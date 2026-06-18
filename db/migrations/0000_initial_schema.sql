-- Quarterly Ascension — initial D1 schema
-- Ported 1:1 from src/lib/db.ts CREATE TABLE statements (with reasoning columns
-- inlined since those were retroactive ALTER TABLEs in the SQLite version).

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
  settlement_time REAL,
  reasoning TEXT
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
  error TEXT,
  reasoning TEXT
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

CREATE INDEX IF NOT EXISTS idx_events_tick       ON events(tick);
CREATE INDEX IF NOT EXISTS idx_events_agent      ON events(agent_id);
CREATE INDEX IF NOT EXISTS idx_action_logs_tick  ON action_logs(tick);
CREATE INDEX IF NOT EXISTS idx_action_logs_agent ON action_logs(agent_id);
