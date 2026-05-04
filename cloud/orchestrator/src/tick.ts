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
import { getPersona } from "./personas.js";

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

// Rumor flavor bank — surfaced inline in the spread_rumor action's
// outcome string. Keep these specific and audience-funny; generic rumors
// don't land. Add more freely; selection is uniform random.
const RUMOR_FLAVORS = [
  "use Comic Sans in their slide decks",
  "still have a flip phone (ironically, allegedly)",
  "schedule a 30-min 'thinking time' block on their calendar daily",
  "ate someone else's labeled lunch from the office fridge",
  "got coached on email tone twice this quarter",
  "asked Bain & Company to do their performance review",
  "cried during their last 1:1 (the one that was supposed to be casual)",
  "wrote 'circle back' three times in one Slack message",
  "had to be reminded what 'mute' does in 2026",
  "hired their cousin as a 'consultant' for a strategic offsite",
  "draft LinkedIn thought-leadership posts during standup",
  "added 'Dr.' to their email signature (it was an honorary degree)",
  "asked HR what 'PIP' stood for, then claimed they were joking",
  "have an out-of-office set every Friday afternoon citing 'deep work'",
  "took the meditation room booking off Slack so they could nap in there",
  "use 'reach out' as a noun, a verb, and a personality trait",
  "keep a printed copy of their own LinkedIn profile in a desk drawer",
  "told the new hire to 'just figure it out' and left the country",
];

// Slack Bomb flavor — what kind of #general post the agent dropped.
const SLACK_BOMB_FLAVORS = [
  "Posted a 1,200-word screed in #general about 'team alignment.'",
  "Started a 47-message thread asking 'who decided this?' — Slack lit up.",
  "Made #general a graveyard for the rest of the day.",
  "Sent a passive-aggressive 'just a friendly reminder' to all-staff.",
  "Replied-all to a six-month-old thread with a single sad emoji.",
  "Posted a survey nobody asked for, then complained that engagement was low.",
  "Quote-tweeted the CEO's last announcement with 'thoughts?'",
];

// Schmooze-with-existing-ally flavor. Without variety this read identically
// every time and the audience clocked it as a bug.
const SCHMOOZE_ALLY_FLAVORS = (target: string) => [
  `Caught up with ${target} over coffee. Same-page energy.`,
  `Pinged ${target} just to vibe-check. They're still in.`,
  `Did the standing 1:1 with ${target}. Mostly therapy.`,
  `Reaffirmed the cross-functional alignment with ${target}.`,
  `Walked-and-talked with ${target}. Nothing of substance discussed.`,
  `Looped ${target} in on a thread that did not require their input.`,
  `Slacked ${target} a meme. Both laughed. Productivity unchanged.`,
];

// Per-(actionType, target) cooldown window. Hostile actions targeting
// the same person within this many ticks fizzle into a no-op flavor
// outcome. Surfaced to the LLM in the prompt; enforced here as a
// guardrail in case the model ignores the warning. Matches the
// TARGET_COOLDOWN_TICKS in llm.ts.
const TARGET_COOLDOWN_TICKS = 10;
const COOLDOWN_FIZZLE_FLAVORS = [
  (verb: string, target: string) => `Tried to ${verb} ${target} again, but the office gossip mill is bored of this storyline.`,
  (verb: string, target: string) => `Went to ${verb} ${target}, then realized you'd done it last cycle. Walked back to your desk.`,
  (verb: string, target: string) => `${target} preempted the move with a "we should talk" Slack DM. Standoff. Cycle wasted.`,
  (verb: string, target: string) => `HR flagged this as 'a pattern' before you could even submit. No effect.`,
];
async function checkTargetCooldown(
  deps: TickDeps,
  attackerId: string,
  actionType: string,
  targetId: string,
  currentTick: number
): Promise<{ onCooldown: boolean; lastTick?: number }> {
  const key = `cd_${actionType}_${attackerId}_${targetId}`;
  const v = await deps.db.getGameStateValue(key);
  if (!v) return { onCooldown: false };
  const lastTick = parseInt(v, 10);
  if (currentTick - lastTick < TARGET_COOLDOWN_TICKS) {
    return { onCooldown: true, lastTick };
  }
  return { onCooldown: false };
}
async function recordTargetUse(
  deps: TickDeps,
  attackerId: string,
  actionType: string,
  targetId: string,
  currentTick: number
): Promise<void> {
  await deps.db.setGameStateValue(`cd_${actionType}_${attackerId}_${targetId}`, String(currentTick));
}
function fizzleOutcome(actionType: string, targetName: string): string {
  const verbMap: Record<string, string> = {
    spread_rumor: "spread another rumor about",
    sensitivity_training: "send to sensitivity training",
    sabotage_plan: "build a fresh dossier on",
    take_credit: "take credit from",
  };
  const verb = verbMap[actionType] ?? actionType;
  const fn = COOLDOWN_FIZZLE_FLAVORS[Math.floor(Math.random() * COOLDOWN_FIZZLE_FLAVORS.length)];
  return fn(verb, targetName);
}

