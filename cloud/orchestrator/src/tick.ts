// Tick processing. Phase 5 expands this from a thin port of the laptop
// orchestrator into the full game-mechanics layer:
//   - Random events have real teeth (All-Hands skips Phase 4, Budget Cuts
//     burns 15% on-chain, Reorg dissolves alliances, etc.)
//   - Status effects are actually enforced (tired/problematic prestige decay,
//     under_investigation blocks retaliation)
//   - Every paid action does something real (the 8 dud "intel" actions
//     return useful data and apply tangible side-effects)
//   - New earning paths: Whistleblower Bounty, Mentorship, Coffee Chat,
//     Quarterly Bonus, Employee of the Month — real DLBR transfers from
//     HR / Motivational Speaker back to agents

import { v4 as uuid } from "uuid";
import { Keypair } from "@stellar/stellar-sdk";
import type { Action, Agent, GameEvent, StatusEffect } from "./types.js";
import type { Db } from "./db.js";
import type { Stellar } from "./stellar.js";
import { MppClient, buildServiceUrls, isPaidAction } from "./mpp-client.js";
import { getAgentDecision, type LlmDeps, type TickCtx } from "./llm.js";
import { processRandomEvents, type RandomEventsState } from "./random-events.js";

export interface RewardSources {
  hrDeptSecret: string;
  motivSpeakerSecret: string;
}

export interface TickDeps {
  db: Db;
  stellar: Stellar;
  mpp: MppClient;
  npcBase: string;
  llm: LlmDeps;
  rewards: RewardSources;
  randomEventsState: RandomEventsState;
  emit: (event: GameEvent) => Promise<void>;
}

const HOSTILE_ACTIONS = new Set([
  "file_complaint",
  "sensitivity_training",
  "sabotage_plan",
  "fix_laptop",
  "calendar_conflict",
  "schedule_conflict",
  "poison_meeting",
  "send_motivation",
  "take_credit",
]);

// Multiple flavor variants for fallback paths so we don't see the same
// boilerplate twice in a row.
function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

const TEAM_LUNCH_FALLBACK_FLAVORS = [
  (other: string) =>
    `(Bummed someone — ${other} — already booked the Caterer this cycle. Pivoted to actual work.) `,
  () =>
    `(Tried to book lunch but the Caterer's calendar was triple-stacked by the time I sent the invite. Real synergy lost. Pivoted to work.) `,
  (other: string) =>
    `(Walked over to set up catering, found ${other} already there with the same idea. Awkward small talk, then back to my desk to grind.) `,
  () =>
    `(Texted the Caterer about lunch; got an out-of-office about workshop overcommitment. Had to reroute to actually doing work. Tragic.) `,
  () =>
    `(Lunch booking declined — apparently we're "post-perks" this cycle. Logged a JIRA. Did some work in the meantime.) `,
];

