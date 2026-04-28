import "dotenv/config";
import { initDatabase, getRecentTickerEntries } from "../src/lib/db.js";
import { getExplorerTxUrl } from "../src/lib/stellar.js";

async function main() {
  await initDatabase();
  const entries = (await getRecentTickerEntries(50))
    .filter((e) => e.status === "settled" && e.txHash)
    .reverse(); // chronological

  if (entries.length === 0) {
    console.log("No settled transactions yet.");
  } else {
    console.log(`Settled transactions (${entries.length}):\n`);
    for (const e of entries) {
      const time = e.settlementTime ? `${e.settlementTime.toFixed(1)}s` : "?";
      console.log(`${e.fromAgentName} → ${e.toService}: $${e.amount}`);
      console.log(`  tx:   ${e.txHash}`);
      console.log(`  link: ${getExplorerTxUrl(e.txHash!)}`);
      console.log(`  settled in ${time}`);
      console.log();
    }
  }
}

main().catch(console.error);