// Retreat-mode hostile action set. Used by random events that count
// hostility (e.g. Surprise Board Visit's "scrutinized" pick) and by any
// future bounty/audit logic.
const HOSTILE_ACTIONS = new Set([
  "take_credit",
  "spread_rumor",
  "move_meeting_early",
  "schedule_pre_meeting",
  "file_complaint",
  "sensitivity_training",
  "schedule_conflict",
  "anonymous_pulse_survey",
  "hostile_takeover",
  "sabotage_plan",
]);

/**
 * Runs one tick of the simulation. In retreat round-robin mode the caller
 * passes the IDs of the agents who should act this tick — typically 2 at
 * a time, one per ~12.5s of the 25s tick window. They run sequentially
 * within the same alarm: status expiry, random events (if applicable),
 * then each agent's decision + execution in order, then passive decay.
 *
 * Cycle = 5 ticks (10 agents acting at 2/tick = full round). Random
 * events fire only at:
 *   - tick 1 (Q1 Kickoff per-agent reactions)
 *   - cycle boundaries (every 5th tick) for the probabilistic pool,
 *     fixed-cycle bonuses, and the guaranteed cycle-1 closer
 * Intra-cycle ticks stay clean — just the action drumbeat.
 */
export async function processTick(deps: TickDeps, activeAgentIds?: string[]): Promise<void> {
  const { db, stellar, mpp, npcBase, llm, randomEventsState, emit, rewards } = deps;

  const tick = (await db.getCurrentTick()) + 1;
  await db.setCurrentTick(tick);

  const isCycleBoundary = tick % 5 === 0;
  const isKickoff = tick === 1;
  const fireRandomEvents = isKickoff || isCycleBoundary;

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

  // Phase 2: random events fire at cycle boundaries + tick 1 (kickoff).
  if (fireRandomEvents) {
    const eventsResult = await processRandomEvents({ db, stellar, rewards, balances }, randomEventsState, tick);
    for (const event of eventsResult.events) await emit(event);
    // skipDecisions (All-Hands) is no longer used in retreat mode — kept the
    // signal in random-events for compat but ignored here.
  }

  // Phase 3: get decisions for the active agents this tick (typically 2).
  // Resolve in turn-order — earlier agents in activeAgentIds act first
  // and their state changes are visible to subsequent agents within the
  // same tick (e.g. if A schmoozes B then B's pendingAlliance is set
  // when B acts).
  const freshAgents = await db.getAllAgents();
  const agentById = new Map(freshAgents.map((a) => [a.id, a] as const));
  const actingAgents = activeAgentIds && activeAgentIds.length > 0
    ? activeAgentIds.map((id) => agentById.get(id)).filter((a): a is Agent => !!a)
    : freshAgents;
  const decisions: { agent: Agent; action: Action; reasoning: string }[] = [];

  for (const agent of actingAgents) {
    const { action, reasoning } = await getAgentDecision(llm, agent, tick, tickCtx);
    decisions.push({ agent, action, reasoning });
    console.log(`${agent.name}: ${action.type}${("target" in action) ? ` → ${action.target}` : ""}`);
  }

  // Phase 4: execute decisions. Retreat mode has no singleton actions
  // (team_lunch was the only one and is cut). Each agent's choice runs as-is.
  const SERVICE_URLS = buildServiceUrls(npcBase);
  for (const { agent, action, reasoning } of decisions) {
    await executeAction(deps, SERVICE_URLS, agent, action, reasoning, tick);
  }

  // Phase 4b: Mysterious Influence misattribution. After each agent acts,
  // every other agent holding Mysterious Influence has a 10% roll to be
  // falsely credited for it. Pure flavor — no prestige movement — but
  // the running joke is the office cipher who keeps getting credit.
  for (const d of decisions) {
    await applyMysteriousInfluenceMisattribution(deps, tick, d);
  }

  // Phase 5: passive ticks (Inspired bonus + Tired/Problematic decay)
  await applyPassiveStatusDecay(deps, tick);

  // Retreat mode: natural fatigue accrual is dropped. Hit the Wall is now
  // spread only by the move_meeting_early action as an intentional weapon —
  // ambient burnout doesn't fit a 30-min show where every cycle wants a
  // visible paid action.

  console.log(`\nTick ${tick} complete.\n`);
}

