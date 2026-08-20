PRAGMA foreign_keys = ON;

-- Admin list/detail reference counts must not scan the complete archive table.
CREATE INDEX IF NOT EXISTS game_result_archives_question_set_id_idx
  ON game_result_archives(question_set_id);

-- rooms predates question_sets, so prepared_question_set_id could not receive a
-- normal foreign key in the initial schema. These triggers close that race for
-- administrative deletion and every other writer without rebuilding rooms.
CREATE TRIGGER IF NOT EXISTS rooms_prepared_question_set_insert_guard
BEFORE INSERT ON rooms
WHEN NEW.prepared_question_set_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM question_sets WHERE id = NEW.prepared_question_set_id
  )
BEGIN
  SELECT RAISE(ABORT, 'prepared question set does not exist');
END;

CREATE TRIGGER IF NOT EXISTS rooms_prepared_question_set_update_guard
BEFORE UPDATE OF prepared_question_set_id ON rooms
WHEN NEW.prepared_question_set_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM question_sets WHERE id = NEW.prepared_question_set_id
  )
BEGIN
  SELECT RAISE(ABORT, 'prepared question set does not exist');
END;

CREATE TRIGGER IF NOT EXISTS question_sets_prepared_room_delete_guard
BEFORE DELETE ON question_sets
WHEN EXISTS (
  SELECT 1 FROM rooms WHERE prepared_question_set_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'question set is prepared by a room');
END;
