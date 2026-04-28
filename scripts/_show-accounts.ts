import "dotenv/config";
import { initDatabase, getAllAgents } from "../src/lib/db.js";
import { getExplorerAccountUrl, ASSET_ISSUER } from "../src/lib/stellar.js";

initDatabase();
console.log("Stellar Expert account links:\n");
console.log("ISSUER (DLBR):");
console.log(`  ${getExplorerAccountUrl(ASSET_ISSUER)}\n`);
console.log("AGENTS:");
for (const a of getAllAgents()) {
  console.log(`  ${a.name.padEnd(22)} ${getExplorerAccountUrl(a.publicKey)}`);
}
console.log("\nNPCs (from .env):");
const npcs = ["COFFEE_CART", "HR_DEPT", "CONSULTANT", "IT_GUY", "EXEC_ASSISTANT", "CATERER", "MOTIVATIONAL_SPEAKER"];
for (const npc of npcs) {
  const addr = process.env[`${npc}_ADDRESS`];
  if (addr) console.log(`  ${npc.padEnd(22)} ${getExplorerAccountUrl(addr)}`);
}
