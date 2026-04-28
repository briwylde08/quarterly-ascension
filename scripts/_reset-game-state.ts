import "dotenv/config";
import { initDatabase, setGameStatus, setCurrentTick, db } from "../src/lib/db.js";

initDatabase();
setGameStatus("setup");
setCurrentTick(0);
db.exec(`
  DELETE FROM events;
  DELETE FROM ticker;
  DELETE FROM action_logs;
  UPDATE agents SET
    prestige = 0,
    status_effects = '[]',
    allies = '[]',
    pending_alliance = NULL;
`);
console.log("Reset: status=setup, tick=0.");
console.log("Cleared: events, ticker, action_logs.");
console.log("Agent state reset: prestige=0, status_effects=[], allies=[], pending_alliance=null.");
console.log("On-chain DLBR balances are untouched (agents keep whatever DLBR they had).");
