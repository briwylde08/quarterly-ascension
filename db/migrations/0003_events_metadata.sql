-- Persist event metadata that lives on the GameEvent type but was being
-- silently dropped at saveEvent time. Without these, page refreshes pull
-- /api/state which returns events without parentEventId, so child events
-- (Hit the Wall per-agent rows, alliance children, etc.) render as
-- standalone rows instead of nested under their parent.

ALTER TABLE events ADD COLUMN parent_event_id TEXT;
ALTER TABLE events ADD COLUMN action_type TEXT;
ALTER TABLE events ADD COLUMN target_name TEXT;
ALTER TABLE events ADD COLUMN action_detail TEXT;
