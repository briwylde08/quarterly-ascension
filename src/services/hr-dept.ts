import { Request, Response } from "express";
import { createNpcService, startService, ServiceConfig } from "./base.js";

const config: ServiceConfig = {
  name: "HR Department",
  port: 3011,
  recipientAddress: process.env.HR_DEPT_ADDRESS || "",
};

const service = createNpcService(config, [
  {
    path: "/file-complaint",
    price: 22,
    handler: (req: Request, res: Response) => {
      const { target } = req.body;
      res.json({
        action: "complaint_filed",
        target,
        effect: "under_investigation",
        description: `Complaint filed against ${target}. They will skip their next action while HR investigates.`,
        corporateSpeak: "We take all concerns seriously and will investigate thoroughly.",
        statusEffect: {
          type: "under_investigation",
          target,
          duration: 1,  // Skip 1 action
        },
      });
    },
  },
  {
    path: "/sensitivity-training",
    price: 30,
    handler: (req: Request, res: Response) => {
      const { target } = req.body;
      res.json({
        action: "sensitivity_training_assigned",
        target,
        effect: "problematic",
        description: `${target} has been enrolled in mandatory sensitivity training.`,
        corporateSpeak: "This is an opportunity for growth and learning.",
        prestigeChange: -20,
        statusEffect: {
          type: "problematic",
          target,
          duration: null,  // Until removed by birthday cake
        },
      });
    },
  },
  {
    path: "/check-status",
    price: 5,
    handler: (req: Request, res: Response) => {
      // In real implementation, this would check the database
      res.json({
        action: "status_check",
        description: "HR status inquiry completed",
        corporateSpeak: "Your inquiry has been logged. Someone will follow up within 3-5 business days.",
        // The orchestrator will fill in actual complaint data
        complaints: [],
      });
    },
  },
]);

export { service, config };

if (import.meta.url === `file://${process.argv[1]}`) {
  startService(service, config);
}
