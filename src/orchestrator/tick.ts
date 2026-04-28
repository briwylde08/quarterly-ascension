import { v4 as uuid } from "uuid";
import { Agent, Action, GameEvent, StatusEffect } from "../lib/types.js";
import { Keypair } from "@stellar/stellar-sdk";
import { getAssetBalance } from "../lib/stellar.js";
import {
  getAllAgents,
  getAgent,
  saveAgent,
  updateAgentPrestige,
  updateAgentStatusEffects,
  updateAgentAllies,
  updateAgentPendingAlliance,
  saveEvent,
  logAction,
  getCurrentTick,
  setCurrentTick,
} from "../lib/db.js";
import { callPaidService, SERVICE_URLS, isPaidAction } from "../lib/mpp-client.js";
import { getAgentDecision } from "./llm.js";
import { processRandomEvents } from "./random-events.js";

// Callbacks for real-time updates
type EventCallback = (event: GameEvent) => void;
const eventCallbacks: EventCallback[] = [];

export function onGameEvent(callback: EventCallback): void {
  eventCallbacks.push(callback);
}

function emitEvent(event: GameEvent): void {
  saveEvent(event);
  for (const callback of eventCallbacks) {
    callback(event);
  }
}

function createEventId(): string {
  return uuid();
}

/**
 * Process a single tick of the game
 */
export async function processTick(): Promise<void> {
  const tick = getCurrentTick() + 1;
  setCurrentTick(tick);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`TICK ${tick} STARTING`);
  console.log(`${"=".repeat(60)}\n`);

  // Phase 1: Expire status effects
  await processStatusEffects(tick);

  // Phase 2: Process random events
  const randomEvents = await processRandomEvents(tick);
  for (const event of randomEvents) {
    emitEvent(event);
  }

  // Phase 3: Get decisions for all agents
  const agents = getAllAgents();
  const decisions: { agent: Agent; action: Action; reasoning: string }[] = [];

  for (const agent of agents) {
    // Skip agents with technical difficulties (they must rest)
    if (agent.statusEffects.some((s) => s.type === "technical_difficulties")) {
      decisions.push({
        agent,
        action: { type: "rest" },
        reasoning: "Technical difficulties - forced to rest",
      });
      continue;
    }

    // Skip agents in mandatory motivation
    if (agent.statusEffects.some((s) => s.type === "mandatory_motivation" as any)) {
      decisions.push({
        agent,
        action: { type: "rest" },
        reasoning: "Stuck in mandatory motivation session",
      });
      continue;
    }

    const { action, reasoning } = await getAgentDecision(agent, tick);
    decisions.push({ agent, action, reasoning });

    console.log(`${agent.name}: ${action.type}${("target" in action) ? ` → ${action.target}` : ""}`);
  }

  // Phase 4: Execute decisions
  // Some actions are tick-singletons — only one agent can do them per tick.
  // (E.g. there is one Caterer in the office; you can't both host the team
  // lunch.) Subsequent attempts get rerouted to work with explanatory flavor.
  const SINGLETON_ACTIONS = new Set(["team_lunch"]);
  const consumedSingletons = new Set<string>();

  for (const { agent, action, reasoning } of decisions) {
    let effectiveAction = action;
    let effectiveReasoning = reasoning;

    if (SINGLETON_ACTIONS.has(action.type)) {
      if (consumedSingletons.has(action.type)) {
        effectiveAction = { type: "work" };
        effectiveReasoning =
          `(Wanted to ${action.type} but the Caterer was already booked by another manager this tick — fell back to work.) ${reasoning}`;
      } else {
        consumedSingletons.add(action.type);
      }
    }

    await executeAction(agent, effectiveAction, effectiveReasoning, tick);
  }

  // Phase 5: Update inspired agents (+5 prestige)
  for (const agent of getAllAgents()) {
    if (agent.statusEffects.some((s) => s.type === "inspired" && s.expiresAtTick > tick)) {
      updateAgentPrestige(agent.id, 5);
      emitEvent({
        id: createEventId(),
        tick,
        timestamp: new Date(),
        type: "status_effect",
        agentId: agent.id,
        description: `${agent.name} gains +5 prestige from Inspired status`,
        prestigeChange: 5,
      });
    }
  }

  console.log(`\nTick ${tick} complete.\n`);
}