export async function processTick(deps: TickDeps): Promise<void> {
  const { db, stellar, mpp, npcBase, llm, randomEventsState, emit, rewards } = deps;

  const tick = (await db.getCurrentTick()) + 1;
  await db.setCurrentTick(tick);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`TICK ${tick} STARTING`);
  console.log(`${"=".repeat(60)}\n`);

  // Phase 1: expire status effects
  const agents = await db.getAllAgents();
  for (const agent of agents) {
    const updated = agent.statusEffects.filter((e) => !(e.expiresAtTick && e.expiresAtTick <= tick));
    if (updated.length !== agent.statusEffects.length) {
      await db.updateAgentStatusEffects(agent.id, updated);
    }
  }

  // Pre-fetch tick-wide context: full agent roster, recent leaked emails, and
  // every agent's DLBR balance fetched in parallel. Random events (audit) and
  // every getAgentDecision call reuse these instead of refetching, which cuts
  // ~30 subrequests off a typical tick and keeps us under the per-invocation
  // cap on heavy ticks (paid actions, scheduled emails, etc.).
  const refreshedAgents = await db.getAllAgents();
  const leakedEmails = await db.getRecentLeakedEmails(5);
  const balanceEntries = await Promise.all(
    refreshedAgents.map(async (a) => [a.id, await stellar.getAssetBalance(a.publicKey)] as [string, number])
  );
  const balances = new Map(balanceEntries);
  const tickCtx: TickCtx = { allAgents: refreshedAgents, leakedEmails, balances };

  // Phase 2: random events. processRandomEvents now returns events + signals
  // (e.g. skipDecisions when All-Hands fires).
  const eventsResult = await processRandomEvents({ db, stellar, rewards, balances }, randomEventsState, tick);
  for (const event of eventsResult.events) await emit(event);

  // Phase 3: if All-Hands fired, every agent's action this tick is replaced
  // with a synthetic "stuck in the meeting" event. No decisions, no payments.
  if (eventsResult.skipDecisions) {
    const skipping = await db.getAllAgents();
    for (const a of skipping) {
      await emit({
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "action",
        agentId: a.id,
        description: `${a.name}: trapped in the All-Hands. Took notes that nobody will read.`,
        prestigeChange: 0,
        reasoning: "All-Hands meeting consumed the entire cycle.",
      });
    }
    await applyPassiveStatusDecay(deps, tick);
    console.log(`\nTick ${tick} complete (All-Hands skipped decisions).\n`);
    return;
  }

  // Phase 3b: get decisions
  const freshAgents = await db.getAllAgents();
  const decisions: { agent: Agent; action: Action; reasoning: string }[] = [];

  for (const agent of freshAgents) {
    if (agent.statusEffects.some((s) => s.type === "technical_difficulties")) {
      decisions.push({ agent, action: { type: "rest" }, reasoning: "Technical difficulties - forced to rest" });
      continue;
    }
    if (agent.statusEffects.some((s) => s.type === "mandatory_motivation")) {
      decisions.push({ agent, action: { type: "rest" }, reasoning: "Stuck in mandatory motivation session" });
      continue;
    }

    const { action, reasoning } = await getAgentDecision(llm, agent, tick, tickCtx);
    decisions.push({ agent, action, reasoning });
    console.log(`${agent.name}: ${action.type}${("target" in action) ? ` → ${action.target}` : ""}`);
  }

  // Phase 4: execute decisions
  const SERVICE_URLS = buildServiceUrls(npcBase);
  const SINGLETON_ACTIONS = new Set(["team_lunch"]);
  const consumedSingletons = new Map<string, string>(); // type → which agent consumed it

  for (const { agent, action, reasoning } of decisions) {
    let effectiveAction = action;
    let effectiveReasoning = reasoning;

    if (SINGLETON_ACTIONS.has(action.type)) {
      if (consumedSingletons.has(action.type)) {
        const winner = consumedSingletons.get(action.type)!;
        effectiveAction = { type: "work" };
        const flavor = pick(TEAM_LUNCH_FALLBACK_FLAVORS);
        effectiveReasoning = flavor(winner) + reasoning;
      } else {
        consumedSingletons.set(action.type, agent.name);
      }
    }

    await executeAction(deps, SERVICE_URLS, agent, effectiveAction, effectiveReasoning, tick);
  }

  // Phase 5: passive ticks (Inspired bonus + Tired/Problematic decay)
  await applyPassiveStatusDecay(deps, tick);

  // Phase 5b: fatigue check. Any agent who has gone 4+ consecutive ticks
  // without a `rest` action accrues `tired` status (-2 prestige/tick decay
  // for 3 ticks, removable by coffee or rest). Without this, `buy_coffee`
  // and `buy_fancy_coffee` were dead weight in the action economy because
  // `tired` was almost never applied — the coffee_machine_broken random
  // event was its only source.
  await applyFatigue(deps, tick);

  console.log(`\nTick ${tick} complete.\n`);
}

async function applyFatigue(deps: TickDeps, tick: number): Promise<void> {
  const { db, emit } = deps;
  // Window widened from 4 → 6 cycles. The 4-cycle threshold caused a
  // synchronized wall around tick 5 (everyone hit fatigue at once because
  // every agent's history starts at tick 1). 6 desyncs them and gives the
  // game a chance to spread the tired status organically.
  const FATIGUE_WINDOW = 6;
  const agents = await db.getAllAgents();
  for (const agent of agents) {
    if (agent.statusEffects.some((e) => e.type === "tired" || e.type === "caffeinated")) continue;
    const recent = await db.getRecentActionLogsForAgent(agent.id, FATIGUE_WINDOW);
    if (recent.length < FATIGUE_WINDOW) continue;
    const allNonRest = recent.every((r) => r.action_type !== "rest");
    if (!allNonRest) continue;
    await db.updateAgentStatusEffects(agent.id, [
      ...agent.statusEffects,
      { type: "tired", expiresAtTick: tick + 3 },
    ]);
    await emit({
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: "status_effect",
      agentId: agent.id,
      description: `${agent.name} hit the wall (${FATIGUE_WINDOW} cycles without rest) — now Tired (-2 prestige/cycle for 3 cycles, removed by coffee).`,
    });
  }
}

