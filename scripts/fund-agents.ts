import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { sendAsset, getAssetBalance, ASSET_CODE, ASSET_ISSUER } from "../src/lib/stellar.js";
import { initDatabase, getAllAgents } from "../src/lib/db.js";

const STARTING_BUDGET = parseInt(process.env.STARTING_BUDGET || "50", 10);
const FUNDING_ACCOUNT_SECRET = process.env.FUNDING_ACCOUNT_SECRET;

async function main() {
  if (!FUNDING_ACCOUNT_SECRET) {
    console.error("ERROR: FUNDING_ACCOUNT_SECRET is not set in .env");
    console.error("Run scripts/create-issuer.ts first.");
    process.exit(1);
  }

  initDatabase();

  const fundingPublic = Keypair.fromSecret(FUNDING_ACCOUNT_SECRET).publicKey();

  // If the funding account IS the asset issuer, supply is unbounded — every
  // payment from the issuer mints fresh asset. Otherwise it's a regular
  // distributor account and we have to check its actual balance.
  const isIssuer = fundingPublic === ASSET_ISSUER;
  const fundingBalance = isIssuer ? Infinity : await getAssetBalance(fundingPublic);

  console.log(`Funding account: ${fundingPublic.slice(0, 8)}...${isIssuer ? " (issuer — unlimited supply)" : ""}`);
  if (!isIssuer) {
    console.log(`Funding balance: $${fundingBalance} ${ASSET_CODE}`);
  }
  console.log(`Target per agent: $${STARTING_BUDGET} ${ASSET_CODE}`);
  console.log();

  const agents = getAllAgents();
  if (agents.length === 0) {
    console.error("ERROR: No agents in database. Run `npm run setup` first.");
    process.exit(1);
  }

  // Compute how much we need to send (idempotent — only top up gaps)
  const balances = await Promise.all(
    agents.map(async (a) => ({ agent: a, current: await getAssetBalance(a.publicKey) }))
  );

  const topUps = balances
    .map(({ agent, current }) => ({
      agent,
      current,
      needed: Math.max(0, STARTING_BUDGET - current),
    }))
    .filter((x) => x.needed > 0);

  const totalNeeded = topUps.reduce((sum, x) => sum + x.needed, 0);

  if (topUps.length === 0) {
    console.log("All agents are already at or above the target budget. Nothing to do.");
    for (const { agent, current } of balances) {
      console.log(`  ${agent.name}: $${current}`);
    }
    return;
  }

  console.log(`Want to send $${totalNeeded} ${ASSET_CODE} total across ${topUps.length} agent(s).`);
  if (fundingBalance < totalNeeded) {
    console.log(`Funding account is $${(totalNeeded - fundingBalance).toFixed(2)} short — will fund as many agents as possible.`);
  }
  console.log();

  // Process agents in order, sending what we can afford. Stop topping up
  // (but still report) when the funding account is too low for the next agent.
  let remaining = fundingBalance;
  let funded = 0;
  let skipped: { name: string; needed: number }[] = [];

  for (const { agent, current, needed } of topUps) {
    if (remaining < needed) {
      skipped.push({ name: agent.name, needed });
      continue;
    }
    try {
      await sendAsset(FUNDING_ACCOUNT_SECRET, agent.publicKey, needed);
      console.log(`  ✓ ${agent.name}: $${current} → $${current + needed}`);
      remaining -= needed;
      funded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${agent.name}: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (skipped.length > 0) {
    const stillNeeded = skipped.reduce((s, x) => s + x.needed, 0);
    console.log(`\n${skipped.length} agent(s) skipped — funding account ran out:`);
    for (const s of skipped) console.log(`  - ${s.name} (needs $${s.needed})`);
    console.log(`\nAdd $${stillNeeded.toFixed(2)} more ${ASSET_CODE} to ${fundingPublic}, then re-run this script.`);
  }

  console.log("\nDone. Final balances:");
  for (const { agent } of balances) {
    const final = await getAssetBalance(agent.publicKey);
    console.log(`  ${agent.name}: $${final}`);
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
