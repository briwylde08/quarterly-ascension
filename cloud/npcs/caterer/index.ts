import { createCharge, WorkerEnv } from "../../shared/mpp-worker.js";

const NAME = "The Caterer";

const PARTY_THEMES = [
  "Cocktails and tiny appetizers in the lobby",
  "Build-your-own taco bar with mediocre margaritas",
  "Sundae cart and a playlist somebody made too aggressively",
  "An open bar that closes after exactly 47 minutes",
  "Karaoke nobody asked for and everyone secretly loves",
];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

type Endpoint = { price: number; needsTarget: boolean; payload: (target?: string) => object };

const ENDPOINTS: Record<string, Endpoint> = {
  "/office-party": {
    price: 25,
    needsTarget: false,
    payload: () => ({
      action: "office_party_hosted",
      description: "Threw an office party. Everyone gains a little prestige; you gain more.",
      theme: pick(PARTY_THEMES),
      catererNote: "Generosity is the new strategy. Probably.",
      prestigeChange: 15,
      ripplePrestige: 5,
    }),
  },
};

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ service: NAME, status: "ok" });

    const endpoint = ENDPOINTS[url.pathname];
    if (!endpoint || request.method !== "POST") return new Response("Not found", { status: 404 });

    let target: string | undefined;
    if (endpoint.needsTarget) {
      try { target = (await request.clone().json<{ target?: string }>())?.target; } catch {}
    }

    const charge = createCharge(env);
    const outcome = await charge(request, endpoint.price);
    if (!outcome.settled) return outcome.response;
    return outcome.result.withReceipt(Response.json(endpoint.payload(target)));
  },
};
