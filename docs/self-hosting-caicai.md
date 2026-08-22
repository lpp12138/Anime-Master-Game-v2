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

`worker.env` 权限应保持为 `0640 root:animegame`，其中的 `COMMUNITY_UPLOAD_SECRET` 与 `QUESTION_SET_DELETE_SECRET` 不得复制进代码或前端环境变量。

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

`0026_question_image_bangumi_tags.sql` 会增加首份投稿 ID 及逐图片 Bangumi 标签索引；`0027_homepage_question_set_appends.sql` 会为同标题社区截图题库选择一个规范集合，并把历史首份投稿回填到多投稿幂等表；`0028_game_question_sampling.sql` 会增加房间题数设置、已准备题数和每局固定抽题顺序；`0029_question_set_admin_integrity.sql` 会增加历史归档题库索引，并用 trigger 防止房间准备一个不存在或正在被删除的题库；`0030_question_set_item_admin.sql` 会增加结构编辑标记，使管理员新增、删除或调序后的题库不再接收同标题自动追加；`0031_relax_community_set_storage_cap.sql` 会重建图片索引与投稿范围表，移除累计 30 题 CHECK（保留单次投稿 1–30 张与每局 30 题上限），使同标题社区题库可累计超过 30 题；`0032_question_is_r18.sql` 会为 `questions` 与 `question_image_index` 各增加一个带 CHECK 的 `is_r18` 整型列（默认 0，只接受 0/1），manifest JSON 每题同步保存布尔 `is_r18` 字段（旧 manifest 缺省即 false，历史行与旧索引保持默认非 R18）；`0033_room_lobby_include_r18.sql` 会给 `rooms` 增加带 CHECK 的 `lobby_include_r18` 整型列（默认 0，只接受 0/1），作为房间级“包含 R18 题目”开关（默认关闭，历史房间不包含 R18 题目）；`0034_question_image_md5.sql` 会给社区图片索引增加可空且格式受限的 `image_md5` 和 partial unique index，以单段 R2 对象 ETag 对应的 MD5 做精确文件去重；`0035_allow_structurally_edited_appends.sql` 会移除投稿账本中 `(question_set_id,start_order_index)` 的唯一限制，使人工删题后的题库仍可按 ID 继续追加，同时保留投稿 ID 主键和单次 1–30 题约束。；`0036_question_uploader_identity.sql` 会为投稿账本增加可空的上传者 ID/昵称列并回填每套题库的第一份投稿（即创建者），后续投稿写入时记录上传者身份，游戏载荷按题目 ID 携带当前图片的上传者昵称（出题人），裁判以单独标签显示。十项 migration 都必须在启动对应新版 Worker 前完成；0034 应用后，历史索引行保持 NULL，需以每个本站图片 URL 的 `HEAD` ETag（去掉引号后必须是 32 位小写十六进制）回填；回填前先报告重复 ETag，不能绕过唯一约束或静默删除历史题目。旧 game session 的空抽题快照继续按全题库原顺序读取。finalize 请求体限制为 512 KiB；新建时 manifest、图片索引与投稿记录原子提交，追加时通过 manifest 修订号比较原子更新题目、计数、图片索引与投稿记录。失败不留下半次追加，成功响应丢失后的同内容重试通过投稿 ID 返回原记录，服务端内容指纹会拒绝同一 ID 下被修改的投稿；整套题库不再受累计 30 题限制，单次投稿仍最多 30 张。Bangumi 搜索支持动画、游戏和全部范围；搜索、finalize 使用的作品详情和整份角色列表分别通过 Worker Cache API 缓存 12 小时、30 天和 7 天。选择角色直接复用列表结果，不发送逐角色详情请求，finalize 会按官方 ID 重写类型/名称并校验角色归属。上游请求使用项目专属 User-Agent，不需要 Bangumi access token。缓存不可用时只影响标签搜索，不会把上传密钥发送给 Bangumi。

受密钥保护的 `/api/community-image-index` 可按必填作品 ID 和可选角色 ID 查询最多 50 张公开题库图片，只返回图片及规范标签，不读取或返回答案。上传页支持选择、拖放、粘贴剪贴板位图，以及粘贴 JSON/JSONL 或每行一个截图直链。`POST /api/community-remote-image-source` 负责下载 FanCaps/Bangumi 图片；它必须保留密钥校验、HTTPS 域名白名单、20 MiB 响应限制、重定向限制和上游超时，不能改成任意 URL 代理。`/question-set-admin` 的列表、详情、单题 POST/GET/PATCH/DELETE 和整库 PATCH/DELETE 同样必须保留密钥校验，mutation 请求体不得超过 16 KiB。

