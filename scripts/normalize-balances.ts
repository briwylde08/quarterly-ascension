// One-shot maintenance: bring every agent's DLBR balance to a target value.
//
// Strategy:
//   - Burns (agent → issuer) run in parallel — each agent has its own
//     sequence number, so concurrent submissions are safe.
//   - Mints (issuer → agent) run sequentially — they all draw from the issuer
//     account, so they share a sequence and must serialize.

import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { sendAsset, getAssetBalance, ASSET_CODE } from "../src/lib/stellar.js";
import { initDatabase, getAllAgents } from "../src/lib/db.js";

const TARGET = parseFloat(process.env.NORMALIZE_TARGET || "200");
const ISSUER_SECRET = process.env.ASSET_ISSUER_SECRET;
const ISSUER_PUBLIC = process.env.ASSET_ISSUER || "";

async function main() {
  if (!ISSUER_SECRET) {
    console.error("ASSET_ISSUER_SECRET not set in .env");
    process.exit(1);
  }
  const issuerKp = Keypair.fromSecret(ISSUER_SECRET);
  if (issuerKp.publicKey() !== ISSUER_PUBLIC) {
    console.error(`ASSET_ISSUER_SECRET pubkey ${issuerKp.publicKey()} does not match ASSET_ISSUER ${ISSUER_PUBLIC}`);
    process.exit(1);
  }

  await initDatabase();
  const agents = await getAllAgents();
  if (agents.length === 0) {
    console.error("No agents in DB.");
    process.exit(1);
  }

  console.log(`Target balance: ${TARGET} ${ASSET_CODE} per agent`);
  console.log(`Reading current balances for ${agents.length} agents...\n`);

  const balances = await Promise.all(
    agents.map(async (a) => ({
      agent: a,
      current: await getAssetBalance(a.publicKey),
    }))
  );

  const burnList: { agent: typeof agents[number]; amount: number }[] = [];
  const mintList: { agent: typeof agents[number]; amount: number }[] = [];

  for (const { agent, current } of balances) {
    const delta = TARGET - current;
    const rounded = Math.round(delta * 100) / 100;
    if (Math.abs(rounded) < 0.01) {
      console.log(`  ${agent.name.padEnd(22)} $${current.toFixed(2)} (no change)`);
    } else if (rounded < 0) {
      const burn = Math.abs(rounded);
      console.log(`  ${agent.name.padEnd(22)} $${current.toFixed(2)} → burn $${burn.toFixed(2)}`);
      burnList.push({ agent, amount: burn });
    } else {
      console.log(`  ${agent.name.padEnd(22)} $${current.toFixed(2)} → mint $${rounded.toFixed(2)}`);
      mintList.push({ agent, amount: rounded });
    }
  }

  if (burnList.length === 0 && mintList.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  // Burns: parallel
  if (burnList.length > 0) {
    console.log(`\nBurning ${burnList.length} excess balance(s) in parallel...`);
    const burnResults = await Promise.allSettled(
      burnList.map(({ agent, amount }) => sendAsset(agent.secretKey, ISSUER_PUBLIC, amount))
    );
    burnResults.forEach((r, i) => {
      const { agent, amount } = burnList[i];
      if (r.status === "fulfilled") {
        console.log(`  ✓ ${agent.name.padEnd(22)} burned $${amount.toFixed(2)} (tx ${r.value.slice(0, 8)}…)`);
      } else {
        console.error(`  ✗ ${agent.name.padEnd(22)} burn failed: ${r.reason}`);
      }
    });
  }

  // Mints: sequential
  if (mintList.length > 0) {
    console.log(`\nMinting ${mintList.length} top-up(s) sequentially from issuer...`);
    for (const { agent, amount } of mintList) {
      try {
        const hash = await sendAsset(ISSUER_SECRET, agent.publicKey, amount);
        console.log(`  ✓ ${agent.name.padEnd(22)} minted $${amount.toFixed(2)} (tx ${hash.slice(0, 8)}…)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${agent.name.padEnd(22)} mint failed: ${msg}`);
      }
    }
  }

  // Verify
  console.log(`\nFinal balances:`);
  for (const { agent } of balances) {
    const final = await getAssetBalance(agent.publicKey);
    const flag = Math.abs(final - TARGET) < 0.01 ? "✓" : "⚠";
    console.log(`  ${flag} ${agent.name.padEnd(22)} $${final.toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
