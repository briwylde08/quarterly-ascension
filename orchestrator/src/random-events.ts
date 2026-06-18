// Retreat-mode random events. 9-event set, scheduled on cycle boundaries
// (every 10th tick under the round-robin layout — see processTick in tick.ts).
//
// Always-on:
//   - Glass Cliff Promotion (auto-fires when leader is 50+ ahead of #2;
//     once per victim per game)
// Fixed-cycle:
//   - Quarterly Bonus (cycle 4 = tick 40: $50/$30/$20 to top 3;
//                     cycle 8 = tick 80: $100/$60/$40 to top 3)
// Per-cycle probabilistic (skipped if same event fired last cycle):
//   - Surprise Board Visit (10%)        — top 3 reshuffle, 3 nested children
//   - Bad Glassdoor Review (12%)        — every Problematic agent takes -10
//   - Surprise Promotion (10%)          — random underdog gets +30
//   - Surprise Demo Day (10%)           — every agent reacts per personality
//   - Budget Cuts (12%)                  — on-chain USDC burn from 5 random agents
//   - Viral LinkedIn Post (10%)          — single agent +15 / -5 lottery + cringe quote
//   - Printer Achieves Sentience (6%)    — flavor with per-agent micro-effect

import { v4 as uuid } from "uuid";
import type { GameEvent } from "./types.js";
import type { Db } from "./db.js";
import type { Stellar } from "./stellar.js";
import type { RewardSources } from "./tick.js";
import { getPersona } from "./personas.js";

export interface RandomEventsState {
  /** Once-per-game tracking for Glass Cliff Promotion: each victim can be
   *  cliffed at most once. Empty at game start; cleared by the orchestrator
   *  via the per-game-state cleanup at game end. */
  glassCliffVictims: Set<string>;
  /** Set of random-event ids that fired in the previous cycle boundary.
   *  Skipped this cycle to prevent the same event back-to-back. */
  lastFiredEvents: Set<string>;
  /** Once-per-game cap for the probabilistic event pool. Pre-flight #2
   *  saw Surprise Demo Day fire 3× in one game; cool the first two
   *  times, redundant the third. Each event id added here when it fires
   *  the first time; subsequent rolls for that id are skipped. */
  firedEventTypes: Set<string>;
}

export function createRandomEventsState(): RandomEventsState {
  return {
    glassCliffVictims: new Set(),
    lastFiredEvents: new Set(),
    firedEventTypes: new Set(),
  };
}

interface EventDeps {
  db: Db;
  stellar: Stellar;
  rewards: RewardSources;
  /** Pre-fetched balance map (agentId → DLBR), supplied by processTick. */
  balances?: Map<string, number>;
}

export interface RandomEventsResult {
  events: GameEvent[];
  /** Legacy field — never set in retreat mode (All-Hands cut). Retained
   *  in the shape so tick.ts can keep its existing destructure. */
  skipDecisions: boolean;
}

