import { createCharge, WorkerEnv } from "../../shared/mpp-worker.js";

const NAME = "The Caterer";

const LUNCH_MENUS = [
  "Artisanal sandwich platter with quinoa salad",
  "Build-your-own taco bar (vegetarian options available)",
  "Mediterranean mezze spread",
  "Sushi and poke bowls",
  "Classic deli spread with three types of coleslaw",
];

const CAKE_MESSAGES = [
  "Happy Birthday! (Even though it's not your birthday)",
  "Congratulations on your continued employment!",
  "Thanks for being a team player!",
  "Here's to another fiscal quarter!",
];

const POISON_SYMPTOMS = [
  "mild food poisoning",
  "suspicious stomach issues",
  "an unfortunate allergic reaction",
  "concerns about the mayonnaise",
];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

type Endpoint = { price: number; needsTarget: boolean; payload: (target?: string) => object };

const ENDPOINTS: Record<string, Endpoint> = {
  "/team-lunch": {
    price: 25,
    needsTarget: false,
    payload: () => ({
      action: "team_lunch_hosted",
      effect: "prestige_boost",
      description: "Hosted a team lunch - everyone appreciates free food",
      menu: pick(LUNCH_MENUS),
      attendeeCount: Math.floor(Math.random() * 8) + 5,
      catererNote: "Nothing brings people together like carbs",
      prestigeChange: 15,
      allianceChance: 0.3,
    }),
  },
  "/poison-meeting": {
    price: 35,
    needsTarget: true,
    payload: (target) => ({
      action: "meeting_poisoned",
      target,
      effect: "meeting_ruined",
      description: `${target}'s department meeting was disrupted by ${pick(POISON_SYMPTOMS)}`,
      catererNote: "We are deeply sorry for any inconvenience caused by our catering",
      plausibleDeniability: "The health inspector found nothing conclusive",
      prestigeChange: -10,
    }),
  },
  "/birthday-cake": {
    price: 12,
    needsTarget: false,
    payload: () => ({
      action: "birthday_cake_delivered",
      effect: "removes_problematic",
      description: "A surprise birthday cake appeared - how thoughtful!",
      cakeMessage: pick(CAKE_MESSAGES),
      cakeFlavor: "Generic vanilla with buttercream",
      catererNote: "Everyone loves the person who brings cake",
      prestigeChange: 5,
      removesStatus: "problematic",
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