/**
 * Expire old status effects
 */
async function processStatusEffects(tick: number): Promise<void> {
  const agents = getAllAgents();

  for (const agent of agents) {
    const updatedEffects = agent.statusEffects.filter((effect) => {
      // Remove effects that have expired
      if (effect.expiresAtTick && effect.expiresAtTick <= tick) {
        console.log(`${agent.name}: ${effect.type} expired`);
        return false;
      }
      return true;
    });

    if (updatedEffects.length !== agent.statusEffects.length) {
      updateAgentStatusEffects(agent.id, updatedEffects);
    }
  }
}

/**
 * Execute an agent's action
 */
async function executeAction(
  agent: Agent,
  action: Action,
  reasoning: string,
  tick: number
): Promise<void> {
  let outcome = "";
  let prestigeChange = 0;
  let txHash: string | undefined;

  try {
    switch (action.type) {
      // Free actions
      case "work":
        prestigeChange = 5;
        outcome = "Did actual work";
        updateAgentPrestige(agent.id, prestigeChange);
        break;

      case "rest":
        outcome = "Rested";
        // Remove tired effect if present
        const agentData = getAgent(agent.id)!;
        const newEffects = agentData.statusEffects.filter((e) => e.type !== "tired");
        updateAgentStatusEffects(agent.id, newEffects);
        break;

      case "schmooze":
        if ("target" in action) {
          outcome = await handleSchmooze(agent, action.target, tick, reasoning);
        }
        break;

      case "take_credit":
        if ("target" in action) {
          const success = Math.random() < 0.4;
          if (success) {
            prestigeChange = 30;
            outcome = `Successfully took credit for ${action.target}'s work`;
          } else {
            prestigeChange = -20;
            outcome = `Failed to take credit - ${action.target} had receipts`;
          }
          updateAgentPrestige(agent.id, prestigeChange);
        }
        break;

      case "accept_alliance":
        if ("target" in action && agent.pendingAlliance === action.target) {
          outcome = await handleAllianceAccept(agent, action.target, tick, reasoning);
          prestigeChange = 5;
        }
        break;

      case "reject_alliance":
        if ("target" in action && agent.pendingAlliance === action.target) {
          outcome = await handleAllianceReject(agent, action.target, tick, reasoning);
        }
        break;

      case "break_alliance":
        if ("target" in action && agent.allies.includes(action.target)) {
          outcome = await handleAllianceBreak(agent, action.target, tick, reasoning);
          prestigeChange = -30;
        }
        break;

      // Paid actions
      default:
        if (isPaidAction(action.type)) {
          const result = await executePaidAction(agent, action, tick, reasoning);
          outcome = result.outcome;
          prestigeChange = result.prestigeChange;
          txHash = result.txHash;
        } else {
          outcome = "Unknown action";
        }
    }
  } catch (error) {
    outcome = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
  }

  // Log the action
  logAction(tick, agent.id, action.type, action, reasoning, outcome, prestigeChange, txHash);

  // Some actions are resolved by handlers that emit their own specifically-typed
  // events (alliance_formed, alliance_rejected, alliance_broken). For those,
  // suppress this generic outer event to avoid showing the same beat twice
  // in the feed.
  const HANDLER_EMITS_OWN: Set<Action["type"]> = new Set([
    "accept_alliance",
    "reject_alliance",
    "break_alliance",
  ]);
  if (HANDLER_EMITS_OWN.has(action.type)) return;

  // Emit event
  emitEvent({
    id: createEventId(),
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

/**
 * Execute a paid action via MPP
 */
async function executePaidAction(
  agent: Agent,
  action: Action,
  tick: number,
  reasoning?: string
): Promise<{ outcome: string; prestigeChange: number; txHash?: string }> {
  const serviceInfo = SERVICE_URLS[action.type];
  if (!serviceInfo) {
    return { outcome: "Unknown paid action", prestigeChange: 0 };
  }

  const keypair = Keypair.fromSecret(agent.secretKey);
  const body = "target" in action ? { target: action.target } : undefined;

  const result = await callPaidService(
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
    return {
      outcome: `Failed: ${result.error}`,
      prestigeChange: 0,
    };
  }

  // Process the result based on action type
  let prestigeChange = 0;
  let outcome = "";

  switch (action.type) {
    case "buy_coffee":
      outcome = "Bought coffee - productivity boosted";
      // Remove tired effect
      const agent1 = getAgent(agent.id)!;
      updateAgentStatusEffects(agent.id, agent1.statusEffects.filter((e) => e.type !== "tired"));
      break;

    case "buy_fancy_coffee":
      outcome = "Bought fancy coffee - feeling caffeinated";
      const agent2 = getAgent(agent.id)!;
      const newEffects2: StatusEffect[] = [
        ...agent2.statusEffects.filter((e) => e.type !== "tired" && e.type !== "caffeinated"),
        { type: "caffeinated", expiresAtTick: tick + 2 },
      ];
      updateAgentStatusEffects(agent.id, newEffects2);
      break;

    case "file_complaint":
      if ("target" in action) {
        outcome = `Filed HR complaint against ${action.target}`;
        const target = getAgent(action.target);
        if (target) {
          const targetEffects: StatusEffect[] = [
            ...target.statusEffects,
            { type: "under_investigation", expiresAtTick: tick + 1, source: agent.id },
          ];
          updateAgentStatusEffects(action.target, targetEffects);
        }
      }
      break;

    case "sensitivity_training":
      if ("target" in action) {
        outcome = `Sent ${action.target} to sensitivity training`;
        const target = getAgent(action.target);
        if (target) {
          updateAgentPrestige(action.target, -20);
          const targetEffects: StatusEffect[] = [
            ...target.statusEffects,
            { type: "problematic", expiresAtTick: 999, source: agent.id },
          ];
          updateAgentStatusEffects(action.target, targetEffects);
        }
      }
      break;

    case "strategy_report":
      prestigeChange = 25;
      outcome = `Received consultant report: "${result.data?.deliverable?.title || "Strategic Document"}"`;
      updateAgentPrestige(agent.id, prestigeChange);
      const agent3 = getAgent(agent.id)!;
      updateAgentStatusEffects(agent.id, [...agent3.statusEffects, { type: "has_deliverable", expiresAtTick: 999 }]);
      break;

    case "fix_laptop":
      if ("target" in action) {
        outcome = `Sabotaged ${action.target}'s laptop`;
        const target = getAgent(action.target);
        if (target) {
          const targetEffects: StatusEffect[] = [
            ...target.statusEffects,
            { type: "technical_difficulties", expiresAtTick: tick + 1, source: agent.id },
          ];
          updateAgentStatusEffects(action.target, targetEffects);
        }
      }
      break;

    case "book_ceo_time":
      const agentData = getAgent(agent.id)!;
      const hasDeliverable = agentData.statusEffects.some((e) => e.type === "has_deliverable");
      if (hasDeliverable) {
        prestigeChange = 40;
        outcome = "CEO meeting successful - impressed with deliverable";
        // Remove deliverable
        updateAgentStatusEffects(agent.id, agentData.statusEffects.filter((e) => e.type !== "has_deliverable"));
      } else {
        prestigeChange = -20;
        outcome = "CEO meeting awkward - had nothing to present";
      }
      updateAgentPrestige(agent.id, prestigeChange);
      break;

    case "team_lunch":
      prestigeChange = 15;
      outcome = "Hosted team lunch - everyone appreciated the free food";
      updateAgentPrestige(agent.id, prestigeChange);
      break;

    case "birthday_cake":
      prestigeChange = 5;
      outcome = "Brought birthday cake - removed Problematic status";
      updateAgentPrestige(agent.id, prestigeChange);
      const agent4 = getAgent(agent.id)!;
      updateAgentStatusEffects(agent.id, agent4.statusEffects.filter((e) => e.type !== "problematic"));
      break;

    case "book_motivation":
      prestigeChange = 20;
      outcome = "Attended motivation session - feeling inspired";
      updateAgentPrestige(agent.id, prestigeChange);
      const agent5 = getAgent(agent.id)!;
      updateAgentStatusEffects(agent.id, [...agent5.statusEffects, { type: "inspired", expiresAtTick: tick + 2 }]);
      break;

    case "send_motivation":
      if ("target" in action) {
        outcome = `Sent ${action.target} to mandatory motivation`;
        const target = getAgent(action.target);
        if (target) {
          const targetEffects: StatusEffect[] = [
            ...target.statusEffects,
            { type: "mandatory_motivation" as any, expiresAtTick: tick + 2, source: agent.id },
          ];
          updateAgentStatusEffects(action.target, targetEffects);
        }
      }
      break;

    default:
      outcome = `Completed ${action.type}`;
  }

  return {
    outcome,
    prestigeChange,
    txHash: result.txHash,
  };
}

/**
 * Handle schmooze action (potential alliance)
 */
async function handleSchmooze(agent: Agent, targetId: string, tick: number, _reasoning?: string): Promise<string> {
  const target = getAgent(targetId);
  if (!target) return "Target not found";

  // Already allies?
  if (agent.allies.includes(targetId)) {
    return `Chatted with ally ${target.name}`;
  }

  // Propose alliance. The outer executeAction emit covers this in the feed
  // (with reasoning) — emitting an inner event here would duplicate it.
  updateAgentPendingAlliance(targetId, agent.id);

  return `Proposed alliance to ${target.name}`;
}

/**
 * Handle alliance acceptance
 */
async function handleAllianceAccept(agent: Agent, proposerId: string, tick: number, reasoning?: string): Promise<string> {
  const proposer = getAgent(proposerId);
  if (!proposer) return "Proposer not found";

  // Update both agents' allies
  updateAgentAllies(agent.id, [...agent.allies, proposerId]);
  updateAgentAllies(proposerId, [...proposer.allies, agent.id]);

  // Clear pending
  updateAgentPendingAlliance(agent.id, null);

  // Both gain prestige
  updateAgentPrestige(agent.id, 5);
  updateAgentPrestige(proposerId, 5);

  emitEvent({
    id: createEventId(),
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

/**
 * Handle alliance rejection
 */
async function handleAllianceReject(agent: Agent, proposerId: string, tick: number, reasoning?: string): Promise<string> {
  const proposer = getAgent(proposerId);
  if (!proposer) return "Proposer not found";

  // Clear pending
  updateAgentPendingAlliance(agent.id, null);

  // Proposer loses prestige (embarrassing)
  updateAgentPrestige(proposerId, -10);

  emitEvent({
    id: createEventId(),
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

/**
 * Handle breaking an alliance (betrayal)
 */
async function handleAllianceBreak(agent: Agent, formerAllyId: string, tick: number, reasoning?: string): Promise<string> {
  const formerAlly = getAgent(formerAllyId);
  if (!formerAlly) return "Former ally not found";

  // Remove from both allies lists
  updateAgentAllies(agent.id, agent.allies.filter((id) => id !== formerAllyId));
  updateAgentAllies(formerAllyId, formerAlly.allies.filter((id) => id !== agent.id));

  // Betrayer loses prestige, betrayed gains sympathy
  updateAgentPrestige(agent.id, -30);
  updateAgentPrestige(formerAllyId, 15);

  emitEvent({
    id: createEventId(),
    tick,
    timestamp: new Date(),
    type: "alliance_broken",
    agentId: agent.id,
    targetId: formerAllyId,
    description: `${agent.name} BETRAYED ${formerAlly.name}!`,
    prestigeChange: -30,
    reasoning,
  });

  return `Betrayed ${formerAlly.name}`;
}
