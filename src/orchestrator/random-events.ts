import { v4 as uuid } from "uuid";
import { GameEvent } from "../lib/types.js";
import { getAllAgents, updateAgentPrestige, updateAgentStatusEffects, getAgent } from "../lib/db.js";
import { getUsdcBalance } from "../lib/stellar.js";

interface RandomEventDef {
  id: string;
  name: string;
  probability: number; // Per tick, 0-1
  trigger: "random" | "weekly" | "midgame" | "once";
  execute: (tick: number) => Promise<GameEvent[]>;
}

// Track one-time events
const triggeredOnce = new Set<string>();
let lastWeeklyTick = 0;

const RANDOM_EVENTS: RandomEventDef[] = [
  {
    id: "all_hands",
    name: "All-Hands Meeting",
    probability: 0.1,
    trigger: "random",
    execute: async (tick) => {
      return [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        description: "ALL-HANDS MEETING: Everyone skips this action while CEO rambles about vision and synergy.",
      }];
      // Note: This would need integration with tick processing to actually skip actions
    },
  },
  {
    id: "budget_cuts",
    name: "Budget Cuts",
    probability: 0.08,
    trigger: "random",
    execute: async (tick) => {
      const agents = getAllAgents();
      const victim = agents[Math.floor(Math.random() * agents.length)];
      // In a real implementation, we'd reduce their USDC balance
      // For now, just announce it
      return [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        agentId: victim.id,
        description: `BUDGET CUTS: ${victim.name} loses 30% of remaining budget!`,
      }];
    },
  },
  {
    id: "reorg_rumors",
    name: "Reorg Rumors",
    probability: 0.05,
    trigger: "random",
    execute: async (tick) => {
      // Dissolve all alliances
      const agents = getAllAgents();
      for (const agent of agents) {
        if (agent.allies.length > 0) {
          // Clear allies in DB
          // updateAgentAllies(agent.id, []);
        }
      }
      return [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        description: "REORG RUMORS: All alliances have been dissolved as everyone scrambles to protect themselves!",
      }];
    },
  },
  {
    id: "mandatory_fun",
    name: "Mandatory Fun",
    probability: 1.0, // Triggered by weekly check
    trigger: "weekly",
    execute: async (tick) => {
      const agents = getAllAgents();
      const events: GameEvent[] = [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        description: "MANDATORY FUN: Team building event! Everyone pays $15 and receives random prestige changes.",
      }];

      for (const agent of agents) {
        const prestigeChange = Math.floor(Math.random() * 31) - 10; // -10 to +20
        updateAgentPrestige(agent.id, prestigeChange);
        events.push({
          id: uuid(),
          tick,
          timestamp: new Date(),
          type: "random_event",
          agentId: agent.id,
          description: `${agent.name} ${prestigeChange >= 0 ? "enjoyed" : "endured"} mandatory fun`,
          prestigeChange,
        });
      }

      return events;
    },
  },
  {
    id: "audit",
    name: "Audit",
    probability: 1.0,
    trigger: "weekly",
    execute: async (tick) => {
      // Find highest spender (by lowest balance relative to start)
      const agents = getAllAgents();
      let lowestBalance = Infinity;
      let biggestSpender = agents[0];

      for (const agent of agents) {
        const balance = await getUsdcBalance(agent.publicKey);
        if (balance < lowestBalance) {
          lowestBalance = balance;
          biggestSpender = agent;
        }
      }

      updateAgentPrestige(biggestSpender.id, -30);
      const agentData = getAgent(biggestSpender.id)!;
      updateAgentStatusEffects(biggestSpender.id, [
        ...agentData.statusEffects,
        { type: "under_review", expiresAtTick: tick + 4 },
      ]);

      return [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        agentId: biggestSpender.id,
        description: `AUDIT: ${biggestSpender.name} is under review for excessive spending! -30 prestige`,
        prestigeChange: -30,
      }];
    },
  },
  {
    id: "viral_linkedin",
    name: "Viral LinkedIn Post",
    probability: 0.07,
    trigger: "random",
    execute: async (tick) => {
      const agents = getAllAgents();
      const lucky = agents[Math.floor(Math.random() * agents.length)];
      updateAgentPrestige(lucky.id, 50);

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
    },
  },
  {
    id: "coffee_machine_broken",
    name: "Coffee Machine Broken",
    probability: 0.05,
    trigger: "random",
    execute: async (tick) => {
      const agents = getAllAgents();
      for (const agent of agents) {
        const agentData = getAgent(agent.id)!;
        if (!agentData.statusEffects.some((e) => e.type === "caffeinated")) {
          updateAgentStatusEffects(agent.id, [
            ...agentData.statusEffects,
            { type: "tired", expiresAtTick: tick + 2 },
          ]);
        }
      }

      return [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        description: "COFFEE MACHINE BROKEN: Everyone without Caffeinated status is now Tired!",
      }];
    },
  },
  {
    id: "new_initiative",
    name: "New Initiative",
    probability: 1.0,
    trigger: "midgame",
    execute: async (tick) => {
      return [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        description: "NEW INITIATIVE: CEO announces a pivot! All previous strategy reports are now worth 50% less prestige.",
      }];
    },
  },
  {
    id: "printer_jam",
    name: "Printer Jam",
    probability: 0.08,
    trigger: "random",
    execute: async (tick) => {
      const agents = getAllAgents();
      const victims = agents.filter((a) =>
        a.statusEffects.some((e) => e.type === "has_deliverable")
      );

      if (victims.length === 0) {
        return []; // No one has a deliverable
      }

      const victim = victims[Math.floor(Math.random() * victims.length)];
      const agentData = getAgent(victim.id)!;
      updateAgentStatusEffects(victim.id, agentData.statusEffects.filter((e) => e.type !== "has_deliverable"));

      return [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        agentId: victim.id,
        description: `PRINTER JAM: ${victim.name} lost their deliverable! The printer ate it.`,
      }];
    },
  },
  {
    id: "surprise_promotion",
    name: "Surprise Promotion",
    probability: 0.03,
    trigger: "random",
    execute: async (tick) => {
      const agents = getAllAgents().sort((a, b) => a.prestige - b.prestige);
      const lowest = agents[0];
      updateAgentPrestige(lowest.id, 20);

      return [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        agentId: lowest.id,
        description: `SURPRISE PROMOTION: ${lowest.name} got promoted out of nowhere! +20 prestige. Everyone is confused.`,
        prestigeChange: 20,
      }];
    },
  },
  {
    id: "email_leak",
    name: "Email Leak",
    probability: 0.06,
    trigger: "random",
    execute: async (tick) => {
      const agents = getAllAgents();
      const victim = agents[Math.floor(Math.random() * agents.length)];

      return [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        agentId: victim.id,
        description: `EMAIL LEAK: ${victim.name}'s last 5 actions were accidentally forwarded to all-staff!`,
      }];
    },
  },
  {
    id: "fire_drill",
    name: "Fire Drill",
    probability: 0.04,
    trigger: "random",
    execute: async (tick) => {
      return [{
        id: uuid(),
        tick,
        timestamp: new Date(),
        type: "random_event",
        description: "FIRE DRILL: Everyone evacuates! No actions this tick, but plenty of time for hallway gossip.",
      }];
    },
  },
];

/**
 * Process random events for a tick
 */
export async function processRandomEvents(tick: number): Promise<GameEvent[]> {
  const events: GameEvent[] = [];

  // Check weekly events (every 12 ticks)
  if (tick > 0 && tick % 12 === 0 && tick !== lastWeeklyTick) {
    lastWeeklyTick = tick;
    for (const event of RANDOM_EVENTS.filter((e) => e.trigger === "weekly")) {
      const result = await event.execute(tick);
      events.push(...result);
    }
  }

  // Check midgame event (tick 24 for a 48-tick game)
  if (tick === 24 && !triggeredOnce.has("new_initiative")) {
    triggeredOnce.add("new_initiative");
    const event = RANDOM_EVENTS.find((e) => e.id === "new_initiative")!;
    const result = await event.execute(tick);
    events.push(...result);
  }

  // Check random events
  for (const event of RANDOM_EVENTS.filter((e) => e.trigger === "random")) {
    if (Math.random() < event.probability) {
      const result = await event.execute(tick);
      events.push(...result);
    }
  }

  return events;
}
