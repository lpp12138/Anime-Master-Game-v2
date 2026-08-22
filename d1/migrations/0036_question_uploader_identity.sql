PRAGMA foreign_keys = ON;

-- 每份社区投稿记录上传者身份，供游戏内“当前图片的出题人”展示。
-- 历史投稿无法追溯身份，回填只覆盖每套题库的第一份投稿（即题库创建者）；
-- 其余历史投稿保持 NULL，游戏内不显示上传者（回退到裁判昵称）。
ALTER TABLE community_question_set_submissions ADD COLUMN submitted_by_player_id TEXT
  CHECK (submitted_by_player_id IS NULL OR (length(submitted_by_player_id) BETWEEN 1 AND 128));
ALTER TABLE community_question_set_submissions ADD COLUMN submitted_by_nickname TEXT
  CHECK (submitted_by_nickname IS NULL OR (length(trim(submitted_by_nickname)) BETWEEN 1 AND 20));

UPDATE community_question_set_submissions
SET submitted_by_player_id = (
      SELECT qs.created_by_player_id
      FROM question_sets qs
      WHERE qs.id = community_question_set_submissions.question_set_id
    ),
    submitted_by_nickname = (
      SELECT qs.created_by_nickname
      FROM question_sets qs
      WHERE qs.id = community_question_set_submissions.question_set_id
    )
WHERE start_order_index = 0
  AND submitted_by_player_id IS NULL
  AND EXISTS (
    SELECT 1 FROM question_sets qs WHERE qs.id = community_question_set_submissions.question_set_id
  );
