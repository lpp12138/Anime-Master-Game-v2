import * as gameService from "./gameService";

import { RoomGameAuthority, type AuthorityVersion } from "./roomGameAuthority";
import {
  RoomAuthorityVNext,
  type VNextAggregate,
  type VNextMutationEnvelope,
  type VNextMutationOutcome,
  type VNextSocketAttachment,
  type VNextStartBootstrap,
} from "./roomAuthorityVNext";
import {
  CURRENT_ROOM_RUNTIME_GENERATION,
  ROOM_VERSION_EXPIRED_ERROR_CODE,
  ROOM_VERSION_EXPIRED_MESSAGE,
  RoomRuntimeV3Storage,
  RoomVersionExpiredError,
} from "./roomRuntimeV3";
import { getRoomNoticeUpdatedDelta } from "./roomNotice";
import type { GameDatabase, GameDatabaseMutationTracker } from "./d1QueryCompat";
import { getManifestImageUrls } from "./questionSetManifest";
import { buildRoomChatTeamAudience, RoomChatRateLimiter, tryHandleRoomChatMessage } from "./roomChat";
import {
  isR2ImageUploadTooLarge,
  R2_IMAGE_UPLOAD_MAX_BYTES,
  R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE,
} from "../src/lib/r2UploadPolicy";
import {
  COMMUNITY_SCREENSHOT_MAX_QUESTIONS,
  isCommunityScreenshotWithin1080p,
} from "../src/lib/communityScreenshotPolicy";
import { InvalidImageError, validateRasterImage } from "./imageValidation";
import { normalizeBangumiQuestionTags } from "../src/lib/bangumiTags";
import {
  BangumiApiError,
  getBangumiAnimeSubject,
  getBangumiSubjectCharacters,
  searchBangumiAnime,
} from "./bangumiApi";

import type {
  Answer,
  BangumiAnimeTag,
  BangumiCharacterTag,
  BuzzerAnswer,
  GameBootstrapSnapshot,
  GameResultSnapshot,
  GameSession,
  PlayerScore,
  Question,
  QuestionResult,
  QuestionSet,
  PublicRoomSummary,
  RealtimeDelta,
  Room,
  RoomQuestionSource,
  RoomStatus,
  GameMode,
  RoundSnapshot,
} from "../src/types/game";

export interface Env {
  DB: D1Database;
  ROOM_OBJECTS: DurableObjectNamespace;
  ROOM_OBJECTS_V3: DurableObjectNamespace;
  IMAGE_BUCKET: R2Bucket;
  ALLOWED_ORIGIN?: string;
  R2_IMAGE_PREFIX?: string;
  R2_PUBLIC_BASE_URL?: string;
  R2_EXISTING_IMAGE_LIMIT?: string;
  REMOTE_IMAGE_PROXY_CANDIDATES?: string;
  COMMUNITY_UPLOAD_SECRET?: string;
}

type RpcBody = {
  name?: string;
  args?: unknown[];
  clientActionId?: string;
};

type BroadcastMessage = {
  type: "change";
  name: string;
  result?: unknown;
  args?: unknown[];
  topic: string;
  version?: number;
  clientActionId?: string;
  delta?: RealtimeDelta;
  deltas?: RealtimeDelta[];
  roundSnapshot?: RoundSnapshot;
  gameResultSnapshot?: GameResultSnapshot;
};

type ClientBroadcastMessage = {
  type: "change";
  name: string;
  topic: string;
  version: number;
  clientActionId?: string;
  deltas?: RealtimeDelta[];
};

type AutoForfeitAlarmState = {
  key: string;
  gameSessionId: string;
  topic: string;
  runAtMs: number;
  questionIndex?: number;
  revealRound?: number;
  roundStartedAt?: string;
  attempts?: number;
};

type AutoForfeitScheduleMessage = {
  topic: string;
  result: unknown;
  roundSnapshot: RoundSnapshot | null;
  mutationName: MutationName;
  source: "http_rpc" | "local_rpc" | "websocket_action" | "legacy_endpoint";
};

type TeamBattleVoteAlarmState = {
  key: string;
  gameSessionId: string;
  topic: string;
  runAtMs: number;
  attempts?: number;
};

type DeadlineKind = "auto-forfeit" | "team-battle-vote";
const FORFEIT_ANSWER_TEXT = "__FORFEIT__";

function isQuestionReviewingSession(session: GameSession) {
  return session.gameMode === "TEAM_BATTLE"
    ? session.teamBattleState?.phase === "REVIEW"
    : !session.roundStartedAt && session.revealedBlocks.length >= 45;
}

export function projectSpectatorRoundSnapshot(snapshot: RoundSnapshot, playerAnswersEnabled: boolean) {
  if (playerAnswersEnabled || isQuestionReviewingSession(snapshot.gameSession)) return snapshot;
  const redactOrdinaryAnswer = (answer: Answer): Answer => ({
    ...answer,
    answerText: answer.answerText === FORFEIT_ANSWER_TEXT ? FORFEIT_ANSWER_TEXT : "",
  });
  const redactBuzzerAnswer = (answer: BuzzerAnswer): BuzzerAnswer => ({ ...answer, answerText: "" });
  return {
    ...snapshot,
    answers: snapshot.answers.map(redactOrdinaryAnswer),
    labelAnswers: snapshot.labelAnswers.map(redactOrdinaryAnswer),
    buzzerAnswers: snapshot.buzzerAnswers.map(redactBuzzerAnswer),
    labelBuzzerAnswers: snapshot.labelBuzzerAnswers.map(redactBuzzerAnswer),
  };
}

export function projectSpectatorBootstrapSnapshot(
  snapshot: GameBootstrapSnapshot,
  questionPreviewEnabled: boolean,
  playerAnswersEnabled: boolean,
) {
  if (isQuestionReviewingSession(snapshot.gameSession)) return snapshot;
  return {
    ...snapshot,
    questions: questionPreviewEnabled
      ? snapshot.questions
      : snapshot.questions.map((question) => ({
          ...question,
          labelText: null,
          labelSource: null,
          labelSourceAnswerId: null,
          labelUpdatedByPlayerId: null,
          labelUpdatedAt: null,
        })),
    roundSnapshot: projectSpectatorRoundSnapshot(snapshot.roundSnapshot, playerAnswersEnabled),
  };
}

export function getVNextAnswerViewerIds(aggregate: VNextAggregate | null) {
  const presenterId = aggregate?.gameSession?.presenterPlayerId;
  const answerViewerIds = new Set(aggregate?.players
    .filter((player) => player.role === "SPECTATOR" && aggregate.room?.spectatorPlayerAnswersEnabled !== false)
    .map((player) => player.id) ?? []);
  const session = aggregate?.gameSession;
  if (session && session.gameMode !== "TEAM_BATTLE") {
    const correctPlayerIds = new Set(
      aggregate?.questionResults
        .filter((result) => result.questionIndex === session.currentQuestionIndex)
        .map((result) => result.playerId) ?? [],
    );
    for (const player of aggregate?.players ?? []) {
      if (player.role === "PLAYER" && player.id !== presenterId && correctPlayerIds.has(player.id)) {
        answerViewerIds.add(player.id);
      }
    }
  }
  return answerViewerIds;
}

type DeadlineTransition =
  | { type: "noop" }
  | { type: "upsert"; kind: "auto-forfeit"; state: AutoForfeitAlarmState }
  | { type: "upsert"; kind: "team-battle-vote"; state: TeamBattleVoteAlarmState }
  | {
      type: "clear";
      kind: DeadlineKind;
      gameSessionId: string;
      topic: string;
      expectedKey: string;
    };

type MutationExecutionResult<T> = {
  data: T;
  deadlineTransitions: DeadlineTransition[];
};

type MutationDeadlinePolicy = "none" | "authoritative-post-state";

class DeadlineTransitionApplyError extends Error {
  readonly code = "DEADLINE_RECOVERY_REQUIRED";

  constructor() {
    super("操作状态可能已由服务端提交，但倒计时同步失败。请等待页面恢复或刷新状态，不要重复提交操作。");
    this.name = "DeadlineTransitionApplyError";
  }
}

type GameRpcErrorLogContext = {
  roomId?: string | null;
  gameSessionId?: string | null;
  questionIndex?: number | null;
  expectedQuestionIndex?: number | null;
  playerCount?: number | null;
  eligiblePlayerCount?: number | null;
};

const ACTION_RESULT_TTL_MS = 10_000;
const ROUND_SNAPSHOT_CACHE_TTL_MS = 1_000;
const BOOTSTRAP_SNAPSHOT_CACHE_TTL_MS = 2_000;
const GAME_RESULT_SNAPSHOT_CACHE_TTL_MS = 5_000;
const CACHE_SWEEP_INTERVAL_MS = 1_000;
const RECENT_ACTION_CACHE_MAX_ENTRIES = 512;
const ROUND_SNAPSHOT_CACHE_MAX_ENTRIES = 32;
const BOOTSTRAP_SNAPSHOT_CACHE_MAX_ENTRIES = 16;
const GAME_RESULT_SNAPSHOT_CACHE_MAX_ENTRIES = 16;
const RPC_BODY_MAX_BYTES = 64 * 1024;
const LOCAL_ROOM_OBJECT_TOPIC_HEADER = "x-local-room-object-topic";
const ROUND_DEADLINE_GRACE_MS = 3000;
const AUTO_FORFEIT_ALARM_STORAGE_KEY = "auto-forfeit-alarm";
const AUTO_FORFEIT_COMPLETED_KEY_STORAGE_KEY = "auto-forfeit-completed-key";
const AUTO_FORFEIT_ALARM_RETRY_DELAY_MS = 1000;
const AUTO_FORFEIT_ALARM_MAX_ATTEMPTS = 3;
const TEAM_BATTLE_VOTE_ALARM_STORAGE_KEY = "team-battle-vote-alarm";
const TEAM_BATTLE_VOTE_COMPLETED_KEY_STORAGE_KEY = "team-battle-vote-completed-key";
const TEAM_BATTLE_VOTE_ALARM_RETRY_DELAY_MS = 1000;
const TEAM_BATTLE_VOTE_ALARM_MAX_ATTEMPTS = 3;
const BUSINESS_ALARM_RECOVERY_RETRY_DELAY_MS = 30_000;
const BUSINESS_ALARM_MIN_SCHEDULE_DELAY_MS = 1000;
const REMOTE_IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;
const R2_IMAGE_ROUTE_PREFIX = "/api/r2-images/";
const COMMUNITY_QUESTION_SET_BODY_MAX_BYTES = 512 * 1024;
const COMMUNITY_UPLOAD_KEY_HEADER = "x-community-upload-key";
const COMMUNITY_UPLOAD_SECRET_MIN_LENGTH = 24;
const ROOM_CLEANUP_IDLE_MS = 48 * 60 * 60 * 1000;
const ROOM_CLEANUP_MAX_ROOMS_PER_RUN = 50;
const ROOM_CLEANUP_MAX_ORPHAN_QUESTION_SETS_PER_RUN = 100;
const ROOM_CLEANUP_SQL_CHUNK_SIZE = 50;
const R2_ORPHAN_CLEANUP_MIN_AGE_MS = 72 * 60 * 60 * 1000;
const R2_ORPHAN_CLEANUP_LIST_LIMIT = 1000;
const R2_DELETE_MAX_KEYS_PER_CALL = 1000;
const R2_CLEANUP_MAX_DELETE_PER_RUN = 10_000;
const RPC_LOG_ID_MAX_LENGTH = 160;
const RPC_LOG_NAME_MAX_LENGTH = 120;
const RPC_LOG_ERROR_MAX_LENGTH = 4000;
const GAME_SESSION_ID_STRING_ARG_NAMES = new Set([
  "getGameBootstrapSnapshot",
  "getGameResultSnapshot",
  "getGameSessionById",
  "getLeaderboardForGameSession",
  "getPlayerScores",
  "getQuestionResultsForGameSession",
  "getRoundSnapshot",
]);
const GAME_SESSION_ID_OBJECT_ARG_NAMES = new Set([
  "getQuestionResultsForQuestion",
  "getAnswersForQuestion",
  "getAnswersForQuestionRound",
  "getAnswerForPlayerRound",
  "getBuzzerAnswersForQuestion",
  "getBuzzerAnswersForQuestionRound",
  "getBuzzerAnswerForPlayerRound",
]);
const DEFAULT_REMOTE_IMAGE_PROXY_CANDIDATES = [
  "https://corsproxy.io/?url=",
  "https://api.allorigins.win/raw?url=",
  "https://api.codetabs.com/v1/proxy?quest=",
];

const SERVER_RECEIVED_AT_ACTION_NAMES = new Set([
  "submitAnswer",
  "submitForfeitAnswer",
  "cancelForfeitAnswer",
  "submitBuzzerAnswer",
  "completeTeamBattleBlockSelection",
  "advanceTeamBattleTurn",
  "submitTeamBattleRevealVote",
  "submitTeamBattleGuessVote",
  "autoForfeitExpiredRound",
  "settleBuzzerRound",
]);

const MUTATION_REGISTRY = {
  createRoom: { deadline: "none" },
  joinRoom: { deadline: "none" },
  updatePlayerRole: { deadline: "none" },
  leaveRoom: { deadline: "authoritative-post-state" },
  kickPlayerFromRoom: { deadline: "authoritative-post-state" },
  dissolveRoom: { deadline: "authoritative-post-state" },
  selectPresenterForRound: { deadline: "authoritative-post-state" },
  cancelCurrentRound: { deadline: "authoritative-post-state" },
  cancelPresenterSetup: { deadline: "authoritative-post-state" },
  createUploadedQuestionSet: { deadline: "none" },
  prepareQuestionSetForStart: { deadline: "none" },
  updateRoomGameSettings: { deadline: "none" },
  updateRoomNotice: { deadline: "none" },
  selectTeamForPlayer: { deadline: "none" },
  startGameWithQuestionSet: { deadline: "authoritative-post-state" },
  confirmRevealBlocks: { deadline: "authoritative-post-state" },
  submitAnswer: { deadline: "none" },
  submitForfeitAnswer: { deadline: "none" },
  autoForfeitExpiredRound: { deadline: "authoritative-post-state" },
  cancelForfeitAnswer: { deadline: "none" },
  submitBuzzerAnswer: { deadline: "none" },
  judgeBuzzerAnswer: { deadline: "authoritative-post-state" },
  setAnswerJudgements: { deadline: "authoritative-post-state" },
  markPendingRoundAnswersWrong: { deadline: "authoritative-post-state" },
  settleBuzzerRound: { deadline: "authoritative-post-state" },
  completeTeamBattleBlockSelection: { deadline: "authoritative-post-state" },
  submitTeamBattleRevealVote: { deadline: "authoritative-post-state" },
  submitTeamBattleGuessVote: { deadline: "authoritative-post-state" },
  finalizeTeamBattleVote: { deadline: "authoritative-post-state" },
  judgeTeamBattleGuess: { deadline: "authoritative-post-state" },
  advanceTeamBattleTurn: { deadline: "authoritative-post-state" },
  revealTeamBattleAnswer: { deadline: "authoritative-post-state" },
  gradeAnswersAndAdvance: { deadline: "authoritative-post-state" },
  advanceReviewedQuestion: { deadline: "authoritative-post-state" },
  publishQuestionSetToCommunity: { deadline: "none" },
  rateCommunityQuestionSet: { deadline: "none" },
  updateQuestionLabel: { deadline: "none" },
  skipCurrentQuestion: { deadline: "authoritative-post-state" },
  endCurrentGameEarly: { deadline: "authoritative-post-state" },
  returnRoomToLobby: { deadline: "authoritative-post-state" },
} as const satisfies Record<string, { deadline: MutationDeadlinePolicy }>;

type MutationName = keyof typeof MUTATION_REGISTRY;

const QUERY_NAMES = [
  "assertCanCreateUploadedQuestionSet",
  "getAnswerForPlayerRound",
  "getAnswersForQuestion",
  "getAnswersForQuestionRound",
  "getBuzzerAnswerForPlayerRound",
  "getBuzzerAnswersForQuestion",
  "getBuzzerAnswersForQuestionRound",
  "getCommunityQuestionSetDetail",
  "getCommunityQuestionSets",
  "getGameBootstrapSnapshot",
  "getGameResultSnapshot",
  "getGameSessionById",
  "getLeaderboardForGameSession",
  "getPlayerScores",
  "getPlayersByRoomId",
  "getQuestionResultsForGameSession",
  "getQuestionResultsForQuestion",
  "getQuestionSetById",
  "getQuestionSetRatingProgress",
  "getQuestionsByQuestionSetId",
  "getRoomByCode",
  "getRoomWithPlayers",
  "getRoundSnapshot",
] as const;

type QueryName = (typeof QUERY_NAMES)[number];
type CallableGameServiceName = {
  [Name in keyof typeof gameService]: (typeof gameService)[Name] extends (...args: never[]) => unknown ? Name : never;
}[keyof typeof gameService] & string;
type InternalGameServiceName =
  | "dissolveRoomOnPageExit"
  | "createQuestionSetFromUrlText"
  | "createHomepageCommunityQuestionSet"
  | "getDeadlineStateForRoomId"
  | "getRoomIdForGameSession"
  | "parseImageUrlsText"
  | "parseQuestionImportText"
  | "runWithGameDatabase";
type AssertNever<Value extends never> = Value;
type MissingGameServiceClassification = AssertNever<
  Exclude<CallableGameServiceName, MutationName | QueryName | InternalGameServiceName>
>;
type UnknownMutationRegistration = AssertNever<Exclude<MutationName, CallableGameServiceName>>;
type UnknownQueryRegistration = AssertNever<Exclude<QueryName, CallableGameServiceName>>;

const PUBLIC_RPC_NAMES: ReadonlySet<string> = new Set([...Object.keys(MUTATION_REGISTRY), ...QUERY_NAMES]);

function getMutationDeadlinePolicy(name: string): MutationDeadlinePolicy | null {
  return name in MUTATION_REGISTRY ? MUTATION_REGISTRY[name as MutationName].deadline : null;
}

function shouldAdvanceRoomVersion(name: string, result: unknown) {
  return !(name === "updateRoomNotice" && isRecord(result) && result.changed === false);
}

const COMPACT_SNAPSHOT_MUTATION_NAMES = new Set([
  "startGameWithQuestionSet",
  "leaveRoom",
  "kickPlayerFromRoom",
  "confirmRevealBlocks",
  "autoForfeitExpiredRound",
  "settleBuzzerRound",
  "completeTeamBattleBlockSelection",
  "finalizeTeamBattleVote",
  "judgeTeamBattleGuess",
  "advanceTeamBattleTurn",
  "revealTeamBattleAnswer",
  "gradeAnswersAndAdvance",
  "advanceReviewedQuestion",
  "skipCurrentQuestion",
  "endCurrentGameEarly",
]);

const GAME_RESULT_SNAPSHOT_MUTATION_NAMES = new Set([
  "advanceReviewedQuestion",
  "skipCurrentQuestion",
  "endCurrentGameEarly",
]);

const DELTA_ONLY_ROUND_CACHE_INVALIDATION_MUTATION_NAMES = new Set([
  "submitAnswer",
  "submitForfeitAnswer",
  "cancelForfeitAnswer",
  "submitBuzzerAnswer",
  "judgeBuzzerAnswer",
  "setAnswerJudgements",
  "markPendingRoundAnswersWrong",
  "submitTeamBattleRevealVote",
  "submitTeamBattleGuessVote",
  "updateQuestionLabel",
]);

const ROOM_AUTHORITY_GAME_NAMES = new Set<string>([
  "getGameBootstrapSnapshot", "getGameResultSnapshot", "getGameSessionById", "getLeaderboardForGameSession",
  "getPlayerScores", "getQuestionResultsForGameSession", "getQuestionResultsForQuestion", "getRoundSnapshot",
  "getAnswersForQuestion", "getAnswersForQuestionRound", "getAnswerForPlayerRound", "getBuzzerAnswersForQuestion",
  "getBuzzerAnswersForQuestionRound", "getBuzzerAnswerForPlayerRound", "getQuestionsByQuestionSetId",
  "confirmRevealBlocks", "submitAnswer", "submitForfeitAnswer", "cancelForfeitAnswer", "submitBuzzerAnswer",
  "judgeBuzzerAnswer", "setAnswerJudgements", "markPendingRoundAnswersWrong", "settleBuzzerRound", "autoForfeitExpiredRound", "completeTeamBattleBlockSelection", "submitTeamBattleRevealVote",
  "submitTeamBattleGuessVote", "finalizeTeamBattleVote", "judgeTeamBattleGuess", "advanceTeamBattleTurn", "revealTeamBattleAnswer",
  "gradeAnswersAndAdvance", "advanceReviewedQuestion", "updateQuestionLabel", "skipCurrentQuestion",
  "endCurrentGameEarly", "returnRoomToLobby",
]);

const ROOM_AUTHORITY_MEMBERSHIP_NAMES = new Set(["joinRoom", "leaveRoom", "kickPlayerFromRoom", "dissolveRoom", "updatePlayerRole"]);
const ROOM_AUTHORITY_ACTIVE_ONLY_NAMES = new Set(["cancelCurrentRound"]);
const ROOM_AUTHORITY_ROSTER_QUERY_NAMES = new Set(["getRoomWithPlayers", "getPlayersByRoomId"]);
const VNEXT_POSITIONAL_ROOM_MUTATIONS = new Set(["joinRoom", "leaveRoom", "kickPlayerFromRoom", "dissolveRoom", "updatePlayerRole", "cancelCurrentRound", "returnRoomToLobby"]);
const ROOM_HANDOFF_BARRIER_NAMES = new Set([
  "selectPresenterForRound",
  "cancelPresenterSetup",
  "prepareQuestionSetForStart",
  "updateRoomGameSettings",
  "updateRoomNotice",
  "selectTeamForPlayer",
  "startGameWithQuestionSet",
]);

function getJoinCapacityErrorCode(error: string | undefined) {
  if (error?.startsWith("玩家已满")) return "PLAYER_CAPACITY_FULL";
  if (error?.startsWith("观战人数已满")) return "SPECTATOR_CAPACITY_FULL";
  return undefined;
}

function shouldUseVNextRoomState(aggregate: VNextAggregate | null, hasPendingRoomHandoff: boolean) {
  return Boolean(
    aggregate?.gameSession
    && aggregate.cutoverState !== "initializing"
    && (aggregate.room?.status !== "LOBBY" || hasPendingRoomHandoff),
  );
}

function getVNextPositionalMutation(name: string, args: unknown[]) {
  switch (name) {
    case "joinRoom": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomCode: args[0], playerId: args[1], nickname: args[2], role: args[3], team: args[4] } } : null;
    case "leaveRoom": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], playerId: args[1] } } : null;
    case "kickPlayerFromRoom": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], hostPlayerId: args[1], targetPlayerId: args[2] } } : null;
    case "dissolveRoom": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], hostPlayerId: args[1] } } : null;
    case "updatePlayerRole": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], actorPlayerId: args[1], targetPlayerId: args[2], role: args[3], team: args[4] } } : null;
    case "cancelCurrentRound": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], hostPlayerId: args[1] } } : null;
    case "returnRoomToLobby": return typeof args[1] === "string" ? { actorId: args[1], payload: { roomId: args[0], hostPlayerId: args[1] } } : null;
    default: return null;
  }
}

const AUTHORITY_PROJECTION_BOUNDARY_NAMES = new Set<string>([
  "cancelCurrentRound", "dissolveRoom", "revealTeamBattleAnswer", "gradeAnswersAndAdvance", "advanceReviewedQuestion", "updateQuestionLabel",
  "skipCurrentQuestion", "endCurrentGameEarly", "returnRoomToLobby", "joinRoom", "leaveRoom", "kickPlayerFromRoom", "updatePlayerRole",
]);
const AUTHORITY_HANDOFF_NAMES = new Set(["returnRoomToLobby", "cancelCurrentRound", "dissolveRoom"]);
const AUTHORITY_JOURNALED_NAMES = new Set([
  "submitAnswer", "submitForfeitAnswer", "cancelForfeitAnswer", "judgeBuzzerAnswer", "setAnswerJudgements", "markPendingRoundAnswersWrong", "settleBuzzerRound",
  "completeTeamBattleBlockSelection", "finalizeTeamBattleVote", "judgeTeamBattleGuess", "advanceTeamBattleTurn", "revealTeamBattleAnswer", "gradeAnswersAndAdvance",
  "advanceReviewedQuestion", "skipCurrentQuestion", "endCurrentGameEarly", "joinRoom", "leaveRoom", "kickPlayerFromRoom", "updatePlayerRole", ...AUTHORITY_HANDOFF_NAMES,
]);
const AUTHORITY_PERSIST_RESULT_NAMES = new Set([
  "judgeBuzzerAnswer", "setAnswerJudgements", "markPendingRoundAnswersWrong", "settleBuzzerRound", "completeTeamBattleBlockSelection", "finalizeTeamBattleVote", "judgeTeamBattleGuess", "advanceTeamBattleTurn", "revealTeamBattleAnswer",
  "gradeAnswersAndAdvance", "advanceReviewedQuestion", "skipCurrentQuestion", "endCurrentGameEarly", ...AUTHORITY_HANDOFF_NAMES,
]);

function corsHeaders(request: Request, env: Env) {
  const requestOrigin = request.headers.get("origin") ?? "";
  const allowedOrigins = (env.ALLOWED_ORIGIN ?? "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin = allowedOrigins.includes("*")
    ? requestOrigin || "*"
    : allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins[0] ?? "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": `content-type,${COMMUNITY_UPLOAD_KEY_HEADER}`,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function withCors(response: Response, request: Request, env: Env) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(request, env))) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data: unknown, init: ResponseInit = {}, request: Request, env: Env) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(request, env),
      ...init.headers,
    },
  });
}

function toUserErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";

  if (!message) {
      return "服务发生未知错误，请查看日志。";
  }

  if (/^[\x00-\x7F]+$/.test(message)) {
    if (/unique constraint/i.test(message)) {
      return "保存失败：数据已存在，请刷新后重试。";
    }
    if (/foreign key constraint/i.test(message)) {
      return "保存失败：关联数据不存在，请刷新后重试。";
    }
    if (/not null constraint/i.test(message)) {
      return "保存失败：缺少必填数据。";
    }
    if (/check constraint/i.test(message)) {
      return "保存失败：数据不符合规则。";
    }
    if (/no such table/i.test(message)) {
      return "数据库表不存在，请先执行数据库迁移。";
    }
    return "服务发生内部错误，请查看日志。";
  }

  return message;
}

function errorResponse(error: unknown, request: Request, env: Env) {
  const message = toUserErrorMessage(error);
  if (error instanceof RoomVersionExpiredError) {
    return json({ error: message, code: error.code }, { status: error.status }, request, env);
  }
  if (error instanceof DeadlineTransitionApplyError) {
    return json(
      {
        error: message,
        code: error.code,
        recoveryRequired: true,
        stateMayHaveCommitted: true,
      },
      { status: 503 },
      request,
      env,
    );
  }
  return json({ error: message }, { status: 400 }, request, env);
}

async function readLimitedRequestText(request: Request, maxBytes: number) {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("请求内容过大，请缩小后重试。");
  }

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error("请求内容过大，请缩小后重试。");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

async function readRpcBody(request: Request) {
  const text = await readLimitedRequestText(request, RPC_BODY_MAX_BYTES);
  if (!text.trim()) {
    throw new Error("请求内容不能为空。");
  }

  return JSON.parse(text) as RpcBody;
}

function getExportedFunction(name: string) {
  if (!PUBLIC_RPC_NAMES.has(name)) {
    throw new Error(`未知游戏接口：${name}`);
  }
  const fn = (gameService as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`未知游戏接口：${name}`);
  }
  return fn as (...args: unknown[]) => Promise<unknown>;
}

function getRoomObject(env: Env, topic: string) {
  return env.ROOM_OBJECTS_V3.get(env.ROOM_OBJECTS_V3.idFromName(topic));
}

