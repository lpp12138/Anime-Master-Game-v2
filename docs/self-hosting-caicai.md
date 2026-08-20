# caicai.lpp.moe 单机部署说明

当前服务器在没有 Cloudflare 账号凭据的情况下使用以下拓扑：

```text
Nginx 443
├─ /api/* -> 127.0.0.1:8787 (Wrangler local / workerd)
└─ 其他路径 -> /var/www/caicai.lpp.moe (Vite 静态文件)
```

> `wrangler dev --local` 适合单机低流量部署和迁移前过渡，不等同于 Cloudflare 托管生产 SLA。取得 Cloudflare 凭据后仍建议按 `docs/deployment.md` 迁移到 Workers、D1、R2 和 Durable Objects。

## 服务器路径

- 运行源码：`/srv/anime-master-game/app`
- Wrangler 持久化数据：`/var/lib/anime-master-game/wrangler`
- Worker 私密环境文件：`/etc/anime-master-game/worker.env`
- 前端静态文件：`/var/www/caicai.lpp.moe`
- Nginx 站点：`/etc/nginx/sites-available/caicai.lpp.moe`
- Worker 服务：`anime-master-game.service`
- 每日清理定时器：`anime-master-game-maintenance.timer`
- 每日状态备份定时器：`anime-master-game-backup.timer`
- 增量状态备份：`/var/backups/anime-master-game/daily`

`worker.env` 权限应保持为 `0640 root:animegame`，其中的 `COMMUNITY_UPLOAD_SECRET` 不得复制进代码或前端环境变量。

## 更新

在源码目录完成测试和构建后：

```bash
npm ci
npm run worker:typecheck
npm run test:community-screenshot-upload
npm run test:bangumi-api
npm run test:r2-upload
npm run build
```

`wrangler dev` 会监视运行目录，直接 rsync 可能在 migration 前热重载新版 Worker。因此先停服务并创建一致性备份，再同步源码、执行 migration、启动 Worker，最后切换前端：

```bash
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/var/backups/anime-master-game/$stamp"
install -d -m 0700 "$backup"
systemctl stop anime-master-game.service
cp -a /var/lib/anime-master-game/wrangler "$backup/wrangler"
rsync -a --exclude='node_modules/' /srv/anime-master-game/app/ "$backup/app/"
rsync -a /var/www/caicai.lpp.moe/ "$backup/frontend/"

rsync -a --delete \
  --exclude='.git/' --exclude='node_modules/' --exclude='pages-dist/' --exclude='.wrangler/' \
  --exclude='.env*' --exclude='.dev.vars*' \
  ./ /srv/anime-master-game/app/
chown -R animegame:animegame /srv/anime-master-game/app
runuser -u animegame -- sh -c \
  'cd /srv/anime-master-game/app && HOME=/srv/anime-master-game npm ci'
runuser -u animegame -- sh -c \
  'cd /srv/anime-master-game/app && HOME=/srv/anime-master-game ./node_modules/.bin/wrangler d1 migrations apply anime_master_game --local --persist-to /var/lib/anime-master-game/wrangler'
systemctl start anime-master-game.service
curl -fsS http://127.0.0.1:8787/api/public-rooms >/dev/null

rsync -a --delete pages-dist/ /var/www/caicai.lpp.moe/
chown -R www-data:www-data /var/www/caicai.lpp.moe
```

若 migration 或启动检查失败，不要切换前端；停止服务后从同一 `$backup` 恢复运行源码和整份 Wrangler 状态，再启动旧版。

`0026_question_image_bangumi_tags.sql` 会增加首份投稿 ID 及逐图片 Bangumi 标签索引；`0027_homepage_question_set_appends.sql` 会为同标题社区截图题库选择一个规范集合，并把历史首份投稿回填到多投稿幂等表。两项 migration 都必须在启动新版 Worker 前完成。finalize 请求体限制为 512 KiB；新建时 manifest、图片索引与投稿记录原子提交，追加时通过 manifest 修订号比较原子更新题目、计数、图片索引与投稿记录。失败不留下半次追加，成功响应丢失后的同内容重试通过投稿 ID 返回原记录，服务端内容指纹会拒绝同一 ID 下被修改的投稿；整套题库仍最多 30 题。番剧搜索、finalize 使用的番剧详情和整份番剧角色列表分别通过 Worker Cache API 缓存 12 小时、30 天和 7 天；选择角色直接复用列表结果，不发送逐角色详情请求，finalize 会按官方 ID 重写名称并校验角色归属。上游请求使用项目专属 User-Agent，不需要 Bangumi access token。缓存不可用时只影响标签搜索，不会把上传密钥发送给 Bangumi。

