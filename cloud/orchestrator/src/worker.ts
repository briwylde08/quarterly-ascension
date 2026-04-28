// Worker entry: forwards every request to the single GameOrchestrator DO.
// There is exactly one game in flight at a time, so the DO is named "main".

import { GameOrchestrator } from "./orchestrator-do.js";

export { GameOrchestrator };

export interface Env {
  DB: D1Database;
  ORCHESTRATOR: DurableObjectNamespace;
  ASSET_CODE: string;
  ASSET_ISSUER: string;
  ASSET_SAC: string;
  STELLAR_NETWORK: string;
  HORIZON_URL: string;
  OPENAI_BASE_URL: string;
  OPENAI_API_KEY: string;
  CF_AIG_TOKEN?: string;
  ADMIN_SECRET: string;
  NPC_BASE_URL: string;
  TICK_INTERVAL_MS: string;
  MAX_TICKS: string;

  // Phase 5 — NPC reward sources (bounties and bonuses).
  HR_DEPT_ADDRESS: string;
  HR_DEPT_SECRET: string;
  MOTIVATIONAL_SPEAKER_ADDRESS: string;
  MOTIVATIONAL_SPEAKER_SECRET: string;

  // Phase 6 — claim flow + emails.
  RESEND_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.ORCHESTRATOR.idFromName("main");
    const stub = env.ORCHESTRATOR.get(id);
    return stub.fetch(request);
  },
};