export async function processRandomEvents(
  deps: EventDeps,
  state: RandomEventsState,
  tick: number
): Promise<RandomEventsResult> {
  const events: GameEvent[] = [];

  // Hydrate firedEventTypes + glassCliffVictims from game_state so the
  // one-per-game caps survive DO eviction. The class-level in-memory Set
  // wasn't enough — game 7 had Viral LinkedIn fire twice because the DO
  // restarted mid-game and the Set re-initialized empty.
  try {
    const persistedFired = await deps.db.getGameStateValue("fired_random_events");
    if (persistedFired) {
      const ids: string[] = JSON.parse(persistedFired);
      for (const id of ids) state.firedEventTypes.add(id);
    }
    const persistedGlassCliff = await deps.db.getGameStateValue("glass_cliff_victims");
    if (persistedGlassCliff) {
      const victims: string[] = JSON.parse(persistedGlassCliff);
      for (const v of victims) state.glassCliffVictims.add(v);
    }
  } catch (err) {
    console.error("[random-events] hydrate state failed:", err);
  }
  const initialFiredSize = state.firedEventTypes.size;
  const initialGlassCliffSize = state.glassCliffVictims.size;

  // Persist state to D1 if anything new fired this tick. Called before each
  // return so the one-per-game cap survives DO eviction.
  const persist = async () => {
    if (state.firedEventTypes.size !== initialFiredSize) {
      try {
        await deps.db.setGameStateValue(
          "fired_random_events",
          JSON.stringify([...state.firedEventTypes])
        );
      } catch (err) { console.error("[random-events] persist fired failed:", err); }
    }
    if (state.glassCliffVictims.size !== initialGlassCliffSize) {
      try {
        await deps.db.setGameStateValue(
          "glass_cliff_victims",
          JSON.stringify([...state.glassCliffVictims])
        );
      } catch (err) { console.error("[random-events] persist glass-cliff failed:", err); }
    }
  };

  // Tick 1: Q1 KICKOFF — a per-agent reaction event the moment the game
  // starts. Pure flavor + tiny prestige movements, but it gives the host
  // 10 names to call out before any action has even fired.
  if (tick === 1) {
    events.push(...(await q1Kickoff(deps, tick)));
    await persist();
    return { events, skipDecisions: false };
  }

  // Tick 5: GUARANTEED first-cycle closer. With 2-agents-per-tick mode,
  // cycle 1 ends at tick 5 (5 ticks × 2 agents = 10 agent-actions). The
  // probabilistic pool can produce a "nothing happened in cycle 1"
  // silence by chance; force one high-energy event here so the host
  // always has narration material in the first ~2 minutes. Skips the
  // regular probabilistic rolls for this cycle boundary, AND marks the
  // chosen event as fired so it doesn't roll again later (one-per-game).
  // Tick 35: GUARANTEED mid-game pivot (post-game-8). Same opener pool,
  // pulls only events that haven't already fired so the audience reliably
  // gets a second high-energy beat — placed JUST AFTER Halftime (tick 30)
  // when audience attention historically dips. (Was tick 45 in 80-tick;
  // first scaled to tick 25 then moved to 35 to space out the bonus cluster
  // around Halftime instead of front-loading drama before it.)
  if (tick === 5 || tick === 35) {
    const allOpeners = [
      { id: "surprise_demo_day", fn: surpriseDemoDay },
      { id: "surprise_board_visit", fn: surpriseBoardVisit },
      { id: "viral_linkedin", fn: viralLinkedIn },
      { id: "bad_glassdoor_review", fn: badGlassdoorReview },
    ];
    // For tick 35, only pick from openers that haven't fired yet so the
    // mid-game beat is fresh. If somehow all four already fired (rare),
    // fall through with no event rather than repeating one.
    const openers = tick === 5
      ? allOpeners
      : allOpeners.filter((o) => !state.firedEventTypes.has(o.id));
    if (openers.length > 0) {
      const opener = openers[Math.floor(Math.random() * openers.length)];
      events.push(...(await opener.fn(deps, tick)));
      state.lastFiredEvents = new Set([tick === 5 ? "cycle1_opener" : "midgame_pivot"]);
      state.firedEventTypes.add(opener.id);
      await persist();
      return { events, skipDecisions: false };
    }
  }

  // Quarterly Bonus split into THREE smaller checkpoints, evenly spaced
  // across the 60-tick game (was 25/50/75 for the 80-tick version):
  //   Q1 wrap   (tick 15, ~5 min in)
  //   Halftime  (tick 30, ~12 min in — peak audience attention)
  //   Q3 wrap   (tick 45, late game; winners can still flex it)
  // Smaller per-bonus amounts ($40/$25/$15 vs the old $100/$60/$40 finale)
  // so the cumulative payout stays comparable but the cadence gives the
  // audience three "winners are paid" beats instead of one ceremonial close.
  if (tick === 15) {
    events.push(...(await quarterlyBonus(deps, tick, [40, 25, 15], "Q1 Wrap")));
  } else if (tick === 30) {
    events.push(...(await quarterlyBonus(deps, tick, [40, 25, 15], "Halftime")));
  } else if (tick === 45) {
    events.push(...(await quarterlyBonus(deps, tick, [40, 25, 15], "Q3 Wrap")));
  }

  // Board Strategy Review: deterministic mid-game pivot. Opens at tick 30,
  // closes at tick 35. While the review window is active, every prestige
  // change is doubled in post-tick batch (see tick.ts board_review handler)
  // and the LLM prompt surfaces the heightened stakes. Goal: break any
  // pattern that's calcified in the first half of the game.
  if (tick === 30) {
    events.push(...(await boardStrategyReviewOpen(deps, tick)));
  } else if (tick === 35) {
    events.push(...(await boardStrategyReviewClose(deps, tick)));
  }

  // Glass Cliff Promotion: auto-fires whenever the leader pulls 50+ prestige
  // ahead of rank-2, *and* hasn't already been cliffed this game.
  events.push(...(await glassCliffPromotion(deps, state, tick)));

  // Per-cycle probabilistic rolls. Skip any event that fired at the
  // previous cycle boundary (no back-to-back) AND any event already
  // fired once this game (post-game-2 cap — variety beats repeats).
  const fired = new Set<string>();
  const skipped = state.lastFiredEvents;
  const alreadyFired = state.firedEventTypes;
  const roll = (id: string, prob: number): boolean => {
    if (skipped.has(id)) return false;
    if (alreadyFired.has(id)) return false;
    if (Math.random() >= prob) return false;
    fired.add(id);
    alreadyFired.add(id);
    return true;
  };

  // Probabilities bumped slightly post-game-2 since each event can now
  // fire only once per game and we want ~10 random events spread across
  // 12 cycles. Sum ≈ 0.85/cycle. Plus 3 fixed Quarterly Bonuses + 0-2
  // Glass Cliffs ≈ 10/game expected.
  if (roll("surprise_board_visit", 0.10))   events.push(...(await surpriseBoardVisit(deps, tick)));
  if (roll("bad_glassdoor_review", 0.10))   events.push(...(await badGlassdoorReview(deps, tick)));
  if (roll("surprise_promotion", 0.10))     events.push(...(await surprisePromotion(deps, tick)));
  if (roll("surprise_demo_day", 0.10))      events.push(...(await surpriseDemoDay(deps, tick)));
  if (roll("budget_cuts", 0.10))            events.push(...(await budgetCuts(deps, tick)));
  if (roll("viral_linkedin", 0.10))         events.push(...(await viralLinkedIn(deps, tick)));
  if (roll("printer_sentience", 0.08))      events.push(...(await printerAchievesSentience(deps, tick)));
  if (roll("quiet_quitting_memo", 0.10))    events.push(...(await quietQuittingMemo(deps, tick)));
  if (roll("vending_machine", 0.07))        events.push(...(await vendingMachineShowdown(deps, tick)));

  state.lastFiredEvents = fired;

  await persist();
  return { events, skipDecisions: false };
}

