// LLM decision engine. Same logic as src/orchestrator/llm.ts on the laptop;
// the differences are: OpenAI client config comes from env-bound secrets, and
// the db / stellar accessors are injected so the DO can supply them.

import OpenAI from "openai";
import type { Agent, Action } from "./types.js";
import { buildPersonaPrompt, getPersona } from "./personas.js";
import type { Db } from "./db.js";
import type { Stellar } from "./stellar.js";

export interface LlmDeps {
  db: Db;
  stellar: Stellar;
  openaiBaseUrl: string;
  openaiApiKey: string;
  cfAigToken?: string;
}

export interface GossipMoment {
  tick: number;
  description: string;
  prestigeChange?: number | null;
}

const GOSSIP_SYSTEM_PROMPT = `You're Dana — the office gossip at MegaCorp. Fifteen years here, knows everyone's deal, has opinions about everyone. Right now you're catching up your work bestie about what's gone down in the last few cycles.

Voice: chatty, casual, slightly catty, affectionate-snarky. Use phrases like "did you SEE", "between us", "honestly", "bless their heart", "you'll never guess what." Don't read a list — make it a conversation. Refer to managers by first name only. 3-5 sentences total. End on a juicy hook ("...and don't even get me started on Marcus") if there's more to tell.

Don't mention prestige numbers literally — translate them ("got absolutely cooked", "had a moment", "is having a quarter"). Don't moralize. The bestie knows the office; you don't have to explain mechanics.`;