/**
 * Phase 5 of every tick: status-driven prestige changes that don't depend
 * on actions taken. Inspired adds, Tired and Problematic subtract.
 */
async function applyPassiveStatusDecay(deps: TickDeps, tick: number): Promise<void> {
  const { db, emit } = deps;
  for (const agent of await db.getAllAgents()) {
    let net = 0;
    const reasons: string[] = [];

    if (agent.statusEffects.some((s) => s.type === "inspired" && s.expiresAtTick > tick)) {
      net += 5;
      reasons.push("Inspired (+5)");
    }
    if (agent.statusEffects.some((s) => s.type === "tired")) {
      net -= 2;
      reasons.push("Tired (-2)");
    }
    if (agent.statusEffects.some((s) => s.type === "problematic")) {
      net -= 3;
      reasons.push("Problematic (-3)");
    }

    if (net !== 0) {
      await db.updateAgentPrestige(agent.id, net);
      await emit({
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "status_effect",
        agentId: agent.id,
        description: `${agent.name}: ${net > 0 ? "+" : ""}${net} prestige (${reasons.join(", ")})`,
        prestigeChange: net,
      });
    }
  }
}

async function executeAction(
  deps: TickDeps,
  serviceUrls: ReturnType<typeof buildServiceUrls>,
  agent: Agent,
  action: Action,
  reasoning: string,
  tick: number
): Promise<void> {
  const { db, emit } = deps;

  let outcome = "";
  let prestigeChange = 0;
  let txHash: string | undefined;

  try {
    switch (action.type) {
      case "work":
        prestigeChange = 5;
        outcome = "Did actual work";
        await db.updateAgentPrestige(agent.id, prestigeChange);
        break;

      case "rest": {
        outcome = "Rested";
        const a = (await db.getAgent(agent.id))!;
        await db.updateAgentStatusEffects(agent.id, a.statusEffects.filter((e) => e.type !== "tired"));
        break;
      }

      case "schmooze":
        if ("target" in action) {
          outcome = await handleSchmooze(deps, agent, action.target);
        }
        break;

      case "take_credit":
        if ("target" in action) {
          // Marked targets (from sabotage_plan) auto-succeed — the dossier
          // is in your hand and the receipts have been pre-disputed.
          const target = await db.getAgent(action.target);
          const targetIsMarked = target?.statusEffects.some((e) => e.type === "marked") ?? false;
          const success = targetIsMarked || Math.random() < 0.4;
          if (success) {
            prestigeChange = 30;
            outcome = targetIsMarked
              ? `Successfully took credit for ${action.target}'s work (the sabotage dossier made it stick)`
              : `Successfully took credit for ${action.target}'s work`;
          } else {
            prestigeChange = -20;
            outcome = `Failed to take credit - ${action.target} had receipts`;
          }
          await db.updateAgentPrestige(agent.id, prestigeChange);
          // Marked status is consumed once exploited.
          if (targetIsMarked && target) {
            await db.updateAgentStatusEffects(
              action.target,
              target.statusEffects.filter((e) => e.type !== "marked")
            );
          }
        }
        break;

      case "accept_alliance":
        if ("target" in action && agent.pendingAlliance === action.target) {
          outcome = await handleAllianceAccept(deps, agent, action.target, tick, reasoning);
          prestigeChange = 5;
        }
        break;

      case "reject_alliance":
        if ("target" in action && agent.pendingAlliance === action.target) {
          outcome = await handleAllianceReject(deps, agent, action.target, tick, reasoning);
        }
        break;

      case "break_alliance":
        if ("target" in action && agent.allies.includes(action.target)) {
          outcome = await handleAllianceBreak(deps, agent, action.target, tick, reasoning);
          prestigeChange = -15; // self-cost reduced from -30 (handler also locks ex-ally out for 1 tick)
        }
        break;

      default:
        if (isPaidAction(action.type, serviceUrls)) {
          const result = await executePaidAction(deps, serviceUrls, agent, action, tick, reasoning);
          outcome = result.outcome;
          prestigeChange = result.prestigeChange;
          txHash = result.txHash;
        } else {
          outcome = "Unknown action";
        }
    }
  } catch (err) {
    outcome = `Error: ${err instanceof Error ? err.message : "Unknown error"}`;
  }

  await db.logAction(tick, agent.id, action.type, action, reasoning, outcome, prestigeChange, txHash);

  const HANDLER_EMITS_OWN: Set<Action["type"]> = new Set([
    "accept_alliance",
    "reject_alliance",
    "break_alliance",
  ]);
  if (HANDLER_EMITS_OWN.has(action.type)) return;

  await emit({
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: txHash ? "payment" : "action",
    agentId: agent.id,
    targetId: "target" in action ? action.target : undefined,
    description: `${agent.name}: ${outcome}`,
    prestigeChange,
    txHash,
    reasoning,
  });
}

