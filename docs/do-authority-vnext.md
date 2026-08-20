# Room Durable Object Authority vNext

## 不可变目标与禁止项

- Room DO 是房间实时状态唯一协调中心；服务端权威决定阶段、deadline、结算和切题。
- 新游戏使用 authority vNext；已有进行中且没有 vNext `active_game` 的游戏继续 legacy。
- D1 只用于开局读取/房间长期索引及游戏结束聚合投影；游戏实时热路径 D1 写入为 0。
- 普通答案和普通判定只更新内存、Attachment 和小型 WebSocket delta，不单独写 SQL。
- 不可逆阶段变化必须 checkpoint 成功后才广播；不删除旧表、旧 journal 或旧数据。
- 禁止心跳、ping/pong 保活、周期 Alarm、周期 checkpoint timer、每动作 journal、HTTP 轮询和每动作完整 snapshot。
- 不依赖 DO 内存持续存活；不新增 Cloudflare 存储组件；不部署、提交、push 或建 PR。

## 最终状态分层

- 内存：当前游戏、题目/阶段/deadline、玩家、当前题答案与判定、累计分数、dirty generation、有界最近动作。
- Attachment：每连接身份和当前题未提交 mutation；上限 16,384 字节，预算 12,288 字节（75%）。
- IndexedDB Outbox：mutation 发送前落盘，durable ACK 后按 actor/clientSeq 清除。
- DO SQLite：`authority_vnext_active_game` 单行恢复聚合、每题一行 `authority_vnext_question_archive`、最多一行最终 `authority_vnext_projection_outbox`。
- D1：题库/房间索引/结束后聚合结果；开局可一次性读取，进行中不得查询或写入；vNext 历史结算使用单行 `game_result_archives`。
- `active_game` 只保存恢复当前局所需的题目、当前题、累计分数、committed seq 和 deadline；正常唤醒不读 archive。

## authority vNext 数据与版本分流

- DO schema 从生产 v6 只追加迁移到 v7；旧 migration 不改写，迁移完成并校验三张 vNext 表后才推进版本。
- `authority_version=2`、`schema_version`、`game_id` 和 cutover 状态持久化在 active row，不依赖内存判断。
- 新开局先写 `initializing` active row（含 startRequestId/参数），再执行 D1 开局，最后原子替换为 active aggregate。
- 中途崩溃时根据 initializing row 幂等核验/补完 D1 开局并完成 aggregate；缺 active row 才允许判定为 legacy。
- active row 存在且 gameId 匹配时走 vNext；否则正在进行的旧游戏走 legacy。
- vNext 不写 `processed_actions`、`mutation_journal*`、projection marker 或旧 normalized 游戏表。
- legacy 恢复、Alarm 和投影逻辑保留，仅服务升级前已进行中的游戏；不批量唤醒。

## Mutation、ACK 与幂等协议

- mutation envelope：`actionId, actorId, clientSeq, gameId, questionIndex, payload`；保留 action name 作为路由。
- 每 actor 的 clientSeq 严格单调：已 committed 的重发回 durable 状态；内存/Attachment 最近动作可回 provisional 结果。
- `clientSeq == lastSeen+1` 才应用；更小为 duplicate/replay，更大为明确 out-of-order 拒绝。
- 合法 envelope 的业务终止拒绝会消费 seq、进入 dirty committedSeq 流并返回 terminal rejection；语法/身份/乱序拒绝不消费。
- terminal rejection 在 durable ACK 前仍留 Outbox；重连重放返回同一拒绝，checkpoint 后才按 committed seq 清除。
- `gameId` 不匹配时拒绝；题目级 mutation 的题号、phase 不匹配时拒绝，加入/退出/角色/踢人/解散/取消本局/返回大厅等房间级 mutation 不受题号约束；最近 actionId 集合最多 512 项，按插入顺序淘汰。
- 普通答案：Outbox→DO 验证→分配 `serverReceivedAt/orderToken`→内存/Attachment→provisional ACK→主持人收到正文，所有连接只收到不含正文的参与状态 delta。
- 普通判定：Outbox→DO 验证→内存/主持人 Attachment→目标玩家及主持人收到完整 judgement delta，同时全房同步不含正文的判定、积分和本题结果 delta→provisional ACK。
- checkpoint 后发送 `checkpoint_committed(version, committedSeqByActor)`；客户端仅删除 `clientSeq <= committedSeq`。
- 客户端收到 durable ACK 时还必须原子推进对应 actor 的 IndexedDB 序号水位；HTTP vNext mutation 的响应也携带已提交序号提示，并在 RPC 返回页面前完成本地同步，避免两条连接乱序时与 Outbox 分配出相同 `clientSeq`。
- 握手确认当前持久化 gameId 后，客户端丢弃其他已结束 gameId 的 Outbox；旧局 envelope 在 vNext DO 明确拒绝，绝不回落 legacy。
- snapshot 仅用于加入、刷新、重连和版本缺口恢复；普通 mutation 不构建完整 snapshot。

