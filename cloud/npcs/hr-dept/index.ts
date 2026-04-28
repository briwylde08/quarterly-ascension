import { createCharge, WorkerEnv } from "../../shared/mpp-worker.js";

/**
 * HR Department NPC. Files complaints, sends rivals to sensitivity training,
 * and offers cheap defensive intel.
 */

const NAME = "HR Department";

type Endpoint = {
  price: number;
  needsTarget: boolean;
  payload: (target?: string) => object;
};

const ENDPOINTS: Record<string, Endpoint> = {
  "/file-complaint": {
    price: 22,
    needsTarget: true,
    payload: (target) => ({
      action: "complaint_filed",
      target,
      effect: "under_investigation",
      description: `Complaint filed against ${target}. They will skip their next action while HR investigates.`,
      corporateSpeak: "We take all concerns seriously and will investigate thoroughly.",
      statusEffect: { type: "under_investigation", target, duration: 1 },
    }),
  },
  "/sensitivity-training": {
    price: 30,
    needsTarget: true,
    payload: (target) => ({
      action: "sensitivity_training_assigned",
      target,
      effect: "problematic",
      description: `${target} has been enrolled in mandatory sensitivity training.`,
      corporateSpeak: "This is an opportunity for growth and learning.",
      prestigeChange: -20,
      statusEffect: { type: "problematic", target, duration: null },
    }),
  },
  "/check-status": {
    price: 5,
    needsTarget: false,
    payload: () => ({
      action: "status_check",
      description: "HR status inquiry completed",
      corporateSpeak: "Your inquiry has been logged. Someone will follow up within 3-5 business days.",
      complaints: [],
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
      } catch { /* body parse failure — payload will show undefined */ }
    }

    const charge = createCharge(env);
    const outcome = await charge(request, endpoint.price);

    if (!outcome.settled) return outcome.response;

    return outcome.result.withReceipt(Response.json(endpoint.payload(target)));
  },
};
