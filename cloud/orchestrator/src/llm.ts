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
    model: "openai/gpt-5.4-mini",
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
  { type: "work", description: "Do actual work (+5 prestige, +$5 base salary, free)", cost: 0 },
  { type: "expense_report", description: "File an expense report (+$10 reimbursed; 20% chance Finance flags it for -5 prestige). Free, no skill required.", cost: 0 },
  { type: "rest", description: "Rest and recover (removes Hit the Wall, free)", cost: 0 },
  { type: "take_credit", description: "Attempt to claim credit for someone's work (50% success: +30 prestige, 50% fail: -20 prestige)", cost: 0, requiresTarget: true },

  { type: "schmooze", description: "Schmooze another manager — propose a cross-functional partnership (free)", cost: 0, requiresTarget: true },
  { type: "accept_alliance", description: "Accept a pending cross-functional partnership (+5 prestige to both)", cost: 0, requiresTarget: true },
  { type: "reject_alliance", description: "Reject a pending cross-functional partnership (proposer loses 10 prestige)", cost: 0, requiresTarget: true },
  { type: "break_alliance", description: "End a cross-functional partnership (-15 prestige for you; ex-partner gets Under Investigation 1 tick — can't retaliate immediately). Calculated nuke.", cost: 0, requiresTarget: true },

  // Underdog comeback paths — gated by prestige thresholds in the filter below.
  { type: "boomerang", description: "Quit and come back (free). Resets your prestige to 100, clears all status effects. Massive visual moment, one shot per game. Available only when prestige < 50.", cost: 0 },
  { type: "cry_in_stairwell", description: "Cry in the stairwell (free). Removes Problematic and Hit the Wall. 20% chance the VP sees and grants +20 sympathy prestige. Available only when prestige ≤ 30.", cost: 0 },
  { type: "hail_mary_idea", description: "Pitch a wild idea at the next all-hands (free). Lottery: 30% +50 prestige (CEO loved it), 50% +5 (polite nodding), 20% -5 (sounded unhinged). One use per game.", cost: 0 },

  // Passive accumulation — capped at 3 uses per game; 3rd use grants Mysterious Influence.
  { type: "join_meeting_silently", description: "Join a meeting and say nothing (free, +4 prestige). Do this 3 times in one game and you'll get a MYSTERIOUS INFLUENCE public tag — people start crediting you with things you didn't do.", cost: 0 },

  // === CHEAP PAID ($5 – $10) ===
  { type: "coffee_chat", description: "Casual coffee with target ($5; non-self). Both gain +3 prestige. No alliance proposed. Low-stakes networking.", cost: 5, requiresTarget: true },
  { type: "buy_coffee", description: "Buy coffee (removes Hit the Wall).", cost: 5 },
  { type: "spread_rumor", description: "Spread a rumor about target ($10). Target loses 5 prestige and gets QUESTIONABLE JUDGMENT public tag for 2 cycles. Cheap social warfare with real teeth.", cost: 10, requiresTarget: true },
  { type: "move_meeting_early", description: "Move target's meeting to 7:30am ($10). Target loses 5 prestige and becomes Hit the Wall. The room is freezing.", cost: 10, requiresTarget: true },

  // === MID PAID ($20 – $25) ===
  { type: "schedule_pre_meeting", description: "Schedule a pre-meeting for the meeting ($20). Target loses 15 prestige + gains MEETING BLOCKED. Loyal managers (loyalty > 70) are immune — they think this is normal.", cost: 20, requiresTarget: true },
  { type: "file_complaint", description: "File HR complaint (you +5 'diligence' prestige; target gets Under Investigation, can't retaliate against you for 1 tick)", cost: 22, requiresTarget: true },
  { type: "strategy_report", description: "Get consultant report (+35 prestige, gives Has Deliverable for a future +40 CEO meeting)", cost: 25 },
  { type: "leak_org_chart", description: "Insider intel — top 3 wealth + alliance graph + you gain +5 prestige (positional advantage)", cost: 25 },
  { type: "office_party", description: "Throw an office party ($25). +5 prestige to ALL managers and +15 to you. Generous play that visibly helps your rivals too.", cost: 25 },
  { type: "anonymous_pulse_survey", description: "Launch an 'anonymous' morale survey somehow entirely about the leader ($25). Target loses 50 prestige. Available only when YOU are rank ≥ 4 AND target is rank #1. One shot per game.", cost: 25, requiresTarget: true },

  // === EXPENSIVE ($30 – $50) ===
  { type: "sensitivity_training", description: "Send rival to sensitivity training (target -20 prestige + Problematic for 4 ticks: -3 prestige/tick decay)", cost: 30, requiresTarget: true },
  { type: "schedule_conflict", description: "Cancel target's CEO meeting (clears their Has Deliverable + Meeting-Blocked for 2 ticks)", cost: 30, requiresTarget: true },
  { type: "hostile_takeover", description: "Mount a hostile takeover of target's cross-functional partnerships ($35). Their existing partners become YOUR partners; target's partner list goes to zero. Mid-to-late game power move.", cost: 35, requiresTarget: true },
  { type: "sabotage_plan", description: "Build dossier on target (-10 prestige to target + 'Documented' for 2 ticks: any take_credit against them auto-succeeds). Setup play.", cost: 40, requiresTarget: true },
  { type: "book_ceo_time", description: "Meet with CEO (+40 prestige with Has Deliverable, -20 without; -10 if Meeting-Blocked)", cost: 50 },
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
}