## Rolling checkpoint

- 只在真实事件尾部惰性检查：dirty≥20、事件到来时距上次提交≥10秒、Attachment≥12,288字节、dirty 连接关闭。
- 结束题、锁定倒计时/顺序、切题、deadline、结束游戏、解散、最终投影均强制 persist-first checkpoint。
- 安静超过10秒不唤醒；答案/判定不 setAlarm；不用 setInterval 或循环 setTimeout。
- checkpoint 捕获 generation、aggregate 和 seq 快照，以单个 in-flight Promise 合并请求。
- 提交成功只推进捕获的 committed seq；期间到达的新 generation 保持 dirty，属于下一 checkpoint。
- 强制 checkpoint 记录 target generation，并循环等待/续提，直到该 generation 与 seq 已 committed；此前不得广播或执行副作用。
- 普通 checkpoint 尽量只 UPSERT active row（约1 changed row）；完成题额外 UPSERT 一条 archive。
- 50答案+50判定不得产生100次 checkpoint；50人近同时关闭只允许首个 checkpoint 提交全局 dirty。

## Hibernation 与 Attachment 恢复

- constructor 只做 v7 schema check；事件处理时读一行 active row，再枚举现存 WebSocket Attachment。
- 合并 `clientSeq > committedSeqByActor[actor]` 的 pending mutation，按 actor+seq/actionId 去重并按序重放。
- Attachment 只保留当前题未 checkpoint 项，不保存历史；成功 checkpoint 后压缩清除已 committed 项。
- 序列化前计算 UTF-8 JSON 字节；接近12,288字节先 checkpoint，仍超预算则只保留安全最小身份并记录降级。
- serialize/deserialize 失败不得使 DO 崩溃；不兼容版本忽略 pending 内容并要求客户端 Outbox 重放。
- 任一关闭连接携带未 committed mutation 时都 checkpoint 全 aggregate；单 in-flight 合并近同时关闭，clean close 不写。
- 主持人判定始终记录在主持人 Attachment/aggregate，不依赖目标玩家在线。
- vNext 唤醒不得读 D1、archive、旧 journal、旧 projection 或逐玩家 SQL，也不自动全房广播 snapshot。

## 广播与稳定窗口

- answer 正文定向发送给主持人和当前观战者（观战 UI 默认隐藏，打开“其他玩家回答”后展示）；3秒稳定窗口内主持人隐藏正文，窗口结束后立即显示并启用判定；judgement 立即发目标玩家和主持人；谁已作答、公开判定、积分和本题答对人数以小 delta 广播全房。
- Worker 转发 WebSocket 到 Room DO 时必须保留 `playerId` 查询参数；Attachment 连接身份不得依赖该连接先发送 mutation 才补全。
- 同一 payload 只 stringify 一次；普通 delta 目标小于1KB，目标玩家反馈不做延迟批处理。
- 3秒稳定窗口使用服务端绝对时间；`orderToken=serverReceivedAtMs:actorId:clientSeq` 构成可恢复全序，窗口结束由一次性 UI 定时器触发重绘，不参与保活或持久化。
- 恢复/补拉 snapshot 的 `serverNow` 必须使用快照生成时刻，不能复用持久化的轮次开始时刻；客户端不得被旧 snapshot 向后校时。
- `serverNow` 仅用于校时，不作为业务状态版本；公开 delta 顺序使用 realtime version，状态位置使用题号/轮次/轮次开始标识。
- 最终顺序在后续真实事件或 deadline 锁定，并先 checkpoint 后广播。

