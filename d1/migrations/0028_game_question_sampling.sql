ALTER TABLE rooms
  ADD COLUMN lobby_question_count INTEGER
  CHECK (lobby_question_count IS NULL OR lobby_question_count BETWEEN 1 AND 30);

ALTER TABLE rooms
  ADD COLUMN prepared_question_count INTEGER
  CHECK (prepared_question_count IS NULL OR prepared_question_count BETWEEN 1 AND 30);

ALTER TABLE game_sessions
  ADD COLUMN selected_question_ids TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(selected_question_ids)
    AND json_type(selected_question_ids) = 'array'
    AND json_array_length(selected_question_ids) BETWEEN 0 AND 30
    AND length(selected_question_ids) <= 4096
  );