function getRoomIdFromRequiredTopic(topic: string) {
  const roomId = getRoomIdFromTopic(topic);
  if (!roomId) throw new Error("实时房间标识无效。");
  return roomId;
}

async function assertCurrentRoomRuntime(env: Env, topic: string) {
  const roomId = getRoomIdFromRequiredTopic(topic);
  const row = await env.DB.prepare("select runtime_generation from rooms where id = ?")
    .bind(roomId)
    .first<{ runtime_generation: number | null }>();
  if (row && Number(row.runtime_generation) !== CURRENT_ROOM_RUNTIME_GENERATION) {
    throw new RoomVersionExpiredError();
  }
  return row != null;
}

function expiredRoomWebSocketResponse() {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  server.send(JSON.stringify({
    type: "room_expired",
    code: ROOM_VERSION_EXPIRED_ERROR_CODE,
    message: ROOM_VERSION_EXPIRED_MESSAGE,
  }));
  server.close(4001, ROOM_VERSION_EXPIRED_ERROR_CODE);
  return new Response(null, { status: 101, webSocket: client });
}

async function runWithGameDatabase<T>(env: Env, callback: () => Promise<T>) {
  return await gameService.runWithGameDatabase(env.DB, callback);
}

function attachServerReceivedAt(name: string, args: unknown[], receivedAtMs?: number) {
  if (!SERVER_RECEIVED_AT_ACTION_NAMES.has(name) || typeof receivedAtMs !== "number" || !Number.isFinite(receivedAtMs)) {
    return args;
  }

  const [firstArg, ...restArgs] = args ?? [];
  if (!isRecord(firstArg)) {
    return args;
  }

  return [{ ...firstArg, serverReceivedAtMs: receivedAtMs }, ...restArgs];
}

async function callGameFunction(name: string, args: unknown[], receivedAtMs?: number) {
  return await getExportedFunction(name)(...attachServerReceivedAt(name, args ?? [], receivedAtMs));
}

async function callGameFunctionWithEnv(name: string, args: unknown[], request: Request, env: Env, receivedAtMs?: number) {
  return await callGameFunction(name, args, receivedAtMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getQueryGameSessionId(name: string | undefined, args: unknown[] | undefined) {
  const firstArg = args?.[0];
  if (name && GAME_SESSION_ID_STRING_ARG_NAMES.has(name) && typeof firstArg === "string") {
    return firstArg;
  }
  if (name && GAME_SESSION_ID_OBJECT_ARG_NAMES.has(name) && isRecord(firstArg) && typeof firstArg.gameSessionId === "string") {
    return firstArg.gameSessionId;
  }
  return null;
}

function isGameSessionRecord(value: Record<string, unknown>) {
  return typeof value.id === "string" && typeof value.roomId === "string" && "currentQuestionIndex" in value;
}

function getResultGameSessionId(result: unknown) {
  if (!isRecord(result)) {
    return null;
  }

  if (isGameSessionRecord(result)) {
    return result.id;
  }

  const gameSession = result.gameSession;
  if (isRecord(gameSession) && typeof gameSession.id === "string") {
    return gameSession.id;
  }

  if (typeof result.gameSessionId === "string") {
    return result.gameSessionId;
  }

  return null;
}

function getDeltaOnlyRoundCacheInvalidationGameSessionId(name: string, result: unknown, args: unknown[] = []) {
  if (!DELTA_ONLY_ROUND_CACHE_INVALIDATION_MUTATION_NAMES.has(name)) return null;
  if (name === "updateQuestionLabel" && isRecord(args[0]) && typeof args[0].gameSessionId === "string") {
    return args[0].gameSessionId;
  }
  return getResultGameSessionId(result);
}

async function getRoundSnapshotForMutation(name: string, result: unknown) {
  if (!COMPACT_SNAPSHOT_MUTATION_NAMES.has(name)) {
    return null;
  }

  const gameSessionId = getResultGameSessionId(result);
  if (gameSessionId) {
    return await gameService.getRoundSnapshot(gameSessionId);
  }

  const room = getResultRoom(result);
  if ((name === "kickPlayerFromRoom" || name === "leaveRoom") && room?.status === "PLAYING" && room.currentGameId) {
    return await gameService.getRoundSnapshot(room.currentGameId);
  }

  return null;
}

async function getGameResultSnapshotForMutation(name: string, result: unknown) {
  if (!GAME_RESULT_SNAPSHOT_MUTATION_NAMES.has(name)) {
    return null;
  }

  const gameSession = getResultGameSession(result);
  if (gameSession?.status === "GAME_RESULT") {
    return await gameService.getGameResultSnapshot(gameSession.id);
  }

  const room = getResultRoom(result);
  if (room?.status === "GAME_RESULT" && room.currentGameId) {
    return await gameService.getGameResultSnapshot(room.currentGameId);
  }

  return null;
}

function attachRoundSnapshot(result: unknown, roundSnapshot: RoundSnapshot | null) {
  if (!roundSnapshot || !isRecord(result)) {
    return result;
  }

  return {
    ...result,
    roundSnapshot,
  };
}

function stripRoundSnapshotFromBroadcastResult(result: unknown) {
  if (!isRecord(result) || !("roundSnapshot" in result)) {
    return result;
  }

  const { roundSnapshot: _roundSnapshot, ...broadcastResult } = result;
  return broadcastResult;
}

function asRoom(value: unknown): Room | null {
  return isRecord(value) && typeof value.code === "string" && typeof value.status === "string" ? (value as Room) : null;
}

function asGameSession(value: unknown): GameSession | null {
  return isRecord(value) && isGameSessionRecord(value) ? (value as GameSession) : null;
}

function asAnswer(value: unknown): Answer | null {
  return isRecord(value) && typeof value.id === "string" && typeof value.gameSessionId === "string" && "answerText" in value && "submittedAt" in value
    ? (value as Answer)
    : null;
}

function asBuzzerAnswer(value: unknown): BuzzerAnswer | null {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.gameSessionId === "string" &&
    "answerText" in value &&
    "submittedAt" in value &&
    typeof value.status === "string" &&
    "scoreAwarded" in value
    ? (value as BuzzerAnswer)
    : null;
}

function asArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

function asQuestion(value: unknown): Question | null {
  return isRecord(value) && typeof value.id === "string" && typeof value.questionSetId === "string" && "orderIndex" in value
    ? (value as Question)
    : null;
}

function asQuestionSet(value: unknown): QuestionSet | null {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && "imageCount" in value
    ? (value as QuestionSet)
    : null;
}

function getResultRoom(result: unknown) {
  if (isRecord(result)) {
    return asRoom(result.room) ?? asRoom(result);
  }
  return null;
}

function getResultGameSession(result: unknown) {
  if (isRecord(result)) {
    return asGameSession(result.gameSession) ?? asGameSession(result);
  }
  return null;
}

function sanitizeLogString(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function getRoomIdFromTopic(topic: string | null | undefined) {
  const normalizedTopic = sanitizeLogString(topic, RPC_LOG_ID_MAX_LENGTH);
  return normalizedTopic?.startsWith("room:") ? normalizedTopic.slice("room:".length) || null : null;
}

function getSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function getGameRpcArgumentLogContext(name: string | undefined, args: unknown[]): GameRpcErrorLogContext {
  const firstArg = args[0];
  if (isRecord(firstArg)) {
    return {
      roomId: sanitizeLogString(firstArg.roomId, RPC_LOG_ID_MAX_LENGTH),
      gameSessionId:
        sanitizeLogString(firstArg.gameSessionId, RPC_LOG_ID_MAX_LENGTH) ??
        (name === "startGameWithQuestionSet" ? sanitizeLogString(firstArg.startRequestId, RPC_LOG_ID_MAX_LENGTH) : null),
      questionIndex: getSafeInteger(firstArg.questionIndex),
      expectedQuestionIndex: getSafeInteger(firstArg.expectedQuestionIndex),
    };
  }

  if (typeof firstArg === "string" && name && GAME_SESSION_ID_STRING_ARG_NAMES.has(name)) {
    return {
      gameSessionId: sanitizeLogString(firstArg, RPC_LOG_ID_MAX_LENGTH),
    };
  }

  return {};
}

function getGameSessionEligiblePlayerCount(gameSession: GameSession | null | undefined) {
  if (!gameSession?.eligiblePlayerIds) {
    return null;
  }

  return new Set(gameSession.eligiblePlayerIds).size;
}

function getRoomPlayerCount(room: Room | null | undefined) {
  if (!room || room.players.length === 0) {
    return null;
  }

  return room.players.filter((player) => player.role !== "SPECTATOR").length;
}

function getErrorLogDetails(error: unknown) {
  const errorRecord = isRecord(error) ? error : null;
  const errorCode = errorRecord?.code;

  return {
    error: sanitizeLogString(error instanceof Error ? error.message : String(error), RPC_LOG_ERROR_MAX_LENGTH),
    errorName: sanitizeLogString(error instanceof Error ? error.name : typeof error, RPC_LOG_NAME_MAX_LENGTH),
    errorCode:
      typeof errorCode === "string" || typeof errorCode === "number"
        ? sanitizeLogString(String(errorCode), RPC_LOG_NAME_MAX_LENGTH)
        : null,
    errorStack: sanitizeLogString(error instanceof Error ? error.stack : null, RPC_LOG_ERROR_MAX_LENGTH),
  };
}

function getAutoForfeitGameSession(result: unknown, roundSnapshot: RoundSnapshot | null) {
  return roundSnapshot?.gameSession ?? getResultGameSession(result);
}

function asRoundSnapshot(value: unknown): RoundSnapshot | null {
  return isRecord(value) &&
    asGameSession(value.gameSession) &&
    Array.isArray(value.scores) &&
    Array.isArray(value.questionResults) &&
    Array.isArray(value.answers) &&
    Array.isArray(value.labelAnswers) &&
    Array.isArray(value.buzzerAnswers) &&
    Array.isArray(value.labelBuzzerAnswers)
    ? (value as RoundSnapshot)
    : null;
}

function asGameResultSnapshot(value: unknown): GameResultSnapshot | null {
  return isRecord(value) &&
    asGameSession(value.gameSession) &&
    Array.isArray(value.leaderboard) &&
    "questionSet" in value &&
    Array.isArray(value.questionScores)
    ? (value as GameResultSnapshot)
    : null;
}

function getBroadcastGameResultSnapshot(message: BroadcastMessage) {
  const directSnapshot = asGameResultSnapshot(message.gameResultSnapshot);
  if (directSnapshot) {
    return directSnapshot;
  }

  for (const delta of message.deltas ?? []) {
    if (delta.scope === "game" && delta.type === "game_result_snapshot") {
      return delta.snapshot;
    }
  }

  if (message.delta?.scope === "game" && message.delta.type === "game_result_snapshot") {
    return message.delta.snapshot;
  }

  if (isRecord(message.result)) {
    return asGameResultSnapshot(message.result.gameResultSnapshot);
  }

  return null;
}

function toClientBroadcastMessage(message: BroadcastMessage, version: number): ClientBroadcastMessage {
  const deltas = [...(message.deltas ?? (message.delta ? [message.delta] : []))];
  const roundSnapshot = asRoundSnapshot(message.roundSnapshot);
  const gameResultSnapshot = asGameResultSnapshot(message.gameResultSnapshot);
  if (roundSnapshot && !deltas.some((delta) => delta.scope === "game" && delta.type === "round_snapshot")) {
    deltas.push({ scope: "game", type: "round_snapshot", snapshot: roundSnapshot });
  }
  if (
    gameResultSnapshot &&
    !deltas.some((delta) => delta.scope === "game" && delta.type === "game_result_snapshot")
  ) {
    deltas.push({ scope: "game", type: "game_result_snapshot", snapshot: gameResultSnapshot });
  }

  return {
    type: "change",
    name: message.name,
    topic: message.topic,
    version,
    clientActionId: message.clientActionId,
    ...(deltas.length > 0 ? { deltas } : {}),
  };
}

function getAutoForfeitKey(gameSession: GameSession) {
  if (!gameSession.roundStartedAt) {
    return null;
  }

  return [
    gameSession.id,
    gameSession.currentQuestionIndex,
    gameSession.currentRevealRound,
    gameSession.roundStartedAt,
  ].join(":");
}

function getAutoForfeitRunAtMs(gameSession: GameSession) {
  if (!gameSession.roundStartedAt) {
    return null;
  }

  const roundStartedAtMs = new Date(gameSession.roundStartedAt).getTime();
  if (!Number.isFinite(roundStartedAtMs)) {
    return null;
  }

  return roundStartedAtMs + gameSession.roundSeconds * 1000 + ROUND_DEADLINE_GRACE_MS;
}

function getTeamBattleVoteAlarmKey(gameSession: GameSession) {
  const state = gameSession.teamBattleState;
  if (
    gameSession.status !== "PLAYING" ||
    gameSession.gameMode !== "TEAM_BATTLE" ||
    !state?.voteDeadlineAt ||
    (state.phase !== "REVEAL_VOTE" && state.phase !== "GUESS_VOTE")
  ) {
    return null;
  }

  return [
    gameSession.id,
    gameSession.currentQuestionIndex,
    gameSession.currentRevealRound,
    state.turnNumber,
    state.phase,
    state.voteDeadlineAt,
  ].join(":");
}

function getTeamBattleVoteRunAtMs(gameSession: GameSession) {
  const deadlineAt = gameSession.teamBattleState?.voteDeadlineAt;
  if (!deadlineAt) {
    return null;
  }

  const runAtMs = new Date(deadlineAt).getTime();
  return Number.isFinite(runAtMs) ? runAtMs : null;
}

function getTimeMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const timeMs = new Date(value).getTime();
  return Number.isFinite(timeMs) ? timeMs : null;
}

function compareRoundPosition(left: Pick<GameSession, "currentQuestionIndex" | "currentRevealRound" | "roundStartedAt">, right: Pick<GameSession, "currentQuestionIndex" | "currentRevealRound" | "roundStartedAt">) {
  if (left.currentQuestionIndex !== right.currentQuestionIndex) {
    return left.currentQuestionIndex - right.currentQuestionIndex;
  }

  if (left.currentRevealRound !== right.currentRevealRound) {
    return left.currentRevealRound - right.currentRevealRound;
  }

  const leftStartedAtMs = getTimeMs(left.roundStartedAt);
  const rightStartedAtMs = getTimeMs(right.roundStartedAt);
  if (leftStartedAtMs != null && rightStartedAtMs != null && leftStartedAtMs !== rightStartedAtMs) {
    return leftStartedAtMs - rightStartedAtMs;
  }

  return 0;
}

function isStaleRoundSnapshot(nextSnapshot: RoundSnapshot, currentSnapshot: RoundSnapshot) {
  const positionComparison = compareRoundPosition(nextSnapshot.gameSession, currentSnapshot.gameSession);
  if (positionComparison !== 0) {
    return positionComparison < 0;
  }

  const nextServerNowMs = getTimeMs(nextSnapshot.gameSession.serverNow);
  const currentServerNowMs = getTimeMs(currentSnapshot.gameSession.serverNow);
  return nextServerNowMs != null && currentServerNowMs != null && nextServerNowMs < currentServerNowMs;
}

function getAlarmRoundPosition(alarm: AutoForfeitAlarmState) {
  if (typeof alarm.questionIndex === "number" && typeof alarm.revealRound === "number" && alarm.roundStartedAt) {
    return {
      currentQuestionIndex: alarm.questionIndex,
      currentRevealRound: alarm.revealRound,
      roundStartedAt: alarm.roundStartedAt,
    };
  }

  const parts = alarm.key.split(":");
  const questionIndex = Number(parts[1]);
  const revealRound = Number(parts[2]);
  const roundStartedAt = parts.slice(3).join(":");
  if (!Number.isFinite(questionIndex) || !Number.isFinite(revealRound) || !roundStartedAt) {
    return null;
  }

  return {
    currentQuestionIndex: questionIndex,
    currentRevealRound: revealRound,
    roundStartedAt,
  };
}

function isStaleAutoForfeitTransition(next: AutoForfeitAlarmState, current: AutoForfeitAlarmState | undefined) {
  if (!current || current.gameSessionId !== next.gameSessionId) {
    return false;
  }
  const currentPosition = getAlarmRoundPosition(current);
  if (next.questionIndex == null || next.revealRound == null || !next.roundStartedAt || !currentPosition) {
    return false;
  }
  return compareRoundPosition(
    {
      currentQuestionIndex: next.questionIndex,
      currentRevealRound: next.revealRound,
      roundStartedAt: next.roundStartedAt,
    },
    currentPosition,
  ) < 0;
}

function getTeamBattleVoteAlarmPosition(alarm: TeamBattleVoteAlarmState) {
  const parts = alarm.key.split(":");
  const questionIndex = Number(parts[1]);
  const revealRound = Number(parts[2]);
  const turnNumber = Number(parts[3]);
  const deadlineAt = parts.slice(5).join(":");
  if (!Number.isFinite(questionIndex) || !Number.isFinite(revealRound) || !Number.isFinite(turnNumber) || !deadlineAt) {
    return null;
  }

  return {
    questionIndex,
    revealRound,
    turnNumber,
    deadlineAt,
  };
}

function isStaleTeamBattleVoteTransition(next: TeamBattleVoteAlarmState, current: TeamBattleVoteAlarmState | undefined) {
  if (!current || current.gameSessionId !== next.gameSessionId) {
    return false;
  }
  const nextPosition = getTeamBattleVoteAlarmPosition(next);
  const currentPosition = getTeamBattleVoteAlarmPosition(current);
  if (!nextPosition || !currentPosition) {
    return false;
  }
  if (nextPosition.questionIndex !== currentPosition.questionIndex) {
    return nextPosition.questionIndex < currentPosition.questionIndex;
  }
  if (nextPosition.revealRound !== currentPosition.revealRound) {
    return nextPosition.revealRound < currentPosition.revealRound;
  }
  if (nextPosition.turnNumber !== currentPosition.turnNumber) {
    return nextPosition.turnNumber < currentPosition.turnNumber;
  }
  const nextDeadlineMs = getTimeMs(nextPosition.deadlineAt);
  const currentDeadlineMs = getTimeMs(currentPosition.deadlineAt);
  return nextDeadlineMs != null && currentDeadlineMs != null && nextDeadlineMs < currentDeadlineMs;
}

function resolveDeadlineTransitions<T>(params: {
  mutationName: MutationName;
  data: T;
  roundSnapshot: RoundSnapshot | null;
  topic: string | null;
  currentAutoForfeit: AutoForfeitAlarmState | undefined;
  currentTeamBattleVote: TeamBattleVoteAlarmState | undefined;
}): MutationExecutionResult<T> {
  const policy = MUTATION_REGISTRY[params.mutationName].deadline;
  if (policy === "none" || !params.topic) {
    return { data: params.data, deadlineTransitions: [{ type: "noop" }] };
  }

  const transitions: DeadlineTransition[] = [];
  const gameSession = getAutoForfeitGameSession(params.data, params.roundSnapshot);
  if (gameSession) {
    const autoForfeitKey = getAutoForfeitKey(gameSession);
    const autoForfeitRunAtMs = getAutoForfeitRunAtMs(gameSession);
    if (
      autoForfeitKey &&
      autoForfeitRunAtMs != null &&
      gameSession.status === "PLAYING" &&
      gameSession.gameMode !== "TEAM_BATTLE"
    ) {
      transitions.push({
        type: "upsert",
        kind: "auto-forfeit",
        state: {
          key: autoForfeitKey,
          gameSessionId: gameSession.id,
          topic: params.topic,
          runAtMs: autoForfeitRunAtMs,
          questionIndex: gameSession.currentQuestionIndex,
          revealRound: gameSession.currentRevealRound,
          roundStartedAt: gameSession.roundStartedAt ?? undefined,
        },
      });
    } else if (params.currentAutoForfeit?.gameSessionId === gameSession.id) {
      transitions.push({
        type: "clear",
        kind: "auto-forfeit",
        gameSessionId: gameSession.id,
        topic: params.topic,
        expectedKey: params.currentAutoForfeit.key,
      });
    }

    const teamBattleKey = getTeamBattleVoteAlarmKey(gameSession);
    const teamBattleRunAtMs = getTeamBattleVoteRunAtMs(gameSession);
    if (teamBattleKey && teamBattleRunAtMs != null) {
      transitions.push({
        type: "upsert",
        kind: "team-battle-vote",
        state: {
          key: teamBattleKey,
          gameSessionId: gameSession.id,
          topic: params.topic,
          runAtMs: teamBattleRunAtMs,
        },
      });
    } else if (params.currentTeamBattleVote?.gameSessionId === gameSession.id) {
      transitions.push({
        type: "clear",
        kind: "team-battle-vote",
        gameSessionId: gameSession.id,
        topic: params.topic,
        expectedKey: params.currentTeamBattleVote.key,
      });
    }
  } else {
    const room = getResultRoom(params.data);
    const roomNoLongerHasActiveGame = Boolean(room && (room.status !== "PLAYING" || !room.currentGameId));
    const deletedRoom = (params.mutationName === "dissolveRoom" || params.mutationName === "leaveRoom") && !room;
    if (roomNoLongerHasActiveGame || deletedRoom) {
      if (params.currentAutoForfeit?.topic === params.topic) {
        transitions.push({
          type: "clear",
          kind: "auto-forfeit",
          gameSessionId: params.currentAutoForfeit.gameSessionId,
          topic: params.topic,
          expectedKey: params.currentAutoForfeit.key,
        });
      }
      if (params.currentTeamBattleVote?.topic === params.topic) {
        transitions.push({
          type: "clear",
          kind: "team-battle-vote",
          gameSessionId: params.currentTeamBattleVote.gameSessionId,
          topic: params.topic,
          expectedKey: params.currentTeamBattleVote.key,
        });
      }
    }
  }

  return {
    data: params.data,
    deadlineTransitions: transitions.length > 0 ? transitions : [{ type: "noop" }],
  };
}

function getResultQuestionSet(result: unknown) {
  if (isRecord(result)) {
    return asQuestionSet(result.questionSet) ?? asQuestionSet(result);
  }
  return null;
}

function getArgRecord(args: unknown[]) {
  return isRecord(args[0]) ? args[0] : null;
}

function buildRealtimeDeltas(
  name: string,
  args: unknown[],
  result: unknown,
  roundSnapshot: RoundSnapshot | null,
  gameResultSnapshot: GameResultSnapshot | null = null,
): RealtimeDelta[] {
  const deltas: RealtimeDelta[] = [];
  const room = getResultRoom(result);
  const gameSession = getResultGameSession(result);
  const questionSet = getResultQuestionSet(result);
  const question = asQuestion(result);
  const buzzerAnswer = asBuzzerAnswer(result);
  const answer = buzzerAnswer ? null : asAnswer(result);
  const argRecord = getArgRecord(args);

  if (name === "dissolveRoom" && typeof args[0] === "string") {
    deltas.push({ scope: "room", type: "room_dissolved", roomId: args[0] });
  }

  const roomNoticeDelta = getRoomNoticeUpdatedDelta(name, result);
  if (roomNoticeDelta) deltas.push(roomNoticeDelta);

  if (room?.id) {
    deltas.push({ scope: "room", type: "room_updated", room });
  }

  if (questionSet) {
    deltas.push({
      scope: "question-set",
      type: "question_set_updated",
      questionSet,
      ratedPlayerId: typeof argRecord?.playerId === "string" ? argRecord.playerId : undefined,
      rating: typeof argRecord?.rating === "number" ? argRecord.rating : undefined,
    });
  }

  if (question) {
    deltas.push({ scope: "game", type: "question_label_updated", question });
  }

  if (name === "cancelForfeitAnswer" && isRecord(result) && gameSession && typeof result.canceledAnswerId === "string") {
    deltas.push({
      scope: "game",
      type: "answer_canceled",
      gameSession,
      canceledAnswerId: result.canceledAnswerId,
      canceledPlayerId: typeof argRecord?.playerId === "string" ? argRecord.playerId : undefined,
    });
  } else if (answer) {
    const submittedBuzzerAnswer = isRecord(result) ? asBuzzerAnswer(result.buzzerAnswer) : null;
    deltas.push({
      scope: "game",
      type: "answer_submitted",
      answer,
      ...(submittedBuzzerAnswer ? { buzzerAnswer: submittedBuzzerAnswer } : {}),
    });
  }

  const judgedBuzzerAnswer = isRecord(result) ? asBuzzerAnswer(result.judgedAnswer) : null;
  const judgedAnswers = isRecord(result) ? asArray<BuzzerAnswer>(result.judgedAnswers) : undefined;
  if (judgedAnswers && gameSession && (name === "setAnswerJudgements" || name === "markPendingRoundAnswersWrong")) {
    deltas.push({
      scope: "game",
      type: "answer_judgements_changed",
      gameSession,
      answers: judgedAnswers,
      scores: asArray<PlayerScore>(result.scores) ?? [],
      questionResults: asArray<QuestionResult>(result.questionResults) ?? [],
    });
  } else if (judgedBuzzerAnswer && gameSession) {
    const scoreState = isRecord(result)
      ? {
          scores: asArray<PlayerScore>(result.scores),
          questionResults: asArray<QuestionResult>(result.questionResults),
          buzzerAnswers: asArray<BuzzerAnswer>(result.buzzerAnswers),
        }
      : {};
    deltas.push({
      scope: "game",
      type: "buzzer_answer_judged",
      gameSession,
      buzzerAnswer: judgedBuzzerAnswer,
      ...scoreState,
    });
  } else if (buzzerAnswer) {
    deltas.push({ scope: "game", type: "buzzer_answer_submitted", buzzerAnswer });
  }

  if (roundSnapshot) {
    deltas.push({ scope: "game", type: "round_snapshot", snapshot: roundSnapshot });
  }

  if (gameResultSnapshot) {
    deltas.push({ scope: "game", type: "game_result_snapshot", snapshot: gameResultSnapshot });
  } else if (!roundSnapshot && gameSession && name !== "cancelForfeitAnswer") {
    deltas.push({ scope: "game", type: "game_session_updated", gameSession });
  }

  return deltas;
}

async function getRoomTopicForBroadcast(name: string, args: unknown[], result: unknown) {
  const resultRoom = getResultRoom(result);
  if (resultRoom?.id) {
    return `room:${resultRoom.id}`;
  }

  const resultGameSession = getResultGameSession(result);
  if (resultGameSession?.roomId) {
    return `room:${resultGameSession.roomId}`;
  }

  const first = args[0];
  if (typeof first === "string" && (name.includes("Room") || name.includes("Presenter") || name.includes("Round"))) {
    return `room:${first}`;
  }

  if (isRecord(first)) {
    if (typeof first.roomId === "string" && first.roomId.trim()) {
      return `room:${first.roomId}`;
    }

    if (typeof first.gameSessionId === "string" && first.gameSessionId.trim()) {
      const roomId = await gameService.getRoomIdForGameSession(first.gameSessionId);
      return roomId ? `room:${roomId}` : null;
    }
  }

  return null;
}

async function broadcast(env: Env, message: BroadcastMessage) {
  await getRoomObject(env, message.topic).fetch("https://room-object/broadcast", {
    method: "POST",
    body: JSON.stringify(message),
  });
}

async function scheduleAutoForfeit(env: Env, message: AutoForfeitScheduleMessage) {
  const response = await getRoomObject(env, message.topic).fetch("https://room-object/schedule-auto-forfeit", {
    method: "POST",
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    throw new DeadlineTransitionApplyError();
  }
}

function logAuxiliaryFailure(event: string, error: unknown, extra: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({
      event,
      message: error instanceof Error ? error.message : String(error),
      ...extra,
    }),
  );
}

async function getJoinRoomRoute(env: Env, args: unknown[]) {
  const roomCode = typeof args[0] === "string" ? args[0] : "";
  if (!roomCode.trim()) {
    return null;
  }

  return await runWithGameDatabase(env, async () => {
    const room = await gameService.getRoomByCode(roomCode);
    if (!room?.id) return null;
    if (Number(room.runtime_generation) !== CURRENT_ROOM_RUNTIME_GENERATION) throw new RoomVersionExpiredError();
    return { topic: `room:${room.id}`, runtimeChecked: true as const };
  });
}

function getRoomIdArgTopic(args: unknown[]) {
  const roomId = typeof args[0] === "string" ? args[0].trim() : "";
  return roomId ? `room:${roomId}` : null;
}

function logRpcInvocation(params: { transport: "http" | "websocket"; name: string; isMutation: boolean; localTopic?: string | null }) {
  console.info(
    JSON.stringify({
      event: "game_rpc",
      transport: params.transport,
      name: params.name,
      isMutation: params.isMutation,
      hasLocalTopic: Boolean(params.localTopic),
    }),
  );
}

async function handleRpc(
  request: Request,
  env: Env,
  options: {
    localTopic?: string | null;
    localBroadcast?: (message: BroadcastMessage) => Promise<void>;
    localCacheGameResult?: (snapshot: GameResultSnapshot) => Promise<void>;
    localInvalidateRoundSnapshots?: (gameSessionId: string) => void;
    localScheduleAutoForfeit?: (message: AutoForfeitScheduleMessage) => Promise<void>;
    gameDatabase?: GameDatabase;
    mutationTracker?: GameDatabaseMutationTracker;
    localAuthorityCommit?: (name: string, result: unknown, clientActionId?: string) => AuthorityVersion | null | Promise<AuthorityVersion | null>;
    receivedAtMs?: number;
    body?: RpcBody;
  } = {},
) {
  const body = options.body ?? await readRpcBody(request);
  const name = body.name ?? "";
  const args = body.args ?? [];
  const mutationDeadlinePolicy = getMutationDeadlinePolicy(name);
  const isMutation = mutationDeadlinePolicy != null;
  logRpcInvocation({ transport: "http", name, isMutation, localTopic: options.localTopic });

  const execute = async () => {
    const result = await callGameFunctionWithEnv(name, args, request, env, options.receivedAtMs);
    const roundSnapshot = await getRoundSnapshotForMutation(name, result);
    const gameResultSnapshot = await getGameResultSnapshotForMutation(name, result);
    const responseResult = attachRoundSnapshot(result, roundSnapshot);
    const authorityVersion = isMutation ? await options.localAuthorityCommit?.(name, responseResult, body.clientActionId) ?? null : null;
    const scheduleRoundSnapshot = asRoundSnapshot(responseResult) ?? roundSnapshot;
    const topic = options.localTopic ?? await getRoomTopicForBroadcast(name, args, responseResult);
    const invalidatedGameSessionId = getDeltaOnlyRoundCacheInvalidationGameSessionId(name, responseResult, args);

    if (invalidatedGameSessionId && options.localTopic && options.localInvalidateRoundSnapshots) {
      options.localInvalidateRoundSnapshots(invalidatedGameSessionId);
    }

    let postCommitError: unknown = null;
    if (topic && mutationDeadlinePolicy === "authoritative-post-state") {
      const scheduleMessage = {
        topic,
        result: responseResult,
        roundSnapshot: scheduleRoundSnapshot,
        mutationName: name as MutationName,
        source: options.localTopic === topic ? "local_rpc" : "http_rpc",
      } satisfies AutoForfeitScheduleMessage;
      try {
        if (options.localTopic === topic && options.localScheduleAutoForfeit) {
          await options.localScheduleAutoForfeit(scheduleMessage);
        } else {
          await scheduleAutoForfeit(env, scheduleMessage);
        }
      } catch (error) {
        postCommitError = error;
        if (options.localTopic === topic && options.localInvalidateRoundSnapshots && scheduleRoundSnapshot) {
          options.localInvalidateRoundSnapshots(scheduleRoundSnapshot.gameSession.id);
        }
      }
    }

    if (isMutation) {
      const deltas = buildRealtimeDeltas(name, args, responseResult, roundSnapshot, gameResultSnapshot);
      if (topic && deltas.length > 0) {
        const message = {
          type: "change",
          name,
          result: stripRoundSnapshotFromBroadcastResult(responseResult),
          args,
          topic,
          clientActionId: body.clientActionId,
          delta: deltas[0],
          deltas,
          version: authorityVersion?.stateVersion,
        } satisfies BroadcastMessage;

        if (options.localTopic === topic && options.localCacheGameResult && gameResultSnapshot) {
          try {
            await options.localCacheGameResult(gameResultSnapshot);
          } catch (error) {
            postCommitError ??= error;
          }
        }

        try {
          if (options.localTopic === topic && options.localBroadcast) {
            await options.localBroadcast(message);
          } else {
            await broadcast(env, message);
          }
        } catch (error) {
          postCommitError ??= error;
        }
      }
    }

    if (postCommitError) {
      throw postCommitError instanceof DeadlineTransitionApplyError ? postCommitError : new DeadlineTransitionApplyError();
    }

    return json({ data: responseResult }, {}, request, env);
  };
  return options.gameDatabase
    ? await gameService.runWithGameDatabase(options.gameDatabase, execute, options.mutationTracker)
    : await runWithGameDatabase(env, execute);
}

async function getGameSessionTopic(env: Env, args: unknown[]) {
  const gameSessionId = typeof args[0] === "string" ? args[0].trim() : "";
  if (!gameSessionId) return null;
  const roomId = await runWithGameDatabase(env, () => gameService.getRoomIdForGameSession(gameSessionId));
  return roomId ? `room:${roomId}` : null;
}

const ROOM_CODE_RPC_NAMES = new Set(["getRoomByCode", "getRoomWithPlayers", "joinRoom"]);

async function resolveRoomTopicForRpc(env: Env, name: string, args: unknown[]) {
  if (name === "createRoom") return null;
  if (ROOM_CODE_RPC_NAMES.has(name)) return await getJoinRoomRoute(env, args);
  if (name === "getPlayersByRoomId" || name === "updatePlayerRole") {
    const topic = getRoomIdArgTopic(args);
    return topic ? { topic, runtimeChecked: false as const } : null;
  }
  if (GAME_SESSION_ID_STRING_ARG_NAMES.has(name)) {
    const topic = await getGameSessionTopic(env, args);
    return topic ? { topic, runtimeChecked: false as const } : null;
  }
  const topic = await runWithGameDatabase(env, () => getRoomTopicForBroadcast(name, args, null));
  return topic ? { topic, runtimeChecked: false as const } : null;
}

function getR2ImagePrefix(env: Env) {
  return (env.R2_IMAGE_PREFIX ?? "question-images")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\./g, "");
}

function sanitizeFileName(name: string) {
  const fallback = "image";
  const withoutPath = name.split(/[\\/]/).filter(Boolean).pop() ?? fallback;
  const dotIndex = withoutPath.lastIndexOf(".");
  const rawBase = dotIndex > 0 ? withoutPath.slice(0, dotIndex) : withoutPath;
  const rawExt = dotIndex > 0 ? withoutPath.slice(dotIndex).toLowerCase() : "";
  const base = rawBase
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : "";
  return `${base || fallback}${ext}`;
}

function encodeR2Key(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function getR2PublicUrl(request: Request, env: Env, key: string) {
  const configuredBase = env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/g, "");
  if (configuredBase) {
    return `${configuredBase}/${encodeR2Key(key)}`;
  }

  const origin = new URL(request.url).origin;
  return `${origin}${R2_IMAGE_ROUTE_PREFIX}${encodeR2Key(key)}`;
}

function buildR2ImageKey(request: Request, env: Env, fileNameOverride?: string, category?: string) {
  const url = new URL(request.url);
  const fileName = sanitizeFileName(fileNameOverride ?? url.searchParams.get("filename") ?? "image");
  const now = new Date();
  const datePath = now.toISOString().slice(0, 10).replace(/-/g, "/");
  const prefix = getR2ImagePrefix(env);
  const normalizedCategory = category?.replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "";
  const id = crypto.randomUUID();
  return [prefix, normalizedCategory, datePath, `${id}-${fileName}`].filter(Boolean).join("/");
}

function getRequestContentLength(request: Request) {
  const value = request.headers.get("content-length");
  if (!value) {
    return null;
  }

  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

async function putR2Image(
  request: Request,
  env: Env,
  body: ArrayBuffer,
  contentType: string,
  fileName: string,
  customMetadata: Record<string, string> = {},
  category?: string,
) {
  if (isR2ImageUploadTooLarge(body.byteLength)) {
    return {
      ok: false as const,
      error: R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE,
      response: json({ error: R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE }, { status: 413 }, request, env),
    };
  }

  const key = buildR2ImageKey(request, env, fileName, category);
  const checksum = await crypto.subtle.digest("SHA-256", body);
  const object = await env.IMAGE_BUCKET.put(key, body, {
    httpMetadata: {
      contentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      uploadedAt: new Date().toISOString(),
      ...customMetadata,
    },
    sha256: checksum,
  });

  if (!object) {
    throw new Error("图片写入 R2 失败，请稍后重试。");
  }

  return {
    ok: true as const,
    key,
    url: getR2PublicUrl(request, env, key),
    publicId: key,
    size: object.size,
    etag: object.httpEtag,
  };
}

type RemoteFetchResult = {
  body: ArrayBuffer;
  contentType: string;
};

class RemoteImageTargetBlockedError extends Error {}

function isHttpImageUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}


function getRemoteProxyCandidates(env: Env) {
  const configured = (env.REMOTE_IMAGE_PROXY_CANDIDATES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set([...configured, ...DEFAULT_REMOTE_IMAGE_PROXY_CANDIDATES]));
}

function isBlockedRemoteHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0") {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }

  return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function getSourceFetchHeaders(url: URL) {
  const headers = new Headers({
    "User-Agent": "Mozilla/5.0 (compatible; AnimeMasterGame/1.0)",
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
  });

  if (url.hostname === "cdni.fancaps.net" || url.hostname === "fancaps.net") {
    headers.set("Referer", "https://fancaps.net/");
  } else if (url.hostname === "lain.bgm.tv") {
    headers.set("Referer", "https://bgm.tv/");
  }

  return headers;
}

async function fetchRemoteImage(rawUrl: string, env: Env): Promise<RemoteFetchResult> {
  const targetUrl = new URL(rawUrl);
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new Error("只支持 http/https 图片链接。");
  }
  if (isBlockedRemoteHost(targetUrl.hostname)) {
    throw new RemoteImageTargetBlockedError("不允许导入本地或私有网络图片。");
  }

  const attempts = [
    { url: targetUrl.toString(), headers: getSourceFetchHeaders(targetUrl) },
    ...getRemoteProxyCandidates(env).map((prefix) => ({
      url: `${prefix}${encodeURIComponent(targetUrl.toString())}`,
      headers: new Headers({ Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" }),
    })),
  ];
  let lastError = "远端图片请求失败。";

  for (const attempt of attempts) {
    try {
      let currentUrl = attempt.url;
      let response: Response | null = null;
      for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
        const parsedAttemptUrl = new URL(currentUrl);
        if (!["http:", "https:"].includes(parsedAttemptUrl.protocol) || isBlockedRemoteHost(parsedAttemptUrl.hostname)) {
          throw new RemoteImageTargetBlockedError("远端图片重定向到了不允许的地址。");
        }
        response = await fetch(currentUrl, { method: "GET", headers: attempt.headers, redirect: "manual" });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location || redirectCount === 3) throw new Error("远端图片重定向次数过多。");
        currentUrl = new URL(location, currentUrl).toString();
      }
      if (!response) throw new Error("远端图片请求失败。");
      if (!response.ok) {
        lastError = `远端返回 HTTP ${response.status}`;
        continue;
      }

      const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!contentType.startsWith("image/") || contentType === "image/svg+xml") {
        lastError = "远端返回的不是受支持的位图图片。";
        continue;
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > REMOTE_IMAGE_FETCH_MAX_BYTES) {
        throw new Error("远端原图不能超过 20 MB。");
      }

      const body = await readBodyWithLimit(response.body, REMOTE_IMAGE_FETCH_MAX_BYTES, "远端原图不能超过 20 MB。");
      if (body.byteLength === 0) {
        lastError = "远端图片内容为空。";
        continue;
      }

      return { body, contentType };
    } catch (error) {
      if (error instanceof RemoteImageTargetBlockedError || error instanceof ImageBodyTooLargeError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastError);
}

class ImageBodyTooLargeError extends Error {}

async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null, maxBytes: number, tooLargeMessage: string) {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ImageBodyTooLargeError(tooLargeMessage);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined.buffer;
}

