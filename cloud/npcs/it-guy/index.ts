import { createCharge, WorkerEnv } from "../../shared/mpp-worker.js";

const NAME = "IT Guy";

const FIX_EXCUSES = [
  "Their laptop had a critical driver conflict",
  "We detected some suspicious network activity on their machine",
  "Their Outlook needed an emergency patch",
  "We're migrating them to the new VPN client",
  "Their hard drive is being scanned for compliance",
  "We found some unlicensed software that needs removal",
];

const CALENDAR_EXCUSES = [
  "Exchange server sync issue",
  "Calendar permissions need to be re-provisioned",
  "Timezone database corruption",
  "Outlook client desync detected",
];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const ticket = () => `INC${Math.floor(Math.random() * 900000) + 100000}`;

type Endpoint = { price: number; needsTarget: boolean; payload: (target?: string) => object };

const ENDPOINTS: Record<string, Endpoint> = {
  "/fix-laptop": {
    price: 18,
    needsTarget: true,
    payload: (target) => ({
      action: "laptop_fixed",
      target,
      effect: "technical_difficulties",
      description: `${target}'s laptop is experiencing technical difficulties`,
      itExcuse: pick(FIX_EXCUSES),
      ticketNumber: ticket(),
      estimatedResolution: "1 business day",
      statusEffect: { type: "technical_difficulties", target, duration: 1 },
    }),
  },
  "/recover-emails": {
    price: 20,
    needsTarget: true,
    payload: (target) => ({
      action: "emails_recovered",
      target,
      description: `Retrieved email activity for ${target}`,
      itNote: "Found some interesting items in the sent folder...",
      emails: [],
    }),
  },
  "/calendar-conflict": {
    price: 15,
    needsTarget: true,
    payload: (target) => ({
      action: "calendar_conflict_created",
      target,
      effect: "meeting_will_fail",
      description: `${target}'s next meeting action will fail due to calendar issues`,
      itExcuse: pick(CALENDAR_EXCUSES),
      ticketNumber: ticket(),
      statusEffect: { type: "calendar_conflict", target, duration: 1 },
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
