import "dotenv/config";
import { getAssetBalance, ASSET_CODE } from "../src/lib/stellar.js";
import { initDatabase, getAllAgents } from "../src/lib/db.js";

async function main() {
  await initDatabase();
  for (const agent of await getAllAgents()) {
    const bal = await getAssetBalance(agent.publicKey);
    console.log(`${agent.name}: ${bal} ${ASSET_CODE} (${agent.publicKey.slice(0, 8)}...)`);
  }
}

main();
