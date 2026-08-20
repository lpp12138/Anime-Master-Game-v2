PRAGMA foreign_keys = ON;

-- 房间级“包含 R18 题目”开关，默认关闭。关闭时服务端准备题库、重算可用题数和
-- 开局抽题必须排除 is_r18=true 的题目，不能只做前端过滤；开启后才包含 R18 题目。
-- 该开关只影响本局抽取范围，不改变底层题库内容，也不影响逐题 is_r18 标记。
-- 历史房间默认 false（不包含 R18 题目），与逐题 is_r18 默认 false 保持一致。
ALTER TABLE rooms
  ADD COLUMN lobby_include_r18 INTEGER NOT NULL DEFAULT 0
  CHECK (lobby_include_r18 IN (0, 1));