export async function generateGossip(
  deps: LlmDeps,
  moments: GossipMoment[],
  currentTick: number,
): Promise<string> {
  if (moments.length === 0) return "Honestly? Dead cycle. Nothing to report. Get me coffee and I'll dig.";
  const openai = new OpenAI({
    apiKey: deps.openaiApiKey,
    baseURL: deps.openaiBaseUrl,
    defaultHeaders: deps.cfAigToken ? { "cf-aig-authorization": `Bearer ${deps.cfAigToken}` } : undefined,
  });
  const lines = moments
    .map((m) => `- Cycle ${m.tick}: ${m.description}${m.prestigeChange ? ` (${m.prestigeChange > 0 ? "+" : ""}${m.prestigeChange} prestige)` : ""}`)
    .join("\n");
  const userPrompt = `Current cycle: ${currentTick}. Recent activity:\n\n${lines}\n\nGive me the dish.`;
  const response = await openai.chat.completions.create({
    model: "openai/gpt-5.5",
    max_completion_tokens: 400,
    messages: [
      { role: "system", content: GOSSIP_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });
  return (response.choices[0]?.message?.content || "").trim();
}

// Retreat-mode 27-action menu. Cuts from long-form: buy_fancy_coffee,
// check_hr_status, competitive_intel, recover_emails, calendar_conflict,
// team_lunch, poison_meeting, birthday_cake, book_motivation, send_motivation,
// whistleblower_bounty, mentorship, fix_laptop. Adds: spread_rumor,
// move_meeting_early, schedule_pre_meeting, office_party, anonymous_pulse_survey,
// hostile_takeover, boomerang, cry_in_stairwell, join_meeting_silently.
const ALL_ACTIONS = [
  // === FREE (12) ===
  { type: "work", description: "Do actual work (+5 prestige, +$2 base salary, free). Boring. The audience does not enjoy watching this.", cost: 0 },
  { type: "expense_report", description: "File an expense report (+$25 reimbursed; 10% chance Finance flags it for -5 prestige). Safe income path — when budgets get tight, this is the cleanest refill.", cost: 0 },
  { type: "find_budget", description: "Snoop for unused budget in another department (free). 60% chance: HR transfers $30 to you. 40% chance: get caught — lose 10 prestige + Meeting Blocked for 1 cycle. Risky cash grab; bigger upside than expense_report but real downside.", cost: 0 },
  { type: "shotgun_red_bull", description: "Shotgun a Red Bull in the breakroom (free). Removes Hit the Wall instantly. Mildly unprofessional but effective. The kitchen smells like sugar for an hour. The free way to recover.", cost: 0 },
  { type: "take_credit", description: "Attempt to claim credit for someone's work (50% base success: +30 prestige, 50% fail: -20 prestige). Auto-succeeds against a Documented target (set up via Sabotage Plan). Bumped to 65% against targets with Questionable Judgment (set up via Spread Rumor).", cost: 0, requiresTarget: true },

  { type: "schmooze", description: "Schmooze another manager — propose a cross-functional partnership (free). Each manager caps at 3 partnerships; if you're at 3 OR they're at 3, the proposal politely fizzles ('they're at capacity, let's circle back next quarter').", cost: 0, requiresTarget: true },
  { type: "accept_alliance", description: "Accept a pending cross-functional partnership (+5 prestige to both)", cost: 0, requiresTarget: true },
  { type: "reject_alliance", description: "Reject a pending cross-functional partnership (proposer loses 10 prestige)", cost: 0, requiresTarget: true },
  { type: "break_alliance", description: "End a cross-functional partnership (-15 prestige for you; ex-partner gets Under Investigation 1 tick — can't retaliate immediately). Calculated nuke.", cost: 0, requiresTarget: true },

  // Underdog comeback paths — gated by prestige thresholds in the filter below.
  { type: "boomerang", description: "Quit and come back (free). Sets your prestige to 75, clears all status effects. Massive visual moment, one shot per game. Available only when prestige < 30 AND after tick 10 — gives the game time to develop before anyone reaches for the comeback button.", cost: 0 },
  { type: "cry_in_stairwell", description: "Cry in the stairwell (free, anytime). Removes Problematic and Hit the Wall. 20% chance the VP sees and grants +20 sympathy prestige. The desperate self-rescue or just a Tuesday.", cost: 0 },
  { type: "hail_mary_idea", description: "Pitch a wild idea at the next all-hands (free). Lottery: 30% +50 prestige (CEO loved it), 50% +5 (polite nodding), 20% -5 (sounded unhinged). One use per game.", cost: 0 },

  // Passive accumulation — capped at 3 uses per game; 3rd use grants Mysterious Influence.
  { type: "join_meeting_silently", description: "Join a meeting and say nothing (free, +4 prestige). Do this 3 times in one game and you'll get a MYSTERIOUS INFLUENCE public tag — people start crediting you with things you didn't do.", cost: 0 },

  // === CHEAP PAID ($5 – $10) ===
  { type: "coffee_chat", description: "Casual coffee with target ($5; non-self). Both gain +3 prestige. No alliance proposed. Low-stakes networking.", cost: 5, requiresTarget: true },
  { type: "buy_coffee", description: "Buy coffee (removes Hit the Wall).", cost: 5 },
  { type: "spread_rumor", description: "Spread a rumor about target ($10). Target loses 5 prestige and gets QUESTIONABLE JUDGMENT public tag for 2 cycles. Cheap social warfare with real teeth.", cost: 10, requiresTarget: true },
  { type: "move_meeting_early", description: "Move target's meeting to 7:30am ($10). Target -5 prestige + Hit the Wall (-3/cycle for 3 cycles = -9 total damage, plus they'll need to spend a turn on Shotgun a Red Bull or $5 on Buy Coffee — that's stolen value on top of the prestige hit). Underrated cheap attack.", cost: 10, requiresTarget: true },

  // === MID PAID ($20 – $25) ===
  { type: "invoke_handbook", description: "Invoke the Employee Handbook against target ($15). Cite a policy section. Target loses 3 prestige and gains Problematic for 2 cycles. The cheap source of Problematic — combine with Bad Glassdoor Review for compound damage.", cost: 15, requiresTarget: true },
  { type: "schedule_pre_meeting", description: "Schedule a pre-meeting for the meeting ($20). Target loses 15 prestige (highest single-shot damage at this cost) + gains MEETING BLOCKED for 2 cycles, blocking their Book CEO Time play. Loyal managers (loyalty > 70) think pre-meetings are normal and are immune — but most managers aren't loyal.", cost: 20, requiresTarget: true },
  { type: "file_complaint", description: "File HR complaint (you +5 'diligence' prestige; target gets Under Investigation, can't retaliate against you for 1 tick)", cost: 22, requiresTarget: true },
  { type: "strategy_report", description: "Get consultant report (+35 prestige, gives Has Deliverable for a future +40 CEO meeting)", cost: 30 },
  { type: "slack_bomb", description: "Drop a passive-aggressive bomb in #general aimed at one named target ($15). Picked target loses 8 prestige + gains Questionable Judgment for 2 cycles. A bystander (random other manager) catches splash for -4 prestige (no tag) — sometimes that's a rival, sometimes that's an ally. You gain 8 prestige (eyeballs are eyeballs). 15% chance HR flags it → you also lose 5 prestige and gain Problematic 1 cycle. Cheaper than Spread Rumor's per-damage cost.", cost: 15, requiresTarget: true },
  { type: "office_party", description: "Throw an office party ($25). +5 prestige to ALL managers and +15 to you. Generous play that visibly helps your rivals too.", cost: 25 },
  { type: "anonymous_pulse_survey", description: "Launch an 'anonymous' morale survey somehow entirely about the leader ($25). Target loses 50 prestige. Available only when YOU are rank ≥ 4 AND target is rank #1. One shot per game.", cost: 25, requiresTarget: true },

  // === EXPENSIVE ($30 – $50) ===
  { type: "sensitivity_training", description: "Send rival to sensitivity training (you +5 'managerial accountability' prestige; target -20 + Problematic for 4 ticks at -3/tick. Setup play — Bad Glassdoor Review hits Problematic targets for an extra -10.)", cost: 30, requiresTarget: true },
  { type: "schedule_conflict", description: "Cancel target's CEO meeting (clears their Has Deliverable + Meeting-Blocked for 2 ticks)", cost: 30, requiresTarget: true },
  { type: "hostile_takeover", description: "Mount a hostile takeover of target's cross-functional partnerships ($35). Their existing partners become YOUR partners; target's partner list goes to zero. Mid-to-late game power move.", cost: 35, requiresTarget: true },
  { type: "sabotage_plan", description: "Commission a dossier on target (-10 prestige + Documented for 2 cycles, meaning the next Take Credit against them is a guaranteed +30 prestige to the attacker). Combined value: $40 cost, ~$70+ prestige swing if you Take Credit on cycle 2. The biggest setup play in the game.", cost: 40, requiresTarget: true },
  { type: "book_ceo_time", description: "Meet with CEO (+40 prestige with Has Deliverable, -20 without; -10 if Meeting-Blocked)", cost: 40 },
];

export interface TickCtx {
  /** All agents, freshly read at the start of the tick. */
  allAgents: Agent[];
  /** Recent leaked emails (max 5). */
  leakedEmails: Array<{ fromAgent: string; toAgent: string; subject: string; body: string }>;
  /** Pre-fetched DLBR balances by agent id, computed in parallel at tick start. */
  balances: Map<string, number>;
}

interface DecisionContext {
  agent: Agent;
  balance: number;
  currentTick: number;
  allAgents: Agent[];
  recentActions: any[];
  leakedEmails: Array<{ fromAgent: string; toAgent: string; subject: string; body: string }>;
  /** Free-form directive set by the human adopter. In retreat mode this is
   *  always-open and persistent — the LLM sees whatever is currently set. */
  directive: string | null;
  /** True once this agent has used their one-shot hail_mary_idea this game. */
  hailMaryUsed: boolean;
  /** True once this agent has burned their one-shot boomerang. */
  boomerangUsed: boolean;
  /** True once this agent has launched their one-shot anonymous_pulse_survey. */
  pulseSurveyUsed: boolean;
  /** Number of times the agent has used join_meeting_silently this game.
   *  Capped at 3 — the 3rd use grants Mysterious Influence. */
  joinMeetingCount: number;
  /** Recent inbound attacks targeting this agent. Used to surface a
   *  "you just got hit by X" pull in the prompt so retaliation is a
   *  visible, named option rather than a generic rival list. */
  recentAttackers: Array<{ attackerId: string; attackerName: string; actionType: string; tick: number }>;
  /** True once any agent in the game has earned the Mysterious Influence
   *  status — once that happens, join_meeting_silently is removed from
   *  every menu globally. The "office cipher" trope is one-character-only. */
  mysteriousInfluenceClaimed: boolean;
}

// Hostile actions that have a target argument and are subject to the
// per-target cooldown ("you can't attack the same person with the same
// move twice in a row"). Surfaced both as a prompt warning and enforced
// at handler-time. schedule_pre_meeting + move_meeting_early added
// post-game-3: pre-flight #3 had Pre-Meeting on Ron 5x because it
// wasn't in the cooldown list.
const TARGETED_HOSTILE_ACTIONS = new Set([
  "spread_rumor",
  "sensitivity_training",
  "sabotage_plan",
  "take_credit",
  "schedule_pre_meeting",
  "move_meeting_early",
  "slack_bomb",
]);
const TARGET_COOLDOWN_TICKS = 10; // ≈ 2 cycles in 1-agent/tick mode

function buildContextPrompt(ctx: DecisionContext): string {
  const { agent, balance, currentTick, allAgents, recentActions, leakedEmails, directive, hailMaryUsed, boomerangUsed, pulseSurveyUsed, joinMeetingCount, mysteriousInfluenceClaimed } = ctx;
  // Rank used by the anonymous_pulse_survey gate (only available when underdog).
  const currentRank = allAgents.findIndex((a) => a.id === agent.id) + 1;

  // Public-visible statuses on rivals — info other agents can act on
  // (e.g. a Marked agent is auto-take_credit-able). Most internal statuses
  // are hidden from peers; this whitelist surfaces only the actionable ones.
  const PUBLIC_STATUSES = new Set([
    "marked", "problematic", "tired", "meeting_blocked",
    "mysterious_influence", "questionable_judgment",
  ]);
  const otherAgents = allAgents
    .filter((a) => a.id !== agent.id)
    .map((a) => {
      const tags = a.statusEffects
        .filter((s) => PUBLIC_STATUSES.has(s.type))
        .map((s) => s.type.toUpperCase().replace(/_/g, " "));
      // Well-allied = 3+ alliances. Hostile actions against this agent are
      // dampened (sensitivity_training, sabotage_plan, poison_meeting all
      // halve their prestige hit). Surface so the LLM can route around.
      if (a.allies.length >= 3) tags.push("WELL-ALLIED");
      return {
        id: a.id,
        name: a.name,
        title: a.title,
        prestige: a.prestige,
        isAlly: agent.allies.includes(a.id),
        isRival: false,
        publicTags: tags,
      };
    });

  const availableActions = ALL_ACTIONS.filter((action) => {
    if (action.cost > balance) return false;
    if (action.type === "accept_alliance" && !agent.pendingAlliance) return false;
    if (action.type === "reject_alliance" && !agent.pendingAlliance) return false;
    if (action.type === "break_alliance" && agent.allies.length === 0) return false;
    // Hail Mary only surfaces when the agent is truly cornered: low prestige
    // AND low cash AND hasn't already burned the one-shot this game.
    if (action.type === "hail_mary_idea" && (agent.prestige > 10 || balance >= 5 || hailMaryUsed)) return false;
    // Retreat-mode comeback gates.
    // Boomerang: prestige < 30, one-shot, AND tick > 10 (= cycle 3+). The
    // tick gate stops the "starting balance reset" pattern where 5+ agents
    // boomerang in the first 2 cycles before the game has even developed.
    if (action.type === "boomerang" && (agent.prestige >= 30 || boomerangUsed || currentTick <= 10)) return false;
    // Cry in the Stairwell is now anytime-available. Was gated to ≤30
    // prestige but post-game-2 feedback: more melodrama is better.
    // Anonymous pulse survey: underdog tool, one-shot, target #1 only.
    // Per-agent gate here; per-target #1 check happens at execution.
    if (action.type === "anonymous_pulse_survey" && (currentRank < 4 || pulseSurveyUsed)) return false;
    // Join meeting silently has TWO gates:
    //   1. Per-agent cap of 3 uses (each agent's path to Mysterious Influence)
    //   2. Global one-per-game cap on the trophy itself — once any agent
    //      has earned Mysterious Influence, the action disappears from
    //      every menu. Pre-flight #2 saw 6/10 agents grab MI; that's
    //      not the rare-trope-character beat we wanted.
    if (action.type === "join_meeting_silently" && (joinMeetingCount >= 3 || mysteriousInfluenceClaimed)) return false;
    return true;
  });

  const statusDescriptions = agent.statusEffects.map((s) => {
    switch (s.type) {
      // Retreat renames: internal key stays stable; user-facing label is updated.
      case "tired": return "Hit the Wall (-3 prestige/cycle decay; removed by Shotgun a Red Bull, Buy Coffee, or Cry in the Stairwell)";
      case "marked": return `Documented (sabotaged — next take_credit against you auto-succeeds; expires tick ${s.expiresAtTick})`;
      // Retreat additions:
      case "mysterious_influence": return "Mysterious Influence (+2 prestige/cycle passive; people occasionally credit you for things you didn't do)";
      case "questionable_judgment": return `Questionable Judgment (public credibility tag; expires tick ${s.expiresAtTick})`;
      // Carryover from long-form:
      case "under_investigation": return `Under Investigation (can't take hostile action against ${s.source}; expires tick ${s.expiresAtTick})`;
      case "problematic": return `Problematic (-3 prestige/tick decay; expires tick ${s.expiresAtTick})`;
      case "has_deliverable": return "Has Deliverable (CEO meeting will succeed and award +40)";
      case "meeting_blocked": return `Meeting-Blocked (can't book CEO time; expires tick ${s.expiresAtTick})`;
      // Cut effects (no source remaining in retreat) — keep cases for backward
      // compatibility with any in-flight game state until DB is reset.
      case "caffeinated": return `Caffeinated (legacy; expires tick ${s.expiresAtTick})`;
      case "inspired": return `Inspired (legacy; expires tick ${s.expiresAtTick})`;
      case "under_review": return `Under Review (legacy; expires tick ${s.expiresAtTick})`;
      case "technical_difficulties": return "Technical Difficulties (legacy; forced to shotgun a Red Bull)";
      case "mandatory_motivation": return "Stuck in Mandatory Motivation (legacy; forced to rest)";
      default: return s.type;
    }
  });

  const leakSection = leakedEmails.length > 0
    ? `\nPUBLIC KNOWLEDGE (recently leaked internal emails — everyone has seen these):\n${leakedEmails.map((e) => {
        const from = allAgents.find((a) => a.id === e.fromAgent)?.name ?? e.fromAgent;
        const to = allAgents.find((a) => a.id === e.toAgent)?.name ?? e.toAgent;
        return `- ${from} → ${to} (Subject: "${e.subject}"): "${e.body}"`;
      }).join("\n")}\n`
    : "";

  // Anti-pattern nudge: tighter than long-form (was 3+ in last 5).
  // Retreat: 2+ same action in last 4 = nudge.
  const recentSlice = recentActions.slice(-4);
  const actionCounts = new Map<string, number>();
  for (const a of recentSlice) {
    actionCounts.set(a.action_type, (actionCounts.get(a.action_type) ?? 0) + 1);
  }
  let lockInNote = "";
  for (const [actionType, count] of actionCounts) {
    if (count >= 2) {
      lockInNote =
        `\nSTRATEGY NOTE: You've chosen '${actionType}' ${count} of your last ${recentSlice.length} turns. The audience is starting to clock the pattern. Your rivals see it too. Strongly consider varying your approach this turn — there are 27 actions in the menu and most of them you haven't tried yet.\n`;
      break;
    }
  }

  // Per-target hostile cooldown surface. For each (actionType, targetId)
  // pair this agent has used in the last TARGET_COOLDOWN_TICKS, mark it
  // as on cooldown — the LLM is told not to repeat, and the handler
  // enforces a no-op if it tries anyway.
  const cooldownPairs: Array<{ actionType: string; targetId: string; tick: number }> = [];
  for (const a of recentActions) {
    if (!TARGETED_HOSTILE_ACTIONS.has(a.action_type)) continue;
    let target: string | undefined;
    try {
      const data = typeof a.action_data === "string" ? JSON.parse(a.action_data) : a.action_data;
      target = data?.target;
    } catch { /* ignore parse failures */ }
    if (!target) continue;
    if (currentTick - a.tick >= TARGET_COOLDOWN_TICKS) continue;
    cooldownPairs.push({ actionType: a.action_type, targetId: target, tick: a.tick });
  }
  let cooldownNote = "";
  if (cooldownPairs.length > 0) {
    const lines = cooldownPairs.map((p) => {
      const t = allAgents.find((a) => a.id === p.targetId);
      return `- ${p.actionType} → ${t?.name ?? p.targetId} (used at tick ${p.tick}, cooldown until tick ${p.tick + TARGET_COOLDOWN_TICKS})`;
    });
    cooldownNote =
      `\nCOOLDOWNS — these (action, target) pairs are on cooldown. Repeating now will fizzle (no effect; the office gossip mill is bored of this storyline):\n${lines.join("\n")}\n`;
  }

  // Retaliation pull: surface the most recent inbound attack so the LLM
  // sees a clear "this person just hit you" pointer rather than a generic
  // rival list.
  let retaliationNote = "";
  if (ctx.recentAttackers.length > 0) {
    const lines = ctx.recentAttackers.slice(0, 3).map((r) =>
      `- ${r.attackerName} hit you with ${r.actionType} at tick ${r.tick}`
    );
    retaliationNote =
      `\nRECENT INCOMING ATTACKS (you may want to retaliate):\n${lines.join("\n")}\nRetaliation is a strong play — the audience reads back-and-forth feuds as drama. Counter-attacks land especially well.\n`;
  }

  const directiveSection = directive
    ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LIFE-COACH DIRECTIVE (from your real-world life-coach; live, may update tick-to-tick):

  "${directive.replace(/"/g, '\\"')}"

This is a life-coach whispering in your ear, helping you show up as
your best (or worst) self. Take it seriously. BUT — your persona
traits shape *how* you execute. If the directive conflicts with who
you are (e.g. a cautious manager told to "go aggressive," or a loyal
one told to "betray everyone"), your character might comply
imperfectly, half-heartedly, or pick an adjacent action that fits
your nature better. Be true to yourself. Either way, your reasoning
quote MUST explicitly reference the directive — say what your life
coach asked and how your action relates. The audience is watching
this play out.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`
    : "";

  // allAgents arrives pre-sorted prestige DESC, so allAgents[0] is the leader
  // and findIndex+1 is this agent's rank.
  const rank = allAgents.findIndex((a) => a.id === agent.id) + 1;
  const leader = allAgents[0];
  const gapToLeader = leader.prestige - agent.prestige;
  let positionalNudge = "";
  if (rank === 1) {
    positionalNudge = `\nSTRATEGIC POSITION:\nYou're the current leader. Defend your lead — don't get cute. Build deliverables, keep your alliances warm, and avoid handing the mid-pack a reason to focus-fire on you.\n`;
  } else if (rank >= 2 && rank <= 5) {
    positionalNudge = `\nSTRATEGIC POSITION:\nYou're in striking distance (Rank ${rank} of ${allAgents.length}). The leader is ${leader.name} at ${leader.prestige} prestige — ${gapToLeader} ahead of you. To win the VP slot you'll need to close that gap. Concentrated pressure on the leader (sabotage_plan + take_credit, sensitivity_training, schedule_conflict on a Deliverable holder) is usually the fastest path. Coordinate with allies if you have them.\n`;
  } else {
    positionalNudge = `\nSTRATEGIC POSITION:\nYou're in the bottom half (Rank ${rank} of ${allAgents.length}, ${gapToLeader} behind the leader). Picking fights at the top from here usually backfires — you'll burn budget for marginal damage and the leader will still be ahead. Focus on rebuilding your own position: work, alliances, deliverables, and earning paths (mentorship, coffee_chat). Climb steadily before you punch up.\n`;
  }

  return `${directiveSection}${positionalNudge}${retaliationNote}${cooldownNote}${lockInNote}
CURRENT SITUATION (Tick ${currentTick}):

YOUR STATUS:
- Prestige: ${agent.prestige} (Rank #${rank} of ${allAgents.length})
- Budget: $${balance.toFixed(2)} DLBR
- Status Effects: ${statusDescriptions.length > 0 ? statusDescriptions.join(", ") : "None"}
- Allies: ${agent.allies.length > 0 ? agent.allies.map((id) => allAgents.find((a) => a.id === id)?.name).join(", ") : "None"}
${agent.pendingAlliance ? `- PENDING ALLIANCE: ${allAgents.find((a) => a.id === agent.pendingAlliance)?.name} wants to ally with you` : ""}

${(() => {
  // Surface Documented (auto-Take-Credit) and Questionable Judgment
  // (65% Take Credit) targets as a dedicated EXPLOIT NOW section. Without
  // this callout the LLM tends to miss the chain even when both pieces
  // (target tag + take_credit description) are in the prompt — game-7 had
  // 6 Documented windows and 0 chained Take Credits.
  const documented = otherAgents.filter(a => a.publicTags.includes("MARKED"));
  const qj = otherAgents.filter(a => a.publicTags.includes("QUESTIONABLE JUDGMENT"));
  if (documented.length === 0 && qj.length === 0) return "";
  const lines: string[] = ["🎯 EXPLOIT OPPORTUNITIES (act on these BEFORE the windows close):"];
  for (const a of documented) {
    lines.push(`- ${a.name} (id: ${a.id}) is DOCUMENTED — take_credit on them is a GUARANTEED +30 prestige (free action). This is the biggest single-action swing available. Do not miss this window.`);
  }
  for (const a of qj) {
    lines.push(`- ${a.name} (id: ${a.id}) has QUESTIONABLE JUDGMENT — take_credit on them is 65% to succeed (vs the usual 50%). Solid value if you don't have a cleaner shot.`);
  }
  return lines.join("\n") + "\n\n";
})()}OTHER MANAGERS (use the id in lowercase as "target" in action JSON):
${otherAgents.map((a) => {
  const tags: string[] = [];
  if (a.isAlly) tags.push("ALLY");
  for (const t of a.publicTags) tags.push(t);
  const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  return `- id: ${a.id} — ${a.name} (${a.title}): ${a.prestige} prestige${tagStr}`;
}).join("\n")}

YOUR RECENT ACTIONS:
${recentActions.slice(-5).map((a) => `- Tick ${a.tick}: ${a.action_type} → ${a.outcome}`).join("\n") || "None yet"}
${lockInNote}${leakSection}
AVAILABLE ACTIONS:
${availableActions.map((a) => `- ${a.type}${a.cost > 0 ? ` ($${a.cost})` : " (free)"}${a.requiresTarget ? " [requires target]" : ""}: ${a.description}`).join("\n")}

INSTRUCTIONS:
Choose ONE action based on your personality. Consider:
1. Your traits (aggression, greed, caution, loyalty)
2. Your current budget and prestige
3. Your relationships (allies, rivals)
4. Your quirk
5. Any status effects affecting you
6. Don't pile redundant statuses: if a manager above is already tagged
   with a status (e.g. MANDATORY MOTIVATION, DOCUMENTED, HIT THE WALL,
   MEETING BLOCKED, PROBLEMATIC, TECHNICAL DIFFICULTIES), an action that
   imposes that same status on them is wasted spend — pick a different
   target or a different action.

${agent.statusEffects.some((s) => s.type === "technical_difficulties") ? "WARNING: You have Technical Difficulties - you MUST choose 'shotgun_red_bull' this turn!" : ""}

Respond with ONLY a single JSON object — no prose, no code fences — matching this shape:
{
  "reasoning": "<2-3 sentences, in character>",
  "action": {"type": "<one of the action types above>", "target": "<id, only if the action requires a target>"}
}

Examples:
{"reasoning": "Per my spreadsheet analysis, investing in a consultant report will yield the highest ROI this quarter.", "action": {"type": "strategy_report"}}
{"reasoning": "Kevin has been undermining my initiatives. Time to take this to HR.", "action": {"type": "file_complaint", "target": "kevin"}}
`;
}

function parseAction(response: string, agent: Agent): { action: Action; reasoning: string } {
  try {
    const parsed = JSON.parse(response);
    if (parsed?.action?.type) {
      return {
        action: parsed.action as Action,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      };
    }
  } catch { /* fall through */ }
  console.warn(`Could not parse action for ${agent.name}, defaulting to work`);
  return { action: { type: "work" }, reasoning: "I'll just do my job." };
}

function humanizeActionType(type: string): string {
  return type.replace(/_/g, " ");
}

function corporateExcuse(action: Action, reason: string): string {
  const verb = humanizeActionType(action.type);
  const target = ("target" in action && action.target) ? action.target : "someone";

  switch (reason) {
    case "Invalid target":
      return invalidTargetExcuse(action, target);
    case "Insufficient funds":
      return `Tried to ${verb}, but the corporate card came back declined. I'll need to circle back next quarter, finance is being awful.`;
    case "Cannot target an ally with hostile action":
      return allyHostileExcuse(action, target);
    case "Action requires a target":
      return `Wanted to ${verb}, but apparently I forgot to loop in a stakeholder. Lesson learned, will sync offline.`;
    case "Technical difficulties - must rest":
      return `My laptop is, regrettably, bricked. IT says 8-12 weeks. I'll be working from notebook today.`;
    case "Under review - cannot book CEO time":
      return `Audit's still sniffing around my Q3 numbers. Best to keep my head down this cycle.`;
    case "Unknown action type":
      return `Had a transformational idea, but it was honestly a bit too disruptive for our risk profile. Maybe next quarter.`;
    case "Already acted this tick":
      return `Already filed three deliverables this morning, my bandwidth is genuinely Stretched. Need to recharge.`;
    default:
      return `Wanted to ${verb}${target !== "someone" ? " " + target : ""}, but ${reason.toLowerCase()}. Suboptimal.`;
  }
}