## Alarm 规则

- vNext 每个 Room DO 只维护当前唯一业务 deadline；deadline 未改变不得调用 `setAlarm()`。
- handler 读取 active row+Attachments，核对 authority/game/version/phase/deadline；过期已完成任务直接退出。
- deadline 转换幂等且 persist-first；有下一个真实 deadline 才重新 setAlarm。
- 不为 checkpoint、projection、连接恢复、答案、判定或保活设置 Alarm。
- 永久 schema/不兼容错误不重设；Cloudflare 自动重试由 `retryCount/isRetry` 观测并在应用层安全退出。
- 官方自动重试为2秒起始指数退避、最多6次；应用不得制造过去时间或近时无限循环。

## D1 最终投影

- 游戏正常结束或提前结算的 checkpoint 同时 UPSERT 唯一最终 projection outbox row，然后立即 best-effort 批量投影；取消本局只投影房间/成员 handoff，不生成游戏结果归档。
- 每个 outbox game entry 自带 `projectionVersion`：聚合归档为 v2，差量 roster 为 v3；无版本旧 entry 继续旧 normalized 投影，同一队列允许各版本并存。
- 结算快照中的 `questionSet.questions` 必须来自 authority 聚合的最新 `questions`，确保本局填写的正确答案无需等待 D1 投影即可在题库浏览中显示。
- 单行 outbox payload 是按 gameId 去重的有界聚合批次；新局结束只合并、不覆盖尚未成功的旧局结果。
- payload 上限1MiB并为下一局最坏聚合预留400KiB；接近上限时先同步排空，仍失败才禁止下一局，绝不覆盖/丢弃旧结果。
- D1 临时失败不回滚已结束游戏；小 outbox 不阻止下一局，后续真实事件继续重试且不设置投影 Alarm。
- 每次真实事件最多投影一个 game；新 vNext 只 UPSERT 一条结算归档，内容仅为最终排行榜与稀疏正分 `questionScores`，不得包含答案、判定详情或每动作历史。
- 新 vNext 不写 `game_participants`、`player_scores`、`question_results`；旧数据无归档时仍从三张旧表读取，旧 outbox 仍可写旧格式。
- v3 roster 使用期望列表对账：只删除离开/变化成员，只插入新增/变化成员；未变化成员不得触发 UPDATE，昵称互换必须先统一删除变化行再插入。
- 返回大厅的 roster handoff 未投影成功时，DO 继续提供大厅成员查询和 mutation；下一局开局前必须收敛 handoff，不能从过期 D1 roster 启动。
- 同一 outbox 只允许单个 in-flight flush；D1 外部 I/O 期间若 outbox 被新 mutation 替换，旧 flush 不得删除或覆盖新 payload。
- D1 migration `0012_game_result_archives.sql` 只追加且可重复执行；极端局最终 D1 计费写入目标≤500行，不能把约36条 SQL statements 当作 rows_written。
- 投影一个 game 后从 outbox 移除该项，全部排空才删除 outbox；新旧历史结果读取协议统一返回最终排行榜和逐题得分。
- 最终 waitUntil 是首轮收敛；若无后续事件仍失败，持久 outbox 保留到重连/下一局事件，不用 Alarm 违反休眠约束。

## 四模式转换与房间 mutation

