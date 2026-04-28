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

const ALL_ACTIONS = [
  { type: "work", description: "Do actual work (+5 prestige, free)", cost: 0 },
  { type: "rest", description: "Rest and recover (removes Tired debuff, free)", cost: 0 },
  { type: "schmooze", description: "Build relationship with another manager (may form alliance)", cost: 0, requiresTarget: true },
  { type: "take_credit", description: "Attempt to claim credit for someone's work (40% success: +30 prestige, 60% fail: -20 prestige)", cost: 0, requiresTarget: true },

  { type: "accept_alliance", description: "Accept a pending alliance proposal (+5 prestige to both)", cost: 0, requiresTarget: true },
  { type: "reject_alliance", description: "Reject a pending alliance proposal (proposer loses 10 prestige)", cost: 0, requiresTarget: true },
  { type: "break_alliance", description: "Betray an ally (-30 prestige for you, +15 for them)", cost: 0, requiresTarget: true },

  { type: "buy_coffee", description: "Buy coffee (removes Tired)", cost: 8 },
  { type: "buy_fancy_coffee", description: "Buy fancy coffee (Caffeinated for 2 ticks; immune to Tired)", cost: 15 },
  { type: "file_complaint", description: "File HR complaint (target gets Under Investigation; can't retaliate against you for 1 tick)", cost: 22, requiresTarget: true },
  { type: "sensitivity_training", description: "Send rival to sensitivity training (target -20 prestige + Problematic for 4 ticks: -3 prestige/tick decay)", cost: 30, requiresTarget: true },
  { type: "check_hr_status", description: "See who has filed complaints against you", cost: 5 },
  { type: "strategy_report", description: "Get consultant report (+25 prestige, gives Deliverable; halved after a New Initiative pivot)", cost: 35 },
  { type: "competitive_intel", description: "Learn top 3 agents' last action", cost: 25 },
  { type: "sabotage_plan", description: "Get dirt on a target (reveals their last 3 actions; -3 prestige to target)", cost: 40, requiresTarget: true },
  { type: "fix_laptop", description: "Sabotage target's laptop (they're forced to rest next tick)", cost: 18, requiresTarget: true },
  { type: "recover_emails", description: "See target's last 3 actions (no other effect)", cost: 20, requiresTarget: true },
  { type: "calendar_conflict", description: "Triple-book target's calendar (clears their Deliverable + pending alliance offer)", cost: 15, requiresTarget: true },
  { type: "book_ceo_time", description: "Meet with CEO (+40 prestige with Deliverable, -20 without; -10 if Meeting-Blocked)", cost: 50 },
  { type: "leak_org_chart", description: "Insider intel — top 3 wealth ranking + active alliance graph", cost: 25 },
  { type: "schedule_conflict", description: "Cancel target's CEO meeting (clears their Deliverable + Meeting-Blocked for 2 ticks)", cost: 30, requiresTarget: true },
  { type: "team_lunch", description: "Host team lunch (+15 prestige; only one host per cycle)", cost: 25 },
  { type: "poison_meeting", description: "Sabotage target's catered meeting (target -10 prestige)", cost: 35, requiresTarget: true },
  { type: "birthday_cake", description: "Bring cake (+5 prestige, removes own Problematic)", cost: 12 },
  { type: "book_motivation", description: "Attend motivation session (+20 prestige, Inspired for 2 ticks: +5/tick)", cost: 30 },
  { type: "send_motivation", description: "Send rival to mandatory motivation (target forced to rest for 2 ticks)", cost: 35, requiresTarget: true },

  // Earning paths (Phase 5)
  { type: "whistleblower_bounty", description: "Report target to HR ($10 cost). If target had hostile actions in last 3 ticks → +30 prestige + $25 bounty. If false → -10 prestige; target +5 sympathy.", cost: 10, requiresTarget: true },
  { type: "mentorship", description: "Mentor target ($15 cost; non-self target). Self +5 prestige + $30 stipend; target +10 prestige. Wholesome alternative to take_credit.", cost: 15, requiresTarget: true },
  { type: "coffee_chat", description: "Casual coffee with target ($5; non-self). Both gain +3 prestige. No alliance proposed. Low-stakes networking.", cost: 5, requiresTarget: true },
];

interface DecisionContext {
  agent: Agent;
  balance: number;
  currentTick: number;
  allAgents: Agent[];
  recentActions: any[];
  leakedEmails: Array<{ fromAgent: string; toAgent: string; subject: string; body: string }>;
}