function invalidTargetExcuse(action: Action, target: string): string {
  switch (action.type) {
    case "take_credit":
      return `Was going to take credit for ${target}'s work, but couldn't find them on the org chart. Pretty sure they were quietly let go in the last reorg. RIP.`;
    case "schmooze":
      return `Tried to grab coffee with ${target} to subtly probe their alignment, but their Slack handle 404s. Probably riffed in the last reorg — saves me the small talk.`;
    case "file_complaint":
      return `Was going to file an HR complaint against ${target}, but apparently they don't exist on payroll anymore. Saved myself a meeting.`;
    case "sensitivity_training":
      return `Wanted to send ${target} to mandatory sensitivity training, but their email bounces. Reorg got there first.`;
    case "fix_laptop":
      return `Was going to have IT "fix" ${target}'s laptop, but they're not in the directory anymore. Honestly, probably for the best.`;
    case "calendar_conflict":
      return `Tried to book a calendar conflict for ${target}, but Outlook says no such employee. Suspiciously convenient.`;
    case "schedule_conflict":
      return `Was going to torpedo ${target}'s CEO meeting, but their calendar's been deleted. Either they're gone or they're hiding.`;
    case "poison_meeting":
      return `Was going to ask the Caterer to "season" ${target}'s meeting, but turns out their meetings have all been canceled. Strange.`;
    case "send_motivation":
      return `Wanted to send ${target} to a mandatory four-hour motivational seminar, but they're missing from the team page. Possibly let go. Possibly hiding.`;
    case "sabotage_plan":
      return `Was going to commission a sabotage plan against ${target}, but the Consultant said they couldn't find anyone by that name in the directory. Awkward call.`;
    case "recover_emails":
      return `Asked IT to recover ${target}'s emails, but their account was deactivated three reorgs ago. Should have asked sooner.`;
    case "accept_alliance":
    case "reject_alliance":
    case "break_alliance":
      return `Tried to formalize the alliance situation with ${target}, but apparently they're no longer with the company. Saves me the awkward 1:1.`;
    default:
      return `Was going to ${humanizeActionType(action.type)} ${target}, but couldn't find them on the org chart. RIP.`;
  }
}

