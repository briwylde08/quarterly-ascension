-- Retreat mode: persistent coach directives.
-- Each manager has at most one active directive at a time, set by their
-- claimer at any tick. Persists across cycles until overwritten or cleared.
-- Capped at 280 chars at the API boundary.

ALTER TABLE agents ADD COLUMN directive TEXT;