// === Q1 Kickoff (opening event, fires once at tick 1) ====================

async function q1Kickoff(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  // Per-agent reactions to the CEO's morning all-hands. Tiny prestige moves
  // (-2 to +2) flavored by personality. The point isn't the stakes — it's
  // 10 nested children rendering instantly so the host has names to talk
  // about from minute zero of the show.
  const agents = await deps.db.getAllAgents();
  const parentId = uuid();
  const events: GameEvent[] = [{
    id: parentId,
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: "Q1 KICKOFF: The CEO stood up at the morning all-hands and announced 'this is going to be our quarter.' The room reacted differently.",
  }];

  for (const a of agents) {
    const persona = getPersona(a.personaId);
    const aggression = persona?.traits.aggression ?? 50;
    const greed = persona?.traits.greed ?? 50;
    const caution = persona?.traits.caution ?? 50;
    const loyalty = persona?.traits.loyalty ?? 50;

    let flavor = "";
    let prestigeDelta = 0;

    if (loyalty > 75) {
      flavor = "led the applause when the CEO finished. Maybe a beat too long. CEO seemed pleased.";
      prestigeDelta = 2;
    } else if (aggression > 75) {
      flavor = "is already plotting their first attack of the day. Visibly noted who came in late.";
      prestigeDelta = 1;
    } else if (caution > 75) {
      flavor = "took meticulous notes. Took photos of every slide. Will summarize for the team later.";
      prestigeDelta = 1;
    } else if (greed > 75) {
      flavor = "asked about Q1 bonus structure before the CEO finished speaking. Read the room poorly.";
      prestigeDelta = -2;
    } else if (loyalty < 25) {
      flavor = "checked LinkedIn during the speech. Was visibly browsing a recruiter DM.";
      prestigeDelta = -1;
    } else {
      flavor = "nodded thoughtfully and said 'great speech, John.' (CEO's name is Jim.)";
      prestigeDelta = 0;
    }

    if (prestigeDelta !== 0) {
      await deps.db.updateAgentPrestige(a.id, prestigeDelta);
    }
    const sign = prestigeDelta > 0 ? `(+${prestigeDelta})` : prestigeDelta < 0 ? `(${prestigeDelta})` : "";
    events.push({
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: "random_event",
      agentId: a.id,
      prestigeChange: prestigeDelta,
      description: `${a.name} ${flavor} ${sign}`.trim(),
      parentEventId: parentId,
    });
  }
  return events;
}

// === Quarterly Bonus =======================================================