async function executePaidAction(
  deps: TickDeps,
  serviceUrls: ReturnType<typeof buildServiceUrls>,
  agent: Agent,
  action: Action,
  tick: number,
  reasoning?: string
): Promise<{ outcome: string; prestigeChange: number; txHash?: string }> {
  const { db, mpp, stellar, rewards } = deps;
  const serviceInfo = serviceUrls[action.type];
  if (!serviceInfo) return { outcome: "Unknown paid action", prestigeChange: 0 };

  const keypair = Keypair.fromSecret(agent.secretKey);
  const body = "target" in action ? { target: action.target } : undefined;

  const result = await mpp.callPaidService(
    agent.id,
    agent.name,
    keypair,
    serviceInfo.url,
    serviceInfo.name,
    serviceInfo.price,
    body,
    reasoning
  );

  if (!result.success) {
    return { outcome: `Failed: ${result.error}`, prestigeChange: 0 };
  }

  let prestigeChange = 0;
  let outcome = "";

  switch (action.type) {
    case "buy_coffee": {
      outcome = "Bought coffee - productivity boosted";
      const a = (await db.getAgent(agent.id))!;
      await db.updateAgentStatusEffects(agent.id, a.statusEffects.filter((e) => e.type !== "tired"));
      break;
    }

    case "buy_fancy_coffee": {
      outcome = "Bought fancy coffee - feeling caffeinated";
      const a = (await db.getAgent(agent.id))!;
      const newEffects: StatusEffect[] = [
        ...a.statusEffects.filter((e) => e.type !== "tired" && e.type !== "caffeinated"),
        { type: "caffeinated", expiresAtTick: tick + 2 },
      ];
      await db.updateAgentStatusEffects(agent.id, newEffects);
      break;
    }

    case "file_complaint":
      if ("target" in action) {
        // Buff: filer also gets +5 prestige for "managerial diligence." Without
        // this the action only restricted the target's retaliation and gave
        // the filer nothing — strictly worse than free take_credit.
        prestigeChange = 5;
        outcome = `Filed HR complaint against ${action.target}; you receive a "diligence" prestige bonus`;
        await db.updateAgentPrestige(agent.id, prestigeChange);
        const target = await db.getAgent(action.target);
        if (target) {
          await db.updateAgentStatusEffects(action.target, [
            ...target.statusEffects,
            { type: "under_investigation", expiresAtTick: tick + 1, source: agent.id },
          ]);
        }
      }
      break;

    case "sensitivity_training":
      if ("target" in action) {
        const target = await db.getAgent(action.target);
        if (target) {
          // Well-allied targets (3+ alliances) absorb half the prestige hit.
          // Coalition-builders are politically harder to torpedo.
          const wellAllied = target.allies.length >= 3;
          const hit = wellAllied ? -10 : -20;
          outcome = wellAllied
            ? `Sent ${action.target} to sensitivity training; their alliances softened the blow (${hit} prestige instead of -20)`
            : `Sent ${action.target} to sensitivity training (${hit} prestige)`;
          await db.updateAgentPrestige(action.target, hit);
          await db.updateAgentStatusEffects(action.target, [
            ...target.statusEffects,
            { type: "problematic", expiresAtTick: tick + 4, source: agent.id },
          ]);
        }
      }
      break;

    case "check_hr_status": {
      // Reveal complaints filed against the agent (under_investigation entries
      // where source = filer).
      const me = (await db.getAgent(agent.id))!;
      const open = me.statusEffects.filter((e) => e.type === "under_investigation");
      if (open.length === 0) {
        outcome = "Checked HR — slate is clean. No complaints on file.";
      } else {
        const filers = open.map((e) => e.source).filter(Boolean) as string[];
        outcome = `HR records show ${open.length} active complaint(s), filed by: ${filers.join(", ")}`;
      }
      break;
    }

    case "competitive_intel": {
      const all = await db.getAllAgents();
      const top3 = all.slice(0, 3).filter((a) => a.id !== agent.id);
      const lines: string[] = [];
      for (const t of top3) {
        const last = await db.getAgentLastActionLog(t.id);
        const shortAction = last ? `${last.action_type} (t${last.tick})` : "no recent action";
        lines.push(`${t.name}: ${shortAction}`);
      }
      // New: also spread rumors that nick the leader. Pure-info actions were
      // never picked in the first run; an immediate -3 to the top non-self
      // rival makes this a real competitive move.
      const topRival = top3[0];
      if (topRival) {
        await db.updateAgentPrestige(topRival.id, -3);
      }
      outcome = `Competitive intel — top 3 last moves: ${lines.join("; ")}.${topRival ? ` Rumor-spreading nicked ${topRival.name} for -3 prestige.` : ""}`;
      break;
    }

    case "sabotage_plan":
      if ("target" in action) {
        // Stronger prestige hit + 2-tick "marked" debuff. Well-allied targets
        // halve the prestige damage.
        const recent = await db.getRecentActionLogsForAgent(action.target, 3);
        const summary = recent.length > 0
          ? recent.map((r) => `t${r.tick}:${r.action_type}`).join(", ")
          : "no recent activity";
        const target = await db.getAgent(action.target);
        const wellAllied = target ? target.allies.length >= 3 : false;
        const hit = wellAllied ? -5 : -10;
        await db.updateAgentPrestige(action.target, hit);
        if (target) {
          await db.updateAgentStatusEffects(action.target, [
            ...target.statusEffects.filter((e) => e.type !== "marked"),
            { type: "marked", expiresAtTick: tick + 2, source: agent.id },
          ]);
        }
        outcome = wellAllied
          ? `Sabotage dossier on ${action.target}: ${hit} prestige (alliance bloc absorbed half the hit) + marked for 2 cycles. Recent moves: ${summary}`
          : `Sabotage dossier on ${action.target}: ${hit} prestige + marked for 2 cycles (next take_credit against them auto-succeeds). Recent moves: ${summary}`;
      }
      break;

    case "recover_emails":
      if ("target" in action) {
        const recent = await db.getRecentActionLogsForAgent(action.target, 3);
        const summary = recent.length > 0
          ? recent.map((r) => `t${r.tick}:${r.action_type}`).join(", ")
          : "no recent activity";
        // Buff: 30% chance to expose & nuke the target's pending alliance.
        // Adds an actionable wrinkle on top of the info reveal.
        const target = await db.getAgent(action.target);
        let expose = "";
        if (target && target.pendingAlliance && Math.random() < 0.3) {
          await db.updateAgentPendingAlliance(action.target, null);
          expose = ` Bonus find: forwarded a draft alliance with ${target.pendingAlliance} that quietly evaporated.`;
        }
        outcome = `Recovered ${action.target}'s recent inbox traces: ${summary}.${expose}`;
      }
      break;

    case "calendar_conflict":
      if ("target" in action) {
        const target = await db.getAgent(action.target);
        if (target) {
          // Buff: always apply meeting_blocked (1 tick) on top of clearing
          // has_deliverable + pending_alliance. Without this, calendar_conflict
          // did literally nothing if the target had neither — and most agents
          // don't.
          const cleaned = target.statusEffects.filter((e) => e.type !== "has_deliverable");
          await db.updateAgentStatusEffects(action.target, [
            ...cleaned,
            { type: "meeting_blocked", expiresAtTick: tick + 1, source: agent.id },
          ]);
          await db.updateAgentPendingAlliance(action.target, null);
          outcome = `Triple-booked ${action.target}'s calendar. Deliverable prep + pending alliance gone, and they're meeting-blocked for 1 cycle.`;
        }
      }
      break;

    case "leak_org_chart": {
      const all = await db.getAllAgents();
      const balances = await Promise.all(
        all.map(async (a) => ({ name: a.name, bal: await stellar.getAssetBalance(a.publicKey) }))
      );
      balances.sort((a, b) => b.bal - a.bal);
      const top = balances.slice(0, 3).map((b) => `${b.name}: $${b.bal.toFixed(0)}`).join(", ");
      const allies = all
        .filter((a) => a.allies.length > 0)
        .map((a) => `${a.id}↔${a.allies.join(",")}`)
        .join(" | ");
      // Buff: tangible reward — +5 prestige for "positioning yourself well
      // with insider info." Otherwise this $25 action returned data the LLM
      // already had access to.
      prestigeChange = 5;
      await db.updateAgentPrestige(agent.id, prestigeChange);
      outcome = `Insider info — wealth ranking top 3: ${top}. Active alliances: ${allies || "none"}. Positional advantage: +5 prestige.`;
      break;
    }

    case "schedule_conflict":
      if ("target" in action) {
        const target = await db.getAgent(action.target);
        if (target) {
          const cleaned = target.statusEffects.filter((e) => e.type !== "has_deliverable");
          await db.updateAgentStatusEffects(action.target, [
            ...cleaned,
            { type: "meeting_blocked", expiresAtTick: tick + 2, source: agent.id },
          ]);
          outcome = `Cancelled ${action.target}'s CEO meeting. They're meeting-blocked for 2 cycles.`;
        }
      }
      break;

    case "poison_meeting":
      if ("target" in action) {
        const target = await db.getAgent(action.target);
        const wellAllied = target ? target.allies.length >= 3 : false;
        const hit = wellAllied ? -5 : -10;
        await db.updateAgentPrestige(action.target, hit);
        outcome = wellAllied
          ? `Sabotaged ${action.target}'s catering — but their allies covered the optics. ${hit} prestige instead of -10.`
          : `Sabotaged ${action.target}'s catering. They lose ${hit} prestige in the post-meeting fallout.`;
      }
      break;

    case "fix_laptop":
      if ("target" in action) {
        outcome = `Sabotaged ${action.target}'s laptop`;
        const target = await db.getAgent(action.target);
        if (target) {
          await db.updateAgentStatusEffects(action.target, [
            ...target.statusEffects,
            { type: "technical_difficulties", expiresAtTick: tick + 1, source: agent.id },
          ]);
        }
      }
      break;

    case "strategy_report": {
      // The New Initiative midgame event halves future strategy report rewards.
      // Bumped from 25→35 (and 12→18 post-NI) so the LLM picks it more often
      // — in the previous run nobody ever held has_deliverable when New
      // Initiative fired, which made the midgame pivot toothless.
      const newInit = (await db.getGameStateValue("new_initiative_active")) === "true";
      prestigeChange = newInit ? 18 : 35;
      outcome = `Received consultant report${newInit ? " (post-pivot, prestige halved)" : ""}: "${result.data?.deliverable?.title || "Strategic Document"}"`;
      await db.updateAgentPrestige(agent.id, prestigeChange);
      const a = (await db.getAgent(agent.id))!;
      await db.updateAgentStatusEffects(agent.id, [...a.statusEffects, { type: "has_deliverable", expiresAtTick: 999 }]);
      break;
    }

    case "book_ceo_time": {
      const a = (await db.getAgent(agent.id))!;
      const hasDeliverable = a.statusEffects.some((e) => e.type === "has_deliverable");
      const blocked = a.statusEffects.some((e) => e.type === "meeting_blocked");
      if (blocked) {
        prestigeChange = -10;
        outcome = "CEO meeting blocked — prior schedule conflict couldn't be resolved";
      } else if (hasDeliverable) {
        prestigeChange = 40;
        outcome = "CEO meeting successful - impressed with deliverable";
        await db.updateAgentStatusEffects(agent.id, a.statusEffects.filter((e) => e.type !== "has_deliverable"));
      } else {
        prestigeChange = -20;
        outcome = "CEO meeting awkward - had nothing to present";
      }
      await db.updateAgentPrestige(agent.id, prestigeChange);
      break;
    }

    case "team_lunch":
      prestigeChange = 15;
      outcome = "Hosted team lunch - everyone appreciated the free food";
      await db.updateAgentPrestige(agent.id, prestigeChange);
      break;

    case "birthday_cake": {
      prestigeChange = 5;
      outcome = "Brought birthday cake - removed Problematic status";
      await db.updateAgentPrestige(agent.id, prestigeChange);
      const a = (await db.getAgent(agent.id))!;
      await db.updateAgentStatusEffects(agent.id, a.statusEffects.filter((e) => e.type !== "problematic"));
      break;
    }

    case "book_motivation": {
      prestigeChange = 20;
      outcome = "Attended motivation session - feeling inspired";
      await db.updateAgentPrestige(agent.id, prestigeChange);
      const a = (await db.getAgent(agent.id))!;
      await db.updateAgentStatusEffects(agent.id, [...a.statusEffects, { type: "inspired", expiresAtTick: tick + 2 }]);
      break;
    }

    case "send_motivation":
      if ("target" in action) {
        outcome = `Sent ${action.target} to mandatory motivation`;
        const target = await db.getAgent(action.target);
        if (target) {
          await db.updateAgentStatusEffects(action.target, [
            ...target.statusEffects,
            { type: "mandatory_motivation", expiresAtTick: tick + 2, source: agent.id },
          ]);
        }
      }
      break;

    case "whistleblower_bounty":
      if ("target" in action) {
        const recent = await db.getRecentActionLogsForAgent(action.target, 6);
        const cutoff = tick - 3;
        const recentHostile = recent.filter(
          (r) => r.tick >= cutoff && HOSTILE_ACTIONS.has(r.action_type)
        );
        if (recentHostile.length > 0) {
          // Valid report. HR pays $25 bounty + 30 prestige.
          prestigeChange = 30;
          await db.updateAgentPrestige(agent.id, prestigeChange);
          let payHash: string | undefined;
          try {
            payHash = await stellar.sendAsset(rewards.hrDeptSecret, agent.publicKey, 25);
          } catch (err) {
            console.error(`[whistleblower] HR payout to ${agent.name} failed:`, err);
          }
          outcome = `Whistleblower bounty paid — ${action.target} flagged for ${recentHostile.length} hostile action(s) in the last 3 cycles. HR sent $25.`;
          if (payHash) outcome += ` (tx: ${payHash.slice(0, 8)}…)`;
        } else {
          // Bad-faith report. Small prestige hit (was -10; lowered to -3 so
          // the bounty is worth attempting more often). Target still gets +5
          // wrongful-report bonus for the inconvenience.
          prestigeChange = -3;
          await db.updateAgentPrestige(agent.id, prestigeChange);
          await db.updateAgentPrestige(action.target, 5);
          outcome = `Whistleblower report against ${action.target} unsubstantiated — HR found nothing. You: -3 prestige. ${action.target}: +5 prestige (wrongful-report bonus).`;
        }
      }
      break;

    case "mentorship":
      if ("target" in action) {
        prestigeChange = 5;
        await db.updateAgentPrestige(agent.id, prestigeChange);
        await db.updateAgentPrestige(action.target, 10);
        let payHash: string | undefined;
        try {
          payHash = await stellar.sendAsset(rewards.motivSpeakerSecret, agent.publicKey, 30);
        } catch (err) {
          console.error(`[mentorship] Speaker payout to ${agent.name} failed:`, err);
        }
        outcome = `Mentored ${action.target} (+10 prestige to them, +5 to me). Pay-It-Forward stipend: $30.`;
        if (payHash) outcome += ` (tx: ${payHash.slice(0, 8)}…)`;
      }
      break;

    case "coffee_chat":
      if ("target" in action) {
        prestigeChange = 3;
        await db.updateAgentPrestige(agent.id, prestigeChange);
        await db.updateAgentPrestige(action.target, 3);
        outcome = `Low-stakes coffee with ${action.target}. Both +3 prestige, no alliance proposed.`;
      }
      break;

    default:
      outcome = `Completed ${action.type}`;
  }

  return { outcome, prestigeChange, txHash: result.txHash };
}