async function handleRemoteImageSource(request: Request, env: Env) {
  const payload = JSON.parse(await readLimitedRequestText(request, 4096)) as Record<string, unknown>;
  const roomId = typeof payload.roomId === "string" ? payload.roomId.trim() : "";
  const presenterPlayerId = typeof payload.presenterPlayerId === "string" ? payload.presenterPlayerId.trim() : "";
  const imageUrl = typeof payload.imageUrl === "string" ? payload.imageUrl.trim() : "";
  if (!roomId || !presenterPlayerId || !isHttpImageUrl(imageUrl)) {
    throw new Error("远端图片请求参数无效。");
  }
  await runWithGameDatabase(env, () => gameService.assertCanCreateUploadedQuestionSet({ roomId, presenterPlayerId }));
  const remote = await fetchRemoteImage(imageUrl, env);
  const headers = new Headers({
    "content-type": remote.contentType,
    "content-length": String(remote.body.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const [name, value] of Object.entries(corsHeaders(request, env))) headers.set(name, value);
  return new Response(remote.body, { status: 200, headers });
}

async function hasValidCommunityUploadKey(request: Request, env: Env) {
  const configuredSecret = (env.COMMUNITY_UPLOAD_SECRET ?? "").trim();
  if (configuredSecret.length < COMMUNITY_UPLOAD_SECRET_MIN_LENGTH) return false;

  const suppliedHeader = (request.headers.get(COMMUNITY_UPLOAD_KEY_HEADER) ?? "").trim();
  const suppliedSecret = suppliedHeader.length <= 512 ? suppliedHeader : "__invalid_oversized_key__";
  const encoder = new TextEncoder();
  const [configuredDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(configuredSecret)),
    crypto.subtle.digest("SHA-256", encoder.encode(suppliedSecret)),
  ]);
  const configuredBytes = new Uint8Array(configuredDigest);
  const suppliedBytes = new Uint8Array(suppliedDigest);
  let difference = 0;
  for (let index = 0; index < configuredBytes.length; index += 1) {
    difference |= configuredBytes[index] ^ suppliedBytes[index];
  }
  return difference === 0;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorizeCommunityUpload(request: Request, env: Env) {
  if ((env.COMMUNITY_UPLOAD_SECRET ?? "").trim().length < COMMUNITY_UPLOAD_SECRET_MIN_LENGTH) {
    return json({ error: "截图上传功能尚未配置。" }, { status: 503 }, request, env);
  }
  if (!await hasValidCommunityUploadKey(request, env)) {
    return json({ error: "上传密钥无效。" }, { status: 401 }, request, env);
  }
  return null;
}

async function handleCommunityScreenshotUpload(request: Request, env: Env) {
  const authError = await authorizeCommunityUpload(request, env);
  if (authError) return authError;
  if (!env.IMAGE_BUCKET) {
    return json({ error: "服务器图片存储尚未配置。" }, { status: 500 }, request, env);
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) {
    return json({ error: "只能上传图片文件。" }, { status: 415 }, request, env);
  }

  const contentLength = getRequestContentLength(request);
  if (contentLength != null && contentLength > R2_IMAGE_UPLOAD_MAX_BYTES) {
    return json({ error: R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE }, { status: 413 }, request, env);
  }

  let body: ArrayBuffer;
  try {
    body = await readBodyWithLimit(request.body, R2_IMAGE_UPLOAD_MAX_BYTES, R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE);
  } catch (error) {
    if (error instanceof ImageBodyTooLargeError) {
      return json({ error: error.message }, { status: 413 }, request, env);
    }
    throw error;
  }
  if (body.byteLength === 0) return json({ error: "上传内容为空。" }, { status: 400 }, request, env);

  let image;
  try {
    image = validateRasterImage(body);
  } catch (error) {
    const message = error instanceof InvalidImageError ? error.message : "图片内容校验失败。";
    return json({ error: message }, { status: 415 }, request, env);
  }
  if (!isCommunityScreenshotWithin1080p(image.width, image.height)) {
    return json(
      { error: "图片尺寸超过 1080p，请刷新页面后让浏览器重新压缩。", width: image.width, height: image.height },
      { status: 422 },
      request,
      env,
    );
  }

  const uploaded = await putR2Image(
    request,
    env,
    body,
    image.contentType,
    `screenshot${image.extension}`,
    {
      uploadSource: "homepage-community",
      validatedWidth: String(image.width),
      validatedHeight: String(image.height),
    },
    "community",
  );
  if (!uploaded.ok) return uploaded.response;

  return json({
    key: uploaded.key,
    url: uploaded.url,
    width: image.width,
    height: image.height,
    size: uploaded.size,
  }, {}, request, env);
}

async function handleBangumiAnimeSearch(request: Request, env: Env, cache: Cache) {
  const authError = await authorizeCommunityUpload(request, env);
  if (authError) return authError;
  const query = new URL(request.url).searchParams.get("query") ?? "";
  try {
    const results = await searchBangumiAnime(cache, query);
    return json({ results }, { headers: { "cache-control": "no-store" } }, request, env);
  } catch (error) {
    if (error instanceof BangumiApiError) {
      return json({ error: error.message }, { status: error.status }, request, env);
    }
    throw error;
  }
}

async function handleBangumiSubjectCharacters(request: Request, env: Env, cache: Cache, subjectId: number) {
  const authError = await authorizeCommunityUpload(request, env);
  if (authError) return authError;
  try {
    const characters = await getBangumiSubjectCharacters(cache, subjectId);
    return json({ characters }, { headers: { "cache-control": "no-store" } }, request, env);
  } catch (error) {
    if (error instanceof BangumiApiError) {
      return json({ error: error.message }, { status: error.status }, request, env);
    }
    throw error;
  }
}

type CommunityImageIndexRow = {
  question_id: string;
  question_set_id: string;
  image_url: string;
  order_index: number;
  anime_subject_id: number | null;
  anime_tags_json: string;
  character_tags_json: string;
  created_at: string;
};

async function handleCommunityImageIndexSearch(request: Request, env: Env) {
  const authError = await authorizeCommunityUpload(request, env);
  if (authError) return authError;
  if (!env.DB) return json({ error: "服务器题库索引尚未配置。" }, { status: 500 }, request, env);

  const url = new URL(request.url);
  const animeSubjectId = Number(url.searchParams.get("animeSubjectId"));
  const characterIdValue = url.searchParams.get("characterId");
  const characterId = characterIdValue == null || characterIdValue === "" ? null : Number(characterIdValue);
  if (!Number.isInteger(animeSubjectId) || animeSubjectId < 1 || animeSubjectId > 2_147_483_647) {
    return json({ error: "必须提供有效的番剧 ID。" }, { status: 400 }, request, env);
  }
  if (characterId != null && (!Number.isInteger(characterId) || characterId < 1 || characterId > 2_147_483_647)) {
    return json({ error: "角色 ID 无效。" }, { status: 400 }, request, env);
  }
  const requestedLimit = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20;
  const characterClause = characterId == null ? "" : `
    AND EXISTS (
      SELECT 1
      FROM json_each(image_index.character_tags_json) AS character_tag
      WHERE CAST(json_extract(character_tag.value, '$.id') AS INTEGER) = ?
    )`;
  const bindings: unknown[] = [animeSubjectId];
  if (characterId != null) bindings.push(characterId);
  bindings.push(limit);
  try {
    const result = await env.DB.prepare(`
    SELECT
      image_index.question_id,
      image_index.question_set_id,
      image_index.image_url,
      image_index.order_index,
      image_index.anime_subject_id,
      image_index.anime_tags_json,
      image_index.character_tags_json,
      image_index.created_at
    FROM question_image_index AS image_index
    INNER JOIN question_sets AS question_set ON question_set.id = image_index.question_set_id
    WHERE question_set.is_public = 1
      AND image_index.anime_subject_id = ?${characterClause}
    ORDER BY image_index.created_at DESC, image_index.question_id DESC
    LIMIT ?
  `).bind(...bindings).all<CommunityImageIndexRow>();

  const images = (result.results ?? []).map((row) => {
    let animeTags: BangumiAnimeTag[] = [];
    let characterTags: BangumiCharacterTag[] = [];
    try {
      const normalized = normalizeBangumiQuestionTags(
        JSON.parse(row.anime_tags_json),
        JSON.parse(row.character_tags_json),
      );
      if (normalized.animeTags[0]?.id === row.anime_subject_id) {
        animeTags = normalized.animeTags;
        characterTags = normalized.characterTags;
      }
    } catch {
      // Keep a corrupt row non-fatal without forwarding malformed metadata.
    }
    return {
      questionId: row.question_id,
      questionSetId: row.question_set_id,
      imageUrl: row.image_url,
      orderIndex: row.order_index,
      animeSubjectId: row.anime_subject_id,
      animeTags,
      characterTags,
      createdAt: row.created_at,
    };
  });
    return json({ images }, { headers: { "cache-control": "no-store" } }, request, env);
  } catch (error) {
    console.error("Community image index query failed", error);
    return json({ error: "图片标签索引查询失败，请稍后重试。" }, { status: 500 }, request, env);
  }
}

type SubmittedCommunityQuestion = {
  r2Key: string;
  labelText: string;
  animeTags: BangumiAnimeTag[];
  characterTags: BangumiCharacterTag[];
};

async function canonicalizeSubmittedBangumiTags(
  cache: Cache,
  questions: SubmittedCommunityQuestion[],
): Promise<SubmittedCommunityQuestion[]> {
  const subjectIds = [...new Set(questions.flatMap((question) => question.animeTags.map((tag) => tag.id)))];
  if (subjectIds.length === 0) return questions;

  const subjects = new Map(await mapWithConcurrency(subjectIds, 4, async (subjectId) => {
    const subject = await getBangumiAnimeSubject(cache, subjectId);
    return [subjectId, subject] as const;
  }));
  const castSubjectIds = [...new Set(questions
    .filter((question) => question.characterTags.length > 0)
    .flatMap((question) => question.animeTags.map((tag) => tag.id)))];
  const casts = new Map(await mapWithConcurrency(castSubjectIds, 4, async (subjectId) => {
    const characters = await getBangumiSubjectCharacters(cache, subjectId);
    return [subjectId, new Map(characters.map((character) => [character.id, character]))] as const;
  }));

  return questions.map((question) => {
    const submittedAnime = question.animeTags[0];
    if (!submittedAnime) return question;
    const anime = subjects.get(submittedAnime.id);
    if (!anime) throw new BangumiApiError("所选 Bangumi 番剧不存在。", 400);
    const cast = casts.get(anime.id);
    const characterTags = question.characterTags.map((submittedCharacter) => {
      const character = cast?.get(submittedCharacter.id);
      if (!character) {
        throw new BangumiApiError(`角色“${submittedCharacter.name}”不属于所选 Bangumi 番剧。`, 400);
      }
      return {
        id: character.id,
        subjectId: anime.id,
        name: character.name,
        nameCn: null,
        relation: character.relation,
      } satisfies BangumiCharacterTag;
    });
    return {
      ...question,
      animeTags: [{ id: anime.id, name: anime.name, nameCn: anime.nameCn }],
      characterTags,
    };
  });
}

async function handleCommunityQuestionSetCreate(request: Request, env: Env, cache: Cache) {
  const authError = await authorizeCommunityUpload(request, env);
  if (authError) return authError;
  if (!env.IMAGE_BUCKET || !env.DB) {
    return json({ error: "服务器题库存储尚未配置。" }, { status: 500 }, request, env);
  }

  let payload: unknown;
  try {
    const text = await readLimitedRequestText(request, COMMUNITY_QUESTION_SET_BODY_MAX_BYTES);
    payload = JSON.parse(text);
  } catch (error) {
    if (error instanceof Error && error.message === "请求内容过大，请缩小后重试。") {
      return json({ error: "题库请求内容过大（上限 512 KiB）。" }, { status: 413 }, request, env);
    }
    return json({ error: "题库请求内容无效。" }, { status: 400 }, request, env);
  }
  if (!isRecord(payload) || !Array.isArray(payload.questions)) {
    return json({ error: "题库请求参数无效。" }, { status: 400 }, request, env);
  }
  if (payload.questions.length === 0 || payload.questions.length > COMMUNITY_SCREENSHOT_MAX_QUESTIONS) {
    return json({ error: `每个题库必须包含 1 到 ${COMMUNITY_SCREENSHOT_MAX_QUESTIONS} 张截图。` }, { status: 400 }, request, env);
  }
  const submissionId = typeof payload.submissionId === "string" ? payload.submissionId.trim() : "";
  if (!/^[a-zA-Z0-9_-]{16,160}$/.test(submissionId)) {
    return json({ error: "投稿标识无效，请刷新页面后重试。" }, { status: 400 }, request, env);
  }

  const prefix = getR2ImagePrefix(env);
  const requiredKeyPrefix = [prefix, "community"].filter(Boolean).join("/") + "/";
  const seenKeys = new Set<string>();
  const submittedQuestions: SubmittedCommunityQuestion[] = [];
  for (const item of payload.questions) {
    if (!isRecord(item) || typeof item.r2Key !== "string") {
      return json({ error: "题库图片参数无效。" }, { status: 400 }, request, env);
    }
    const r2Key = item.r2Key.trim();
    if (!r2Key.startsWith(requiredKeyPrefix) || r2Key.includes("..") || seenKeys.has(r2Key)) {
      return json({ error: "题库包含无效或重复的服务器图片。" }, { status: 400 }, request, env);
    }
    if (typeof item.labelText !== "string" || !item.labelText.trim()) {
      return json({ error: "每张截图都必须填写正确答案。" }, { status: 400 }, request, env);
    }
    let tags;
    try {
      tags = normalizeBangumiQuestionTags(item.animeTags, item.characterTags);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bangumi 标签格式无效。";
      return json({ error: message }, { status: 400 }, request, env);
    }
    seenKeys.add(r2Key);
    submittedQuestions.push({
      r2Key,
      labelText: item.labelText.trim(),
      animeTags: tags.animeTags,
      characterTags: tags.characterTags,
    });
  }

  const title = typeof payload.title === "string" ? payload.title : "";
  const description = typeof payload.description === "string" ? payload.description : undefined;
  const playerId = typeof payload.playerId === "string" ? payload.playerId : "";
  const nickname = typeof payload.nickname === "string" ? payload.nickname : "";
  const submissionFingerprint = await sha256Hex(JSON.stringify({
    version: 1,
    title: title.replace(/[\r\n]+/g, " ").trim(),
    description: description?.trim() || null,
    playerId: playerId.trim(),
    nickname: nickname.replace(/[\r\n]+/g, " ").trim(),
    questions: submittedQuestions.map((question) => ({
      r2Key: question.r2Key,
      labelText: question.labelText,
      animeSubjectId: question.animeTags[0]?.id ?? null,
      characterIds: question.characterTags.map((tag) => tag.id),
    })),
  }));

  try {
    const existing = await runWithGameDatabase(env, () => gameService.getHomepageCommunityQuestionSetBySubmissionId(submissionId));
    if (existing) {
      if (existing.submissionFingerprint !== submissionFingerprint) {
        return json({ error: "投稿内容已发生变化，请作为一次新投稿重试。" }, { status: 409 }, request, env);
      }
      const questionSet = existing.questionSet;
      return json({ id: questionSet.id, title: questionSet.title, imageCount: questionSet.imageCount }, {}, request, env);
    }
  } catch (error) {
    if (error instanceof gameService.HomepageCommunityQuestionSetPersistenceError) {
      console.error("Homepage community idempotency lookup failed", error.cause);
      return json({ error: error.message }, { status: 500 }, request, env);
    }
    throw error;
  }

  const storedObjects = await Promise.all(submittedQuestions.map((question) => env.IMAGE_BUCKET.head(question.r2Key)));
  if (storedObjects.some((object) => !object || object.customMetadata?.uploadSource !== "homepage-community")) {
    return json({ error: "部分服务器图片不存在或未通过校验，请重新上传。" }, { status: 400 }, request, env);
  }

  let canonicalQuestions: SubmittedCommunityQuestion[];
  try {
    canonicalQuestions = await canonicalizeSubmittedBangumiTags(cache, submittedQuestions);
  } catch (error) {
    if (error instanceof BangumiApiError) {
      return json({ error: error.message }, { status: error.status }, request, env);
    }
    throw error;
  }

  let questionSet;
  try {
    questionSet = await runWithGameDatabase(env, () => gameService.createHomepageCommunityQuestionSet({
      submissionId,
      submissionFingerprint,
      playerId,
      nickname,
      title,
      description,
      questions: canonicalQuestions.map((question) => ({
        imageUrl: getR2PublicUrl(request, env, question.r2Key),
        labelText: question.labelText,
        animeTags: question.animeTags,
        characterTags: question.characterTags,
      })),
    }));
  } catch (error) {
    if (error instanceof gameService.HomepageCommunityQuestionSetConflictError) {
      return json({ error: error.message }, { status: 409 }, request, env);
    }
    if (error instanceof gameService.HomepageCommunityQuestionSetPersistenceError) {
      console.error("Homepage community question set persistence failed", error.cause);
      return json({ error: error.message }, { status: 500 }, request, env);
    }
    throw error;
  }

  return json({ id: questionSet.id, title: questionSet.title, imageCount: questionSet.imageCount }, {}, request, env);
}

async function handleR2Upload(request: Request, env: Env) {
  if (!env.IMAGE_BUCKET) {
    return json({ error: "缺少 R2 存储绑定：请在 wrangler.toml 配置 IMAGE_BUCKET。" }, { status: 500 }, request, env);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return json({ error: "只能上传图片文件。" }, { status: 415 }, request, env);
  }

  const contentLength = getRequestContentLength(request);
  if (contentLength != null && contentLength > R2_IMAGE_UPLOAD_MAX_BYTES) {
    return json({ error: R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE }, { status: 413 }, request, env);
  }

  let body: ArrayBuffer;
  try {
    body = await readBodyWithLimit(request.body, R2_IMAGE_UPLOAD_MAX_BYTES, R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE);
  } catch (error) {
    if (error instanceof ImageBodyTooLargeError) {
      return json({ error: error.message }, { status: 413 }, request, env);
    }
    throw error;
  }
  if (body.byteLength === 0) {
    return json({ error: "上传内容为空。" }, { status: 400 }, request, env);
  }

  const uploaded = await putR2Image(request, env, body, contentType, new URL(request.url).searchParams.get("filename") ?? "image");
  if (!uploaded.ok) {
    return uploaded.response;
  }

  return json(
    {
      key: uploaded.key,
      url: uploaded.url,
      publicId: uploaded.publicId,
      size: uploaded.size,
      etag: uploaded.etag,
    },
    {},
    request,
    env,
  );
}

function getR2ObjectKeyFromPath(pathname: string) {
  if (!pathname.startsWith(R2_IMAGE_ROUTE_PREFIX)) {
    return null;
  }

  const encodedKey = pathname.slice(R2_IMAGE_ROUTE_PREFIX.length);
  if (!encodedKey) {
    return null;
  }

  const key = encodedKey
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");

  if (!key || key.includes("..") || key.startsWith("/")) {
    return null;
  }

  return key;
}

async function handleR2Image(request: Request, env: Env, key: string) {
  if (!env.IMAGE_BUCKET) {
    return json({ error: "缺少 R2 存储绑定。" }, { status: 500 }, request, env);
  }

  const object = request.method === "HEAD" ? await env.IMAGE_BUCKET.head(key) : await env.IMAGE_BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404, headers: corsHeaders(request, env) });
  }

  const headers = new Headers(corsHeaders(request, env));
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }

  if (request.method === "HEAD") {
    headers.set("content-length", String(object.size));
    return new Response(null, { headers });
  }

  return new Response(object.body, { headers });
}

