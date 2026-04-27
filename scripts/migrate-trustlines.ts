import "dotenv/config";
import { addAssetTrustline, ASSET_CODE, ASSET_ISSUER } from "../src/lib/stellar.js";
import { initDatabase, getAllAgents } from "../src/lib/db.js";

interface Account {
  label: string;
  secretKey: string;
}

const NPC_SERVICES = [
  { name: "Coffee Cart", envVar: "COFFEE_CART_SECRET" },
  { name: "HR Department", envVar: "HR_DEPT_SECRET" },
  { name: "The Consultant", envVar: "CONSULTANT_SECRET" },
  { name: "IT Guy", envVar: "IT_GUY_SECRET" },
  { name: "Executive Assistant", envVar: "EXEC_ASSISTANT_SECRET" },
  { name: "The Caterer", envVar: "CATERER_SECRET" },
  { name: "Motivational Speaker", envVar: "MOTIVATIONAL_SPEAKER_SECRET" },
];

async function main() {
  if (!ASSET_ISSUER) {
    console.error("ERROR: ASSET_ISSUER is not set in .env");
    console.error("Run scripts/create-issuer.ts first.");
    process.exit(1);
  }

  initDatabase();

  console.log(`Migrating trustlines to ${ASSET_CODE} (issuer: ${ASSET_ISSUER.slice(0, 8)}...)\n`);

  const accounts: Account[] = [];

  // Agents from the DB
  const agents = getAllAgents();
  for (const agent of agents) {
    accounts.push({ label: agent.name, secretKey: agent.secretKey });
  }

  // NPC services from .env
  for (const npc of NPC_SERVICES) {
    const secret = process.env[npc.envVar];
    if (!secret) {
      console.warn(`  ⚠️  ${npc.name}: ${npc.envVar} not in .env, skipping`);
      continue;
    }
    accounts.push({ label: npc.name, secretKey: secret });
  }

  console.log(`Adding ${ASSET_CODE} trustlines for ${accounts.length} account(s):\n`);

  let succeeded = 0;
  let alreadyHad = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      await addAssetTrustline(account.secretKey);
      console.log(`  ✓ ${account.label}`);
      succeeded++;
    } catch (err: any) {
      const msg = err?.response?.data?.extras?.result_codes?.operations?.[0] || err.message;
      // op_already_exists is fine — trustline is already there
      if (typeof msg === "string" && msg.includes("already")) {
        console.log(`  ✓ ${account.label} (already had trustline)`);
        alreadyHad++;
      } else {
        console.error(`  ✗ ${account.label}: ${msg}`);
        failed++;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log();
  console.log(`Done. ${succeeded} added, ${alreadyHad} already existed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
