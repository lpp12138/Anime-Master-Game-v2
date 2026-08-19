PRAGMA foreign_keys = ON;

-- A client-stable opaque ID makes finalize idempotent when its success response is
-- lost. Its server-computed fingerprint prevents the same ID from silently accepting
-- edited content. Historical and non-homepage sets remain NULL and are unaffected.
ALTER TABLE question_sets ADD COLUMN community_submission_id TEXT;
ALTER TABLE question_sets ADD COLUMN community_submission_fingerprint TEXT
  CHECK (community_submission_fingerprint IS NULL OR (
    length(community_submission_fingerprint) = 64
    AND community_submission_fingerprint NOT GLOB '*[^0-9a-f]*'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS question_sets_community_submission_id_unique
  ON question_sets(community_submission_id)
  WHERE community_submission_id IS NOT NULL;

-- Homepage screenshot uploads remain manifest-backed for game reads. This compact
-- per-image index stores canonical Bangumi tags without multiplying one upload into
-- hundreds of D1 rows. Anime IDs have a normal index; character IDs are queried with
-- json_each(character_tags_json) because each image is bounded to eight characters.
CREATE TABLE IF NOT EXISTS question_image_index (
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
  CHECK (order_index >= 0 AND order_index < 30),
  CHECK (anime_subject_id IS NULL OR anime_subject_id > 0),
  CHECK (json_valid(anime_tags_json) AND json_type(anime_tags_json) = 'array'),
  CHECK (json_valid(character_tags_json) AND json_type(character_tags_json) = 'array'),
  CHECK (json_array_length(anime_tags_json) <= 1),
  CHECK (json_array_length(character_tags_json) <= 8),
  CHECK ((anime_subject_id IS NULL AND json_array_length(anime_tags_json) = 0)
      OR (anime_subject_id IS NOT NULL AND json_array_length(anime_tags_json) = 1)),
  CHECK (json_array_length(character_tags_json) = 0 OR anime_subject_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS question_image_index_anime_idx
  ON question_image_index(anime_subject_id, created_at DESC, question_id DESC)
  WHERE anime_subject_id IS NOT NULL;