- `confirmRevealBlocks` 开始绝对 deadline；`submit/forfeit/cancel` 只改当前轮；deadline `autoForfeit` 只锁提交并补未行动者放弃，保留当前轮等待主持人判定；仅手动 `settle/grade` 决定下一轮或答案复盘并强制 checkpoint。
- `ROUND_REVEAL` 的 `gradeAnswersAndAdvance` 按 roundScores 仅给首次正确者计分；全员正确进 REVIEW，否则停表等待下轮。
- `setAnswerJudgements/markPendingWrong/judgeBuzzerAnswer` 可在答案继续到达时执行；按 actionId 去重并从结果重算累计分数。
- `BUZZER_FIRST_CORRECT` 按 orderToken 判定；更早 pending 未判不得接受后项正确；首个正确强制 checkpoint 后进 REVIEW。
- `BUZZER_RANKED` 按整道题跨轮的稳定接收顺序计分，本题初始 N 名有效玩家依次获 N..1；每次改判重建本题全部正确 result、buzzer 分值和累计分数；后续轮只统计仍在房的 PLAYER 且本题尚未答对者。
- `TEAM_BATTLE` 的出题人禁选为高级设置且默认关闭。关闭时每题由 Room DO 直接进入 `REVEAL_VOTE` 并建立首个权威 deadline；开启时才先进入无 deadline/Alarm 的 `PRESENTER_BLOCK`，仅出题人通过一次 `completeTeamBattleBlockSelection` 提交去重、排序并按实际 35/45 格范围校验的 `disabledBlocks`。该 mutation 强制 phase-boundary checkpoint 并一次广播全房，然后启动首个投票 deadline；旧进行中状态缺少开关时按已开启兼容，不改变既有对局流程。
- `TEAM_BATTLE REVEAL_VOTE` 仅 activeTeam 成员投未揭且未禁用的方块，数量为 min(revealLimit,remainingSelectable)；阶段开始时立即产生 deadline（默认25秒）。activeTeam 全员首次提交完成且剩余超过5秒时，只允许把 deadline 单调缩短为5秒确认期；缩短后的 aggregate 必须先强制 checkpoint，再重排一次 Alarm，之后修改不得再次重排或延长。
- `TEAM_BATTLE GUESS_VOTE` 在阶段开始时立即产生 deadline（默认50秒），使用同一全员提交确认期规则；两种时长由房间设置限制在1～600秒，旧状态缺字段时使用默认值。
- `finalizeTeamBattleVote` 在 deadline 后原子结算截止前已提交的票；Room Alarm 是主触发源，Alarm 超过 deadline 仍未广播时仅出题人客户端在1秒后发送一次兜底意图，服务端必须再次校验出题人身份、题号、阶段、回合号和权威 deadline，普通玩家或旧阶段乱序消息不能触发。部分提交只统计提交者，选格零票时所有未揭且未禁用格为0票平票并随机开格，猜测零票时视为skip；其他最高票同票仍在同票集合内随机选择并公开提示；揭格→GUESS_VOTE，guess→JUDGING，skip→TURN_RESULT。
- `TEAM_BATTLE TURN_RESULT` 保存 `previousTurnAction` 并向全房展示“不猜”或错误猜测，不设置 deadline/Alarm，且保持原 activeTeam、turnNumber、currentRevealRound 不变。仅出题人可调用 `advanceTeamBattleTurn(expectedTurnNumber)`；Room DO 在确认时选择仍有成员的下一队、将 turnNumber/currentRevealRound 各加1，并依据上一动作设置 revealLimit（skip=1、guess=2），然后才进入 REVEAL_VOTE；未禁用格全部揭开（包括全部格子被禁用）时直接进入 GUESS_VOTE。若 revealLimit=2 但只剩一个可选格，只要求并揭开这一格。
- `advanceTeamBattleTurn` 对旧回合、重复和乱序请求返回当前公开状态而不推进；普通玩家无权调用。TURN_RESULT 在 Hibernation 恢复后继续等待确认，行动队员在此期间离房不会提前切队；确认时若只有原队仍有成员则原队继续，双方都无人则保留结算状态并要求出题人公布答案或结束游戏。
- TEAM_BATTLE 猜对给胜队现有成员各1分并进 REVIEW；`revealTeamBattleAnswer` 无分进 REVIEW；两者均全揭并停 deadline。
- TEAM_BATTLE 成员离开时移除 teams/votes/memberNames；除 TURN_RESULT 外，activeTeam 空则切换可行动队、清 votes/pending，并为当前投票阶段重新开始完整 deadline；当前队仍有人且其余成员已全部提交时可按同一规则缩短为5秒，但不得延长。TURN_RESULT 不因离房推进，双方都空时清除 deadline/Alarm，禁止形成无人自动循环。
- `advanceReviewedQuestion` 仅允许完整图片且 `roundStartedAt=null` 的复盘阶段；`skipCurrentQuestion` 保持显式跳题语义；二者均归档并强制 checkpoint。
- `updateQuestionLabel` 仅允许当前题复盘时首次填写；引用来源必须是本局当前题的普通或 buzzer answer，成功后广播公开 label delta。
- 四模式均测试前置条件、aggregate 字段、delta、deadline、计分、放弃/批判/切题，以及 legacy/vNext 等价结果。
- active vNext 期间加入/离开/踢人/角色变化只更新 DO aggregate；ended vNext 允许玩家退出并立即 checkpoint/投影房间 roster；下一题 eligibility 从 aggregate roster 一次计算。
- vNext 房间 mutation 必须保持原公开 RPC 返回契约；`joinRoom` 成功仍返回 `{ room, error, errorCode }`，不能以裸 `Room` 破坏调用方判断。
- 本局首次成为非出题人的 PLAYER 时进入只增不减的参赛者快照；出题人和从未参赛的观战者不得进入积分、逐题结果、排行榜或参赛者投影，离房或参赛后转观众不删除历史参赛身份。
- 游戏中不投影 D1 roster；结束/回大厅时差量对账。房间码发现可读 D1 索引；handoff 成功前实时 roster 必须从 DO 恢复。