async function handleR2ImagesList(request: Request, env: Env) {
  if (!env.IMAGE_BUCKET) {
    return json({ error: "缺少 R2 存储绑定。" }, { status: 500 }, request, env);
  }

  const prefix = getR2ImagePrefix(env);
  const limit = Math.max(1, Math.min(100, Number(env.R2_EXISTING_IMAGE_LIMIT ?? 50)));
  const listed = await env.IMAGE_BUCKET.list({
    prefix: prefix ? `${prefix}/` : undefined,
    limit,
    include: ["httpMetadata", "customMetadata"],
  });

  const images = listed.objects
    .filter((object) => object.customMetadata?.uploadSource !== "homepage-community")
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    .map((object) => ({
      publicId: object.key,
      url: getR2PublicUrl(request, env, object.key),
      originalUrl: getR2PublicUrl(request, env, object.key),
      width: null,
      height: null,
      createdAt: object.uploaded.toISOString(),
      size: object.size,
    }));

  return json(
    {
      images,
      folder: prefix,
      limit,
      truncated: listed.truncated,
      cursor: listed.cursor ?? null,
    },
    {},
    request,
    env,
  );
}

type ExpiredRoomRow = {
  id: string;
  room_code: string;
  game_status: string;
  updated_at: string;
};

type CleanupQuestionSetImageRow = {
  room_id?: string | null;
  question_set_id: string;
  image_url?: string | null;
  manifest_version?: number | null;
  manifest_json?: string | null;
};

type R2ImageReferenceRow = {
  question_set_id: string;
  is_public: number | boolean;
  image_url?: string | null;
  manifest_version?: number | null;
  manifest_json?: string | null;
};

type IdRow = {
  id: string;
};

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function deleteR2KeysInBatches(
  bucket: R2Bucket,
  keys: string[],
  onBatchFailure?: (error: unknown, failedKeys: string[]) => void,
) {
  const failedR2Keys = new Set<string>();
  let deletedR2KeyCount = 0;
  let successfulBatchCount = 0;

  for (const keyBatch of chunkArray(keys, R2_DELETE_MAX_KEYS_PER_CALL)) {
    try {
      await bucket.delete(keyBatch);
      deletedR2KeyCount += keyBatch.length;
      successfulBatchCount += 1;
    } catch (error) {
      if (!onBatchFailure) throw error;
      for (const key of keyBatch) failedR2Keys.add(key);
      onBatchFailure(error, keyBatch);
    }
  }

  return { deletedR2KeyCount, failedR2Keys, successfulBatchCount };
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function isDbTruthy(value: number | boolean) {
  return value === true || value === 1;
}

async function queryRows<T>(env: Env, sql: string, ...params: unknown[]) {
  const result = await env.DB.prepare(sql).bind(...params).all<T>();
  return result.results ?? [];
}

function sanitizeCleanupR2Key(key: string, env: Env) {
  const prefix = getR2ImagePrefix(env);
  if (!prefix) {
    return null;
  }

  const normalizedKey = key.trim();
  if (!normalizedKey || normalizedKey.includes("..") || normalizedKey.startsWith("/")) {
    return null;
  }

  return normalizedKey.startsWith(`${prefix}/`) ? normalizedKey : null;
}

function getR2ObjectKeyFromImageUrl(imageUrl: string, env: Env, options: { allowAnyOriginPrefixPath?: boolean } = {}) {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return null;
  }

  const routeKey = getR2ObjectKeyFromPath(url.pathname);
  if (routeKey) {
    return sanitizeCleanupR2Key(routeKey, env);
  }

  if (options.allowAnyOriginPrefixPath) {
    const prefix = getR2ImagePrefix(env);
    const prefixPath = `/${prefix}/`;
    if (prefix && url.pathname.startsWith(prefixPath)) {
      const encodedKey = url.pathname.slice(1);
      const key = encodedKey
        .split("/")
        .map((part) => decodeURIComponent(part))
        .join("/");
      return sanitizeCleanupR2Key(key, env);
    }
  }

  const configuredBase = env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/g, "");
  if (!configuredBase) {
    return null;
  }

  try {
    const base = new URL(`${configuredBase}/`);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      return null;
    }

    const encodedKey = url.pathname.slice(base.pathname.length);
    const key = encodedKey
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
    return sanitizeCleanupR2Key(key, env);
  } catch {
    return null;
  }
}

function getR2ReferenceNeedle(env: Env) {
  const prefix = getR2ImagePrefix(env);
  if (!prefix) {
    return null;
  }

  // D1 limits LIKE/GLOB patterns to 50 bytes; use a literal path needle so the public base URL cannot exceed it.
  return `/${prefix}/`;
}

type PublicRoomRow = {
  id: string;
  room_code: string;
  room_name: string | null;
  game_status: RoomStatus;
  lobby_game_mode: GameMode | null;
  member_count: number | null;
  spectator_count: number | null;
  lobby_player_capacity: number | null;
  lobby_spectator_capacity: number | null;
  prepared_question_source: RoomQuestionSource | null;
  created_at: string;
  activity_at: string;
  status_rank: number;
};

type PublicRoomCursor = {
  version: 3;
  statusRank: number;
  updatedAt: string;
  createdAt: string;
  id: string;
};

type PublicRoomPage = {
  rooms: PublicRoomSummary[];
  nextCursor: string | null;
};

const PUBLIC_ROOM_PAGE_SIZE = 20;
const PUBLIC_ROOM_QUERY_LIMIT = PUBLIC_ROOM_PAGE_SIZE + 1;
const PUBLIC_ROOM_ACTIVITY_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_ROOM_PRESENCE_CONCURRENCY = 5;
const PUBLIC_ROOM_PRESENCE_TIMEOUT_MS = 800;
const PUBLIC_ROOM_DIRECTORY_CACHE_TTL_SECONDS = 60;
const PUBLIC_ROOM_DIRECTORY_CACHE_VERSION = 2;

type PublicRoomResponseCache = Pick<Cache, "match" | "put">;

function encodePublicRoomCursor(room: PublicRoomRow) {
  return btoa(JSON.stringify({
    version: 3,
    statusRank: room.status_rank,
    updatedAt: room.activity_at,
    createdAt: room.created_at,
    id: room.id,
  } satisfies PublicRoomCursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodePublicRoomCursor(value: string | null | undefined): PublicRoomCursor | null {
  if (!value) return null;
  if (value.length > 1024) throw new Error("公开房间游标无效。");
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(base64)) as Partial<PublicRoomCursor>;
    if (
      parsed.version !== 3 ||
      !Number.isInteger(parsed.statusRank) ||
      Number(parsed.statusRank) < 0 ||
      Number(parsed.statusRank) > 4 ||
      typeof parsed.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !parsed.id
    ) {
      throw new Error("invalid cursor payload");
    }
    return {
      version: 3,
      statusRank: Number(parsed.statusRank),
      updatedAt: parsed.updatedAt,
      createdAt: parsed.createdAt,
      id: parsed.id,
    };
  } catch {
    throw new Error("公开房间游标无效。");
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function listPublicRooms(env: Env, cursorValue?: string | null, now = Date.now()): Promise<PublicRoomPage> {
  const cursor = decodePublicRoomCursor(cursorValue);
  const cutoffIso = new Date(now - PUBLIC_ROOM_ACTIVITY_WINDOW_MS).toISOString();
  const cursorClause = cursor ? `WHERE
      status_rank > ? OR
      (status_rank = ? AND activity_at < ?) OR
      (status_rank = ? AND activity_at = ? AND created_at < ?) OR
      (status_rank = ? AND activity_at = ? AND created_at = ? AND id < ?)` : "";
  const bindings: Array<string | number> = [CURRENT_ROOM_RUNTIME_GENERATION, cutoffIso];
  if (cursor) {
    bindings.push(
      cursor.statusRank,
      cursor.statusRank, cursor.updatedAt,
      cursor.statusRank, cursor.updatedAt, cursor.createdAt,
      cursor.statusRank, cursor.updatedAt, cursor.createdAt, cursor.id,
    );
  }
  bindings.push(PUBLIC_ROOM_QUERY_LIMIT);
  const result = await env.DB.prepare(`WITH ranked_rooms AS (
      SELECT
        id,room_code,room_name,game_status,lobby_game_mode,member_count,spectator_count,lobby_player_capacity,lobby_spectator_capacity,prepared_question_source,created_at,
        COALESCE(public_activity_at,updated_at) AS activity_at,
        CASE
          WHEN game_status='PLAYING' THEN 0
          WHEN game_status='QUESTION_SETUP' AND prepared_question_source IS NOT NULL THEN 1
          WHEN game_status='QUESTION_SETUP' THEN 2
          WHEN game_status='LOBBY' THEN 3
          ELSE 4
        END AS status_rank
      FROM rooms
      WHERE room_visibility='PUBLIC' AND runtime_generation=?
        AND (game_status IN ('PLAYING','GAME_RESULT') OR COALESCE(public_activity_at,updated_at)>=?)
    )
    SELECT id,room_code,room_name,game_status,lobby_game_mode,member_count,spectator_count,lobby_player_capacity,lobby_spectator_capacity,prepared_question_source,created_at,activity_at,status_rank
    FROM ranked_rooms
    ${cursorClause}
    ORDER BY status_rank ASC, activity_at DESC, created_at DESC, id DESC
    LIMIT ?`)
    .bind(...bindings)
    .all<PublicRoomRow>();
  const candidates = result.results ?? [];
  const pageCandidates = candidates.slice(0, PUBLIC_ROOM_PAGE_SIZE);
  const rooms: PublicRoomSummary[] = pageCandidates
    .map((room) => ({
      id: room.id,
      code: room.room_code,
      name: room.room_name?.trim() || "未命名房间",
      status: room.game_status,
      gameMode: room.lobby_game_mode ?? "ROUND_REVEAL",
      playerCount: Math.max(0, Math.min(50, Number(room.member_count) || 0)),
      spectatorCount: Math.max(0, Math.min(50, Number(room.spectator_count) || 0)),
      playerCapacity: Math.max(1, Math.min(50, Number(room.lobby_player_capacity) || 50)),
      spectatorCapacity: typeof room.lobby_spectator_capacity === "number"
        ? Math.max(0, Math.min(50, room.lobby_spectator_capacity))
        : 50,
      isCountApproximate: room.game_status === "PLAYING" || room.game_status === "GAME_RESULT",
      questionSource: room.prepared_question_source ?? null,
      currentQuestionIndex: null,
      questionCount: null,
      createdAt: room.created_at,
      updatedAt: room.activity_at,
    }));

  const enrichedRooms = await mapWithConcurrency(rooms, PUBLIC_ROOM_PRESENCE_CONCURRENCY, async (room) => {
    if (room.status !== "PLAYING" && room.status !== "GAME_RESULT") return room;
    try {
      const topic = `room:${room.id}`;
      const presenceUrl = new URL("https://room-object/internal/public-presence");
      presenceUrl.searchParams.set("topic", topic);
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort("房间在线人数读取超时。"), PUBLIC_ROOM_PRESENCE_TIMEOUT_MS);
      const response = await getRoomObject(env, topic).fetch(new Request(presenceUrl, { signal: abortController.signal }))
        .finally(() => clearTimeout(timeout));
      if (!response.ok) throw new Error(`presence ${response.status}`);
      const presence = await response.json<{
        status?: RoomStatus;
        playerCount?: number;
        spectatorCount?: number;
        playerCapacity?: number;
        spectatorCapacity?: number;
        updatedAt?: string;
        currentQuestionIndex?: number;
        questionCount?: number;
      }>();
      if (typeof presence.playerCount !== "number") throw new Error("invalid presence response");
      const presenceUpdatedAt = typeof presence.updatedAt === "string" && Number.isFinite(Date.parse(presence.updatedAt))
        ? presence.updatedAt
        : room.updatedAt;
      const hasValidProgress = Number.isInteger(presence.currentQuestionIndex) &&
        Number.isInteger(presence.questionCount) &&
        Number(presence.currentQuestionIndex) >= 0 &&
        Number(presence.questionCount) > 0 &&
        Number(presence.currentQuestionIndex) < Number(presence.questionCount);
      const playerCapacity = typeof presence.playerCapacity === "number"
        ? Math.max(1, Math.min(50, Math.floor(presence.playerCapacity)))
        : room.playerCapacity;
      const spectatorCapacity = typeof presence.spectatorCapacity === "number"
        ? Math.max(0, Math.min(50, Math.floor(presence.spectatorCapacity)))
        : room.spectatorCapacity;
      return {
        ...room,
        status: presence.status ?? room.status,
        playerCount: Math.max(0, Math.min(playerCapacity, Math.floor(presence.playerCount))),
        spectatorCount: typeof presence.spectatorCount === "number"
          ? Math.max(0, Math.min(spectatorCapacity, Math.floor(presence.spectatorCount)))
          : room.spectatorCount,
        playerCapacity,
        spectatorCapacity,
        isCountApproximate: false,
        updatedAt: presenceUpdatedAt,
        currentQuestionIndex: hasValidProgress ? Number(presence.currentQuestionIndex) : null,
        questionCount: hasValidProgress ? Number(presence.questionCount) : null,
      };
    } catch {
      return room;
    }
  });
  const cutoffMs = now - PUBLIC_ROOM_ACTIVITY_WINDOW_MS;
  return {
    rooms: enrichedRooms.filter((room) => {
      const updatedAtMs = Date.parse(room.updatedAt);
      return Number.isFinite(updatedAtMs) && updatedAtMs >= cutoffMs;
    }),
    nextCursor: candidates.length > PUBLIC_ROOM_PAGE_SIZE && pageCandidates.length > 0
      ? encodePublicRoomCursor(pageCandidates[pageCandidates.length - 1])
      : null,
  };
}

function getPublicRoomDirectoryCacheKey(request: Request, cursorValue?: string | null) {
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = "/api/public-rooms";
  cacheUrl.search = "";
  cacheUrl.searchParams.set("cacheVersion", String(PUBLIC_ROOM_DIRECTORY_CACHE_VERSION));
  cacheUrl.searchParams.set("runtimeGeneration", String(CURRENT_ROOM_RUNTIME_GENERATION));
  if (cursorValue) cacheUrl.searchParams.set("cursor", cursorValue);
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function publicRoomDirectoryClientResponse(response: Response, request: Request, env: Env, cacheStatus: "HIT" | "MISS") {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-public-room-cache", cacheStatus);
  return withCors(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }), request, env);
}

export async function getPublicRoomsResponse(
  request: Request,
  env: Env,
  cache: PublicRoomResponseCache,
): Promise<Response> {
  const cursorValue = new URL(request.url).searchParams.get("cursor");
  const cacheKey = getPublicRoomDirectoryCacheKey(request, cursorValue);
  try {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) return publicRoomDirectoryClientResponse(cachedResponse, request, env, "HIT");
  } catch (error) {
    logAuxiliaryFailure("public_room_directory_cache_read_failed", error);
  }

  const page = await listPublicRooms(env, cursorValue);
  const body = JSON.stringify(page);
  const cacheResponse = new Response(body, {
    headers: {
      "cache-control": `public, max-age=${PUBLIC_ROOM_DIRECTORY_CACHE_TTL_SECONDS}`,
      "content-type": "application/json; charset=utf-8",
    },
  });
  try {
    await cache.put(cacheKey, cacheResponse.clone());
  } catch (error) {
    logAuxiliaryFailure("public_room_directory_cache_write_failed", error);
  }
  return publicRoomDirectoryClientResponse(cacheResponse, request, env, "MISS");
}

async function getExpiredRooms(env: Env, cutoffIso: string) {
  return queryRows<ExpiredRoomRow>(
    env,
    `select id, room_code, game_status, updated_at
     from rooms
     where updated_at < ?
     order by updated_at asc
     limit ?`,
    cutoffIso,
    ROOM_CLEANUP_MAX_ROOMS_PER_RUN,
  );
}

export function expandCleanupQuestionSetImageRows(rows: CleanupQuestionSetImageRow[]) {
  const expanded: CleanupQuestionSetImageRow[] = [];
  const expandedManifestIds = new Set<string>();
  for (const row of rows) {
    if (row.image_url) expanded.push({ ...row, manifest_version: null, manifest_json: null });
    if (row.manifest_version == null || expandedManifestIds.has(row.question_set_id)) continue;
    expandedManifestIds.add(row.question_set_id);
    const imageUrls = getManifestImageUrls({
      id: row.question_set_id,
      manifest_version: row.manifest_version,
      manifest_json: row.manifest_json ?? null,
    });
    for (const imageUrl of imageUrls ?? []) {
      expanded.push({ room_id: row.room_id, question_set_id: row.question_set_id, image_url: imageUrl });
    }
  }
  return expanded;
}

async function getUnpublishedQuestionSetImageRowsForRooms(env: Env, roomIds: string[]) {
  const rows: CleanupQuestionSetImageRow[] = [];
  for (const roomIdChunk of chunkArray(roomIds, ROOM_CLEANUP_SQL_CHUNK_SIZE)) {
    if (roomIdChunk.length === 0) {
      continue;
    }

    const roomPlaceholders = placeholders(roomIdChunk.length);
    rows.push(
      ...(await queryRows<CleanupQuestionSetImageRow>(
        env,
        `select distinct r.id as room_id, qs.id as question_set_id, q.image_url as image_url,
                qs.manifest_version as manifest_version, qs.manifest_json as manifest_json
         from rooms r
         join question_sets qs on qs.id = r.prepared_question_set_id
         left join questions q on q.question_set_id = qs.id
         where r.id in (${roomPlaceholders}) and qs.is_public = 0
         union
         select distinct gs.room_id as room_id, qs.id as question_set_id, q.image_url as image_url,
                qs.manifest_version as manifest_version, qs.manifest_json as manifest_json
         from game_sessions gs
         join question_sets qs on qs.id = gs.question_set_id
         left join questions q on q.question_set_id = qs.id
         where gs.room_id in (${roomPlaceholders}) and qs.is_public = 0`,
        ...roomIdChunk,
        ...roomIdChunk,
      )),
    );
  }

  return expandCleanupQuestionSetImageRows(rows);
}

async function getOldOrphanUnpublishedQuestionSetIds(env: Env, cutoffIso: string) {
  const rows = await queryRows<IdRow>(
    env,
    `select qs.id
     from question_sets qs
     where qs.is_public = 0
       and qs.updated_at < ?
       and not exists (
         select 1 from game_sessions gs where gs.question_set_id = qs.id
       )
       and not exists (
         select 1 from rooms r where r.prepared_question_set_id = qs.id
       )
     order by qs.updated_at asc, qs.id asc
     limit ?`,
    cutoffIso,
    ROOM_CLEANUP_MAX_ORPHAN_QUESTION_SETS_PER_RUN,
  );
  return rows.map((row) => row.id);
}

async function getQuestionSetImageRows(env: Env, questionSetIds: string[]) {
  const rows: CleanupQuestionSetImageRow[] = [];
  for (const questionSetIdChunk of chunkArray(questionSetIds, ROOM_CLEANUP_SQL_CHUNK_SIZE)) {
    if (questionSetIdChunk.length === 0) {
      continue;
    }

    rows.push(
      ...(await queryRows<CleanupQuestionSetImageRow>(
        env,
        `select qs.id as question_set_id, q.image_url as image_url,
                qs.manifest_version as manifest_version, qs.manifest_json as manifest_json
         from question_sets qs
         left join questions q on q.question_set_id = qs.id
         where qs.id in (${placeholders(questionSetIdChunk.length)}) and qs.is_public = 0`,
        ...questionSetIdChunk,
      )),
    );
  }

  return expandCleanupQuestionSetImageRows(rows);
}

async function getUnreferencedUnpublishedQuestionSetIds(env: Env, questionSetIds: string[]) {
  const unreferencedIds: string[] = [];
  for (const questionSetIdChunk of chunkArray(questionSetIds, ROOM_CLEANUP_SQL_CHUNK_SIZE)) {
    if (questionSetIdChunk.length === 0) continue;
    const rows = await queryRows<IdRow>(
      env,
      `select qs.id
       from question_sets qs
       where qs.is_public = 0
         and qs.id in (${placeholders(questionSetIdChunk.length)})
         and not exists (
           select 1 from game_sessions gs where gs.question_set_id = qs.id
         )
         and not exists (
           select 1 from rooms r where r.prepared_question_set_id = qs.id
         )`,
      ...questionSetIdChunk,
    );
    unreferencedIds.push(...rows.map((row) => row.id));
  }
  return unreferencedIds;
}

async function deleteExpiredRooms(env: Env, roomIds: string[], cutoffIso: string) {
  const deletedRoomIds: string[] = [];
  for (const roomIdChunk of chunkArray(roomIds, ROOM_CLEANUP_SQL_CHUNK_SIZE)) {
    if (roomIdChunk.length === 0) {
      continue;
    }

    const rows = await queryRows<IdRow>(
      env,
      `delete from rooms
       where id in (${placeholders(roomIdChunk.length)}) and updated_at < ?
       returning id`,
      ...roomIdChunk,
      cutoffIso,
    );
    deletedRoomIds.push(...rows.map((row) => row.id));
  }

  return deletedRoomIds;
}

async function getR2ImageReferences(env: Env) {
  const referenceNeedle = getR2ReferenceNeedle(env);
  if (!referenceNeedle) {
    return [];
  }

  const rows = await queryRows<R2ImageReferenceRow>(
    env,
    `select q.question_set_id, qs.is_public, q.image_url,
            null as manifest_version, null as manifest_json
     from questions q
     join question_sets qs on qs.id = q.question_set_id
     where instr(q.image_url, ?) > 0
     union all
     select qs.id as question_set_id, qs.is_public, null as image_url,
            qs.manifest_version, qs.manifest_json
     from question_sets qs
     where qs.manifest_version = 1 and instr(qs.manifest_json, ?) > 0`,
    referenceNeedle,
    referenceNeedle,
  );
  const references: Array<R2ImageReferenceRow & { image_url: string }> = [];
  for (const row of rows) {
    if (row.image_url) references.push({ ...row, image_url: row.image_url });
    if (row.manifest_version == null) continue;
    for (const imageUrl of getManifestImageUrls({
      id: row.question_set_id,
      manifest_version: row.manifest_version,
      manifest_json: row.manifest_json ?? null,
    }) ?? []) {
      references.push({ question_set_id: row.question_set_id, is_public: row.is_public, image_url: imageUrl });
    }
  }
  return references;
}