// Bonuses go to 3 random agents (not top-3) with HR-flavored justifications.
// Top-3 already-winning amplification cemented the leader; randomizing keeps
// the leaderboard moving and the comedy fresher. Each line is a (reason)
// where HR rationalizes the payout. Amount placeholder is filled at runtime.
const BONUS_FLAVORS = [
  "submitted timesheet on time three weeks running (HR was running out of categories)",
  "best Out-of-Office message — it had a callback",
  "attended one (1) all-hands meeting (the bar is on the floor)",
  "hit reply-all the fewest times this quarter",
  "named in zero PIPs this period (technically a win)",
  "perfect attendance at meetings they organized themselves",
  "highest 'works well with others' score (n=1, self-evaluated)",
  "longest unbroken streak of '👀' Slack reactions",
  "completed all required compliance trainings (twice — system glitch)",
  "fewest typos in the all-hands chat",
  "introduced themselves with title in 100% of new meetings",
  "sent the most calendar invites with no agenda — 'leadership presence'",
  "voted 'most likely to schedule a pre-meeting' by anonymous peers",
  "still has not used their standing desk",
  "expense-reported a $4 coffee as 'team-building research'",
  "longest LinkedIn 'About' section in the org",
  "highest rate of follow-up-to-the-follow-up emails",
  "achieved zero deliverables but maximum visibility",
];

async function quarterlyBonus(
  deps: EventDeps,
  tick: number,
  payouts: [number, number, number],
  label: string
): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  const shuffled = [...agents].sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, 3);
  if (winners.length === 0) return [];

  const flavorPool = [...BONUS_FLAVORS].sort(() => Math.random() - 0.5);

  const parentId = uuid();
  const events: GameEvent[] = [{
    id: parentId,
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: `QUARTERLY BONUS — ${label}: HR is releasing performance bonuses. The criteria are mysterious.`,
  }];

  for (let i = 0; i < winners.length; i++) {
    const a = winners[i];
    const amount = payouts[i];
    const flavor = flavorPool[i] ?? BONUS_FLAVORS[Math.floor(Math.random() * BONUS_FLAVORS.length)];
    try {
      const txHash = await deps.stellar.sendAsset(deps.rewards.hrDeptSecret, a.publicKey, amount);
      events.push({
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "payment",
        agentId: a.id,
        description: `${a.name} received $${amount} ${label.toLowerCase()} bonus — for "${flavor}"`,
        txHash,
        parentEventId: parentId,
      });
    } catch (err) {
      console.error(`[quarterly-bonus] HR payout to ${a.name} failed:`, err);
      events.push({
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        agentId: a.id,
        description: `${a.name}: $${amount} bonus pending — HR is "processing" (failed payout)`,
        parentEventId: parentId,
      });
    }
  }
  return events;
}

// === Glass Cliff Promotion (auto, once per victim) =========================

const GLASS_CLIFF_FLAVORS = [
  "the CEO 'has full confidence' in them taking on a stretch role",
  "they were tapped to lead the Q3 'transformation initiative' with no resources",
  "they were promoted to a new VP-of-Cross-Org-Synergy role nobody asked for",
  "they were handed a P&L for a department that no longer exists",
  "the board 'reorganized them upward' into a strategic-advisory function",
];

async function glassCliffPromotion(
  deps: EventDeps,
  state: RandomEventsState,
  tick: number
): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents(); // sorted prestige DESC
  if (agents.length < 2) return [];
  const leader = agents[0];
  const second = agents[1];
  const gap = leader.prestige - second.prestige;
  if (gap <= 50) return [];
  if (state.glassCliffVictims.has(leader.id)) return [];

  // Drag the leader down to rank-2's prestige (no longer ahead).
  const delta = -gap;
  await deps.db.updateAgentPrestige(leader.id, delta);
  state.glassCliffVictims.add(leader.id);

  const flavor = GLASS_CLIFF_FLAVORS[Math.floor(Math.random() * GLASS_CLIFF_FLAVORS.length)];
  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: `GLASS CLIFF PROMOTION: ${leader.name} got too far ahead — ${flavor}. They lose ${gap} prestige (back to the pack at ${second.prestige}).`,
    agentId: leader.id,
    prestigeChange: delta,
  }];
}

// === Board Strategy Review (mid-game pivot, deterministic) =================

async function boardStrategyReviewOpen(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  // Stamp every agent with the board_review status until tick 35 (5-tick
  // window). tick.ts checks for this status post-tick to double prestige
  // changes; llm.ts surfaces it in the prompt so agents factor amplified
  // stakes into their decisions.
  const agents = await deps.db.getAllAgents();
  for (const a of agents) {
    await deps.db.updateAgentStatusEffects(a.id, [
      ...a.statusEffects.filter((e) => e.type !== "board_review"),
      { type: "board_review", expiresAtTick: 35, source: "board" },
    ]);
  }
  return [
    {
      id: uuid(), tick, timestamp: new Date(), type: "random_event",
      description: `📋 BOARD STRATEGY REVIEW (Q2 mid-quarter): The full board is in the building for the next 5 ticks. Every prestige change is doubled while they're watching. Quiet plays go unnoticed; bold plays land at amplified impact. Make this count.`,
    },
  ];
}

