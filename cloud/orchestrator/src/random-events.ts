// Random events. Phase 5: every event that fires now has actual mechanics.
//   - All-Hands: signals the tick processor to skip Phase 4 (decisions/actions)
//   - Budget Cuts: each agent loses 15% of their DLBR balance via on-chain
//     payment to the asset issuer (effective burn)
//   - Reorg Rumors: every alliance is dissolved, pending proposals cleared
//   - Email Leak: a fake corporate email is generated and persisted to D1;
//     future LLM prompts include the most recent leaks as "Public Knowledge"
//   - New Initiative (one-shot, tick 24): all `has_deliverable` removed,
//     and a flag is set so future strategy_report rewards are halved
//   - Quarterly Bonus (every 12 ticks): top 3 agents each receive $50 from
//     HR Dept on-chain
//   - Employee of the Month (every 8 ticks): agent with the most `work`
//     actions in the last 8 ticks gets $40 + Inspired (2 ticks)
//   - Fire Drill: still flavor only, by request

import { v4 as uuid } from "uuid";
import type { GameEvent } from "./types.js";
import type { Db } from "./db.js";
import type { Stellar } from "./stellar.js";
import type { RewardSources } from "./tick.js";

export interface RandomEventsState {
  triggeredOnce: Set<string>;
  lastWeeklyTick: number;       // 12-tick cycle (mandatory fun, audit, quarterly bonus)
  lastEmployeeMonthTick: number; // 8-tick cycle (employee of the month)
  /** Audit cooldown: agentId → tick of last audit. Eligible victims must be
   *  >= 12 ticks since their last audit, otherwise we skip them. Without
   *  this, the lowest-balance agent gets pinned with -30 prestige + under
   *  review every weekly tick (death spiral). */
  recentAudits: Map<string, number>;
}

export function createRandomEventsState(): RandomEventsState {
  return {
    triggeredOnce: new Set(),
    lastWeeklyTick: 0,
    lastEmployeeMonthTick: 0,
    recentAudits: new Map(),
  };
}

interface EventDeps {
  db: Db;
  stellar: Stellar;
  rewards: RewardSources;
  /** Pre-fetched balance map (agentId → DLBR), supplied by processTick.
   *  Audit reuses it to avoid 10 redundant Horizon calls per weekly tick. */
  balances?: Map<string, number>;
}

export interface RandomEventsResult {
  events: GameEvent[];
  skipDecisions: boolean;  // All-Hands sets this true
}

export async function processRandomEvents(
  deps: EventDeps,
  state: RandomEventsState,
  tick: number
): Promise<RandomEventsResult> {
  const events: GameEvent[] = [];
  let skipDecisions = false;

  // Weekly cycle (every 12 ticks): mandatory fun, audit, quarterly bonus
  if (tick > 0 && tick % 12 === 0 && tick !== state.lastWeeklyTick) {
    state.lastWeeklyTick = tick;
    events.push(...(await mandatoryFun(deps, tick)));
    events.push(...(await audit(deps, state, tick)));
    events.push(...(await quarterlyBonus(deps, tick)));
  }

  // Employee of the Month (every 8 ticks)
  if (tick > 0 && tick % 8 === 0 && tick !== state.lastEmployeeMonthTick) {
    state.lastEmployeeMonthTick = tick;
    events.push(...(await employeeOfTheMonth(deps, tick)));
  }

  // One-shot midgame: New Initiative at tick 24
  if (tick === 24 && !state.triggeredOnce.has("new_initiative")) {
    state.triggeredOnce.add("new_initiative");
    events.push(...(await newInitiative(deps, tick)));
  }

  // Random per-tick rolls
  // All-Hands skips the entire decisions phase for this tick, which is
  // disruptive — keep the probability low so 4-hour games still see most
  // ticks produce action.
  if (Math.random() < 0.05) {
    events.push(...(await allHands(tick)));
    skipDecisions = true;
  }
  if (Math.random() < 0.08) events.push(...(await budgetCuts(deps, tick)));
  if (Math.random() < 0.05) events.push(...(await reorgRumors(deps, tick)));
  if (Math.random() < 0.07) events.push(...(await viralLinkedIn(deps, tick)));
  if (Math.random() < 0.05) events.push(...(await coffeeMachineBroken(deps, tick)));
  if (Math.random() < 0.08) events.push(...(await printerJam(deps, tick)));
  if (Math.random() < 0.03) events.push(...(await surprisePromotion(deps, tick)));
  if (Math.random() < 0.06) events.push(...(await emailLeak(deps, tick)));
  if (Math.random() < 0.04) events.push(...(await fireDrill(tick)));

  return { events, skipDecisions };
}

// === All-Hands ==============================================================

