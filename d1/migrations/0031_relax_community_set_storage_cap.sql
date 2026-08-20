PRAGMA foreign_keys = ON;

-- Community screenshot collections are no longer capped at 30 questions in
-- total. The per-upload cap (1..30 per submission), the per-game cap (1..30
-- questions per game) and the request/image size limits stay unchanged, but a
-- same-title canonical collection may now accumulate beyond 30 questions.
--
-- SQLite cannot ALTER a CHECK constraint, so the two storage tables that
-- carried the cumulative 30 cap are rebuilt:
--   * question_image_index       : drop CHECK (order_index < 30), keep order_index >= 0;
--   * community_question_set_submissions : drop CHECK (start_order_index < 30) and
--     CHECK (start_order_index + added_image_count <= 30), keep the per-submission
--     cap (added_image_count BETWEEN 1 AND 30) and start_order_index >= 0.
--
-- The rebuild copies all rows, so existing history is preserved unchanged.
-- Table names/columns and constraints other than the removed caps are identical,
-- which keeps the game, admin and submission-idempotency code paths unchanged.

-- 1) Per-image Bangumi tag index: allow order_index >= 30 for accumulated sets.
CREATE TABLE IF NOT EXISTS question_image_index_v2 (
  question_id TEXT PRIMARY KEY,
  question_set_id TEXT NOT NULL,
  image_url TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  anime_subject_id INTEGER,
  anime_tags_json TEXT NOT NULL DEFAULT '[]',
  character_tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE CASCADE,
  UNIQUE (question_set_id, order_index),
  CHECK (length(trim(answer_text)) BETWEEN 1 AND 100),
  CHECK (length(image_url) BETWEEN 1 AND 2048),
  CHECK (order_index >= 0),
  CHECK (anime_subject_id IS NULL OR anime_subject_id > 0),
  CHECK (json_valid(anime_tags_json) AND json_type(anime_tags_json) = 'array'),
  CHECK (json_valid(character_tags_json) AND json_type(character_tags_json) = 'array'),
  CHECK (json_array_length(anime_tags_json) <= 1),
  CHECK (json_array_length(character_tags_json) <= 8),
  CHECK ((anime_subject_id IS NULL AND json_array_length(anime_tags_json) = 0)
      OR (anime_subject_id IS NOT NULL AND json_array_length(anime_tags_json) = 1)),
  CHECK (json_array_length(character_tags_json) = 0 OR anime_subject_id IS NOT NULL)
);

INSERT INTO question_image_index_v2 (
  question_id, question_set_id, image_url, answer_text, order_index,
  anime_subject_id, anime_tags_json, character_tags_json, created_at
)
SELECT
  question_id, question_set_id, image_url, answer_text, order_index,
  anime_subject_id, anime_tags_json, character_tags_json, created_at
FROM question_image_index;

DROP TABLE question_image_index;
ALTER TABLE question_image_index_v2 RENAME TO question_image_index;

CREATE INDEX IF NOT EXISTS question_image_index_anime_idx
  ON question_image_index(anime_subject_id, created_at DESC, question_id DESC)
  WHERE anime_subject_id IS NOT NULL;

-- 2) Submission ranges: each submission still adds 1..30 questions, but the
-- cumulative collection size is no longer bounded.
CREATE TABLE IF NOT EXISTS community_question_set_submissions_v2 (
  submission_id TEXT PRIMARY KEY,
  submission_fingerprint TEXT NOT NULL,
  question_set_id TEXT NOT NULL,
  start_order_index INTEGER NOT NULL,
  added_image_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE CASCADE,
  UNIQUE (question_set_id, start_order_index),
  CHECK (
    length(submission_id) BETWEEN 16 AND 160
    AND submission_id NOT GLOB '*[^a-zA-Z0-9_-]*'
  ),
  CHECK (
    length(submission_fingerprint) = 64
    AND submission_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (start_order_index >= 0),
  CHECK (added_image_count >= 1 AND added_image_count <= 30)
);

INSERT INTO community_question_set_submissions_v2 (
  submission_id, submission_fingerprint, question_set_id,
  start_order_index, added_image_count, created_at
)
SELECT
  submission_id, submission_fingerprint, question_set_id,
  start_order_index, added_image_count, created_at
FROM community_question_set_submissions;

DROP TABLE community_question_set_submissions;
ALTER TABLE community_question_set_submissions_v2 RENAME TO community_question_set_submissions;

CREATE INDEX IF NOT EXISTS community_question_set_submissions_set_idx
  ON community_question_set_submissions(question_set_id, start_order_index);
