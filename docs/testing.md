# 本地测试与选择规则

## 目的

本文规定修改代码后应运行哪些现有测试。执行者应根据改动范围主动完成相关验证，不等待用户逐项指定。

本项目暂不使用 Git hooks 或 GitHub Actions 自动触发测试；“自动”是指 Codex/开发者完成修改后按本规则主动执行，而不是每次保存文件都启动压力测试。

## 基础验证

多人游戏相关改动至少运行：

```powershell
npm run worker:typecheck
npm run lint
npm run build
```

纯文档改动只需检查链接、命令、数字来源和 `git diff --check`。纯首页文案或样式改动通常运行 `lint` 和 `build` 即可。

## 按改动范围选择测试

| 改动范围 | 必须追加运行 |
| --- | --- |
| IndexedDB Outbox、ACK、clientSeq、刷新补发 | `npm run test:authority-outbox`、`npm run test:authority-vnext` |
| WebSocket 协议、delta、snapshot、加入/退出、判定反馈 | `npm run test:authority-vnext`、`npm run test:authority-full-game` |
| 四种游戏模式、计分、阶段转换、deadline | `npm run test:authority-full-game`、`npm run test:authority-state-machine`、`npm run test:authority-vnext` |
| 本局随机抽题、题数设置、开局幂等或抽题快照恢复 | `npm run test:question-set-creation-method`、`npm run test:authority-vnext`、`npm run test:authority-full-game`、`npm run test:game-result-archive` |
| DO checkpoint、Hibernation、Attachment、Alarm、恢复 | `npm run test:authority-vnext`、`npm run test:authority-budget` |
| D1 最终投影、历史结算、roster handoff | `npm run test:authority-vnext`、`npm run test:game-result-archive`、`npm run test:authority-budget` |
| D1 migration 或 DO schema migration | 对应升级测试、重复初始化测试、失败不推进版本测试，以及 `worker:typecheck` |
| 房间 runtime generation、旧房间退役、DO namespace 分流 | `npm run test:room-runtime-cutover`、`npm run test:authority-outbox`、`npm run test:authority-local-runtime` |
| Worker 本地运行时、重连、并发、D1 热路径或额度模型 | 上述相关测试，再运行 `npm run test:authority-local-runtime` |
| 公开房间创建、目录、实时人数或题目来源 | `npm run test:public-rooms`、`npm run test:question-set-creation-method`、`npm run test:authority-vnext`、`npm run test:authority-local-runtime` |
| 首页密钥截图选择/拖放/粘贴、受限直链或 JSON/JSONL 导入、同标题追加、答案/标签、图片索引或投稿幂等 | `npm run test:community-screenshot-upload`、`npm run test:r2-upload`、`npm run test:question-set-creation-method` |
| 逐题 R18 标记的导入校验（`is_r18`/`isR18` 只接受 boolean、拒绝 null/冲突）、manifest/legacy/图片索引保存与保留、完整性报告 R18 mismatch 或 `0032_question_is_r18.sql` 迁移 | `npm run test:community-screenshot-upload`、`npm run test:community-question-list`、`npm run test:question-set-creation-method`，并按下方 D1 migration 规则覆盖升级与失败不推进 |
| 题库管理鉴权、检索、详情答案、逐题增删改查/换图/调序、元数据更新、安全删除、D1 引用保护或 R2 引用清理 | `npm run test:community-screenshot-upload`、`npm run test:r2-upload`、`npm run test:question-set-creation-method` |
| Bangumi 动画/游戏代理、规范化、范围缓存或上游边界 | `npm run test:bangumi-api`、`npm run test:community-screenshot-upload` |
| 首页 finalize 的 D1 batch/migration | 上述测试外，使用独立 `--persist-to` 状态在真实本地 Wrangler 中验证强制失败整批回滚、同投稿 ID 并发重试及不同投稿同标题并发追加 |

一项改动命中多行时取并集，不要只选择最短的一行。

## 测试职责

### `test:authority-vnext`

覆盖幂等、checkpoint generation、Hibernation、Attachment、Alarm、projection、legacy 兼容、50 人并发和 30 题写入预算等服务端权威行为。

### `test:authority-full-game`

以多个独立角色完成四种模式的整局流程，检查公开状态、定向消息、主持人操作、计分和结算结果。

### `test:authority-state-machine`

四种模式各使用固定随机种子交错执行多人动作、重复/乱序、角色变化、Alarm 和恢复。适用于容易遗漏组合状态的规则改动。

### `test:authority-outbox`

覆盖 IndexedDB 序号分配、durable ACK 清理、刷新保留和新旧 gameId 清理。

### `test:community-question-list`

覆盖出题工具 JSON/JSONL 题单解析的边界校验，包括 `is_r18`/`isR18` 布尔类型、null 拒绝、双字段冲突拒绝和缺省 false。

### `test:game-result-archive`

覆盖 D1 migration、聚合历史结算、旧 normalized 数据回退和损坏归档处理。

### `test:authority-budget`

执行快速、确定性的单局 DO/D1 写入预算断言。改变 checkpoint、投影、索引或归档结构时必须同步更新模型，不能只提高上限让测试通过。

### `test:community-screenshot-upload`

覆盖受保护投稿及题库管理 API，包括密钥拒绝、受限截图直链解析、动画/游戏标签规范化、列表边界、答案只在管理详情/单题响应返回、legacy/manifest/corrupt 存储检查、逐题新增/更新/换图/调序/删除、最后一题保护、社区题库累计超过 30 题（同标题追加与管理员逐题新增均不受 30 上限，但单次投稿仍最多 30 张、每局仍最多 30 题）、`updatedAt` 并发冲突、结构编辑后的规范集合解绑、活动游戏和准备房间写入拒绝、D1 级联，以及共享、损坏引用和 R2 删除失败时的安全清理行为。

### `test:authority-local-runtime`

使用本地 workerd、真实 WebSocket 和本地 D1 模拟 10 个房间、最终 281 人（极端房 50 名玩家加 50 名观战者）、30 题及重启恢复。为避免单核开发机把 10 个房间共 280 个初始成员的 D1 建房流量压成一次无界突发，测试逐房准备题库，但极端房的 99 名非房主成员仍并发加入；全部房间准备完成后，280 条 WebSocket 连接、快照、答题、重放、重连、判定和结算阶段继续跨房并发。该测试较慢，不要求每次普通 UI 修改都运行，但运行时、存储、协议和压力相关改动必须运行。

## 失败处理

- 修改前已有失败必须先复现并明确记录，不能归类为本次通过。
- 新增失败必须修复后重新运行受影响测试。
- 不得删除断言、减少人数/题数、扩大预算或跳过场景来掩盖失败。
- 最终报告应列出实际执行的命令、通过数量和未执行测试的理由。

## 额度联动

影响 Workers、Durable Objects、D1、R2、Images 或 Pages 用量的改动，还必须按 [`cloudflare-free-budget.md`](cloudflare-free-budget.md) 重新计算额度。测试通过不代表额度设计合理。
