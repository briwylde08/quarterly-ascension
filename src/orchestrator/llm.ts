import OpenAI from "openai";
import { Agent, Action, StatusEffect } from "../lib/types.js";
import { buildPersonaPrompt, getPersona } from "../agents/personas.js";
import { getAssetBalance } from "../lib/stellar.js";
import { getActionPrice, isPaidAction } from "../lib/mpp-client.js";
import { getAllAgents, getAgentActionLogs } from "../lib/db.js";

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  defaultHeaders: process.env.CF_AIG_TOKEN
    ? { "cf-aig-authorization": `Bearer ${process.env.CF_AIG_TOKEN}` }
    : undefined,
});

// All possible actions
const ALL_ACTIONS = [
  // Free actions
  { type: "work", description: "Do actual work (+5 prestige, free)", cost: 0 },
  { type: "rest", description: "Rest and recover (removes Tired debuff, free)", cost: 0 },
  { type: "schmooze", description: "Build relationship with another manager (may form alliance)", cost: 0, requiresTarget: true },
  { type: "take_credit", description: "Attempt to claim credit for someone's work (40% success: +30 prestige, 60% fail: -20 prestige)", cost: 0, requiresTarget: true },

  // Alliance actions
  { type: "accept_alliance", description: "Accept a pending alliance proposal", cost: 0, requiresTarget: true },
  { type: "reject_alliance", description: "Reject a pending alliance proposal (proposer loses 10 prestige)", cost: 0, requiresTarget: true },
  { type: "break_alliance", description: "Betray an ally (-30 prestige for you, +15 for them)", cost: 0, requiresTarget: true },

  // Paid actions
  { type: "buy_coffee", description: "Buy coffee (+1 productivity, removes Tired)", cost: 8 },
  { type: "buy_fancy_coffee", description: "Buy fancy coffee (Caffeinated for 2 ticks)", cost: 15 },
  { type: "file_complaint", description: "File HR complaint (target skips 1 action)", cost: 22, requiresTarget: true },
  { type: "sensitivity_training", description: "Send rival to sensitivity training (-20 prestige, Problematic status)", cost: 30, requiresTarget: true },
  { type: "check_hr_status", description: "Check if anyone filed against you", cost: 5 },
  { type: "strategy_report", description: "Get consultant report (+25 prestige, gives Deliverable)", cost: 35 },
  { type: "competitive_intel", description: "Learn top 3 agents' recent actions", cost: 25 },
  { type: "sabotage_plan", description: "Get dirt on a specific target", cost: 40, requiresTarget: true },
  { type: "fix_laptop", description: "Sabotage target's laptop (they skip 1 action)", cost: 18, requiresTarget: true },
  { type: "recover_emails", description: "See target's last 3 actions", cost: 20, requiresTarget: true },
  { type: "calendar_conflict", description: "Target's next meeting fails", cost: 15, requiresTarget: true },
  { type: "book_ceo_time", description: "Meet with CEO (+40 prestige if you have Deliverable, -20 if not)", cost: 50 },
  { type: "leak_org_chart", description: "Get insider info about upcoming changes", cost: 25 },
  { type: "schedule_conflict", description: "Cancel target's CEO meeting", cost: 30, requiresTarget: true },
  { type: "team_lunch", description: "Host team lunch (+15 prestige, may form alliance)", cost: 25 },
  { type: "poison_meeting", description: "Ruin target's meeting (-10 prestige for them)", cost: 35, requiresTarget: true },
  { type: "birthday_cake", description: "Bring cake (+5 prestige, removes Problematic)", cost: 12 },
  { type: "book_motivation", description: "Attend motivation session (+20 prestige, Inspired for 2 ticks)", cost: 30 },
  { type: "send_motivation", description: "Send rival to mandatory motivation (wastes their next 2 actions)", cost: 35, requiresTarget: true },
];

interface DecisionContext {
  agent: Agent;
  balance: number;
  currentTick: number;
  allAgents: Agent[];
  recentActions: any[];
}

/**
 * Build the context prompt for an agent's decision
 */