受密钥保护的 `/api/community-image-index` 可按必填番剧 ID 和可选角色 ID 查询最多 50 张公开题库图片，只返回图片及规范标签，不读取或返回答案。`POST /api/community-remote-image-source` 用于上传或粘贴动画截图工具 JSON/JSONL 后下载 FanCaps/Bangumi 图片；它必须保留密钥校验、HTTPS 域名白名单、20 MiB 响应限制、重定向限制和上游超时。当前 Nginx 应为图片上传设置 5 次/秒（burst 10），为题单远端图片设置 5 次/秒（burst 10），为 finalize 设置 10 次/分钟（burst 5、`client_max_body_size 512k`），为 Bangumi helper 和图片索引设置 3 次/秒（burst 10；浏览器自动匹配最多并发 3 个请求）；限流响应统一为 429。修改配置后执行 `nginx -t && systemctl reload nginx`。

检查：

```bash
systemctl status anime-master-game.service
curl -fsS https://caicai.lpp.moe/api/public-rooms
nginx -t
```

## 持久化状态备份

安装仓库中的备份脚本和 unit：

```bash
install -o root -g root -m 0755 ops/anime-master-game-backup /usr/local/sbin/anime-master-game-backup
install -o root -g root -m 0644 ops/anime-master-game-backup.service /etc/systemd/system/
install -o root -g root -m 0644 ops/anime-master-game-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now anime-master-game-backup.timer
```

`anime-master-game-backup.timer` 每天约 02:15 UTC 运行 `/usr/local/sbin/anime-master-game-backup`。脚本使用 `flock` 防重入，短暂停止 Worker 后一致性复制整份 Wrangler 状态，并通过 `rsync --link-dest` 硬链接未变化的 R2 blob；同时备份密钥、release 信息、Nginx 和 systemd 配置。保留 14 天目录，备份根目录权限为 `0700`。当前单机重启和运行时启动约产生十余秒 API 维护窗口。

检查备份与下次执行时间：

```bash
systemctl list-timers anime-master-game-backup.timer
systemctl status anime-master-game-backup.service
readlink -f /var/backups/anime-master-game/daily/latest
```

恢复时先停止 Worker，再用选定快照完整覆盖状态；不要只复制某一个 SQLite 文件或遗漏 WAL/blob：

```bash
snapshot=/var/backups/anime-master-game/daily/<TIMESTAMP>
systemctl stop anime-master-game.service
rsync -a --delete "$snapshot/wrangler/" /var/lib/anime-master-game/wrangler/
chown -R animegame:animegame /var/lib/anime-master-game/wrangler
# 仅在确需回滚密钥时再恢复 $snapshot/config/worker.env
systemctl start anime-master-game.service
curl -fsS http://127.0.0.1:8787/api/public-rooms >/dev/null
```

增量硬链接备份仍位于同一块磁盘，只能防误操作和迁移失败；应定期把最新快照加密复制到另一台主机或对象存储，才能防整机/磁盘故障。

## 密钥轮换

生成新密钥并写入权限受限的环境文件，然后重启 Worker：

```bash
secret="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
printf 'COMMUNITY_UPLOAD_SECRET=%s\n' "$secret" > /etc/anime-master-game/worker.env
chown root:animegame /etc/anime-master-game/worker.env
chmod 0640 /etc/anime-master-game/worker.env
systemctl restart anime-master-game.service
```

轮换后旧密钥立即失效。

## 误传题库下架

当前页面没有管理员删除按钮。发现误传内容时，先停止运行时并把对应题库改为私有即可立即从社区目录下架（先备份持久化目录，并把 `<QUESTION_SET_ID>` 替换为实际 UUID）：

```bash
cat >/tmp/unpublish-question-set.sql <<'SQL'
UPDATE question_sets
SET is_public=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id='<QUESTION_SET_ID>';
SQL
chmod 644 /tmp/unpublish-question-set.sql
systemctl stop anime-master-game.service
runuser -u animegame -- sh -c \
  'cd /srv/anime-master-game/app && HOME=/srv/anime-master-game ./node_modules/.bin/wrangler d1 execute anime_master_game --local --persist-to /var/lib/anime-master-game/wrangler --file /tmp/unpublish-question-set.sql'
systemctl start anime-master-game.service
rm /tmp/unpublish-question-set.sql
```

如需彻底删除，还要先确认没有历史游戏引用；删除题库记录后，图片对象会由 72 小时孤儿对账回收。
