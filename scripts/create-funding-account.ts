import "dotenv/config";
import {
  generateKeypair,
  fundWithFriendbot,
  addUsdcTrustline,
  getUsdcBalance,
} from "../src/lib/stellar.js";

async function main() {
  console.log("Creating funding account on Stellar testnet...\n");

  const keypair = generateKeypair();
  console.log(`Public key:  ${keypair.publicKey}`);
  console.log(`Secret key:  ${keypair.secretKey}`);
  console.log();

  console.log("Funding with Friendbot (XLM for fees)...");
  await fundWithFriendbot(keypair.publicKey);

  console.log("Adding USDC trustline...");
  await addUsdcTrustline(keypair.secretKey);

  const balance = await getUsdcBalance(keypair.publicKey);
  console.log(`Current USDC balance: $${balance}\n`);

  console.log("=".repeat(60));
  console.log("NEXT STEPS");
  console.log("=".repeat(60));
  console.log();
  console.log("1. Add this line to your .env file:");
  console.log();
  console.log(`   FUNDING_ACCOUNT_SECRET=${keypair.secretKey}`);
  console.log();
  console.log("2. Get USDC into this account from Circle's testnet faucet:");
  console.log();
  console.log(`   https://faucet.circle.com/`);
  console.log();
  console.log("   Paste this address into the faucet:");
  console.log(`   ${keypair.publicKey}`);
  console.log();
  console.log("   You'll need at least:");
  console.log(`   - $500 USDC for STARTING_BUDGET=50  (10 agents × $50)`);
  console.log(`   - $1000 USDC for STARTING_BUDGET=100 (10 agents × $100)`);
  console.log();
  console.log("3. Once funded, run:");
  console.log();
  console.log(`   npx tsx scripts/fund-agents.ts`);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
