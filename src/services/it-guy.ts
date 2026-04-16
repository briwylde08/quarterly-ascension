import { Request, Response } from "express";
import { createNpcService, startService, ServiceConfig } from "./base.js";

const config: ServiceConfig = {
  name: "IT Guy",
  port: 3013,
  recipientAddress: process.env.IT_GUY_ADDRESS || "",
};

const excuses = [
  "Their laptop had a critical driver conflict",
  "We detected some suspicious network activity on their machine",
  "Their Outlook needed an emergency patch",
  "We're migrating them to the new VPN client",
  "Their hard drive is being scanned for compliance",
  "We found some unlicensed software that needs removal",
];

const calendarExcuses = [
  "Exchange server sync issue",
  "Calendar permissions need to be re-provisioned",
  "Timezone database corruption",
  "Outlook client desync detected",
];

function randomExcuse(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

const service = createNpcService(config, [
  {
    path: "/fix-laptop",
    price: 18,
    handler: (req: Request, res: Response) => {
      const { target } = req.body;
      const excuse = randomExcuse(excuses);
      res.json({
        action: "laptop_fixed",
        target,
        effect: "technical_difficulties",
        description: `${target}'s laptop is experiencing technical difficulties`,
        itExcuse: excuse,
        ticketNumber: `INC${Math.floor(Math.random() * 900000) + 100000}`,
        estimatedResolution: "1 business day",
        statusEffect: {
          type: "technical_difficulties",
          target,
          duration: 1,  // Skip 1 action
        },
      });
    },
  },
  {
    path: "/recover-emails",
    price: 20,
    handler: (req: Request, res: Response) => {
      const { target } = req.body;
      res.json({
        action: "emails_recovered",
        target,
        description: `Retrieved email activity for ${target}`,
        itNote: "Found some interesting items in the sent folder...",
        // The orchestrator will fill in actual action data
        emails: [],
      });
    },
  },
  {
    path: "/calendar-conflict",
    price: 15,
    handler: (req: Request, res: Response) => {
      const { target } = req.body;
      const excuse = randomExcuse(calendarExcuses);
      res.json({
        action: "calendar_conflict_created",
        target,
        effect: "meeting_will_fail",
        description: `${target}'s next meeting action will fail due to calendar issues`,
        itExcuse: excuse,
        ticketNumber: `INC${Math.floor(Math.random() * 900000) + 100000}`,
        statusEffect: {
          type: "calendar_conflict",
          target,
          duration: 1,  // Next meeting fails
        },
      });
    },
  },
]);

export { service, config };

if (import.meta.url === `file://${process.argv[1]}`) {
  startService(service, config);
}
