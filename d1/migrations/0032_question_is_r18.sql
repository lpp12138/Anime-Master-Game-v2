PRAGMA foreign_keys = ON;

-- Per-question adult-content flag (isR18). Each question/screenshot carries its
-- own boolean instead of the whole question set: the community screenshot
-- collection may accumulate beyond 30 questions and mix titles, so a single
-- collection-level flag would be wrong. Historical rows default to false and
-- keep their existing manifest/index content untouched.
--
-- The flag lives in both storage forms:
--   * questions            : legacy (non-manifest) question rows;
--   * question_image_index : canonical per-image index for homepage sets.
-- Manifest-backed sets store the flag inside manifest_json (additive field,
-- missing means false), and the per-image index row mirrors it for the admin
-- and community image-index reads. All single-question admin mutations rewrite
-- the full index, so the two stay in sync; append/finalize writes both in the
-- same D1 batch.
ALTER TABLE questions
ADD COLUMN is_r18 INTEGER NOT NULL DEFAULT 0
CHECK (is_r18 IN (0, 1));

ALTER TABLE question_image_index
ADD COLUMN is_r18 INTEGER NOT NULL DEFAULT 0
CHECK (is_r18 IN (0, 1));
