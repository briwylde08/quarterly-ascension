import { d1 } from "./d1-client.js";
import { Agent, GameEvent, StatusEffect, TickerEntry, GameStatus } from "./types.js";

// Phase 2 of the Cloudflare migration: persistence is on D1, accessed over
// HTTPS via the async client in d1-client.ts. The schema lives in
// cloud/db/migrations/*.sql and is applied with `wrangler d1 execute`, so
// this file no longer owns DDL — it's purely query helpers.
//
// Phase 3 will move the orchestrator into a Durable Object with a direct D1
// binding; at that point this file gets rewritten again to use the binding
// instead of the HTTP client.

export async function initDatabase(): Promise<void> {
  // Schema is applied via `wrangler d1 execute --file db/migrations/*.sql`.
  // Nothing to do at runtime, but keep the function so callers don't all
  // need to change at once.
}

export async function closeDatabase(): Promise<void> {
  // No persistent connection to close — every query is a stateless HTTP POST.
}

// Game state
export async function getGameStatus(): Promise<GameStatus> {
  const row = await d1.first<{ value: string }>(
    "SELECT value FROM game_state WHERE key = 'status'"
  );
  return (row?.value as GameStatus) || "setup";
}

export async function setGameStatus(status: GameStatus): Promise<void> {
  await d1.run(
    "INSERT OR REPLACE INTO game_state (key, value) VALUES ('status', ?)",
    status
  );
}

export async function getCurrentTick(): Promise<number> {
  const row = await d1.first<{ value: string }>(
    "SELECT value FROM game_state WHERE key = 'current_tick'"
  );
  return row ? parseInt(row.value, 10) : 0;
}

export async function setCurrentTick(tick: number): Promise<void> {
  await d1.run(
    "INSERT OR REPLACE INTO game_state (key, value) VALUES ('current_tick', ?)",
    tick.toString()
  );
}