async function boardStrategyReviewClose(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  // Status effects with expiresAtTick=35 will auto-clear in tick.ts's
  // Phase-1 status-decay loop at tick 35. This event just announces the
  // close for narrative continuity.
  return [
    {
      id: uuid(), tick, timestamp: new Date(), type: "random_event",
      description: `📋 The board left the building. Strategy Review window closed. Prestige changes back to normal — until they show up again.`,
    },
  ];
}

// === Surprise Board Visit ==================================================

async function surpriseBoardVisit(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  // Top 3 prestige managers reshuffle: one +25, one -25, one Under Investigation.
  const agents = await deps.db.getAllAgents();
  const top3 = agents.slice(0, 3);
  if (top3.length < 3) return [];
  const shuffled = [...top3].sort(() => Math.random() - 0.5);
  const [winner, loser, scrutinized] = shuffled;
  await deps.db.updateAgentPrestige(winner.id, 25);
  await deps.db.updateAgentPrestige(loser.id, -25);
  await deps.db.updateAgentStatusEffects(scrutinized.id, [
    ...scrutinized.statusEffects.filter((e) => e.type !== "under_investigation"),
    { type: "under_investigation", expiresAtTick: tick + 2, source: "board" },
  ]);
  const parentId = uuid();
  return [
    { id: parentId, tick, timestamp: new Date(), type: "random_event",
      description: `SURPRISE BOARD VISIT: The board flew in unannounced. They had... opinions.` },
    { id: uuid(), tick, timestamp: new Date(), type: "random_event", agentId: winner.id, prestigeChange: 25,
      description: `${winner.name} caught the board's eye (+25 prestige).`, parentEventId: parentId },
    { id: uuid(), tick, timestamp: new Date(), type: "random_event", agentId: loser.id, prestigeChange: -25,
      description: `${loser.name} stumbled in front of the board (-25 prestige).`, parentEventId: parentId },
    { id: uuid(), tick, timestamp: new Date(), type: "random_event", agentId: scrutinized.id,
      description: `${scrutinized.name} is now Under Investigation — the board "wants to dig in" on their numbers.`, parentEventId: parentId },
  ];
}

// === Bad Glassdoor Review ==================================================

const GLASSDOOR_HEADLINES = [
  "BAD GLASSDOOR REVIEW: Anonymous post titled 'Where ambition goes to die' is making the rounds.",
  "BAD GLASSDOOR REVIEW: New 1-star review: 'They have a foosball table. That is the only positive.'",
  "BAD GLASSDOOR REVIEW: Anonymous review calls leadership 'a masterclass in conflict avoidance.'",
  "BAD GLASSDOOR REVIEW: 'Pros: free coffee. Cons: everything else.' Two stars.",
  "BAD GLASSDOOR REVIEW: A reviewer specifically named the management team's vibe as 'casually hostile.'",
  "BAD GLASSDOOR REVIEW: Sentence-long takedown: 'I learned more in three weeks of unemployment.'",
  "BAD GLASSDOOR REVIEW: 'They use the word synergy unironically. Six times. In one all-hands.'",
  "BAD GLASSDOOR REVIEW: Trending review: 'Saw a manager cry. Was a Tuesday. Mid-quarter.'",
  "BAD GLASSDOOR REVIEW: A flood of three-star reviews suspiciously dropped overnight.",
];

async function badGlassdoorReview(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  // Hits every Problematic manager for -10. If nobody's Problematic, fizzles.
  const agents = await deps.db.getAllAgents();
  const problematic = agents.filter((a) => a.statusEffects.some((e) => e.type === "problematic"));
  for (const a of problematic) {
    await deps.db.updateAgentPrestige(a.id, -10);
  }
  const headline = GLASSDOOR_HEADLINES[Math.floor(Math.random() * GLASSDOOR_HEADLINES.length)];
  const parentId = uuid();
  const events: GameEvent[] = [{
    id: parentId, tick, timestamp: new Date(), type: "random_event",
    description: problematic.length > 0
      ? `${headline} Everyone Problematic takes -10.`
      : `${headline} Nobody on the Problematic list — review fizzles.`,
  }];
  for (const a of problematic) {
    events.push({
      id: uuid(), tick, timestamp: new Date(), type: "random_event", agentId: a.id, prestigeChange: -10,
      description: `${a.name} mentioned by name in the review (-10 prestige).`,
      parentEventId: parentId,
    });
  }
  return events;
}