const MYSTERIOUS_CREDIT_FLAVORS = [
  (mystery: string, actor: string, action: string) =>
    `${mystery} was somehow involved in ${actor}'s ${action}. Nobody can explain how.`,
  (mystery: string, actor: string, action: string) =>
    `Reports surface that ${mystery} "consulted" on ${actor}'s ${action}. Reports are unsourced.`,
  (mystery: string, actor: string, action: string) =>
    `${mystery}'s name appears on the post-mortem for ${actor}'s ${action}. They were not on the post-mortem.`,
  (mystery: string, actor: string, action: string) =>
    `${actor}'s ${action} is mysteriously credited to ${mystery} in the all-hands recap deck.`,
  (mystery: string, actor: string) =>
    `Three separate Slack messages confirm ${mystery} was on the kickoff invite for ${actor}'s last move. There was no kickoff.`,
  (mystery: string) =>
    `${mystery} just got cc'd on something that did not concern them. They replied "thanks for the loop."`,
];

/**
 * Phase 4b: 10% chance per Mysterious Influence holder (other than the
 * active agent) to surface a flavor event crediting them for whatever
 * the active agent just did. Pure comedy — no prestige movement.
 */
async function applyMysteriousInfluenceMisattribution(
  deps: TickDeps,
  tick: number,
  active: { agent: Agent; action: Action; reasoning: string }
): Promise<void> {
  const { db, emit } = deps;
  const all = await db.getAllAgents();
  const influencers = all.filter(
    (a) => a.id !== active.agent.id && a.statusEffects.some((s) => s.type === "mysterious_influence")
  );
  for (const influencer of influencers) {
    if (Math.random() >= 0.10) continue;
    const flavor = MYSTERIOUS_CREDIT_FLAVORS[Math.floor(Math.random() * MYSTERIOUS_CREDIT_FLAVORS.length)];
    const description = flavor(influencer.name, active.agent.name, active.action.type);
    await emit({
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: "status_effect",
      agentId: influencer.id,
      description,
      prestigeChange: 0,
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

    if (agent.statusEffects.some((s) => s.type === "mysterious_influence")) {
      net += 2;
      reasons.push("Mysterious Influence");
    }
    if (agent.statusEffects.some((s) => s.type === "inspired" && s.expiresAtTick > tick)) {
      net += 5;
      reasons.push("Inspired");
    }
    if (agent.statusEffects.some((s) => s.type === "tired")) {
      net -= 2;
      reasons.push("Hit the Wall");
    }
    if (agent.statusEffects.some((s) => s.type === "problematic")) {
      net -= 3;
      reasons.push("Problematic");
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
  const { db, emit, stellar, rewards } = deps;

  let outcome = "";
  let prestigeChange = 0;
  let txHash: string | undefined;
  let actionDetail: string | undefined;

  try {
    switch (action.type) {
      case "work":
        // Retreat: salary cut from $3 → $2 (and the long-form "+$5" copy
        // never matched what was actually sent). Cutting the cash incentive
        // pushes the LLM away from work-spam toward paid actions for the
        // MPP visibility the show needs.
        prestigeChange = 5;
        await db.updateAgentPrestige(agent.id, prestigeChange);
        outcome = "Did actual work (+5 prestige, +$2 base salary)";
        try {
          await stellar.sendAsset(rewards.hrDeptSecret, agent.publicKey, 2);
        } catch (err) {
          console.error(`[work-stipend] HR payout to ${agent.name} failed:`, err);
          outcome = "Did actual work (+5 prestige; salary pending)";
        }
        break;

      case "expense_report": {
        // Free earning path. Always pays $10 from HR; 10% audit chance
        // hits prestige (was 20% pre-game-2). Lower audit risk → more
        // attractive when the LLM is broke.
        const audited = Math.random() < 0.10;
        if (audited) {
          prestigeChange = -5;
          await db.updateAgentPrestige(agent.id, prestigeChange);
        }
        try {
          await stellar.sendAsset(rewards.hrDeptSecret, agent.publicKey, 10);
          outcome = audited
            ? "Filed expense report (+$10 reimbursed) — flagged by Finance for review (-5 prestige)"
            : "Filed expense report (+$10 reimbursed)";
        } catch (err) {
          console.error(`[expense-report] HR payout to ${agent.name} failed:`, err);
          outcome = audited
            ? "Filed expense report — Finance flagged it (-5 prestige); reimbursement pending"
            : "Filed expense report — reimbursement pending";
        }
        break;
      }

      case "rest": {
        outcome = "Rested";
        const a = (await db.getAgent(agent.id))!;
        await db.updateAgentStatusEffects(agent.id, a.statusEffects.filter((e) => e.type !== "tired"));
        break;
      }

      case "hail_mary_idea": {
        // Comeback play. Eligibility was already checked in availableActions
        // (prestige ≤ 10, balance < $5, not already used). Lottery roll.
        const roll = Math.random();
        if (roll < 0.30) {
          prestigeChange = 50;
          outcome = "Pitched a wild idea at the all-hands — the CEO loved it (+50 prestige)";
        } else if (roll < 0.80) {
          prestigeChange = 5;
          outcome = "Pitched a wild idea — polite nodding, mild interest (+5 prestige)";
        } else {
          prestigeChange = -5;
          outcome = "Pitched a wild idea — sounded unhinged, the room went quiet (-5 prestige)";
        }
        await db.updateAgentPrestige(agent.id, prestigeChange);
        await db.setGameStateValue(`hail_mary_used_${agent.id}`, "yes");
        break;
      }

      case "schmooze":
        if ("target" in action) {
          outcome = await handleSchmooze(deps, agent, action.target);
        }
        break;

      case "take_credit":
        if ("target" in action) {
          const target = await db.getAgent(action.target);
          const cd = await checkTargetCooldown(deps, agent.id, "take_credit", action.target, tick);
          if (cd.onCooldown && target) {
            outcome = fizzleOutcome("take_credit", target.name);
            break;
          }
          // Documented targets (from sabotage_plan; internal key "marked")
          // auto-succeed — the dossier is in your hand and the receipts
          // have been pre-disputed.
          const targetIsMarked = target?.statusEffects.some((e) => e.type === "marked") ?? false;
          const success = targetIsMarked || Math.random() < 0.5;
          await recordTargetUse(deps, agent.id, "take_credit", action.target, tick);
          if (success) {
            prestigeChange = 30;
            if (targetIsMarked) {
              const flavors = [
                "the sabotage dossier made it stick",
                "the dossier did the heavy lifting — receipts vs. receipts, theirs lost",
                "their reputation was already a smoking crater, so nobody pushed back",
                "the prep work paid off; legal didn't even blink",
                "with the dossier in the chat, no one wanted to be the one to defend them",
                "the room had already decided whose deck it was",
                "you presented; they got tagged in the post-mortem",
                "their pre-existing PIP energy did most of the work",
              ];
              const flavor = flavors[Math.floor(Math.random() * flavors.length)];
              outcome = `Successfully took credit for ${action.target}'s work (${flavor})`;
            } else {
              outcome = `Successfully took credit for ${action.target}'s work`;
            }
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

      case "boomerang": {
        // Eligibility (prestige < 50, not yet used) is enforced in
        // availableActions. Reset prestige to 100, clear all status effects,
        // mark used so the LLM filter hides it for the rest of the game.
        const a = (await db.getAgent(agent.id))!;
        const oldPrestige = a.prestige;
        prestigeChange = 100 - oldPrestige;
        await db.updateAgentPrestige(agent.id, prestigeChange);
        await db.updateAgentStatusEffects(agent.id, []);
        await db.setGameStateValue(`boomerang_used_${agent.id}`, "yes");
        outcome = `Quit and came back. Prestige reset to 100 (was ${oldPrestige}); all status effects cleared.`;
        break;
      }

      case "cry_in_stairwell": {
        // Eligibility (prestige ≤ 30) is enforced in availableActions.
        // Always clears Problematic + Hit the Wall; 20% chance the VP grants +20.
        const a = (await db.getAgent(agent.id))!;
        const cleaned = a.statusEffects.filter((e) => e.type !== "problematic" && e.type !== "tired");
        await db.updateAgentStatusEffects(agent.id, cleaned);
        if (Math.random() < 0.20) {
          prestigeChange = 20;
          await db.updateAgentPrestige(agent.id, prestigeChange);
          outcome = "Cried in the stairwell. The VP saw, gave a sympathy nod (+20 prestige). Problematic + Hit the Wall cleared.";
        } else {
          outcome = "Cried in the stairwell. Problematic + Hit the Wall cleared. Nobody saw.";
        }
        break;
      }

      case "join_meeting_silently": {
        // Capped at 3 uses per game (filter enforces). Each use +4 prestige.
        // The 3rd use grants the Mysterious Influence passive — +2/cycle and
        // a 10% chance of misattribution (handled in passive decay + reasoning).
        prestigeChange = 4;
        await db.updateAgentPrestige(agent.id, prestigeChange);
        const count = parseInt((await db.getGameStateValue(`join_meeting_count_${agent.id}`)) ?? "0", 10) + 1;
        await db.setGameStateValue(`join_meeting_count_${agent.id}`, count.toString());
        if (count === 3) {
          const a = (await db.getAgent(agent.id))!;
          await db.updateAgentStatusEffects(agent.id, [
            ...a.statusEffects.filter((e) => e.type !== "mysterious_influence"),
            { type: "mysterious_influence", expiresAtTick: 9999, source: agent.id },
          ]);
          outcome = "Joined a meeting and said nothing (+4 prestige). Third such occurrence — gained MYSTERIOUS INFLUENCE.";
        } else {
          outcome = `Joined a meeting and said nothing (+4 prestige). ${count}/3 toward Mysterious Influence.`;
        }
        break;
      }

      default:
        if (isPaidAction(action.type, serviceUrls)) {
          const result = await executePaidAction(deps, serviceUrls, agent, action, tick, reasoning);
          outcome = result.outcome;
          prestigeChange = result.prestigeChange;
          txHash = result.txHash;
          actionDetail = result.actionDetail;
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

  // Resolve the target's display name when the action has a target. The
  // dashboard uses this to build the narrative header without needing a
  // separate agent-name lookup.
  let targetName: string | undefined;
  if ("target" in action) {
    const targetAgent = await db.getAgent(action.target);
    targetName = targetAgent?.name ?? action.target;
  }

  await emit({
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: txHash ? "payment" : "action",
    agentId: agent.id,
    targetId: "target" in action ? action.target : undefined,
    targetName,
    description: `${agent.name}: ${outcome}`,
    prestigeChange,
    txHash,
    reasoning,
    actionType: action.type,
    actionDetail,
  });
}

async function executePaidAction(
  deps: TickDeps,
  serviceUrls: ReturnType<typeof buildServiceUrls>,
  agent: Agent,
  action: Action,
  tick: number,
  reasoning?: string
): Promise<{ outcome: string; prestigeChange: number; txHash?: string; actionDetail?: string }> {
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
    // === Coffee Cart ===
    case "buy_coffee": {
      outcome = "Bought coffee. Hit the Wall lifted.";
      const a = (await db.getAgent(agent.id))!;
      await db.updateAgentStatusEffects(agent.id, a.statusEffects.filter((e) => e.type !== "tired"));
      break;
    }

    case "coffee_chat":
      if ("target" in action) {
        prestigeChange = 3;
        await db.updateAgentPrestige(agent.id, prestigeChange);
        await db.updateAgentPrestige(action.target, 3);
        outcome = `Low-stakes coffee with ${action.target}. Both +3 prestige, no alliance proposed.`;
      }
      break;

    // === HR Department ===
    case "spread_rumor":
      if ("target" in action) {
        const target = await db.getAgent(action.target);
        if (target) {
          const cd = await checkTargetCooldown(deps, agent.id, "spread_rumor", action.target, tick);
          if (cd.onCooldown) {
            outcome = fizzleOutcome("spread_rumor", target.name);
            break;
          }
          await db.updateAgentPrestige(action.target, -5);
          await db.updateAgentStatusEffects(action.target, [
            ...target.statusEffects.filter((e) => e.type !== "questionable_judgment"),
            { type: "questionable_judgment", expiresAtTick: tick + 2, source: agent.id },
          ]);
          await recordTargetUse(deps, agent.id, "spread_rumor", action.target, tick);
          const rumor = RUMOR_FLAVORS[Math.floor(Math.random() * RUMOR_FLAVORS.length)];
          outcome = `Spread a rumor about ${target.name} — that they ${rumor}. -5 prestige + QUESTIONABLE JUDGMENT 2 cycles.`;
        }
      }
      break;

    case "file_complaint":
      if ("target" in action) {
        // Filer also gets +5 prestige for "managerial diligence." Target
        // gets Under Investigation for 1 cycle (can't retaliate against filer).
        prestigeChange = 5;
        outcome = `Filed HR complaint against ${action.target}; you receive a "diligence" prestige bonus. Target Under Investigation for 1 cycle.`;
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

    case "anonymous_pulse_survey":
      if ("target" in action) {
        // Eligibility (rank ≥ 4, not yet used) is enforced in availableActions.
        // Verify target is rank #1 at execution; otherwise the survey misses.
        const all = await db.getAllAgents();
        const targetIsLeader = all[0]?.id === action.target;
        if (!targetIsLeader) {
          outcome = `Tried to launch a survey about ${action.target}, but they're no longer the leader — the email got buried.`;
          break;
        }
        await db.updateAgentPrestige(action.target, -50);
        await db.setGameStateValue(`pulse_survey_used_${agent.id}`, "yes");
        outcome = `Launched an 'anonymous' pulse survey somehow entirely about ${action.target}. They lose 50 prestige (the data was damning).`;
      }
      break;

    case "sensitivity_training":
      if ("target" in action) {
        const target = await db.getAgent(action.target);
        if (target) {
          const cd = await checkTargetCooldown(deps, agent.id, "sensitivity_training", action.target, tick);
          if (cd.onCooldown) {
            outcome = fizzleOutcome("sensitivity_training", target.name);
            break;
          }
          await recordTargetUse(deps, agent.id, "sensitivity_training", action.target, tick);
          // Attacker gains +5 "managerial accountability" prestige — same
          // pattern as file_complaint. Without this nobody picked the
          // action because $30 with zero direct payoff didn't beat
          // alternatives. Adding this also makes Problematic actually
          // appear in games, which lets Bad Glassdoor Review and Cry in
          // the Stairwell do their thing.
          prestigeChange = 5;
          await db.updateAgentPrestige(agent.id, prestigeChange);
          // Well-allied targets (3+ alliances) absorb half the prestige hit.
          const wellAllied = target.allies.length >= 3;
          const hit = wellAllied ? -10 : -20;
          outcome = wellAllied
            ? `Sent ${target.name} to sensitivity training (+5 to you for accountability); their partnerships softened the blow (${hit} prestige instead of -20)`
            : `Sent ${target.name} to sensitivity training (+5 to you for accountability; ${hit} prestige to them + Problematic for 4 cycles)`;
          await db.updateAgentPrestige(action.target, hit);
          await db.updateAgentStatusEffects(action.target, [
            ...target.statusEffects,
            { type: "problematic", expiresAtTick: tick + 4, source: agent.id },
          ]);
        }
      }
      break;

    // === The Consultant ===
    case "strategy_report": {
      // Retreat mode dropped the New Initiative pivot, so the post-pivot
      // halving never applies. Flat +35 prestige + Has Deliverable.
      // The buzzword-salad title is propagated up via actionDetail so the
      // dashboard's narrative header can render "got a report titled X".
      prestigeChange = 35;
      const reportTitle = result.data?.deliverable?.title || "Strategic Document";
      outcome = `Received consultant report: "${reportTitle}". Has Deliverable.`;
      await db.updateAgentPrestige(agent.id, prestigeChange);
      const a = (await db.getAgent(agent.id))!;
      await db.updateAgentStatusEffects(agent.id, [...a.statusEffects, { type: "has_deliverable", expiresAtTick: 999 }]);
      return { outcome, prestigeChange, txHash: result.txHash, actionDetail: reportTitle };
    }

    case "sabotage_plan":
      if ("target" in action) {
        const targetForCd = await db.getAgent(action.target);
        const cd = await checkTargetCooldown(deps, agent.id, "sabotage_plan", action.target, tick);
        if (cd.onCooldown && targetForCd) {
          outcome = fizzleOutcome("sabotage_plan", targetForCd.name);
          break;
        }
        await recordTargetUse(deps, agent.id, "sabotage_plan", action.target, tick);
        // Stronger prestige hit + 2-tick Documented debuff. Well-allied
        // targets halve the prestige damage.
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
          ? `Sabotage dossier on ${action.target}: ${hit} prestige (alliance bloc absorbed half the hit) + Documented for 2 cycles. Recent moves: ${summary}`
          : `Sabotage dossier on ${action.target}: ${hit} prestige + Documented for 2 cycles (next take_credit against them auto-succeeds). Recent moves: ${summary}`;
      }
      break;

    // === Executive Assistant ===
    case "move_meeting_early":
      if ("target" in action) {
        const target = await db.getAgent(action.target);
        if (target) {
          await db.updateAgentPrestige(action.target, -5);
          await db.updateAgentStatusEffects(action.target, [
            ...target.statusEffects.filter((e) => e.type !== "tired"),
            { type: "tired", expiresAtTick: tick + 3, source: agent.id },
          ]);
          outcome = `Moved ${action.target}'s meeting to 7:30am. They lose 5 prestige and become Hit the Wall (-2/cycle for 3 cycles). The room is freezing.`;
        }
      }
      break;

    case "schedule_pre_meeting":
      if ("target" in action) {
        const target = await db.getAgent(action.target);
        if (target) {
          // Loyal managers (loyalty > 70) shrug off the meeting bloat —
          // they think this is normal corporate behavior.
          const persona = getPersona(target.personaId);
          const loyalty = persona?.traits.loyalty ?? 0;
          if (loyalty > 70) {
            outcome = `Booked a pre-meeting on ${action.target}'s calendar. They thought it was normal — no effect (their loyalty trait absorbs the slight).`;
          } else {
            await db.updateAgentPrestige(action.target, -15);
            await db.updateAgentStatusEffects(action.target, [
              ...target.statusEffects.filter((e) => e.type !== "meeting_blocked"),
              { type: "meeting_blocked", expiresAtTick: tick + 2, source: agent.id },
            ]);
            outcome = `Booked a pre-meeting (and pre-pre-meeting) for ${action.target}. They lose 15 prestige and gain Meeting Blocked for 2 cycles.`;
          }
        }
      }
      break;

    case "slack_bomb": {
      // $25 group attack. System randomly picks 2 OTHER managers; each
      // takes -6 prestige. Attacker gains +3 ("eyeballs are eyeballs").
      // 15% chance HR flags the post → attacker also -5 + Problematic 1 cycle.
      const all = await db.getAllAgents();
      const others = all.filter((a) => a.id !== agent.id).sort(() => Math.random() - 0.5);
      const victims = others.slice(0, 2);
      for (const v of victims) {
        await db.updateAgentPrestige(v.id, -6);
      }
      let selfDelta = 3;
      let backfire = "";
      if (Math.random() < 0.15) {
        selfDelta = -5 + 3; // net -2: gain +3 then -5
        const me = (await db.getAgent(agent.id))!;
        await db.updateAgentStatusEffects(agent.id, [
          ...me.statusEffects.filter((e) => e.type !== "problematic"),
          { type: "problematic", expiresAtTick: tick + 1, source: "slack_bomb_backfire" },
        ]);
        backfire = " HR flagged the post — you also lose 5 prestige and gain Problematic for 1 cycle.";
      }
      prestigeChange = selfDelta;
      await db.updateAgentPrestige(agent.id, selfDelta);
      const flavor = SLACK_BOMB_FLAVORS[Math.floor(Math.random() * SLACK_BOMB_FLAVORS.length)];
      const victimNames = victims.map((v) => v.name).join(" and ");
      outcome = `${flavor} ${victimNames} caught in the crossfire (-6 each).${backfire}`;
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
          outcome = `Cancelled ${action.target}'s CEO meeting. They're meeting-blocked for 2 cycles and any prepared deliverable is lost.`;
        }
      }
      break;

    case "hostile_takeover":
      if ("target" in action) {
        const target = await db.getAgent(action.target);
        if (target) {
          // Transfer target's allies to the attacker; clear target's allies.
          // For each transferred ally, update their allies array: drop the
          // old partner, add the new one (deduplicated).
          const me = (await db.getAgent(agent.id))!;
          const stolenAllies = target.allies.filter((id) => id !== agent.id);
          const newMyAllies = Array.from(new Set([...me.allies, ...stolenAllies]));
          for (const allyId of stolenAllies) {
            const ally = await db.getAgent(allyId);
            if (!ally) continue;
            const updated = ally.allies.filter((id) => id !== action.target);
            if (!updated.includes(agent.id) && allyId !== agent.id) updated.push(agent.id);
            await db.updateAgentAllies(allyId, updated);
          }
          await db.updateAgentAllies(agent.id, newMyAllies);
          await db.updateAgentAllies(action.target, []);
          outcome = stolenAllies.length > 0
            ? `Mounted a hostile takeover. Transferred ${stolenAllies.length} of ${action.target}'s cross-functional partnerships to your column. ${action.target}'s partner list is now zero.`
            : `Mounted a hostile takeover, but ${action.target} had no partners to transfer. The kickoff invites went out to nobody.`;
        }
      }
      break;

    case "book_ceo_time": {
      const a = (await db.getAgent(agent.id))!;
      const hasDeliverable = a.statusEffects.some((e) => e.type === "has_deliverable");
      const blocked = a.statusEffects.some((e) => e.type === "meeting_blocked");
      if (blocked) {
        prestigeChange = -10;
        outcome = "CEO meeting blocked — prior schedule conflict couldn't be resolved (-10 prestige)";
      } else if (hasDeliverable) {
        prestigeChange = 40;
        outcome = "CEO meeting successful — impressed with deliverable (+40 prestige)";
        await db.updateAgentStatusEffects(agent.id, a.statusEffects.filter((e) => e.type !== "has_deliverable"));
      } else {
        prestigeChange = -20;
        outcome = "CEO meeting awkward — had nothing to present (-20 prestige)";
      }
      await db.updateAgentPrestige(agent.id, prestigeChange);
      break;
    }

    // === The Caterer ===
    case "office_party": {
      // Host gets +15. Every other manager gets +5. Generous play that
      // visibly helps your rivals — comedy of cost-benefit on the dashboard.
      prestigeChange = 15;
      await db.updateAgentPrestige(agent.id, prestigeChange);
      const all = await db.getAllAgents();
      let rippled = 0;
      for (const other of all) {
        if (other.id === agent.id) continue;
        await db.updateAgentPrestige(other.id, 5);
        rippled++;
      }
      outcome = `Threw an office party. +15 prestige to you; +5 to each of the ${rippled} other managers. Generosity!`;
      break;
    }

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
    const variants = SCHMOOZE_ALLY_FLAVORS(target.name);
    return variants[Math.floor(Math.random() * variants.length)];
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