function allyHostileExcuse(action: Action, target: string): string {
  switch (action.type) {
    case "file_complaint":
      return `Was about to file a complaint against ${target}, then remembered we have a strategic synergy partnership. Awkward. Tabled.`;
    case "sensitivity_training":
      return `Was going to send ${target} to sensitivity training, then realized we're allied. Now I might have to go to sensitivity training myself.`;
    case "fix_laptop":
      return `Was about to have IT mysteriously brick ${target}'s laptop, but we're allies. Let's call this a deferred opportunity.`;
    case "sabotage_plan":
      return `Was going to commission opposition research on ${target}, then remembered they're an ally. Filed the dossier in the desk drawer.`;
    case "calendar_conflict":
      return `Was going to triple-book ${target}'s morning, but we're aligned. Sent them a coffee invite instead.`;
    case "schedule_conflict":
      return `Was about to torpedo ${target}'s CEO meeting, but we're allies. Saved the move for someone less strategic.`;
    case "poison_meeting":
      return `Was about to compromise the Caterer for ${target}'s next meeting, but they're an ally. Reset to peaceful posture.`;
    case "send_motivation":
      return `Was going to send ${target} to a four-hour motivational seminar, but we're allies. Saving that one for later.`;
    default:
      return `Was about to ${humanizeActionType(action.type)} ${target}, then remembered we're in a strategic synergy partnership. Awkward.`;
  }
}