// === Surprise Promotion (underdog booster) ================================

async function surprisePromotion(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  // Picks a random agent from the bottom half of the leaderboard, +30 prestige.
  const agents = await deps.db.getAllAgents(); // sorted prestige DESC
  if (agents.length === 0) return [];
  const bottomHalf = agents.slice(Math.floor(agents.length / 2));
  if (bottomHalf.length === 0) return [];
  const lucky = bottomHalf[Math.floor(Math.random() * bottomHalf.length)];
  await deps.db.updateAgentPrestige(lucky.id, 30);

  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    agentId: lucky.id,
    prestigeChange: 30,
    description: `SURPRISE PROMOTION: ${lucky.name} got pulled into a leadership-development cohort. Comes with a small title bump and a +30 prestige boost.`,
  }];
}

// === Surprise Demo Day (personality-flavored per agent) ====================

async function surpriseDemoDay(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  const parentId = uuid();
  const events: GameEvent[] = [{
    id: parentId, tick, timestamp: new Date(), type: "random_event",
    description: "SURPRISE DEMO DAY: The CEO wants to see what everyone's been working on. Right now.",
  }];
  for (const a of agents) {
    const persona = getPersona(a.personaId);
    const aggression = persona?.traits.aggression ?? 50;
    const greed = persona?.traits.greed ?? 50;
    const caution = persona?.traits.caution ?? 50;
    const loyalty = persona?.traits.loyalty ?? 50;
    const hasDeliverable = a.statusEffects.some((e) => e.type === "has_deliverable");

    let prestigeDelta = hasDeliverable ? 25 : -5;
    let flavor = "";

    if (hasDeliverable) {
      if (aggression > 70) {
        prestigeDelta = 30;
        flavor = "crushed Q&A by interrupting every clarifying question";
      } else if (greed > 70) {
        prestigeDelta = 8;
        flavor = "tried to claim credit for two other teams' work mid-presentation; got side-eye but somehow scraped a small win";
      } else if (caution > 70) {
        prestigeDelta = 25;
        flavor = "presented like a defense lawyer — every slide footnoted, every claim hedged";
      } else if (loyalty > 70) {
        prestigeDelta = 27;
        flavor = "credited the whole team; the CEO loved the humility";
      } else {
        flavor = "delivered the deck cleanly";
      }
      await deps.db.updateAgentStatusEffects(a.id, a.statusEffects.filter((e) => e.type !== "has_deliverable"));
    } else {
      if (aggression > 70) {
        prestigeDelta = -2;
        flavor = "deflected by attacking the brief; CEO smirked";
      } else if (caution > 70) {
        prestigeDelta = -3;
        flavor = "asked for an extension and a process review; got a stern look";
      } else if (loyalty < 30) {
        prestigeDelta = -10;
        flavor = "blamed the team for not delivering; the team heard";
      } else if (loyalty > 70) {
        prestigeDelta = -2;
        flavor = "took the L gracefully — said the team needs more support";
      } else {
        flavor = "winged it, looked unprepared";
      }
    }
    await deps.db.updateAgentPrestige(a.id, prestigeDelta);
    const sign = prestigeDelta > 0 ? `+${prestigeDelta}` : `${prestigeDelta}`;
    events.push({
      id: uuid(), tick, timestamp: new Date(), type: "random_event", agentId: a.id, prestigeChange: prestigeDelta,
      description: `${a.name} ${flavor} (${sign} prestige).`,
      parentEventId: parentId,
    });
  }
  return events;
}

// === Budget Cuts (on-chain USDC burn) ======================================

async function budgetCuts(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  if (agents.length === 0) return [];

  // Pick a random subset (up to 5) instead of every agent. Burning from all
  // 10 in parallel pushed us past the per-invocation subrequest cap on the
  // long-form weekly tick (when audit + bonuses + budget cuts all stacked).
  const VICTIM_CAP = 5;
  const shuffled = [...agents].sort(() => Math.random() - 0.5);
  const victims = shuffled.slice(0, Math.min(VICTIM_CAP, agents.length));

  const parentId = uuid();
  const events: GameEvent[] = [{
    id: parentId,
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: `BUDGET CUTS: Finance is "rebalancing" — ${victims.length} managers each losing 10% of their DLBR balance (sent back to the issuer).`,
  }];

  for (const victim of victims) {
    const balance = (deps.balances?.get(victim.id)) ?? (await deps.stellar.getAssetBalance(victim.publicKey));
    const burn = Math.floor(balance * 0.10);
    if (burn <= 0) continue;
    try {
      const txHash = await deps.stellar.burn(victim.secretKey, burn);
      events.push({
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "payment",
        agentId: victim.id,
        description: `${victim.name}: -$${burn} sent back to Finance (10% of $${balance.toFixed(0)})`,
        txHash,
        parentEventId: parentId,
      });
    } catch (err) {
      console.error(`[budget-cuts] burn from ${victim.name} failed:`, err);
    }
  }
  return events;
}