async function handleSchmooze(deps: TickDeps, agent: Agent, targetId: string): Promise<string> {
  // Re-fetch both sides — the agent reference passed in is the snapshot from
  // before this tick's actions ran, so allies modified earlier in the tick
  // won't be visible. Reading fresh prevents a re-propose against an
  // already-formed alliance.
  const me = await deps.db.getAgent(agent.id);
  const target = await deps.db.getAgent(targetId);
  if (!target) return "Target not found";
  if (targetId === agent.id) return "Tried to schmooze yourself. The IT system flagged it.";
  if (me?.allies.includes(targetId) || target.allies.includes(agent.id)) {
    return `Chatted with ally ${target.name}`;
  }
  // Don't overwrite an existing pending — if target already has someone
  // pending (especially us), no-op.
  if (target.pendingAlliance && target.pendingAlliance !== agent.id) {
    return `${target.name} already has a pending alliance offer; deferred.`;
  }
  await deps.db.updateAgentPendingAlliance(targetId, agent.id);
  return `Proposed alliance to ${target.name}`;
}

async function handleAllianceAccept(deps: TickDeps, agent: Agent, proposerId: string, tick: number, reasoning?: string): Promise<string> {
  const { db, emit } = deps;
  const proposer = await db.getAgent(proposerId);
  if (!proposer) return "Proposer not found";

  await db.updateAgentAllies(agent.id, [...agent.allies, proposerId]);
  await db.updateAgentAllies(proposerId, [...proposer.allies, agent.id]);
  await db.updateAgentPendingAlliance(agent.id, null);
  await db.updateAgentPrestige(agent.id, 5);
  await db.updateAgentPrestige(proposerId, 5);

  await emit({
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "alliance_formed",
    agentId: agent.id,
    targetId: proposerId,
    description: `${agent.name} and ${proposer.name} formed an alliance`,
    prestigeChange: 5,
    reasoning,
  });

  return `Formed alliance with ${proposer.name}`;
}

