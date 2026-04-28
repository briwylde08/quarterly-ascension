import "dotenv/config";
import { initDatabase, setGameStatus, setCurrentTick } from "../src/lib/db.js";
import { d1 } from "../src/lib/d1-client.js";

async function main() {
  await initDatabase();
  await setGameStatus("setup");
  await setCurrentTick(0);
  await d1.run("DELETE FROM events");
  await d1.run("DELETE FROM ticker");
  await d1.run("DELETE FROM action_logs");
  await d1.run(
    "UPDATE agents SET prestige = 0, status_effects = '[]', allies = '[]', pending_alliance = NULL"
  );
  console.log("Reset: status=setup, tick=0.");
  console.log("Cleared: events, ticker, action_logs.");
  console.log("Agent state reset: prestige=0, status_effects=[], allies=[], pending_alliance=null.");
  console.log("On-chain DLBR balances are untouched (agents keep whatever DLBR they had).");
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
