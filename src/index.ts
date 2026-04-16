import "dotenv/config";
import express from "express";
import { initDatabase, getGameStatus, setGameStatus, getCurrentTick } from "./lib/db.js";
import { processTick, onGameEvent } from "./orchestrator/tick.js";
import { createAdminRouter } from "./orchestrator/admin.js";
import { startDisplayServer } from "./display/server.js";
import { sendHourlyReports, sendGameEndSummary } from "./lib/email.js";
import { onTickerUpdate } from "./lib/mpp-client.js";

const PORT = process.env.PORT || 3000;
const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS || "300000", 10); // 5 minutes default
const TICKS_PER_REPORT = 12; // Send report every 12 ticks (1 hour at 5min ticks)
const MAX_TICKS = parseInt(process.env.MAX_TICKS || "48", 10); // 4 hours default

let tickInterval: NodeJS.Timeout | null = null;
let lastReportTick = 0;

async function main() {
  console.log("=".repeat(60));
  console.log("QUARTERLY ASCENSION");
  console.log("=".repeat(60));
  console.log();

  // Initialize database
  console.log("Initializing database...");
  initDatabase();

  // Create Express app for admin API
  const app = express();
  app.use(express.json());

  // Admin routes
  app.use("/admin", createAdminRouter());

  // Health check
  app.get("/health", (req, res) => {
    res.json({
      status: getGameStatus(),
      tick: getCurrentTick(),
      uptime: process.uptime(),
    });
  });

  // Start admin API server
  app.listen(PORT, () => {
    console.log(`Admin API running on http://localhost:${PORT}`);
  });

  // Start display server
  startDisplayServer();

  // Subscribe to events for logging
  onGameEvent((event) => {
    console.log(`[Event] ${event.type}: ${event.description}`);
  });

  onTickerUpdate((entry) => {
    const status = entry.status === "settled" ? "✓" : entry.status === "failed" ? "✗" : "⏳";
    console.log(`[Payment] ${status} ${entry.fromAgentName} → ${entry.toService}: $${entry.amount}`);
  });

  console.log("\nReady. Use the admin API to start the game:");
  console.log(`  curl -X POST http://localhost:${PORT}/admin/start -H "Authorization: Bearer \${ADMIN_SECRET}"`);
  console.log("\nOr start automatically...\n");

  // Auto-start after 5 seconds (for development)
  setTimeout(() => {
    const status = getGameStatus();
    if (status === "setup") {
      startGame();
    }
  }, 5000);
}

/**
 * Start the game
 */
function startGame() {
  console.log("\n" + "=".repeat(60));
  console.log("GAME STARTING");
  console.log("=".repeat(60) + "\n");

  setGameStatus("running");

  // Start tick loop
  tickInterval = setInterval(async () => {
    const status = getGameStatus();

    if (status !== "running") {
      return;
    }

    const tick = getCurrentTick();

    // Check if game should end
    if (tick >= MAX_TICKS) {
      endGame();
      return;
    }

    // Process tick
    try {
      await processTick();
    } catch (error) {
      console.error("Tick processing error:", error);
    }

    // Check if we should send reports
    const currentTick = getCurrentTick();
    if (currentTick - lastReportTick >= TICKS_PER_REPORT) {
      try {
        await sendHourlyReports(lastReportTick + 1, currentTick);
        lastReportTick = currentTick;
      } catch (error) {
        console.error("Report sending error:", error);
      }
    }
  }, TICK_INTERVAL_MS);

  // Process first tick immediately
  processTick().catch(console.error);
}

/**
 * End the game
 */
async function endGame() {
  console.log("\n" + "=".repeat(60));
  console.log("GAME ENDING");
  console.log("=".repeat(60) + "\n");

  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }

  setGameStatus("ended");

  // Send final reports
  try {
    await sendHourlyReports(lastReportTick + 1, getCurrentTick());
    await sendGameEndSummary();
  } catch (error) {
    console.error("Final report error:", error);
  }

  // Print final standings
  const { getAllAgents } = await import("./lib/db.js");
  const agents = getAllAgents().sort((a, b) => b.prestige - a.prestige);

  console.log("\nFINAL STANDINGS:");
  console.log("-".repeat(40));
  agents.forEach((agent, i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  ";
    console.log(`${medal} #${i + 1} ${agent.name}: ${agent.prestige} prestige`);
  });

  console.log("\n" + "=".repeat(60));
  console.log(`🏆 ${agents[0].name} IS THE NEW VP OF QUARTERLY ASCENSION! 🏆`);
  console.log("=".repeat(60) + "\n");
}

// Handle shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  if (tickInterval) {
    clearInterval(tickInterval);
  }
  process.exit(0);
});

// Run
main().catch(console.error);