// Agents
export async function saveAgent(agent: Agent): Promise<void> {
  await d1.run(
    `INSERT OR REPLACE INTO agents
       (id, persona_id, name, title, public_key, secret_key, prestige, status_effects, allies, pending_alliance, claimed_by, claimed_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agent.id,
    agent.personaId,
    agent.name,
    agent.title,
    agent.publicKey,
    agent.secretKey,
    agent.prestige,
    JSON.stringify(agent.statusEffects),
    JSON.stringify(agent.allies),
    agent.pendingAlliance,
    agent.claimedBy,
    agent.claimedByName
  );
}

export async function getAgent(id: string): Promise<Agent | null> {
  const row = await d1.first<any>("SELECT * FROM agents WHERE id = ?", id);
  if (!row) return null;
  return rowToAgent(row);
}

export async function getAllAgents(): Promise<Agent[]> {
  const rows = await d1.all<any>("SELECT * FROM agents ORDER BY prestige DESC");
  return rows.map(rowToAgent);
}

function rowToAgent(row: any): Agent {
  return {
    id: row.id,
    personaId: row.persona_id,
    name: row.name,
    title: row.title,
    publicKey: row.public_key,
    secretKey: row.secret_key,
    prestige: row.prestige,
    statusEffects: JSON.parse(row.status_effects),
    allies: JSON.parse(row.allies),
    pendingAlliance: row.pending_alliance,
    claimedBy: row.claimed_by,
    claimedByName: row.claimed_by_name,
  };
}

export async function updateAgentPrestige(id: string, delta: number): Promise<void> {
  await d1.run("UPDATE agents SET prestige = prestige + ? WHERE id = ?", delta, id);
}

export async function updateAgentStatusEffects(
  id: string,
  effects: StatusEffect[]
): Promise<void> {
  await d1.run(
    "UPDATE agents SET status_effects = ? WHERE id = ?",
    JSON.stringify(effects),
    id
  );
}

export async function updateAgentAllies(id: string, allies: string[]): Promise<void> {
  await d1.run(
    "UPDATE agents SET allies = ? WHERE id = ?",
    JSON.stringify(allies),
    id
  );
}

export async function updateAgentPendingAlliance(
  id: string,
  pendingAlliance: string | null
): Promise<void> {
  await d1.run(
    "UPDATE agents SET pending_alliance = ? WHERE id = ?",
    pendingAlliance,
    id
  );
}

export async function claimAgent(
  agentId: string,
  email: string,
  name: string
): Promise<boolean> {
  const agent = await getAgent(agentId);
  if (!agent || agent.claimedBy) return false;

  await d1.run(
    "UPDATE agents SET claimed_by = ?, claimed_by_name = ? WHERE id = ?",
    email,
    name,
    agentId
  );
  return true;
}

// Events
export async function saveEvent(event: GameEvent): Promise<void> {
  await d1.run(
    `INSERT INTO events (id, tick, timestamp, type, agent_id, target_id, description, prestige_change, tx_hash, settlement_time, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.tick,
    event.timestamp.toISOString(),
    event.type,
    event.agentId,
    event.targetId,
    event.description,
    event.prestigeChange,
    event.txHash,
    event.settlementTime,
    event.reasoning
  );
}

export async function getEventsByTick(tick: number): Promise<GameEvent[]> {
  const rows = await d1.all<any>(
    "SELECT * FROM events WHERE tick = ? ORDER BY timestamp",
    tick
  );
  return rows.map(rowToEvent);
}

export async function getEventsByAgent(agentId: string, limit = 50): Promise<GameEvent[]> {
  const rows = await d1.all<any>(
    "SELECT * FROM events WHERE agent_id = ? ORDER BY tick DESC LIMIT ?",
    agentId,
    limit
  );
  return rows.map(rowToEvent);
}

export async function getRecentEvents(limit = 20): Promise<GameEvent[]> {
  const rows = await d1.all<any>(
    "SELECT * FROM events ORDER BY tick DESC, timestamp DESC LIMIT ?",
    limit
  );
  return rows.map(rowToEvent);
}

function rowToEvent(row: any): GameEvent {
  return {
    id: row.id,
    tick: row.tick,
    timestamp: new Date(row.timestamp),
    type: row.type,
    agentId: row.agent_id,
    targetId: row.target_id,
    description: row.description,
    prestigeChange: row.prestige_change,
    txHash: row.tx_hash,
    settlementTime: row.settlement_time,
    reasoning: row.reasoning,
  };
}

// Ticker
export async function saveTickerEntry(entry: TickerEntry): Promise<void> {
  await d1.run(
    `INSERT INTO ticker
       (id, from_agent, from_agent_name, to_service, amount, status, tx_hash, submitted_at, settled_at, settlement_time, error, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       amount          = excluded.amount,
       status          = excluded.status,
       tx_hash         = COALESCE(excluded.tx_hash, ticker.tx_hash),
       submitted_at    = COALESCE(excluded.submitted_at, ticker.submitted_at),
       settled_at      = COALESCE(excluded.settled_at, ticker.settled_at),
       settlement_time = COALESCE(excluded.settlement_time, ticker.settlement_time),
       error           = COALESCE(excluded.error, ticker.error),
       reasoning       = COALESCE(excluded.reasoning, ticker.reasoning)`,
    entry.id,
    entry.fromAgent,
    entry.fromAgentName,
    entry.toService,
    entry.amount,
    entry.status,
    entry.txHash,
    entry.submittedAt,
    entry.settledAt,
    entry.settlementTime,
    entry.error,
    entry.reasoning
  );
}

export async function getRecentTickerEntries(limit = 20): Promise<TickerEntry[]> {
  const rows = await d1.all<any>(
    `SELECT * FROM ticker
     ORDER BY COALESCE(settled_at, submitted_at, 0) DESC
     LIMIT ?`,
    limit
  );

  return rows.map((row) => ({
    id: row.id,
    fromAgent: row.from_agent,
    fromAgentName: row.from_agent_name,
    toService: row.to_service,
    amount: row.amount,
    status: row.status,
    txHash: row.tx_hash,
    submittedAt: row.submitted_at,
    settledAt: row.settled_at,
    settlementTime: row.settlement_time,
    error: row.error,
    reasoning: row.reasoning,
  }));
}

export async function getTickerStats(): Promise<{
  total: number;
  amountMoved: number;
  avgSettlement: number;
}> {
  const row = await d1.first<any>(
    `SELECT
       COUNT(*) as total,
       COALESCE(SUM(CASE WHEN status = 'settled' THEN amount ELSE 0 END), 0) as amount_moved,
       COALESCE(AVG(CASE WHEN status = 'settled' THEN settlement_time END), 0) as avg_settlement
     FROM ticker`
  );

  return {
    total: row?.total ?? 0,
    amountMoved: row?.amount_moved ?? 0,
    avgSettlement: row?.avg_settlement ?? 0,
  };
}

// Action logs
export async function logAction(
  tick: number,
  agentId: string,
  actionType: string,
  actionData: object,
  reasoning: string,
  outcome: string,
  prestigeChange: number,
  txHash?: string
): Promise<void> {
  await d1.run(
    `INSERT INTO action_logs (tick, agent_id, action_type, action_data, reasoning, outcome, prestige_change, tx_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    tick,
    agentId,
    actionType,
    JSON.stringify(actionData),
    reasoning,
    outcome,
    prestigeChange,
    txHash
  );
}

export async function getAgentActionLogs(
  agentId: string,
  tickStart: number,
  tickEnd: number
): Promise<any[]> {
  return d1.all<any>(
    `SELECT * FROM action_logs
     WHERE agent_id = ? AND tick >= ? AND tick <= ?
     ORDER BY tick`,
    agentId,
    tickStart,
    tickEnd
  );
}

// Reset
export async function resetDatabase(): Promise<void> {
  // D1's /query endpoint takes one statement at a time when there are
  // bindings; for parameterless DDL/DML we can submit them sequentially.
  await d1.run("DELETE FROM agents");
  await d1.run("DELETE FROM events");
  await d1.run("DELETE FROM ticker");
  await d1.run("DELETE FROM action_logs");
  await d1.run("DELETE FROM game_state");
}
