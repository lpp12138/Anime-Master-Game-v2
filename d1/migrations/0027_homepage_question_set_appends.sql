PRAGMA foreign_keys = ON;

-- A homepage upload title identifies one canonical collection. Historical uploads may
-- contain duplicate titles, so only the newest compatible set for each title is
-- claimed during backfill; the other historical sets remain readable and unchanged.
ALTER TABLE question_sets ADD COLUMN community_collection_title TEXT
  CHECK (community_collection_title IS NULL OR (
    community_collection_title = title
    AND length(trim(community_collection_title)) BETWEEN 1 AND 80
  ));

WITH ranked_homepage_sets AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY title
      ORDER BY created_at DESC, id DESC
    ) AS title_rank
  FROM question_sets
  WHERE is_public = 1
    AND community_submission_id IS NOT NULL
    AND manifest_version = 1
    AND length(trim(title)) BETWEEN 1 AND 80
)
UPDATE question_sets
SET community_collection_title = title
WHERE id IN (
  SELECT id
  FROM ranked_homepage_sets
  WHERE title_rank = 1
);

CREATE UNIQUE INDEX IF NOT EXISTS question_sets_community_collection_title_unique
  ON question_sets(community_collection_title)
  WHERE community_collection_title IS NOT NULL;

-- Submission identity can no longer live only on question_sets because many
-- independently retried submissions can append to one set. Each submission remains
-- content-bound and records the immutable range that it added.
CREATE TABLE IF NOT EXISTS community_question_set_submissions (
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
  CHECK (start_order_index >= 0 AND start_order_index < 30),
  CHECK (added_image_count >= 1 AND added_image_count <= 30),
  CHECK (start_order_index + added_image_count <= 30)
);

CREATE INDEX IF NOT EXISTS community_question_set_submissions_set_idx
  ON community_question_set_submissions(question_set_id, start_order_index);

INSERT OR IGNORE INTO community_question_set_submissions (
  submission_id,
  submission_fingerprint,
  question_set_id,
  start_order_index,
  added_image_count,
  created_at
)
SELECT
  community_submission_id,
  community_submission_fingerprint,
  id,
  0,
  image_count,
  created_at
FROM question_sets
WHERE community_submission_id IS NOT NULL
  AND community_submission_fingerprint IS NOT NULL
  AND image_count BETWEEN 1 AND 30;
