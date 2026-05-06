// GameOrchestrator: the Durable Object that owns the tick loop, the admin
// API surface, and the WebSocket pub/sub for live display events.
//
// The DO holds itself open via DurableObjectState.storage.setAlarm — every
// alarm fire calls processTick, persists results to D1, and reschedules the
// next alarm TICK_INTERVAL_MS in the future.

import type { Env } from "./worker.js";
import { Db } from "./db.js";
import { Stellar } from "./stellar.js";
import { MppClient } from "./mpp-client.js";
import { processTick, type TickDeps } from "./tick.js";
import { createRandomEventsState, type RandomEventsState } from "./random-events.js";
import type { Agent, GameEvent, TickerEntry } from "./types.js";
import type { LlmDeps, GossipMoment } from "./llm.js";
import { generateGossip } from "./llm.js";
import { getPersona } from "./personas.js";

interface BroadcastMessage {
  type: "game_event" | "ticker_update";
  data: unknown;
}

// Coaching is structured as three quarter-long windows. The owner gets one
// directive credit per quarter and can spend it any time within the range.
// Q1 (ticks 1-11) is a warm-up — no coaching. After tick 12 (when the Q1
// Retreat mode: coaching is always open. Claimers may submit a directive
// at any tick; submissions persist until overwritten or cleared. No
// quarter gates, no credit limits.

const DIRECTIVE_MAX_LENGTH = 280;
const PASSWORD_MIN_LENGTH = 4;
const PASSWORD_MAX_LENGTH = 128;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BYTES = 32;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** PBKDF2-SHA256 password hash. Stored as JSON: {salt, hash, iterations}. */
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const hashBuf = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    PBKDF2_HASH_BYTES * 8
  );
  return JSON.stringify({
    salt: bytesToBase64(salt),
    hash: bytesToBase64(new Uint8Array(hashBuf)),
    iterations: PBKDF2_ITERATIONS,
  });
}

/** Verify a password against a stored PBKDF2 record. Constant-time compare. */
async function verifyPassword(password: string, storedRecord: string): Promise<boolean> {
  let parsed: { salt: string; hash: string; iterations: number };
  try {
    parsed = JSON.parse(storedRecord);
  } catch {
    return false;
  }
  const salt = base64ToBytes(parsed.salt);
  const expected = base64ToBytes(parsed.hash);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const hashBuf = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: parsed.iterations, hash: "SHA-256" },
    keyMaterial,
    expected.length * 8
  );
  const actual = new Uint8Array(hashBuf);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

export class GameOrchestrator {
  private state: DurableObjectState;
  private env: Env;
  private sockets = new Set<WebSocket>();

  // In-memory random-events state. It's fine that this resets on DO eviction —
  // the only thing it tracks is "has the midgame initiative fired" and "what
  // tick was the last weekly", and those are both tick-deterministic enough
  // that a missed re-trigger is acceptable.
  private randomEventsState: RandomEventsState = createRandomEventsState();

  // Coalesce concurrent alarm fires (shouldn't happen, but cheap insurance).
  private tickInFlight = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight — admin/api/health are all browser-callable. Wildcard
    // origin is safe here: admin endpoints still require the Bearer token,
    // and CORS only protects against cookie-authenticated cross-site calls,
    // which we don't use.
    if (
      request.method === "OPTIONS" &&
      (url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/admin/") ||
        url.pathname === "/health")
    ) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // /health — public liveness probe
    if (url.pathname === "/health") {
      return withCors(
        Response.json({
          service: "orchestrator",
          status: "ok",
          connectedSockets: this.sockets.size,
        })
      );
    }

    // /ws — WebSocket upgrade for live event stream
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.acceptSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // /admin/* — Bearer-auth gated control surface (CORS-enabled for the
    // dashboard's pause button)
    if (url.pathname.startsWith("/admin/")) {
      const authError = this.checkAdminAuth(request);
      if (authError) return withCors(authError);
      return withCors(await this.handleAdmin(url, request));
    }

    // /api/* — public read-only state + claim flow, CORS-enabled
    if (url.pathname.startsWith("/api/")) {
      return withCors(await this.handleApi(url, request));
    }