当前 Nginx 应为图片上传设置 5 次/秒（burst 10），为题单远端图片设置 5 次/秒（burst 10），为 finalize 设置 10 次/分钟（burst 5、`client_max_body_size 512k`），为 Bangumi helper 和图片索引设置 3 次/秒（burst 10；浏览器自动匹配最多并发 3 个请求），并为 `/api/admin/question-sets` 前缀单独设置 5 次/秒（burst 10、`client_max_body_size 16k`）；限流响应统一为 429。修改配置后执行 `nginx -t && systemctl reload nginx`。

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

## 密钥生成与轮换

生成/轮换时两个密钥都应直接写入权限受限的环境文件，不要打印到终端、日志或工单：

```bash
umask 077
printf 'COMMUNITY_UPLOAD_SECRET=%s\nQUESTION_SET_DELETE_SECRET=%s\n' \
  "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" \
  "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" > /etc/anime-master-game/worker.env
chown root:animegame /etc/anime-master-game/worker.env
chmod 0640 /etc/anime-master-game/worker.env
systemctl restart anime-master-game.service
```

轮换后旧密钥立即失效。

## 题库下架与安全删除

访问 `https://caicai.lpp.moe/question-set-admin`，输入与截图投稿相同的管理密钥。服务器上的密钥只能用下面的 root 命令读取，不要复制进仓库、前端环境变量、日志或工单：

```bash
sudo sed -n 's/^COMMUNITY_UPLOAD_SECRET=//p' /etc/anime-master-game/worker.env
sudo sed -n 's/^QUESTION_SET_DELETE_SECRET=//p' /etc/anime-master-game/worker.env
```

管理页可检索题库、检查答案与 Bangumi 标签，修改标题、说明和公开状态，并逐题新增、查询、编辑答案/标签、拖放或粘贴换图、调序及删除。取消公开会立即从社区目录下架；规范同标题集合同时释放，之后的新投稿可能建立另一个规范集合。单题新增、删除或调序也会释放该题库的同标题自动绑定，但题库重新保持公开时仍会出现在截图上传页，可按题库 ID 明确选择并继续追加。所有修改和删除都使用页面刚读取的 `updatedAt` 做乐观并发控制，遇到 409 必须刷新后重新确认，不能绕过版本条件；活动游戏或已准备房间引用时仍不能修改单题。

永久删除整个题库除管理密钥外，还要在危险操作区输入单独的删除密钥（`QUESTION_SET_DELETE_SECRET`，页面只保存在内存，仅随整库删除请求头发送）并输入完整题库标题。Worker 会拒绝活动游戏或损坏 manifest 的题库；已准备房间不阻止删除，而是先在同一个 D1 batch 中把引用该题库的房间原子退回大厅并取消准备，再删除题库，成功响应返回释放的房间数，页面会提示。历史结算归档是自包含快照，删除题库后仍保留。题库及题目、图片索引、投稿记录和评分先在 D1 中级联删除，成功后才重新扫描所有剩余题库引用并清理不再共享的本站 R2 对象。引用扫描或 R2 删除失败会在页面显示待重试数量，且不会把失败伪报成已清理；损坏的剩余 manifest 会让清理失败关闭。每日 72 小时孤儿对账继续处理普通待清理对象。

只有在管理页不可用的应急情况下，才停止 Worker、先做一致性备份，再用 SQL 取消公开；同时必须释放规范集合标识，并使用条件 ID，不能直接删除行：

```bash
cat >/tmp/unpublish-question-set.sql <<'SQL'
UPDATE question_sets
SET is_public=0,
    community_collection_title=NULL,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id='<QUESTION_SET_ID>';
SQL
chmod 644 /tmp/unpublish-question-set.sql
systemctl stop anime-master-game.service
runuser -u animegame -- sh -c \
  'cd /srv/anime-master-game/app && HOME=/srv/anime-master-game ./node_modules/.bin/wrangler d1 execute anime_master_game --local --persist-to /var/lib/anime-master-game/wrangler --file /tmp/unpublish-question-set.sql'
systemctl start anime-master-game.service
rm /tmp/unpublish-question-set.sql
```
