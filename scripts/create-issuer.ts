import "dotenv/config";
import { generateKeypair, fundWithFriendbot } from "../src/lib/stellar.js";

const ASSET_CODE = process.env.ASSET_CODE || "DLBR";

async function main() {
  console.log(`Creating ${ASSET_CODE} issuer account on Stellar testnet...\n`);

  const keypair = generateKeypair();
  console.log(`Public key:  ${keypair.publicKey}`);
  console.log(`Secret key:  ${keypair.secretKey}`);
  console.log();

  console.log("Funding with Friendbot (XLM for fees)...");
  await fundWithFriendbot(keypair.publicKey);

  console.log();
  console.log("=".repeat(60));
  console.log(`${ASSET_CODE} ISSUER CREATED`);
  console.log("=".repeat(60));
  console.log();
  console.log("This account is now the issuer of the game asset. On Stellar,");
  console.log("any payment of the asset from the issuer effectively mints new");
  console.log("supply — so this account doubles as the funding account for");
  console.log("agents (no separate distributor needed).");
  console.log();
  console.log("Add these lines to your .env file:");
  console.log();
  console.log(`   ASSET_CODE=${ASSET_CODE}`);
  console.log(`   ASSET_ISSUER=${keypair.publicKey}`);
  console.log(`   FUNDING_ACCOUNT_SECRET=${keypair.secretKey}`);
  console.log();
  console.log("Next:");
  console.log(`   npx tsx scripts/deploy-sac.ts       # deploys Soroban Asset Contract`);
  console.log(`   npx tsx scripts/migrate-trustlines.ts   # switches accounts to ${ASSET_CODE}`);
  console.log(`   npx tsx scripts/fund-agents.ts          # mints ${ASSET_CODE} to agents`);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