async function allHands(tick: number): Promise<GameEvent[]> {
  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: "ALL-HANDS MEETING: CEO is rambling about vision, synergy, and 'a really exciting Q4'. Nobody is getting anything done this cycle.",
  }];
}

// === Budget Cuts (on-chain 15% burn) =======================================

async function budgetCuts(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  if (agents.length === 0) return [];

  const events: GameEvent[] = [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: "BUDGET CUTS: Finance is clawing back 15% of every manager's discretionary budget. Effective immediately.",
  }];

  // Burn 15% from each agent in parallel — payments to the issuer destroy supply.
  await Promise.all(agents.map(async (agent) => {
    try {
      const balance = await deps.stellar.getAssetBalance(agent.publicKey);
      const burn = Math.floor(balance * 0.15 * 100) / 100;
      if (burn < 0.01) return; // skip if effectively nothing
      const txHash = await deps.stellar.burn(agent.secretKey, burn);
      events.push({
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        agentId: agent.id,
        description: `${agent.name}: lost $${burn.toFixed(2)} to Q4 austerity (15% cut)`,
        txHash,
      });
    } catch (err) {
      console.error(`[budget-cuts] burn failed for ${agent.name}:`, err);
    }
  }));

  return events;
}

// === Reorg Rumors (dissolve all alliances) =================================

async function reorgRumors(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();

  const broken = agents.filter((a) => a.allies.length > 0 || a.pendingAlliance);
  await Promise.all(broken.map(async (a) => {
    if (a.allies.length > 0) await deps.db.updateAgentAllies(a.id, []);
    if (a.pendingAlliance) await deps.db.updateAgentPendingAlliance(a.id, null);
  }));

  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: `REORG RUMORS: Slack is on fire. ${broken.length} alliance(s) dissolved overnight as everyone scrambles to protect themselves.`,
  }];
}

// === Email Leak (persisted fake email) =====================================

const EMAIL_TEMPLATES: Array<(from: string, to: string, third?: string) => { subject: string; body: string }> = [
  (from, to, third) => ({
    subject: "between us",
    body: `${third ? `look, ${third}'s "strategic vision" deck is just bullet points from the 2019 offsite. don't tell anyone i said that. — ${from}` : `${to}, real talk — half this team would not survive a real RIF. — ${from}`}`,
  }),
  (from, to) => ({
    subject: "Re: Re: Re: Q-thinking-about-it",
    body: `${to} — i'm not going to that meeting. tell anyone who asks i'm "in another stand-up." — ${from}`,
  }),
  (from, to, third) => ({
    subject: "fwd: idea",
    body: `${to} what if we just ${third ? `quietly took ${third}'s deck and reformatted it ` : "rebranded last quarter's deck "}— calling it "synthesis," vibes-based plagiarism, but no one will check. — ${from}`,
  }),
  (from, to) => ({
    subject: "reading between the lines",
    body: `${to}, the CEO's "great work everyone" email had ${from === "Linda Metrics" ? "exactly 3" : "exactly 2"} exclamation points. last week it was 5. this is a soft warning. — ${from}`,
  }),
  (from, to, third) => ({
    subject: "career advice (delete after reading)",
    body: `${to} — if you want to make principal, ${third ? `you need to start being seen with ${third} at lunches. visibility theater works.` : "you need to volunteer for the cross-functional taskforce. nobody who joined that has been laid off in 3 cycles."} — ${from}`,
  }),
  (from, to) => ({
    subject: "DO NOT FORWARD",
    body: `${to} the all-hands deck was leaked to me 4 hrs early. only mentioning because the "team kudos" slide doesn't have your name and i thought you should know. — ${from}`,
  }),
  (from, to, third) => ({
    subject: "Q3 retro thoughts",
    body: `${to} — ${third ? `${third} hosted "team lunch" but the food was a leftover wrap platter from a Tuesday all-hands. ` : ""}retros are theater. let's just complain to each other on slack like adults. — ${from}`,
  }),
  (from, to) => ({
    subject: "ok this is the move",
    body: `${to}: "Here's where we landed" + slide-with-arrow. that's the deck. that's the whole deck. people will applaud. — ${from}`,
  }),
];