function buildContextPrompt(ctx: DecisionContext): string {
  const { agent, balance, currentTick, allAgents, recentActions, leakedEmails } = ctx;

  const otherAgents = allAgents
    .filter((a) => a.id !== agent.id)
    .map((a) => ({
      id: a.id,
      name: a.name,
      title: a.title,
      prestige: a.prestige,
      isAlly: agent.allies.includes(a.id),
      isRival: false,
    }));

  const availableActions = ALL_ACTIONS.filter((action) => {
    if (action.cost > balance) return false;
    if (action.type === "accept_alliance" && !agent.pendingAlliance) return false;
    if (action.type === "reject_alliance" && !agent.pendingAlliance) return false;
    if (action.type === "break_alliance" && agent.allies.length === 0) return false;
    return true;
  });

  const statusDescriptions = agent.statusEffects.map((s) => {
    switch (s.type) {
      case "tired": return "Tired (-2 prestige/tick decay; removed by coffee or rest)";
      case "caffeinated": return `Caffeinated (immune to Tired; expires tick ${s.expiresAtTick})`;
      case "inspired": return `Inspired (+5 prestige/tick; expires tick ${s.expiresAtTick})`;
      case "under_investigation": return `Under Investigation (can't take hostile action against ${s.source}; expires tick ${s.expiresAtTick})`;
      case "problematic": return `Problematic (-3 prestige/tick decay; expires tick ${s.expiresAtTick} — or removed by bringing birthday cake)`;
      case "under_review": return `Under Review (can't book CEO time; expires tick ${s.expiresAtTick})`;
      case "technical_difficulties": return "Technical Difficulties (forced to rest this cycle)";
      case "has_deliverable": return "Has Deliverable (CEO meeting will succeed and award +40)";
      case "mandatory_motivation": return "Stuck in Mandatory Motivation (forced to rest)";
      case "meeting_blocked": return `Meeting-Blocked (can't book CEO time; expires tick ${s.expiresAtTick})`;
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

  return `
CURRENT SITUATION (Tick ${currentTick}):

YOUR STATUS:
- Prestige: ${agent.prestige} (Rank #${allAgents.findIndex((a) => a.id === agent.id) + 1} of ${allAgents.length})
- Budget: $${balance.toFixed(2)} DLBR
- Status Effects: ${statusDescriptions.length > 0 ? statusDescriptions.join(", ") : "None"}
- Allies: ${agent.allies.length > 0 ? agent.allies.map((id) => allAgents.find((a) => a.id === id)?.name).join(", ") : "None"}
${agent.pendingAlliance ? `- PENDING ALLIANCE: ${allAgents.find((a) => a.id === agent.pendingAlliance)?.name} wants to ally with you` : ""}

OTHER MANAGERS (use the id in lowercase as "target" in action JSON):
${otherAgents.map((a) => `- id: ${a.id} — ${a.name} (${a.title}): ${a.prestige} prestige${a.isAlly ? " [ALLY]" : ""}`).join("\n")}

YOUR RECENT ACTIONS:
${recentActions.slice(-5).map((a) => `- Tick ${a.tick}: ${a.action_type} → ${a.outcome}`).join("\n") || "None yet"}
${leakSection}
AVAILABLE ACTIONS:
${availableActions.map((a) => `- ${a.type}${a.cost > 0 ? ` ($${a.cost})` : " (free)"}${a.requiresTarget ? " [requires target]" : ""}: ${a.description}`).join("\n")}

INSTRUCTIONS:
Choose ONE action based on your personality. Consider:
1. Your traits (aggression, greed, caution, loyalty)
2. Your current budget and prestige
3. Your relationships (allies, rivals)
4. Your quirk
5. Any status effects affecting you

${agent.statusEffects.some((s) => s.type === "technical_difficulties") ? "WARNING: You have Technical Difficulties - you MUST choose 'rest' this turn!" : ""}

Respond with:
1. Brief reasoning (2-3 sentences, in character)
2. Your chosen action as JSON

Example response:
"Per my spreadsheet analysis, investing in a consultant report will yield the highest ROI this quarter. The data clearly supports this decision."

ACTION: {"type": "strategy_report"}

Or with a target:
"Kevin has been undermining my initiatives. Time to take this to HR."

ACTION: {"type": "file_complaint", "target": "kevin"}
`;
}

function parseAction(response: string, agent: Agent): { action: Action; reasoning: string } {
  const actionMatch = response.match(/ACTION:\s*(\{[^}]+\})/i);
  const reasoning = response.split(/ACTION:/i)[0].trim();

  if (!actionMatch) {
    console.warn(`Could not parse action for ${agent.name}, defaulting to work`);
    return { action: { type: "work" }, reasoning: reasoning || "I'll just do my job." };
  }

  try {
    const parsed = JSON.parse(actionMatch[1]);
    return { action: parsed as Action, reasoning };
  } catch {
    console.warn(`Invalid JSON for ${agent.name}, defaulting to work`);
    return { action: { type: "work" }, reasoning: reasoning || "I'll just do my job." };
  }
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
  currentTick: number
): Promise<{ action: Action; reasoning: string }> {
  const persona = getPersona(agent.personaId);
  if (!persona) {
    return { action: { type: "work" }, reasoning: "No persona found" };
  }

  const balance = await deps.stellar.getAssetBalance(agent.publicKey);
  const allAgents = await deps.db.getAllAgents();
  const recentActions = await deps.db.getAgentActionLogs(agent.id, Math.max(0, currentTick - 10), currentTick);
  const leakedEmails = await deps.db.getRecentLeakedEmails(5);

  const context: DecisionContext = { agent, balance, currentTick, allAgents, recentActions, leakedEmails };

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
