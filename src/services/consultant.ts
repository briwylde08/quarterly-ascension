import { Request, Response } from "express";
import { createNpcService, startService, ServiceConfig } from "./base.js";

const config: ServiceConfig = {
  name: "The Consultant",
  port: 3012,
  recipientAddress: process.env.CONSULTANT_ADDRESS || "",
};

// Buzzword generators
const buzzwords = [
  "synergy", "alignment", "leverage", "disrupt", "pivot", "scale",
  "blockchain", "AI-driven", "agile", "holistic", "paradigm shift",
  "value proposition", "north star", "move the needle", "boil the ocean",
  "circle back", "low-hanging fruit", "deep dive", "bandwidth",
];

const reportTitles = [
  "Strategic Synergy Framework v2.1",
  "Digital Transformation Roadmap Q1",
  "Agile Innovation Playbook",
  "Holistic Value Creation Matrix",
  "Disruptive Alignment Strategy",
  "Next-Gen Paradigm Shift Analysis",
  "Blockchain-Enabled Synergy Protocol",
  "AI-Driven North Star Initiative",
];

function generateBuzzwordSalad(): string {
  const count = 3 + Math.floor(Math.random() * 4);
  const selected = [];
  for (let i = 0; i < count; i++) {
    selected.push(buzzwords[Math.floor(Math.random() * buzzwords.length)]);
  }
  return selected.join(" ");
}

function generateReportTitle(): string {
  return reportTitles[Math.floor(Math.random() * reportTitles.length)];
}

const service = createNpcService(config, [
  {
    path: "/strategy-report",
    price: 35,
    handler: (req: Request, res: Response) => {
      const title = generateReportTitle();
      res.json({
        action: "strategy_report_delivered",
        effect: "has_deliverable",
        deliverable: {
          title,
          subtitle: `Leveraging ${generateBuzzwordSalad()} for competitive advantage`,
          pageCount: 47,
          charts: 23,
          actualValue: "negligible",
        },
        description: `Received "${title}" - a comprehensive 47-page deck with 23 charts`,
        consultantQuote: "This will really move the needle on your Q1 objectives.",
        prestigeChange: 25,
        statusEffect: {
          type: "has_deliverable",
          duration: null,  // Until used
        },
      });
    },
  },
  {
    path: "/competitive-intel",
    price: 25,
    handler: (req: Request, res: Response) => {
      res.json({
        action: "competitive_intel_delivered",
        description: "Received intelligence on top performers",
        consultantQuote: "Our proprietary research methodology reveals some interesting patterns...",
        // The orchestrator will fill in actual agent data
        intel: [],
      });
    },
  },
  {
    path: "/sabotage-plan",
    price: 40,
    handler: (req: Request, res: Response) => {
      const { target } = req.body;
      res.json({
        action: "sabotage_plan_delivered",
        target,
        description: `Received dossier on ${target}'s vulnerabilities`,
        consultantQuote: "We've identified several... opportunities for strategic repositioning.",
        // The orchestrator will fill in actual weakness data
        vulnerabilities: [],
      });
    },
  },
]);

export { service, config };

if (import.meta.url === `file://${process.argv[1]}`) {
  startService(service, config);
}
