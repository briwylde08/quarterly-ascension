import "dotenv/config";
import {
  generateKeypair,
  fundWithFriendbot,
  addAssetTrustline,
  sendAsset,
  accountExists,
  getAssetBalance,
  ASSET_CODE,
} from "./lib/stellar.js";
import { initDatabase, saveAgent, resetDatabase } from "./lib/db.js";
import { PERSONAS } from "./agents/personas.js";

const STARTING_BUDGET = parseInt(process.env.STARTING_BUDGET || "500", 10);
const FUNDING_ACCOUNT_SECRET = process.env.FUNDING_ACCOUNT_SECRET;

interface AccountData {
  id: string;
  name: string;
  type: "agent" | "npc";
  publicKey: string;
  secretKey: string;
}

// NPC service definitions
const NPC_SERVICES = [
  { id: "coffee_cart", name: "Coffee Cart", envVar: "COFFEE_CART_ADDRESS" },
  { id: "hr_dept", name: "HR Department", envVar: "HR_DEPT_ADDRESS" },
  { id: "consultant", name: "The Consultant", envVar: "CONSULTANT_ADDRESS" },
  { id: "it_guy", name: "IT Guy", envVar: "IT_GUY_ADDRESS" },
  { id: "exec_assistant", name: "Executive Assistant", envVar: "EXEC_ASSISTANT_ADDRESS" },
  { id: "caterer", name: "The Caterer", envVar: "CATERER_ADDRESS" },
  { id: "motivational_speaker", name: "Motivational Speaker", envVar: "MOTIVATIONAL_SPEAKER_ADDRESS" },
];

async function setup() {
  console.log("=".repeat(60));
  console.log("QUARTERLY ASCENSION - SETUP");
  console.log("=".repeat(60));
  console.log();

  // Initialize database
  console.log("Initializing database...");
  initDatabase();
  resetDatabase();
  console.log("Database ready.\n");

  const accounts: AccountData[] = [];

  // Create agent accounts
  console.log("Creating agent accounts...\n");
  for (const persona of PERSONAS) {
    const keypair = generateKeypair();

    console.log(`Creating ${persona.name}...`);

    // Fund with Friendbot
    try {
      await fundWithFriendbot(keypair.publicKey);
    } catch (error) {
      console.error(`  Failed to fund: ${error}`);
      continue;
    }

    // Add asset trustline
    try {
      await addAssetTrustline(keypair.secretKey);
    } catch (error) {
      console.error(`  Failed to add trustline: ${error}`);
      continue;
    }

    // Save to database
    saveAgent({
      id: persona.id,
      personaId: persona.id,
      name: persona.name,
      title: persona.title,
      publicKey: keypair.publicKey,
      secretKey: keypair.secretKey,
      prestige: 0,
      statusEffects: [],
      allies: [],
      pendingAlliance: null,
      claimedBy: null,
      claimedByName: null,
    });

    accounts.push({
      id: persona.id,
      name: persona.name,
      type: "agent",
      ...keypair,
    });

    console.log(`  ✓ ${persona.name}: ${keypair.publicKey.slice(0, 8)}...`);

    // Small delay to avoid rate limiting
    await sleep(1000);
  }

  console.log("\nCreating NPC service accounts...\n");
  for (const npc of NPC_SERVICES) {
    const keypair = generateKeypair();

    console.log(`Creating ${npc.name}...`);

    try {
      await fundWithFriendbot(keypair.publicKey);
      await addAssetTrustline(keypair.secretKey);
    } catch (error) {
      console.error(`  Failed: ${error}`);
      continue;
    }

    accounts.push({
      id: npc.id,
      name: npc.name,
      type: "npc",
      ...keypair,
    });

    console.log(`  ✓ ${npc.name}: ${keypair.publicKey.slice(0, 8)}...`);

    await sleep(1000);
  }

  // Fund agents with the game asset if we have a funding account
  if (FUNDING_ACCOUNT_SECRET) {
    console.log(`\nFunding agents with ${ASSET_CODE}...\n`);

    for (const account of accounts.filter((a) => a.type === "agent")) {
      try {
        await sendAsset(FUNDING_ACCOUNT_SECRET, account.publicKey, STARTING_BUDGET);
        console.log(`  ✓ Funded ${account.name} with $${STARTING_BUDGET} ${ASSET_CODE}`);
      } catch (error) {
        console.error(`  Failed to fund ${account.name}: ${error}`);
      }

      await sleep(500);
    }
  } else {
    console.log("\n⚠️  No FUNDING_ACCOUNT_SECRET set.");
    console.log("   You need to manually fund agent accounts with the game asset.");
    console.log("   ");
  }

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("SETUP COMPLETE");
  console.log("=".repeat(60));
  console.log("\nAgent Accounts:");
  for (const account of accounts.filter((a) => a.type === "agent")) {
    const balance = await getAssetBalance(account.publicKey);
    console.log(`  ${account.name}: ${account.publicKey} ($${balance} ${ASSET_CODE})`);
  }

  console.log("\nNPC Service Accounts:");
  for (const account of accounts.filter((a) => a.type === "npc")) {
    console.log(`  ${account.name}: ${account.publicKey}`);
  }

  // Print .env additions
  console.log("\n" + "=".repeat(60));
  console.log("ADD TO YOUR .env FILE:");
  console.log("=".repeat(60));
  console.log();

  for (const npc of NPC_SERVICES) {
    const account = accounts.find((a) => a.id === npc.id);
    if (account) {
      console.log(`${npc.envVar}=${account.publicKey}`);
    }
  }

  console.log();
  console.log("# NPC Secret Keys (for receiving payments):");
  for (const npc of NPC_SERVICES) {
    const account = accounts.find((a) => a.id === npc.id);
    if (account) {
      console.log(`${npc.envVar.replace("_ADDRESS", "_SECRET")}=${account.secretKey}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run setup
setup().catch(console.error);
