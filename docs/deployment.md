# 部署指南

当前架构：

- 前端：Cloudflare Pages
- 后端 API + WebSocket：Cloudflare Workers
- 实时房间：Durable Objects
- 持久化：Cloudflare D1
- 图片：Cloudflare R2
- 远端 URL 图片获取兜底：Worker 有界代理，图片压缩在浏览器完成

生产环境推荐使用自定义域名同源路由：

```text
https://game.example.com        -> Pages 前端
https://game.example.com/api/*  -> Worker API 和 WebSocket
```

同源路由可以让页面、HTTP API 和 WebSocket 都走同一个 origin，减少 CORS 预检和跨域代理链路差异。跨域 `workers.dev` API 地址只建议用于首次联调或没有自定义域名的临时部署。

目录：

- [本地开发](#本地开发)
- [Cloudflare 部署](#cloudflare-部署)
- [Requests 与实时通信](#requests-与实时通信)
- [更新部署](#更新部署)
- [常见问题](#常见问题)

## 本地开发

安装依赖：

```bash
npm install
```

复制环境变量：

```bash
cp .env.example .env.local
```

首页密钥上传和受保护题库管理共用一个只供本地 Worker 读取的 `.dev.vars` 密钥（至少 24 个字符，不能使用 `NEXT_PUBLIC_` 前缀）；整库删除另需一个独立删除密钥：

```bash
printf 'COMMUNITY_UPLOAD_SECRET=%s\nQUESTION_SET_DELETE_SECRET=%s\n' \
  "$(openssl rand -base64 32 | tr -d '\n')" \
  "$(openssl rand -base64 32 | tr -d '\n')" > .dev.vars
chmod 600 .dev.vars
```

本地前端至少需要：

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:8787
```

图片上传会走本地 Worker 的 R2 绑定。首次运行前先创建本地 D1，并确认 `wrangler.toml` 里有 `IMAGE_BUCKET` 绑定：

```toml
[[r2_buckets]]
binding = "IMAGE_BUCKET"
bucket_name = "anime-master-game-images"
```

初始化本地 D1：

```bash
npm run d1:migrate:local
```

开两个终端：

```bash
npm run worker:dev
```

```bash
npm run dev
```

默认地址：

```text
前端：http://localhost:3000
Worker：http://localhost:8787
```

本地检查：

```bash
npm run lint
npm run worker:typecheck
npm run build
```

## Cloudflare 部署

第一次部署顺序：

1. 创建 D1。
2. 创建 R2 bucket。
3. 填 `wrangler.toml`。
4. 执行远程 D1 迁移。
5. 部署 Worker：本地手动部署或 Git 连接部署二选一。
6. 连接 GitHub 自动部署 Pages。
7. 绑定自定义域名，并配置 Worker 同源 `/api/*` route。
8. 回填真实 `ALLOWED_ORIGIN`，按你的 Worker 部署方式更新 Worker。
9. 删除 Pages 的 `NEXT_PUBLIC_API_BASE_URL`，重新部署 Pages。

### 1. 创建 D1

登录 Cloudflare：

```bash
npx wrangler login
```

创建远程 D1：

```bash
npx wrangler d1 create anime_master_game
```

把输出里的 `database_id` 填入 `wrangler.toml`。注意 `binding` 必须是 `DB`，因为 Worker 代码读取的是 `env.DB`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "anime_master_game"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
migrations_dir = "d1/migrations"
```

第一次部署时还没有 Pages 地址，`ALLOWED_ORIGIN` 先临时写成 `"*"`：

```toml
[vars]
ALLOWED_ORIGIN = "*"
R2_IMAGE_PREFIX = "question-images"
R2_EXISTING_IMAGE_LIMIT = "50"
```

### 2. 创建 R2 bucket

创建远程 R2 bucket：

```bash
npx wrangler r2 bucket create anime-master-game-images
```

确认 `wrangler.toml` 里的 binding 名称是 `IMAGE_BUCKET`。Worker 代码通过绑定直接读写 R2，不需要 R2 API token，也不要把 Cloudflare API token 写进代码或配置：

```toml
[[r2_buckets]]
binding = "IMAGE_BUCKET"
bucket_name = "anime-master-game-images"

```

URL/JSONL 导入统一由 Worker 在校验当前房间出题人身份后有界获取外部原图，避免未配置代理的手机直接连接海外图床；浏览器不会直接请求题单中的外链。缩放、压缩和 WebP 编码仍全部在浏览器完成，再通过现有上传接口写入 R2，不需要 Cloudflare Images binding 或额外签名密钥。

执行远程 D1 迁移：

```bash
npm run d1:migrate:remote
```

给首页截图上传和题库管理入口配置 Worker secret，整库删除再单独配置删除密钥：

```bash
npx wrangler secret put COMMUNITY_UPLOAD_SECRET
npx wrangler secret put QUESTION_SET_DELETE_SECRET
```

两个值都只应存在于 Worker secret 或服务器权限受限的环境文件中；不要写进 `wrangler.toml`、Git、Pages 环境变量或任何 `NEXT_PUBLIC_*` 变量。

首页按钮进入独立上传页；该页面接受文件选择、多图拖放和 Ctrl/Cmd+V 剪贴板截图，也接受动画截图工具导出的 JSON/JSONL 文件、直接粘贴的 `image_url` / `label_text` 题单，或每行一个截图直链，并以自适应网格展示截图。题单和直链远端图片只通过受上传密钥保护的 `POST /api/community-remote-image-source` 获取；该接口限定为 FanCaps/Bangumi HTTPS 域名、拒绝跨域重定向、限制 20 MiB 和 15 秒上游请求，随后仍由浏览器压缩、由截图上传接口重新校验。反向代理必须为该接口单独限速，不能为了通用 URL 粘贴而放宽 SSRF 白名单。

页面通过 Worker 访问官方 `https://api.bgm.tv/v0` 建立 Bangumi 作品和角色标签。正确答案输入框可按 `anime`（type 2）、`game`（type 4）或 `all` 搜索，三种范围使用隔离缓存；下方角色输入只筛选所选作品的官方角色列表。上游请求使用项目专属 User-Agent；无需 Bangumi token。Worker Cache API 分别缓存作品搜索 12 小时、finalize 使用的作品详情 30 天和整份角色列表 7 天；选角色直接复用列表结果，不产生逐角色 N+1 请求。finalize 会按官方 ID 重写类型/名称并校验角色归属，避免信任客户端标签、浏览器直连和重复打到 Bangumi。finalize JSON 请求体上限为 512 KiB；浏览器在相同内容的重试期间保留已上传的 R2 key 和一个稳定投稿 ID；Worker 把该 ID 与服务端计算的内容指纹绑定并拒绝同 ID 下被修改的内容。未指定目标 ID 时，标题完全相同的社区截图投稿会追加到同一规范题库；上传页明确选择现有题库时按 ID 追加，已人工增删或调序的公开社区题库也可继续接收投稿；整套题库不再受累计 30 题限制，可跨投稿持续追加；单次投稿仍最多 30 张、每局游戏仍最多抽 30 题。新建和追加分别通过 D1 batch 原子写入/更新 manifest、图片索引与投稿记录，并以 manifest 修订号解决并发追加。D1 migrations `0026_question_image_bangumi_tags.sql` 与 `0027_homepage_question_set_appends.sql` 分别保存逐图片规范标签及同标题集合/多投稿幂等记录；`0028_game_question_sampling.sql` 保存房间题数设置、已准备题数和每局固定抽题顺序；`0029_question_set_admin_integrity.sql` 为历史结算引用计数增加索引，并用 D1 trigger 补齐 `rooms.prepared_question_set_id` 的引用完整性；`0030_question_set_item_admin.sql` 标记已由管理员新增、删除或调序的题库并解除其规范同标题追加绑定；`0031_relax_community_set_storage_cap.sql` 移除图片索引与投稿范围表的累计 30 题 CHECK（保留单次投稿 1–30 张与每局 30 题上限）；`0032_question_is_r18.sql` 为 `questions` 与 `question_image_index` 各增加一个带 CHECK 的整型列 `is_r18`（默认 0，只接受 0/1），manifest JSON 每题同步保存布尔 `is_r18` 字段（旧 manifest 缺省即 false）；`0033_room_lobby_include_r18.sql` 为 `rooms` 增加带 CHECK 的 `lobby_include_r18` 整型列（默认 0，只接受 0/1），作为默认关闭的房间级“包含 R18 题目”开关；`0034_question_image_md5.sql` 为社区图片索引增加可空、格式受限的 `image_md5` 和 partial unique index，使用单段 R2 对象 ETag 对应的 MD5 阻止精确字节重复；`0035_allow_structurally_edited_appends.sql` 移除投稿账本中 `(question_set_id,start_order_index)` 的过时唯一限制，使删题后的当前末尾可与历史投稿起点重复，同时保留投稿 ID 幂等主键、单次 1–30 题 CHECK 和普通查询索引。；`0036_question_uploader_identity.sql` 会为投稿账本增加可空的上传者 ID/昵称列并回填每套题库的第一份投稿（即创建者），后续投稿写入时记录上传者身份，游戏载荷按题目 ID 携带当前图片的上传者昵称（出题人），裁判以单独标签显示。；`0037_question_genre_tags.sql` 会为图片索引增加有界的 Bangumi 属性标签数组 `anime_genre_tags_json`（异世界、恋爱等官方用户标签，最多 20 条）与首播年份 `anime_release_year`（1950–2100，缺省 NULL），finalize 与管理端规范化时按官方 subject 详情写入，历史图片由一次性回填脚本按作品去重后获取。；`0038_room_tag_hints.sql` 会给 `rooms` 增加带 CHECK 的 `lobby_tag_hints_enabled`（默认 0）与 `lobby_tag_hint_block_step`（默认 5，限 1–15），作为房间级“翻格解锁 Tag 提示”开关与步长（默认关闭，历史房间不开启）。部署新版 Worker 前必须先执行上述迁移；旧索引行的 MD5 初始为 NULL，应在上线时通过对应图片的 R2 `HEAD` ETag 回填（先报告并处理历史碰撞，再更新），否则仅这些未回填的历史图片暂时不能参与去重。旧 game session 的空抽题快照继续按全题库原顺序读取。

受同一上传密钥保护的 `GET /api/community-image-index?animeSubjectId=<id>&characterId=<optional>&limit=<1-50>` 只查询公开题库，返回图片标识和规范标签，不返回 `answer_text`。它是可信预览/整理工具的后端读模型，不应改成匿名答案接口。

`/question-set-admin` 使用同一密钥访问 `/api/admin/question-sets` 管理 API。密钥只驻留页面内存；列表不返回答案，只有受保护详情和单题 GET 返回答案/Bangumi 标签。题库 PATCH、单题 POST/PATCH/DELETE 和整库 DELETE 都要求当前 `expectedUpdatedAt`；单题/整库删除还分别要求完整匹配的 `confirmQuestionId` / `confirmQuestionSetId`，整库 DELETE 另需 `x-question-set-delete-key` 请求头（服务端单独配置的 `QUESTION_SET_DELETE_SECRET`，至少 24 字符；未配置返回 503，缺失/错误返回 403，常量时间比较且超长输入直接拒绝）。单题 mutation 同时更新 manifest 或 legacy rows、连续顺序和 `question_image_index`；新增、删除、调序会写入 `community_structure_edited=1` 并释放仅凭同标题自动命中的规范集合标题，但公开社区题库仍可在上传页按 ID 选择后继续追加。单题 mutation 仍会拒绝被活动游戏或已准备房间引用、损坏或形状不一致的题库，并执行图片来源及版本检查。已准备房间不再阻止整库删除：删除会先在同一个 D1 batch 中把引用该题库的房间原子退回 LOBBY 并清空出题人/题库引用等列（成功响应返回 `releasedPreparedRoomCount`），再删除题库；过期版本不会清空房间，活动游戏仍被拒绝，并发准备会被 trigger 拒绝。

替换/删除单题或删除整库时，D1 先提交，再重新扫描全部剩余 legacy、图片索引和 manifest 引用，只批量清理不再共享的可信本站 R2 对象；扫描、映射或 R2 删除失败只报告待重试对象，不回滚或伪报 D1 失败。损坏的任一剩余 manifest 会让引用扫描失败关闭，避免误删未追踪图片；历史归档是自包含快照，可以保留。

部署在 Nginx 或其他反向代理后时，必须分别限制图片上传、finalize、Bangumi helper、图片索引和题库管理 API 的速率；题库管理 mutation 请求体上限是 16 KiB，允许方法为 GET、POST、PATCH、DELETE 和 OPTIONS。不要仅依赖共享密钥承担配额控制。

### 3. 部署 Worker

先检查 Worker：

```bash
npm run worker:typecheck
npx wrangler deploy --dry-run
```

#### 方式 A：本地手动部署

部署 Worker：

```bash
npm run worker:deploy
```

部署成功后，记下 Worker 地址：

```text
https://anime-master-game-api.<your-name>.workers.dev
```

#### 方式 B：Git 连接部署

把代码和 `wrangler.toml` push 到 GitHub。

在 Cloudflare 创建 Worker：

```text
Account home -> Add -> Workers
```

选择连接 GitHub 仓库，填写：

```text
Project name: anime-master-game-api
Root directory: 项目根目录
Build command: 留空
Deploy command: npx wrangler deploy
```

如果页面可以选择 production branch，就选 `main` 或你的实际生产分支。如果创建页面没有分支选项，先继续创建，部署后到这里确认或调整：

```text
Workers & Pages -> 你的 Worker -> Settings -> Builds
```

Worker 名称要和 `wrangler.toml` 一致：

```toml
name = "anime-master-game-api"
```

部署成功后，记下 Worker 地址：

```text
https://anime-master-game-api.<your-name>.workers.dev
```

### 4. 部署 Pages

在 Cloudflare 创建 Pages：

```text
Account home -> Add -> Pages
```

连接 GitHub 仓库，构建配置：

```text
Framework preset: None / No preset
Build command: npm run build
Build output directory: pages-dist
Root directory: 项目根目录
```

如果还没有配置同源 `/api/*`，在 `Environment variables (advanced)` 添加临时跨域 API 地址：

```env
NEXT_PUBLIC_API_BASE_URL=https://anime-master-game-api.<your-name>.workers.dev
```

如果已经配置了自定义域名同源 `/api/*`，不要配置 `NEXT_PUBLIC_API_BASE_URL`。

不要把 `NEXT_PUBLIC_API_BASE_URL` 保留为空字符串；直接删除这个环境变量。

其他前端上传参数已有默认值，通常不用填：

```text
NEXT_PUBLIC_UPLOAD_IMAGE_MAX_SIZE=1600
NEXT_PUBLIC_UPLOAD_IMAGE_FORMAT=image/webp
NEXT_PUBLIC_UPLOAD_IMAGE_QUALITY=0.78
NEXT_PUBLIC_R2_UPLOAD_CONCURRENCY=2
```

保存后 Cloudflare Pages 会自动构建并部署。部署成功后，记下 Pages 地址：

```text
https://anime-master-game-v2.pages.dev
```

### 5. 回填 CORS

把 `wrangler.toml` 里的 `ALLOWED_ORIGIN` 从 `"*"` 改成真实 Pages origin：

```toml
ALLOWED_ORIGIN = "https://anime-master-game-v2.pages.dev"
```

不要带结尾 `/`：

```text
正确：https://anime-master-game-v2.pages.dev
错误：https://anime-master-game-v2.pages.dev/
```

然后更新 Worker：

```bash
# 本地手动部署：
npm run worker:deploy

# Git 连接部署：
git push
```

### 6. 推荐：自定义域名同源 `/api/*`

生产环境推荐做成：

```text
https://game.example.com        -> Pages 前端
https://game.example.com/api/*  -> Worker API 和 WebSocket
```

这样 API 和页面同源，可以减少 CORS `OPTIONS`，也能避免跨域 Worker 地址、Pages 地址和浏览器 WebSocket 行为不一致导致的实时同步问题。

步骤：

1. 给 Pages 绑定自定义域名：

```text
Workers & Pages -> 你的 Pages 项目 -> Custom domains -> Set up a domain
```

2. 给 Worker 添加 route：

```text
Workers & Pages -> 你的 Worker -> Domains -> Add domain -> Route pattern
```

Route pattern：

```text
game.example.com/api/*
```

不要选择 `Custom Domains`，这里要选 `Route pattern`，因为前端根路径仍然由 Pages 提供，只有 `/api/*` 交给 Worker。

如果输入框里默认出现类似下面的通配 pattern，不要直接使用：

```text
*.example.com/*
```

它会把整站流量都交给 Worker，可能导致 Pages 前端打不开。只填写当前前端域名下的 `/api/*`：

```text
game.example.com/api/*
```

例如你的前端域名是 `anipeek.animaster.dpdns.org`，就填写：

```text
anipeek.animaster.dpdns.org/api/*
```

3. 删除 Pages 环境变量：

在 Pages 项目的 `Settings -> Environment variables` 里删除 `NEXT_PUBLIC_API_BASE_URL`。

如果 Cloudflare Pages 界面或现有流程必须保留这个变量，就填自定义域名的 origin，不要带 `/api`：

```env
NEXT_PUBLIC_API_BASE_URL=https://game.example.com
```

不要填：

```env
NEXT_PUBLIC_API_BASE_URL=https://game.example.com/api
NEXT_PUBLIC_API_BASE_URL=/api
```

保存后，在 Pages 的 `Deployments` 里重新运行最近一次 Git deployment。

4. Worker 的 `ALLOWED_ORIGIN` 改成：

```toml
ALLOWED_ORIGIN = "https://game.example.com"
```

然后更新 Worker：

```bash
# 本地手动部署：
npm run worker:deploy

# Git 连接部署：
git push
```

5. 检查生产页面的 API 地址：

打开浏览器开发者工具，确认请求和 WebSocket 都是同源地址：

```text
https://game.example.com/api/rpc
wss://game.example.com/api/realtime/room%3A.../ws
```

如果仍然看到 `https://anime-master-game-api.<your-name>.workers.dev` 或 `wss://anime-master-game-api.<your-name>.workers.dev`，说明 Pages 还在使用旧的 `NEXT_PUBLIC_API_BASE_URL`，需要删除该环境变量并重新部署 Pages。

## Requests 与实时通信

Cloudflare 的 HTTP `Requests` 是这个项目需要重点控制的指标。游戏进行中不要把“刷新一下状态”当成免费操作；频繁的 `/api/rpc` 会很快累积请求数。

各组件的 Free 额度、单局工程预算和修改审查清单统一见 [`cloudflare-free-budget.md`](cloudflare-free-budget.md)。

开发新功能时遵循这些规则：

- 游戏中已经知道 `roomId` 或 `gameSessionId` 的读写操作，优先复用 WebSocket action 通道。
- 新增 mutation 时，确认是否应该加入 `src/lib/cloudflareClient.ts` 的 `MUTATION_NAMES`。
- 新增游戏中读请求时，确认是否应该加入 `WS_QUERY_NAMES`，让它在已有实时连接上执行。
- 保留 HTTP `/api/rpc` 用于进入房间前的 bootstrap、按房间号查询、加入房间、图片上传/导入等不适合绑定到现有 room topic 的流程。
- mutation 不能静默 HTTP 重试，避免重复提交；read-only query 只有 WebSocket transport 失败时才允许 HTTP fallback。
- 不要引入轮询。断线重连后如需补偿同步，优先做一次 snapshot catch-up，而不是定时拉取。
- 上线后用 Workers Observability 里的结构化 `game_rpc` 日志检查 `transport` 和 `name`，确认高频 action 是否走了 WebSocket。

排查 request 增长时，先按这个顺序看来源：

1. `/api/rpc` 的 action 分布，特别是 `getRoundSnapshot`、`getRoomWithPlayers` 这类状态读取。
2. WebSocket 建连次数，确认是否有异常重连。
3. R2 图片请求。图片通常不是主要来源，但如果一局题量变大或图片没有缓存，也需要单独看。
4. Durable Object alarms 和 WebSocket message 属于 Observability event/DO 用量口径，不要和 HTTP `Requests` 混在一起分析。

## 更新部署

只改前端：

```bash
git push
```

Cloudflare Pages 会自动构建和部署。

只改 Worker 或 `wrangler.toml`：

```bash
# 本地手动部署：
npm run worker:deploy

# Git 连接部署：
git push
```

改了 D1 迁移：

```bash
npm run d1:migrate:remote

# 本地手动部署：
npm run worker:deploy

# Git 连接部署：
git push
```

前后端都改了：

- 如果接口兼容，更新 Worker，并 push 前端。
- 如果新前端依赖新后端，先更新 Worker，确认 Worker 部署完成后，再 push 前端。

改了 Pages 环境变量：

```text
Pages -> Deployments -> 重新运行最近一次 Git deployment
```

改了 R2 bucket 名称或绑定后，先更新 `wrangler.toml`，再重新部署 Worker。

## 常见问题

### 找不到 Pages 创建入口

新版入口：

```text
Account home -> Add -> Pages
```

如果从旧入口进入：

```text
Workers & Pages -> Create application
```

默认可能是 Create Worker 页面。不要在这里创建 Pages，找到页面下方：

```text
Looking to deploy Pages? Get started
```

点击 `Get started` 进入 Pages。

### Framework preset 没有 Vite

没关系，preset 不是必须。选：

```text
Framework preset: None / No preset
```

然后手动填：

```text
Build command: npm run build
Build output directory: pages-dist
```

### 页面操作提示 Failed to fetch

优先检查两处。

第一，Worker 的 `ALLOWED_ORIGIN` 必须和浏览器地址栏 origin 精确一致，不能带结尾 `/`：

```toml
ALLOWED_ORIGIN = "https://anime-master-game-v2.pages.dev"
```

第二，Pages 的 `NEXT_PUBLIC_API_BASE_URL`：

- 跨域 Worker 模式：填 Worker 地址。
- 同源 `/api/*` 模式：删除这个环境变量。
- 如果界面或流程必须保留变量：填自定义域名 origin，例如 `https://game.example.com`，不要带 `/api`。
- 不要填 `localhost`。
- 跨域 Worker 模式不要填 Pages 地址；同源模式只在必须保留变量时填自定义域名 origin。

改完 Worker 配置后执行：

```bash
# 本地手动部署：
npm run worker:deploy

# Git 连接部署：
git push
```

改完 Pages 环境变量后，在 Pages 的 `Deployments` 里重新运行最近一次 Git deployment。

### 多浏览器游戏内状态不同步

现象：房主点击开始游戏、返回大厅能同步，但揭露方块、下一题、判分后玩家端不动，刷新后才显示最新状态。

优先检查生产环境是否使用同源 `/api/*`：

```text
推荐：https://game.example.com/api/*
临时：https://anime-master-game-api.<your-name>.workers.dev
```

如果已经有自定义域名，按“推荐：自定义域名同源 `/api/*`”配置：

- Worker route pattern：`game.example.com/api/*`，不要使用 `*.example.com/*`
- Pages 删除 `NEXT_PUBLIC_API_BASE_URL`
- Worker `ALLOWED_ORIGIN = "https://game.example.com"`
- 重新部署 Worker 和 Pages

同时确认 Cloudflare 没有给 `/api/*` 配缓存规则，Network 里的 WebSockets 功能处于开启状态。

### 线上提示数据库表不存在

执行远程 D1 迁移：

```bash
npm run d1:migrate:remote
```

### 图片上传后无法显示

先检查 Worker 是否绑定了 R2：

```toml
[[r2_buckets]]
binding = "IMAGE_BUCKET"
bucket_name = "anime-master-game-images"
```

再检查图片 URL 是否走到了 Worker：

```text
https://game.example.com/api/r2-images/question-images/...
```

如果你配置了 `R2_PUBLIC_BASE_URL`，需要确保该域名已经绑定到 R2 bucket，且浏览器可以直接访问对象。