    return new Response("not found", { status: 404 });
  }

  // ----- WebSocket fan-out --------------------------------------------------

  private acceptSocket(ws: WebSocket): void {
    ws.accept();
    this.sockets.add(ws);
    ws.addEventListener("close", () => this.sockets.delete(ws));
    ws.addEventListener("error", () => this.sockets.delete(ws));
  }

  private broadcast(message: BroadcastMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.sockets) {
      try {
        ws.send(data);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  // ----- Auth ---------------------------------------------------------------

  private checkAdminAuth(request: Request): Response | null {
    const auth = request.headers.get("authorization") || "";
    if (!auth.startsWith("Bearer ")) {
      return Response.json({ error: "Missing authorization header" }, { status: 401 });
    }
    if (auth.slice(7) !== this.env.ADMIN_SECRET) {
      return Response.json({ error: "Invalid admin token" }, { status: 403 });
    }
    return null;
  }

  // ----- Admin endpoints ----------------------------------------------------

  private async handleAdmin(url: URL, request: Request): Promise<Response> {
    const db = new Db(this.env.DB);
    const path = url.pathname.replace(/^\/admin/, "");

    if (path === "/status" && request.method === "GET") {
      return Response.json({
        status: await db.getGameStatus(),
        tick: await db.getCurrentTick(),
        connectedSockets: this.sockets.size,
        timestamp: new Date().toISOString(),
      });
    }

    if (path === "/start" && request.method === "POST") {
      const current = await db.getGameStatus();
      if (current === "running") {
        return Response.json({ error: "Game already running" }, { status: 400 });
      }
      // Top up HR Department's DLBR balance before kickoff so payouts never
      // stall mid-show. Best-effort — if it fails, the game still starts;
      // we just log and surface in the response for visibility.
      const hrFunding = await this.ensureHrFunded();
      await db.setGameStatus("running");
      // Pin game-start time so the alarm handler can target a fixed wall-clock
      // cadence (gameStartedAt + tick * interval) instead of drifting on work time.
      await db.setGameStateValue("game_started_at", String(Date.now()));
      // First tick fires immediately; subsequent ones are alarm-scheduled.
      await this.state.storage.setAlarm(Date.now() + 100);
      return Response.json({
        status: "running",
        startedAt: new Date().toISOString(),
        hrFunding,
      });
    }

    if (path === "/halt" && request.method === "POST") {
      const current = await db.getGameStatus();
      if (current !== "running") {
        return Response.json({ error: `Cannot halt game in ${current} state` }, { status: 400 });
      }
      await db.setGameStatus("halted");
      await this.state.storage.deleteAlarm();
      return Response.json({ status: "halted", tick: await db.getCurrentTick() });
    }

    if (path === "/resume" && request.method === "POST") {
      const current = await db.getGameStatus();
      if (current !== "halted") {
        return Response.json({ error: `Cannot resume game in ${current} state` }, { status: 400 });
      }
      await db.setGameStatus("running");
      // Realign game-start time so cadence resumes from where we left off
      // (rather than racing forward to "catch up" the pause duration).
      const interval = parseInt(this.env.TICK_INTERVAL_MS, 10);
      const tick = await db.getCurrentTick();
      await db.setGameStateValue("game_started_at", String(Date.now() - tick * interval));
      await this.state.storage.setAlarm(Date.now() + 100);
      return Response.json({ status: "running" });
    }

    if (path === "/end" && request.method === "POST") {
      await db.setGameStatus("ended");
      await this.state.storage.deleteAlarm();
      return Response.json({ status: "ended", tick: await db.getCurrentTick() });
    }

    if (path === "/tick" && request.method === "POST") {
      // Manual tick trigger for smoke testing without waiting for the alarm.
      // Uses the same round-robin picker as the alarm (2 agents per tick).
      if (this.tickInFlight) {
        return Response.json({ error: "Tick already in progress" }, { status: 409 });
      }
      const activeAgentIds = await this.pickActiveAgentsForRoundRobin(2);
      await this.runTick(activeAgentIds);
      return Response.json({ ok: true, tick: await db.getCurrentTick(), activeAgents: activeAgentIds });
    }

    // Reset the game: clears events/ticker/action_logs/leaked_emails, resets
    // agent prestige/status/allies, drops the new_initiative flag, halts any
    // pending alarm, and resets the DO's in-memory random-events state.
    //
    // Preserves: agents.claimed_by/claimed_by_name (so humans stay attached
    // across runs), agents on-chain DLBR balances (those are real testnet
    // assets — left alone unless ?wipe_balances=true is added later).
    //
    // Refuses to run while status === "running"; halt first.
    if (path === "/reset" && request.method === "POST") {
      const normalize = url.searchParams.get("normalize") === "true";
      const targetParam = url.searchParams.get("target");
      const target = targetParam ? parseFloat(targetParam) : 200;
      const current = await db.getGameStatus();
      if (current === "running") {
        return Response.json(
          { error: "Halt the game before resetting (POST /admin/halt or click Pause first)" },
          { status: 400 }
        );
      }
      // Reset always wipes claims and password hashes together (issue #2).
      // The retreat is a single-session event; no need to preserve coaches
      // across reset boundaries. Slots are released so anyone can re-claim
      // for the next game.
      const result = await this.performReset({ normalizeBalances: normalize, target, broadcastNotice: "Game reset by admin. Cycle 0. Status: setup." });
      return Response.json({
        ok: true,
        status: "setup",
        tick: 0,
        wipedClaims: true,
        normalized: normalize,
        normalize: result,
        next: "POST /admin/start to begin a fresh game",
      });
    }

    // Dump the full game record as JSON — actions, events, and a stripped
    // agent roster (no secret keys, no owner emails). Designed for end-of-game
    // analysis: pull this before the post-game cleanup alarm wipes the tables.
    if (path === "/snapshot" && request.method === "GET") {
      const [actionsRes, eventsRes, agentsRes, statusVal, tickVal] = await Promise.all([
        this.env.DB.prepare("SELECT id, tick, agent_id, action_type, action_data, reasoning, outcome, prestige_change, tx_hash, created_at FROM action_logs ORDER BY tick ASC, id ASC").all(),
        this.env.DB.prepare("SELECT id, tick, timestamp, type, agent_id, target_id, description, prestige_change, tx_hash, settlement_time, reasoning, parent_event_id, action_type, target_name, action_detail FROM events ORDER BY tick ASC, timestamp ASC").all(),
        this.env.DB.prepare("SELECT id, persona_id, name, title, prestige, status_effects, allies, pending_alliance, claimed_by_name FROM agents").all(),
        db.getGameStatus(),
        db.getCurrentTick(),
      ]);
      return Response.json({
        snapshotAt: new Date().toISOString(),
        status: statusVal,
        tick: tickVal,
        agents: agentsRes.results,
        actions: actionsRes.results,
        events: eventsRes.results,
        counts: {
          agents: agentsRes.results.length,
          actions: actionsRes.results.length,
          events: eventsRes.results.length,
        },
      });
    }

    // Cancel the post-game cleanup alarm. Use during testing when you want
    // the game record to stick around past the 5-minute auto-wipe window.
    // Once cancelled, the cleanup must be triggered manually via /admin/reset.
    if (path === "/cancel-cleanup" && request.method === "POST") {
      const pending = await this.state.storage.getAlarm();
      await this.state.storage.deleteAlarm();
      return Response.json({
        ok: true,
        cancelledAlarmAt: pending,
        note: "Post-game cleanup will not fire automatically. Call /admin/reset when done.",
      });
    }

    // Bring every agent's DLBR balance to a target. Burns from agents who
    // are above (in parallel — distinct source accounts), then mints from
    // the issuer to agents who are below (sequential — single source means
    // shared sequence number). Body: {"target": 200}
    if (path === "/normalize" && request.method === "POST") {
      const status = await db.getGameStatus();
      if (status === "running") {
        return Response.json(
          { error: "Halt the game before normalizing balances." },
          { status: 400 }
        );
      }
      if (!this.env.ASSET_ISSUER_SECRET) {
        return Response.json(
          { error: "ASSET_ISSUER_SECRET not configured on the orchestrator" },
          { status: 500 }
        );
      }

      const body = await request.json().catch(() => ({})) as { target?: number };
      const target = typeof body.target === "number" && body.target > 0 ? body.target : 200;
      const stellar = this.makeStellar();
      const agents = await db.getAllAgents();

      // Snapshot balances in parallel.
      const snapshot = await Promise.all(
        agents.map(async (a) => ({ agent: a, balance: await stellar.getAssetBalance(a.publicKey) }))
      );

      const burns: Array<{ name: string; amount: number; txHash?: string; error?: string }> = [];
      const mints: Array<{ name: string; amount: number; txHash?: string; error?: string }> = [];

      // Burns: distinct source accounts → parallelize.
      await Promise.all(
        snapshot
          .filter((e) => target - e.balance < -0.01)
          .map(async (e) => {
            const amount = Math.round((e.balance - target) * 100) / 100;
            try {
              const txHash = await stellar.burn(e.agent.secretKey, amount);
              burns.push({ name: e.agent.name, amount, txHash });
            } catch (err) {
              burns.push({ name: e.agent.name, amount, error: String(err) });
            }
          })
      );

      // Mints: shared source (issuer), must serialize.
      for (const e of snapshot) {
        const amount = Math.round((target - e.balance) * 100) / 100;
        if (amount <= 0.01) continue;
        try {
          const txHash = await stellar.sendAsset(this.env.ASSET_ISSUER_SECRET, e.agent.publicKey, amount);
          mints.push({ name: e.agent.name, amount, txHash });
        } catch (err) {
          mints.push({ name: e.agent.name, amount, error: String(err) });
        }
      }

      return Response.json({ ok: true, target, burns, mints, agents: snapshot.length });
    }

    return new Response("not found", { status: 404 });
  }

  // ----- API endpoints ------------------------------------------------------

  private async handleApi(url: URL, request: Request): Promise<Response> {
    const db = new Db(this.env.DB);
    const stellar = this.makeStellar();
    const path = url.pathname.replace(/^\/api/, "");

    // Roster: agent list with persona traits + live stats + claim status.
    if (path === "/agents" && request.method === "GET") {
      const agents = await db.getAllAgents();
      const total = agents.length;
      const enriched = await Promise.all(
        agents.map(async (a, idx) => {
          const persona = getPersona(a.personaId);
          // Directive is public on the dashboard / directive screen in
          // retreat mode (no longer a private "owner-only" field).
          const directive = (await db.getGameStateValue(`directive_${a.id}`)) || null;
          return {
            id: a.id,
            name: a.name,
            title: a.title,
            traits: persona?.traits ?? null,
            backstory: persona?.backstory ?? null,
            quirk: persona?.quirk ?? null,
            speechStyle: persona?.speechStyle ?? null,
            prestige: a.prestige,
            balance: await stellar.getAssetBalance(a.publicKey),
            statusEffects: a.statusEffects,
            allies: a.allies,
            claimed: !!a.claimedByName,
            claimedByName: a.claimedByName,
            directive,
            rank: idx + 1,
            total,
            explorerUrl: stellar.getExplorerAccountUrl(a.publicKey),
          };
        })
      );
      return Response.json({ agents: enriched, tick: await db.getCurrentTick(), status: await db.getGameStatus() });
    }

    // Single agent detail with recent activity.
    const agentMatch = path.match(/^\/agent\/([a-z_]+)$/);
    if (agentMatch && request.method === "GET") {
      const agentId = agentMatch[1];
      const agent = await db.getAgent(agentId);
      if (!agent) return new Response("not found", { status: 404 });

      const all = await db.getAllAgents();
      const total = all.length;
      const rank = all.findIndex((a) => a.id === agent.id) + 1;
      const persona = getPersona(agent.personaId);
      const recentActions = await db.getRecentActionLogsForAgent(agent.id, 12);
      const balance = await stellar.getAssetBalance(agent.publicKey);
      const gameStatus = await db.getGameStatus();
      const currentTick = await db.getCurrentTick();

      // Retreat mode: directive is public on the dashboard (the directive
      // screen shows them verbatim) so we surface it for everyone. The
      // `activated` flag signals to the agent.html state machine whether
      // the slot has a password set yet.
      const claimed = !!agent.claimedByName;
      const activated = claimed && !!(await db.getGameStateValue(`password_${agent.id}`));
      const directive = (await db.getGameStateValue(`directive_${agent.id}`)) || null;
      const coachingOpen = gameStatus === "running" || gameStatus === "halted";

      return Response.json({
        id: agent.id,
        name: agent.name,
        title: agent.title,
        traits: persona?.traits ?? null,
        backstory: persona?.backstory ?? null,
        quirk: persona?.quirk ?? null,
        speechStyle: persona?.speechStyle ?? null,
        prestige: agent.prestige,
        balance,
        rank,
        total,
        statusEffects: agent.statusEffects,
        allies: agent.allies,
        claimed,
        claimedByName: agent.claimedByName,
        activated,
        gameStatus,
        currentTick,
        coachingWindow: { open: coachingOpen, alwaysOpen: true },
        directive,
        explorerUrl: stellar.getExplorerAccountUrl(agent.publicKey),
        recentActions: recentActions.map((r) => ({
          tick: r.tick,
          actionType: r.action_type,
          outcome: r.outcome,
          reasoning: r.reasoning,
          prestigeChange: r.prestige_change,
          txHash: r.tx_hash,
        })),
      });
    }

    // Claim flow — atomic.
    if (path === "/claim" && request.method === "POST") {
      // Retreat-mode claim: atomic claim+activate with name + password.
      // No email — coaching auth is password-based for the in-room show.
      let body: { agentId?: string; name?: string; password?: string };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const { agentId, name, password } = body;
      if (!agentId || !name || !password) {
        return Response.json({ error: "agentId, name, and password are all required" }, { status: 400 });
      }
      if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
        return Response.json(
          { error: `password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters` },
          { status: 400 }
        );
      }
      const trimmedName = name.trim().slice(0, 80);
      if (trimmedName.length === 0) {
        return Response.json({ error: "name is required" }, { status: 400 });
      }

      const claimStatus = await db.getGameStatus();
      if (claimStatus !== "setup") {
        return Response.json(
          {
            error: `Claims are only open between rounds (current status: ${claimStatus}).`,
            status: claimStatus,
          },
          { status: 400 }
        );
      }

      // Atomic: only set claimed_by_name if currently NULL. Then store the
      // password hash. If the claim succeeded but hashing failed, roll back
      // to keep the slot available.
      const updateRes = await this.env.DB
        .prepare(
          "UPDATE agents SET claimed_by_name = ? WHERE id = ? AND claimed_by_name IS NULL"
        )
        .bind(trimmedName, agentId)
        .run();
      const changes = updateRes.meta?.changes ?? 0;
      if (changes === 0) {
        const a = await db.getAgent(agentId);
        if (!a) return Response.json({ error: "agent not found" }, { status: 404 });
        return Response.json(
          { error: "agent already claimed", claimedByName: a.claimedByName },
          { status: 409 }
        );
      }

      try {
        const hash = await hashPassword(password);
        await db.setGameStateValue(`password_${agentId}`, hash);
      } catch (err) {
        console.error("[claim] password hashing failed; releasing claim:", err);
        await this.env.DB
          .prepare("UPDATE agents SET claimed_by_name = NULL WHERE id = ?")
          .bind(agentId)
          .run();
        return Response.json({ error: "could not store password; please try again" }, { status: 500 });
      }

      return Response.json({ ok: true, agentId, claimedByName: trimmedName, activated: true });
    }

    // Release a claim. Allowed only when the game is NOT running. Auth via
    // password (the same one set at claim time).
    if (path === "/release" && request.method === "POST") {
      const status = await db.getGameStatus();
      if (status === "running") {
        return Response.json(
          { error: "Cannot release a manager while a cycle is in progress. Try after halt or end-of-game." },
          { status: 400 }
        );
      }

      let body: { agentId?: string; password?: string };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const { agentId, password } = body;
      if (!agentId || !password) {
        return Response.json({ error: "agentId and password both required" }, { status: 400 });
      }

      const claimedAgent = await db.getAgent(agentId);
      if (!claimedAgent) return Response.json({ error: "agent not found" }, { status: 404 });
      if (!claimedAgent.claimedByName) {
        return Response.json({ error: "agent is not claimed" }, { status: 400 });
      }
      const storedHash = await db.getGameStateValue(`password_${agentId}`);
      if (!storedHash || !(await verifyPassword(password, storedHash))) {
        return Response.json({ error: "password does not match the claim record" }, { status: 403 });
      }

      const releasedFromName = claimedAgent.claimedByName;
      await this.env.DB
        .prepare("UPDATE agents SET claimed_by = NULL, claimed_by_name = NULL WHERE id = ?")
        .bind(agentId)
        .run();

      return Response.json({ ok: true, agentId, releasedFrom: releasedFromName });
    }

    // Retreat-mode coaching: always-open. Claimer submits a directive at
    // any tick; it persists until overwritten or DELETE'd. Auth via password
    // (set at claim time). Cap 280 chars.
    if (path === "/directive" && (request.method === "POST" || request.method === "DELETE")) {
      let body: { agentId?: string; password?: string; directive?: string };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const { agentId, password } = body;
      if (!agentId || !password) {
        return Response.json({ error: "agentId and password both required" }, { status: 400 });
      }

      const directiveAgent = await db.getAgent(agentId);
      if (!directiveAgent) return Response.json({ error: "agent not found" }, { status: 404 });
      if (!directiveAgent.claimedByName) {
        return Response.json({ error: "agent is not claimed" }, { status: 400 });
      }
      const storedHash = await db.getGameStateValue(`password_${agentId}`);
      if (!storedHash || !(await verifyPassword(password, storedHash))) {
        return Response.json({ error: "password does not match the claim record" }, { status: 403 });
      }

      const status = await db.getGameStatus();
      const currentTick = await db.getCurrentTick();
      if (status !== "running" && status !== "halted") {
        return Response.json(
          { error: `Coaching unavailable: game is ${status}.`, currentTick, status },
          { status: 400 }
        );
      }

      const key = `directive_${agentId}`;
      if (request.method === "DELETE") {
        await this.env.DB.prepare("DELETE FROM game_state WHERE key = ?").bind(key).run();
        return Response.json({ ok: true, cleared: true });
      }

      const text = (body.directive ?? "").trim().slice(0, DIRECTIVE_MAX_LENGTH);
      if (text.length === 0) {
        return Response.json({ error: "directive is empty (DELETE to clear instead)" }, { status: 400 });
      }
      await db.setGameStateValue(key, text);
      return Response.json({ ok: true, directive: text, persistsUntilOverwritten: true });
    }

    // Office politics: current alliances + recent rivalries (anyone who's
    // attacked another agent 2+ times in the last 12 ticks). Used by the
    // dashboard's "Current Alliances" panel.
    if (path === "/relationships" && request.method === "GET") {
      const HOSTILE_ACTIONS = [
        "take_credit", "sabotage_plan", "sensitivity_training", "poison_meeting",
        "send_motivation", "file_complaint", "calendar_conflict", "schedule_conflict",
        "fix_laptop", "whistleblower_bounty",
      ];
      const RIVALRY_LOOKBACK = 12;
      const RIVALRY_THRESHOLD = 2;

      const [agents, currentTick] = await Promise.all([db.getAllAgents(), db.getCurrentTick()]);

      // Alliances: dedupe by canonical pair key (alphabetical).
      const seen = new Set<string>();
      const alliances: Array<{ a: string; aName: string; b: string; bName: string }> = [];
      const nameById = new Map(agents.map((a) => [a.id, a.name]));
      for (const a of agents) {
        for (const allyId of a.allies) {
          const key = [a.id, allyId].sort().join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          const [first, second] = key.split("|");
          alliances.push({
            a: first,
            aName: nameById.get(first) ?? first,
            b: second,
            bName: nameById.get(second) ?? second,
          });
        }
      }

      // Rivalries: group hostile actions by attacker→victim in the last
      // RIVALRY_LOOKBACK ticks; surface pairs with ≥ RIVALRY_THRESHOLD hits.
      const placeholders = HOSTILE_ACTIONS.map(() => "?").join(",");
      const sql = `SELECT agent_id as attacker, json_extract(action_data, '$.target') as victim, COUNT(*) as cnt
                   FROM action_logs
                   WHERE tick > ?
                     AND action_type IN (${placeholders})
                     AND json_extract(action_data, '$.target') IS NOT NULL
                   GROUP BY attacker, victim
                   HAVING cnt >= ?
                   ORDER BY cnt DESC, attacker ASC`;
      const rivalryRows = await this.env.DB
        .prepare(sql)
        .bind(currentTick - RIVALRY_LOOKBACK, ...HOSTILE_ACTIONS, RIVALRY_THRESHOLD)
        .all<{ attacker: string; victim: string; cnt: number }>();
      const rivalries = (rivalryRows.results ?? []).map((r) => ({
        attacker: r.attacker,
        attackerName: nameById.get(r.attacker) ?? r.attacker,
        victim: r.victim,
        victimName: nameById.get(r.victim) ?? r.victim,
        count: r.cnt,
      }));

      return Response.json({
        currentTick,
        alliances,
        rivalries,
        rivalryWindowTicks: RIVALRY_LOOKBACK,
        rivalryThreshold: RIVALRY_THRESHOLD,
      });
    }

    // Latest gossip narrative — refreshed every 4 ticks by the alarm handler.
    // Public read; used by the dashboard's "Gossip with your work bestie" panel.
    if (path === "/gossip" && request.method === "GET") {
      const [text, tickStr, generatedAt] = await Promise.all([
        db.getGameStateValue("latest_gossip"),
        db.getGameStateValue("latest_gossip_tick"),
        db.getGameStateValue("latest_gossip_at"),
      ]);
      return Response.json({
        text: text || null,
        tick: tickStr ? parseInt(tickStr, 10) || null : null,
        generatedAt: generatedAt || null,
      });
    }

    if (path === "/state") {
      const [agents, status, tick, recentEvents, ticker, stats, storageAlarm, turnOrderRaw, turnIndexRaw, gameStartedAtRaw] = await Promise.all([
        db.getAllAgents(),
        db.getGameStatus(),
        db.getCurrentTick(),
        db.getRecentEvents(300),
        db.getRecentTickerEntries(200),
        db.getTickerStats(),
        // DO storage tracks the next scheduled alarm time as a ms-since-epoch
        // number (or null if no alarm). Surfacing it lets every dashboard
        // tab show the same countdown without local-clock drift / refresh
        // resetting it.
        this.state.storage.getAlarm(),
        db.getGameStateValue("turn_order"),
        db.getGameStateValue("turn_index"),
        db.getGameStateValue("game_started_at"),
      ]);

      // While a tick is processing (LLM + Stellar work, ~20-28s) the storage
      // alarm is null because it hasn't been rescheduled yet. Surface a
      // tickInFlight flag so the dashboard can render "Working…" instead of
      // a countdown stuck at 0:00. nextAlarmAt is still set to the wall-clock
      // target so when the in-flight tick completes the countdown picks up
      // accurately for the next interval.
      let nextAlarmAt = storageAlarm;
      const tickInFlight = (storageAlarm == null) && status === "running";
      if ((nextAlarmAt == null || nextAlarmAt <= Date.now()) && status === "running" && gameStartedAtRaw) {
        const startedAt = parseInt(gameStartedAtRaw, 10);
        const interval = parseInt(this.env.TICK_INTERVAL_MS, 10);
        nextAlarmAt = startedAt + tick * interval;
      }

      const agentsWithBalances = await Promise.all(
        agents.map(async (a) => ({
          id: a.id,
          name: a.name,
          title: a.title,
          prestige: a.prestige,
          balance: await stellar.getAssetBalance(a.publicKey),
          statusEffects: a.statusEffects,
          allies: a.allies,
          explorerUrl: stellar.getExplorerAccountUrl(a.publicKey),
        }))
      );

      // "Up Next": the IDs (and resolved names) of the agents who will
      // act on the next alarm fire. Read directly from the turn-order
      // queue stored in game_state.
      let nextAgents: Array<{ id: string; name: string }> = [];
      if (turnOrderRaw && turnIndexRaw) {
        try {
          const order: string[] = JSON.parse(turnOrderRaw);
          const idx = parseInt(turnIndexRaw, 10);
          const ids = order.slice(idx, idx + 2);
          nextAgents = ids
            .map((id) => agents.find((a) => a.id === id))
            .filter((a): a is NonNullable<typeof a> => !!a)
            .map((a) => ({ id: a.id, name: a.name }));
        } catch { /* malformed state, leave empty */ }
      }

      return Response.json({
        status,
        tick,
        tickIntervalMs: parseInt(this.env.TICK_INTERVAL_MS, 10),
        maxTicks: parseInt(this.env.MAX_TICKS, 10),
        nextAlarmAt,
        tickInFlight,
        serverTime: Date.now(),
        agents: agentsWithBalances,
        nextAgents,
        recentEvents,
        ticker,
        stats: {
          totalTransactions: stats.total,
          totalAmountMoved: stats.amountMoved,
          avgSettlementTime: stats.avgSettlement,
        },
      });
    }

    if (path === "/events") {
      return Response.json(await db.getRecentEvents(50));
    }

    if (path === "/ticker") {
      return Response.json(await db.getRecentTickerEntries(50));
    }

    return new Response("not found", { status: 404 });
  }

  // ----- Alarm-driven tick loop ---------------------------------------------

  async alarm(): Promise<void> {
    const db = new Db(this.env.DB);
    const status = await db.getGameStatus();

    // Game has ended — never auto-wipe. Final standings + action_logs +
    // events stay in D1 for post-game analysis until someone explicitly
    // calls /admin/reset. If an alarm somehow fires while we're in this
    // state (shouldn't happen — we don't schedule one), just no-op.
    if (status === "ended") {
      console.log("[alarm] fired while ended; ignoring (no auto-cleanup).");
      return;
    }

    if (status !== "running") {
      // Game halted between alarm scheduling and firing — drop.
      return;
    }

    const tick = await db.getCurrentTick();
    const maxTicks = parseInt(this.env.MAX_TICKS, 10);
    if (tick >= maxTicks) {
      await db.setGameStatus("ended");

      // Clear all per-game ephemeral state including password hashes. Each
      // new game starts fresh — claims and passwords get released together
      // (issue #2). Persona traits + on-chain balances are the only carryover.
      try {
        await this.env.DB.prepare(`
          DELETE FROM game_state WHERE
            key LIKE 'directive_%' OR
            key LIKE 'hail_mary_used_%' OR
            key LIKE 'boomerang_used_%' OR
            key LIKE 'pulse_survey_used_%' OR
            key LIKE 'join_meeting_count_%' OR
            key LIKE 'password_%' OR
            key IN ('turn_order', 'turn_index')
        `).run();
      } catch (err) {
        console.error("[alarm] failed to clear per-game state on end-of-game:", err);
      }

      // Clear adoption claims so the next game's intro page shows everyone as
      // available. action_logs / events are preserved for post-game analysis;
      // only the owner pointers are released.
      try {
        await this.env.DB.prepare("UPDATE agents SET claimed_by = NULL, claimed_by_name = NULL").run();
      } catch (err) {
        console.error("[alarm] failed to clear claims on end-of-game:", err);
      }

      // Emit a game_end event so live dashboards can show the winner overlay.
      // The agents list is sorted prestige DESC, so all[0] is the new VP.
      try {
        const all = await db.getAllAgents();
        if (all.length > 0) {
          const winner = all[0];
          const event: GameEvent = {
            id: crypto.randomUUID(),
            tick,
            timestamp: new Date(),
            type: "game_end",
            agentId: winner.id,
            description: `🏆 Q1 closed — ${winner.name} promoted to VP with ${winner.prestige} prestige.`,
            prestigeChange: 0,
          };
          await db.saveEvent(event);
          this.broadcast({ type: "game_event", data: event });
        }
      } catch (err) {
        console.error("[alarm] failed to emit game_end event:", err);
      }

      // Don't schedule a cleanup alarm. Final standings, action_logs, and
      // events stay in D1 until someone explicitly calls /admin/reset, so
      // we can always pull /admin/snapshot for post-game analysis.
      console.log(`[alarm] game ended at tick ${tick}; data preserved until /admin/reset`);
      return;
    }

    // Retreat round-robin: each alarm fires for 2 agents' turns. Picks
    // the next 2 from the rolling turn-order queue.
    const activeAgentIds = await this.pickActiveAgentsForRoundRobin(2);
    await this.runTick(activeAgentIds);

    // After the tick, refresh the gossip narrative every 5 ticks (= once
    // per cycle in 2-agents-per-tick mode). Cheap (one mini call), failure
    // shouldn't break the tick loop.
    const newTick = await db.getCurrentTick();
    if (newTick > 0 && newTick % 5 === 0) {
      try {
        await this.runGossipPass(newTick);
      } catch (err) {
        console.error(`[gossip] refresh at tick ${newTick} failed:`, err);
      }
    }

    // Reschedule the next alarm if we're still running.
    // Game-4 fix: target a fixed wall-clock cadence (gameStartedAt + tick * interval)
    // instead of "now + interval". The latter caused work-time drift — each tick's
    // LLM + Stellar settlement added ~20s to the gap, blowing 33min games to 60min.
    const stillRunning = (await db.getGameStatus()) === "running";
    if (stillRunning) {
      const interval = parseInt(this.env.TICK_INTERVAL_MS, 10);
      const startedAtRaw = await db.getGameStateValue("game_started_at");
      const startedAt = startedAtRaw ? parseInt(startedAtRaw, 10) : Date.now();
      // newTick = the tick we just finished. Next alarm fires for tick newTick+1,
      // which should land at startedAt + newTick*interval (so tick 1 fires near
      // startedAt+0, tick 2 near startedAt+interval, etc.).
      const targetTime = startedAt + newTick * interval;
      const delay = Math.max(targetTime - Date.now(), 1000);
      await this.state.storage.setAlarm(Date.now() + delay);
    }
  }

  private async runTick(activeAgentIds?: string[]): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const db = new Db(this.env.DB);
      const stellar = this.makeStellar();

      const mpp = new MppClient(async (entry: TickerEntry) => {
        // Persist + broadcast every ticker state transition.
        try {
          await db.saveTickerEntry(entry);
        } catch (err) {
          console.error(`[ticker] persist failed for ${entry.id}:`, err);
        }
        this.broadcast({
          type: "ticker_update",
          data: {
            ...entry,
            explorerUrl: entry.txHash ? stellar.getExplorerTxUrl(entry.txHash) : undefined,
          },
        });
      });

      const llm: LlmDeps = {
        db,
        stellar,
        openaiBaseUrl: this.env.OPENAI_BASE_URL,
        openaiApiKey: this.env.OPENAI_API_KEY,
        cfAigToken: this.env.CF_AIG_TOKEN,
      };

      const deps: TickDeps = {
        db,
        stellar,
        mpp,
        npcBase: this.env.NPC_BASE_URL,
        llm,
        rewards: {
          hrDeptSecret: this.env.HR_DEPT_SECRET,
          motivSpeakerSecret: this.env.MOTIVATIONAL_SPEAKER_SECRET,
        },
        randomEventsState: this.randomEventsState,
        emit: async (event: GameEvent) => {
          await db.saveEvent(event);
          this.broadcast({ type: "game_event", data: event });
        },
      };

      await processTick(deps, activeAgentIds);
    } catch (err) {
      console.error("[tick] FAILED:", err);
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Ensures the HR Department wallet has enough DLBR to cover salary +
   * bonus + expense_report payouts for a full game. Called on /admin/start.
   *
   * Threshold: 1500 DLBR. Top-up target: 5000 DLBR (covers worst case where
   * every cycle has a Quarterly Bonus tier-1 + 10 work salaries + a few
   * expense reports — comfortably 4-5x typical demand).
   *
   * Best-effort: logs and returns a status object on failure rather than
   * blocking the game start.
   */
  private async ensureHrFunded(): Promise<{
    skipped?: string;
    balanceBefore?: number;
    minted?: number;
    txHash?: string;
    error?: string;
  }> {
    if (!this.env.ASSET_ISSUER_SECRET) {
      console.warn("[hr-funding] ASSET_ISSUER_SECRET not configured; skipping replenish");
      return { skipped: "ASSET_ISSUER_SECRET not configured" };
    }
    const FLOOR = 1500;
    const TOPUP_TO = 5000;
    const stellar = this.makeStellar();
    try {
      const balance = await stellar.getAssetBalance(this.env.HR_DEPT_ADDRESS);
      if (balance >= FLOOR) {
        return { balanceBefore: balance, minted: 0 };
      }
      const amount = Math.round((TOPUP_TO - balance) * 100) / 100;
      const txHash = await stellar.sendAsset(this.env.ASSET_ISSUER_SECRET, this.env.HR_DEPT_ADDRESS, amount);
      console.log(`[hr-funding] minted ${amount} DLBR → HR Dept (was ${balance.toFixed(2)}, now ~${TOPUP_TO})`);
      return { balanceBefore: balance, minted: amount, txHash };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[hr-funding] replenish failed:", msg);
      return { error: msg };
    }
  }

  /**
   * Round-robin turn picker — 2 agents per tick. Each cycle (5 ticks ×
   * 2 agents = 10 agents) operates on a randomized permutation of the
   * full roster. Stored in game_state as `turn_order` (JSON array) and
   * `turn_index`. When the index runs out, a fresh order is generated.
   */
  private async pickActiveAgentsForRoundRobin(count: number = 2): Promise<string[]> {
    const db = new Db(this.env.DB);
    const orderRaw = await db.getGameStateValue("turn_order");
    const indexRaw = await db.getGameStateValue("turn_index");
    let order: string[] = orderRaw ? JSON.parse(orderRaw) : [];
    let index = indexRaw ? parseInt(indexRaw, 10) : 0;

    // Shuffle once per game (game-5 user feedback): predictable rhythm so
    // coaches know when their manager acts. Pairs are fixed for all 16
    // cycles — only shuffled if turn_order is empty (= start of game) or
    // someone reset state. Wrap-around at end of cycle keeps the order.
    if (order.length === 0) {
      const agents = await db.getAllAgents();
      order = agents.map((a) => a.id).sort(() => Math.random() - 0.5);
      index = 0;
      await db.setGameStateValue("turn_order", JSON.stringify(order));
    }

    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      if (index >= order.length) {
        // Wrap to the start of the same fixed order — no reshuffle.
        index = 0;
      }
      out.push(order[index]);
      index += 1;
    }
    await db.setGameStateValue("turn_index", String(index));
    return out;
  }

  /**
   * Pull "big moments" from the last 4 ticks and ask the gossip narrator to
   * summarize. Cached in game_state for /api/gossip.
   */
  private async runGossipPass(currentTick: number): Promise<void> {
    const db = new Db(this.env.DB);
    const tickStart = Math.max(0, currentTick - 4);

    const rows = await this.env.DB.prepare(
      `SELECT tick, description, prestige_change, type FROM events
       WHERE tick > ? AND tick <= ?
         AND (type = 'random_event'
              OR type LIKE 'alliance_%'
              OR ABS(COALESCE(prestige_change, 0)) >= 15)
       ORDER BY tick ASC, timestamp ASC`,
    ).bind(tickStart, currentTick).all<{ tick: number; description: string; prestige_change: number | null; type: string }>();

    const all = rows.results ?? [];
    if (all.length === 0) return;

    // Cap to top 12 by prestige magnitude (random/alliance events get a default
    // weight so they're not dropped), then re-sort chronologically for the LLM.
    const moments: GossipMoment[] = [...all]
      .sort((a, b) => Math.abs(b.prestige_change ?? 50) - Math.abs(a.prestige_change ?? 50))
      .slice(0, 12)
      .sort((a, b) => a.tick - b.tick)
      .map((r) => ({ tick: r.tick, description: r.description, prestigeChange: r.prestige_change }));

    const llm: LlmDeps = {
      db,
      stellar: this.makeStellar(),
      openaiBaseUrl: this.env.OPENAI_BASE_URL,
      openaiApiKey: this.env.OPENAI_API_KEY,
      cfAigToken: this.env.CF_AIG_TOKEN,
    };

    const gossip = await generateGossip(llm, moments, currentTick);
    if (gossip) {
      await db.setGameStateValue("latest_gossip", gossip);
      await db.setGameStateValue("latest_gossip_tick", String(currentTick));
      await db.setGameStateValue("latest_gossip_at", new Date().toISOString());
    }
  }

  /**
   * Full reset of the game state. Used by /admin/reset (HTTP) and by the
   * post-game cleanup alarm. Wipes all dynamic D1 tables, resets agent
   * stats, optionally wipes claims, optionally normalizes on-chain DLBR
   * balances. Status leaves at "setup", tick at 0.
   */
  private async performReset(opts: {
    normalizeBalances: boolean;
    target?: number;
    broadcastNotice?: string;
  }): Promise<{ burns: number; mints: number; failures: number } | null> {
    const D = this.env.DB;
    const db = new Db(D);

    await this.state.storage.deleteAlarm();

    await D.prepare("DELETE FROM events").run();
    await D.prepare("DELETE FROM ticker").run();
    await D.prepare("DELETE FROM action_logs").run();
    await D.prepare("DELETE FROM leaked_emails").run();
    // Drop ALL game_state including password_* hashes (issue #2). The retreat
    // is a single-session event — releasing a slot for the next game means
    // releasing both the claim and its password together. Otherwise we'd end
    // up with stale auth state vs. an open claim slot.
    await D.prepare("DELETE FROM game_state").run();

    // Clear claims so the next game's intro page shows everyone available.
    await D.prepare(
      `UPDATE agents SET prestige = 0, status_effects = '[]', allies = '[]', pending_alliance = NULL, claimed_by = NULL, claimed_by_name = NULL`
    ).run();

    let normResult: { burns: number; mints: number; failures: number } | null = null;
    if (opts.normalizeBalances) {
      if (!this.env.ASSET_ISSUER_SECRET) {
        console.warn("[reset] normalizeBalances requested but ASSET_ISSUER_SECRET not configured");
      } else {
        const target = opts.target ?? 200;
        const stellar = this.makeStellar();
        const agents = await db.getAllAgents();
        const snapshot = await Promise.all(
          agents.map(async (a) => ({ agent: a, balance: await stellar.getAssetBalance(a.publicKey) }))
        );
        let burns = 0, mints = 0, failures = 0;
        // Burns: parallel (different source accounts)
        await Promise.all(
          snapshot
            .filter((e) => target - e.balance < -0.01)
            .map(async (e) => {
              const amount = Math.round((e.balance - target) * 100) / 100;
              try {
                await stellar.burn(e.agent.secretKey, amount);
                burns++;
              } catch (err) {
                console.error(`[reset] burn failed for ${e.agent.name}:`, err);
                failures++;
              }
            })
        );
        // Mints: sequential (single source = issuer; sequence number)
        for (const e of snapshot) {
          const amount = Math.round((target - e.balance) * 100) / 100;
          if (amount <= 0.01) continue;
          try {
            await stellar.sendAsset(this.env.ASSET_ISSUER_SECRET, e.agent.publicKey, amount);
            mints++;
          } catch (err) {
            console.error(`[reset] mint failed for ${e.agent.name}:`, err);
            failures++;
          }
        }
        normResult = { burns, mints, failures };
      }
    }

    await db.setGameStatus("setup");
    await db.setCurrentTick(0);

    // In-memory state lives on the DO instance, not D1. Reset explicitly so
    // one-shot triggeredOnce flags fire again next run.
    this.randomEventsState = createRandomEventsState();
    this.tickInFlight = false;

    if (opts.broadcastNotice) {
      this.broadcast({
        type: "game_event",
        data: {
          id: crypto.randomUUID(),
          tick: 0,
          timestamp: new Date().toISOString(),
          type: "game_resumed",
          description: opts.broadcastNotice,
        },
      });
    }

    return normResult;
  }

  private makeStellar(): Stellar {
    return new Stellar({
      network: this.env.STELLAR_NETWORK,
      horizonUrl: this.env.HORIZON_URL,
      assetCode: this.env.ASSET_CODE,
      assetIssuer: this.env.ASSET_ISSUER,
    });
  }
}

// CORS helpers. The display is hosted on a different origin (Cloudflare
// Pages), so the browser needs explicit cross-origin permission for the
// /api/* and /health surfaces. Wildcard is fine: the data is public-read
// and admin endpoints stay restricted by Bearer auth.
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