async function handleAllianceReject(deps: TickDeps, agent: Agent, proposerId: string, tick: number, reasoning?: string): Promise<string> {
  const { db, emit } = deps;
  const proposer = await db.getAgent(proposerId);
  if (!proposer) return "Proposer not found";

  await db.updateAgentPendingAlliance(agent.id, null);
  await db.updateAgentPrestige(proposerId, -10);

  await emit({
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "alliance_rejected",
    agentId: agent.id,
    targetId: proposerId,
    description: `${agent.name} rejected ${proposer.name}'s alliance proposal`,
    prestigeChange: -10,
    reasoning,
  });

  return `Rejected alliance with ${proposer.name}`;
}

async function handleAllianceBreak(deps: TickDeps, agent: Agent, formerAllyId: string, tick: number, reasoning?: string): Promise<string> {
  const { db, emit } = deps;
  const formerAlly = await db.getAgent(formerAllyId);
  if (!formerAlly) return "Former ally not found";

  await db.updateAgentAllies(agent.id, agent.allies.filter((id) => id !== formerAllyId));
  await db.updateAgentAllies(formerAllyId, formerAlly.allies.filter((id) => id !== agent.id));

  // Reworked: was self -30 / ex-ally +15 (pure loss for the betrayer; never
  // chosen). Now self -15, ex-ally gets `under_investigation` against you for
  // 1 tick — they can't immediately retaliate. Calculated nuke instead of
  // pointless self-harm.
  await db.updateAgentPrestige(agent.id, -15);
  await db.updateAgentStatusEffects(formerAllyId, [
    ...formerAlly.statusEffects.filter((e) =>
      !(e.type === "under_investigation" && e.source === agent.id)
    ),
    { type: "under_investigation", expiresAtTick: tick + 1, source: agent.id },
  ]);

  await emit({
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "alliance_broken",
    agentId: agent.id,
    targetId: formerAllyId,
    description: `${agent.name} BETRAYED ${formerAlly.name}! ${formerAlly.name} is locked out of retaliation for 1 cycle.`,
    prestigeChange: -15,
    reasoning,
  });

  return `Betrayed ${formerAlly.name}`;
}
