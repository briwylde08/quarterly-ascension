import Database from "better-sqlite3";
import { Agent, GameEvent, StatusEffect, TickerEntry, GameStatus } from "./types.js";

const DB_PATH = process.env.DB_PATH || "game.db";
let db: Database.Database;

export function initDatabase(): void {
  db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS game_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      public_key TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      prestige INTEGER DEFAULT 0,
      status_effects TEXT DEFAULT '[]',
      allies TEXT DEFAULT '[]',
      pending_alliance TEXT,
      claimed_by TEXT,
      claimed_by_name TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      tick INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      agent_id TEXT,
      target_id TEXT,
      description TEXT NOT NULL,
      prestige_change INTEGER,
      tx_hash TEXT,
      settlement_time REAL
    );

    CREATE TABLE IF NOT EXISTS ticker (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      from_agent_name TEXT NOT NULL,
      to_service TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT,
      submitted_at INTEGER,
      settled_at INTEGER,
      settlement_time REAL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS action_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_data TEXT NOT NULL,
      reasoning TEXT,
      outcome TEXT,
      prestige_change INTEGER,
      tx_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_events_tick ON events(tick);
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_action_logs_tick ON action_logs(tick);
    CREATE INDEX IF NOT EXISTS idx_action_logs_agent ON action_logs(agent_id);
  `);
}

// Game state
export function getGameStatus(): GameStatus {
  const row = db.prepare("SELECT value FROM game_state WHERE key = 'status'").get() as { value: string } | undefined;
  return (row?.value as GameStatus) || "setup";
}

export function setGameStatus(status: GameStatus): void {
  db.prepare("INSERT OR REPLACE INTO game_state (key, value) VALUES ('status', ?)").run(status);
}

export function getCurrentTick(): number {
  const row = db.prepare("SELECT value FROM game_state WHERE key = 'current_tick'").get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

export function setCurrentTick(tick: number): void {
  db.prepare("INSERT OR REPLACE INTO game_state (key, value) VALUES ('current_tick', ?)").run(tick.toString());
}

// Agents
export function saveAgent(agent: Agent): void {
  db.prepare(`
    INSERT OR REPLACE INTO agents
    (id, persona_id, name, title, public_key, secret_key, prestige, status_effects, allies, pending_alliance, claimed_by, claimed_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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

export function getAgent(id: string): Agent | null {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
  if (!row) return null;

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

export function getAllAgents(): Agent[] {
  const rows = db.prepare("SELECT * FROM agents ORDER BY prestige DESC").all() as any[];
  return rows.map((row) => ({
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
  }));
}

export function updateAgentPrestige(id: string, delta: number): void {
  db.prepare("UPDATE agents SET prestige = prestige + ? WHERE id = ?").run(delta, id);
}

export function updateAgentStatusEffects(id: string, effects: StatusEffect[]): void {
  db.prepare("UPDATE agents SET status_effects = ? WHERE id = ?").run(JSON.stringify(effects), id);
}

export function updateAgentAllies(id: string, allies: string[]): void {
  db.prepare("UPDATE agents SET allies = ? WHERE id = ?").run(JSON.stringify(allies), id);
}

export function updateAgentPendingAlliance(id: string, pendingAlliance: string | null): void {
  db.prepare("UPDATE agents SET pending_alliance = ? WHERE id = ?").run(pendingAlliance, id);
}

export function claimAgent(agentId: string, email: string, name: string): boolean {
  const agent = getAgent(agentId);
  if (!agent || agent.claimedBy) return false;

  db.prepare("UPDATE agents SET claimed_by = ?, claimed_by_name = ? WHERE id = ?").run(email, name, agentId);
  return true;
}

// Events
export function saveEvent(event: GameEvent): void {
  db.prepare(`
    INSERT INTO events (id, tick, timestamp, type, agent_id, target_id, description, prestige_change, tx_hash, settlement_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.tick,
    event.timestamp.toISOString(),
    event.type,
    event.agentId,
    event.targetId,
    event.description,
    event.prestigeChange,
    event.txHash,
    event.settlementTime
  );
}

export function getEventsByTick(tick: number): GameEvent[] {
  const rows = db.prepare("SELECT * FROM events WHERE tick = ? ORDER BY timestamp").all(tick) as any[];
  return rows.map(rowToEvent);
}

export function getEventsByAgent(agentId: string, limit = 50): GameEvent[] {
  const rows = db.prepare("SELECT * FROM events WHERE agent_id = ? ORDER BY tick DESC LIMIT ?").all(agentId, limit) as any[];
  return rows.map(rowToEvent);
}

export function getRecentEvents(limit = 20): GameEvent[] {
  const rows = db.prepare("SELECT * FROM events ORDER BY tick DESC, timestamp DESC LIMIT ?").all(limit) as any[];
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
  };
}

// Ticker
export function saveTickerEntry(entry: TickerEntry): void {
  db.prepare(`
    INSERT OR REPLACE INTO ticker
    (id, from_agent, from_agent_name, to_service, amount, status, tx_hash, submitted_at, settled_at, settlement_time, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
    entry.error
  );
}

export function getRecentTickerEntries(limit = 20): TickerEntry[] {
  const rows = db.prepare(`
    SELECT * FROM ticker
    ORDER BY COALESCE(settled_at, submitted_at, 0) DESC
    LIMIT ?
  `).all(limit) as any[];

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
  }));
}

export function getTickerStats(): { total: number; amountMoved: number; avgSettlement: number } {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN amount ELSE 0 END), 0) as amount_moved,
      COALESCE(AVG(CASE WHEN status = 'settled' THEN settlement_time END), 0) as avg_settlement
    FROM ticker
  `).get() as any;

  return {
    total: row.total,
    amountMoved: row.amount_moved,
    avgSettlement: row.avg_settlement,
  };
}

// Action logs
export function logAction(
  tick: number,
  agentId: string,
  actionType: string,
  actionData: object,
  reasoning: string,
  outcome: string,
  prestigeChange: number,
  txHash?: string
): void {
  db.prepare(`
    INSERT INTO action_logs (tick, agent_id, action_type, action_data, reasoning, outcome, prestige_change, tx_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tick, agentId, actionType, JSON.stringify(actionData), reasoning, outcome, prestigeChange, txHash);
}

export function getAgentActionLogs(agentId: string, tickStart: number, tickEnd: number): any[] {
  return db.prepare(`
    SELECT * FROM action_logs
    WHERE agent_id = ? AND tick >= ? AND tick <= ?
    ORDER BY tick
  `).all(agentId, tickStart, tickEnd) as any[];
}

// Reset
export function resetDatabase(): void {
  db.exec(`
    DELETE FROM agents;
    DELETE FROM events;
    DELETE FROM ticker;
    DELETE FROM action_logs;
    DELETE FROM game_state;
  `);
}

export function closeDatabase(): void {
  db.close();
}

export { db };