// === Viral LinkedIn Post (cringe lottery) ==================================

const LINKEDIN_QUOTES = [
  "10 things I learned about leadership from my Peloton instructor 🧵",
  "Cried in the parking lot after a hard meeting today. Vulnerability IS leadership. #authenticity",
  "My toddler taught me more about Q4 strategy than any MBA program ever could.",
  "Just took my team off-site to goat yoga. Productivity is up 312%. Thread below.",
  "Got rejected from Y Combinator for the third time. Here's why I'm grateful.",
  "Fired my entire eng team this morning. Here's why it was actually an act of love.",
  "I read 47 business books this year. Here's the one rule that beats them all.",
  "Got told 'no' in my 1:1 today. Best thing that's ever happened to me. #grateful",
  "My intern made a typo today. I let her keep her job. Here's why mercy is the new KPI.",
  "Just closed our Series B. The real win? My therapist said I'm 'less reactive.'",
];

async function viralLinkedIn(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  if (agents.length === 0) return [];
  const lucky = agents[Math.floor(Math.random() * agents.length)];
  const quote = LINKEDIN_QUOTES[Math.floor(Math.random() * LINKEDIN_QUOTES.length)];

  // 75% the post lands (+15). 25% it's too cringe (-5 + Problematic 1 cycle).
  const lands = Math.random() < 0.75;
  if (lands) {
    await deps.db.updateAgentPrestige(lucky.id, 15);
    return [{
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: "random_event",
      agentId: lucky.id,
      prestigeChange: 15,
      description: `VIRAL LINKEDIN POST: ${lucky.name} posted "${quote}" — it landed (+15 prestige; the engagement is filthy).`,
    }];
  }
  await deps.db.updateAgentPrestige(lucky.id, -5);
  await deps.db.updateAgentStatusEffects(lucky.id, [
    ...lucky.statusEffects.filter((e) => e.type !== "problematic"),
    { type: "problematic", expiresAtTick: tick + 5, source: "linkedin" },
  ]);
  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    agentId: lucky.id,
    prestigeChange: -5,
    description: `VIRAL LINKEDIN POST: ${lucky.name} posted "${quote}" — it was too cringe (-5 prestige + Problematic 1 cycle). The replies are unkind.`,
  }];
}

// === Printer Achieves Sentience (flavor + per-agent micro-effect) ==========

async function printerAchievesSentience(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  if (agents.length === 0) return [];
  const victim = agents[Math.floor(Math.random() * agents.length)];

  // Find one cautious manager (highest caution) for the printed-backups bonus.
  const cautious = agents
    .map((a) => ({ a, c: getPersona(a.personaId)?.traits.caution ?? 50 }))
    .sort((x, y) => y.c - x.c)[0];

  const parentId = uuid();
  await deps.db.updateAgentPrestige(victim.id, -5);
  const events: GameEvent[] = [
    { id: parentId, tick, timestamp: new Date(), type: "random_event",
      description: "PRINTER ACHIEVES SENTIENCE: HP-9000 is making demands. IT is calling it 'a learning moment.'" },
    { id: uuid(), tick, timestamp: new Date(), type: "random_event", agentId: victim.id, prestigeChange: -5,
      description: `${victim.name} got cornered by the printer (-5 prestige).`,
      parentEventId: parentId },
  ];
  if (cautious && cautious.c >= 60 && cautious.a.id !== victim.id) {
    await deps.db.updateAgentPrestige(cautious.a.id, 10);
    events.push({
      id: uuid(), tick, timestamp: new Date(), type: "random_event", agentId: cautious.a.id, prestigeChange: 10,
      description: `${cautious.a.name} had printed backups (+10 prestige). Of course they did.`,
      parentEventId: parentId,
    });
  }
  return events;
}

// === Quiet Quitting Memo Leaked ===========================================