## v7～v9 迁移验收

- 迁移只追加；v9 为 `rooms` 增加团队选格/猜测倒计时列，逐列检查后再推进 schema version。
- 测试空库、生产 v6/v8 fixture、重复初始化、中途失败不推进版本、未完成 legacy journal、已有业务 Alarm 恢复。

## 写入量和观测目标

- 50人×30题：DO changed rows 目标150–300；普通答案/判定0行；每题边界约2行；rolling checkpoint约1行。
- TEAM_BATTLE 默认关闭禁选，因此默认预算不增加主持人 mutation、广播或 phase-boundary checkpoint。开启时每题增加1个主持人 mutation 和1行 phase-boundary checkpoint；首个投票 Alarm 从题目建立时延后到禁选完成时设置，不增加每题 Alarm 总数。30题增加30个 mutation/30行，60局每天增加1,800个 mutation/1,800行。
- TEAM_BATTLE 每个未结束本题的猜测阶段最多增加1个 `advanceTeamBattleTurn` 主持人 mutation、1次小广播和1行 phase-boundary checkpoint；不增加 Alarm、D1 或轮询，50名玩家不会放大。
- 当前 legacy 普通答案约7–9行；判定为固定 journal/版本写加每目标2行及全员积分重算，最坏数十行。
- 结构化日志只在 checkpoint/阶段边界输出，不记录答案正文：authorityVersion、restore ms、active/Attachment bytes。
- 同时记录 checkpoint trigger/version/duration/changed rows、D1读写、广播次数/字节、ACK、duplicate、Alarm。
- 工程目标：restore p50<50ms/p95<100ms/p99<250ms；50 Attachment总量约100KB；判定可见p95≤150ms。

## 当前阶段与风险

- 当前阶段：历史结算聚合归档与 v3 roster 差量对账、handoff 安全边界均已完成并通过本地验证。
- 已完成：前三阶段及独立复核；阶段四50×30压力测试、Alarm/重放/断线/完整投影回归、四模式随机状态机，以及本地 workerd 10房间/最终281人（极端房100人）/30题/进程重启压力测试。
- 已确认问题：normalized SQL 热写、每动作 journal、全量 projection、D1/旧表恢复、Alarm 混用、客户端心跳、无 durable Outbox。
- 剩余工作：生产发布前应用 D1 0012 migration；生产真实网络与 Cloudflare 额度观测；本次不部署。
- 主要风险：极端情况下全员 roster 都真实变化仍会产生对应索引写入；生产投影延迟与工程测量不代表 Cloudflare SLA。

## 官方依据

- Hibernation/WebSocket Attachment：https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- DO State API：https://developers.cloudflare.com/durable-objects/api/state/
- SQLite Storage/计量：https://developers.cloudflare.com/durable-objects/api/storage-api/
- Alarm：https://developers.cloudflare.com/durable-objects/api/alarms/
- DO 定价与请求计量：https://developers.cloudflare.com/durable-objects/platform/pricing/
- Workers 请求计量：https://developers.cloudflare.com/workers/platform/pricing/
