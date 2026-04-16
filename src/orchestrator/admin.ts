import express, { Request, Response, NextFunction } from "express";
import { getGameStatus, setGameStatus, getCurrentTick } from "../lib/db.js";
import { setGameHalted } from "../services/base.js";
import { onGameEvent } from "./tick.js";
import { GameEvent } from "../lib/types.js";
import { v4 as uuid } from "uuid";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin-secret";

/**
 * Middleware to check admin authentication
 */
function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization header" });
    return;
  }

  const token = authHeader.split(" ")[1];
  if (token !== ADMIN_SECRET) {
    res.status(403).json({ error: "Invalid admin token" });
    return;
  }

  next();
}

/**
 * Create admin router
 */
export function createAdminRouter() {
  const router = express.Router();

  // All admin routes require authentication
  router.use(adminAuth);

  /**
   * GET /admin/status
   * Get current game status
   */
  router.get("/status", (req, res) => {
    res.json({
      status: getGameStatus(),
      tick: getCurrentTick(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * POST /admin/halt
   * Halt the game
   */
  router.post("/halt", (req, res) => {
    const currentStatus = getGameStatus();

    if (currentStatus === "halted") {
      res.status(400).json({ error: "Game is already halted" });
      return;
    }

    if (currentStatus !== "running") {
      res.status(400).json({ error: `Cannot halt game in ${currentStatus} state` });
      return;
    }

    setGameStatus("halted");
    setGameHalted(true);

    const tick = getCurrentTick();

    // Emit halt event
    const event: GameEvent = {
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: "game_halted",
      description: "Game halted by admin",
    };

    // Would emit this through the event system
    console.log(`Game halted at tick ${tick}`);

    res.json({
      status: "halted",
      tick,
      timestamp: new Date().toISOString(),
      state: "preserved",
    });
  });

  /**
   * POST /admin/resume
   * Resume the game
   */
  router.post("/resume", (req, res) => {
    const currentStatus = getGameStatus();

    if (currentStatus !== "halted") {
      res.status(400).json({ error: `Cannot resume game in ${currentStatus} state` });
      return;
    }

    setGameStatus("running");
    setGameHalted(false);

    const tick = getCurrentTick();

    // Emit resume event
    const event: GameEvent = {
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: "game_resumed",
      description: "Game resumed by admin",
    };

    console.log(`Game resumed at tick ${tick}`);

    res.json({
      status: "running",
      tick,
      resumedAt: new Date().toISOString(),
    });
  });

  /**
   * POST /admin/end
   * End the game
   */
  router.post("/end", (req, res) => {
    const currentStatus = getGameStatus();

    if (currentStatus === "ended") {
      res.status(400).json({ error: "Game has already ended" });
      return;
    }

    setGameStatus("ended");
    setGameHalted(true);

    const tick = getCurrentTick();

    // Emit end event
    const event: GameEvent = {
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: "game_end",
      description: "Game ended by admin",
    };

    console.log(`Game ended at tick ${tick}`);

    res.json({
      status: "ended",
      tick,
      endedAt: new Date().toISOString(),
    });
  });

  /**
   * POST /admin/inject-event
   * Inject a custom event
   */
  router.post("/inject-event", (req, res) => {
    const { type, description, agentId, targetId, prestigeChange } = req.body;

    if (!description) {
      res.status(400).json({ error: "Missing description" });
      return;
    }

    const tick = getCurrentTick();

    const event: GameEvent = {
      id: uuid(),
      tick,
      timestamp: new Date(),
      type: type || "random_event",
      description,
      agentId,
      targetId,
      prestigeChange,
    };

    // Would emit through event system
    console.log(`Injected event: ${description}`);

    res.json({
      success: true,
      event,
    });
  });

  return router;
}
