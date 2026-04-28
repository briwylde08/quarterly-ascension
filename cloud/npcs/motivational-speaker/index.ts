import { createCharge, WorkerEnv } from "../../shared/mpp-worker.js";

const NAME = "Motivational Speaker";

const SPEAKER_NAMES = [
  "Brad Momentum",
  "Crystal Hustle",
  "Derek Grindstone",
  "Tiffany Uplift",
  "Chad Inspiration",
];

const QUOTES = [
  "Success is just failure that hasn't given up yet!",
  "Be the synergy you wish to see in the world!",
  "Your comfort zone is a beautiful place, but nothing grows there!",
  "Dream bigger! Then dream even bigger! Now TRIPLE IT!",
  "The only thing standing between you and success is... everything!",
  "Turn your wounds into wisdom, and your wisdom into a TED talk!",
  "You miss 100% of the shots you don't take, and also about 90% of the ones you do!",
  "If opportunity doesn't knock, build a door! Then monetize the door!",
];

const SESSION_TITLES = [
  "Unleashing Your Inner Champion",
  "From Good to Great to LEGENDARY",
  "The 7 Habits of Highly Synergistic People",
  "Mindset Mastery: Think It, Be It, Invoice It",
  "Crushing It: A Journey to Excellence",
];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

type Endpoint = { price: number; needsTarget: boolean; payload: (target?: string) => object };

const ENDPOINTS: Record<string, Endpoint> = {
  "/book-session": {
    price: 30,
    needsTarget: false,
    payload: () => {
      const speaker = pick(SPEAKER_NAMES);
      const title = pick(SESSION_TITLES);
      return {
        action: "motivation_session_attended",
        effect: "inspired",
        description: `Attended "${title}" with ${speaker}`,
        speaker,
        sessionTitle: title,
        keyTakeaway: pick(QUOTES),
        speakerNote: "Remember: you are ENOUGH! (But could always be more)",
        prestigeChange: 20,
        statusEffect: { type: "inspired", duration: 2 },
      };
    },
  },
  "/send-to-rival": {
    price: 35,
    needsTarget: true,
    payload: (target) => ({
      action: "mandatory_motivation_assigned",
      target,
      effect: "wasted_actions",
      description: `${target} has been enrolled in mandatory motivation training`,
      speaker: pick(SPEAKER_NAMES),
      sessionTitle: pick(SESSION_TITLES),
      speakerNote: "They seemed... resistant to growth. We'll work on that.",
      hrJustification: "We noticed some opportunities for personal development",
      statusEffect: { type: "mandatory_motivation", target, duration: 2 },
    }),
  },
  "/mentorship": {
    price: 15,
    needsTarget: true,
    payload: (target) => ({
      action: "mentorship_session",
      target,
      description: `Booked a mentorship session for ${target}.`,
      speaker: pick(SPEAKER_NAMES),
      mentorshipNote: "MegaCorp's Pay-It-Forward program rewards mentors with a stipend.",
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
