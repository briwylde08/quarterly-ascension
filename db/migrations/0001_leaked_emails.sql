-- Phase 5 (game mechanics): persisted leaked emails.
-- When the Email Leak random event fires, we generate a fake email between
-- the victim and another agent and write it here. Future LLM prompts pull
-- the most recent N emails as "Public Knowledge from leaks" so the leak
-- has lasting influence on agent decisions.

CREATE TABLE IF NOT EXISTS leaked_emails (
  id TEXT PRIMARY KEY,
  tick INTEGER NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leaked_emails_tick ON leaked_emails(tick);
