import "dotenv/config";
import { d1 } from "../src/lib/d1-client.js";

async function main() {
  console.log("[smoke] testing D1 client...");

  const ping = await d1.first<{ one: number }>("SELECT 1 AS one");
  console.log("[smoke] SELECT 1 →", ping);

  const tables = await d1.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  console.log("[smoke] tables in D1:", tables.map((t) => t.name));

  const stmt = d1.prepare("SELECT COUNT(*) AS n FROM agents WHERE prestige > ?");
  const row = await stmt.get<{ n: number }>(0);
  console.log("[smoke] prepared stmt with bind →", row);

  const writeResult = await d1.run(
    "INSERT OR REPLACE INTO game_state (key, value) VALUES (?, ?)",
    "smoke_test_marker",
    new Date().toISOString()
  );
  console.log("[smoke] write result →", writeResult);

  const back = await d1.first<{ value: string }>(
    "SELECT value FROM game_state WHERE key = ?",
    "smoke_test_marker"
  );
  console.log("[smoke] read-back →", back);

  await d1.run("DELETE FROM game_state WHERE key = ?", "smoke_test_marker");
  console.log("[smoke] cleanup ok");

  console.log("[smoke] ALL GOOD ✓");
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
