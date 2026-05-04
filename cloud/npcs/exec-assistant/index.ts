import { createCharge, WorkerEnv } from "../../shared/mpp-worker.js";

const NAME = "Executive Assistant";

const CEO_MOODS = [
  "The CEO is in a good mood today - golf went well",
  "The CEO is distracted - board meeting tomorrow",
  "The CEO is energetic - just had their third espresso",
  "The CEO is reflective - thinking about legacy",
  "The CEO is impatient - has a flight to catch",
];

const ORG_CHART_RUMORS = [
  "There's a new VP position opening up",
  "Someone on the third floor is getting 'reorganized'",
  "The CEO mentioned wanting 'fresh perspectives' in leadership",
  "Budget review is coming - some teams might merge",
  "A senior director is interviewing elsewhere",
];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

type Endpoint = { price: number; needsTarget: boolean; payload: (target?: string) => object };

const ENDPOINTS: Record<string, Endpoint> = {
  "/book-ceo-time": {
    price: 40,
    needsTarget: false,
    payload: () => ({
      action: "ceo_meeting_booked",
      description: "CEO meeting scheduled for this tick",
      assistantNote: pick(CEO_MOODS),
      meetingRoom: `Executive Suite ${Math.floor(Math.random() * 5) + 1}`,
      duration: "15 minutes (if you're lucky)",
      requiresDeliverable: true,
    }),
  },
  "/schedule-conflict": {
    price: 30,
    needsTarget: true,
    payload: (target) => ({
      action: "schedule_conflict_created",
      target,
      effect: "ceo_meeting_cancelled",
      description: `${target}'s CEO meeting has been cancelled due to a 'conflict'`,
      assistantNote: "So sorry, but the CEO's schedule just got very complicated",
      excuse: "An urgent matter came up that required immediate attention",
    }),
  },
  "/move-meeting-early": {
    price: 10,
    needsTarget: true,
    payload: (target) => ({
      action: "meeting_moved_early",
      target,
      description: `${target}'s next meeting is now at 7:30am. The room is freezing.`,
      assistantNote: "I told them it was the only window the CEO had.",
      prestigeChange: -5,
      statusEffect: { type: "tired", target, duration: 3 },
    }),
  },
  "/schedule-pre-meeting": {
    price: 20,
    needsTarget: true,
    payload: (target) => ({
      action: "pre_meeting_scheduled",
      target,
      description: `Booked a pre-meeting for ${target}'s next meeting. And a pre-pre-meeting.`,
      assistantNote: "I've added a 'syncs to align' to their calendar through Q2.",
      prestigeChange: -15,
      statusEffect: { type: "meeting_blocked", target, duration: 2 },
    }),
  },
  "/hostile-takeover": {
    price: 35,
    needsTarget: true,
    payload: (target) => ({
      action: "hostile_takeover_executed",
      target,
      description: `Mounted a hostile takeover of ${target}'s cross-functional partnerships.`,
      assistantNote: "I've sent the kickoff invites. Their old partners are now your old partners.",
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