async function emailLeak(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  if (agents.length < 2) return [];

  const victim = agents[Math.floor(Math.random() * agents.length)];
  const others = agents.filter((a) => a.id !== victim.id);
  const recipient = others[Math.floor(Math.random() * others.length)];
  const thirdParty = others.length > 1
    ? others.filter((a) => a.id !== recipient.id)[Math.floor(Math.random() * (others.length - 1))]
    : undefined;

  const tmpl = EMAIL_TEMPLATES[Math.floor(Math.random() * EMAIL_TEMPLATES.length)];
  const { subject, body } = tmpl(victim.name, recipient.name, thirdParty?.name);

  const id = uuid();
  await deps.db.saveLeakedEmail({
    id,
    tick,
    fromAgent: victim.id,
    toAgent: recipient.id,
    subject,
    body,
  });

  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    agentId: victim.id,
    targetId: recipient.id,
    description: `EMAIL LEAK: ${victim.name} → ${recipient.name} (Subject: "${subject}") — "${body}"`,
  }];
}

// === New Initiative (midgame pivot) ========================================

async function newInitiative(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  // Activate the flag — strategy_report payouts will be halved going forward.
  await deps.db.setGameStateValue("new_initiative_active", "true");

  // Anyone holding has_deliverable just had their deck invalidated.
  const agents = await deps.db.getAllAgents();
  let invalidated = 0;
  for (const a of agents) {
    if (a.statusEffects.some((e) => e.type === "has_deliverable")) {
      await deps.db.updateAgentStatusEffects(
        a.id,
        a.statusEffects.filter((e) => e.type !== "has_deliverable")
      );
      invalidated++;
    }
  }

  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: `NEW INITIATIVE: CEO announces a "Q3 strategic pivot." All ${invalidated} in-flight deliverable(s) are now obsolete. Future consultant reports earn 50% less prestige.`,
  }];
}

// === Quarterly Bonus (every 12 ticks; HR pays top 3) =======================

async function quarterlyBonus(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents(); // already sorted prestige DESC
  const top3 = agents.slice(0, 3);
  if (top3.length === 0) return [];

  const events: GameEvent[] = [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: `QUARTERLY BONUS: HR is releasing performance bonuses to the top 3 by prestige.`,
  }];

  for (const a of top3) {
    try {
      const txHash = await deps.stellar.sendAsset(deps.rewards.hrDeptSecret, a.publicKey, 50);
      events.push({
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "payment",
        agentId: a.id,
        description: `${a.name}: received $50 quarterly bonus from HR`,
        txHash,
      });
    } catch (err) {
      console.error(`[quarterly-bonus] HR payout to ${a.name} failed:`, err);
      events.push({
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        agentId: a.id,
        description: `${a.name}: bonus pending — HR is "processing" (failed payout)`,
      });
    }
  }
  return events;
}

// === Employee of the Month (every 8 ticks) =================================

async function employeeOfTheMonth(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  if (agents.length === 0) return [];

  const since = Math.max(0, tick - 8);
  const counts = await Promise.all(
    agents.map(async (a) => ({ agent: a, n: await deps.db.countWorkActionsSince(a.id, since) }))
  );
  counts.sort((x, y) => y.n - x.n);
  const winner = counts[0];
  // Bar raised to 3+ work actions in 8 cycles — winning with 1 work action
  // looked silly in the first run.
  if (winner.n < 3) {
    return [{
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: "random_event",
      description: `EMPLOYEE OF THE MONTH: nominations were "underwhelming" — no manager logged enough actual work to qualify. Award withheld this cycle.`,
    }];
  }

  // Pay $40 from HR + Inspired buff (2 ticks).
  let txHash: string | undefined;
  try {
    txHash = await deps.stellar.sendAsset(deps.rewards.hrDeptSecret, winner.agent.publicKey, 40);
  } catch (err) {
    console.error(`[employee-of-month] HR payout to ${winner.agent.name} failed:`, err);
  }
  await deps.db.updateAgentStatusEffects(winner.agent.id, [
    ...winner.agent.statusEffects,
    { type: "inspired", expiresAtTick: tick + 2 },
  ]);

  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "payment",
    agentId: winner.agent.id,
    description: `EMPLOYEE OF THE MONTH: ${winner.agent.name} (${winner.n} work actions in 8 cycles) → $40 + Inspired status.`,
    txHash,
  }];
}

// === Mandatory Fun (still random per-agent prestige; weekly) ===============

async function mandatoryFun(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  const events: GameEvent[] = [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: "MANDATORY FUN: Team building event! Everyone receives random prestige changes.",
  }];

  for (const agent of agents) {
    const prestigeChange = Math.floor(Math.random() * 31) - 10;
    await deps.db.updateAgentPrestige(agent.id, prestigeChange);
    events.push({
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: "random_event",
      agentId: agent.id,
      description: `${agent.name} ${prestigeChange >= 0 ? "enjoyed" : "endured"} mandatory fun (${prestigeChange >= 0 ? "+" : ""}${prestigeChange})`,
      prestigeChange,
    });
  }

  return events;
}

// === Audit (weekly) =========================================================

