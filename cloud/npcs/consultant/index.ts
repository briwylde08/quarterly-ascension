import { createCharge, WorkerEnv } from "../../shared/mpp-worker.js";

/**
 * The Consultant NPC. Sells buzzword reports, intel, and sabotage dossiers.
 * Each strategy report has a randomly-generated impressive-sounding title
 * and a buzzword-salad subtitle, in keeping with the bit.
 */

const NAME = "The Consultant";

const BUZZWORDS = [
  "synergy", "alignment", "leverage", "disrupt", "pivot", "scale",
  "blockchain", "AI-driven", "agile", "holistic", "paradigm shift",
  "value proposition", "north star", "move the needle", "boil the ocean",
  "circle back", "low-hanging fruit", "deep dive", "bandwidth",
];

const REPORT_TITLES = [
  "Strategic Synergy Framework v2.1",
  "Digital Transformation Roadmap Q1",
  "Agile Innovation Playbook",
  "Holistic Value Creation Matrix",
  "Disruptive Alignment Strategy",
  "Next-Gen Paradigm Shift Analysis",
  "Blockchain-Enabled Synergy Protocol",
  "AI-Driven North Star Initiative",
];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const buzzwordSalad = () => Array.from({ length: 3 + Math.floor(Math.random() * 4) }, () => pick(BUZZWORDS)).join(" ");

type Endpoint = {
  price: number;
  needsTarget: boolean;
  payload: (target?: string) => object;
};

const ENDPOINTS: Record<string, Endpoint> = {
  "/strategy-report": {
    price: 25,
    needsTarget: false,
    payload: () => {
      const title = pick(REPORT_TITLES);
      return {
        action: "strategy_report_delivered",
        effect: "has_deliverable",
        deliverable: {
          title,
          subtitle: `Leveraging ${buzzwordSalad()} for competitive advantage`,
          pageCount: 47,
          charts: 23,
          actualValue: "negligible",
        },
        description: `Received "${title}" - a comprehensive 47-page deck with 23 charts`,
        consultantQuote: "This will really move the needle on your Q1 objectives.",
        prestigeChange: 25,
        statusEffect: { type: "has_deliverable", duration: null },
      };
    },
  },
  "/competitive-intel": {
    price: 25,
    needsTarget: false,
    payload: () => ({
      action: "competitive_intel_delivered",
      description: "Received intelligence on top performers",
      consultantQuote: "Our proprietary research methodology reveals some interesting patterns...",
      intel: [],
    }),
  },
  "/sabotage-plan": {
    price: 40,
    needsTarget: true,
    payload: (target) => ({
      action: "sabotage_plan_delivered",
      target,
      description: `Received dossier on ${target}'s vulnerabilities`,
      consultantQuote: "We've identified several... opportunities for strategic repositioning.",
      vulnerabilities: [],
    }),
  },
};

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ service: NAME, status: "ok" });
    }

    const endpoint = ENDPOINTS[url.pathname];
    if (!endpoint || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    let target: string | undefined;
    if (endpoint.needsTarget) {
      try {
        const body = await request.clone().json<{ target?: string }>();
        target = body?.target;
      } catch { /* swallow */ }
    }

    const charge = createCharge(env);
    const outcome = await charge(request, endpoint.price);

    if (!outcome.settled) return outcome.response;

    return outcome.result.withReceipt(Response.json(endpoint.payload(target)));
  },
};
