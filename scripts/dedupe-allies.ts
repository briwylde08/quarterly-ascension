// One-shot maintenance: dedupe agents.allies arrays in D1.
//
// Earlier in the run, handleSchmooze used a stale agent snapshot that let a
// schmooze fire after an alliance had already been formed in the same tick,
// resulting in entries like ron.allies = ["stacy","brenda","brenda"]. The
// orchestrator code is fixed; this script normalizes the existing rows.
//
// Safe to re-run; idempotent.

import "dotenv/config";
import { d1 } from "../src/lib/d1-client.js";

interface AgentRow {
  id: string;
  allies: string;
}

async function main() {
  const rows = await d1.all<AgentRow>("SELECT id, allies FROM agents");
  let touched = 0;
  for (const r of rows) {
    const current: string[] = JSON.parse(r.allies);
    const cleaned = Array.from(new Set(current)).filter((x) => x !== r.id);
    if (cleaned.length !== current.length) {
      console.log(`  ${r.id}: ${JSON.stringify(current)} → ${JSON.stringify(cleaned)}`);
      await d1.run("UPDATE agents SET allies = ? WHERE id = ?", JSON.stringify(cleaned), r.id);
      touched++;
    }
  }
  console.log(touched === 0 ? "No duplicates found." : `Cleaned ${touched} agent(s).`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
