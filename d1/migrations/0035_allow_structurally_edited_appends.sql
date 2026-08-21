PRAGMA foreign_keys = ON;

-- A structurally edited community set may be selected explicitly by ID and
-- continue receiving new submissions. Historical submission ranges describe
-- where each submission was inserted at that time; after an administrator
-- deletes/reorders questions, a later append can legitimately reuse the same
-- current start_order_index. Keep submission IDs unique for idempotency, but
-- remove the obsolete UNIQUE(question_set_id, start_order_index) restriction.
CREATE TABLE IF NOT EXISTS community_question_set_submissions_v3 (
  submission_id TEXT PRIMARY KEY,
  submission_fingerprint TEXT NOT NULL,
  question_set_id TEXT NOT NULL,
  start_order_index INTEGER NOT NULL,
  added_image_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE CASCADE,
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

INSERT INTO community_question_set_submissions_v3 (
  submission_id, submission_fingerprint, question_set_id,
  start_order_index, added_image_count, created_at
)
SELECT
  submission_id, submission_fingerprint, question_set_id,
  start_order_index, added_image_count, created_at
FROM community_question_set_submissions;

DROP TABLE community_question_set_submissions;
ALTER TABLE community_question_set_submissions_v3 RENAME TO community_question_set_submissions;

CREATE INDEX IF NOT EXISTS community_question_set_submissions_set_idx
  ON community_question_set_submissions(question_set_id, start_order_index);
