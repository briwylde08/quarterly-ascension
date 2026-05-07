-- Per-action directive feedback so coaches can see "did my agent listen?"
-- alignment: "followed" | "tilted" | "defied" | null (no directive at the time)
-- text snapshot: the directive verbatim at the moment the action fired,
-- so coaches can re-read what they had in flight.

ALTER TABLE action_logs ADD COLUMN directive_alignment TEXT;
ALTER TABLE action_logs ADD COLUMN directive_at_action TEXT;