function buildContextPrompt(ctx: DecisionContext): string {
  const { agent, balance, currentTick, allAgents, recentActions } = ctx;

  // Get other agents info (limited view)
  const otherAgents = allAgents
    .filter((a) => a.id !== agent.id)
    .map((a) => ({
      name: a.name,
      title: a.title,
      prestige: a.prestige,
      isAlly: agent.allies.includes(a.id),
      isRival: false, // Could track this
    }));

  // Get available actions based on current state
  const availableActions = ALL_ACTIONS.filter((action) => {
    // Can't afford paid actions
    if (action.cost > balance) return false;

    // Alliance-specific actions
    if (action.type === "accept_alliance" && !agent.pendingAlliance) return false;
    if (action.type === "reject_alliance" && !agent.pendingAlliance) return false;
    if (action.type === "break_alliance" && agent.allies.length === 0) return false;

    // Can't target allies with hostile actions if we have any
    // (We'll validate specific targets later)

    return true;
  });

  // Status effect descriptions
  const statusDescriptions = agent.statusEffects.map((s) => {
    switch (s.type) {
      case "tired": return "Tired (actions cost +$5, removed by coffee or rest)";
      case "caffeinated": return `Caffeinated (immune to Tired, expires tick ${s.expiresAtTick})`;
      case "inspired": return `Inspired (+5 prestige/tick, expires tick ${s.expiresAtTick})`;
      case "under_investigation": return `Under Investigation (can't attack ${s.source}, expires tick ${s.expiresAtTick})`;
      case "problematic": return "Problematic (-10% prestige gains, removed by birthday cake)";
      case "under_review": return `Under Review (can't book CEO time, expires tick ${s.expiresAtTick})`;
      case "technical_difficulties": return "Technical Difficulties (skip this action!)";
      case "has_deliverable": return "Has Deliverable (CEO meeting will succeed)";
      default: return s.type;
    }
  });

  return `
CURRENT SITUATION (Tick ${currentTick}):

YOUR STATUS:
- Prestige: ${agent.prestige} (Rank #${allAgents.findIndex((a) => a.id === agent.id) + 1} of ${allAgents.length})
- Budget: $${balance.toFixed(2)} DLBR
- Status Effects: ${statusDescriptions.length > 0 ? statusDescriptions.join(", ") : "None"}
- Allies: ${agent.allies.length > 0 ? agent.allies.map((id) => allAgents.find((a) => a.id === id)?.name).join(", ") : "None"}
${agent.pendingAlliance ? `- PENDING ALLIANCE: ${allAgents.find((a) => a.id === agent.pendingAlliance)?.name} wants to ally with you` : ""}

OTHER MANAGERS:
${otherAgents.map((a) => `- ${a.name} (${a.title}): ${a.prestige} prestige${a.isAlly ? " [ALLY]" : ""}`).join("\n")}

YOUR RECENT ACTIONS:
${recentActions.slice(-5).map((a) => `- Tick ${a.tick}: ${a.action_type} → ${a.outcome}`).join("\n") || "None yet"}

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

/**
 * Parse the LLM response into an Action
 */
function parseAction(response: string, agent: Agent): { action: Action; reasoning: string } {
  // Extract reasoning (everything before ACTION:)
  const actionMatch = response.match(/ACTION:\s*(\{[^}]+\})/i);
  const reasoning = response.split(/ACTION:/i)[0].trim();

  if (!actionMatch) {
    // Default to work if we can't parse
    console.warn(`Could not parse action for ${agent.name}, defaulting to work`);
    return { action: { type: "work" }, reasoning: reasoning || "I'll just do my job." };
  }

  try {
    const parsed = JSON.parse(actionMatch[1]);
    return { action: parsed as Action, reasoning };
  } catch (e) {
    console.warn(`Invalid JSON for ${agent.name}, defaulting to work`);
    return { action: { type: "work" }, reasoning: reasoning || "I'll just do my job." };
  }
}

/**
 * Validate an action is legal for this agent
 */
function validateAction(action: Action, agent: Agent, balance: number, allAgents: Agent[]): { valid: boolean; reason?: string } {
  const actionDef = ALL_ACTIONS.find((a) => a.type === action.type);
  if (!actionDef) {
    return { valid: false, reason: "Unknown action type" };
  }

  // Check cost
  if (actionDef.cost > balance) {
    return { valid: false, reason: "Insufficient funds" };
  }

  // Check if action requires target
  if (actionDef.requiresTarget && !("target" in action)) {
    return { valid: false, reason: "Action requires a target" };
  }

  // Validate target exists
  if ("target" in action) {
    const target = allAgents.find((a) => a.id === action.target);
    if (!target) {
      return { valid: false, reason: "Invalid target" };
    }

    // Can't target allies with hostile actions
    const hostileActions = ["file_complaint", "sensitivity_training", "sabotage_plan", "fix_laptop", "calendar_conflict", "schedule_conflict", "poison_meeting", "send_motivation"];
    if (hostileActions.includes(action.type) && agent.allies.includes(action.target)) {
      return { valid: false, reason: "Cannot target an ally with hostile action" };
    }
  }

  // Check technical difficulties
  if (agent.statusEffects.some((s) => s.type === "technical_difficulties") && action.type !== "rest") {
    return { valid: false, reason: "Technical difficulties - must rest" };
  }

  // Check under review for CEO time
  if (action.type === "book_ceo_time" && agent.statusEffects.some((s) => s.type === "under_review")) {
    return { valid: false, reason: "Under review - cannot book CEO time" };
  }

  return { valid: true };
}

/**
 * Get a decision from the LLM for an agent
 */
export async function getAgentDecision(
  agent: Agent,
  currentTick: number
): Promise<{ action: Action; reasoning: string }> {
  const persona = getPersona(agent.personaId);
  if (!persona) {
    return { action: { type: "work" }, reasoning: "No persona found" };
  }

  // Get current balance
  const balance = await getAssetBalance(agent.publicKey);

  // Get all agents for context
  const allAgents = getAllAgents();

  // Get recent actions
  const recentActions = getAgentActionLogs(agent.id, Math.max(0, currentTick - 10), currentTick);

  const context: DecisionContext = {
    agent,
    balance,
    currentTick,
    allAgents,
    recentActions,
  };

  const systemPrompt = buildPersonaPrompt(persona);
  const userPrompt = buildContextPrompt(context);

  try {
    const response = await openai.chat.completions.create({
      model: "openai/gpt-5.5",
      max_completion_tokens: 500,
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

    // Validate the action
    const validation = validateAction(action, agent, balance, allAgents);
    if (!validation.valid) {
      console.log(`${agent.name}'s action invalid (${validation.reason}), defaulting to work`);
      return { action: { type: "work" }, reasoning: `Wanted to ${action.type} but: ${validation.reason}` };
    }

    return { action, reasoning };
  } catch (error) {
    console.error(`LLM error for ${agent.name}:`, error);
    return { action: { type: "work" }, reasoning: "LLM error, defaulting to work" };
  }
}
