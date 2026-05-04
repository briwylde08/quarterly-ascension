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
}

export function createRandomEventsState(): RandomEventsState {
  return {
    glassCliffVictims: new Set(),
    lastFiredEvents: new Set(),
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

  // Quarterly Bonus at fixed cycle boundaries: halftime (cycle 4 = tick 40)
  // and finale (cycle 8 = tick 80, also game-end).
  if (tick === 40) {
    events.push(...(await quarterlyBonus(deps, tick, [50, 30, 20], "Halftime")));
  } else if (tick === 80) {
    events.push(...(await quarterlyBonus(deps, tick, [100, 60, 40], "Finale")));
  }

  // Glass Cliff Promotion: auto-fires whenever the leader pulls 50+ prestige
  // ahead of rank-2, *and* hasn't already been cliffed this game.
  events.push(...(await glassCliffPromotion(deps, state, tick)));

  // Per-cycle probabilistic rolls. Skip any event that fired at the previous
  // cycle boundary so the same chaos doesn't hit two cycles in a row.
  const fired = new Set<string>();
  const skipped = state.lastFiredEvents;
  const roll = (id: string, prob: number): boolean => {
    if (skipped.has(id)) return false;
    if (Math.random() >= prob) return false;
    fired.add(id);
    return true;
  };

  // Probabilities bumped post-pre-flight #1 (sum was ~0.70/cycle → ~6
  // events/game including the 2 fixed bonuses; the show felt sparse).
  // New sum ≈ 1.00/cycle → ~8 random events + 2 fixed bonuses ≈ 10/game.
  if (roll("surprise_board_visit", 0.15))   events.push(...(await surpriseBoardVisit(deps, tick)));
  if (roll("bad_glassdoor_review", 0.15))   events.push(...(await badGlassdoorReview(deps, tick)));
  if (roll("surprise_promotion", 0.13))     events.push(...(await surprisePromotion(deps, tick)));
  if (roll("surprise_demo_day", 0.13))      events.push(...(await surpriseDemoDay(deps, tick)));
  if (roll("budget_cuts", 0.15))            events.push(...(await budgetCuts(deps, tick)));
  if (roll("viral_linkedin", 0.15))         events.push(...(await viralLinkedIn(deps, tick)));
  if (roll("printer_sentience", 0.14))      events.push(...(await printerAchievesSentience(deps, tick)));

  state.lastFiredEvents = fired;

  return { events, skipDecisions: false };
}

// === Quarterly Bonus =======================================================

async function quarterlyBonus(
  deps: EventDeps,
  tick: number,
  payouts: [number, number, number],
  label: string
): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents(); // sorted prestige DESC
  const top3 = agents.slice(0, 3);
  if (top3.length === 0) return [];

  const parentId = uuid();
  const events: GameEvent[] = [{
    id: parentId,
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: `QUARTERLY BONUS — ${label}: HR is releasing performance bonuses to the top 3 by prestige.`,
  }];

  for (let i = 0; i < top3.length; i++) {
    const a = top3[i];
    const amount = payouts[i];
    try {
      const txHash = await deps.stellar.sendAsset(deps.rewards.hrDeptSecret, a.publicKey, amount);
      events.push({
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "payment",
        agentId: a.id,
        description: `${a.name} (rank #${i + 1}): received $${amount} ${label.toLowerCase()} bonus from HR`,
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
        prestigeDelta = 20;
        flavor = "tried to claim credit for two other teams' work mid-presentation; got side-eye";
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
    description: `BUDGET CUTS: Finance is "rebalancing" — ${victims.length} managers each losing 15% of their DLBR balance (sent back to the issuer).`,
  }];

  for (const victim of victims) {
    const balance = (deps.balances?.get(victim.id)) ?? (await deps.stellar.getAssetBalance(victim.publicKey));
    const burn = Math.floor(balance * 0.15);
    if (burn <= 0) continue;
    try {
      const txHash = await deps.stellar.burn(victim.secretKey, burn);
      events.push({
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "payment",
        agentId: victim.id,
        description: `${victim.name}: -$${burn} sent back to Finance (15% of $${balance.toFixed(0)})`,
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
    { type: "problematic", expiresAtTick: tick + 1, source: "linkedin" },
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