function buildContextPrompt(ctx: DecisionContext): string {
  const { agent, balance, currentTick, allAgents, recentActions, leakedEmails, directive, hailMaryUsed, boomerangUsed, pulseSurveyUsed, joinMeetingCount } = ctx;
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
    if (action.type === "boomerang" && (agent.prestige >= 50 || boomerangUsed)) return false;
    if (action.type === "cry_in_stairwell" && agent.prestige > 30) return false;
    // Anonymous pulse survey: underdog tool, one-shot, target #1 only.
    // Per-agent gate here; per-target #1 check happens at execution.
    if (action.type === "anonymous_pulse_survey" && (currentRank < 4 || pulseSurveyUsed)) return false;
    // Join meeting silently caps at 3 uses per game; 3rd grants Mysterious Influence.
    if (action.type === "join_meeting_silently" && joinMeetingCount >= 3) return false;
    return true;
  });

  const statusDescriptions = agent.statusEffects.map((s) => {
    switch (s.type) {
      // Retreat renames: internal key stays stable; user-facing label is updated.
      case "tired": return "Hit the Wall (-2 prestige/tick decay; removed by coffee, rest, or cry_in_stairwell)";
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
      case "technical_difficulties": return "Technical Difficulties (legacy; forced to rest)";
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

  // Anti-pattern nudge: reasoning models lock onto a single action once
  // they've used it a few times. If an action shows up >=3x in the last 5,
  // drop a one-liner suggesting (not forcing) variety.
  const recentSlice = recentActions.slice(-5);
  const actionCounts = new Map<string, number>();
  for (const a of recentSlice) {
    actionCounts.set(a.action_type, (actionCounts.get(a.action_type) ?? 0) + 1);
  }
  let lockInNote = "";
  for (const [actionType, count] of actionCounts) {
    if (count >= 3) {
      lockInNote =
        `\nSTRATEGY NOTE: You've chosen '${actionType}' ${count} of your last ${recentSlice.length} cycles. That's a strong pattern. Your rivals likely see it too — consider whether your default move is still the optimal one this cycle, or whether varying your approach would catch them off-guard. (Sticking with it is fine if it's still right; just don't pick it on autopilot.)\n`;
      break;
    }
  }

  const directiveSection = directive
    ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STAKEHOLDER NOTE (from your real-world adopter):

  "${directive.replace(/"/g, '\\"')}"

This is one input among many — alongside your personality, current
standing, budget, allies, and what's actually working. If pursuing
this guidance is costing you significant prestige, breaking your
alliances, or repeatedly failing (e.g. several missed take_credits
in a row, or attacks landing for less than they cost), your
stakeholder would rather you adapt than mechanically obey. You're
a corporate manager, not a robot. Show judgment.
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

  return `${directiveSection}${positionalNudge}
CURRENT SITUATION (Tick ${currentTick}):

YOUR STATUS:
- Prestige: ${agent.prestige} (Rank #${rank} of ${allAgents.length})
- Budget: $${balance.toFixed(2)} DLBR
- Status Effects: ${statusDescriptions.length > 0 ? statusDescriptions.join(", ") : "None"}
- Allies: ${agent.allies.length > 0 ? agent.allies.map((id) => allAgents.find((a) => a.id === id)?.name).join(", ") : "None"}
${agent.pendingAlliance ? `- PENDING ALLIANCE: ${allAgents.find((a) => a.id === agent.pendingAlliance)?.name} wants to ally with you` : ""}

OTHER MANAGERS (use the id in lowercase as "target" in action JSON):
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
   with a status (e.g. MANDATORY MOTIVATION, MARKED, TIRED, MEETING
   BLOCKED, PROBLEMATIC, TECHNICAL DIFFICULTIES), an action that imposes
   that same status on them is wasted spend — pick a different target
   or a different action.

${agent.statusEffects.some((s) => s.type === "technical_difficulties") ? "WARNING: You have Technical Difficulties - you MUST choose 'rest' this turn!" : ""}

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

  if (agent.statusEffects.some((s) => s.type === "technical_difficulties") && action.type !== "rest") {
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

  const context: DecisionContext = { agent, balance, currentTick, allAgents, recentActions, leakedEmails, directive, hailMaryUsed, boomerangUsed, pulseSurveyUsed, joinMeetingCount };

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
      model: "openai/gpt-5.4-mini",
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