function validateAction(action: Action, agent: Agent, balance: number, allAgents: Agent[]): { valid: boolean; reason?: string } {
  const actionDef = ALL_ACTIONS.find((a) => a.type === action.type);
  if (!actionDef) return { valid: false, reason: "Unknown action type" };
  if (actionDef.cost > balance) return { valid: false, reason: "Insufficient funds" };
  if (actionDef.requiresTarget && !("target" in action)) return { valid: false, reason: "Action requires a target" };

  if ("target" in action) {
    const target = allAgents.find((a) => a.id === action.target);
    if (!target) return { valid: false, reason: "Invalid target" };
    if (action.target === agent.id) return { valid: false, reason: "Cannot target yourself" };

    const hostileActions = ["file_complaint", "sensitivity_training", "sabotage_plan", "fix_laptop", "calendar_conflict", "schedule_conflict", "poison_meeting", "send_motivation", "take_credit", "whistleblower_bounty"];
    if (hostileActions.includes(action.type) && agent.allies.includes(action.target)) {
      return { valid: false, reason: "Cannot target an ally with hostile action" };
    }

    // Under investigation: can't take a hostile action against the source.
    if (hostileActions.includes(action.type)) {
      const blockedSources = agent.statusEffects
        .filter((e) => e.type === "under_investigation" && e.source)
        .map((e) => e.source as string);
      if (blockedSources.includes(action.target)) {
        return { valid: false, reason: "Cannot retaliate against complainant while Under Investigation" };
      }
    }
  }

  if (agent.statusEffects.some((s) => s.type === "technical_difficulties") && action.type !== "shotgun_red_bull") {
    return { valid: false, reason: "Technical difficulties - must rest" };
  }

  if (action.type === "book_ceo_time" && agent.statusEffects.some((s) => s.type === "under_review")) {
    return { valid: false, reason: "Under review - cannot book CEO time" };
  }

  return { valid: true };
}

