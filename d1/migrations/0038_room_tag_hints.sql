PRAGMA foreign_keys = ON;

-- 房间级“翻格解锁 Tag 提示”开关与步长：开启后，游戏中每翻出
-- tag_hint_block_step 个格子解锁当前图片的 1 个 Bangumi 属性 Tag。
ALTER TABLE rooms ADD COLUMN lobby_tag_hints_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (lobby_tag_hints_enabled IN (0, 1));
ALTER TABLE rooms ADD COLUMN lobby_tag_hint_block_step INTEGER NOT NULL DEFAULT 5
  CHECK (lobby_tag_hint_block_step BETWEEN 1 AND 15);
