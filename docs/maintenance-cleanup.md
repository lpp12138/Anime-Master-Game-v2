# Maintenance Cleanup SQL

本项目现在使用 Cloudflare D1。下面的 SQL 可用 `wrangler d1 execute` 执行。

生产环境已经通过 Worker Cron Trigger 自动清理超过 48 小时未更新的房间。自动清理会先根据房间历史游戏和当前准备题库追溯未发布题库，只删除未发布题库独占引用的 R2 图片对象，再删除房间和已无引用的未发布题库记录。公开社区题库不会被清理。R2 引用对账会读取 legacy 题目、逐图索引和全部 manifest；任一 manifest 损坏时必须失败关闭并保留对象，不能靠 JSON 文本筛选后继续删除。

Room runtime generation 3 硬切后，历史房间的 `runtime_generation` 保持 `NULL`，访问会被逻辑拒绝但不会立即删除。拒绝路径不得更新 `updated_at`，这些房间仍由本流程在 48 小时后按原有 R2 追溯顺序自然清理。

不要在生产环境绕过 Worker 直接删除旧房间，否则会先丢失 `rooms -> game_sessions -> question_sets -> questions` 的追溯链，导致 R2 图片对象无法被一起清理。下面 SQL 仅用于本地排查、预览或紧急手动维护。

本地预览：

```bash
npx wrangler d1 execute anime_master_game --local --command "select id, room_code, game_status, updated_at from rooms limit 20"
```

远程执行前建议先运行 `select` 预览，再运行 `delete`。

## 预览旧 LOBBY 房间

```sql
select id, room_code, game_status, created_at, updated_at
from rooms
where game_status = 'LOBBY'
  and updated_at < datetime('now', '-3 days')
order by updated_at asc;
```

## 删除旧 LOBBY 房间

```sql
delete from rooms
where game_status = 'LOBBY'
  and updated_at < datetime('now', '-3 days');
```

## 删除明显过期房间

```sql
delete from rooms
where (
  game_status in ('LOBBY', 'GAME_RESULT')
  and updated_at < datetime('now', '-3 days')
)
or (
  game_status in ('QUESTION_SETUP', 'PLAYING')
  and updated_at < datetime('now', '-1 day')
);
```

## 预览旧私有题库

```sql
select id, title, is_public, image_count, created_at, updated_at
from question_sets
where is_public = 0
  and created_at < datetime('now', '-3 days')
order by created_at asc;
```

## 删除未发布且未被游戏使用的旧题库

```sql
delete from question_sets
where is_public = 0
  and created_at < datetime('now', '-3 days')
  and not exists (
    select 1
    from game_sessions
    where game_sessions.question_set_id = question_sets.id
  );
```

## 测试环境清空房间

```sql
delete from rooms;
```

`rooms` 会级联删除房间玩家、游戏会话、答案、积分和判分记录；不会删除社区题库。
