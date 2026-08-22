PRAGMA foreign_keys = ON;

-- Bangumi 属性标签与首播年份：属性标签来自官方 subject 详情的用户标签
-- （异世界、恋爱等，去重后有界条数与名称长度），年份由官方 date 字段推导。
-- 历史行由一次性回填脚本按作品 ID 去重后从官方接口获取；新增/编辑时由
-- finalize 与管理端规范化流程写入。
ALTER TABLE question_image_index ADD COLUMN anime_genre_tags_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(anime_genre_tags_json)
    AND json_type(anime_genre_tags_json) = 'array'
    AND json_array_length(anime_genre_tags_json) <= 20);
ALTER TABLE question_image_index ADD COLUMN anime_release_year INTEGER
  CHECK (anime_release_year IS NULL OR (anime_release_year BETWEEN 1950 AND 2100));
