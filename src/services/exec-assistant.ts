import { Request, Response } from "express";
import { createNpcService, startService, ServiceConfig } from "./base.js";

const config: ServiceConfig = {
  name: "Executive Assistant",
  port: 3014,
  recipientAddress: process.env.EXEC_ASSISTANT_ADDRESS || "",
};

const ceoMoods = [
  "The CEO is in a good mood today - golf went well",
  "The CEO is distracted - board meeting tomorrow",
  "The CEO is energetic - just had their third espresso",
  "The CEO is reflective - thinking about legacy",
  "The CEO is impatient - has a flight to catch",
];

const orgChartRumors = [
  "There's a new VP position opening up",
  "Someone on the third floor is getting 'reorganized'",
  "The CEO mentioned wanting 'fresh perspectives' in leadership",
  "Budget review is coming - some teams might merge",
  "A senior director is interviewing elsewhere",
];

function randomItem<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

const service = createNpcService(config, [
  {
    path: "/book-ceo-time",
    price: 50,
    handler: (req: Request, res: Response) => {
      const mood = randomItem(ceoMoods);
      // Success depends on whether agent has a deliverable
      // The orchestrator will check this and adjust the outcome
      res.json({
        action: "ceo_meeting_booked",
        description: "CEO meeting scheduled for this tick",
        assistantNote: mood,
        meetingRoom: `Executive Suite ${Math.floor(Math.random() * 5) + 1}`,
        duration: "15 minutes (if you're lucky)",
        // Prestige change determined by orchestrator based on deliverable status
        // +40 with deliverable, -20 without
        requiresDeliverable: true,
      });
    },
  },
  {
    path: "/leak-org-chart",
    price: 25,
    handler: (req: Request, res: Response) => {
      const rumor = randomItem(orgChartRumors);
      res.json({
        action: "org_chart_leaked",
        description: "Received insider information about upcoming changes",
        assistantNote: "You didn't hear this from me...",
        rumor,
        // The orchestrator may add actual game-relevant intel
        intel: [],
      });
    },
  },
  {
    path: "/schedule-conflict",
    price: 30,
    handler: (req: Request, res: Response) => {
      const { target } = req.body;
      res.json({
        action: "schedule_conflict_created",
        target,
        effect: "ceo_meeting_cancelled",
        description: `${target}'s CEO meeting has been cancelled due to a 'conflict'`,
        assistantNote: "So sorry, but the CEO's schedule just got very complicated",
        excuse: "An urgent matter came up that required immediate attention",
      });
    },
  },
]);

export { service, config };

if (import.meta.url === `file://${process.argv[1]}`) {
  startService(service, config);
}
