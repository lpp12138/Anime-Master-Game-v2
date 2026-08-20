PRAGMA foreign_keys = ON;

-- Structural administrator edits (add/delete/reorder) can no longer preserve the
-- immutable per-submission ranges used by exact-title homepage appends. Detach such
-- sets from canonical append claiming while retaining their submission history for
-- idempotent retries.
ALTER TABLE question_sets
ADD COLUMN community_structure_edited INTEGER NOT NULL DEFAULT 0
CHECK (community_structure_edited IN (0, 1));
