// One-shot importer: copy every row from the local SQLite game.db into D1.
//
// Used once during the Phase 2 migration to preserve the agents' on-chain
// keypairs (re-running setup.ts would generate fresh keypairs and invalidate
// the funded testnet accounts). After this script succeeds, game.db is
// cosmetic and can be deleted.

import "dotenv/config";
import Database from "better-sqlite3";
import { d1 } from "../src/lib/d1-client.js";

const SRC = process.env.SRC_DB_PATH || "game.db";

interface AgentRow {
  id: string;
  persona_id: string;
  name: string;
  title: string;
  public_key: string;
  secret_key: string;
  prestige: number;
  status_effects: string;
  allies: string;
  pending_alliance: string | null;
  claimed_by: string | null;
  claimed_by_name: string | null;
}

interface GameStateRow {
  key: string;
  value: string;
}

interface EventRow {
  id: string;
  tick: number;
  timestamp: string;
  type: string;
  agent_id: string | null;
  target_id: string | null;
  description: string;
  prestige_change: number | null;
  tx_hash: string | null;
  settlement_time: number | null;
  reasoning: string | null;
}

interface TickerRow {
  id: string;
  from_agent: string;
  from_agent_name: string;
  to_service: string;
  amount: number;
  status: string;
  tx_hash: string | null;
  submitted_at: number | null;
  settled_at: number | null;
  settlement_time: number | null;
  error: string | null;
  reasoning: string | null;
}

interface ActionLogRow {
  id: number;
  tick: number;
  agent_id: string;
  action_type: string;
  action_data: string;
  reasoning: string | null;
  outcome: string | null;
  prestige_change: number | null;
  tx_hash: string | null;
  created_at: string;
}

async function main() {
  const src = new Database(SRC, { readonly: true });
  console.log(`[migrate] reading from ${SRC}\n`);

  // game_state
  const gameState = src.prepare("SELECT * FROM game_state").all() as GameStateRow[];
  console.log(`[migrate] game_state: ${gameState.length} rows`);
  for (const row of gameState) {
    await d1.run(
      "INSERT OR REPLACE INTO game_state (key, value) VALUES (?, ?)",
      row.key,
      row.value
    );
  }

  // agents
  const agents = src.prepare("SELECT * FROM agents").all() as AgentRow[];
  console.log(`[migrate] agents: ${agents.length} rows`);
  for (const row of agents) {
    await d1.run(
      `INSERT OR REPLACE INTO agents
         (id, persona_id, name, title, public_key, secret_key, prestige, status_effects, allies, pending_alliance, claimed_by, claimed_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.persona_id,
      row.name,
      row.title,
      row.public_key,
      row.secret_key,
      row.prestige,
      row.status_effects,
      row.allies,
      row.pending_alliance,
      row.claimed_by,
      row.claimed_by_name
    );
  }

  // events
  const events = src.prepare("SELECT * FROM events").all() as EventRow[];
  console.log(`[migrate] events: ${events.length} rows`);
  for (const row of events) {
    await d1.run(
      `INSERT OR REPLACE INTO events (id, tick, timestamp, type, agent_id, target_id, description, prestige_change, tx_hash, settlement_time, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.tick,
      row.timestamp,
      row.type,
      row.agent_id,
      row.target_id,
      row.description,
      row.prestige_change,
      row.tx_hash,
      row.settlement_time,
      row.reasoning
    );
  }

  // ticker
  const ticker = src.prepare("SELECT * FROM ticker").all() as TickerRow[];
  console.log(`[migrate] ticker: ${ticker.length} rows`);
  for (const row of ticker) {
    await d1.run(
      `INSERT OR REPLACE INTO ticker
         (id, from_agent, from_agent_name, to_service, amount, status, tx_hash, submitted_at, settled_at, settlement_time, error, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.from_agent,
      row.from_agent_name,
      row.to_service,
      row.amount,
      row.status,
      row.tx_hash,
      row.submitted_at,
      row.settled_at,
      row.settlement_time,
      row.error,
      row.reasoning
    );
  }

  // action_logs (let D1 assign IDs since they're AUTOINCREMENT)
  const actionLogs = src.prepare("SELECT * FROM action_logs").all() as ActionLogRow[];
  console.log(`[migrate] action_logs: ${actionLogs.length} rows`);
  for (const row of actionLogs) {
    await d1.run(
      `INSERT INTO action_logs (tick, agent_id, action_type, action_data, reasoning, outcome, prestige_change, tx_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.tick,
      row.agent_id,
      row.action_type,
      row.action_data,
      row.reasoning,
      row.outcome,
      row.prestige_change,
      row.tx_hash,
      row.created_at
    );
  }

  src.close();
  console.log("\n[migrate] DONE");
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