export async function getAgentDecision(
  deps: LlmDeps,
  agent: Agent,
  currentTick: number,
  tickCtx: TickCtx
): Promise<{ action: Action; reasoning: string }> {
  const persona = getPersona(agent.personaId);
  if (!persona) {
    return { action: { type: "work" }, reasoning: "No persona found" };
  }

  // Tick-wide context is pre-fetched once by processTick — reuse it instead
  // of re-querying per agent (this used to cost ~30 subrequests per tick and
  // pushed us over the per-invocation cap on heavy ticks).
  const balance = tickCtx.balances.get(agent.id) ?? 0;
  const allAgents = tickCtx.allAgents;
  const leakedEmails = tickCtx.leakedEmails;
  const recentActions = await deps.db.getAgentActionLogs(agent.id, Math.max(0, currentTick - 10), currentTick);

  // Stakeholder directive (set by the human adopter, always-open in retreat
  // mode). Injected high in the prompt as guidance the LLM should bias toward.
  const directive = await deps.db.getGameStateValue(`directive_${agent.id}`);
  const hailMaryUsed = (await deps.db.getGameStateValue(`hail_mary_used_${agent.id}`)) === "yes";
  const boomerangUsed = (await deps.db.getGameStateValue(`boomerang_used_${agent.id}`)) === "yes";
  const pulseSurveyUsed = (await deps.db.getGameStateValue(`pulse_survey_used_${agent.id}`)) === "yes";
  const joinMeetingCount = parseInt((await deps.db.getGameStateValue(`join_meeting_count_${agent.id}`)) ?? "0", 10);

  // Recent inbound attacks against this agent (used for the retaliation pull
  // in the prompt). Look back ~6 ticks ≈ 1 cycle.
  const inboundRaw = await deps.db.getRecentActionsTargetingAgent(agent.id, Math.max(0, currentTick - 6), 5);
  const recentAttackers = inboundRaw.map((row: any) => {
    const attacker = allAgents.find((a) => a.id === row.agent_id);
    return {
      attackerId: row.agent_id,
      attackerName: attacker?.name ?? row.agent_id,
      actionType: row.action_type,
      tick: row.tick,
    };
  });

  const mysteriousInfluenceClaimed = allAgents.some((a) =>
    a.statusEffects.some((s) => s.type === "mysterious_influence")
  );

  const context: DecisionContext = { agent, balance, currentTick, allAgents, recentActions, leakedEmails, directive, hailMaryUsed, boomerangUsed, pulseSurveyUsed, joinMeetingCount, recentAttackers, mysteriousInfluenceClaimed };

  const openai = new OpenAI({
    apiKey: deps.openaiApiKey,
    baseURL: deps.openaiBaseUrl,
    defaultHeaders: deps.cfAigToken
      ? { "cf-aig-authorization": `Bearer ${deps.cfAigToken}` }
      : undefined,
  });

  const systemPrompt = buildPersonaPrompt(persona);
  const userPrompt = buildContextPrompt(context);

  try {
    const response = await openai.chat.completions.create({
      model: "openai/gpt-5.5",
      max_completion_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { action: { type: "work" }, reasoning: "Empty response" };
    }

    const { action, reasoning } = parseAction(content, agent);

    const validation = validateAction(action, agent, balance, allAgents);
    if (!validation.valid) {
      console.log(`${agent.name}'s action invalid (${validation.reason}), defaulting to work`);
      return {
        action: { type: "work" },
        reasoning: corporateExcuse(action, validation.reason ?? "unknown"),
      };
    }

    return { action, reasoning };
  } catch (error) {
    console.error(`LLM error for ${agent.name}:`, error);
    return { action: { type: "work" }, reasoning: "LLM error, defaulting to work" };
  }
}
