import { createCharge, WorkerEnv } from "../../shared/mpp-worker.js";

/**
 * Coffee Cart NPC service. Sells corporate caffeine for DLBR.
 *
 * Routes:
 *   GET  /health                   — uptime/identity ping (no payment)
 *   POST /buy           ($8 DLBR)  — generic coffee, removes Tired
 *   POST /buy-fancy     ($15 DLBR) — fancy coffee, grants Caffeinated
 *
 * MPP charge mode: client agent gets a 402 with payment params on first hit,
 * signs a Stellar Soroban transfer to RECIPIENT_ADDRESS, retries with the
 * signed credential, and receives the JSON payload + a Payment-Receipt
 * header containing the on-chain tx hash.
 */

const NAME = "Coffee Cart";

const ENDPOINTS = {
  "/buy": {
    price: 5,
    payload: {
      item: "coffee",
      effect: "productivity_boost",
      description: "A mediocre cup of corporate coffee",
      flavor: "Hints of burnt beans and existential dread",
      statusEffect: { type: "removes_tired", duration: null },
    },
  },
  "/buy-fancy": {
    price: 10,
    payload: {
      item: "fancy_coffee",
      effect: "caffeinated",
      description: "An artisanal pour-over that costs more than your hourly wage",
      flavor: "Notes of superiority and oat milk",
      statusEffect: { type: "caffeinated", duration: 2 },
    },
  },
  "/coffee-chat": {
    price: 5,
    payload: {
      item: "coffee_chat",
      effect: "low_stakes_networking",
      description: "Two coffees for a casual catch-up. No agenda. Probably.",
      flavor: "Half work-talk, half complaining about the org chart",
    },
  },
} as const;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ service: NAME, status: "ok" });
    }

    const endpoint = ENDPOINTS[url.pathname as keyof typeof ENDPOINTS];
    if (!endpoint || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const charge = createCharge(env);
    const outcome = await charge(request, endpoint.price);

    if (!outcome.settled) {
      // 402 Payment Required — return the challenge unchanged.
      return outcome.response;
    }

    // Payment cleared on-chain. Produce the success payload and attach the
    // Payment-Receipt header so the orchestrator can extract the tx hash.
    const base = Response.json(endpoint.payload);
    return outcome.result.withReceipt(base);
  },
};
