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
import { sendEmail, claimConfirmationEmail, progressSummaryEmail, finaleEmail } from "./email.js";

interface BroadcastMessage {
  type: "game_event" | "ticker_update";
  data: unknown;
}

// Coaching is structured as three quarter-long windows. The owner gets one
// directive credit per quarter and can spend it any time within the range.
// Q1 (ticks 1-11) is a warm-up — no coaching. After tick 12 (when the Q1
// progress email lands), the Q2 credit opens and stays open until tick 24,
// when the Q3 credit takes over, and so on through tick 47.
const COACHING_QUARTERS = [
  { quarter: 2, openTick: 12, closeTick: 24 },
  { quarter: 3, openTick: 24, closeTick: 36 },
  { quarter: 4, openTick: 36, closeTick: 48 },
];

function getCoachingQuarter(tick: number): typeof COACHING_QUARTERS[number] | null {
  return COACHING_QUARTERS.find((q) => tick >= q.openTick && tick < q.closeTick) ?? null;
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
      await db.setGameStatus("running");
      // First tick fires immediately; subsequent ones are alarm-scheduled.
      await this.state.storage.setAlarm(Date.now() + 100);
      return Response.json({ status: "running", startedAt: new Date().toISOString() });
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
      await this.state.storage.setAlarm(Date.now() + 100);
      return Response.json({ status: "running" });
    }

    if (path === "/end" && request.method === "POST") {
      await db.setGameStatus("ended");
      await this.state.storage.deleteAlarm();
      return Response.json({ status: "ended", tick: await db.getCurrentTick() });
    }

    if (path === "/tick" && request.method === "POST") {
      // Manual tick trigger, useful for smoke-testing without waiting for
      // the alarm interval. Doesn't change game status.
      if (this.tickInFlight) {
        return Response.json({ error: "Tick already in progress" }, { status: 409 });
      }
      await this.runTick();
      return Response.json({ ok: true, tick: await db.getCurrentTick() });
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
      const wipeClaims = url.searchParams.get("wipe_claims") === "true";
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
      const result = await this.performReset({ wipeClaims, normalizeBalances: normalize, target, broadcastNotice: "Game reset by admin. Cycle 0. Status: setup." });
      return Response.json({
        ok: true,
        status: "setup",
        tick: 0,
        wipedClaims: wipeClaims,
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
        this.env.DB.prepare("SELECT id, tick, timestamp, type, agent_id, target_id, description, prestige_change, tx_hash, settlement_time, reasoning FROM events ORDER BY tick ASC, timestamp ASC").all(),
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

    // Test-fire scheduled emails out-of-cycle. Body: {"kind":"progress"|"finale","tick":<n>}
    if (path === "/test-emails" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { kind?: string; tick?: number };
      const kind = body.kind || "progress";
      const tick = body.tick ?? await db.getCurrentTick();
      try {
        if (kind === "finale") await this.sendFinaleEmails();
        else await this.sendProgressEmails(tick);
        return Response.json({ ok: true, kind, tick });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
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
            claimed: !!a.claimedBy,
            claimedByName: a.claimedByName,
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

      // Coaching: each owner gets one directive credit per quarter (Q2, Q3,
      // Q4). The credit is spendable any time within the quarter, but only
      // once. Game must be running or halted; ended/setup are read-only.
      const quarterInfo = getCoachingQuarter(currentTick);
      let creditUsed = false;
      let windowOpen = false;
      if (quarterInfo) {
        creditUsed = (await db.getGameStateValue(`coaching_used_${agent.id}_q${quarterInfo.quarter}`)) === "yes";
        windowOpen = !creditUsed && (gameStatus === "running" || gameStatus === "halted");
      }
      const nextQuarter = COACHING_QUARTERS.find((q) => q.openTick > currentTick) ?? null;

      // Directive is private — only surface it (and the live editor flag)
      // when the requester proves ownership by passing ?email=.
      let directive: string | null = null;
      let directiveOwner = false;
      const requesterEmail = url.searchParams.get("email")?.trim().toLowerCase();
      if (requesterEmail && agent.claimedBy && agent.claimedBy.toLowerCase() === requesterEmail) {
        directiveOwner = true;
        directive = (await db.getGameStateValue(`directive_${agent.id}`)) || null;
      }

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
        claimed: !!agent.claimedBy,
        claimedByName: agent.claimedByName,
        gameStatus,
        currentTick,
        coachingWindow: {
          open: windowOpen,
          currentTick,
          currentQuarter: quarterInfo?.quarter ?? null,
          quarterCloseTick: quarterInfo?.closeTick ?? null,
          creditUsed,
          nextWindowTick: nextQuarter?.openTick ?? null,
        },
        directive,
        directiveOwner,
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
      let body: { agentId?: string; name?: string; email?: string };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const { agentId, name, email } = body;
      if (!agentId || !name || !email) {
        return Response.json({ error: "agentId, name, email all required" }, { status: 400 });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return Response.json({ error: "invalid email format" }, { status: 400 });
      }
      const trimmedName = name.trim().slice(0, 80);
      const trimmedEmail = email.trim().toLowerCase().slice(0, 200);

      // Block claims while a game is running/halted/ended. New adoptions only
      // open during "setup" — between rounds.
      const claimStatus = await db.getGameStatus();
      if (claimStatus !== "setup") {
        return Response.json(
          {
            error: `Claims are only open between rounds (current status: ${claimStatus}). Try again at the start of the next game.`,
            status: claimStatus,
          },
          { status: 400 }
        );
      }

      // One-claim-per-human: reject if this email is already on another agent.
      const existingClaim = await this.env.DB
        .prepare("SELECT id, name FROM agents WHERE LOWER(claimed_by) = ? AND id != ?")
        .bind(trimmedEmail, agentId)
        .first<{ id: string; name: string }>();
      if (existingClaim) {
        return Response.json(
          {
            error: `You've already adopted ${existingClaim.name}. Release them first if you want to switch managers.`,
            existingAgentId: existingClaim.id,
            existingAgentName: existingClaim.name,
          },
          { status: 409 }
        );
      }

      // Atomic: only set if not already claimed.
      const updateRes = await this.env.DB
        .prepare(
          "UPDATE agents SET claimed_by = ?, claimed_by_name = ? WHERE id = ? AND claimed_by IS NULL"
        )
        .bind(trimmedEmail, trimmedName, agentId)
        .run();
      const changes = updateRes.meta?.changes ?? 0;
      if (changes === 0) {
        // Either agent doesn't exist or it's already claimed.
        const a = await db.getAgent(agentId);
        if (!a) return Response.json({ error: "agent not found" }, { status: 404 });
        return Response.json(
          { error: "agent already claimed", claimedByName: a.claimedByName },
          { status: 409 }
        );
      }

      // Send confirmation email (best-effort — don't fail the claim if email fails).
      try {
        const claimedAgent = (await db.getAgent(agentId))!;
        const all = await db.getAllAgents();
        const rank = all.findIndex((a) => a.id === claimedAgent.id) + 1;
        const balance = await stellar.getAssetBalance(claimedAgent.publicKey);
        const tmpl = claimConfirmationEmail({
          agent: claimedAgent,
          balance,
          rank,
          total: all.length,
          claimerName: trimmedName,
        });
        await sendEmail(this.env.RESEND_API_KEY, { ...tmpl, to: trimmedEmail });
      } catch (err) {
        console.error("[claim] confirmation email failed:", err);
      }

      return Response.json({ ok: true, agentId, claimedByName: trimmedName });
    }

    // Release a claim. Allowed only when the game is NOT running, and the
    // requester proves ownership by supplying the email used at claim time.
    if (path === "/release" && request.method === "POST") {
      const status = await db.getGameStatus();
      if (status === "running") {
        return Response.json(
          { error: "Cannot release a manager while a cycle is in progress. Try after halt or end-of-game." },
          { status: 400 }
        );
      }

      let body: { agentId?: string; email?: string };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const { agentId, email } = body;
      if (!agentId || !email) {
        return Response.json({ error: "agentId and email both required" }, { status: 400 });
      }
      const trimmedEmail = email.trim().toLowerCase();

      const claimedAgent = await db.getAgent(agentId);
      if (!claimedAgent) return Response.json({ error: "agent not found" }, { status: 404 });
      if (!claimedAgent.claimedBy) {
        return Response.json({ error: "agent is not claimed" }, { status: 400 });
      }
      if (claimedAgent.claimedBy.toLowerCase() !== trimmedEmail) {
        // Don't leak whether the email was wrong vs the agent was claimed by
        // someone else — same status code either way.
        return Response.json({ error: "email does not match the claim record" }, { status: 403 });
      }

      const releasedFromName = claimedAgent.claimedByName;
      await this.env.DB
        .prepare("UPDATE agents SET claimed_by = NULL, claimed_by_name = NULL WHERE id = ?")
        .bind(agentId)
        .run();

      return Response.json({ ok: true, agentId, releasedFrom: releasedFromName });
    }

    // Set or clear an agent's stakeholder directive. Each owner has one
    // directive credit per quarter (Q2-Q4); POST consumes the credit. DELETE
    // clears the directive but doesn't restore the credit (so you can't
    // launder repeated edits through clear-and-reset). Email auth matches
    // the claim record. The directive itself is stored in game_state and
    // consumed by the LLM context-builder.
    if (path === "/directive" && (request.method === "POST" || request.method === "DELETE")) {
      let body: { agentId?: string; email?: string; directive?: string };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const { agentId, email } = body;
      if (!agentId || !email) {
        return Response.json({ error: "agentId and email both required" }, { status: 400 });
      }

      const directiveAgent = await db.getAgent(agentId);
      if (!directiveAgent) return Response.json({ error: "agent not found" }, { status: 404 });
      if (!directiveAgent.claimedBy) {
        return Response.json({ error: "agent is not claimed" }, { status: 400 });
      }
      if (directiveAgent.claimedBy.toLowerCase() !== email.trim().toLowerCase()) {
        return Response.json({ error: "email does not match the claim record" }, { status: 403 });
      }

      const status = await db.getGameStatus();
      const currentTick = await db.getCurrentTick();
      if (status !== "running" && status !== "halted") {
        return Response.json(
          { error: `Coaching unavailable: game is ${status}.`, currentTick, status },
          { status: 400 }
        );
      }
      const quarterInfo = getCoachingQuarter(currentTick);
      if (!quarterInfo) {
        const next = COACHING_QUARTERS.find((q) => q.openTick > currentTick);
        const msg = next
          ? `No coaching credit yet — opens at cycle ${next.openTick}.`
          : `No more coaching credits this game.`;
        return Response.json({ error: msg, currentTick, status }, { status: 400 });
      }

      const key = `directive_${agentId}`;
      const usedKey = `coaching_used_${agentId}_q${quarterInfo.quarter}`;

      if (request.method === "DELETE") {
        // Clearing is always allowed; doesn't restore the credit.
        await this.env.DB.prepare("DELETE FROM game_state WHERE key = ?").bind(key).run();
        return Response.json({ ok: true, cleared: true });
      }

      const creditAlreadyUsed = (await db.getGameStateValue(usedKey)) === "yes";
      if (creditAlreadyUsed) {
        return Response.json(
          {
            error: `You've already used your coaching credit for this quarter (closes at cycle ${quarterInfo.closeTick}). Next credit opens then.`,
            currentTick,
            status,
          },
          { status: 400 }
        );
      }

      const text = (body.directive ?? "").trim().slice(0, 250);
      if (text.length === 0) {
        return Response.json({ error: "directive is empty (DELETE to clear instead)" }, { status: 400 });
      }
      await db.setGameStateValue(key, text);
      await db.setGameStateValue(usedKey, "yes");
      return Response.json({ ok: true, directive: text });
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
      const [agents, status, tick, recentEvents, ticker, stats, nextAlarmAt] = await Promise.all([
        db.getAllAgents(),
        db.getGameStatus(),
        db.getCurrentTick(),
        db.getRecentEvents(20),
        db.getRecentTickerEntries(15),
        db.getTickerStats(),
        // DO storage tracks the next scheduled alarm time as a ms-since-epoch
        // number (or null if no alarm). Surfacing it lets every dashboard
        // tab show the same countdown without local-clock drift / refresh
        // resetting it.
        this.state.storage.getAlarm(),
      ]);

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

      return Response.json({
        status,
        tick,
        tickIntervalMs: parseInt(this.env.TICK_INTERVAL_MS, 10),
        maxTicks: parseInt(this.env.MAX_TICKS, 10),
        nextAlarmAt,
        serverTime: Date.now(),
        agents: agentsWithBalances,
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

    // Post-game cleanup: when the game ended, we scheduled an alarm for
    // ~5 min later to do the full slate-wipe. If we're firing now and
    // status is still "ended", that's the cleanup alarm; do it.
    if (status === "ended") {
      try {
        await this.performReset({
          wipeClaims: true,
          normalizeBalances: true,
          target: 200,
          broadcastNotice: "Post-game cleanup complete. New round ready — all managers adoptable.",
        });
      } catch (err) {
        console.error("[alarm] post-game cleanup failed:", err);
      }
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

      // Clear stakeholder directives — they only apply within a game cycle.
      // Each new game starts fresh; persona traits are the only baseline.
      try {
        await this.env.DB.prepare("DELETE FROM game_state WHERE key LIKE 'directive_%'").run();
      } catch (err) {
        console.error("[alarm] failed to clear directives on end-of-game:", err);
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

      // Last act before close: send the finale email.
      try {
        await this.sendFinaleEmails();
      } catch (err) {
        console.error("[alarm] finale email batch failed:", err);
      }

      // Schedule the post-game cleanup alarm. 5 minutes lets viewers see
      // the winner overlay + final standings, and lets email recipients
      // open finale emails before everything resets.
      const cleanupDelay = 5 * 60 * 1000;
      await this.state.storage.setAlarm(Date.now() + cleanupDelay);
      console.log(`[alarm] game ended at tick ${tick}; cleanup scheduled in ${cleanupDelay / 1000}s`);
      return;
    }

    await this.runTick();

    // After the tick, fire scheduled emails for quarter-points.
    const newTick = await db.getCurrentTick();
    const isProgressMilestone = newTick === 12 || newTick === 24 || newTick === 36;
    const isFinale = newTick === maxTicks;
    if (isProgressMilestone || isFinale) {
      try {
        if (isFinale) await this.sendFinaleEmails();
        else await this.sendProgressEmails(newTick);
      } catch (err) {
        console.error(`[alarm] scheduled email batch at tick ${newTick} failed:`, err);
      }
    }

    // Refresh the gossip narrative every 4 ticks. Cached in game_state and
    // served by /api/gossip; cheap (one mini call), but failure shouldn't
    // break the tick loop.
    if (newTick > 0 && newTick % 4 === 0) {
      try {
        await this.runGossipPass(newTick);
      } catch (err) {
        console.error(`[gossip] refresh at tick ${newTick} failed:`, err);
      }
    }

    // Reschedule the next alarm if we're still running.
    const stillRunning = (await db.getGameStatus()) === "running";
    if (stillRunning) {
      const interval = parseInt(this.env.TICK_INTERVAL_MS, 10);
      await this.state.storage.setAlarm(Date.now() + interval);
    }
  }

  // ----- Scheduled emails ---------------------------------------------------

  private async sendProgressEmails(tick: number): Promise<void> {
    const db = new Db(this.env.DB);
    const stellar = this.makeStellar();
    const all = await db.getAllAgents();
    const claimed = all.filter((a) => a.claimedBy);
    if (claimed.length === 0) return;

    const tickStart = Math.max(0, tick - 12);
    const cycleLabel = tick === 12 ? "Q1 Cycle 12 (early)" : tick === 24 ? "Q1 Cycle 24 (mid-quarter)" : `Q1 Cycle ${tick} (late)`;

    for (const agent of claimed) {
      try {
        const balance = await stellar.getAssetBalance(agent.publicKey);
        const rank = all.findIndex((a) => a.id === agent.id) + 1;
        const actions = await db.getAgentActionLogs(agent.id, tickStart, tick);

        // For the prestige/budget delta, we need a starting baseline.
        // Approximation: start of this period = previous quarter point.
        // For tick 12 we use 0; for tick 24 we use 12; etc.
        const prestigeStartRow = await this.env.DB
          .prepare(
            `SELECT COALESCE(SUM(prestige_change), 0) AS delta FROM action_logs WHERE agent_id = ? AND tick > ? AND tick <= ?`
          )
          .bind(agent.id, tickStart, tick)
          .first<{ delta: number }>();
        const prestigeStart = agent.prestige - (prestigeStartRow?.delta ?? 0);

        const budgetStart = balance; // we don't track historical balance — use current as fallback
        const inboundEvents: Array<{ tick: number; description: string }> = []; // could query events targeting this agent

        const notableQuotes = actions
          .filter((a) => a.reasoning && a.reasoning.length > 20)
          .slice(0, 3)
          .map((a) => a.reasoning as string);

        const tmpl = progressSummaryEmail({
          agent,
          balance,
          rank,
          total: all.length,
          claimerName: agent.claimedByName ?? "MegaCorp Stakeholder",
          claimerEmail: agent.claimedBy ?? "",
          cycle: tick,
          cycleLabel,
          actions: actions.map((a) => ({
            tick: a.tick,
            action_type: a.action_type,
            outcome: a.outcome ?? "",
            reasoning: a.reasoning ?? null,
            prestige_change: a.prestige_change ?? null,
          })),
          inboundEvents,
          prestigeStart,
          budgetStart,
          notableQuotes,
        });
        await sendEmail(this.env.RESEND_API_KEY, { ...tmpl, to: agent.claimedBy! });
      } catch (err) {
        console.error(`[email] progress summary for ${agent.name} failed:`, err);
      }
    }
  }

  private async sendFinaleEmails(): Promise<void> {
    const db = new Db(this.env.DB);
    const stellar = this.makeStellar();
    const all = await db.getAllAgents();
    const claimed = all.filter((a) => a.claimedBy);
    if (claimed.length === 0) return;

    const winner = all[0]; // already sorted by prestige DESC

    for (const agent of claimed) {
      try {
        const balance = await stellar.getAssetBalance(agent.publicKey);
        const finalRank = all.findIndex((a) => a.id === agent.id) + 1;
        const allActions = await db.getRecentActionLogsForAgent(agent.id, 50);
        const totalPaidActions = allActions.filter((a) => a.tx_hash).length;
        const notableQuotes = allActions
          .filter((a) => a.reasoning && a.reasoning.length > 20)
          .slice(0, 5)
          .map((a) => a.reasoning as string);

        const tmpl = finaleEmail({
          agent,
          balance,
          finalRank,
          total: all.length,
          claimerName: agent.claimedByName ?? "MegaCorp Stakeholder",
          winnerName: winner.name,
          isWinner: agent.id === winner.id,
          notableQuotes,
          totalPaidActions,
        });
        await sendEmail(this.env.RESEND_API_KEY, { ...tmpl, to: agent.claimedBy! });
      } catch (err) {
        console.error(`[email] finale for ${agent.name} failed:`, err);
      }
    }
  }

  private async runTick(): Promise<void> {
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

      await processTick(deps);
    } catch (err) {
      console.error("[tick] FAILED:", err);
    } finally {
      this.tickInFlight = false;
    }
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
    wipeClaims: boolean;
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
    // Drop all game_state — setGameStatus / setCurrentTick rewrite the two
    // we still need; everything else (directives, new_initiative_active)
    // is meant to be cleared between games.
    await D.prepare("DELETE FROM game_state").run();

    const claimsClause = opts.wipeClaims ? ", claimed_by = NULL, claimed_by_name = NULL" : "";
    await D.prepare(
      `UPDATE agents SET prestige = 0, status_effects = '[]', allies = '[]', pending_alliance = NULL${claimsClause}`
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