async function audit(deps: EventDeps, state: RandomEventsState, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  if (agents.length === 0) return [];

  // Cooldown: skip anyone audited in the last 12 ticks. Without this, whoever
  // hits the lowest balance once gets pinned and audited every weekly cycle.
  const eligible = agents.filter((a) => {
    const last = state.recentAudits.get(a.id);
    return !last || tick - last >= 12;
  });

  if (eligible.length === 0) {
    return [{
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: "random_event",
      description: "AUDIT: HR queued an audit, but every plausible suspect is already on review. Deferred to next quarter.",
    }];
  }

  // Use the pre-fetched balance map when present (cheap), else fall back.
  const balanceFor = async (a: typeof eligible[number]) =>
    deps.balances?.get(a.id) ?? (await deps.stellar.getAssetBalance(a.publicKey));

  const ranked = await Promise.all(
    eligible.map(async (a) => ({ agent: a, balance: await balanceFor(a) }))
  );
  ranked.sort((x, y) => x.balance - y.balance);

  // Pick randomly from the bottom 3 of eligible — adds variety so the same
  // person doesn't get audited twice in a row even if their balance is still
  // lowest right after the cooldown clears.
  const pool = ranked.slice(0, Math.min(3, ranked.length));
  const victim = pool[Math.floor(Math.random() * pool.length)].agent;

  state.recentAudits.set(victim.id, tick);

  await deps.db.updateAgentPrestige(victim.id, -30);
  const agentData = (await deps.db.getAgent(victim.id))!;
  await deps.db.updateAgentStatusEffects(victim.id, [
    ...agentData.statusEffects,
    { type: "under_review" as const, expiresAtTick: tick + 4 },
  ]);

  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    agentId: victim.id,
    description: `AUDIT: ${victim.name} is under review for excessive spending! -30 prestige`,
    prestigeChange: -30,
  }];
}

// === Viral LinkedIn ========================================================

async function viralLinkedIn(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  if (agents.length === 0) return [];

  const lucky = agents[Math.floor(Math.random() * agents.length)];
  await deps.db.updateAgentPrestige(lucky.id, 50);

  const posts = [
    "I'm humbled to announce...",
    "Agree? 👇",
    "My unpopular opinion: hard work pays off",
    "Here's what 10 years in corporate taught me...",
    "CEO: You're fired. Me: I quit first. CEO: 😮 Hired.",
  ];
  const post = posts[Math.floor(Math.random() * posts.length)];

  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    agentId: lucky.id,
    description: `VIRAL LINKEDIN POST: ${lucky.name} posted "${post}" and gained 50 prestige!`,
    prestigeChange: 50,
  }];
}

// === Coffee Machine Broken =================================================

async function coffeeMachineBroken(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  for (const agent of agents) {
    if (!agent.statusEffects.some((e) => e.type === "caffeinated")) {
      await deps.db.updateAgentStatusEffects(agent.id, [
        ...agent.statusEffects,
        { type: "tired" as const, expiresAtTick: tick + 2 },
      ]);
    }
  }

  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: "COFFEE MACHINE BROKEN: Everyone without Caffeinated status is now Tired (-2 prestige/cycle for 2 cycles)!",
  }];
}

// === Printer Jam ===========================================================

async function printerJam(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = await deps.db.getAllAgents();
  const victims = agents.filter((a) => a.statusEffects.some((e) => e.type === "has_deliverable"));
  if (victims.length === 0) return [];

  const victim = victims[Math.floor(Math.random() * victims.length)];
  await deps.db.updateAgentStatusEffects(
    victim.id,
    victim.statusEffects.filter((e) => e.type !== "has_deliverable")
  );

  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    agentId: victim.id,
    description: `PRINTER JAM: ${victim.name} lost their deliverable! The printer ate it.`,
  }];
}

// === Surprise Promotion ====================================================

async function surprisePromotion(deps: EventDeps, tick: number): Promise<GameEvent[]> {
  const agents = (await deps.db.getAllAgents()).sort((a, b) => a.prestige - b.prestige);
  if (agents.length === 0) return [];

  const lowest = agents[0];
  await deps.db.updateAgentPrestige(lowest.id, 20);

  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    agentId: lowest.id,
    description: `SURPRISE PROMOTION: ${lowest.name} got promoted out of nowhere! +20 prestige. Everyone is confused.`,
    prestigeChange: 20,
  }];
}

// === Fire Drill (still flavor only — by request) ===========================

async function fireDrill(tick: number): Promise<GameEvent[]> {
  return [{
    id: uuid(),
    tick,
    timestamp: new Date(),
    type: "random_event",
    description: "FIRE DRILL: Everyone evacuates! Plenty of time for hallway gossip in the parking lot.",
  }];
}