export async function cleanupUnreferencedR2Objects(env: Env, now = Date.now()) {
  const prefix = getR2ImagePrefix(env);
  if (!prefix) {
    throw new Error("R2 孤儿清理失败：图片对象前缀为空。");
  }

  const references = await getR2ImageReferences(env);
  const referencedKeys = new Set<string>();
  for (const reference of references) {
    const key = getR2ObjectKeyFromImageUrl(reference.image_url, env, { allowAnyOriginPrefixPath: true });
    if (key) referencedKeys.add(key);
  }

  const cutoffMs = now - R2_ORPHAN_CLEANUP_MIN_AGE_MS;
  const keysToDelete: string[] = [];
  let listedObjectCount = 0;
  let listingStoppedAtDeleteLimit = false;
  let cursor: string | undefined;

  do {
    const listed = await env.IMAGE_BUCKET.list({
      prefix: `${prefix}/`,
      limit: R2_ORPHAN_CLEANUP_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    listedObjectCount += listed.objects.length;

    for (const object of listed.objects) {
      if (keysToDelete.length >= R2_CLEANUP_MAX_DELETE_PER_RUN) break;
      if (object.uploaded.getTime() > cutoffMs || referencedKeys.has(object.key)) continue;
      keysToDelete.push(object.key);
    }

    if (keysToDelete.length >= R2_CLEANUP_MAX_DELETE_PER_RUN) {
      listingStoppedAtDeleteLimit = true;
      break;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  } while (cursor);

  const deleteResult = await deleteR2KeysInBatches(env.IMAGE_BUCKET, keysToDelete);

  const summary = {
    event: "unreferenced_r2_cleanup_completed",
    cutoffIso: new Date(cutoffMs).toISOString(),
    referencedR2KeyCount: referencedKeys.size,
    listedObjectCount,
    deletedR2KeyCount: deleteResult.deletedR2KeyCount,
    deleteBatchCount: deleteResult.successfulBatchCount,
    listingStoppedAtDeleteLimit,
  };
  console.info(JSON.stringify(summary));
  return summary;
}

async function deleteUnreferencedQuestionSets(env: Env, questionSetIds: string[]) {
  const deletedQuestionSetIds: string[] = [];
  for (const questionSetIdChunk of chunkArray(questionSetIds, ROOM_CLEANUP_SQL_CHUNK_SIZE)) {
    if (questionSetIdChunk.length === 0) {
      continue;
    }

    const rows = await queryRows<IdRow>(
      env,
      `delete from question_sets
       where is_public = 0
         and id in (${placeholders(questionSetIdChunk.length)})
         and not exists (
           select 1 from game_sessions gs where gs.question_set_id = question_sets.id
         )
         and not exists (
           select 1 from rooms r where r.prepared_question_set_id = question_sets.id
         )
       returning id`,
      ...questionSetIdChunk,
    );
    deletedQuestionSetIds.push(...rows.map((row) => row.id));
  }

  return deletedQuestionSetIds;
}

export async function cleanupExpiredRooms(env: Env, now = Date.now()) {
  if (!env.IMAGE_BUCKET) {
    throw new Error("自动清理失败：缺少 R2 存储绑定。");
  }

  const cutoffIso = new Date(now - ROOM_CLEANUP_IDLE_MS).toISOString();
  const expiredRooms = await getExpiredRooms(env, cutoffIso);
  const expiredRoomIds = expiredRooms.map((room) => room.id);
  const roomCandidateRows = await getUnpublishedQuestionSetImageRowsForRooms(env, expiredRoomIds);
  const deletedRoomIds = await deleteExpiredRooms(env, expiredRoomIds, cutoffIso);
  const deletedRoomIdSet = new Set(deletedRoomIds);
  const rowsForDeletedRooms = roomCandidateRows.filter((row) => row.room_id && deletedRoomIdSet.has(row.room_id));
  const orphanQuestionSetIds = await getOldOrphanUnpublishedQuestionSetIds(env, cutoffIso);
  const orphanRows = await getQuestionSetImageRows(env, orphanQuestionSetIds);
  const candidateRows = [...rowsForDeletedRooms, ...orphanRows];
  const candidateIds = Array.from(new Set(candidateRows.map((row) => row.question_set_id)));
  const unreferencedQuestionSetIds = new Set(await getUnreferencedUnpublishedQuestionSetIds(env, candidateIds));
  const cleanupRows = candidateRows.filter((row) => unreferencedQuestionSetIds.has(row.question_set_id));
  const candidateQuestionSetIds = new Set(cleanupRows.map((row) => row.question_set_id));
  const candidateKeys = new Set<string>();
  const questionSetKeys = new Map<string, Set<string>>();

  for (const row of cleanupRows) {
    const imageUrl = row.image_url;
    if (!imageUrl) {
      continue;
    }

    const key = getR2ObjectKeyFromImageUrl(imageUrl, env);
    if (!key) {
      continue;
    }

    candidateKeys.add(key);
    const keys = questionSetKeys.get(row.question_set_id) ?? new Set<string>();
    keys.add(key);
    questionSetKeys.set(row.question_set_id, keys);
  }

  const protectedKeys = new Set<string>();
  if (candidateKeys.size > 0) {
    const references = await getR2ImageReferences(env);
    for (const reference of references) {
      const key = getR2ObjectKeyFromImageUrl(reference.image_url, env, { allowAnyOriginPrefixPath: true });
      if (!key || !candidateKeys.has(key)) {
        continue;
      }

      if (isDbTruthy(reference.is_public) || !candidateQuestionSetIds.has(reference.question_set_id)) {
        protectedKeys.add(key);
      }
    }
  }

  const allKeysToDelete = Array.from(candidateKeys).filter((key) => !protectedKeys.has(key));
  const keysToDelete = allKeysToDelete.slice(0, R2_CLEANUP_MAX_DELETE_PER_RUN);
  const deferredR2Keys = new Set(allKeysToDelete.slice(R2_CLEANUP_MAX_DELETE_PER_RUN));
  const { deletedR2KeyCount, failedR2Keys, successfulBatchCount } = await deleteR2KeysInBatches(
    env.IMAGE_BUCKET,
    keysToDelete,
    (error, failedKeys) => {
      logAuxiliaryFailure("expired_room_r2_delete_failed", error, {
        batchR2KeyCount: failedKeys.length,
        sampleKey: failedKeys[0] ?? null,
      });
    },
  );

  const deletableQuestionSetIds = Array.from(candidateQuestionSetIds).filter((questionSetId) => {
    const keys = questionSetKeys.get(questionSetId);
    if (!keys) {
      return true;
    }

    return !Array.from(keys).some((key) => failedR2Keys.has(key) || deferredR2Keys.has(key));
  });
  const deletedQuestionSetIds = await deleteUnreferencedQuestionSets(env, deletableQuestionSetIds);
  const summary = {
    event: "expired_room_cleanup_completed",
    cutoffIso,
    selectedRoomCount: expiredRooms.length,
    deletedRoomCount: deletedRoomIds.length,
    candidateQuestionSetCount: candidateQuestionSetIds.size,
    deletedQuestionSetCount: deletedQuestionSetIds.length,
    candidateR2KeyCount: candidateKeys.size,
    deletedR2KeyCount,
    deleteBatchCount: successfulBatchCount,
    protectedR2KeyCount: protectedKeys.size,
    failedR2KeyCount: failedR2Keys.size,
    deferredR2KeyCount: deferredR2Keys.size,
  };

  console.info(JSON.stringify(summary));
  return summary;
}

export class RoomDurableObjectV3 {
  private readonly authority: RoomGameAuthority;
  private readonly authorityVNext: RoomAuthorityVNext;
  private readonly runtime: RoomRuntimeV3Storage;
  private authorityTopic: string | null = null;
  private readonly recentActions = new Map<string, { expiresAt: number; result: unknown }>();
  private readonly roundSnapshotCache = new Map<string, { expiresAt: number; snapshot: RoundSnapshot }>();
  private readonly bootstrapSnapshotCache = new Map<string, { expiresAt: number; snapshot: GameBootstrapSnapshot }>();
  private readonly gameResultSnapshotCache = new Map<string, { expiresAt: number; snapshot: GameResultSnapshot }>();
  private readonly roundSnapshotReadInflight = new Map<string, Promise<RoundSnapshot>>();
  private readonly bootstrapSnapshotReadInflight = new Map<string, Promise<GameBootstrapSnapshot>>();
  private readonly gameResultSnapshotReadInflight = new Map<string, Promise<GameResultSnapshot>>();
  private readonly roundSnapshotCacheGeneration = new Map<string, number>();
  private roundSnapshotCacheEpoch = 0;
  private readonly roomPlayerCountByTopic = new Map<string, number>();
  private readonly roomChatRateLimiter = new RoomChatRateLimiter();
  private actionQueue: Promise<void> = Promise.resolve();
  private r2UploadQueue: Promise<void> = Promise.resolve();
  private lastRecentActionCacheSweepAt = 0;
  private lastSnapshotCacheSweepAt = 0;
  private deadlineReconcilePromise: Promise<void> | null = null;
  private connectionDeadlineReconcilePromise: Promise<void> | null = null;
  private deadlineReconcileRequired = true;
  private deadlineReconciledTopic: string | null = null;
  private deadlineReconcileAfterAlarm = false;
  private lastActionReceivedAtMs = 0;
  private projectionFlushQueue: Promise<void> = Promise.resolve();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.authority = new RoomGameAuthority(state.storage, env.DB);
    this.authorityVNext = new RoomAuthorityVNext(state, env.DB);
    this.runtime = new RoomRuntimeV3Storage(state.storage);
    state.blockConcurrencyWhile(async () => this.runtime.initializeSchema());
  }

  private resolveRoomChatTeamAudience(topic: string, playerId: string) {
    const aggregate = this.authorityVNext.getAggregate();
    if (
      !aggregate ||
      aggregate.roomId !== getRoomIdFromTopic(topic) ||
      aggregate.room?.status !== "PLAYING" ||
      aggregate.gameSession?.gameMode !== "TEAM_BATTLE"
    ) return null;

    const teams = aggregate.gameSession.teamBattleState?.teams;
    if (!teams) return null;
    return buildRoomChatTeamAudience({
      senderPlayerId: playerId,
      teams,
      players: aggregate.players,
      presenterPlayerId: aggregate.gameSession.presenterPlayerId,
    });
  }

  private expireRetiredSocket(socket: WebSocket) {
    try {
      socket.send(JSON.stringify({
        type: "room_expired",
        code: ROOM_VERSION_EXPIRED_ERROR_CODE,
        message: ROOM_VERSION_EXPIRED_MESSAGE,
      }));
    } catch { /* The socket may already be errored or closed. */ }
    try { socket.close(4001, ROOM_VERSION_EXPIRED_ERROR_CODE); } catch { /* Best-effort retirement. */ }
  }

  private async retireOldGeneration() {
    try {
      await this.state.storage.deleteAlarm();
    } catch (error) {
      logAuxiliaryFailure("room_runtime_old_generation_alarm_cleanup_failed", error);
    }
    for (const socket of this.state.getWebSockets()) this.expireRetiredSocket(socket);
  }

  private getAuthorityRoomId(topic = this.authorityTopic) {
    return getRoomIdFromTopic(topic);
  }

  private async ensureAuthority(topic: string | null | undefined, _force = false) {
    const roomId = getRoomIdFromTopic(topic);
    if (!roomId) throw new Error("实时房间标识无效。");
    this.authorityTopic = `room:${roomId}`;
    this.runtime.ensureRoom(roomId);
    if (this.authorityVNext.hasStoredState()) {
      await this.restoreVNextAuthority();
    }
    return roomId;
  }

  private async restoreVNextAuthority(options: { reconcileAlarm?: boolean } = {}) {
    await this.authorityVNext.restoreFromStorage();
    if (options.reconcileAlarm !== false && this.authorityVNext.hasPendingDeadlineRepair()) {
      await this.reconcileVNextAlarm();
    }
  }

  private async runWithAuthority<T>(topic: string | null | undefined, callback: () => Promise<T>) {
    await this.ensureAuthority(topic);
    return await runWithGameDatabase(this.env, callback);
  }

  private flushAuthorityProjections() {
    const task = this.projectionFlushQueue.then(
      () => this.doFlushAuthorityProjections(),
      () => this.doFlushAuthorityProjections(),
    );
    this.projectionFlushQueue = task.catch(() => undefined);
    return task;
  }

  private async doFlushAuthorityProjections() {
    try {
      await this.authorityVNext.flushFinalProjection();
    } catch (error) {
      logAuxiliaryFailure("authority_vnext_projection_failed", error);
    }
  }

  private rememberRoomPlayerCount(topic: string | null | undefined, result: unknown) {
    const normalizedTopic = sanitizeLogString(topic, RPC_LOG_ID_MAX_LENGTH);
    const playerCount = getRoomPlayerCount(getResultRoom(result));
    if (normalizedTopic && playerCount != null) {
      this.roomPlayerCountByTopic.set(normalizedTopic, playerCount);
    }
  }

  private getCachedGameSessionForLog(gameSessionId: string | null | undefined) {
    if (!gameSessionId) {
      return null;
    }

    return this.getCachedRoundSnapshot(gameSessionId)?.gameSession ??
      this.getCachedBootstrapSnapshot(gameSessionId)?.gameSession ??
      this.getCachedGameResultSnapshot(gameSessionId)?.gameSession ??
      null;
  }

  private getGameRpcErrorLogContext(
    name: string | undefined,
    args: unknown[],
    topic: string | null | undefined,
    knownContext: GameRpcErrorLogContext = {},
  ): GameRpcErrorLogContext {
    const argumentContext = getGameRpcArgumentLogContext(name, args);
    const gameSessionId = knownContext.gameSessionId ?? argumentContext.gameSessionId ?? null;
    const cachedGameSession = this.getCachedGameSessionForLog(gameSessionId);
    const normalizedTopic = sanitizeLogString(topic, RPC_LOG_ID_MAX_LENGTH);
    const roomPlayerCount = normalizedTopic ? this.roomPlayerCountByTopic.get(normalizedTopic) ?? null : null;
    const eligiblePlayerCount = getGameSessionEligiblePlayerCount(cachedGameSession);

    return {
      roomId:
        knownContext.roomId ??
        argumentContext.roomId ??
        cachedGameSession?.roomId ??
        getRoomIdFromTopic(normalizedTopic),
      gameSessionId: gameSessionId ?? cachedGameSession?.id ?? null,
      questionIndex:
        knownContext.questionIndex ??
        cachedGameSession?.currentQuestionIndex ??
        argumentContext.questionIndex ??
        null,
      expectedQuestionIndex: knownContext.expectedQuestionIndex ?? argumentContext.expectedQuestionIndex ?? null,
      playerCount: knownContext.playerCount ?? roomPlayerCount ?? null,
      eligiblePlayerCount: knownContext.eligiblePlayerCount ?? eligiblePlayerCount ?? null,
    };
  }

  private enrichGameRpcErrorLogContext(
    current: GameRpcErrorLogContext,
    result: unknown,
    roundSnapshot: RoundSnapshot | null,
    topic: string | null | undefined,
  ) {
    const room = getResultRoom(result);
    const gameSession = roundSnapshot?.gameSession ?? getResultGameSession(result);
    const roomPlayerCount = getRoomPlayerCount(room);
    const eligiblePlayerCount = getGameSessionEligiblePlayerCount(gameSession);
    this.rememberRoomPlayerCount(topic, result);

    return {
      roomId: room?.id ?? gameSession?.roomId ?? current.roomId ?? getRoomIdFromTopic(topic),
      gameSessionId: gameSession?.id ?? current.gameSessionId ?? null,
      questionIndex: gameSession?.currentQuestionIndex ?? current.questionIndex ?? null,
      expectedQuestionIndex: current.expectedQuestionIndex ?? null,
      playerCount: roomPlayerCount ?? current.playerCount ?? null,
      eligiblePlayerCount: eligiblePlayerCount ?? current.eligiblePlayerCount ?? null,
    } satisfies GameRpcErrorLogContext;
  }

  private logGameRpcError(params: {
    transport?: "websocket" | "http";
    name?: string;
    args?: unknown[];
    topic?: string | null;
    clientActionId?: string;
    receivedAtMs?: number;
    context?: GameRpcErrorLogContext;
    error: unknown;
  }) {
    try {
      const context = this.getGameRpcErrorLogContext(params.name, params.args ?? [], params.topic, params.context);
      console.error(
        JSON.stringify({
          event: "game_rpc_error",
          transport: params.transport ?? "websocket",
          name: sanitizeLogString(params.name, RPC_LOG_NAME_MAX_LENGTH),
          topic: sanitizeLogString(params.topic, RPC_LOG_ID_MAX_LENGTH),
          doId: sanitizeLogString(this.state.id.toString(), RPC_LOG_ID_MAX_LENGTH),
          roomId: sanitizeLogString(context.roomId, RPC_LOG_ID_MAX_LENGTH),
          gameSessionId: sanitizeLogString(context.gameSessionId, RPC_LOG_ID_MAX_LENGTH),
          questionIndex: context.questionIndex ?? null,
          expectedQuestionIndex: context.expectedQuestionIndex ?? null,
          playerCount: context.playerCount ?? null,
          eligiblePlayerCount: context.eligiblePlayerCount ?? null,
          clientActionId: sanitizeLogString(params.clientActionId, RPC_LOG_ID_MAX_LENGTH),
          durationMs:
            typeof params.receivedAtMs === "number" && Number.isFinite(params.receivedAtMs)
              ? Math.max(0, Date.now() - params.receivedAtMs)
              : null,
          ...getErrorLogDetails(params.error),
        }),
      );
    } catch (loggingError) {
      logAuxiliaryFailure("game_rpc_error_logging_failed", loggingError, {
        name: sanitizeLogString(params.name, RPC_LOG_NAME_MAX_LENGTH),
        topic: sanitizeLogString(params.topic, RPC_LOG_ID_MAX_LENGTH),
      });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (this.runtime.isRetiredGeneration()) {
      await this.retireOldGeneration();
      if (request.headers.get("upgrade") === "websocket") {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.state.acceptWebSocket(server);
        this.expireRetiredSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }
      return Response.json(
        { error: ROOM_VERSION_EXPIRED_MESSAGE, code: ROOM_VERSION_EXPIRED_ERROR_CODE },
        { status: 410 },
      );
    }

    if (url.pathname === "/internal/public-presence" && request.method === "GET") {
      const topic = url.searchParams.get("topic") ?? "";
      const roomId = getRoomIdFromRequiredTopic(topic);
      this.authorityTopic = topic;
      await this.authorityVNext.restoreFromStorage({ persistRepairs: false });
      const aggregate = this.authorityVNext.getAggregate();
      if (!aggregate || aggregate.roomId !== roomId || !aggregate.room || aggregate.dissolved) {
        return Response.json({ error: "房间实时状态不可用。" }, { status: 404 });
      }
      return Response.json({
        status: aggregate.room.status,
        playerCount: aggregate.players.filter((player) => player.role === "PLAYER").length,
        spectatorCount: aggregate.players.filter((player) => player.role === "SPECTATOR").length,
        playerCapacity: aggregate.room.playerCapacity ?? 50,
        spectatorCapacity: aggregate.room.spectatorCapacity ?? 50,
        updatedAt: new Date(aggregate.lastPublicActivityAtMs).toISOString(),
        currentQuestionIndex: aggregate.gameSession?.currentQuestionIndex ?? null,
        questionCount: aggregate.questions.length,
      });
    }

    if (url.pathname === "/api/rpc" && request.method === "POST") {
      return request.headers.has(LOCAL_ROOM_OBJECT_TOPIC_HEADER)
        ? await this.enqueueActionBoundRpc(request)
        : await this.enqueueR2BoundRpc(request);
    }

    if (request.headers.get("upgrade") === "websocket") {
      const topic = url.searchParams.get("topic") ?? "";
      await this.ensureAuthority(topic);
      await this.tryEnsureDeadlineReconciled(topic, "websocket_connect");
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      const playerId = url.searchParams.get("playerId")?.trim() || undefined;
      const attachment: VNextSocketAttachment = {
        attachmentVersion: 1,
        topic,
        playerId,
        pending: [],
        serializedBytes: 0,
      };
      try {
        attachment.serializedBytes = new TextEncoder().encode(JSON.stringify(attachment)).byteLength;
        server.serializeAttachment(attachment);
      } catch (error) {
        logAuxiliaryFailure("websocket_attachment_initialize_failed", error, { topic, playerId: playerId ?? null });
      }
      const connectedAggregate = this.authorityVNext.getAggregate();
      const connectedGameId = connectedAggregate && (
        connectedAggregate.cutoverState === "active" ||
        (connectedAggregate.room != null && connectedAggregate.room.status !== "LOBBY") ||
        this.authorityVNext.hasPendingRoomHandoff()
      ) ? connectedAggregate.gameId : undefined;
      server.send(JSON.stringify({
        type: "connected",
        topic,
        authorityVersion: connectedAggregate ? 2 : 1,
        gameId: connectedGameId,
        committedSeqByActor: connectedGameId ? connectedAggregate?.committedSeqByActor : undefined,
      }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const message = await request.text();
      let parsedMessage: BroadcastMessage;
      try {
        parsedMessage = JSON.parse(message) as BroadcastMessage;
      } catch (error) {
        logAuxiliaryFailure("broadcast_parse_failed", error);
        return new Response("无效的广播消息。", { status: 400 });
      }

      return this.deadlineReconcileRequired
        ? await this.enqueueRecoveryBoundBroadcast(parsedMessage)
        : await this.handleBroadcastMessage(parsedMessage);
    }

    if (url.pathname === "/schedule-auto-forfeit" && request.method === "POST") {
      return await this.enqueueDeadlineSchedule(request);
    }

    return new Response("未找到对应的实时接口。", { status: 404 });
  }

  private enqueueR2BoundRpc(request: Request) {
    const task = this.r2UploadQueue.then(
      () => this.handleQueuedR2BoundRpc(request),
      () => this.handleQueuedR2BoundRpc(request),
    );
    this.r2UploadQueue = task.then(
      () => undefined,
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private enqueueActionBoundRpc(request: Request) {
    const receivedAtMs = Date.now();
    const task = this.actionQueue.then(
      () => this.handleQueuedR2BoundRpc(request, receivedAtMs),
      () => this.handleQueuedR2BoundRpc(request, receivedAtMs),
    );
    this.actionQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private enqueueDeadlineSchedule(request: Request) {
    const task = this.actionQueue.then(
      () => this.handleDeadlineScheduleRequest(request),
      () => this.handleDeadlineScheduleRequest(request),
    );
    this.actionQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private enqueueRecoveryBoundBroadcast(message: BroadcastMessage) {
    const task = this.actionQueue.then(
      () => this.handleBroadcastMessage(message),
      () => this.handleBroadcastMessage(message),
    );
    this.actionQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async flushPendingRoomHandoffForLobbyMutation(name: string | undefined) {
    if (!name || !ROOM_HANDOFF_BARRIER_NAMES.has(name) || !this.authorityVNext.hasPendingRoomHandoff()) return;
    const handoffReady = await this.authorityVNext.flushRoomHandoff();
    if (!handoffReady) throw new Error("上一局房间状态仍在同步，请稍后重试。");
  }

  private async handleBroadcastMessage(message: BroadcastMessage) {
    if (this.deadlineReconcileRequired) {
      await this.ensureDeadlineReconciled(message.topic, "legacy_broadcast_recovery");
    }

    try {
      this.rememberRoomPlayerCount(message.topic, message.result);
      this.invalidateRoundSnapshotCachesForMutation(message.name, message.result, message.args);
      const gameResultSnapshot = getBroadcastGameResultSnapshot(message);
      if (gameResultSnapshot) {
        await this.cacheGameResultSnapshot(gameResultSnapshot);
      }
    } catch (error) {
      logAuxiliaryFailure("broadcast_auxiliary_parse_failed", error);
    }

    await this.broadcastChangeMessage(message);
    return new Response(null, { status: 204 });
  }

  private async handleDeadlineScheduleRequest(request: Request) {
    const message = (await request.json()) as Partial<AutoForfeitScheduleMessage>;
    if (typeof message.topic !== "string") {
      return new Response("无效的 deadline transition 请求。", { status: 400 });
    }
    const hasTypedMutation =
      typeof message.mutationName === "string" &&
      getMutationDeadlinePolicy(message.mutationName) === "authoritative-post-state";
    console.info(
      JSON.stringify({
        event: "schedule_auto_forfeit_endpoint_called",
        source: message.source ?? "legacy_endpoint",
        mutationName: hasTypedMutation ? message.mutationName : "legacy_unknown",
        topic: sanitizeLogString(message.topic, RPC_LOG_ID_MAX_LENGTH),
      }),
    );

    const source = message.source ?? "legacy_endpoint";
    try {
      await this.reconcileDeadlineFromAuthority(message.topic, source);
    } catch (error) {
      this.deadlineReconcileRequired = true;
      this.deadlineReconciledTopic = null;
      console.error(
        JSON.stringify({
          event: "deadline_transition_failed",
          kind: "legacy_endpoint_reconciliation",
          source,
          topic: sanitizeLogString(message.topic, RPC_LOG_ID_MAX_LENGTH),
          stateMayHaveCommitted: true,
          ...getErrorLogDetails(error),
        }),
      );
      throw new DeadlineTransitionApplyError();
    }
    return new Response(null, { status: 204 });
  }

  private async handleQueuedR2BoundRpc(request: Request, receivedAtMs = Date.now()) {
    const localTopic = request.headers.get(LOCAL_ROOM_OBJECT_TOPIC_HEADER);
    let rpcName: string | undefined;
    let rpcArgs: unknown[] = [];
    try {
      const body = await readRpcBody(request);
      rpcName = body.name;
      rpcArgs = body.args ?? [];
      const mutationDeadlinePolicy = getMutationDeadlinePolicy(body.name ?? "");
      const localRoomId = getRoomIdFromTopic(localTopic);
      await this.flushPendingRoomHandoffForLobbyMutation(body.name);
      if (localTopic && localRoomId && body.name === "startGameWithQuestionSet" && isRecord(body.args?.[0])) {
        const startParams = { ...body.args[0], authorityVersion: 2 };
        const gameId = typeof startParams.startRequestId === "string" ? startParams.startRequestId : null;
        if (!gameId) throw new Error("authority vNext 开局请求缺少 startRequestId。");
        if (this.authorityVNext.hasPendingFinalProjection()) {
          if (this.authorityVNext.hasPendingRoomHandoff()) {
            const handoffReady = await this.authorityVNext.flushRoomHandoff();
            if (!handoffReady) throw new Error("上一局房间成员仍在同步，请稍后再开始新游戏。");
          } else {
            await this.authorityVNext.flushFinalProjection();
          }
          if (this.authorityVNext.hasPendingFinalProjection() && !this.authorityVNext.canStartAnotherGame()) throw new Error("上一局长期结果队列接近容量上限，请稍后再开始新游戏。");
        }
        this.authorityVNext.beginStart(localRoomId, gameId, startParams);
        let result: unknown;
        try {
          result = await runWithGameDatabase(this.env, () => callGameFunction("startGameWithQuestionSet", [startParams], receivedAtMs));
        } catch (error) {
          this.abortRejectedVNextStart(error, gameId, "request");
          throw error;
        }
        if (!isRecord(result)) throw new Error("authority vNext 开局结果无效。");
        const hidden = isRecord(result.__authorityVNextBootstrap) ? result.__authorityVNextBootstrap : null;
        const gameSession = asGameSession(result.gameSession);
        const room = asRoom(result.room);
        if (!hidden || !gameSession || !room || !Array.isArray(hidden.players) || !Array.isArray(hidden.questions) || !isRecord(hidden.questionSet)) throw new Error("authority vNext 开局 bootstrap 不完整。");
        const players = hidden.players as VNextStartBootstrap["players"];
        this.authorityVNext.activateStart({
          room: { ...room, players },
          players,
          questionSet: hidden.questionSet as VNextStartBootstrap["questionSet"],
          questions: hidden.questions as VNextStartBootstrap["questions"],
          questionSetManifestVersion: hidden.questionSetManifestVersion === 1 ? 1 : null,
          gameSession,
        });
        await this.reconcileVNextAlarm();
        this.broadcastVNextCutover();
        this.sendVNextDelta(body.name, { scope: "room", type: "room_updated", room: { ...room, players } });
        this.sendVNextDelta(body.name, { scope: "game", type: "round_snapshot", snapshot: this.authorityVNext.getSnapshot() });
        const { __authorityVNextBootstrap: _hidden, ...publicResult } = result;
        return Response.json({ data: publicResult });
      }
      if (localTopic && body.name && ROOM_AUTHORITY_ROSTER_QUERY_NAMES.has(body.name) && this.authorityVNext.hasStoredState()) {
        await this.restoreVNextAuthority();
        const aggregate = this.authorityVNext.getAggregate();
        if (shouldUseVNextRoomState(aggregate, this.authorityVNext.hasPendingRoomHandoff())) {
          return Response.json({ data: this.authorityVNext.query(body.name, body.args ?? []) });
        }
      }
      if (localTopic && body.name && VNEXT_POSITIONAL_ROOM_MUTATIONS.has(body.name)) {
        await this.ensureAuthority(localTopic);
        await this.resumeInitializingVNextStart();
        const aggregate = this.authorityVNext.getAggregate();
        const positional = getVNextPositionalMutation(body.name, body.args ?? []);
        if (shouldUseVNextRoomState(aggregate, this.authorityVNext.hasPendingRoomHandoff()) && positional) {
          const seen = aggregate.seenSeqByActor[positional.actorId] ?? aggregate.committedSeqByActor[positional.actorId] ?? 0;
          const envelope: VNextMutationEnvelope = {
            actionId: body.clientActionId || crypto.randomUUID(),
            actorId: positional.actorId,
            clientSeq: seen + 1,
            gameId: aggregate.gameId,
            questionIndex: aggregate.gameSession.currentQuestionIndex,
            name: body.name,
            payload: positional.payload,
          };
          const outcome = this.authorityVNext.handleMutation(null, envelope, receivedAtMs);
          this.invalidateVNextSnapshotCaches(outcome);
          if (outcome.provisional) {
            if (outcome.forceCheckpoint === "game-end") this.authorityVNext.prepareFinalResultsFromArchives();
            let receipt;
            try {
              receipt = await this.authorityVNext.forceCheckpoint(outcome.forceCheckpoint ?? "phase-boundary", outcome.archiveQuestion === true);
            } catch (error) {
              this.authorityVNext.resetAfterFailedTransition();
              throw error;
            }
            if (receipt) this.broadcastVNextDurableAck(receipt);
            await this.reconcileVNextAlarm();
            this.sendVNextOutcome(body.name, outcome);
            if (outcome.forceCheckpoint === "game-end" || outcome.forceCheckpoint === "projection") this.state.waitUntil(this.authorityVNext.flushFinalProjection());
          }
          const committedSeq = this.authorityVNext.getAggregate()?.committedSeqByActor[positional.actorId] ?? 0;
          const authoritySequence = committedSeq >= envelope.clientSeq
            ? { gameId: envelope.gameId, actorId: positional.actorId, committedSeq }
            : undefined;
          if (body.name === "joinRoom" && outcome.error) {
            return Response.json({
              data: {
                room: null,
                error: outcome.error,
                errorCode: getJoinCapacityErrorCode(outcome.error),
              },
              authoritySequence,
            });
          }
          return Response.json(
            outcome.error ? { error: outcome.error, authoritySequence } : { data: outcome.data, authoritySequence },
            { status: outcome.error ? 400 : 200 },
          );
        }
      }
      if (localTopic && (ROOM_AUTHORITY_MEMBERSHIP_NAMES.has(body.name ?? "") || ROOM_AUTHORITY_ROSTER_QUERY_NAMES.has(body.name ?? ""))) await this.ensureAuthority(localTopic);
      if (localTopic && mutationDeadlinePolicy != null) {
        await this.ensureDeadlineReconciled(localTopic, "local_rpc_action");
      }
      const response = await handleRpc(request, this.env, {
        body,
        localTopic,
        localBroadcast: (message) => {
          this.rememberRoomPlayerCount(message.topic, message.result);
          return this.broadcastChangeMessage(message);
        },
        localCacheGameResult: (snapshot) => this.cacheGameResultSnapshot(snapshot),
        localInvalidateRoundSnapshots: (gameSessionId) => this.invalidateRoundSnapshotCaches(gameSessionId),
        localScheduleAutoForfeit: async () => undefined,
        receivedAtMs,
        gameDatabase: undefined,
        mutationTracker: undefined,
        localAuthorityCommit: localRoomId
          ? async (name, result, clientActionId) => {
              void clientActionId;
              if (!shouldAdvanceRoomVersion(name, result)) return null;
              return this.runtime.bumpVersion(localRoomId);
            }
          : undefined,
      });
      if (response.ok && body.name === "startGameWithQuestionSet" && localTopic) {
        await this.ensureAuthority(localTopic, true);
      }
      return response;
    } catch (error) {
      this.logGameRpcError({ transport: "http", name: rpcName, args: rpcArgs, topic: localTopic, receivedAtMs, error });
      return errorResponse(error, request, this.env);
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.runtime.isRetiredGeneration()) {
      this.expireRetiredSocket(socket);
      return;
    }
    if (tryHandleRoomChatMessage({
      socket,
      message,
      sockets: this.state.getWebSockets(),
      rateLimiter: this.roomChatRateLimiter,
      resolveTeamAudience: (topic, playerId) => this.resolveRoomChatTeamAudience(topic, playerId),
    })) return;
    const receivedAtMs = Math.max(Date.now(), this.lastActionReceivedAtMs + 1);
    this.lastActionReceivedAtMs = receivedAtMs;
    this.sendActionAccepted(socket, message);
    if (await this.tryHandleWebSocketRoundSnapshotRead(socket, message)) return;
    if (await this.tryHandleWebSocketBootstrapSnapshotRead(socket, message)) return;
    if (await this.tryHandleWebSocketGameResultSnapshotRead(socket, message)) return;

    const task = this.actionQueue.then(
      () => this.handleWebSocketAction(socket, message, receivedAtMs),
      () => this.handleWebSocketAction(socket, message, receivedAtMs),
    );
    this.actionQueue = task.catch(() => undefined);
    await task;
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    if (this.runtime.isRetiredGeneration()) {
      try { socket.close(code, reason); } catch { /* The peer may already be closed. */ }
      return;
    }
    if (this.authorityVNext.hasStoredState()) {
      const receipt = await this.authorityVNext.handleSocketClose(socket);
      if (receipt) this.broadcastVNextDurableAck(receipt);
    }
    try { socket.close(code, reason); } catch { /* The peer may already be closed. */ }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    if (this.runtime.isRetiredGeneration()) {
      this.expireRetiredSocket(socket);
      return;
    }
    if (this.authorityVNext.hasStoredState()) {
      const receipt = await this.authorityVNext.handleSocketClose(socket);
      if (receipt) this.broadcastVNextDurableAck(receipt);
    }
    try { socket.close(1011, "实时连接异常。"); } catch { /* The peer may already be closed. */ }
  }

  private sendActionAccepted(socket: WebSocket, message: string | ArrayBuffer) {
    try {
      const payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as { type?: string; clientActionId?: string };
      if (payload.type === "action" && payload.clientActionId) {
        socket.send(JSON.stringify({ type: "action_accepted", clientActionId: payload.clientActionId }));
      }
    } catch {
      // The queued handler returns the normal invalid-message error.
    }
  }

  private enqueueConsistentRead<T>(read: () => Promise<T>) {
    const task = this.actionQueue.then(read, read);
    this.actionQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private getSpectatorProjection(playerId: string | undefined, gameSessionId: string) {
    const aggregate = this.authorityVNext.getAggregate();
    if (!playerId || !aggregate || aggregate.gameId !== gameSessionId) return null;
    const player = aggregate.players.find((candidate) => candidate.id === playerId);
    if (player?.role !== "SPECTATOR") return null;
    return {
      questionPreviewEnabled: aggregate.room?.spectatorQuestionPreviewEnabled !== false,
      playerAnswersEnabled: aggregate.room?.spectatorPlayerAnswersEnabled !== false,
    };
  }

  private projectRoundSnapshotForPlayer(snapshot: RoundSnapshot, playerId: string | undefined) {
    const projection = this.getSpectatorProjection(playerId, snapshot.gameSession.id);
    return projection ? projectSpectatorRoundSnapshot(snapshot, projection.playerAnswersEnabled) : snapshot;
  }

  private projectBootstrapSnapshotForPlayer(snapshot: GameBootstrapSnapshot, playerId: string | undefined) {
    const projection = this.getSpectatorProjection(playerId, snapshot.gameSession.id);
    return projection
      ? projectSpectatorBootstrapSnapshot(snapshot, projection.questionPreviewEnabled, projection.playerAnswersEnabled)
      : snapshot;
  }

  private tryHandleWebSocketFastPath(socket: WebSocket, message: string | ArrayBuffer) {
    let payload: {
      type?: string;
      name?: string;
      args?: unknown[];
      clientActionId?: string;
    };

    try {
      payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as typeof payload;
    } catch {
      return false;
    }

    const requestedSnapshotGameSessionId = payload.type === "action" && typeof payload.args?.[0] === "string" ? payload.args[0] : null;
    if (!requestedSnapshotGameSessionId || !payload.name) {
      return false;
    }

    const cachedSnapshot =
      payload.name === "getRoundSnapshot"
        ? this.getCachedRoundSnapshot(requestedSnapshotGameSessionId)
        : payload.name === "getGameBootstrapSnapshot"
          ? this.getCachedBootstrapSnapshot(requestedSnapshotGameSessionId)
          : payload.name === "getGameResultSnapshot"
            ? this.getCachedGameResultSnapshot(requestedSnapshotGameSessionId)
            : null;
    if (!cachedSnapshot) {
      return false;
    }

    const socketAttachment = socket.deserializeAttachment() as VNextSocketAttachment | undefined;
    console.info(
      JSON.stringify({
        event: "snapshot_cache_fast_hit",
        name: payload.name,
        gameSessionId: requestedSnapshotGameSessionId,
        topic: socketAttachment?.topic ?? null,
      }),
    );
    const projectedSnapshot = payload.name === "getRoundSnapshot"
      ? this.projectRoundSnapshotForPlayer(cachedSnapshot as RoundSnapshot, socketAttachment?.playerId)
      : payload.name === "getGameBootstrapSnapshot"
        ? this.projectBootstrapSnapshotForPlayer(cachedSnapshot as GameBootstrapSnapshot, socketAttachment?.playerId)
        : cachedSnapshot;
    socket.send(
      JSON.stringify({
        type: "action_result",
        clientActionId: payload.clientActionId,
        data: projectedSnapshot,
      }),
    );
    return true;
  }

  private async tryHandleWebSocketRoundSnapshotRead(socket: WebSocket, message: string | ArrayBuffer) {
    let payload: {
      type?: string;
      name?: string;
      args?: unknown[];
      clientActionId?: string;
    };

    try {
      payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as typeof payload;
    } catch {
      return false;
    }

    const gameSessionId =
      payload.type === "action" && payload.name === "getRoundSnapshot" && typeof payload.args?.[0] === "string"
        ? payload.args[0]
        : null;
    if (!gameSessionId) {
      return false;
    }

    await this.handleRoundSnapshotRead(socket, gameSessionId, payload.clientActionId);
    return true;
  }

  private async handleRoundSnapshotRead(socket: WebSocket, gameSessionId: string, clientActionId: string | undefined) {
    const receivedAtMs = Date.now();
    const precedingActions = this.actionQueue;
    let ownsInflightRead = false;
    try {
      await precedingActions;
      let snapshotPromise = this.roundSnapshotReadInflight.get(gameSessionId);
      if (!snapshotPromise) {
        ownsInflightRead = true;
        const cacheGeneration = this.getRoundSnapshotCacheGeneration(gameSessionId);
        snapshotPromise = this.enqueueConsistentRead(() => this.loadRoundSnapshotForRead(gameSessionId, cacheGeneration));
        this.roundSnapshotReadInflight.set(gameSessionId, snapshotPromise);
        void snapshotPromise.then(
          () => {
            if (this.roundSnapshotReadInflight.get(gameSessionId) === snapshotPromise) {
              this.roundSnapshotReadInflight.delete(gameSessionId);
            }
          },
          () => {
            if (this.roundSnapshotReadInflight.get(gameSessionId) === snapshotPromise) {
              this.roundSnapshotReadInflight.delete(gameSessionId);
            }
          },
        );
      }

      const snapshot = await snapshotPromise;
      const attachment = socket.deserializeAttachment() as VNextSocketAttachment | undefined;
      socket.send(JSON.stringify({
        type: "action_result",
        clientActionId,
        data: this.projectRoundSnapshotForPlayer(snapshot, attachment?.playerId),
      }));
    } catch (error) {
      if (ownsInflightRead) {
        const socketAttachment = socket.deserializeAttachment() as { topic?: string } | undefined;
        this.logGameRpcError({
          name: "getRoundSnapshot",
          args: [gameSessionId],
          topic: socketAttachment?.topic,
          clientActionId,
          receivedAtMs,
          error,
        });
      }
      socket.send(
        JSON.stringify({
          type: "action_result",
          clientActionId,
          error: toUserErrorMessage(error),
        }),
      );
    }
  }

  private async loadRoundSnapshotForRead(gameSessionId: string, cacheGeneration: number) {
    const cachedRoundSnapshot = this.getCachedRoundSnapshot(gameSessionId);
    if (cachedRoundSnapshot) {
      return cachedRoundSnapshot;
    }

    if (this.authorityVNext.hasGameState(gameSessionId)) {
      await this.restoreVNextAuthority();
      return this.authorityVNext.query("getRoundSnapshot", [gameSessionId]) as RoundSnapshot;
    }

    const snapshot = await runWithGameDatabase(this.env, () => gameService.getRoundSnapshot(gameSessionId));
    await this.cacheRoundSnapshot(snapshot, cacheGeneration);
    return snapshot;
  }

  private async tryHandleWebSocketBootstrapSnapshotRead(socket: WebSocket, message: string | ArrayBuffer) {
    let payload: {
      type?: string;
      name?: string;
      args?: unknown[];
      clientActionId?: string;
    };

    try {
      payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as typeof payload;
    } catch {
      return false;
    }

    const gameSessionId =
      payload.type === "action" && payload.name === "getGameBootstrapSnapshot" && typeof payload.args?.[0] === "string"
        ? payload.args[0]
        : null;
    if (!gameSessionId) {
      return false;
    }

    await this.handleBootstrapSnapshotRead(socket, gameSessionId, payload.clientActionId);
    return true;
  }

  private async handleBootstrapSnapshotRead(socket: WebSocket, gameSessionId: string, clientActionId: string | undefined) {
    const receivedAtMs = Date.now();
    const precedingActions = this.actionQueue;
    let ownsInflightRead = false;
    try {
      await precedingActions;
      let snapshotPromise = this.bootstrapSnapshotReadInflight.get(gameSessionId);
      if (!snapshotPromise) {
        ownsInflightRead = true;
        const cacheGeneration = this.getRoundSnapshotCacheGeneration(gameSessionId);
        snapshotPromise = this.enqueueConsistentRead(() => this.loadBootstrapSnapshotForRead(gameSessionId, cacheGeneration));
        this.bootstrapSnapshotReadInflight.set(gameSessionId, snapshotPromise);
        void snapshotPromise.then(
          () => {
            if (this.bootstrapSnapshotReadInflight.get(gameSessionId) === snapshotPromise) {
              this.bootstrapSnapshotReadInflight.delete(gameSessionId);
            }
          },
          () => {
            if (this.bootstrapSnapshotReadInflight.get(gameSessionId) === snapshotPromise) {
              this.bootstrapSnapshotReadInflight.delete(gameSessionId);
            }
          },
        );
      }

      const snapshot = await snapshotPromise;
      const attachment = socket.deserializeAttachment() as VNextSocketAttachment | undefined;
      socket.send(JSON.stringify({
        type: "action_result",
        clientActionId,
        data: this.projectBootstrapSnapshotForPlayer(snapshot, attachment?.playerId),
      }));
    } catch (error) {
      if (ownsInflightRead) {
        const socketAttachment = socket.deserializeAttachment() as { topic?: string } | undefined;
        this.logGameRpcError({
          name: "getGameBootstrapSnapshot",
          args: [gameSessionId],
          topic: socketAttachment?.topic,
          clientActionId,
          receivedAtMs,
          error,
        });
      }
      socket.send(JSON.stringify({ type: "action_result", clientActionId, error: toUserErrorMessage(error) }));
    }
  }

  private async loadBootstrapSnapshotForRead(gameSessionId: string, cacheGeneration: number) {
    const cachedSnapshot = this.getCachedBootstrapSnapshot(gameSessionId);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    if (this.authorityVNext.hasGameState(gameSessionId)) {
      await this.restoreVNextAuthority();
      return this.authorityVNext.query("getGameBootstrapSnapshot", [gameSessionId]) as GameBootstrapSnapshot;
    }

    const snapshot = await runWithGameDatabase(this.env, () => gameService.getGameBootstrapSnapshot(gameSessionId));
    await this.cacheBootstrapSnapshot(snapshot, cacheGeneration);
    return snapshot;
  }

  private async tryHandleWebSocketGameResultSnapshotRead(socket: WebSocket, message: string | ArrayBuffer) {
    let payload: {
      type?: string;
      name?: string;
      args?: unknown[];
      clientActionId?: string;
    };

    try {
      payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as typeof payload;
    } catch {
      return false;
    }

    const gameSessionId =
      payload.type === "action" && payload.name === "getGameResultSnapshot" && typeof payload.args?.[0] === "string"
        ? payload.args[0]
        : null;
    if (!gameSessionId) {
      return false;
    }

    await this.handleGameResultSnapshotRead(socket, gameSessionId, payload.clientActionId);
    return true;
  }

  private async handleGameResultSnapshotRead(socket: WebSocket, gameSessionId: string, clientActionId: string | undefined) {
    const receivedAtMs = Date.now();
    const precedingActions = this.actionQueue;
    let ownsInflightRead = false;
    try {
      await precedingActions;
      let snapshotPromise = this.gameResultSnapshotReadInflight.get(gameSessionId);
      if (!snapshotPromise) {
        ownsInflightRead = true;
        const cacheGeneration = this.getRoundSnapshotCacheGeneration(gameSessionId);
        snapshotPromise = this.enqueueConsistentRead(() => this.loadGameResultSnapshotForRead(gameSessionId, cacheGeneration));
        this.gameResultSnapshotReadInflight.set(gameSessionId, snapshotPromise);
        void snapshotPromise.then(
          () => {
            if (this.gameResultSnapshotReadInflight.get(gameSessionId) === snapshotPromise) {
              this.gameResultSnapshotReadInflight.delete(gameSessionId);
            }
          },
          () => {
            if (this.gameResultSnapshotReadInflight.get(gameSessionId) === snapshotPromise) {
              this.gameResultSnapshotReadInflight.delete(gameSessionId);
            }
          },
        );
      }

      const snapshot = await snapshotPromise;
      socket.send(JSON.stringify({ type: "action_result", clientActionId, data: snapshot }));
    } catch (error) {
      if (ownsInflightRead) {
        const socketAttachment = socket.deserializeAttachment() as { topic?: string } | undefined;
        this.logGameRpcError({
          name: "getGameResultSnapshot",
          args: [gameSessionId],
          topic: socketAttachment?.topic,
          clientActionId,
          receivedAtMs,
          error,
        });
      }
      socket.send(JSON.stringify({ type: "action_result", clientActionId, error: toUserErrorMessage(error) }));
    }
  }

  private async loadGameResultSnapshotForRead(gameSessionId: string, cacheGeneration: number) {
    const cachedSnapshot = this.getCachedGameResultSnapshot(gameSessionId);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    if (this.authorityVNext.hasGameState(gameSessionId)) {
      await this.restoreVNextAuthority();
      return this.authorityVNext.query("getGameResultSnapshot", [gameSessionId]) as GameResultSnapshot;
    }

    const archivedSnapshot = await runWithGameDatabase(this.env, () => gameService.getArchivedGameResultSnapshot(gameSessionId));
    if (archivedSnapshot) {
      await this.cacheGameResultSnapshot(archivedSnapshot, cacheGeneration);
      return archivedSnapshot;
    }

    const snapshot = await runWithGameDatabase(this.env, () => gameService.getGameResultSnapshot(gameSessionId));
    await this.cacheGameResultSnapshot(snapshot, cacheGeneration);
    return snapshot;
  }

  private async resumeInitializingVNextStart() {
    const initializing = this.authorityVNext.getInitializingStart();
    if (!initializing) return;
    const params = { ...initializing.startParams, authorityVersion: 2 };
    let result: unknown;
    try {
      result = await runWithGameDatabase(this.env, () => callGameFunction("startGameWithQuestionSet", [params], Date.now()));
    } catch (error) {
      if (this.abortRejectedVNextStart(error, initializing.gameId, "recovery")) return;
      throw error;
    }
    if (!isRecord(result)) throw new Error("authority vNext 开局恢复结果无效。");
    const hidden = isRecord(result.__authorityVNextBootstrap) ? result.__authorityVNextBootstrap : null;
    const gameSession = asGameSession(result.gameSession);
    const room = asRoom(result.room);
    if (!hidden || !gameSession || gameSession.id !== initializing.gameId || !room || !Array.isArray(hidden.players) || !Array.isArray(hidden.questions) || !isRecord(hidden.questionSet)) {
      throw new Error("authority vNext 开局恢复 bootstrap 不完整。");
    }
    const players = hidden.players as VNextStartBootstrap["players"];
    this.authorityVNext.activateStart({
      room: { ...room, players },
      players,
      questionSet: hidden.questionSet as VNextStartBootstrap["questionSet"],
      questions: hidden.questions as VNextStartBootstrap["questions"],
      questionSetManifestVersion: hidden.questionSetManifestVersion === 1 ? 1 : null,
      gameSession,
    });
    this.clearAllSnapshotCaches();
    await this.reconcileVNextAlarm();
  }

  private abortRejectedVNextStart(error: unknown, gameId: string, source: "request" | "recovery") {
    if (!(error instanceof gameService.StartGameRejectedError)) return false;
    const aborted = this.authorityVNext.abortInitializingStart(gameId);
    if (aborted) {
      console.info(JSON.stringify({
        event: "authority_vnext_initializing_start_aborted",
        authorityVersion: 2,
        gameId,
        reason: error.message,
        source,
      }));
    }
    return aborted;
  }

  private async tryHandleVNextAction(
    socket: WebSocket,
    payload: {
      type?: string;
      name?: string;
      args?: unknown[];
      clientActionId?: string;
      mutation?: VNextMutationEnvelope;
    },
    receivedAtMs: number,
  ) {
    if (!payload.name || payload.name === "startGameWithQuestionSet") return false;
    await this.resumeInitializingVNextStart();
    const queryGameId = getQueryGameSessionId(payload.name, payload.args);
    const argRecord = isRecord(payload.args?.[0]) ? payload.args?.[0] : null;
    const positional = getVNextPositionalMutation(payload.name, payload.args ?? []);
    const activeAggregate = this.authorityVNext.getAggregate();
    const isRoomStateAction = VNEXT_POSITIONAL_ROOM_MUTATIONS.has(payload.name) || ROOM_AUTHORITY_ROSTER_QUERY_NAMES.has(payload.name);
    if (isRoomStateAction && !shouldUseVNextRoomState(activeAggregate, this.authorityVNext.hasPendingRoomHandoff())) return false;
    const gameId = payload.mutation?.gameId ?? queryGameId ?? (typeof argRecord?.gameSessionId === "string" ? argRecord.gameSessionId : null)
      ?? (isRoomStateAction ? activeAggregate?.gameId ?? null : null);
    if (payload.mutation && this.authorityVNext.hasGameState() && !this.authorityVNext.hasGameState(payload.mutation.gameId)) {
      await this.restoreVNextAuthority();
      socket.send(JSON.stringify({ type: "action_result", clientActionId: payload.clientActionId, error: "该操作属于已结束的游戏，请刷新后重试。" }));
      return true;
    }
    if (
      !gameId ||
      !this.authorityVNext.hasGameState(gameId) ||
      (ROOM_AUTHORITY_ACTIVE_ONLY_NAMES.has(payload.name) && !this.authorityVNext.isRunningGame(gameId))
    ) return false;
    await this.restoreVNextAuthority();
    const mutationDeadlinePolicy = getMutationDeadlinePolicy(payload.name);
    if (mutationDeadlinePolicy == null) {
      const data = this.authorityVNext.query(payload.name, payload.args ?? []);
      socket.send(JSON.stringify({ type: "action_result", clientActionId: payload.clientActionId, data }));
      return true;
    }
    let mutation = payload.mutation;
    if (!mutation || mutation.name !== payload.name) {
      const attachment = (() => {
        try { return socket.deserializeAttachment() as VNextSocketAttachment | null; } catch { return null; }
      })();
      const aggregate = this.authorityVNext.getAggregate();
      const actorId = attachment?.playerId
        ?? positional?.actorId
        ?? (typeof argRecord?.playerId === "string" ? argRecord.playerId : undefined)
        ?? (typeof argRecord?.presenterPlayerId === "string" ? argRecord.presenterPlayerId : undefined)
        ?? (typeof argRecord?.hostPlayerId === "string" ? argRecord.hostPlayerId : undefined)
        ?? (typeof argRecord?.actorPlayerId === "string" ? argRecord.actorPlayerId : undefined);
      const mutationPayload = argRecord ?? positional?.payload;
      if (!aggregate?.gameSession || !actorId || !mutationPayload) {
        socket.send(JSON.stringify({ type: "action_result", clientActionId: payload.clientActionId, error: "当前游戏已启用 authority vNext，请刷新页面后重试。" }));
        return true;
      }
      const seen = aggregate.seenSeqByActor[actorId] ?? aggregate.committedSeqByActor[actorId] ?? 0;
      mutation = {
        actionId: payload.clientActionId || crypto.randomUUID(),
        actorId,
        clientSeq: seen + 1,
        gameId: aggregate.gameId,
        questionIndex: aggregate.gameSession.currentQuestionIndex,
        name: payload.name,
        payload: mutationPayload,
      };
    }
    await this.reconcileVNextQuestionSetBeforeGameResult(payload.name);
    const outcome = this.authorityVNext.handleMutation(socket, mutation, receivedAtMs);
    this.invalidateVNextSnapshotCaches(outcome);
    socket.send(JSON.stringify({
      type: "action_received",
      clientActionId: payload.clientActionId,
      actionId: mutation.actionId,
      provisional: outcome.provisional,
      orderToken: outcome.orderToken,
      data: outcome.data,
      error: outcome.error,
      terminal: outcome.terminal,
      duplicate: outcome.duplicate,
    }));
    const sendActionResult = () => socket.send(JSON.stringify({ type: "action_result", clientActionId: payload.clientActionId, data: outcome.data, error: outcome.error }));
    if (!outcome.provisional) {
      sendActionResult();
      if (outcome.duplicate) {
        const aggregate = this.authorityVNext.getAggregate();
        socket.send(JSON.stringify({ type: "checkpoint_committed", gameId: aggregate?.gameId, version: aggregate?.stateVersion ?? 0, committedSeqByActor: aggregate?.committedSeqByActor ?? {} }));
      }
      return true;
    }

    if (outcome.forceCheckpoint) {
      if (outcome.forceCheckpoint === "game-end") this.authorityVNext.prepareFinalResultsFromArchives();
      let receipt;
      try {
        receipt = await this.authorityVNext.forceCheckpoint(outcome.forceCheckpoint, outcome.archiveQuestion === true);
      } catch (error) {
        this.authorityVNext.resetAfterFailedTransition();
        throw error;
      }
      if (receipt) this.broadcastVNextDurableAck(receipt);
      await this.reconcileVNextAlarm();
      this.sendVNextOutcome(payload.name, outcome);
      sendActionResult();
      if (outcome.forceCheckpoint === "game-end" || outcome.forceCheckpoint === "projection") {
        this.state.waitUntil(this.authorityVNext.flushFinalProjection());
      }
      return true;
    }

    if (outcome.duplicate) {
      sendActionResult();
      const receipt = await this.authorityVNext.maybeCheckpoint();
      if (receipt) this.broadcastVNextDurableAck(receipt);
      return true;
    }

    this.sendVNextOutcome(payload.name, outcome);
    sendActionResult();
    if (outcome.deadlineChanged) await this.reconcileVNextAlarm();
    const receipt = await this.authorityVNext.maybeCheckpoint();
    if (receipt) this.broadcastVNextDurableAck(receipt);
    return true;
  }

  private async reconcileVNextQuestionSetBeforeGameResult(name: string) {
    if (name !== "advanceReviewedQuestion" && name !== "skipCurrentQuestion") return;
    const aggregate = this.authorityVNext.getAggregate();
    const gameSession = aggregate?.gameSession;
    if (
      !aggregate ||
      aggregate.cutoverState !== "active" ||
      !gameSession ||
      aggregate.questions.length === 0 ||
      gameSession.currentQuestionIndex < aggregate.questions.length - 1
    ) return;
    const questionSet = await runWithGameDatabase(this.env, () => gameService.getQuestionSetById(gameSession.questionSetId));
    if (questionSet) this.authorityVNext.syncQuestionSetMetadata(questionSet);
  }

  private sendVNextOutcome(name: string, outcome: VNextMutationOutcome) {
    if (outcome.publicDeltas.length) this.sendVNextPublicDeltas(name, outcome.publicDeltas);
    const aggregate = this.authorityVNext.getAggregate();
    const presenterId = aggregate?.gameSession?.presenterPlayerId;
    if (presenterId && outcome.presenterDeltas.length) this.sendVNextDeltas(name, outcome.presenterDeltas, new Set([presenterId]));
    if (outcome.answerViewerDeltas?.length) {
      const answerViewerIds = getVNextAnswerViewerIds(aggregate);
      if (answerViewerIds.size) this.sendVNextDeltas(name, outcome.answerViewerDeltas, answerViewerIds);
    }
    const privateDeltasByPlayer = new Map<string, RealtimeDelta[]>();
    for (const delivery of outcome.playerDeltas) {
      const deltas = privateDeltasByPlayer.get(delivery.playerId) ?? [];
      deltas.push(delivery.delta);
      privateDeltasByPlayer.set(delivery.playerId, deltas);
    }
    for (const delivery of outcome.playerBackfillDeltas ?? []) {
      const deltas = privateDeltasByPlayer.get(delivery.playerId) ?? [];
      deltas.push(...delivery.deltas);
      privateDeltasByPlayer.set(delivery.playerId, deltas);
    }
    for (const [playerId, deltas] of privateDeltasByPlayer) this.sendVNextDeltas(name, deltas, new Set([playerId]));
    this.sendRestrictedSpectatorReviewData(name, outcome);
  }

  private sendVNextPublicDeltas(name: string, deltas: RealtimeDelta[]) {
    const aggregate = this.authorityVNext.getAggregate();
    const session = aggregate?.gameSession;
    const restrictedSpectatorIds = new Set(
      !session || isQuestionReviewingSession(session)
        ? []
        : aggregate?.players
          .filter((player) => player.role === "SPECTATOR" && aggregate.room?.spectatorPlayerAnswersEnabled === false)
          .map((player) => player.id) ?? [],
    );
    const containsRoundSnapshot = deltas.some((delta) => delta.scope === "game" && delta.type === "round_snapshot");
    if (!containsRoundSnapshot || !restrictedSpectatorIds.size) {
      this.sendVNextDeltas(name, deltas, undefined, true);
      return;
    }

    this.sendVNextDeltas(name, deltas, undefined, true, restrictedSpectatorIds);
    const playerId = restrictedSpectatorIds.values().next().value as string | undefined;
    const projectedDeltas = deltas.map((delta) => delta.scope === "game" && delta.type === "round_snapshot"
      ? { ...delta, snapshot: this.projectRoundSnapshotForPlayer(delta.snapshot, playerId) }
      : delta);
    this.sendVNextDeltas(name, projectedDeltas, restrictedSpectatorIds, true);
  }

  private sendRestrictedSpectatorReviewData(name: string, outcome: VNextMutationOutcome) {
    if (outcome.forceCheckpoint !== "phase-boundary") return;
    const aggregate = this.authorityVNext.getAggregate();
    const session = aggregate?.gameSession;
    const room = aggregate?.room;
    if (!aggregate || !session || !room || !isQuestionReviewingSession(session)) return;

    const restrictedQuestionViewerIds = new Set(
      aggregate.players
        .filter((player) => player.role === "SPECTATOR" && room.spectatorQuestionPreviewEnabled === false)
        .map((player) => player.id),
    );
    const question = aggregate.questions[session.currentQuestionIndex];
    if (question && restrictedQuestionViewerIds.size) {
      this.sendVNextDeltas(name, [{ scope: "game", type: "question_label_updated", question }], restrictedQuestionViewerIds);
    }

    const restrictedAnswerViewerIds = new Set(
      aggregate.players
        .filter((player) => player.role === "SPECTATOR" && room.spectatorPlayerAnswersEnabled === false)
        .map((player) => player.id),
    );
    if (restrictedAnswerViewerIds.size) {
      const deltas = this.authorityVNext.getCurrentAnswerTextBackfillDeltas();
      if (deltas.length) this.sendVNextDeltas(name, deltas, restrictedAnswerViewerIds);
    }
  }

  private invalidateVNextSnapshotCaches(outcome: VNextMutationOutcome) {
    if (!outcome.provisional || outcome.duplicate) return;
    const gameId = this.authorityVNext.getAggregate()?.gameId;
    if (gameId) this.clearGameSessionSnapshotCaches(gameId);
  }

  private sendVNextDelta(name: string, delta: RealtimeDelta, recipients?: Set<string>, publicStream = false) {
    this.sendVNextDeltas(name, [delta], recipients, publicStream);
  }

  private sendVNextDeltas(
    name: string,
    deltas: RealtimeDelta[],
    recipients?: Set<string>,
    publicStream = false,
    excludedRecipients?: Set<string>,
  ) {
    const aggregate = this.authorityVNext.getAggregate();
    const payload = JSON.stringify({
      type: "change",
      name,
      topic: this.authorityTopic,
      authorityVersion: 2,
      ...(publicStream ? { version: aggregate?.publicStateVersion ?? 0 } : {}),
      deltas,
    });
    let sent = 0;
    for (const target of this.state.getWebSockets()) {
      if (recipients || excludedRecipients) {
        let playerId: string | undefined;
        try { playerId = (target.deserializeAttachment() as VNextSocketAttachment | null)?.playerId; } catch { playerId = undefined; }
        if (recipients && (!playerId || !recipients.has(playerId))) continue;
        if (playerId && excludedRecipients?.has(playerId)) continue;
      }
      try { target.send(payload); sent += 1; } catch { target.close(1011, "实时推送失败。"); }
    }
    this.authorityVNext.recordBroadcast(payload.length, sent);
  }

  private broadcastVNextDurableAck(receipt: { version: number; committedSeqByActor: Record<string, number> }) {
    const payload = JSON.stringify({
      type: "checkpoint_committed",
      gameId: this.authorityVNext.getAggregate()?.gameId,
      version: receipt.version,
      committedSeqByActor: receipt.committedSeqByActor,
    });
    let sent = 0;
    for (const socket of this.state.getWebSockets()) {
      try { socket.send(payload); sent += 1; } catch { socket.close(1011, "持久化确认推送失败。"); }
    }
    this.authorityVNext.recordBroadcast(payload.length, sent);
  }

  private broadcastVNextCutover() {
    const aggregate = this.authorityVNext.getAggregate();
    this.broadcast(JSON.stringify({
      type: "change",
      name: "authorityCutover",
      topic: this.authorityTopic,
      authorityVersion: 2,
      version: aggregate?.publicStateVersion ?? 0,
      gameId: aggregate?.gameId,
      committedSeqByActor: aggregate?.committedSeqByActor ?? {},
      deltas: [],
    }));
  }

  private async reconcileVNextAlarm() {
    this.authorityVNext.markDeadlineRepairPending();
    const deadline = this.authorityVNext.getDeadline();
    const current = await this.state.storage.getAlarm();
    if (!deadline) {
      if (current != null) await this.state.storage.deleteAlarm();
      this.authorityVNext.recordAlarmScheduled(current != null);
      this.authorityVNext.acknowledgeDeadlineRepair();
      return;
    }
    const scheduledAt = Math.max(deadline.runAtMs, Date.now() + BUSINESS_ALARM_MIN_SCHEDULE_DELAY_MS);
    if (current === scheduledAt) {
      this.authorityVNext.recordAlarmScheduled(false);
      this.authorityVNext.acknowledgeDeadlineRepair();
      return;
    }
    await this.state.storage.setAlarm(scheduledAt);
    this.authorityVNext.recordAlarmScheduled(true);
    this.authorityVNext.acknowledgeDeadlineRepair();
  }

  private async handleWebSocketAction(socket: WebSocket, message: string | ArrayBuffer, receivedAtMs = Date.now()): Promise<void> {
    const socketAttachment = socket.deserializeAttachment() as { topic?: string } | undefined;
    let clientActionId: string | undefined;
    let actionName: string | undefined;
    const actionTopic = socketAttachment?.topic;
    let actionArgs: unknown[] = [];
    let actionLogContext: GameRpcErrorLogContext = {};
    try {
      const payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as {
        type?: string;
        name?: string;
        args?: unknown[];
        clientActionId?: string;
        mutation?: VNextMutationEnvelope;
      };
      clientActionId = payload.clientActionId;
      actionName = payload.name;
      actionArgs = payload.args ?? [];

      if (payload.type !== "action" || !payload.name) {
        socket.send(JSON.stringify({ type: "error", error: "无效的实时操作请求。" }));
        return;
      }

      if (await this.tryHandleVNextAction(socket, payload, receivedAtMs)) return;

      await this.flushPendingRoomHandoffForLobbyMutation(payload.name);

      if (payload.name === "startGameWithQuestionSet" && isRecord(payload.args?.[0])) {
        payload.args = [{ ...payload.args[0], authorityVersion: 2 }];
        actionArgs = payload.args;
      }

      const mutationDeadlinePolicy = getMutationDeadlinePolicy(payload.name);
      const isMutation = mutationDeadlinePolicy != null;
      actionLogContext = this.getGameRpcErrorLogContext(payload.name, actionArgs, actionTopic);
      logRpcInvocation({ transport: "websocket", name: payload.name, isMutation, localTopic: socketAttachment?.topic });

      if (isMutation && actionTopic) {
        if (AUTHORITY_JOURNALED_NAMES.has(payload.name)) {
          await this.ensureAuthority(actionTopic);
        }
        await this.ensureDeadlineReconciled(actionTopic, "websocket_action");
      }

      const actionKey = isMutation && payload.clientActionId ? `${payload.name}:${payload.clientActionId}` : "";
      const cached = actionKey ? this.getCachedRecentAction(actionKey) : null;
      if (cached) {
        socket.send(JSON.stringify({ type: "action_result", clientActionId: payload.clientActionId, data: cached.result }));
        return;
      }

      const requestedSnapshotGameSessionId =
        payload.name === "getRoundSnapshot" && typeof payload.args?.[0] === "string" ? payload.args[0] : null;
      if (requestedSnapshotGameSessionId) {
        const cachedRoundSnapshot = this.getCachedRoundSnapshot(requestedSnapshotGameSessionId);
        if (cachedRoundSnapshot) {
          console.info(
            JSON.stringify({
              event: "round_snapshot_cache_hit",
              gameSessionId: requestedSnapshotGameSessionId,
              topic: socketAttachment?.topic ?? null,
            }),
          );
          socket.send(
            JSON.stringify({
              type: "action_result",
              clientActionId: payload.clientActionId,
              data: cachedRoundSnapshot,
            }),
          );
          return;
        }
      }

      const executeAction = async () => {
        const result = await callGameFunction(payload.name ?? "", payload.args ?? [], receivedAtMs);
        actionLogContext = this.enrichGameRpcErrorLogContext(actionLogContext, result, null, actionTopic);
        const nextRoundSnapshot = await getRoundSnapshotForMutation(payload.name ?? "", result);
        actionLogContext = this.enrichGameRpcErrorLogContext(actionLogContext, result, nextRoundSnapshot, actionTopic);
        const nextGameResultSnapshot = await getGameResultSnapshotForMutation(payload.name ?? "", result);
        const nextResponseResult = attachRoundSnapshot(result, nextRoundSnapshot);
        const nextTopic = isMutation
          ? await getRoomTopicForBroadcast(payload.name ?? "", payload.args ?? [], nextResponseResult)
          : null;
        const nextDeltas =
          isMutation && nextTopic
            ? buildRealtimeDeltas(payload.name ?? "", payload.args ?? [], nextResponseResult, nextRoundSnapshot, nextGameResultSnapshot)
            : [];

        return {
          deltas: nextDeltas,
          gameResultSnapshot: nextGameResultSnapshot,
          roundSnapshot: nextRoundSnapshot,
          responseResult: nextResponseResult,
          topic: nextTopic,
        };
      };
      const roomId = getRoomIdFromTopic(actionTopic);
      if (payload.name === "startGameWithQuestionSet" && roomId && isRecord(payload.args?.[0])) {
        const gameId = typeof payload.args[0].startRequestId === "string" ? payload.args[0].startRequestId : null;
        if (!gameId) throw new Error("authority vNext 开局请求缺少 startRequestId。");
        if (this.authorityVNext.hasPendingFinalProjection()) {
          const flushed = await this.authorityVNext.flushFinalProjection();
          if (!flushed && !this.authorityVNext.canStartAnotherGame()) throw new Error("上一局长期结果队列接近容量上限，请稍后再开始新游戏。");
        }
        this.authorityVNext.beginStart(roomId, gameId, payload.args[0]);
      }
      let execution: Awaited<ReturnType<typeof executeAction>>;
      try {
        execution = await runWithGameDatabase(this.env, executeAction);
      } catch (error) {
        if (payload.name === "startGameWithQuestionSet" && isRecord(payload.args?.[0])) {
          const gameId = typeof payload.args[0].startRequestId === "string" ? payload.args[0].startRequestId : null;
          if (gameId) this.abortRejectedVNextStart(error, gameId, "request");
        }
        throw error;
      }
      const { deltas, gameResultSnapshot, roundSnapshot, topic } = execution;
      let { responseResult } = execution;
      if (payload.name === "startGameWithQuestionSet" && isRecord(responseResult)) {
        const hidden = isRecord(responseResult.__authorityVNextBootstrap) ? responseResult.__authorityVNextBootstrap : null;
        const gameSession = asGameSession(responseResult.gameSession);
        const room = asRoom(responseResult.room);
        if (!hidden || !gameSession || !room || !Array.isArray(hidden.players) || !Array.isArray(hidden.questions) || !isRecord(hidden.questionSet)) {
          throw new Error("authority vNext 开局 bootstrap 不完整。");
        }
        const players = hidden.players as VNextStartBootstrap["players"];
        this.authorityVNext.activateStart({
          room: { ...room, players },
          players,
          questionSet: hidden.questionSet as VNextStartBootstrap["questionSet"],
          questions: hidden.questions as VNextStartBootstrap["questions"],
          questionSetManifestVersion: hidden.questionSetManifestVersion === 1 ? 1 : null,
          gameSession,
        });
        this.clearAllSnapshotCaches();
        const { __authorityVNextBootstrap: _hidden, ...publicResult } = responseResult;
        responseResult = publicResult;
        await this.reconcileVNextAlarm();
        this.broadcastVNextCutover();
      }
      let authorityVersion: AuthorityVersion | null = null;
      if (isMutation && roomId && shouldAdvanceRoomVersion(payload.name ?? "", responseResult)) {
        if (payload.name === "startGameWithQuestionSet") {
          authorityVersion = { epoch: "vnext", stateVersion: this.authorityVNext.getAggregate()?.stateVersion ?? 0 };
        } else {
          authorityVersion = this.runtime.bumpVersion(roomId);
        }
      }
      actionLogContext = this.enrichGameRpcErrorLogContext(
        actionLogContext,
        responseResult,
        roundSnapshot,
        topic ?? actionTopic,
      );
      let postCommitError: unknown = null;
      this.invalidateRoundSnapshotCachesForMutation(payload.name ?? "", responseResult, payload.args ?? []);
      if (gameResultSnapshot) {
        try {
          await this.cacheGameResultSnapshot(gameResultSnapshot);
        } catch (error) {
          postCommitError ??= error;
        }
      }
      if (actionKey) {
        this.cacheRecentAction(actionKey, responseResult);
      }

      if (isMutation) {
        if (topic && deltas.length > 0) {
          const changeMessage = {
            type: "change",
            name: payload.name,
            result: stripRoundSnapshotFromBroadcastResult(responseResult),
            args: payload.args ?? [],
            topic,
            clientActionId: payload.clientActionId,
            delta: deltas[0],
            deltas,
            version: authorityVersion?.stateVersion,
          } satisfies BroadcastMessage;
          try {
            if (socketAttachment?.topic === topic) {
              await this.broadcastChangeMessage(changeMessage);
            } else {
              await broadcast(this.env, changeMessage);
            }
          } catch (error) {
            postCommitError ??= error;
          }
        }
      }

      if (postCommitError) {
        throw postCommitError instanceof DeadlineTransitionApplyError ? postCommitError : new DeadlineTransitionApplyError();
      }

      socket.send(JSON.stringify({ type: "action_result", clientActionId: payload.clientActionId, data: responseResult, authority: authorityVersion }));
    } catch (error) {
      this.logGameRpcError({
        name: actionName,
        args: actionArgs,
        topic: actionTopic,
        clientActionId,
        receivedAtMs,
        context: actionLogContext,
        error,
      });
      socket.send(
        JSON.stringify({
          type: "action_result",
          clientActionId,
          error: toUserErrorMessage(error),
          ...(error instanceof DeadlineTransitionApplyError
            ? {
                errorCode: error.code,
                recoveryRequired: true,
                stateMayHaveCommitted: true,
              }
            : {}),
        }),
      );
    }
  }

  async alarm(alarmInfo?: { retryCount: number; isRetry: boolean }): Promise<void> {
    const task = this.actionQueue.then(
      () => this.handleAlarm(alarmInfo),
      () => this.handleAlarm(alarmInfo),
    );
    this.actionQueue = task.catch(() => undefined);
    await task;
  }

  private async handleAlarm(alarmInfo?: { retryCount: number; isRetry: boolean }) {
    if (this.runtime.isRetiredGeneration()) {
      await this.retireOldGeneration();
      return;
    }
    if (this.authorityVNext.hasStoredState()) {
      try {
        await this.restoreVNextAuthority({ reconcileAlarm: false });
        this.authorityVNext.markAlarmMetric(alarmInfo ?? {});
        if (this.authorityVNext.getCutoverState() === "active") {
          const executed = await this.authorityVNext.executeDueDeadline(Date.now());
          if (executed?.outcome) this.invalidateVNextSnapshotCaches(executed.outcome);
          if (executed?.receipt) this.broadcastVNextDurableAck(executed.receipt);
          if (executed?.outcome) this.sendVNextOutcome(executed.outcome.forceCheckpoint ?? "deadline", executed.outcome);
        }
        await this.reconcileVNextAlarm();
        return;
      } catch (error) {
        this.authorityVNext.resetAfterFailedTransition();
        const permanent = /no such (table|column)|schema|不兼容/i.test(error instanceof Error ? error.message : String(error));
        const retryCount = alarmInfo?.retryCount ?? 0;
        console.error(JSON.stringify({ event: "authority_vnext_alarm_failed", authorityVersion: 2, retryCount, permanent, ...getErrorLogDetails(error) }));
        if (!permanent && retryCount < 5) throw error;
        return;
      }
    }
    try {
      await this.state.storage.deleteAlarm();
    } catch (error) {
      logAuxiliaryFailure("room_runtime_v3_orphan_alarm_cleanup_failed", error);
    }
  }

  private trimOldestEntries<K, V>(cache: Map<K, V>, maxEntries: number) {
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value as K | undefined;
      if (oldestKey === undefined) {
        return;
      }
      cache.delete(oldestKey);
    }
  }

  private cleanupRecentActions(now = Date.now(), force = false) {
    if (
      !force &&
      now - this.lastRecentActionCacheSweepAt < CACHE_SWEEP_INTERVAL_MS &&
      this.recentActions.size < RECENT_ACTION_CACHE_MAX_ENTRIES
    ) {
      return;
    }

    this.lastRecentActionCacheSweepAt = now;
    for (const [key, entry] of this.recentActions.entries()) {
      if (entry.expiresAt <= now) {
        this.recentActions.delete(key);
      }
    }
    this.trimOldestEntries(this.recentActions, RECENT_ACTION_CACHE_MAX_ENTRIES);
  }

  private getCachedRecentAction(key: string) {
    const cached = this.recentActions.get(key);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now()) {
      this.recentActions.delete(key);
      return null;
    }
    return cached;
  }

  private cacheRecentAction(key: string, result: unknown) {
    const now = Date.now();
    this.cleanupRecentActions(now);
    this.recentActions.delete(key);
    this.recentActions.set(key, { expiresAt: now + ACTION_RESULT_TTL_MS, result });
    this.trimOldestEntries(this.recentActions, RECENT_ACTION_CACHE_MAX_ENTRIES);
  }

  private cleanupRoundSnapshotCache(now = Date.now(), force = false) {
    if (
      !force &&
      now - this.lastSnapshotCacheSweepAt < CACHE_SWEEP_INTERVAL_MS &&
      this.roundSnapshotCache.size < ROUND_SNAPSHOT_CACHE_MAX_ENTRIES &&
      this.bootstrapSnapshotCache.size < BOOTSTRAP_SNAPSHOT_CACHE_MAX_ENTRIES &&
      this.gameResultSnapshotCache.size < GAME_RESULT_SNAPSHOT_CACHE_MAX_ENTRIES
    ) {
      return;
    }

    this.lastSnapshotCacheSweepAt = now;
    for (const [key, entry] of this.roundSnapshotCache.entries()) {
      if (entry.expiresAt <= now) {
        this.roundSnapshotCache.delete(key);
      }
    }
    for (const [key, entry] of this.bootstrapSnapshotCache.entries()) {
      if (entry.expiresAt <= now) {
        this.bootstrapSnapshotCache.delete(key);
      }
    }
    for (const [key, entry] of this.gameResultSnapshotCache.entries()) {
      if (entry.expiresAt <= now) {
        this.gameResultSnapshotCache.delete(key);
      }
    }
    this.trimOldestEntries(this.roundSnapshotCache, ROUND_SNAPSHOT_CACHE_MAX_ENTRIES);
    this.trimOldestEntries(this.bootstrapSnapshotCache, BOOTSTRAP_SNAPSHOT_CACHE_MAX_ENTRIES);
    this.trimOldestEntries(this.gameResultSnapshotCache, GAME_RESULT_SNAPSHOT_CACHE_MAX_ENTRIES);
  }

  private invalidateRoundSnapshotCachesForMutation(name: string, result: unknown, args: unknown[] = []) {
    const gameSession = getResultGameSession(result);
    const room = getResultRoom(result);
    if (name === "dissolveRoom" || (name === "leaveRoom" && !room)) {
      this.clearAllSnapshotCaches();
      return;
    }
    if (gameSession && gameSession.status !== "PLAYING") {
      this.clearGameSessionSnapshotCaches(gameSession.id);
    }
    if (room && room.status !== "PLAYING" && !room.currentGameId) {
      this.clearAllSnapshotCaches();
      return;
    }

    const gameSessionId = getDeltaOnlyRoundCacheInvalidationGameSessionId(name, result, args);
    if (!gameSessionId) {
      return;
    }

    this.invalidateRoundSnapshotCaches(gameSessionId);
  }

  private getRoundSnapshotCacheGeneration(gameSessionId: string) {
    return this.roundSnapshotCacheEpoch * 1_000_000 + (this.roundSnapshotCacheGeneration.get(gameSessionId) ?? 0);
  }

  private isRoundSnapshotCacheGenerationCurrent(gameSessionId: string, generation: number | undefined) {
    return generation == null || this.getRoundSnapshotCacheGeneration(gameSessionId) === generation;
  }

  private invalidateRoundSnapshotCaches(gameSessionId: string) {
    this.roundSnapshotCacheGeneration.set(gameSessionId, (this.roundSnapshotCacheGeneration.get(gameSessionId) ?? 0) + 1);
    this.roundSnapshotCache.delete(gameSessionId);
    this.bootstrapSnapshotCache.delete(gameSessionId);
    this.roundSnapshotReadInflight.delete(gameSessionId);
    this.bootstrapSnapshotReadInflight.delete(gameSessionId);
  }

  private clearGameSessionSnapshotCaches(gameSessionId: string) {
    this.roundSnapshotCacheEpoch += 1;
    this.roundSnapshotCacheGeneration.delete(gameSessionId);
    this.roundSnapshotCache.delete(gameSessionId);
    this.bootstrapSnapshotCache.delete(gameSessionId);
    this.gameResultSnapshotCache.delete(gameSessionId);
    this.roundSnapshotReadInflight.delete(gameSessionId);
    this.bootstrapSnapshotReadInflight.delete(gameSessionId);
    this.gameResultSnapshotReadInflight.delete(gameSessionId);
  }

  private clearAllSnapshotCaches() {
    this.roundSnapshotCacheEpoch += 1;
    this.roundSnapshotCacheGeneration.clear();
    this.roundSnapshotCache.clear();
    this.bootstrapSnapshotCache.clear();
    this.gameResultSnapshotCache.clear();
    this.roundSnapshotReadInflight.clear();
    this.bootstrapSnapshotReadInflight.clear();
    this.gameResultSnapshotReadInflight.clear();
  }

  private getCachedRoundSnapshot(gameSessionId: string) {
    const cached = this.roundSnapshotCache.get(gameSessionId);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.roundSnapshotCache.delete(gameSessionId);
      return null;
    }

    return cached.snapshot;
  }

  private async cacheRoundSnapshot(snapshot: RoundSnapshot, cacheGeneration?: number) {
    if (!this.isRoundSnapshotCacheGenerationCurrent(snapshot.gameSession.id, cacheGeneration)) {
      return;
    }

    const now = Date.now();
    this.cleanupRoundSnapshotCache(now);
    if (!this.isRoundSnapshotCacheGenerationCurrent(snapshot.gameSession.id, cacheGeneration)) {
      return;
    }

    const current = this.roundSnapshotCache.get(snapshot.gameSession.id);
    if (current && current.expiresAt > now && isStaleRoundSnapshot(snapshot, current.snapshot)) {
      console.info(
        JSON.stringify({
          event: "round_snapshot_cache_stale_ignored",
          gameSessionId: snapshot.gameSession.id,
          questionIndex: snapshot.gameSession.currentQuestionIndex,
          revealRound: snapshot.gameSession.currentRevealRound,
          cachedQuestionIndex: current.snapshot.gameSession.currentQuestionIndex,
          cachedRevealRound: current.snapshot.gameSession.currentRevealRound,
        }),
      );
      return;
    }

    const expiresAt = now + ROUND_SNAPSHOT_CACHE_TTL_MS;
    this.bootstrapSnapshotCache.delete(snapshot.gameSession.id);
    this.roundSnapshotCache.delete(snapshot.gameSession.id);
    this.roundSnapshotCache.set(snapshot.gameSession.id, { expiresAt, snapshot });
    this.trimOldestEntries(this.roundSnapshotCache, ROUND_SNAPSHOT_CACHE_MAX_ENTRIES);
  }

  private getCachedBootstrapSnapshot(gameSessionId: string) {
    const cached = this.bootstrapSnapshotCache.get(gameSessionId);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.bootstrapSnapshotCache.delete(gameSessionId);
      return null;
    }

    return cached.snapshot;
  }

  private async cacheBootstrapSnapshot(snapshot: GameBootstrapSnapshot, cacheGeneration?: number) {
    if (!this.isRoundSnapshotCacheGenerationCurrent(snapshot.gameSession.id, cacheGeneration)) {
      return;
    }

    const now = Date.now();
    this.cleanupRoundSnapshotCache(now);
    await this.cacheRoundSnapshot(snapshot.roundSnapshot, cacheGeneration);
    if (!this.isRoundSnapshotCacheGenerationCurrent(snapshot.gameSession.id, cacheGeneration)) {
      return;
    }

    const expiresAt = now + BOOTSTRAP_SNAPSHOT_CACHE_TTL_MS;
    this.bootstrapSnapshotCache.delete(snapshot.gameSession.id);
    this.bootstrapSnapshotCache.set(snapshot.gameSession.id, { expiresAt, snapshot });
    this.trimOldestEntries(this.bootstrapSnapshotCache, BOOTSTRAP_SNAPSHOT_CACHE_MAX_ENTRIES);
  }

  private getCachedGameResultSnapshot(gameSessionId: string) {
    const cached = this.gameResultSnapshotCache.get(gameSessionId);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.gameResultSnapshotCache.delete(gameSessionId);
      return null;
    }

    return cached.snapshot;
  }

  private async cacheGameResultSnapshot(snapshot: GameResultSnapshot, cacheGeneration?: number) {
    if (!this.isRoundSnapshotCacheGenerationCurrent(snapshot.gameSession.id, cacheGeneration)) {
      return;
    }
    const now = Date.now();
    this.cleanupRoundSnapshotCache(now);
    if (!this.isRoundSnapshotCacheGenerationCurrent(snapshot.gameSession.id, cacheGeneration)) {
      return;
    }
    const expiresAt = now + GAME_RESULT_SNAPSHOT_CACHE_TTL_MS;
    this.gameResultSnapshotCache.delete(snapshot.gameSession.id);
    this.gameResultSnapshotCache.set(snapshot.gameSession.id, { expiresAt, snapshot });
    this.trimOldestEntries(this.gameResultSnapshotCache, GAME_RESULT_SNAPSHOT_CACHE_MAX_ENTRIES);
  }

  private async getAutoForfeitAlarmState() {
    return await this.state.storage.get<AutoForfeitAlarmState>(AUTO_FORFEIT_ALARM_STORAGE_KEY);
  }

  private async getTeamBattleVoteAlarmState() {
    return await this.state.storage.get<TeamBattleVoteAlarmState>(TEAM_BATTLE_VOTE_ALARM_STORAGE_KEY);
  }

  private async getBusinessAlarmStates() {
    const [autoForfeit, teamBattleVote] = await Promise.all([
      this.getAutoForfeitAlarmState(),
      this.getTeamBattleVoteAlarmState(),
    ]);
    return { autoForfeit, teamBattleVote };
  }

  private async reconcileBusinessAlarm(reason: string, alarmAlreadyConsumed = false) {
    const { autoForfeit, teamBattleVote } = await this.getBusinessAlarmStates();
    const nextRunAt = [
      autoForfeit?.runAtMs,
      teamBattleVote?.runAtMs,
      this.authority.getNextProjectionAt() ?? undefined,
      this.authority.getNextCleanupAt() ?? undefined,
    ]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .sort((left, right) => left - right)[0] ?? null;
    const currentAlarm = alarmAlreadyConsumed ? null : await this.state.storage.getAlarm();
    const scheduledRunAt = nextRunAt == null
      ? null
      : Math.max(nextRunAt, Date.now() + BUSINESS_ALARM_MIN_SCHEDULE_DELAY_MS);
    let changed = false;

    if (scheduledRunAt == null) {
      if (!alarmAlreadyConsumed && currentAlarm != null) {
        await this.state.storage.deleteAlarm();
        changed = true;
      }
    } else if (currentAlarm !== scheduledRunAt) {
      const currentStillRepresentsBusinessTask =
        currentAlarm != null &&
        currentAlarm < nextRunAt &&
        (autoForfeit?.runAtMs === currentAlarm || teamBattleVote?.runAtMs === currentAlarm);
      if (!currentStillRepresentsBusinessTask) {
        await this.state.storage.setAlarm(scheduledRunAt);
        changed = true;
      }
    }

    console.info(
      JSON.stringify({
        event: "business_alarm_reconciled",
        reason,
        oldRunAt: currentAlarm,
        newRunAt: nextRunAt,
        changed,
      }),
    );
  }

  private async applyMutationDeadlineTransitions(params: {
    mutationName: MutationName;
    result: unknown;
    roundSnapshot: RoundSnapshot | null;
    topic: string | null;
    source: string;
    stateMayHaveCommitted: boolean;
    reconcileAlarm?: boolean;
  }) {
    if (MUTATION_REGISTRY[params.mutationName].deadline === "none") {
      return;
    }

    try {
      if (this.deadlineReconcilePromise) {
        await this.deadlineReconcilePromise;
      }
      const current = await this.getBusinessAlarmStates();
      const executionResult = resolveDeadlineTransitions({
        mutationName: params.mutationName,
        data: params.result,
        roundSnapshot: params.roundSnapshot,
        topic: params.topic,
        currentAutoForfeit: current.autoForfeit,
        currentTeamBattleVote: current.teamBattleVote,
      });
      await this.applyDeadlineTransitions(executionResult.deadlineTransitions);
      if (params.reconcileAlarm !== false) {
        await this.reconcileBusinessAlarm(params.source);
      }
      if (params.roundSnapshot) {
        await this.cacheRoundSnapshot(params.roundSnapshot);
      }
      this.deadlineReconcileRequired = false;
      this.deadlineReconciledTopic = params.topic;
    } catch (error) {
      this.deadlineReconcileRequired = true;
      console.error(
        JSON.stringify({
          event: "deadline_transition_failed",
          kind: "mutation",
          mutationName: params.mutationName,
          source: params.source,
          topic: sanitizeLogString(params.topic, RPC_LOG_ID_MAX_LENGTH),
          stateMayHaveCommitted: params.stateMayHaveCommitted,
          ...getErrorLogDetails(error),
        }),
      );
      throw new DeadlineTransitionApplyError();
    }
  }

  private async applyDeadlineTransitions(transitions: DeadlineTransition[]) {
    for (const transition of transitions) {
      if (transition.type === "noop") {
        continue;
      }

      if (transition.type === "clear") {
        const storageKey = transition.kind === "auto-forfeit"
          ? AUTO_FORFEIT_ALARM_STORAGE_KEY
          : TEAM_BATTLE_VOTE_ALARM_STORAGE_KEY;
        const current = transition.kind === "auto-forfeit"
          ? await this.getAutoForfeitAlarmState()
          : await this.getTeamBattleVoteAlarmState();
        if (
          current?.key !== transition.expectedKey ||
          current.gameSessionId !== transition.gameSessionId ||
          current.topic !== transition.topic
        ) {
          continue;
        }
        await this.state.storage.delete(storageKey);
        console.info(
          JSON.stringify({
            event: "deadline_transition_applied",
            kind: transition.kind,
            transition: "clear",
            gameSessionId: transition.gameSessionId,
            key: transition.expectedKey,
          }),
        );
        continue;
      }

      const storageKey = transition.kind === "auto-forfeit"
        ? AUTO_FORFEIT_ALARM_STORAGE_KEY
        : TEAM_BATTLE_VOTE_ALARM_STORAGE_KEY;
      const completedStorageKey = transition.kind === "auto-forfeit"
        ? AUTO_FORFEIT_COMPLETED_KEY_STORAGE_KEY
        : TEAM_BATTLE_VOTE_COMPLETED_KEY_STORAGE_KEY;
      const current = transition.kind === "auto-forfeit"
        ? await this.getAutoForfeitAlarmState()
        : await this.getTeamBattleVoteAlarmState();
      const completedKey = await this.state.storage.get<string>(completedStorageKey);
      if (completedKey === transition.state.key) {
        if (current?.key === transition.state.key) {
          await this.state.storage.delete(storageKey);
        }
        continue;
      }
      const stale = transition.kind === "auto-forfeit"
        ? isStaleAutoForfeitTransition(transition.state, current as AutoForfeitAlarmState | undefined)
        : isStaleTeamBattleVoteTransition(transition.state, current as TeamBattleVoteAlarmState | undefined);
      if (stale) {
        continue;
      }
      if (
        current?.key === transition.state.key &&
        current.topic === transition.state.topic
      ) {
        continue;
      }
      await this.state.storage.put(storageKey, transition.state);
      console.info(
        JSON.stringify({
          event: "deadline_transition_applied",
          kind: transition.kind,
          transition: "upsert",
          gameSessionId: transition.state.gameSessionId,
          key: transition.state.key,
        }),
      );
    }
  }

  private async tryEnsureDeadlineReconciled(topic: string, source: string) {
    if (this.connectionDeadlineReconcilePromise) {
      return await this.connectionDeadlineReconcilePromise;
    }

    const task = this.actionQueue.then(
      () => this.ensureDeadlineReconciled(topic, source),
      () => this.ensureDeadlineReconciled(topic, source),
    );
    this.connectionDeadlineReconcilePromise = task;
    this.actionQueue = task.catch(() => undefined);
    try {
      await task;
    } catch (error) {
      logAuxiliaryFailure("deadline_reconcile_deferred", error, {
        topic: sanitizeLogString(topic, RPC_LOG_ID_MAX_LENGTH),
        source,
      });
    } finally {
      if (this.connectionDeadlineReconcilePromise === task) {
        this.connectionDeadlineReconcilePromise = null;
      }
    }
  }

  private async ensureDeadlineReconciled(topic: string, source: string) {
    if (!topic || (!this.deadlineReconcileRequired && this.deadlineReconciledTopic === topic)) {
      return;
    }
    if (this.deadlineReconcilePromise) {
      return await this.deadlineReconcilePromise;
    }

    const task = this.reconcileDeadlineFromAuthority(topic, source);
    this.deadlineReconcilePromise = task;
    try {
      await task;
    } catch (error) {
      this.deadlineReconcileRequired = true;
      console.error(
        JSON.stringify({
          event: "deadline_transition_failed",
          kind: "reconciliation",
          source,
          topic: sanitizeLogString(topic, RPC_LOG_ID_MAX_LENGTH),
          stateMayHaveCommitted: true,
          ...getErrorLogDetails(error),
        }),
      );
      throw error instanceof DeadlineTransitionApplyError ? error : new DeadlineTransitionApplyError();
    } finally {
      if (this.deadlineReconcilePromise === task) {
        this.deadlineReconcilePromise = null;
      }
    }
  }

  private async reconcileDeadlineFromAuthority(topic: string, source: string, reconcileAlarm = true) {
    const roomId = getRoomIdFromTopic(topic);
    if (!roomId) {
      this.deadlineReconcileRequired = false;
      this.deadlineReconciledTopic = topic;
      return;
    }

    await this.ensureAuthority(topic);
    if (this.authorityVNext.hasStoredState()) {
      await this.restoreVNextAuthority({ reconcileAlarm: false });
      if (reconcileAlarm) await this.reconcileVNextAlarm();
    }
    this.deadlineReconcileRequired = false;
    this.deadlineReconciledTopic = topic;
    console.info(JSON.stringify({
      event: "room_runtime_v3_deadline_reconciled",
      source,
      topic: sanitizeLogString(topic, RPC_LOG_ID_MAX_LENGTH),
      hasVNextState: this.authorityVNext.hasStoredState(),
    }));
  }

  private async runDueAutoForfeit(alarm: AutoForfeitAlarmState | undefined, now: number) {
    if (!alarm || now < alarm.runAtMs) {
      return;
    }

    try {
      const completedKey = await this.state.storage.get<string>(AUTO_FORFEIT_COMPLETED_KEY_STORAGE_KEY);
      if (completedKey === alarm.key) {
        this.deadlineReconcileRequired = true;
        this.deadlineReconcileAfterAlarm = true;
        if ((alarm.attempts ?? 0) > 0) {
          const roomId = await this.ensureAuthority(alarm.topic);
          this.clearAllSnapshotCaches();
          const gapVersion = this.authority.bumpVersion(roomId).stateVersion;
          this.broadcast(JSON.stringify({ type: "change", name: "authorityRecovered", topic: alarm.topic, version: gapVersion, deltas: [] }));
        }
        return;
      }

      const autoForfeitRoomId = await this.ensureAuthority(alarm.topic);
      this.authority.beginMutation(autoForfeitRoomId, "autoForfeitExpiredRound", null, [{ gameSessionId: alarm.gameSessionId }]);
      const execution = await gameService.runWithGameDatabase(this.authority.database, async () => {
        const currentGameSession = await gameService.getGameSessionById(alarm.gameSessionId);
        if (
          !currentGameSession ||
          getAutoForfeitKey(currentGameSession) !== alarm.key
        ) {
          return null;
        }
        const args = [{ gameSessionId: alarm.gameSessionId }];
        logRpcInvocation({ transport: "websocket", name: "autoForfeitExpiredRound", isMutation: true, localTopic: alarm.topic });
        const result = await callGameFunction("autoForfeitExpiredRound", args, now);
        const nextRoundSnapshot = await getRoundSnapshotForMutation("autoForfeitExpiredRound", result);
        const nextGameResultSnapshot = await getGameResultSnapshotForMutation("autoForfeitExpiredRound", result);
        const nextResponseResult = attachRoundSnapshot(result, nextRoundSnapshot);
        const nextDeltas = buildRealtimeDeltas(
          "autoForfeitExpiredRound",
          args,
          nextResponseResult,
          nextRoundSnapshot,
          nextGameResultSnapshot,
        );

        return {
          responseResult: nextResponseResult,
          gameResultSnapshot: nextGameResultSnapshot,
          roundSnapshot: nextRoundSnapshot,
          deltas: nextDeltas,
        };
      });

      if (!execution) {
        this.authority.abortMutation(autoForfeitRoomId);
        this.deadlineReconcileRequired = true;
        this.deadlineReconcileAfterAlarm = true;
        if ((alarm.attempts ?? 0) > 0) {
          this.clearAllSnapshotCaches();
          const gapVersion = this.authority.bumpVersion(autoForfeitRoomId).stateVersion;
          this.broadcast(JSON.stringify({ type: "change", name: "authorityRecovered", topic: alarm.topic, version: gapVersion, deltas: [] }));
        }
        console.info(
          JSON.stringify({
            event: "business_alarm_fired",
            type: "auto-forfeit",
            key: alarm.key,
            latenessMs: Math.max(0, now - alarm.runAtMs),
            retryCount: alarm.attempts ?? 0,
            stale: true,
          }),
        );
        return;
      }

      const autoForfeitVersion = autoForfeitRoomId
        ? this.authority.commitMutation(autoForfeitRoomId, null, execution.responseResult, null)
        : { epoch: "", stateVersion: 0 };

      let postCommitError: unknown = null;
      try {
        await this.state.storage.put(AUTO_FORFEIT_COMPLETED_KEY_STORAGE_KEY, alarm.key);
      } catch (error) {
        postCommitError = error;
      }
      try {
        await this.applyMutationDeadlineTransitions({
          mutationName: "autoForfeitExpiredRound",
          result: execution.responseResult,
          roundSnapshot: execution.roundSnapshot,
          topic: alarm.topic,
          source: "auto_forfeit_alarm",
          stateMayHaveCommitted: true,
          reconcileAlarm: false,
        });
      } catch (error) {
        postCommitError ??= error;
        this.invalidateRoundSnapshotCaches(execution.roundSnapshot.gameSession.id);
      }
      this.invalidateRoundSnapshotCachesForMutation("autoForfeitExpiredRound", execution.responseResult);
      if (execution.gameResultSnapshot) {
        try {
          await this.cacheGameResultSnapshot(execution.gameResultSnapshot);
        } catch (error) {
          postCommitError ??= error;
        }
      }

      if (execution.deltas.length > 0) {
        try {
          await this.broadcastChangeMessage({
            type: "change",
            name: "autoForfeitExpiredRound",
            result: stripRoundSnapshotFromBroadcastResult(execution.responseResult),
            args: [{ gameSessionId: alarm.gameSessionId }],
            topic: alarm.topic,
            delta: execution.deltas[0],
            deltas: execution.deltas,
            version: autoForfeitVersion.stateVersion,
          } satisfies BroadcastMessage);
        } catch (error) {
          postCommitError ??= error;
        }
      }
      if (postCommitError) throw postCommitError;
      console.info(
        JSON.stringify({
          event: "business_alarm_fired",
          type: "auto-forfeit",
          key: alarm.key,
          latenessMs: Math.max(0, now - alarm.runAtMs),
          retryCount: alarm.attempts ?? 0,
          stale: false,
        }),
      );
    } catch (error) {
      const nextAttempts = (alarm.attempts ?? 0) + 1;
      await this.state.storage.put(AUTO_FORFEIT_ALARM_STORAGE_KEY, {
        ...alarm,
        attempts: nextAttempts,
        runAtMs:
          now +
          (nextAttempts < AUTO_FORFEIT_ALARM_MAX_ATTEMPTS
            ? AUTO_FORFEIT_ALARM_RETRY_DELAY_MS
            : BUSINESS_ALARM_RECOVERY_RETRY_DELAY_MS),
      } satisfies AutoForfeitAlarmState);

      console.error(
        JSON.stringify({
          event: "auto_forfeit_alarm_failed",
          gameSessionId: alarm.gameSessionId,
          key: alarm.key,
          attempts: nextAttempts,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async runDueTeamBattleVote(alarm: TeamBattleVoteAlarmState | undefined, now: number) {
    if (!alarm || now < alarm.runAtMs) {
      return;
    }

    try {
      const completedKey = await this.state.storage.get<string>(TEAM_BATTLE_VOTE_COMPLETED_KEY_STORAGE_KEY);
      if (completedKey === alarm.key) {
        this.deadlineReconcileRequired = true;
        this.deadlineReconcileAfterAlarm = true;
        if ((alarm.attempts ?? 0) > 0) {
          const roomId = await this.ensureAuthority(alarm.topic);
          this.clearAllSnapshotCaches();
          const gapVersion = this.authority.bumpVersion(roomId).stateVersion;
          this.broadcast(JSON.stringify({ type: "change", name: "authorityRecovered", topic: alarm.topic, version: gapVersion, deltas: [] }));
        }
        return;
      }

      const teamVoteRoomId = await this.ensureAuthority(alarm.topic);
      this.authority.beginMutation(teamVoteRoomId, "finalizeTeamBattleVote", null, [{ gameSessionId: alarm.gameSessionId }]);
      const execution = await gameService.runWithGameDatabase(this.authority.database, async () => {
        const currentGameSession = await gameService.getGameSessionById(alarm.gameSessionId);
        if (
          !currentGameSession ||
          getTeamBattleVoteAlarmKey(currentGameSession) !== alarm.key
        ) {
          return null;
        }
        const args = [{ gameSessionId: alarm.gameSessionId }];
        logRpcInvocation({ transport: "websocket", name: "finalizeTeamBattleVote", isMutation: true, localTopic: alarm.topic });
        const result = await callGameFunction("finalizeTeamBattleVote", args, now);
        const nextRoundSnapshot = await getRoundSnapshotForMutation("finalizeTeamBattleVote", result);
        const nextGameResultSnapshot = await getGameResultSnapshotForMutation("finalizeTeamBattleVote", result);
        const nextResponseResult = attachRoundSnapshot(result, nextRoundSnapshot);
        const nextDeltas = buildRealtimeDeltas(
          "finalizeTeamBattleVote",
          args,
          nextResponseResult,
          nextRoundSnapshot,
          nextGameResultSnapshot,
        );

        return {
          responseResult: nextResponseResult,
          gameResultSnapshot: nextGameResultSnapshot,
          roundSnapshot: nextRoundSnapshot,
          deltas: nextDeltas,
        };
      });

      if (!execution) {
        this.authority.abortMutation(teamVoteRoomId);
        this.deadlineReconcileRequired = true;
        this.deadlineReconcileAfterAlarm = true;
        if ((alarm.attempts ?? 0) > 0) {
          this.clearAllSnapshotCaches();
          const gapVersion = this.authority.bumpVersion(teamVoteRoomId).stateVersion;
          this.broadcast(JSON.stringify({ type: "change", name: "authorityRecovered", topic: alarm.topic, version: gapVersion, deltas: [] }));
        }
        console.info(
          JSON.stringify({
            event: "business_alarm_fired",
            type: "team-battle-vote",
            key: alarm.key,
            latenessMs: Math.max(0, now - alarm.runAtMs),
            retryCount: alarm.attempts ?? 0,
            stale: true,
          }),
        );
        return;
      }


      const teamVoteVersion = teamVoteRoomId
        ? this.authority.commitMutation(teamVoteRoomId, null, execution.responseResult, null)
        : { epoch: "", stateVersion: 0 };

      let postCommitError: unknown = null;
      try {
        await this.state.storage.put(TEAM_BATTLE_VOTE_COMPLETED_KEY_STORAGE_KEY, alarm.key);
      } catch (error) {
        postCommitError = error;
      }
      try {
        await this.applyMutationDeadlineTransitions({
          mutationName: "finalizeTeamBattleVote",
          result: execution.responseResult,
          roundSnapshot: execution.roundSnapshot,
          topic: alarm.topic,
          source: "team_battle_vote_alarm",
          stateMayHaveCommitted: true,
          reconcileAlarm: false,
        });
      } catch (error) {
        postCommitError ??= error;
        this.invalidateRoundSnapshotCaches(execution.roundSnapshot.gameSession.id);
      }
      this.invalidateRoundSnapshotCachesForMutation("finalizeTeamBattleVote", execution.responseResult);
      if (execution.gameResultSnapshot) {
        try {
          await this.cacheGameResultSnapshot(execution.gameResultSnapshot);
        } catch (error) {
          postCommitError ??= error;
        }
      }

      if (execution.deltas.length > 0) {
        try {
          await this.broadcastChangeMessage({
            type: "change",
            name: "finalizeTeamBattleVote",
            result: stripRoundSnapshotFromBroadcastResult(execution.responseResult),
            args: [{ gameSessionId: alarm.gameSessionId }],
            topic: alarm.topic,
            delta: execution.deltas[0],
            deltas: execution.deltas,
            version: teamVoteVersion.stateVersion,
          } satisfies BroadcastMessage);
        } catch (error) {
          postCommitError ??= error;
        }
      }
      if (postCommitError) throw postCommitError;
      console.info(
        JSON.stringify({
          event: "business_alarm_fired",
          type: "team-battle-vote",
          key: alarm.key,
          latenessMs: Math.max(0, now - alarm.runAtMs),
          retryCount: alarm.attempts ?? 0,
          stale: false,
        }),
      );
    } catch (error) {
      const nextAttempts = (alarm.attempts ?? 0) + 1;
      await this.state.storage.put(TEAM_BATTLE_VOTE_ALARM_STORAGE_KEY, {
        ...alarm,
        attempts: nextAttempts,
        runAtMs:
          now +
          (nextAttempts < TEAM_BATTLE_VOTE_ALARM_MAX_ATTEMPTS
            ? TEAM_BATTLE_VOTE_ALARM_RETRY_DELAY_MS
            : BUSINESS_ALARM_RECOVERY_RETRY_DELAY_MS),
      } satisfies TeamBattleVoteAlarmState);

      console.error(
        JSON.stringify({
          event: "team_battle_vote_alarm_failed",
          gameSessionId: alarm.gameSessionId,
          key: alarm.key,
          attempts: nextAttempts,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async broadcastChangeMessage(message: BroadcastMessage) {
    const version = message.version ?? this.runtime.bumpVersion(await this.ensureAuthority(message.topic)).stateVersion;
    this.broadcast(JSON.stringify(toClientBroadcastMessage(message, version)));
  }

  private broadcast(message: string) {
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "广播失败。");
      }
    }
  }
}

export class RoomDurableObject {
  constructor(private readonly state: DurableObjectState) {}

  private expireSocket(socket: WebSocket) {
    try {
      socket.send(JSON.stringify({
        type: "room_expired",
        code: ROOM_VERSION_EXPIRED_ERROR_CODE,
        message: ROOM_VERSION_EXPIRED_MESSAGE,
      }));
    } finally {
      socket.close(4001, ROOM_VERSION_EXPIRED_ERROR_CODE);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      this.expireSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return Response.json(
      { error: ROOM_VERSION_EXPIRED_MESSAGE, code: ROOM_VERSION_EXPIRED_ERROR_CODE },
      { status: 410 },
    );
  }

  async webSocketMessage(socket: WebSocket): Promise<void> {
    this.expireSocket(socket);
  }

  async alarm(): Promise<void> {
    try {
      await this.state.storage.deleteAlarm();
    } catch (error) {
      console.error(JSON.stringify({
        event: "retired_room_alarm_cleanup_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    for (const socket of this.state.getWebSockets()) this.expireSocket(socket);
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await cleanupExpiredRooms(env);
    } catch (error) {
      logAuxiliaryFailure("expired_room_cleanup_failed", error);
    }
    try {
      await cleanupUnreferencedR2Objects(env);
    } catch (error) {
      logAuxiliaryFailure("unreferenced_r2_cleanup_failed", error);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/api/public-rooms" && request.method === "GET") {
        return await getPublicRoomsResponse(request, env, caches.default);
      }

      if (url.pathname === "/api/rpc" && request.method === "POST") {
        const body = await readRpcBody(request);
        const requestHeaders = new Headers(request.headers);
        requestHeaders.delete("content-length");
        const requestWithBody = new Request(request.url, {
          method: request.method,
          headers: requestHeaders,
          body: JSON.stringify(body),
        });
        const mutationDeadlinePolicy = getMutationDeadlinePolicy(body?.name ?? "");
        const roomRoute = await resolveRoomTopicForRpc(env, body?.name ?? "", body.args ?? []);
        const topic = roomRoute?.topic ?? null;
        if (roomRoute && !roomRoute.runtimeChecked) await assertCurrentRoomRuntime(env, roomRoute.topic);
        if (
          body?.name === "joinRoom" ||
          body?.name === "updatePlayerRole" ||
          body?.name === "selectTeamForPlayer" ||
          body?.name === "updateRoomGameSettings" ||
          body?.name === "updateRoomNotice" ||
          ROOM_AUTHORITY_GAME_NAMES.has(body?.name ?? "") ||
          ROOM_AUTHORITY_ROSTER_QUERY_NAMES.has(body?.name ?? "") ||
          mutationDeadlinePolicy === "authoritative-post-state"
        ) {
          if (topic) {
            const headers = new Headers(requestWithBody.headers);
            headers.set(LOCAL_ROOM_OBJECT_TOPIC_HEADER, topic);
            return withCors(await getRoomObject(env, topic).fetch(new Request(requestWithBody, { headers })), request, env);
          }
        }

        return await handleRpc(requestWithBody, env, { body, receivedAtMs: Date.now() });
      }

      if (url.pathname === "/api/r2-upload" && request.method === "POST") {
        return await handleR2Upload(request, env);
      }

      if (url.pathname === "/api/community-screenshot-upload" && request.method === "POST") {
        return await handleCommunityScreenshotUpload(request, env);
      }

      if (url.pathname === "/api/community-question-set" && request.method === "POST") {
        return await handleCommunityQuestionSetCreate(request, env, caches.default);
      }

      if (url.pathname === "/api/bangumi/subjects" && request.method === "GET") {
        return await handleBangumiAnimeSearch(request, env, caches.default);
      }

      const bangumiSubjectCharactersMatch = url.pathname.match(/^\/api\/bangumi\/subjects\/(\d+)\/characters$/);
      if (bangumiSubjectCharactersMatch && request.method === "GET") {
        return await handleBangumiSubjectCharacters(request, env, caches.default, Number(bangumiSubjectCharactersMatch[1]));
      }

      if (url.pathname === "/api/community-image-index" && request.method === "GET") {
        return await handleCommunityImageIndexSearch(request, env);
      }

      if (url.pathname === "/api/remote-image-source" && request.method === "POST") {
        return await handleRemoteImageSource(request, env);
      }

      if (url.pathname === "/api/r2-images" && request.method === "GET") {
        return await handleR2ImagesList(request, env);
      }

      const r2ImageKey = getR2ObjectKeyFromPath(url.pathname);
      if (r2ImageKey && (request.method === "GET" || request.method === "HEAD")) {
        return await handleR2Image(request, env, r2ImageKey);
      }

      const realtimeMatch = url.pathname.match(/^\/api\/realtime\/(.+)\/ws$/);
      if (realtimeMatch && request.headers.get("upgrade") === "websocket") {
        const topic = decodeURIComponent(realtimeMatch[1]);
        try {
          const exists = await assertCurrentRoomRuntime(env, topic);
          if (!exists) return json({ error: "房间不存在。" }, { status: 404 }, request, env);
        } catch (error) {
          if (error instanceof RoomVersionExpiredError) return expiredRoomWebSocketResponse();
          throw error;
        }
        const roomObjectUrl = new URL("https://room-object/ws");
        roomObjectUrl.searchParams.set("topic", topic);
        const playerId = url.searchParams.get("playerId")?.trim();
        if (playerId) roomObjectUrl.searchParams.set("playerId", playerId);
        return getRoomObject(env, topic).fetch(new Request(roomObjectUrl, request));
      }

      return json({ error: "未找到对应的服务接口。" }, { status: 404 }, request, env);
    } catch (error) {
      return errorResponse(error, request, env);
    }
  },
};