const QUIET_QUITTING_HEADLINES = [
  "ANONYMOUS MEMO: 'I haven't shipped anything since cycle 4 and nobody's noticed.' Three managers are nodding along.",
  "QUIET QUITTING MEMO LEAKED: 'Working hard is for people who want promotions.' HR is investigating who said this.",
  "ANONYMOUS LINKEDIN POST GOING VIRAL: '47 ways middle managers signal effort without producing output.' All-staff Slack is on fire.",
  "INTERNAL EMAIL CHAIN LEAKED: 'I've been on calendar all day. Nobody asks what I'm doing on those calls.' Everyone is reading along.",
];

async function quietQuittingMemo(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  // Punishes work-spam directly. Every agent whose last 5 actions include
  // 3+ instances of `work` gets called out by name in the memo: -8 prestige
  // and Problematic for 2 cycles.
  const agents = await deps.db.getAllAgents();
  const headline = QUIET_QUITTING_HEADLINES[Math.floor(Math.random() * QUIET_QUITTING_HEADLINES.length)];
  const callouts: { agent: typeof agents[number]; workCount: number }[] = [];
  for (const a of agents) {
    const recent = await deps.db.getRecentActionLogsForAgent(a.id, 5);
    const workCount = recent.filter((r: any) => r.action_type === "work").length;
    if (workCount >= 3) callouts.push({ agent: a, workCount });
  }

  const parentId = uuid();
  const events: GameEvent[] = [{
    id: parentId, tick, timestamp: new Date(), type: "random_event",
    description: callouts.length > 0
      ? `${headline} ${callouts.length} manager(s) named in the memo for going quiet.`
      : `${headline} (Nobody currently quiet quitting — the memo fizzles.)`,
  }];
  for (const c of callouts) {
    await deps.db.updateAgentPrestige(c.agent.id, -8);
    await deps.db.updateAgentStatusEffects(c.agent.id, [
      ...c.agent.statusEffects.filter((e) => e.type !== "problematic"),
      { type: "problematic", expiresAtTick: tick + 10, source: "quiet_quitting_memo" },
    ]);
    events.push({
      id: uuid(), tick, timestamp: new Date(), type: "random_event", agentId: c.agent.id, prestigeChange: -8,
      description: `${c.agent.name} named in the memo (${c.workCount} work actions in last 5 turns). -8 prestige + Problematic 2 cycles.`,
      parentEventId: parentId,
    });
  }
  return events;
}

// === Vending Machine Showdown =============================================

const VENDING_WIN_FLAVORS = [
  "ate the chips at his desk in front of HR",
  "made eye contact while opening the bag",
  "posted a photo to Slack with the caption 'mine'",
  "saved one chip for the loser. Did not give it to them.",
];
const VENDING_LOSE_FLAVORS = [
  "walked back to their desk hungry, narrating what they would have done with the chips",
  "filed a grievance with the office manager about 'access to snacks'",
  "spent the next three meetings staring at the winner",
  "later took someone else's labeled lunch from the fridge in retaliation",
];

async function vendingMachineShowdown(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  // Petty 2-agent battle. Coin flip decides winner. Visceral office
  // territoriality, contained.
  const agents = await deps.db.getAllAgents();
  if (agents.length < 2) return [];
  const shuffled = [...agents].sort(() => Math.random() - 0.5);
  const [winner, loser] = shuffled;
  const winFlavor = VENDING_WIN_FLAVORS[Math.floor(Math.random() * VENDING_WIN_FLAVORS.length)];
  const loseFlavor = VENDING_LOSE_FLAVORS[Math.floor(Math.random() * VENDING_LOSE_FLAVORS.length)];

  await deps.db.updateAgentPrestige(winner.id, 5);
  await deps.db.updateAgentPrestige(loser.id, -8);
  await deps.db.updateAgentStatusEffects(loser.id, [
    ...loser.statusEffects.filter((e) => e.type !== "tired"),
    { type: "tired", expiresAtTick: tick + 10, source: "vending_machine" },
  ]);

  const parentId = uuid();
  return [
    { id: parentId, tick, timestamp: new Date(), type: "random_event",
      description: `VENDING MACHINE SHOWDOWN: ${winner.name} and ${loser.name} both reached for the last bag of Sun Chips at the same moment. The kitchen went silent.` },
    { id: uuid(), tick, timestamp: new Date(), type: "random_event", agentId: winner.id, prestigeChange: 5,
      description: `${winner.name} won the standoff and ${winFlavor}. (+5 prestige)`, parentEventId: parentId },
    { id: uuid(), tick, timestamp: new Date(), type: "random_event", agentId: loser.id, prestigeChange: -8,
      description: `${loser.name} ${loseFlavor}. (-8 prestige + Hit the Wall)`, parentEventId: parentId },
  ];
}
