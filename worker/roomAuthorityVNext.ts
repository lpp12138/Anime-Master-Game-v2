import type {
  Answer,
  BuzzerAnswer,
  GameBootstrapSnapshot,
  GameResultQuestionScore,
  GameResultSnapshot,
  GameSession,
  LeaderboardEntry,
  Player,
  PlayerScore,
  Question,
  QuestionResult,
  QuestionSet,
  RealtimeDelta,
  Room,
  RoundSnapshot,
  TeamBattleGuessVote,
  TeamBattleGuessProposal,
  TeamBattleState,
  TeamBattleTeam,
} from "../src/types/game";
import type { DbQuestionSet } from "../src/types/game";
import {
  DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
  DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
  MAX_TEAM_BATTLE_GUESS_LENGTH,
  TEAM_BATTLE_ALL_SUBMITTED_GRACE_SECONDS,
} from "../src/types/game";
import {
  decodeQuestionSetManifest,
  encodeDbQuestionSetManifest,
  QUESTION_SET_MANIFEST_VERSION,
} from "./questionSetManifest";
import { CURRENT_ROOM_RUNTIME_GENERATION } from "../src/lib/roomRuntime";
import { encodeRoomState, ROOM_STATE_MANIFEST_VERSION } from "./roomStateManifest";

const VNEXT_AUTHORITY_VERSION = 2 as const;
const VNEXT_STATE_SCHEMA_VERSION = 1 as const;
const CHECKPOINT_ACTION_THRESHOLD = 20;
const CHECKPOINT_AGE_MS = 10_000;
export const ATTACHMENT_LIMIT_BYTES = 16_384;
export const ATTACHMENT_BUDGET_BYTES = 12_288;
const RECENT_ACTION_LIMIT = 512;
const COMMITTED_REJECTION_LIMIT = 128;
const FINAL_PROJECTION_LIMIT_BYTES = 1024 * 1024;
const FINAL_PROJECTION_RESERVE_BYTES = 400 * 1024;
const GAME_RESULT_ARCHIVE_LIMIT_BYTES = 512 * 1024;
const MAX_PLAYERS_PER_ROOM = 50;
const FORFEIT_ANSWER_TEXT = "__FORFEIT__";
const ANSWER_TEXT_BACKFILL_CHUNK_SIZE = 2;
const PORTRAIT_REVEAL_BLOCK_COUNT = 35;
const ALL_REVEALED_BLOCKS = Array.from({ length: 45 }, (_, index) => index);
const QUESTION_SCOPED_MUTATION_NAMES = new Set([
  "confirmRevealBlocks",
  "submitAnswer",
  "submitForfeitAnswer",
  "cancelForfeitAnswer",
  "submitBuzzerAnswer",
  "judgeBuzzerAnswer",
  "setAnswerJudgements",
  "markPendingRoundAnswersWrong",
  "settleBuzzerRound",
  "autoForfeitExpiredRound",
  "gradeAnswersAndAdvance",
  "completeTeamBattleBlockSelection",
  "submitTeamBattleRevealVote",
  "submitTeamBattleGuessVote",
  "finalizeTeamBattleVote",
  "judgeTeamBattleGuess",
  "advanceTeamBattleTurn",
  "revealTeamBattleAnswer",
  "advanceReviewedQuestion",
  "skipCurrentQuestion",
  "endCurrentGameEarly",
  "updateQuestionLabel",
]);

type CutoverState = "initializing" | "active" | "ended";
type CheckpointTrigger =
  | "action-count"
  | "event-age"
  | "attachment-budget"
  | "connection-close"
  | "phase-boundary"
  | "deadline"
  | "game-end"
  | "projection"
  | "replay";

export type VNextMutationEnvelope = {
  actionId: string;
  actorId: string;
  clientSeq: number;
  gameId: string;
  questionIndex: number;
  name: string;
  payload: Record<string, unknown>;
};

export type VNextPendingMutation = VNextMutationEnvelope & {
  serverReceivedAtMs: number;
  orderToken: string;
};

export type VNextSocketAttachment = {
  attachmentVersion: 1;
  topic: string;
  playerId?: string;
  role?: "player" | "presenter" | "host" | "spectator";
  pending: VNextPendingMutation[];
  serializedBytes: number;
};

export type VNextStartBootstrap = {
  room: Room;
  players: Player[];
  gameParticipants?: Player[];
  questionSet: QuestionSet;
  questions: Question[];
  questionSetManifestVersion?: number | null;
  gameSession: GameSession;
};

type VNextDeadline = {
  kind: "round" | "team-vote";
  gameId: string;
  questionIndex: number;
  phaseKey: string;
  runAtMs: number;
} | null;

export type VNextAggregate = {
  authorityVersion: typeof VNEXT_AUTHORITY_VERSION;
  schemaVersion: typeof VNEXT_STATE_SCHEMA_VERSION;
  cutoverState: CutoverState;
  roomId: string;
  gameId: string;
  startParams?: Record<string, unknown>;
  room?: Room;
  players: Player[];
  questionSet?: QuestionSet;
  questions: Question[];
  questionSetManifestVersion?: number | null;
  dirtyQuestionLabelIds?: string[];
  gameSession?: GameSession;
  answers: Answer[];
  buzzerAnswers: BuzzerAnswer[];
  questionResults: QuestionResult[];
  scores: PlayerScore[];
  scoreBaseline: Record<string, { score: number; correctCount: number }>;
  finalQuestionResults?: QuestionResult[];
  finalLeaderboard?: LeaderboardEntry[];
  resultArchiveSuppressed?: boolean;
  dissolved?: boolean;
  pendingQuestionArchive?: { gameId: string; questionIndex: number; state: unknown };
  committedSeqByActor: Record<string, number>;
  seenSeqByActor: Record<string, number>;
  terminalRejections: Record<string, string>;
  deadline: VNextDeadline;
  stateVersion: number;
  publicStateVersion: number;
  checkpointGeneration: number;
  lastCheckpointAtMs: number;
  lastPublicActivityAtMs: number;
};

export type VNextInitializingStart = {
  roomId: string;
  gameId: string;
  startParams: Record<string, unknown>;
};

export type VNextMutationOutcome = {
  data?: unknown;
  error?: string;
  terminal?: boolean;
  duplicate?: boolean;
  provisional: boolean;
  orderToken?: string;
  publicDeltas: RealtimeDelta[];
  presenterDeltas: RealtimeDelta[];
  answerViewerDeltas?: RealtimeDelta[];
  playerDeltas: Array<{ playerId: string; delta: RealtimeDelta }>;
  playerBackfillDeltas?: Array<{ playerId: string; deltas: RealtimeDelta[] }>;
  forceCheckpoint?: CheckpointTrigger;
  archiveQuestion?: boolean;
  deadlineChanged?: boolean;
};

export type VNextCheckpointReceipt = {
  version: number;
  generation: number;
  committedSeqByActor: Record<string, number>;
  trigger: CheckpointTrigger;
  activeGameBytes: number;
  changedRows: number;
  durationMs: number;
};

type ActiveRow = {
  room_id: string;
  game_id: string;
  cutover_state: CutoverState;
  state_version: number;
  state_json: string;
};

type GameResultArchive = {
  version: 1;
  gameMode: GameSession["gameMode"];
  questionCount: number;
  completedAt: string;
  leaderboard: LeaderboardEntry[];
  questionScores: GameResultQuestionScore[];
};

type LegacyProjectionGame = {
  projectionVersion?: undefined;
  roomId: string;
  dissolved?: boolean;
  room?: Room;
  players: Player[];
  participants?: Player[];
  questions: Question[];
  questionSetManifestVersion?: number | null;
  dirtyQuestionLabelIds?: string[];
  gameSession?: GameSession;
  scores: PlayerScore[];
  questionResults: QuestionResult[];
  publicActivityAt?: string;
};

type ArchiveProjectionGameV2 = {
  projectionVersion: 2;
  roomId: string;
  dissolved?: boolean;
  room?: Room;
  players: Player[];
  questions: Question[];
  questionSetManifestVersion?: number | null;
  dirtyQuestionLabelIds?: string[];
  gameSession?: GameSession;
  archive: GameResultArchive;
  publicActivityAt?: string;
};

type ArchiveProjectionGameV3 = Omit<ArchiveProjectionGameV2, "projectionVersion" | "archive"> & {
  projectionVersion: 3;
  rosterStrategy: "reconcile";
  archive?: GameResultArchive;
};

type ProjectionGame = LegacyProjectionGame | ArchiveProjectionGameV2 | ArchiveProjectionGameV3;
type ProjectionPayload = { games: ProjectionGame[] };

class TerminalMutationError extends Error {}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function getPlayerCapacity(room: Room | undefined) {
  const value = room?.playerCapacity;
  return typeof value === "number" && Number.isInteger(value) ? Math.max(1, Math.min(50, value)) : MAX_PLAYERS_PER_ROOM;
}

function getSpectatorCapacity(room: Room | undefined) {
  const value = room?.spectatorCapacity;
  return typeof value === "number" && Number.isInteger(value) ? Math.max(0, Math.min(50, value)) : MAX_PLAYERS_PER_ROOM;
}

function countPlayersByRole(players: Player[], role: Player["role"]) {
  return players.filter((player) => player.role === role).length;
}

function questionRoundKey(questionIndex: number, revealRound: number, playerId: string) {
  return `${questionIndex}:${revealRound}:${playerId}`;
}

function compareBuzzer(left: BuzzerAnswer, right: BuzzerAnswer) {
  const leftServer = new Date(left.serverReceivedAt).getTime();
  const rightServer = new Date(right.serverReceivedAt).getTime();
  return leftServer - rightServer || left.playerId.localeCompare(right.playerId) || left.id.localeCompare(right.id);
}

function getTeamMembers(state: TeamBattleState, team: TeamBattleTeam) {
  return state.teams[team] ?? [];
}

function oppositeTeam(team: TeamBattleTeam): TeamBattleTeam {
  return team === "red" ? "blue" : "red";
}

function teamName(team: TeamBattleTeam) {
  return team === "red" ? "红队" : "蓝队";
}

function normalizeRevealBlockCount(value: unknown) {
  return Number(value) === PORTRAIT_REVEAL_BLOCK_COUNT ? PORTRAIT_REVEAL_BLOCK_COUNT : ALL_REVEALED_BLOCKS.length;
}

function normalizeDisabledBlocks(value: unknown, blockCount: number) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((block): block is number => Number.isInteger(block) && block >= 0 && block < blockCount)),
  ).sort((a, b) => a - b);
}

function selectableTeamBlocks(session: Pick<GameSession, "revealedBlocks">, state: TeamBattleState, blockCount: number) {
  const revealed = new Set(session.revealedBlocks);
  const disabled = new Set(normalizeDisabledBlocks(state.disabledBlocks, blockCount));
  return Array.from({ length: blockCount }, (_, index) => index).filter((block) => !revealed.has(block) && !disabled.has(block));
}

function normalizeTeamVoteSeconds(value: unknown, fallback: number) {
  return Math.max(1, Math.min(600, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : fallback)));
}

function teamVoteSeconds(state: TeamBattleState, phase: "REVEAL_VOTE" | "GUESS_VOTE") {
  return phase === "REVEAL_VOTE"
    ? normalizeTeamVoteSeconds(state.revealVoteSeconds, DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS)
    : normalizeTeamVoteSeconds(state.guessVoteSeconds, DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS);
}

function normalizeTeamGuessAnswer(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function rebuildTeamGuessProposals(
  state: TeamBattleState,
  resolvePlayerName: (playerId: string) => string | undefined,
) {
  const proposals: TeamBattleGuessProposal[] = [];
  const proposalByAnswer = new Map<string, TeamBattleGuessProposal>();
  for (const proposal of state.guessProposals ?? []) {
    const answerText = normalizeTeamGuessAnswer(proposal.answerText);
    if (!answerText || proposalByAnswer.has(answerText)) continue;
    const normalized = { ...proposal, answerText };
    proposals.push(normalized);
    proposalByAnswer.set(answerText, normalized);
  }
  for (const [voterId, vote] of Object.entries(state.guessVotes)) {
    if (vote.type !== "guess") continue;
    const answerText = normalizeTeamGuessAnswer(vote.answerText);
    if (!answerText) continue;
    let proposal = proposalByAnswer.get(answerText);
    if (!proposal) {
      proposal = {
        answerText,
        proposerPlayerId: voterId,
        proposerName: resolvePlayerName(voterId) ?? "已离开玩家",
      };
      proposals.push(proposal);
      proposalByAnswer.set(answerText, proposal);
    }
    vote.answerText = proposal.answerText;
  }
  state.guessProposals = proposals;
  return proposalByAnswer;
}

function pruneUnusedTeamGuessProposals(state: TeamBattleState) {
  const activeAnswers = new Set(
    Object.values(state.guessVotes)
      .filter((vote) => vote.type === "guess")
      .map((vote) => normalizeTeamGuessAnswer(vote.answerText))
      .filter(Boolean),
  );
  state.guessProposals = (state.guessProposals ?? []).filter((proposal) => activeAnswers.has(proposal.answerText));
}

function teamDeadlineFromSession(session: GameSession): VNextDeadline {
  const state = session.teamBattleState;
  if (!state || (state.phase !== "REVEAL_VOTE" && state.phase !== "GUESS_VOTE") || !state.voteDeadlineAt) return null;
  const runAtMs = new Date(state.voteDeadlineAt).getTime();
  if (!Number.isFinite(runAtMs)) return null;
  return {
    kind: "team-vote",
    gameId: session.id,
    questionIndex: session.currentQuestionIndex,
    phaseKey: `${state.phase}:${state.turnNumber}`,
    runAtMs,
  };
}

function normalizeTeamSessionDeadline(session: GameSession, nowMs: number) {
  const state = session.teamBattleState;
  if (!state) return { changed: false, deadline: null as VNextDeadline };
  let changed = false;
  if (typeof state.presenterBlockEnabled !== "boolean") {
    state.presenterBlockEnabled = true;
    changed = true;
  }
  const revealVoteSeconds = normalizeTeamVoteSeconds(state.revealVoteSeconds, DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS);
  const guessVoteSeconds = normalizeTeamVoteSeconds(state.guessVoteSeconds, DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS);
  if (state.revealVoteSeconds !== revealVoteSeconds) {
    state.revealVoteSeconds = revealVoteSeconds;
    changed = true;
  }
  if (state.guessVoteSeconds !== guessVoteSeconds) {
    state.guessVoteSeconds = guessVoteSeconds;
    changed = true;
  }
  if (Array.isArray(state.disabledBlocks)) {
    const disabledBlocks = normalizeDisabledBlocks(state.disabledBlocks, normalizeRevealBlockCount(state.revealBlockCount));
    if (disabledBlocks.length !== state.disabledBlocks.length || disabledBlocks.some((block, index) => block !== state.disabledBlocks?.[index])) {
      state.disabledBlocks = disabledBlocks;
      changed = true;
    }
  }
  if (state.phase !== "REVEAL_VOTE" && state.phase !== "GUESS_VOTE") {
    if (state.voteDeadlineAt != null) {
      state.voteDeadlineAt = null;
      changed = true;
    }
    return { changed, deadline: null as VNextDeadline };
  }
  if (!getTeamMembers(state, "red").length && !getTeamMembers(state, "blue").length) {
    if (state.voteDeadlineAt != null) {
      state.voteDeadlineAt = null;
      changed = true;
    }
    return { changed, deadline: null as VNextDeadline };
  }
  let runAtMs = state.voteDeadlineAt ? new Date(state.voteDeadlineAt).getTime() : Number.NaN;
  if (!Number.isFinite(runAtMs)) {
    runAtMs = nowMs + teamVoteSeconds(state, state.phase) * 1000;
    state.voteDeadlineAt = nowIso(runAtMs);
    changed = true;
  }
  return {
    changed,
    deadline: {
      kind: "team-vote" as const,
      gameId: session.id,
      questionIndex: session.currentQuestionIndex,
      phaseKey: `${state.phase}:${state.turnNumber}`,
      runAtMs,
    },
  };
}

function getActionActor(params: Record<string, unknown>) {
  return getString(params.playerId) ?? getString(params.presenterPlayerId) ?? getString(params.hostPlayerId);
}

function isPermanentSchemaError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (table|column)|schema validation|schema version/i.test(message);
}

export class RoomAuthorityVNext {
  private aggregate: VNextAggregate | null = null;
  private restored = false;
  private dirtyActionCount = 0;
  private dirtyGeneration = 0;
  private committedGeneration = 0;
  private checkpointPromise: Promise<VNextCheckpointReceipt | null> | null = null;
  private readonly recentActions = new Map<string, VNextMutationOutcome>();
  private metrics = {
    broadcasts: 0,
    broadcastBytes: 0,
    provisionalAcks: 0,
    durableAcks: 0,
    duplicates: 0,
    d1Reads: 0,
    d1Writes: 0,
    alarmScheduled: 0,
    alarmIgnored: 0,
    alarmExecuted: 0,
    alarmRetried: 0,
    checkpoints: 0,
    checkpointChangedRows: 0,
    maxActiveGameBytes: 0,
    checkpointTriggers: {} as Record<string, number>,
  };
  private projectionFlushInFlight: Promise<boolean> | null = null;
  private deadlineRepairPending = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly d1: D1Database,
    private readonly random: () => number = Math.random,
  ) {}

  hasStoredState() {
    return Boolean(this.readActiveRow());
  }

  hasGameState(gameId?: string | null) {
    if (this.aggregate && (!gameId || this.aggregate.gameId === gameId)) {
      return this.aggregate.cutoverState !== "initializing";
    }
    const row = this.readActiveRow();
    return Boolean(row && row.cutover_state !== "initializing" && (!gameId || row.game_id === gameId));
  }

  isRunningGame(gameId?: string | null) {
    if (this.aggregate && (!gameId || this.aggregate.gameId === gameId)) {
      return this.aggregate.cutoverState === "active";
    }
    const row = this.readActiveRow();
    return Boolean(row && row.cutover_state === "active" && (!gameId || row.game_id === gameId));
  }

  getCutoverState() {
    return this.readActiveRow()?.cutover_state ?? null;
  }

  getInitializingStart(): VNextInitializingStart | null {
    const aggregate = this.aggregate ?? this.readAggregate();
    if (!aggregate || aggregate.cutoverState !== "initializing" || !aggregate.startParams) return null;
    return { roomId: aggregate.roomId, gameId: aggregate.gameId, startParams: clone(aggregate.startParams) };
  }

  beginStart(roomId: string, gameId: string, startParams: Record<string, unknown>) {
    const current = this.readActiveRow();
    if (current?.game_id === gameId) return;
    if (current && current.cutover_state === "active") throw new Error("当前房间已有进行中的 authority vNext 游戏。");
    const aggregate: VNextAggregate = {
      authorityVersion: VNEXT_AUTHORITY_VERSION,
      schemaVersion: VNEXT_STATE_SCHEMA_VERSION,
      cutoverState: "initializing",
      roomId,
      gameId,
      startParams: clone(startParams),
      players: [],
      gameParticipants: [],
      questions: [],
      questionSetManifestVersion: null,
      dirtyQuestionLabelIds: [],
      answers: [],
      buzzerAnswers: [],
      questionResults: [],
      scores: [],
      scoreBaseline: {},
      committedSeqByActor: {},
      seenSeqByActor: {},
      terminalRejections: {},
      deadline: null,
      stateVersion: 0,
      publicStateVersion: 0,
      checkpointGeneration: 0,
      lastCheckpointAtMs: Date.now(),
      lastPublicActivityAtMs: Date.now(),
    };
    this.writeActive(aggregate);
    this.aggregate = aggregate;
    this.restored = true;
  }

  abortInitializingStart(gameId: string) {
    const current = this.readActiveRow();
    if (!current || current.game_id !== gameId || current.cutover_state !== "initializing") return false;
    this.state.storage.sql.exec(
      "DELETE FROM authority_vnext_active_game WHERE id=1 AND game_id=? AND cutover_state='initializing'",
      gameId,
    );
    this.aggregate = null;
    this.restored = true;
    this.dirtyGeneration = 0;
    this.committedGeneration = 0;
    this.dirtyActionCount = 0;
    this.deadlineRepairPending = false;
    this.recentActions.clear();
    return true;
  }

  activateStart(bootstrap: VNextStartBootstrap) {
    const current = this.aggregate ?? this.readAggregate();
    if (!current || current.gameId !== bootstrap.gameSession.id) throw new Error("authority vNext 开局 cutover 标记缺失。");
    const players = bootstrap.players.map((player) => ({ ...player, roomId: bootstrap.room.id }));
    const participatingPlayers = players.filter(
      (player) => player.role === "PLAYER" && player.id !== bootstrap.gameSession.presenterPlayerId,
    );
    const scores = participatingPlayers
      .map((player) => ({ id: `${bootstrap.gameSession.id}:${player.id}`, gameSessionId: bootstrap.gameSession.id, playerId: player.id, score: 0, correctCount: 0 }));
    const gameSession = {
      ...bootstrap.gameSession,
      questionCount: bootstrap.questions.length,
      eligiblePlayerIds: bootstrap.gameSession.eligiblePlayerIds ?? this.eligiblePlayers(players, bootstrap.gameSession.presenterPlayerId),
    };
    const normalizedTeam = normalizeTeamSessionDeadline(gameSession, Date.now());
    const aggregate: VNextAggregate = {
      ...current,
      cutoverState: "active",
      room: { ...bootstrap.room, players },
      players,
      gameParticipants: participatingPlayers.map((player) => ({ ...player, role: "PLAYER" })),
      questionSet: {
        ...bootstrap.questionSet,
        questions: clone(bootstrap.questionSet.questions ?? bootstrap.questions),
      },
      questions: bootstrap.questions.slice().sort((a, b) => a.orderIndex - b.orderIndex),
      questionSetManifestVersion: bootstrap.questionSetManifestVersion ?? null,
      dirtyQuestionLabelIds: [],
      gameSession,
      deadline: normalizedTeam.deadline ?? teamDeadlineFromSession(gameSession) ?? current.deadline,
      scores,
      scoreBaseline: {},
      startParams: undefined,
      lastCheckpointAtMs: Date.now(),
      lastPublicActivityAtMs: Date.now(),
    };
    this.writeActive(aggregate);
    this.aggregate = aggregate;
    this.restored = true;
    this.dirtyActionCount = 0;
    this.dirtyGeneration = 0;
    this.committedGeneration = 0;
    this.logCheckpoint("phase-boundary", 1, jsonBytes(aggregate), 0, aggregate.stateVersion);
  }

  async restoreFromStorage(options: { persistRepairs?: boolean } = {}) {
    if (this.restored) return this.aggregate;
    const startedAt = performance.now();
    const aggregate = this.readAggregate();
    if (!aggregate) {
      this.restored = true;
      return null;
    }
    const normalizedTeam = aggregate.cutoverState === "active" && aggregate.gameSession
      ? normalizeTeamSessionDeadline(aggregate.gameSession, Date.now())
      : { changed: false, deadline: null as VNextDeadline };
    const repairedDeadline = normalizedTeam.deadline && (
      !aggregate.deadline ||
      aggregate.deadline.kind !== normalizedTeam.deadline.kind ||
      aggregate.deadline.gameId !== normalizedTeam.deadline.gameId ||
      aggregate.deadline.questionIndex !== normalizedTeam.deadline.questionIndex ||
      aggregate.deadline.phaseKey !== normalizedTeam.deadline.phaseKey ||
      aggregate.deadline.runAtMs !== normalizedTeam.deadline.runAtMs
    );
    if (normalizedTeam.deadline && repairedDeadline) aggregate.deadline = normalizedTeam.deadline;
    const clearedStaleTeamDeadline = !normalizedTeam.deadline && aggregate.gameSession?.gameMode === "TEAM_BATTLE" && aggregate.deadline?.kind === "team-vote";
    if (clearedStaleTeamDeadline) {
      aggregate.deadline = null;
    }
    const clearedInactiveDeadline = aggregate.cutoverState !== "active" && aggregate.deadline !== null;
    if (clearedInactiveDeadline) {
      aggregate.deadline = null;
    }
    if (normalizedTeam.changed || repairedDeadline || clearedStaleTeamDeadline || clearedInactiveDeadline) {
      if (options.persistRepairs !== false) this.writeActive(aggregate);
      this.deadlineRepairPending ||= Boolean(repairedDeadline || clearedStaleTeamDeadline || clearedInactiveDeadline);
      console.info(JSON.stringify({
        event: "authority_vnext_team_deadline_repaired",
        authorityVersion: 2,
        gameId: aggregate.gameId,
        phase: aggregate.gameSession?.teamBattleState?.phase ?? null,
        runAtMs: normalizedTeam.deadline?.runAtMs ?? null,
      }));
    }
    this.aggregate = aggregate;
    this.dirtyGeneration = aggregate.checkpointGeneration;
    this.committedGeneration = aggregate.checkpointGeneration;
    const pending: VNextPendingMutation[] = [];
    let attachmentBytes = 0;
    let maxAttachmentBytes = 0;
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.safeDeserializeAttachment(socket);
      if (!attachment) continue;
      attachmentBytes += attachment.serializedBytes || jsonBytes(attachment);
      maxAttachmentBytes = Math.max(maxAttachmentBytes, attachment.serializedBytes || jsonBytes(attachment));
      for (const action of attachment.pending) {
        if (action.gameId === aggregate.gameId && action.clientSeq > (aggregate.committedSeqByActor[action.actorId] ?? 0)) pending.push(action);
      }
    }
    pending.sort((left, right) => left.serverReceivedAtMs - right.serverReceivedAtMs || left.actorId.localeCompare(right.actorId) || left.clientSeq - right.clientSeq);
    const replayed = new Set<string>();
    for (const action of pending) {
      const key = `${action.actorId}:${action.clientSeq}:${action.actionId}`;
      if (replayed.has(key) || action.clientSeq <= (aggregate.seenSeqByActor[action.actorId] ?? 0)) continue;
      replayed.add(key);
      try {
        const outcome = this.applyMutation(action, true);
        this.rememberAction(action.actionId, outcome);
      } catch (error) {
        if (!(error instanceof TerminalMutationError)) throw error;
        aggregate.seenSeqByActor[action.actorId] = action.clientSeq;
        aggregate.terminalRejections[`${action.actorId}:${action.clientSeq}`] = error.message;
        this.trimCommittedRejections(aggregate);
        this.markDirty();
        this.rememberAction(action.actionId, this.terminalError(error.message));
      }
    }
    this.deadlineRepairPending ||= aggregate.deadline !== null;
    console.info(JSON.stringify({
      event: "authority_vnext_restored",
      authorityVersion: 2,
      gameId: aggregate.gameId,
      wake_restore_ms: Math.max(0, performance.now() - startedAt),
      activeGameBytes: jsonBytes(aggregate),
      attachmentCount: this.state.getWebSockets().length,
      attachmentBytes,
      maxAttachmentBytes,
      replayed: replayed.size,
    }));
    this.restored = true;
    return aggregate;
  }

  hasPendingDeadlineRepair() {
    return this.deadlineRepairPending;
  }

  acknowledgeDeadlineRepair() {
    this.deadlineRepairPending = false;
  }

  markDeadlineRepairPending() {
    this.deadlineRepairPending = true;
  }

  getAggregate() {
    if (!this.aggregate) this.aggregate = this.readAggregate();
    return this.aggregate;
  }

  syncQuestionSetMetadata(questionSet: QuestionSet) {
    const aggregate = this.requireActiveOrEnded();
    if (!aggregate.questionSet || aggregate.questionSet.id !== questionSet.id) return false;
    aggregate.questionSet = {
      ...clone(questionSet),
      questions: clone(aggregate.questions),
    };
    this.markDirty();
    return true;
  }

  getCurrentAnswerTextBackfillDeltas() {
    const aggregate = this.requireActiveOrEnded();
    const session = aggregate.gameSession!;
    if (session.gameMode === "TEAM_BATTLE") return [];
    const answers = aggregate.buzzerAnswers
      .filter((answer) => answer.questionIndex === session.currentQuestionIndex)
      .sort(compareBuzzer);
    const deltas: RealtimeDelta[] = [];
    for (let index = 0; index < answers.length; index += ANSWER_TEXT_BACKFILL_CHUNK_SIZE) {
      deltas.push({
        scope: "game",
        type: "answer_text_backfill",
        gameSessionId: session.id,
        questionIndex: session.currentQuestionIndex,
        buzzerAnswers: clone(answers.slice(index, index + ANSWER_TEXT_BACKFILL_CHUNK_SIZE)),
      });
    }
    return deltas;
  }

  resetAfterFailedTransition() {
    this.aggregate = null;
    this.restored = false;
    this.dirtyGeneration = 0;
    this.committedGeneration = 0;
    this.dirtyActionCount = 0;
    this.recentActions.clear();
  }

  getSnapshot(nowMs = Date.now()): RoundSnapshot {
    const aggregate = this.requireActiveOrEnded();
    const participantIds = this.participantIds(aggregate);
    const gameSession = clone(aggregate.gameSession!);
    gameSession.serverNow = nowIso(nowMs);
    const questionResults = aggregate.questionResults.filter(
      (result) => participantIds.has(result.playerId) && result.questionIndex === gameSession.currentQuestionIndex,
    );
    const correctAnswerKeys = new Set(
      questionResults.map((result) => `${result.playerId}:${result.scoredRound}`),
    );
    const questionAnswers = aggregate.answers.filter(
      (answer) => answer.questionIndex === gameSession.currentQuestionIndex,
    );
    const questionBuzzerAnswers = aggregate.buzzerAnswers.filter(
      (answer) => answer.questionIndex === gameSession.currentQuestionIndex,
    );
    const isCurrentRound = (answer: { revealRound: number }) => answer.revealRound === gameSession.currentRevealRound;
    const isCorrectRoundAnswer = (answer: { playerId: string; revealRound: number }) =>
      correctAnswerKeys.has(`${answer.playerId}:${answer.revealRound}`);
    return {
      gameSession,
      scores: clone(aggregate.scores.filter((score) => participantIds.has(score.playerId))),
      questionResults: clone(questionResults),
      answers: clone(questionAnswers.filter(isCurrentRound)),
      labelAnswers: clone(questionAnswers.filter((answer) => answer.answerText !== FORFEIT_ANSWER_TEXT && isCorrectRoundAnswer(answer))),
      buzzerAnswers: clone(questionBuzzerAnswers.filter(isCurrentRound)).sort(compareBuzzer),
      labelBuzzerAnswers: clone(questionBuzzerAnswers.filter((answer) => answer.status === "correct" && isCorrectRoundAnswer(answer))).sort(compareBuzzer),
    };
  }

  query(name: string, args: unknown[]) {
    const aggregate = this.requireActiveOrEnded();
    const params = isRecord(args[0]) ? args[0] : {};
    const session = aggregate.gameSession!;
    const nowMs = Date.now();
    switch (name) {
      case "getGameSessionById": {
        const currentSession = clone(session);
        currentSession.serverNow = nowIso(nowMs);
        return currentSession;
      }
      case "getQuestionsByQuestionSetId": return clone(aggregate.questions);
      case "getRoundSnapshot": return this.getSnapshot(nowMs);
      case "getGameBootstrapSnapshot": {
        const roundSnapshot = this.getSnapshot(nowMs);
        return { gameSession: clone(roundSnapshot.gameSession), questions: clone(aggregate.questions), roundSnapshot } satisfies GameBootstrapSnapshot;
      }
      case "getPlayerScores": return clone(aggregate.scores.filter((score) => this.participantIds(aggregate).has(score.playerId)));
      case "getLeaderboardForGameSession": return this.leaderboard();
      case "getGameResultSnapshot": return this.gameResultSnapshot();
      case "getRoomWithPlayers": return clone(aggregate.room ?? null);
      case "getPlayersByRoomId": return clone(aggregate.players);
      case "getQuestionResultsForQuestion": return clone(aggregate.questionResults.filter((result) => this.participantIds(aggregate).has(result.playerId) && result.questionIndex === Number(params.questionIndex)));
      case "getQuestionResultsForGameSession": return clone((aggregate.finalQuestionResults ?? aggregate.questionResults).filter((result) => this.participantIds(aggregate).has(result.playerId)));
      case "getAnswersForQuestion": return clone(aggregate.answers.filter((answer) => answer.questionIndex === Number(params.questionIndex)));
      case "getAnswersForQuestionRound": return clone(aggregate.answers.filter((answer) => answer.questionIndex === Number(params.questionIndex) && answer.revealRound === Number(params.revealRound)));
      case "getAnswerForPlayerRound": return clone(aggregate.answers.find((answer) => answer.questionIndex === Number(params.questionIndex) && answer.revealRound === Number(params.revealRound) && answer.playerId === params.playerId) ?? null);
      case "getBuzzerAnswersForQuestion": return clone(aggregate.buzzerAnswers.filter((answer) => answer.questionIndex === Number(params.questionIndex)).sort(compareBuzzer));
      case "getBuzzerAnswersForQuestionRound": return clone(aggregate.buzzerAnswers.filter((answer) => answer.questionIndex === Number(params.questionIndex) && answer.revealRound === Number(params.revealRound)).sort(compareBuzzer));
      case "getBuzzerAnswerForPlayerRound": return clone(aggregate.buzzerAnswers.find((answer) => answer.questionIndex === Number(params.questionIndex) && answer.revealRound === Number(params.revealRound) && answer.playerId === params.playerId) ?? null);
      default: throw new Error(`authority vNext 不支持查询 ${name}`);
    }
  }

  handleMutation(socket: WebSocket | null, envelope: VNextMutationEnvelope, receivedAtMs: number): VNextMutationOutcome {
    const aggregate = this.requireActiveOrEnded();
    if (envelope.gameId !== aggregate.gameId) return this.nonTerminalError("该操作属于旧游戏，请刷新后重试。");
    if (!envelope.actionId || !envelope.actorId || !Number.isInteger(envelope.clientSeq) || envelope.clientSeq < 1) {
      return this.nonTerminalError("实时操作 envelope 无效。");
    }
    const committed = aggregate.committedSeqByActor[envelope.actorId] ?? 0;
    if (envelope.clientSeq <= committed) {
      this.metrics.duplicates += 1;
      const rejection = aggregate.terminalRejections[`${envelope.actorId}:${envelope.clientSeq}`];
      if (rejection) return { ...this.terminalError(rejection), provisional: false, duplicate: true };
      return this.committedDuplicateOutcome(envelope);
    }
    const cached = this.recentActions.get(envelope.actionId);
    if (cached) {
      this.metrics.duplicates += 1;
      return { ...clone(cached), duplicate: true };
    }
    const seen = aggregate.seenSeqByActor[envelope.actorId] ?? committed;
    if (envelope.clientSeq <= seen) {
      this.metrics.duplicates += 1;
      const rejection = aggregate.terminalRejections[`${envelope.actorId}:${envelope.clientSeq}`];
      const replay = rejection ? this.terminalError(rejection) : { provisional: true, publicDeltas: [], presenterDeltas: [], playerDeltas: [] };
      return { ...replay, duplicate: true, forceCheckpoint: "replay" };
    }
    if (envelope.clientSeq !== seen + 1) return this.nonTerminalError(`操作乱序：服务端期望 clientSeq ${seen + 1}。`);
    const pending: VNextPendingMutation = {
      ...envelope,
      serverReceivedAtMs: receivedAtMs,
      orderToken: `${receivedAtMs}:${envelope.actorId}:${envelope.clientSeq}`,
    };
    let outcome: VNextMutationOutcome;
    try {
      outcome = this.applyMutation(pending, false);
    } catch (error) {
      if (!(error instanceof TerminalMutationError)) throw error;
      aggregate.seenSeqByActor[envelope.actorId] = envelope.clientSeq;
      aggregate.terminalRejections[`${envelope.actorId}:${envelope.clientSeq}`] = error.message;
      this.trimCommittedRejections(aggregate);
      this.markDirty();
      outcome = this.terminalError(error.message);
    }
    this.rememberAction(envelope.actionId, outcome);
    if (socket) this.safeAppendAttachment(socket, pending);
    this.metrics.provisionalAcks += 1;
    return outcome;
  }

  private applyMutation(action: VNextPendingMutation, replay: boolean): VNextMutationOutcome {
    const aggregate = this.requireActiveOrEnded();
    const session = aggregate.gameSession!;
    const payload = action.payload;
    if (QUESTION_SCOPED_MUTATION_NAMES.has(action.name) && action.questionIndex !== session.currentQuestionIndex) {
      throw new TerminalMutationError("题目已切换，本次操作未生效。");
    }
    const payloadActor = getActionActor(payload);
    if (payloadActor && payloadActor !== action.actorId) throw new Error("操作身份与 actorId 不一致。");
    let outcome: VNextMutationOutcome;
    switch (action.name) {
      case "confirmRevealBlocks": outcome = this.confirmRevealBlocks(action); break;
      case "submitAnswer": outcome = this.submitAnswer(action); break;
      case "submitForfeitAnswer": outcome = this.submitForfeit(action); break;
      case "cancelForfeitAnswer": outcome = this.cancelForfeit(action); break;
      case "submitBuzzerAnswer": outcome = this.submitBuzzer(action); break;
      case "judgeBuzzerAnswer": outcome = this.judgeBuzzer(action); break;
      case "setAnswerJudgements": outcome = this.setJudgements(action, false); break;
      case "markPendingRoundAnswersWrong": outcome = this.setJudgements(action, true); break;
      case "settleBuzzerRound": outcome = this.settleRound(action); break;
      case "autoForfeitExpiredRound": outcome = this.autoForfeit(action); break;
      case "gradeAnswersAndAdvance": outcome = this.gradeRoundReveal(action); break;
      case "completeTeamBattleBlockSelection": outcome = this.completeTeamBlockSelection(action); break;
      case "submitTeamBattleRevealVote": outcome = this.teamRevealVote(action); break;
      case "submitTeamBattleGuessVote": outcome = this.teamGuessVote(action); break;
      case "finalizeTeamBattleVote": outcome = this.finalizeTeamVote(action); break;
      case "judgeTeamBattleGuess": outcome = this.judgeTeamGuess(action); break;
      case "advanceTeamBattleTurn": outcome = this.advanceTeamTurn(action); break;
      case "revealTeamBattleAnswer": outcome = this.revealTeamAnswer(action); break;
      case "advanceReviewedQuestion": outcome = this.advanceQuestion(action, false); break;
      case "skipCurrentQuestion": outcome = this.advanceQuestion(action, true); break;
      case "endCurrentGameEarly": outcome = this.endGame(action, false); break;
      case "updateQuestionLabel": outcome = this.updateQuestionLabel(action); break;
      case "joinRoom": outcome = this.joinRoom(action); break;
      case "leaveRoom": outcome = this.leaveRoom(action, action.actorId); break;
      case "kickPlayerFromRoom": outcome = this.leaveRoom(action, getString(action.payload.targetPlayerId) ?? ""); break;
      case "updatePlayerRole": outcome = this.updatePlayerRole(action); break;
      case "dissolveRoom": outcome = this.dissolveRoom(action); break;
      case "cancelCurrentRound": outcome = this.cancelCurrentRound(action); break;
      case "returnRoomToLobby": outcome = this.returnRoomToLobby(action); break;
      default: throw new TerminalMutationError(`authority vNext 不支持操作 ${action.name}。`);
    }
    if (this.advancesPublicActivity(action.name, outcome)) {
      aggregate.lastPublicActivityAtMs = action.serverReceivedAtMs;
    }
    aggregate.seenSeqByActor[action.actorId] = action.clientSeq;
    if (outcome.publicDeltas.length > 0) aggregate.publicStateVersion += 1;
    this.markDirty();
    if (!replay) outcome.orderToken = action.orderToken;
    return outcome;
  }

  private confirmRevealBlocks(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertPresenter(action.actorId);
    if (session.roundStartedAt) throw new TerminalMutationError("本轮已经开始。");
    const raw = Array.isArray(action.payload.selectedBlocks) ? action.payload.selectedBlocks : [];
    const selected = raw.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 45);
    const nextBlocks = Array.from(new Set([...session.revealedBlocks, ...selected])).sort((a, b) => a - b);
    if (nextBlocks.length === session.revealedBlocks.length) throw new TerminalMutationError("请至少选择一个尚未打开的方块。");
    session.revealedBlocks = nextBlocks.length >= 45 ? ALL_REVEALED_BLOCKS : nextBlocks;
    session.roundStartedAt = nowIso(action.serverReceivedAtMs);
    session.serverNow = session.roundStartedAt;
    const runAtMs = action.serverReceivedAtMs + session.roundSeconds * 1000 + 3000;
    aggregate.deadline = { kind: "round", gameId: session.id, questionIndex: session.currentQuestionIndex, phaseKey: `round:${session.currentRevealRound}`, runAtMs };
    return this.directSessionOutcome(session, "phase-boundary", true);
  }

  private submitAnswer(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    if (session.gameMode !== "ROUND_REVEAL") throw new TerminalMutationError("当前模式不能提交普通答案。");
    this.assertCanAnswer(action.actorId, action.serverReceivedAtMs);
    const answerText = getString(action.payload.answerText);
    if (!answerText) throw new TerminalMutationError("请先输入答案。");
    const key = questionRoundKey(session.currentQuestionIndex, session.currentRevealRound, action.actorId);
    if (aggregate.questionResults.some((result) => result.questionIndex === session.currentQuestionIndex && result.playerId === action.actorId)) throw new TerminalMutationError("你已答对本题。");
    const existing = aggregate.answers.find((answer) => questionRoundKey(answer.questionIndex, answer.revealRound, answer.playerId) === key);
    const submittedAt = nowIso(action.serverReceivedAtMs);
    const answer: Answer = existing ? Object.assign(existing, { answerText, submittedAt }) : {
      id: action.actionId,
      gameSessionId: session.id,
      questionIndex: session.currentQuestionIndex,
      revealRound: session.currentRevealRound,
      playerId: action.actorId,
      answerText,
      submittedAt,
    };
    if (!existing) aggregate.answers.push(answer);
    let buzzer = aggregate.buzzerAnswers.find((item) => questionRoundKey(item.questionIndex, item.revealRound, item.playerId) === key);
    if (buzzer) Object.assign(buzzer, { answerText, submittedAt, serverReceivedAt: submittedAt, status: "pending", scoreAwarded: 0, judgedAt: null, judgedByPlayerId: null });
    else {
      buzzer = { id: `${action.actionId}:b`, gameSessionId: session.id, questionIndex: session.currentQuestionIndex, revealRound: session.currentRevealRound, playerId: action.actorId, answerText, status: "pending", scoreAwarded: 0, submittedAt, serverReceivedAt: submittedAt };
      aggregate.buzzerAnswers.push(buzzer);
    }
    const delta: RealtimeDelta = { scope: "game", type: "answer_submitted", answer: clone(answer), buzzerAnswer: clone(buzzer) };
    return { data: { ...clone(answer), buzzerAnswer: clone(buzzer) }, provisional: true, publicDeltas: [this.publicAnswerProgress([answer], [buzzer])], presenterDeltas: [delta], answerViewerDeltas: [delta], playerDeltas: [] };
  }

  private submitForfeit(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertCanAnswer(action.actorId, action.serverReceivedAtMs);
    const existingResult = aggregate.questionResults.some((result) => result.questionIndex === session.currentQuestionIndex && result.playerId === action.actorId);
    if (existingResult) throw new TerminalMutationError("你已答对本题。");
    const key = questionRoundKey(session.currentQuestionIndex, session.currentRevealRound, action.actorId);
    const submittedAt = nowIso(action.serverReceivedAtMs);
    let answer = aggregate.answers.find((item) => questionRoundKey(item.questionIndex, item.revealRound, item.playerId) === key);
    if (answer) Object.assign(answer, { answerText: FORFEIT_ANSWER_TEXT, submittedAt });
    else {
      answer = { id: action.actionId, gameSessionId: session.id, questionIndex: session.currentQuestionIndex, revealRound: session.currentRevealRound, playerId: action.actorId, answerText: FORFEIT_ANSWER_TEXT, submittedAt };
      aggregate.answers.push(answer);
    }
    aggregate.buzzerAnswers = aggregate.buzzerAnswers.filter((item) => questionRoundKey(item.questionIndex, item.revealRound, item.playerId) !== key || item.status !== "pending");
    const delta: RealtimeDelta = { scope: "game", type: "answer_submitted", answer: clone(answer) };
    return { data: clone(answer), provisional: true, publicDeltas: [this.publicAnswerProgress([answer], [])], presenterDeltas: [delta], answerViewerDeltas: [delta], playerDeltas: [] };
  }

  private cancelForfeit(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertCanAnswer(action.actorId, action.serverReceivedAtMs);
    const index = aggregate.answers.findIndex((answer) => answer.questionIndex === session.currentQuestionIndex && answer.revealRound === session.currentRevealRound && answer.playerId === action.actorId && answer.answerText === FORFEIT_ANSWER_TEXT);
    if (index < 0) throw new TerminalMutationError("当前没有可取消的放弃状态。");
    const [removed] = aggregate.answers.splice(index, 1);
    const data = { gameSession: clone(session), canceledAnswerId: removed.id };
    const delta: RealtimeDelta = { scope: "game", type: "answer_canceled", gameSession: clone(session), canceledAnswerId: removed.id, canceledPlayerId: action.actorId };
    return { data, provisional: true, publicDeltas: [this.publicAnswerProgress([], [], { canceledPlayerIds: [action.actorId] })], presenterDeltas: [delta], answerViewerDeltas: [delta], playerDeltas: [{ playerId: action.actorId, delta }] };
  }

  private submitBuzzer(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    if (session.gameMode !== "BUZZER_FIRST_CORRECT" && session.gameMode !== "BUZZER_RANKED") throw new TerminalMutationError("当前模式不能抢答。");
    this.assertCanAnswer(action.actorId, action.serverReceivedAtMs);
    const answerText = getString(action.payload.answerText);
    if (!answerText) throw new TerminalMutationError("请先输入抢答答案。");
    if (aggregate.buzzerAnswers.some((answer) => answer.questionIndex === session.currentQuestionIndex && answer.revealRound === session.currentRevealRound && answer.playerId === action.actorId)) throw new TerminalMutationError("你本轮已经提交过抢答。");
    if (session.gameMode === "BUZZER_FIRST_CORRECT" && aggregate.questionResults.some((result) => result.questionIndex === session.currentQuestionIndex)) throw new TerminalMutationError("本题已有玩家答对。");
    const submittedAt = nowIso(action.serverReceivedAtMs);
    const answer: BuzzerAnswer = { id: action.actionId, gameSessionId: session.id, questionIndex: session.currentQuestionIndex, revealRound: session.currentRevealRound, playerId: action.actorId, answerText, status: "pending", scoreAwarded: 0, submittedAt, serverReceivedAt: submittedAt };
    aggregate.buzzerAnswers.push(answer);
    const delta: RealtimeDelta = { scope: "game", type: "buzzer_answer_submitted", buzzerAnswer: clone(answer) };
    return { data: clone(answer), provisional: true, publicDeltas: [this.publicAnswerProgress([], [answer])], presenterDeltas: [delta], answerViewerDeltas: [delta], playerDeltas: [] };
  }

  private judgeBuzzer(action: VNextPendingMutation): VNextMutationOutcome {
    const answerId = getString(action.payload.buzzerAnswerId);
    if (!answerId || typeof action.payload.isCorrect !== "boolean") throw new TerminalMutationError("答案判定参数无效。");
    const outcome = this.applyJudgements(action, [{ buzzerAnswerId: answerId, isCorrect: action.payload.isCorrect }]);
    const judged = outcome.judgedAnswers.find((answer) => answer.id === answerId)!;
    const delta: RealtimeDelta = { scope: "game", type: "buzzer_answer_judged", ...(outcome.sessionChanged ? { gameSession: clone(this.requireActive().gameSession!) } : {}), buzzerAnswer: clone(judged), buzzerAnswers: clone(outcome.allAnswers), scores: clone(outcome.changedScores), questionResults: clone(outcome.changedQuestionResults), removedQuestionResultPlayerIds: outcome.removedQuestionResultPlayerIds };
    return {
      data: { gameSession: clone(this.requireActive().gameSession!), judgedAnswer: clone(judged), changedAnswers: clone(outcome.changedAnswers), scores: clone(outcome.scores), questionResults: clone(outcome.questionResults), buzzerAnswers: clone(outcome.allAnswers) },
      provisional: true,
      publicDeltas: [this.publicAnswerProgress([], outcome.changedAnswers, { gameSession: outcome.sessionChanged ? this.requireActive().gameSession! : undefined, scores: outcome.changedScores, questionResults: outcome.changedQuestionResults, removedQuestionResultPlayerIds: outcome.removedQuestionResultPlayerIds })],
      presenterDeltas: [delta],
      playerDeltas: this.playerJudgementDeltas(outcome.changedAnswers, outcome),
      playerBackfillDeltas: this.playerAnswerBackfills(outcome.newlyCorrectPlayerIds, outcome.allAnswers),
      ...(this.requireActive().gameSession!.gameMode === "BUZZER_FIRST_CORRECT" && judged.status === "correct" ? { forceCheckpoint: "phase-boundary" as const, deadlineChanged: true } : {}),
    };
  }

  private setJudgements(action: VNextPendingMutation, allPendingWrong: boolean): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    const requested = allPendingWrong
      ? aggregate.buzzerAnswers.filter((answer) => answer.questionIndex === session.currentQuestionIndex && answer.revealRound === session.currentRevealRound && answer.status === "pending").map((answer) => ({ buzzerAnswerId: answer.id, isCorrect: false }))
      : Array.isArray(action.payload.judgements) ? action.payload.judgements.filter(isRecord).map((item) => ({ buzzerAnswerId: getString(item.buzzerAnswerId) ?? "", isCorrect: item.isCorrect === true })) : [];
    if (!requested.length) throw new TerminalMutationError("没有需要提交的答案判定。");
    const outcome = this.applyJudgements(action, requested);
    const delta: RealtimeDelta = { scope: "game", type: "answer_judgements_changed", ...(outcome.sessionChanged ? { gameSession: clone(session) } : {}), answers: clone(outcome.changedAnswers), scores: clone(outcome.changedScores), questionResults: clone(outcome.changedQuestionResults), removedQuestionResultPlayerIds: outcome.removedQuestionResultPlayerIds };
    return {
      data: { gameSession: clone(session), judgedAnswers: clone(outcome.changedAnswers), scores: clone(outcome.scores), questionResults: clone(outcome.questionResults) },
      provisional: true,
      publicDeltas: [this.publicAnswerProgress([], outcome.changedAnswers, { gameSession: outcome.sessionChanged ? session : undefined, scores: outcome.changedScores, questionResults: outcome.changedQuestionResults, removedQuestionResultPlayerIds: outcome.removedQuestionResultPlayerIds })],
      presenterDeltas: [delta],
      playerDeltas: this.playerJudgementDeltas(outcome.changedAnswers, outcome),
      playerBackfillDeltas: this.playerAnswerBackfills(outcome.newlyCorrectPlayerIds, outcome.allAnswers),
    };
  }

  private applyJudgements(action: VNextPendingMutation, requested: Array<{ buzzerAnswerId: string; isCorrect: boolean }>) {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    const previousScores = new Map(aggregate.scores.map((score) => [score.playerId, `${score.score}:${score.correctCount}`]));
    const previousResults = new Map(aggregate.questionResults.filter((result) => result.questionIndex === session.currentQuestionIndex).map((result) => [result.playerId, JSON.stringify(result)]));
    const previousAnswers = new Map(aggregate.buzzerAnswers.filter((answer) => answer.questionIndex === session.currentQuestionIndex).map((answer) => [answer.id, `${answer.status}:${answer.scoreAwarded}`]));
    this.assertPresenter(action.actorId);
    const current = aggregate.buzzerAnswers.filter((answer) => answer.questionIndex === session.currentQuestionIndex && answer.revealRound === session.currentRevealRound).sort(compareBuzzer);
    const byId = new Map(current.map((answer) => [answer.id, answer]));
    const targets = requested.map((request) => {
      const answer = byId.get(request.buzzerAnswerId);
      if (!answer) throw new TerminalMutationError("部分回答已不属于当前轮。");
      if (action.serverReceivedAtMs - new Date(answer.serverReceivedAt).getTime() < 3000 && answer.status === "pending") throw new TerminalMutationError("回答提交满3秒后才能判定。");
      return { answer, isCorrect: request.isCorrect };
    });
    if (session.gameMode === "BUZZER_FIRST_CORRECT") {
      const statuses = new Map(current.map((answer) => [answer.id, answer.status]));
      for (const target of targets) statuses.set(target.answer.id, target.isCorrect ? "correct" : "wrong");
      const correctIndex = current.findIndex((answer) => statuses.get(answer.id) === "correct");
      if (correctIndex >= 0 && current.slice(0, correctIndex).some((answer) => statuses.get(answer.id) !== "wrong")) throw new TerminalMutationError("首位答对模式必须按提交顺序判定。");
      if (current.filter((answer) => statuses.get(answer.id) === "correct").length > 1) throw new TerminalMutationError("首位答对模式只能有一名答对玩家。");
    }
    const judgedAt = nowIso(action.serverReceivedAtMs);
    const roundScore = session.gameMode === "BUZZER_FIRST_CORRECT" ? 1 : session.roundScores[session.currentRevealRound - 1] ?? Math.max(1, session.maxRevealRounds - session.currentRevealRound + 1);
    for (const { answer, isCorrect } of targets) {
      Object.assign(answer, { status: isCorrect ? "correct" : "wrong", scoreAwarded: isCorrect ? roundScore : 0, judgedAt, judgedByPlayerId: action.actorId });
      aggregate.questionResults = aggregate.questionResults.filter((result) => !(result.questionIndex === session.currentQuestionIndex && result.playerId === answer.playerId));
      if (isCorrect) aggregate.questionResults.push({ id: `${session.id}:${session.currentQuestionIndex}:${answer.playerId}`, gameSessionId: session.id, questionIndex: session.currentQuestionIndex, playerId: answer.playerId, scoredRound: session.currentRevealRound, scoreAwarded: roundScore, judgedByPlayerId: action.actorId, judgedAt });
    }
    if (session.gameMode === "BUZZER_RANKED") {
      const correct = aggregate.buzzerAnswers
        .filter((answer) => answer.questionIndex === session.currentQuestionIndex && answer.status === "correct")
        .sort(compareBuzzer);
      const eligibleCount = session.eligiblePlayerIds?.length ?? aggregate.scores.length;
      aggregate.questionResults = aggregate.questionResults.filter((result) => result.questionIndex !== session.currentQuestionIndex);
      correct.forEach((answer, index) => {
        answer.scoreAwarded = Math.max(1, eligibleCount - index);
        aggregate.questionResults.push({
          id: `${session.id}:${session.currentQuestionIndex}:${answer.playerId}`,
          gameSessionId: session.id,
          questionIndex: session.currentQuestionIndex,
          playerId: answer.playerId,
          scoredRound: answer.revealRound,
          scoreAwarded: answer.scoreAwarded,
          judgedByPlayerId: answer.judgedByPlayerId ?? action.actorId,
          judgedAt: answer.judgedAt ?? judgedAt,
        });
      });
    }
    this.recalculateScores();
    let sessionChanged = false;
    if (session.gameMode === "BUZZER_FIRST_CORRECT" && current.some((answer) => answer.status === "correct")) {
      session.revealedBlocks = ALL_REVEALED_BLOCKS;
      session.roundStartedAt = null;
      aggregate.deadline = null;
      sessionChanged = true;
    }
    const currentResults = aggregate.questionResults.filter((result) => result.questionIndex === session.currentQuestionIndex);
    const currentResultPlayers = new Set(currentResults.map((result) => result.playerId));
    const allAnswers = aggregate.buzzerAnswers.filter((answer) => answer.questionIndex === session.currentQuestionIndex).sort(compareBuzzer);
    return {
      judgedAnswers: targets.map(({ answer }) => answer),
      changedAnswers: allAnswers.filter((answer) => previousAnswers.get(answer.id) !== `${answer.status}:${answer.scoreAwarded}`),
      allAnswers,
      scores: aggregate.scores,
      questionResults: currentResults,
      changedScores: aggregate.scores.filter((score) => previousScores.get(score.playerId) !== `${score.score}:${score.correctCount}`),
      changedQuestionResults: currentResults.filter((result) => previousResults.get(result.playerId) !== JSON.stringify(result)),
      removedQuestionResultPlayerIds: [...previousResults.keys()].filter((playerId) => !currentResultPlayers.has(playerId)),
      newlyCorrectPlayerIds: [...currentResultPlayers].filter((playerId) => !previousResults.has(playerId)),
      sessionChanged,
    };
  }

  private settleRound(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertPresenter(action.actorId);
    const questionGuesserIds = this.activeQuestionGuesserIds(aggregate);
    const questionGuesserIdSet = new Set(questionGuesserIds);
    const currentEligiblePlayerIds = this.currentRoundEligiblePlayerIds(aggregate, questionGuesserIds);
    const current = aggregate.buzzerAnswers.filter((answer) => questionGuesserIdSet.has(answer.playerId) && answer.questionIndex === session.currentQuestionIndex && answer.revealRound === session.currentRevealRound);
    const deadlineArrived = Boolean(aggregate.deadline && action.serverReceivedAtMs >= aggregate.deadline.runAtMs);
    if (deadlineArrived) this.addMissingForfeits(action);
    const hasCorrect = current.some((answer) => answer.status === "correct");
    const allCorrect = questionGuesserIds.length > 0 && currentEligiblePlayerIds.length === 0;
    if (allCorrect || (session.gameMode === "BUZZER_FIRST_CORRECT" && hasCorrect)) {
      session.revealedBlocks = ALL_REVEALED_BLOCKS;
    } else if (current.some((answer) => answer.status === "pending")) {
      return this.publicSessionOutcome(session);
    } else {
      const allUsedChance = currentEligiblePlayerIds.every((playerId) => current.some((answer) => answer.playerId === playerId) || aggregate.answers.some((answer) => answer.questionIndex === session.currentQuestionIndex && answer.revealRound === session.currentRevealRound && answer.playerId === playerId));
      if (!deadlineArrived && !allUsedChance) return this.publicSessionOutcome(session);
      if (session.currentRevealRound < session.maxRevealRounds) session.currentRevealRound += 1;
      else session.revealedBlocks = ALL_REVEALED_BLOCKS;
    }
    session.roundStartedAt = null;
    aggregate.deadline = null;
    return this.publicSessionOutcome(session, "phase-boundary", true);
  }

  private autoForfeit(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    if (!aggregate.deadline || action.serverReceivedAtMs < aggregate.deadline.runAtMs) return this.publicSessionOutcome(session);
    const addedForfeits = this.addMissingForfeits(action);
    aggregate.deadline = null;
    const outcome = this.publicSessionOutcome(session, "deadline", true);
    if (addedForfeits.length) outcome.publicDeltas.push(this.publicAnswerProgress(addedForfeits, []));
    return outcome;
  }

  private gradeRoundReveal(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertPresenter(action.actorId);
    if (session.gameMode !== "ROUND_REVEAL" || !session.roundStartedAt) throw new TerminalMutationError("当前轮不能判分。");
    const eligible = new Set(session.eligiblePlayerIds ?? []);
    const correct = Array.isArray(action.payload.correctPlayerIds) ? Array.from(new Set(action.payload.correctPlayerIds.filter((id): id is string => typeof id === "string" && eligible.has(id)))) : [];
    const score = session.roundScores[session.currentRevealRound - 1] ?? Math.max(1, session.maxRevealRounds - session.currentRevealRound + 1);
    const existing = new Set(aggregate.questionResults.filter((result) => result.questionIndex === session.currentQuestionIndex).map((result) => result.playerId));
    const newly: string[] = [];
    for (const playerId of correct) {
      if (existing.has(playerId)) continue;
      aggregate.questionResults.push({ id: `${session.id}:${session.currentQuestionIndex}:${playerId}`, gameSessionId: session.id, questionIndex: session.currentQuestionIndex, playerId, scoredRound: session.currentRevealRound, scoreAwarded: score, judgedByPlayerId: action.actorId, judgedAt: nowIso(action.serverReceivedAtMs) });
      newly.push(playerId);
    }
    this.recalculateScores();
    const allCorrect = eligible.size > 0 && [...eligible].every((id) => aggregate.questionResults.some((result) => result.questionIndex === session.currentQuestionIndex && result.playerId === id));
    session.roundStartedAt = null;
    aggregate.deadline = null;
    if (allCorrect) session.revealedBlocks = ALL_REVEALED_BLOCKS;
    const data = { gameSession: clone(session), room: null, newlyScoredPlayerIds: newly };
    return { data, provisional: true, publicDeltas: [{ scope: "game", type: "round_snapshot", snapshot: this.getSnapshot() }], presenterDeltas: [], playerDeltas: [], forceCheckpoint: "phase-boundary", deadlineChanged: true };
  }

  private completeTeamBlockSelection(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertPresenter(action.actorId);
    const state = session.teamBattleState;
    if (!state || session.gameMode !== "TEAM_BATTLE") throw new TerminalMutationError("当前不是红蓝对抗模式。");
    const blockCount = normalizeRevealBlockCount(action.payload.revealBlockCount ?? state.revealBlockCount);
    const disabledBlocks = normalizeDisabledBlocks(action.payload.disabledBlocks, blockCount);
    if (state.phase !== "PRESENTER_BLOCK") {
      const isCompletedRetry =
        Array.isArray(state.disabledBlocks) &&
        normalizeRevealBlockCount(state.revealBlockCount) === blockCount &&
        disabledBlocks.length === state.disabledBlocks.length &&
        disabledBlocks.every((block, index) => block === state.disabledBlocks?.[index]);
      if (isCompletedRetry) return this.publicSessionOutcome(session);
      throw new TerminalMutationError("禁用已确认，不能再次修改。");
    }
    state.revealBlockCount = blockCount;
    state.disabledBlocks = disabledBlocks;
    state.revealVotes = {};
    state.guessVotes = {};
    state.guessProposals = [];
    state.pendingGuess = null;
    const selectable = selectableTeamBlocks(session, state, blockCount);
    const nextPhase = selectable.length > 0 ? "REVEAL_VOTE" : "GUESS_VOTE";
    state.message = selectable.length > 0
      ? disabledBlocks.length > 0
        ? `已禁用 ${disabledBlocks.length} 格 · ${teamName(state.activeTeam)}选格`
        : `未禁用格子 · ${teamName(state.activeTeam)}选格`
      : `全部格子已禁用 · ${teamName(state.activeTeam)}猜测`;
    this.startTeamVoteDeadline(state, nextPhase, action.serverReceivedAtMs);
    if (!getTeamMembers(state, "red").length && !getTeamMembers(state, "blue").length) {
      state.message = "禁用完成 · 等待出题人公布答案";
    }
    return this.publicSessionOutcome(session, "phase-boundary", true);
  }

  private teamRevealVote(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertTeamVoter(action.actorId, "REVEAL_VOTE", action.serverReceivedAtMs);
    const state = session.teamBattleState!;
    const blockCount = normalizeRevealBlockCount(action.payload.revealBlockCount ?? state.revealBlockCount);
    const remaining = selectableTeamBlocks(session, state, blockCount);
    const required = Math.min(state.revealLimit, remaining.length);
    const selected = Array.isArray(action.payload.selectedBlocks) ? Array.from(new Set(action.payload.selectedBlocks.filter((block): block is number => typeof block === "number" && remaining.includes(block)))).sort((a, b) => a - b) : [];
    if (selected.length !== required) throw new TerminalMutationError("本轮选择的方块数量不正确。");
    state.revealVotes[action.actorId] = selected;
    state.revealBlockCount = blockCount;
    const deadlineChanged = this.shortenTeamVoteDeadlineIfComplete(state, action.serverReceivedAtMs);
    return this.directSessionOutcome(session, deadlineChanged ? "phase-boundary" : undefined, deadlineChanged);
  }

  private teamGuessVote(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertTeamVoter(action.actorId, "GUESS_VOTE", action.serverReceivedAtMs);
    const state = session.teamBattleState!;
    const proposalByAnswer = rebuildTeamGuessProposals(
      state,
      (playerId) => state.teamMemberNames?.[playerId] ?? aggregate.players.find((player) => player.id === playerId)?.nickname,
    );
    const rawVote = isRecord(action.payload.vote) ? action.payload.vote : {};
    const answerText = normalizeTeamGuessAnswer(getString(rawVote.answerText));
    const vote: TeamBattleGuessVote = rawVote.type === "skip" ? { type: "skip" } : { type: "guess", answerText };
    if (vote.type === "guess" && !vote.answerText) throw new TerminalMutationError("请输入要猜的答案。");
    if (vote.type === "guess" && vote.answerText.length > MAX_TEAM_BATTLE_GUESS_LENGTH) throw new TerminalMutationError(`猜测答案不能超过 ${MAX_TEAM_BATTLE_GUESS_LENGTH} 个字符。`);
    if (vote.type === "guess") {
      let proposal = proposalByAnswer.get(vote.answerText);
      if (!proposal) {
        proposal = {
          answerText: vote.answerText,
          proposerPlayerId: action.actorId,
          proposerName: state.teamMemberNames?.[action.actorId] ?? aggregate.players.find((player) => player.id === action.actorId)?.nickname ?? "已离开玩家",
        };
        state.guessProposals!.push(proposal);
      }
      vote.answerText = proposal.answerText;
    }
    state.guessVotes[action.actorId] = vote;
    pruneUnusedTeamGuessProposals(state);
    const deadlineChanged = this.shortenTeamVoteDeadlineIfComplete(state, action.serverReceivedAtMs);
    return this.directSessionOutcome(session, deadlineChanged ? "phase-boundary" : undefined, deadlineChanged);
  }

  private finalizeTeamVote(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    const state = session.teamBattleState;
    if (action.actorId !== "__server__") {
      this.assertPresenter(action.actorId);
      if (
        !state ||
        action.payload.expectedPhase !== state.phase ||
        getInteger(action.payload.expectedTurnNumber) !== state.turnNumber ||
        getString(action.payload.expectedVoteDeadlineAt) !== state.voteDeadlineAt
      ) {
        return this.publicSessionOutcome(session);
      }
    }
    if (!state || !state.voteDeadlineAt || action.serverReceivedAtMs < new Date(state.voteDeadlineAt).getTime()) return this.publicSessionOutcome(session);
    if (!getTeamMembers(state, state.activeTeam).length) {
      const availableTeam = oppositeTeam(state.activeTeam);
      state.revealVotes = {};
      state.guessVotes = {};
      state.guessProposals = [];
      state.pendingGuess = null;
      if (getTeamMembers(state, availableTeam).length) {
        state.activeTeam = availableTeam;
        this.startTeamVoteDeadline(state, state.phase, action.serverReceivedAtMs);
        state.message = `${teamName(oppositeTeam(availableTeam))}没有在线队员，轮到${teamName(availableTeam)}。`;
      } else {
        state.voteDeadlineAt = null;
        aggregate.deadline = null;
        state.message = "双方都没有在线队员，已停止自动投票，请出题人公布答案或结束游戏。";
      }
      return this.publicSessionOutcome(session, "phase-boundary", true);
    }
    if (state.phase === "REVEAL_VOTE") {
      const blockCount = normalizeRevealBlockCount(state.revealBlockCount);
      const selectable = selectableTeamBlocks(session, state, blockCount);
      const counts = new Map(
        selectable.map((block) => [block, 0]),
      );
      for (const blocks of Object.values(state.revealVotes)) {
        for (const block of blocks) if (counts.has(block)) counts.set(block, (counts.get(block) ?? 0) + 1);
      }
      const count = Math.min(state.revealLimit, selectable.length);
      const remaining = [...counts.keys()];
      const selected: number[] = [];
      let tieMessage = "";
      while (selected.length < count && remaining.length) {
        const highest = Math.max(...remaining.map((block) => counts.get(block) ?? 0));
        const tied = remaining.filter((block) => (counts.get(block) ?? 0) === highest);
        const slots = count - selected.length;
        if (tied.length <= slots) {
          selected.push(...tied);
        } else {
          const shuffled = this.shuffle(tied);
          const randomSelection = shuffled.slice(0, slots);
          selected.push(...randomSelection);
          tieMessage = `由于多个方块同票，随机选择了 ${randomSelection.map((block) => block + 1).join("、")}。`;
        }
        for (const block of tied) remaining.splice(remaining.indexOf(block), 1);
      }
      session.revealedBlocks = Array.from(new Set([...session.revealedBlocks, ...selected])).sort((a, b) => a - b);
      Object.assign(state, {
        phase: "GUESS_VOTE",
        revealVotes: {},
        guessVotes: {},
        guessProposals: [],
        pendingGuess: null,
        message: `${teamName(state.activeTeam)}打开了 ${selected.map((block) => block + 1).join("、")} 号方块。${tieMessage}`,
      });
      this.startTeamVoteDeadline(state, "GUESS_VOTE", action.serverReceivedAtMs);
      return this.publicSessionOutcome(session, "phase-boundary", true);
    }
    if (state.phase !== "GUESS_VOTE") return this.publicSessionOutcome(session);
    const proposalByAnswer = rebuildTeamGuessProposals(
      state,
      (playerId) => state.teamMemberNames?.[playerId] ?? aggregate.players.find((player) => player.id === playerId)?.nickname,
    );
    const options = new Map<string, { vote: TeamBattleGuessVote; count: number }>();
    for (const vote of Object.values(state.guessVotes)) {
      const key = vote.type === "skip" ? "skip" : `guess:${vote.answerText?.trim()}`;
      const current = options.get(key);
      options.set(key, {
        vote,
        count: (current?.count ?? 0) + 1,
      });
    }
    const noVotes = options.size === 0;
    const highest = noVotes ? 0 : Math.max(...[...options.values()].map((option) => option.count));
    const tiedOptions = noVotes
      ? [{ vote: { type: "skip" as const }, count: 0 }]
      : [...options.values()].filter((option) => option.count === highest);
    const winningOption = tiedOptions.length > 1
      ? tiedOptions[Math.min(tiedOptions.length - 1, Math.floor(this.random() * tiedOptions.length))]
      : tiedOptions[0];
    const winner = winningOption?.vote;
    if (!winner) throw new TerminalMutationError("当前没有可结算的投票。");
    const tieMessage = noVotes
      ? "由于无人提交，视为不猜。"
      : tiedOptions.length > 1
        ? `由于最高票选项票数相同，随机选择了${winner.type === "skip" ? "不猜" : `猜「${winner.answerText}」`}。`
        : "";
    if (winner.type === "skip") {
      state.phase = "TURN_RESULT";
      state.previousTurnAction = { team: state.activeTeam, type: "skip" };
      state.pendingGuess = null;
      state.message = `${teamName(state.activeTeam)}选择不猜。${tieMessage}`;
      state.voteDeadlineAt = null;
      aggregate.deadline = null;
    } else {
      const winningProposal = proposalByAnswer.get(normalizeTeamGuessAnswer(winner.answerText));
      state.phase = "JUDGING";
      state.pendingGuess = {
        team: state.activeTeam,
        answerText: winner.answerText?.trim() ?? "",
        proposerPlayerId: winningProposal?.proposerPlayerId,
        proposerName: winningProposal?.proposerName,
      };
      state.message = `${teamName(state.activeTeam)}决定猜「${state.pendingGuess.answerText}」。${tieMessage}`;
      state.voteDeadlineAt = null;
      aggregate.deadline = null;
    }
    state.revealVotes = {};
    state.guessVotes = {};
    state.guessProposals = [];
    return this.publicSessionOutcome(session, "phase-boundary", true);
  }

  private judgeTeamGuess(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertPresenter(action.actorId);
    const state = session.teamBattleState;
    if (!state || state.phase !== "JUDGING" || !state.pendingGuess || typeof action.payload.isCorrect !== "boolean") throw new TerminalMutationError("当前没有待判定的队伍猜测。");
    const guessedBy = state.pendingGuess.team;
    let scoredPlayerIds: string[] = [];
    if (action.payload.isCorrect) {
      const members = getTeamMembers(state, guessedBy);
      if (!members.length) throw new TerminalMutationError("猜测队伍已经没有成员。");
      state.correctGuess = clone(state.pendingGuess);
      scoredPlayerIds = members;
      for (const playerId of members) {
        aggregate.questionResults = aggregate.questionResults.filter((result) => !(result.questionIndex === session.currentQuestionIndex && result.playerId === playerId));
        aggregate.questionResults.push({ id: `${session.id}:${session.currentQuestionIndex}:${playerId}`, gameSessionId: session.id, questionIndex: session.currentQuestionIndex, playerId, scoredRound: session.currentRevealRound, scoreAwarded: 1, judgedByPlayerId: action.actorId, judgedAt: nowIso(action.serverReceivedAtMs) });
      }
      state.teamScores[guessedBy] += 1;
      state.phase = "REVIEW";
      session.revealedBlocks = ALL_REVEALED_BLOCKS;
      session.roundStartedAt = null;
      this.recalculateScores();
    } else {
      state.phase = "TURN_RESULT";
      state.previousTurnAction = { team: guessedBy, type: "guess", answerText: state.pendingGuess.answerText };
      state.message = `${teamName(guessedBy)}猜测「${state.pendingGuess.answerText}」，猜测错误。`;
      state.voteDeadlineAt = null;
      aggregate.deadline = null;
    }
    state.pendingGuess = null;
    if (state.phase === "REVIEW") state.voteDeadlineAt = null;
    state.revealVotes = {};
    state.guessVotes = {};
    state.guessProposals = [];
    if (state.phase === "REVIEW") aggregate.deadline = null;
    const outcome = this.publicSessionOutcome(session, "phase-boundary", true);
    if (scoredPlayerIds.length) {
      const scored = new Set(scoredPlayerIds);
      outcome.publicDeltas.push(this.publicAnswerProgress([], [], {
        scores: aggregate.scores.filter((score) => scored.has(score.playerId)),
        questionResults: aggregate.questionResults.filter((result) => result.questionIndex === session.currentQuestionIndex && scored.has(result.playerId)),
      }));
    }
    return outcome;
  }

  private advanceTeamTurn(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertPresenter(action.actorId);
    const state = session.teamBattleState;
    if (
      !state ||
      state.phase !== "TURN_RESULT" ||
      !state.previousTurnAction ||
      getInteger(action.payload.expectedTurnNumber) !== state.turnNumber
    ) {
      return this.publicSessionOutcome(session);
    }

    const previous = state.previousTurnAction.team;
    const opposing = oppositeTeam(previous);
    const nextTeam = getTeamMembers(state, opposing).length
      ? opposing
      : getTeamMembers(state, previous).length
        ? previous
        : null;
    if (!nextTeam) throw new TerminalMutationError("没有可继续行动的队伍，请公布答案或结束游戏。");

    state.activeTeam = nextTeam;
    const blockCount = normalizeRevealBlockCount(state.revealBlockCount);
    const nextPhase = selectableTeamBlocks(session, state, blockCount).length === 0 ? "GUESS_VOTE" : "REVEAL_VOTE";
    state.revealLimit = state.previousTurnAction.type === "guess" ? 2 : 1;
    state.turnNumber += 1;
    session.currentRevealRound += 1;
    state.revealVotes = {};
    state.guessVotes = {};
    state.guessProposals = [];
    state.pendingGuess = null;
    state.message = nextPhase === "REVEAL_VOTE"
      ? `${teamName(nextTeam)}本回合可以打开 ${state.revealLimit} 个方块。`
      : `图片已全部打开，轮到${teamName(nextTeam)}决定是否猜测。`;
    this.startTeamVoteDeadline(state, nextPhase, action.serverReceivedAtMs);
    return this.publicSessionOutcome(session, "phase-boundary", true);
  }

  private revealTeamAnswer(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertPresenter(action.actorId);
    const state = session.teamBattleState;
    if (!state) throw new TerminalMutationError("当前不是红蓝对抗模式。");
    Object.assign(state, { phase: "REVIEW", voteDeadlineAt: null, revealVotes: {}, guessVotes: {}, guessProposals: [], pendingGuess: null });
    session.revealedBlocks = ALL_REVEALED_BLOCKS;
    session.roundStartedAt = null;
    aggregate.deadline = null;
    return this.publicSessionOutcome(session, "phase-boundary", true);
  }

  private advanceQuestion(action: VNextPendingMutation, skipped: boolean): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertPresenter(action.actorId);
    const expected = getInteger(action.payload.expectedQuestionIndex);
    if (expected != null && expected !== session.currentQuestionIndex) throw new TerminalMutationError("题目已变化，请刷新后重试。");
    if (!skipped && (session.roundStartedAt || session.revealedBlocks.length !== ALL_REVEALED_BLOCKS.length)) {
      throw new TerminalMutationError("当前还没有进入完整图片复盘阶段，不能进入下一题。");
    }
    if (session.currentQuestionIndex + 1 >= aggregate.questions.length) return this.endGame(action, true);
    this.captureCurrentQuestionArchive();
    aggregate.scoreBaseline = Object.fromEntries(aggregate.scores.map((score) => [score.playerId, { score: score.score, correctCount: score.correctCount }]));
    session.currentQuestionIndex += 1;
    session.currentRevealRound = 1;
    session.revealedBlocks = [];
    session.roundStartedAt = null;
    session.eligiblePlayerIds = this.eligiblePlayers(aggregate.players, session.presenterPlayerId);
    if (session.gameMode === "TEAM_BATTLE") {
      session.teamBattleState = this.resetTeamState(session.teamBattleState, aggregate.players, session.presenterPlayerId, session.currentQuestionIndex);
      if (session.teamBattleState.phase === "REVEAL_VOTE") {
        this.startTeamVoteDeadline(session.teamBattleState, "REVEAL_VOTE", action.serverReceivedAtMs);
      } else {
        aggregate.deadline = null;
      }
    } else {
      aggregate.deadline = null;
    }
    aggregate.answers = [];
    aggregate.buzzerAnswers = [];
    aggregate.questionResults = [];
    const data = { gameSession: clone(session), room: clone(aggregate.room ?? null), skipped };
    return { data, provisional: true, publicDeltas: [{ scope: "game", type: "round_snapshot", snapshot: this.getSnapshot() }], presenterDeltas: [], playerDeltas: [], forceCheckpoint: "phase-boundary", archiveQuestion: true, deadlineChanged: true };
  }

  private endGame(action: VNextPendingMutation, completedNormally: boolean): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertPresenter(action.actorId);
    this.captureCurrentQuestionArchive();
    const endedAt = nowIso(action.serverReceivedAtMs);
    session.status = "GAME_RESULT";
    session.endedAt = endedAt;
    session.completedNormallyAt = completedNormally ? endedAt : null;
    session.roundStartedAt = null;
    aggregate.deadline = null;
    aggregate.cutoverState = "ended";
    aggregate.finalQuestionResults = clone(aggregate.questionResults);
    aggregate.finalLeaderboard = this.leaderboard();
    if (aggregate.room) {
      aggregate.room.status = "GAME_RESULT";
      aggregate.room.currentGameId = session.id;
    }
    this.prepareFinalResultsFromArchives();
    const snapshot = this.gameResultSnapshot();
    const publicDeltas: RealtimeDelta[] = [{ scope: "game", type: "game_result_snapshot", snapshot }];
    if (aggregate.room) publicDeltas.push({ scope: "room", type: "room_updated", room: clone(aggregate.room) });
    return { data: { gameSession: clone(session), room: clone(aggregate.room) }, provisional: true, publicDeltas, presenterDeltas: [], playerDeltas: [], forceCheckpoint: "game-end", archiveQuestion: true, deadlineChanged: true };
  }

  private updateQuestionLabel(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    this.assertPresenter(action.actorId);
    const id = getString(action.payload.questionId);
    const labelText = getString(action.payload.labelText);
    if (!labelText) throw new TerminalMutationError("请先填写正确答案。");
    if (session.roundStartedAt || session.revealedBlocks.length !== ALL_REVEALED_BLOCKS.length) throw new TerminalMutationError("当前还没有进入完整图片复盘阶段，不能填写正确答案。");
    const question = aggregate.questions[session.currentQuestionIndex];
    if (!question || question.id !== id) throw new TerminalMutationError("当前题目不存在，不能填写正确答案。");
    if (question.labelText?.trim()) throw new TerminalMutationError("该题已经有正确答案，不能重复填写。");
    const source = action.payload.source === "answer" ? "answer" : "manual";
    let sourceAnswerId: string | null = null;
    if (source === "answer") {
      sourceAnswerId = getString(action.payload.answerId);
      const sourceAnswerExists = sourceAnswerId && (
        aggregate.answers.some((answer) => answer.id === sourceAnswerId && answer.gameSessionId === session.id && answer.questionIndex === session.currentQuestionIndex)
        || aggregate.buzzerAnswers.some((answer) => answer.id === sourceAnswerId && answer.gameSessionId === session.id && answer.questionIndex === session.currentQuestionIndex)
      );
      if (!sourceAnswerExists) throw new TerminalMutationError(sourceAnswerId ? "引用的答案不存在，不能作为正确答案。" : "请选择一个要引用的答案。");
    }
    Object.assign(question, { labelText, labelSource: source, labelSourceAnswerId: sourceAnswerId, labelUpdatedByPlayerId: action.actorId, labelUpdatedAt: nowIso(action.serverReceivedAtMs) });
    aggregate.dirtyQuestionLabelIds = Array.from(new Set([...(aggregate.dirtyQuestionLabelIds ?? []), question.id]));
    const delta: RealtimeDelta = { scope: "game", type: "question_label_updated", question: clone(question) };
    return { data: clone(question), provisional: true, publicDeltas: [delta], presenterDeltas: [], playerDeltas: [] };
  }

  private joinRoom(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActiveOrEnded();
    const nickname = getString(action.payload.nickname) ?? "玩家";
    const normalizedNickname = nickname.trim().toLowerCase();
    if (aggregate.players.some((player) => (
      player.id !== action.actorId
      && player.nickname.trim().toLowerCase() === normalizedNickname
    ))) {
      throw new TerminalMutationError("该昵称已在房间内使用，请换一个昵称。");
    }
    const requestedRole = action.payload.role === "PLAYER" || action.payload.role === "SPECTATOR" ? action.payload.role : null;
    const selectedTeam = action.payload.team === "red" || action.payload.team === "blue" ? action.payload.team : null;
    let player = aggregate.players.find((item) => item.id === action.actorId);
    let role = player?.role ?? requestedRole ?? "PLAYER";
    if (player && requestedRole && requestedRole !== player.role) {
      if (aggregate.room?.status !== "LOBBY" && aggregate.room?.status !== "QUESTION_SETUP") {
        throw new TerminalMutationError("游戏进行中不能切换玩家/观战身份。");
      }
      if (aggregate.room.status === "QUESTION_SETUP" && player.id === aggregate.room.currentPresenterPlayerId) {
        throw new TerminalMutationError("当前出题人不能切换为观战身份。");
      }
      role = requestedRole;
    }
    const playerCapacity = getPlayerCapacity(aggregate.room);
    const spectatorCapacity = getSpectatorCapacity(aggregate.room);
    if (role === "PLAYER" && (!player || player.role !== "PLAYER") && countPlayersByRole(aggregate.players, "PLAYER") >= playerCapacity) {
      throw new TerminalMutationError(`玩家已满，当前房间最多支持 ${playerCapacity} 名玩家；可以选择观战加入。`);
    }
    if (role === "SPECTATOR" && (!player || player.role !== "SPECTATOR") && countPlayersByRole(aggregate.players, "SPECTATOR") >= spectatorCapacity) {
      throw new TerminalMutationError(`观战人数已满，当前房间最多支持 ${spectatorCapacity} 名观战者。`);
    }
    const manualTeamBattle = aggregate.gameSession?.gameMode === "TEAM_BATTLE" && aggregate.room?.teamAssignmentMode === "MANUAL";
    if (role === "PLAYER" && aggregate.cutoverState === "active" && manualTeamBattle && action.actorId !== aggregate.gameSession?.presenterPlayerId && !selectedTeam && !aggregate.room?.teamAssignments?.[action.actorId]) {
      throw new TerminalMutationError("手动分队已开启，请先选择加入红队或蓝队。");
    }
    if (player) Object.assign(player, { nickname, role, lastSeenAt: nowIso(action.serverReceivedAtMs) });
    else {
      player = { id: action.actorId, roomId: aggregate.roomId, nickname, isHost: false, role, joinedAt: nowIso(action.serverReceivedAtMs), lastSeenAt: nowIso(action.serverReceivedAtMs) };
      aggregate.players.push(player);
    }
    if (role === "PLAYER" && aggregate.cutoverState === "active") this.ensurePlayerScore(player.id);
    if (aggregate.room) {
      aggregate.room.players = aggregate.players;
      aggregate.room.teamAssignments ??= {};
      if (role === "SPECTATOR" || player.id === aggregate.gameSession?.presenterPlayerId) delete aggregate.room.teamAssignments[player.id];
      else if (selectedTeam) aggregate.room.teamAssignments[player.id] = selectedTeam;
    }
    if (selectedTeam && aggregate.gameSession?.teamBattleState && player.id !== aggregate.gameSession.presenterPlayerId) {
      const sourceTeams = aggregate.gameSession.teamBattleState.initialTeams ?? aggregate.gameSession.teamBattleState.teams;
      const initialTeams = { red: [...sourceTeams.red], blue: [...sourceTeams.blue] };
      initialTeams.red = initialTeams.red.filter((id) => id !== player!.id);
      initialTeams.blue = initialTeams.blue.filter((id) => id !== player!.id);
      initialTeams[selectedTeam].push(player.id);
      aggregate.gameSession.teamBattleState.initialTeams = initialTeams;
      aggregate.gameSession.teamBattleState.teamMemberNames ??= {};
      aggregate.gameSession.teamBattleState.teamMemberNames[player.id] = player.nickname;
    }
    const delta: RealtimeDelta = { scope: "room", type: "room_updated", room: clone(aggregate.room!) };
    return {
      data: { room: clone(aggregate.room), error: null, errorCode: null },
      provisional: true,
      publicDeltas: [delta],
      presenterDeltas: [],
      playerDeltas: [],
      ...(aggregate.cutoverState === "ended" ? { forceCheckpoint: "projection" as const } : {}),
    };
  }

  private leaveRoom(action: VNextPendingMutation, targetPlayerId: string): VNextMutationOutcome {
    const aggregate = this.requireActiveOrEnded();
    let teamDeadlineChanged = false;
    if (!targetPlayerId) throw new TerminalMutationError("目标玩家无效。");
    if (action.name === "kickPlayerFromRoom" && aggregate.room?.hostPlayerId !== action.actorId) throw new TerminalMutationError("只有房主可以移出玩家。");
    aggregate.players = aggregate.players.filter((player) => player.id !== targetPlayerId);
    if (aggregate.room) {
      aggregate.room.players = aggregate.players;
      if (aggregate.room.teamAssignments) delete aggregate.room.teamAssignments[targetPlayerId];
      if (!aggregate.players.length) {
        aggregate.room = undefined;
        aggregate.dissolved = true;
        aggregate.cutoverState = "ended";
        aggregate.deadline = null;
      } else if (aggregate.room.hostPlayerId === targetPlayerId) {
        aggregate.room.hostPlayerId = aggregate.players[0].id;
        aggregate.players.forEach((player) => { player.isHost = player.id === aggregate.room!.hostPlayerId; });
      }
    }
    const state = aggregate.gameSession?.teamBattleState;
    if (state) {
      state.teams.red = state.teams.red.filter((id) => id !== targetPlayerId);
      state.teams.blue = state.teams.blue.filter((id) => id !== targetPlayerId);
      delete state.revealVotes[targetPlayerId];
      delete state.guessVotes[targetPlayerId];
      pruneUnusedTeamGuessProposals(state);
      if (state.teamMemberNames) delete state.teamMemberNames[targetPlayerId];
      if (
        state.phase !== "TURN_RESULT" &&
        !getTeamMembers(state, state.activeTeam).length &&
        getTeamMembers(state, oppositeTeam(state.activeTeam)).length
      ) {
        state.activeTeam = oppositeTeam(state.activeTeam);
        state.revealVotes = {};
        state.guessVotes = {};
        state.guessProposals = [];
        state.pendingGuess = null;
        if (state.phase === "REVEAL_VOTE" || state.phase === "GUESS_VOTE") {
          this.startTeamVoteDeadline(state, state.phase, action.serverReceivedAtMs);
          teamDeadlineChanged = true;
        } else if (state.phase === "JUDGING" && aggregate.gameSession) {
          const blockCount = normalizeRevealBlockCount(state.revealBlockCount);
          const nextPhase = selectableTeamBlocks(aggregate.gameSession, state, blockCount).length === 0
            ? "GUESS_VOTE"
            : "REVEAL_VOTE";
          this.startTeamVoteDeadline(state, nextPhase, action.serverReceivedAtMs);
          teamDeadlineChanged = true;
        } else if (state.phase === "PRESENTER_BLOCK") {
          state.voteDeadlineAt = null;
          aggregate.deadline = null;
          state.message = "等待出题人禁用格子";
        } else {
          state.voteDeadlineAt = null;
          aggregate.deadline = null;
        }
      } else if (!getTeamMembers(state, "red").length && !getTeamMembers(state, "blue").length) {
        state.voteDeadlineAt = null;
        state.revealVotes = {};
        state.guessVotes = {};
        state.guessProposals = [];
        state.pendingGuess = null;
        state.message = "双方都没有在线队员，已停止自动投票，请出题人公布答案或结束游戏。";
        aggregate.deadline = null;
        teamDeadlineChanged = true;
      }
      if (!teamDeadlineChanged && (state.phase === "REVEAL_VOTE" || state.phase === "GUESS_VOTE")) {
        teamDeadlineChanged = this.shortenTeamVoteDeadlineIfComplete(state, action.serverReceivedAtMs);
      }
    }
    const delta: RealtimeDelta = aggregate.room ? { scope: "room", type: "room_updated", room: clone(aggregate.room) } : { scope: "room", type: "room_dissolved", roomId: aggregate.roomId };
    return {
      data: aggregate.room ? clone(aggregate.room) : null,
      provisional: true,
      publicDeltas: [delta],
      presenterDeltas: [],
      playerDeltas: [],
      ...(aggregate.dissolved
        ? { forceCheckpoint: "game-end" as const }
        : aggregate.cutoverState === "ended"
          ? { forceCheckpoint: "projection" as const }
          : teamDeadlineChanged
            ? { forceCheckpoint: "phase-boundary" as const }
            : {}),
      ...(teamDeadlineChanged || aggregate.deadline === null ? { deadlineChanged: true } : {}),
    };
  }

  private updatePlayerRole(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActiveOrEnded();
    const room = aggregate.room;
    const target = getString(action.payload.targetPlayerId);
    const player = aggregate.players.find((item) => item.id === target);
    if (target !== action.actorId) throw new TerminalMutationError("身份切换失败：只能切换自己的玩家/观战身份。");
    if (!room) throw new TerminalMutationError("身份切换失败：房间不存在。");
    if (action.payload.role !== "PLAYER" && action.payload.role !== "SPECTATOR") throw new TerminalMutationError("身份切换失败：未知的玩家身份。");
    if (room.status !== "LOBBY" && room.status !== "QUESTION_SETUP") throw new TerminalMutationError("只有在房间大厅或出题准备阶段可以切换玩家/观战身份。");
    if (room.status === "QUESTION_SETUP" && action.payload.role === "SPECTATOR" && target === room.currentPresenterPlayerId) {
      throw new TerminalMutationError("当前出题人不能切换为观战身份。");
    }
    if (!player) throw new TerminalMutationError("身份切换失败：你不在当前房间。");
    const playerCapacity = getPlayerCapacity(room);
    const spectatorCapacity = getSpectatorCapacity(room);
    if (action.payload.role === "PLAYER" && player.role !== "PLAYER" && countPlayersByRole(aggregate.players, "PLAYER") >= playerCapacity) {
      throw new TerminalMutationError(`玩家已满，当前房间最多支持 ${playerCapacity} 名玩家；可以继续观战。`);
    }
    if (action.payload.role === "SPECTATOR" && player.role !== "SPECTATOR" && countPlayersByRole(aggregate.players, "SPECTATOR") >= spectatorCapacity) {
      throw new TerminalMutationError(`观战人数已满，当前房间最多支持 ${spectatorCapacity} 名观战者。`);
    }
    const selectedTeam = action.payload.team === "red" || action.payload.team === "blue" ? action.payload.team : null;
    const teamAssignments = room.teamAssignments ?? {};
    const manualTeamBattle = (room.gameMode ?? aggregate.gameSession?.gameMode) === "TEAM_BATTLE" && room.teamAssignmentMode === "MANUAL";
    if (
      action.payload.role === "PLAYER"
      && manualTeamBattle
      && target !== room.currentPresenterPlayerId
      && !selectedTeam
      && !teamAssignments[target]
    ) {
      throw new TerminalMutationError("手动分队已开启，请先选择加入红队或蓝队。");
    }
    player.role = action.payload.role;
    room.teamAssignments = teamAssignments;
    if (player.role === "SPECTATOR" || player.id === room.currentPresenterPlayerId) delete teamAssignments[player.id];
    else if (selectedTeam) teamAssignments[player.id] = selectedTeam;
    room.players = aggregate.players;
    const delta: RealtimeDelta = { scope: "room", type: "room_updated", room: clone(room) };
    return {
      data: clone(room),
      provisional: true,
      publicDeltas: [delta],
      presenterDeltas: [],
      playerDeltas: [],
      ...(aggregate.cutoverState === "ended" ? { forceCheckpoint: "projection" as const } : {}),
    };
  }

  private ensurePlayerScore(playerId: string) {
    const aggregate = this.requireActive();
    if (playerId === aggregate.gameSession?.presenterPlayerId) return;
    const player = aggregate.players.find((item) => item.id === playerId);
    if (player) {
      aggregate.gameParticipants ??= aggregate.players
        .filter((item) => item.role === "PLAYER" && item.id !== aggregate.gameSession?.presenterPlayerId)
        .map((item) => ({ ...item, role: "PLAYER" }));
      const participant = aggregate.gameParticipants.find((item) => item.id === playerId);
      if (participant) Object.assign(participant, { nickname: player.nickname, role: "PLAYER", lastSeenAt: player.lastSeenAt });
      else aggregate.gameParticipants.push({ ...player, role: "PLAYER" });
    }
    if (!aggregate.scores.some((score) => score.playerId === playerId)) {
      aggregate.scores.push({ id: `${aggregate.gameId}:${playerId}`, gameSessionId: aggregate.gameId, playerId, score: 0, correctCount: 0 });
    }
    aggregate.scoreBaseline[playerId] ??= { score: 0, correctCount: 0 };
  }

  private dissolveRoom(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActiveOrEnded();
    if (aggregate.room?.hostPlayerId !== action.actorId) throw new TerminalMutationError("只有房主可以解散房间。");
    aggregate.room = undefined;
    aggregate.dissolved = true;
    aggregate.deadline = null;
    aggregate.cutoverState = "ended";
    const delta: RealtimeDelta = { scope: "room", type: "room_dissolved", roomId: aggregate.roomId };
    return { data: null, provisional: true, publicDeltas: [delta], presenterDeltas: [], playerDeltas: [], forceCheckpoint: "game-end", deadlineChanged: true };
  }

  private returnRoomToLobby(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActiveOrEnded();
    if (aggregate.room?.hostPlayerId !== action.actorId) throw new TerminalMutationError("只有房主可以返回大厅。");
    if (!aggregate.room) throw new TerminalMutationError("房间已经解散。");
    aggregate.room.status = "LOBBY";
    aggregate.room.currentGameId = null;
    aggregate.room.currentPresenterPlayerId = null;
    aggregate.room.preparedQuestionSetId = null;
    aggregate.room.preparedQuestionCount = null;
    aggregate.room.questionCount = null;
    aggregate.room.preparedQuestionSource = null;
    aggregate.room.teamAssignments = {};
    aggregate.cutoverState = "ended";
    aggregate.deadline = null;
    const delta: RealtimeDelta = { scope: "room", type: "room_updated", room: clone(aggregate.room) };
    return { data: clone(aggregate.room), provisional: true, publicDeltas: [delta], presenterDeltas: [], playerDeltas: [], forceCheckpoint: "projection", deadlineChanged: true };
  }

  private cancelCurrentRound(action: VNextPendingMutation): VNextMutationOutcome {
    const aggregate = this.requireActive();
    if (aggregate.room?.hostPlayerId !== action.actorId) throw new TerminalMutationError("只有房主可以取消当前游戏。");
    if (!aggregate.room) throw new TerminalMutationError("房间已经解散。");
    aggregate.room.status = "LOBBY";
    aggregate.room.currentGameId = null;
    aggregate.room.currentPresenterPlayerId = null;
    aggregate.room.preparedQuestionSetId = null;
    aggregate.room.preparedQuestionCount = null;
    aggregate.room.questionCount = null;
    aggregate.room.preparedQuestionSource = null;
    aggregate.room.teamAssignments = {};
    aggregate.resultArchiveSuppressed = true;
    aggregate.cutoverState = "ended";
    aggregate.deadline = null;
    const delta: RealtimeDelta = { scope: "room", type: "room_updated", room: clone(aggregate.room) };
    return { data: clone(aggregate.room), provisional: true, publicDeltas: [delta], presenterDeltas: [], playerDeltas: [], forceCheckpoint: "projection", deadlineChanged: true };
  }

  async maybeCheckpoint(triggerHint?: CheckpointTrigger) {
    const aggregate = this.aggregate;
    if (!aggregate || this.dirtyGeneration <= this.committedGeneration) return null;
    const trigger = triggerHint ?? (this.dirtyActionCount >= CHECKPOINT_ACTION_THRESHOLD ? "action-count" : Date.now() - aggregate.lastCheckpointAtMs >= CHECKPOINT_AGE_MS ? "event-age" : null);
    if (!trigger) return null;
    return await this.checkpoint(trigger, false);
  }

  async forceCheckpoint(trigger: CheckpointTrigger, archiveQuestion = false) {
    const target = this.dirtyGeneration;
    let receipt: VNextCheckpointReceipt | null = null;
    do {
      receipt = await this.checkpoint(trigger, archiveQuestion);
    } while (this.committedGeneration < target);
    return receipt;
  }

  private async checkpoint(trigger: CheckpointTrigger, archiveQuestion: boolean): Promise<VNextCheckpointReceipt | null> {
    if (this.checkpointPromise) return await this.checkpointPromise;
    const aggregate = this.aggregate;
    if (!aggregate || this.dirtyGeneration <= this.committedGeneration) return null;
    const capturedGeneration = this.dirtyGeneration;
    const capturedSeq = { ...aggregate.seenSeqByActor };
    const captured = clone(aggregate);
    captured.committedSeqByActor = capturedSeq;
    captured.checkpointGeneration = capturedGeneration;
    captured.lastCheckpointAtMs = Date.now();
    const capturedArchive = captured.pendingQuestionArchive;
    delete captured.pendingQuestionArchive;
    const startedAt = performance.now();
    const task = (async () => {
      let changedRows = 1;
      const stateJson = JSON.stringify(captured);
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec(
          `INSERT INTO authority_vnext_active_game(id,room_id,game_id,authority_version,schema_version,cutover_state,state_version,state_json,updated_at)
           VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,game_id=excluded.game_id,
           authority_version=excluded.authority_version,schema_version=excluded.schema_version,cutover_state=excluded.cutover_state,
           state_version=excluded.state_version,state_json=excluded.state_json,updated_at=excluded.updated_at`,
          captured.roomId, captured.gameId, 2, captured.schemaVersion, captured.cutoverState, captured.stateVersion, stateJson, captured.lastCheckpointAtMs,
        );
        if (capturedArchive) {
          const archive = capturedArchive;
          this.state.storage.sql.exec(
            `INSERT INTO authority_vnext_question_archive(game_id,question_index,checkpoint_version,state_json,created_at)
             VALUES(?,?,?,?,?) ON CONFLICT(game_id,question_index) DO UPDATE SET checkpoint_version=excluded.checkpoint_version,state_json=excluded.state_json`,
            archive.gameId, archive.questionIndex, captured.stateVersion, JSON.stringify(archive.state), Date.now(),
          );
          changedRows += 1;
        }
        if (captured.cutoverState === "ended" && (trigger === "game-end" || trigger === "projection")) {
          this.mergeProjectionOutbox(captured);
          changedRows += 1;
        }
      });
      await Promise.resolve();
      const live = this.aggregate;
      if (live) {
        live.committedSeqByActor = { ...live.committedSeqByActor, ...capturedSeq };
        live.stateVersion = Math.max(live.stateVersion, captured.stateVersion);
        live.lastCheckpointAtMs = captured.lastCheckpointAtMs;
        live.checkpointGeneration = Math.max(live.checkpointGeneration, capturedGeneration);
        this.trimCommittedRejections(live);
      }
      this.committedGeneration = Math.max(this.committedGeneration, capturedGeneration);
      if (capturedArchive && live?.pendingQuestionArchive?.gameId === capturedArchive.gameId && live.pendingQuestionArchive.questionIndex === capturedArchive.questionIndex) delete live.pendingQuestionArchive;
      if (this.dirtyGeneration === capturedGeneration) this.dirtyActionCount = 0;
      this.compactAttachments(capturedSeq);
      this.metrics.durableAcks += 1;
      const receipt: VNextCheckpointReceipt = { version: captured.stateVersion, generation: capturedGeneration, committedSeqByActor: capturedSeq, trigger, activeGameBytes: stateJson.length, changedRows, durationMs: Math.max(0, performance.now() - startedAt) };
      this.logCheckpoint(trigger, changedRows, receipt.activeGameBytes, receipt.durationMs, receipt.version);
      return receipt;
    })();
    this.checkpointPromise = task;
    try {
      return await task;
    } finally {
      if (this.checkpointPromise === task) this.checkpointPromise = null;
    }
  }

  async handleSocketClose(socket: WebSocket) {
    const attachment = this.safeDeserializeAttachment(socket);
    if (!attachment || !attachment.pending.some((action) => action.clientSeq > (this.aggregate?.committedSeqByActor[action.actorId] ?? 0))) return null;
    return await this.forceCheckpoint("connection-close");
  }

  getDeadline() {
    const aggregate = this.aggregate ?? this.readAggregate();
    return aggregate?.cutoverState === "active" ? aggregate.deadline : null;
  }

  async executeDueDeadline(now = Date.now()) {
    const aggregate = this.requireActive();
    const deadline = aggregate.deadline;
    if (!deadline || now < deadline.runAtMs || deadline.gameId !== aggregate.gameId || deadline.questionIndex !== aggregate.gameSession!.currentQuestionIndex) return null;
    const actorId = "__server__";
    const seq = (aggregate.seenSeqByActor[actorId] ?? aggregate.committedSeqByActor[actorId] ?? 0) + 1;
    const action: VNextPendingMutation = {
      actionId: `deadline:${deadline.phaseKey}:${deadline.runAtMs}`,
      actorId,
      clientSeq: seq,
      gameId: aggregate.gameId,
      questionIndex: deadline.questionIndex,
      name: deadline.kind === "team-vote" ? "finalizeTeamBattleVote" : "autoForfeitExpiredRound",
      payload: { gameSessionId: aggregate.gameId },
      serverReceivedAtMs: now,
      orderToken: `${now}:${actorId}:${seq}`,
    };
    const outcome = this.applyMutation(action, false);
    const receipt = await this.forceCheckpoint("deadline", Boolean(outcome.archiveQuestion));
    return { outcome, receipt };
  }

  prepareFinalResultsFromArchives() {
    const aggregate = this.requireActiveOrEnded();
    const archived = this.state.storage.sql.exec<{ state_json: string }>(
      "SELECT state_json FROM authority_vnext_question_archive WHERE game_id=? ORDER BY question_index",
      aggregate.gameId,
    ).toArray();
    const results: QuestionResult[] = [];
    for (const row of archived) {
      try {
        const state = JSON.parse(row.state_json) as { questionResults?: QuestionResult[] };
        if (Array.isArray(state.questionResults)) results.push(...state.questionResults);
      } catch { /* A corrupt archive is excluded from the final projection and logged below. */ }
    }
    results.push(...aggregate.questionResults);
    aggregate.finalQuestionResults = Array.from(new Map(results.map((result) => [`${result.questionIndex}:${result.playerId}`, result])).values());
    aggregate.finalLeaderboard = this.leaderboard();
  }

  markAlarmMetric(info: { isRetry?: boolean }) {
    this.metrics.alarmExecuted += 1;
    if (info.isRetry) this.metrics.alarmRetried += 1;
  }

  recordAlarmScheduled(changed: boolean) {
    if (changed) this.metrics.alarmScheduled += 1;
    else this.metrics.alarmIgnored += 1;
  }

  recordBroadcast(bytes: number, count: number) {
    this.metrics.broadcastBytes += bytes * count;
    this.metrics.broadcasts += count;
  }

  getDiagnostics() {
    let attachmentBytes = 0;
    let maxAttachmentBytes = 0;
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.safeDeserializeAttachment(socket);
      if (!attachment) continue;
      const bytes = attachment.serializedBytes || jsonBytes(attachment);
      attachmentBytes += bytes;
      maxAttachmentBytes = Math.max(maxAttachmentBytes, bytes);
    }
    return clone({ ...this.metrics, attachmentCount: this.state.getWebSockets().length, attachmentBytes, maxAttachmentBytes });
  }

  async flushFinalProjection() {
    if (this.projectionFlushInFlight) return await this.projectionFlushInFlight;
    const task = this.flushFinalProjectionOnce();
    this.projectionFlushInFlight = task;
    try {
      return await task;
    } finally {
      if (this.projectionFlushInFlight === task) this.projectionFlushInFlight = null;
    }
  }

  private getDirtyProjectionQuestions(game: ProjectionGame) {
    const dirtyIds = game.dirtyQuestionLabelIds === undefined
      ? new Set(game.questions.filter((question) => question.labelText?.trim()).map((question) => question.id))
      : new Set(game.dirtyQuestionLabelIds);
    return game.questions.filter((question) => dirtyIds.has(question.id) && question.labelText?.trim());
  }

  private async persistManifestQuestionLabels(game: ProjectionGame, dirtyQuestions: Question[]) {
    const questionSetId = game.gameSession?.questionSetId;
    if (!questionSetId) throw new Error("question manifest schema validation failed: projection is missing questionSetId");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await this.d1
        .prepare("SELECT id,manifest_version,manifest_revision,manifest_json FROM question_sets WHERE id=?")
        .bind(questionSetId)
        .first<Pick<DbQuestionSet, "id" | "manifest_version" | "manifest_revision" | "manifest_json">>();
      this.metrics.d1Reads += 1;
      if (!row || row.manifest_version !== QUESTION_SET_MANIFEST_VERSION) {
        throw new Error("question manifest schema validation failed: manifest row is missing or incompatible");
      }

      const currentQuestions = decodeQuestionSetManifest(row);
      if (!currentQuestions) throw new Error("question manifest schema validation failed: manifest payload is missing");
      const currentById = new Map(currentQuestions.map((question) => [question.id, question]));
      let changed = false;
      for (const desired of dirtyQuestions) {
        const current = currentById.get(desired.id);
        if (!current) throw new Error("question manifest schema validation failed: dirty question is missing");
        const currentLabel = current.label_text?.trim();
        if (currentLabel) {
          if (currentLabel !== desired.labelText?.trim()) {
            console.warn(JSON.stringify({
              event: "question_manifest_label_conflict",
              questionSetId,
              questionId: desired.id,
              storedLabelUpdatedAt: current.label_updated_at ?? null,
              projectedLabelUpdatedAt: desired.labelUpdatedAt ?? null,
            }));
          }
          continue;
        }
        current.label_text = desired.labelText?.trim() || null;
        current.label_source = desired.labelSource ?? null;
        current.label_source_answer_id = desired.labelSourceAnswerId ?? null;
        current.label_updated_by_player_id = desired.labelUpdatedByPlayerId ?? null;
        current.label_updated_at = desired.labelUpdatedAt ?? null;
        changed = true;
      }
      if (!changed) return;

      const revision = row.manifest_revision ?? 0;
      const updated = await this.d1
        .prepare(`UPDATE question_sets
          SET manifest_json=?,manifest_revision=manifest_revision+1
          WHERE id=? AND manifest_version=? AND manifest_revision=?
          RETURNING id`)
        .bind(encodeDbQuestionSetManifest(currentQuestions), questionSetId, QUESTION_SET_MANIFEST_VERSION, revision)
        .first<{ id: string }>();
      if (updated) {
        this.metrics.d1Writes += 1;
        return;
      }
    }
    throw new Error("question manifest revision conflict exceeded retry limit");
  }

  private async flushFinalProjectionOnce() {
    const row = this.state.storage.sql.exec<{ payload_json: string; attempts: number }>("SELECT payload_json,attempts FROM authority_vnext_projection_outbox WHERE id=1").toArray()[0];
    if (!row) return true;
    const payload = JSON.parse(row.payload_json) as ProjectionPayload;
    try {
      const statements: D1PreparedStatement[] = [];
      const game = payload.games[0];
      if (!game) {
        this.state.storage.sql.exec("DELETE FROM authority_vnext_projection_outbox WHERE id=1");
        return true;
      }
        const dirtyQuestions = this.getDirtyProjectionQuestions(game);
        if (dirtyQuestions.length > 0 && game.questionSetManifestVersion === QUESTION_SET_MANIFEST_VERSION) {
          await this.persistManifestQuestionLabels(game, dirtyQuestions);
        } else {
          for (const question of dirtyQuestions) {
            statements.push(this.d1.prepare("UPDATE questions SET label_text=?,label_source=?,label_source_answer_id=?,label_updated_by_player_id=?,label_updated_at=? WHERE id=? AND (label_text IS NULL OR trim(label_text)='')").bind(
              question.labelText ?? null,
              question.labelSource ?? null,
              question.labelSourceAnswerId ?? null,
              question.labelUpdatedByPlayerId ?? null,
              question.labelUpdatedAt ?? null,
              question.id,
            ));
          }
        }
        if (game.dissolved) {
          statements.push(this.d1.prepare("DELETE FROM rooms WHERE id=?").bind(game.roomId));
        } else {
          const publicActivityAt = game.publicActivityAt ?? game.gameSession?.endedAt ?? nowIso();
          if (game.projectionVersion === 3) {
            if (!game.room?.id) throw new Error("room state projection is missing room data");
            statements.push(this.d1.prepare(`UPDATE rooms SET
              host_player_id=?,game_status=?,current_presenter_player_id=?,current_game_id=?,prepared_question_set_id=?,prepared_question_count=?,lobby_question_count=?,prepared_question_source=?,member_count=?,spectator_count=?,lobby_team_assignment_mode=?,lobby_team_assignments=?,
              room_state_version=?,room_state_revision=room_state_revision+1,room_state_json=?,public_activity_at=?,updated_at=?
              WHERE id=? AND runtime_generation=?`).bind(
              game.room.hostPlayerId,
              game.room.status,
              game.room.currentPresenterPlayerId ?? null,
              game.room.currentGameId ?? null,
              game.room.preparedQuestionSetId ?? null,
              game.room.preparedQuestionCount ?? null,
              game.room.questionCount ?? null,
              game.room.preparedQuestionSource ?? null,
              countPlayersByRole(game.players, "PLAYER"),
              countPlayersByRole(game.players, "SPECTATOR"),
              game.room.teamAssignmentMode ?? "AUTO",
              JSON.stringify(game.room.teamAssignments ?? {}),
              ROOM_STATE_MANIFEST_VERSION,
              encodeRoomState(game.roomId, game.room.hostPlayerId, game.players),
              publicActivityAt,
              nowIso(),
              game.room.id,
              CURRENT_ROOM_RUNTIME_GENERATION,
            ));
          } else {
            const legacyPlayers = game.players.map((player) => ({
              ...player,
              joinedAt: typeof player.joinedAt === "number" ? nowIso(player.joinedAt) : player.joinedAt,
              lastSeenAt: player.lastSeenAt ?? nowIso(),
            }));
            if (game.room?.id) statements.push(this.d1.prepare("UPDATE rooms SET host_player_id=?,game_status=?,current_presenter_player_id=?,current_game_id=?,prepared_question_set_id=?,prepared_question_count=?,lobby_question_count=?,prepared_question_source=?,member_count=?,spectator_count=?,lobby_team_assignment_mode=?,lobby_team_assignments=?,public_activity_at=?,updated_at=? WHERE id=?").bind(
              game.room.hostPlayerId,
              game.room.status,
              game.room.currentPresenterPlayerId ?? null,
              game.room.currentGameId ?? null,
              game.room.preparedQuestionSetId ?? null,
              game.room.preparedQuestionCount ?? null,
              game.room.questionCount ?? null,
              game.room.preparedQuestionSource ?? null,
              countPlayersByRole(game.players, "PLAYER"),
              countPlayersByRole(game.players, "SPECTATOR"),
              game.room.teamAssignmentMode ?? "AUTO",
              JSON.stringify(game.room.teamAssignments ?? {}),
              publicActivityAt,
              nowIso(),
              game.room.id,
            ));
            statements.push(this.d1.prepare("DELETE FROM players WHERE room_id=?").bind(game.roomId));
            if (game.players.length) statements.push(this.d1.prepare(`INSERT INTO players(id,room_id,nickname,is_host,joined_at,last_seen_at,role)
              SELECT json_extract(value,'$.id'),json_extract(value,'$.roomId'),json_extract(value,'$.nickname'),json_extract(value,'$.isHost'),json_extract(value,'$.joinedAt'),json_extract(value,'$.lastSeenAt'),json_extract(value,'$.role') FROM json_each(?) WHERE true
              ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,nickname=excluded.nickname,is_host=excluded.is_host,last_seen_at=excluded.last_seen_at,role=excluded.role
              `).bind(JSON.stringify(legacyPlayers)));
          }
          if (game.gameSession) {
            statements.push(this.d1.prepare("UPDATE game_sessions SET status=?,current_question_index=?,current_reveal_round=?,revealed_blocks=?,team_battle_state=?,round_started_at=?,ended_at=?,completed_normally_at=? WHERE id=?").bind(game.gameSession.status, game.gameSession.currentQuestionIndex, game.gameSession.currentRevealRound, JSON.stringify(game.gameSession.revealedBlocks), game.gameSession.teamBattleState == null ? null : JSON.stringify(game.gameSession.teamBattleState), game.gameSession.roundStartedAt ?? null, game.gameSession.endedAt ?? null, game.gameSession.completedNormallyAt ?? null, game.gameSession.id));
            const participants = game.projectionVersion == null ? game.participants ?? game.players.filter((player) => player.role === "PLAYER") : [];
            if (participants.length) statements.push(this.d1.prepare(`INSERT INTO game_participants(game_session_id,player_id,nickname,role,joined_at)
              SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.nickname'),json_extract(value,'$.role'),json_extract(value,'$.joinedAt') FROM json_each(?) WHERE true
              ON CONFLICT(game_session_id,player_id) DO UPDATE SET nickname=excluded.nickname,role=excluded.role`).bind(game.gameSession.id, JSON.stringify(participants.map((player) => ({ ...player, role: "PLAYER", joinedAt: typeof player.joinedAt === "number" ? nowIso(player.joinedAt) : player.joinedAt })))));
            if (game.gameSession.completedNormallyAt) statements.push(this.d1.prepare("INSERT OR IGNORE INTO completed_question_set_plays(game_session_id,question_set_id,completed_at) VALUES(?,?,?)").bind(game.gameSession.id, game.gameSession.questionSetId, game.gameSession.completedNormallyAt));
          }
          if (game.projectionVersion == null && game.scores.length) statements.push(this.d1.prepare(`INSERT INTO player_scores(id,game_session_id,player_id,score,correct_count)
            SELECT json_extract(value,'$.id'),json_extract(value,'$.gameSessionId'),json_extract(value,'$.playerId'),json_extract(value,'$.score'),json_extract(value,'$.correctCount') FROM json_each(?) WHERE true
            ON CONFLICT(game_session_id,player_id) DO UPDATE SET score=excluded.score,correct_count=excluded.correct_count`).bind(JSON.stringify(game.scores)));
          if (game.projectionVersion == null && game.questionResults.length) statements.push(this.d1.prepare(`INSERT INTO question_results(id,game_session_id,question_index,player_id,scored_round,score_awarded,judged_by_player_id,judged_at)
            SELECT json_extract(value,'$.id'),json_extract(value,'$.gameSessionId'),json_extract(value,'$.questionIndex'),json_extract(value,'$.playerId'),json_extract(value,'$.scoredRound'),json_extract(value,'$.scoreAwarded'),json_extract(value,'$.judgedByPlayerId'),json_extract(value,'$.judgedAt') FROM json_each(?) WHERE true
            ON CONFLICT(game_session_id,question_index,player_id) DO UPDATE SET scored_round=excluded.scored_round,score_awarded=excluded.score_awarded,judged_by_player_id=excluded.judged_by_player_id,judged_at=excluded.judged_at`).bind(JSON.stringify(game.questionResults)));
          if (game.projectionVersion != null && game.gameSession && game.archive) {
            statements.push(this.d1.prepare(`INSERT INTO game_result_archives(game_session_id,room_id,question_set_id,archive_version,completed_at,result_json)
              VALUES(?,?,?,?,?,?) ON CONFLICT(game_session_id) DO UPDATE SET room_id=excluded.room_id,question_set_id=excluded.question_set_id,
              archive_version=excluded.archive_version,completed_at=excluded.completed_at,result_json=excluded.result_json`).bind(
              game.gameSession.id,
              game.roomId,
              game.gameSession.questionSetId,
              game.archive.version,
              game.archive.completedAt,
              JSON.stringify(game.archive),
            ));
          }
        }
      if (statements.length) {
        await this.d1.batch(statements);
        this.metrics.d1Writes += statements.length;
      }
      payload.games.shift();
      const current = this.state.storage.sql.exec<{ payload_json: string }>("SELECT payload_json FROM authority_vnext_projection_outbox WHERE id=1").toArray()[0];
      if (current?.payload_json !== row.payload_json) return false;
      if (payload.games.length) this.state.storage.sql.exec("UPDATE authority_vnext_projection_outbox SET payload_json=?,attempts=0,updated_at=? WHERE id=1 AND payload_json=?", JSON.stringify(payload), Date.now(), row.payload_json);
      else this.state.storage.sql.exec("DELETE FROM authority_vnext_projection_outbox WHERE id=1 AND payload_json=?", row.payload_json);
      return payload.games.length === 0;
    } catch (error) {
      this.state.storage.sql.exec("UPDATE authority_vnext_projection_outbox SET attempts=attempts+1,updated_at=? WHERE id=1 AND payload_json=?", Date.now(), row.payload_json);
      if (isPermanentSchemaError(error)) console.error(JSON.stringify({ event: "authority_vnext_projection_permanent_error", authorityVersion: 2, error: String(error) }));
      else console.warn(JSON.stringify({ event: "authority_vnext_projection_deferred", authorityVersion: 2, error: String(error) }));
      return false;
    }
  }

  canStartAnotherGame() {
    const row = this.state.storage.sql.exec<{ payload_json: string }>("SELECT payload_json FROM authority_vnext_projection_outbox WHERE id=1").toArray()[0];
    return !row || jsonBytes(row.payload_json) <= FINAL_PROJECTION_LIMIT_BYTES - FINAL_PROJECTION_RESERVE_BYTES;
  }

  hasPendingFinalProjection() {
    return Boolean(this.state.storage.sql.exec<{ id: number }>("SELECT id FROM authority_vnext_projection_outbox WHERE id=1").toArray()[0]);
  }

  hasPendingRoomHandoff() {
    const payloadJson = this.pendingProjectionPayloadJson();
    if (!payloadJson) return false;
    try {
      const payload = JSON.parse(payloadJson) as ProjectionPayload;
      return payload.games.some((game) => !game.dissolved && game.room?.status === "LOBBY");
    } catch {
      return true;
    }
  }

  async flushRoomHandoff() {
    for (let remaining = this.pendingProjectionGameCount(); remaining > 0 && this.hasPendingRoomHandoff(); remaining -= 1) {
      const before = this.pendingProjectionPayloadJson();
      await this.flushFinalProjection();
      if (!this.hasPendingRoomHandoff()) return true;
      if (this.pendingProjectionPayloadJson() === before) return false;
    }
    return !this.hasPendingRoomHandoff();
  }

  private pendingProjectionPayloadJson() {
    return this.state.storage.sql.exec<{ payload_json: string }>("SELECT payload_json FROM authority_vnext_projection_outbox WHERE id=1").toArray()[0]?.payload_json ?? null;
  }

  private pendingProjectionGameCount() {
    const payloadJson = this.pendingProjectionPayloadJson();
    if (!payloadJson) return 0;
    try { return (JSON.parse(payloadJson) as ProjectionPayload).games.length; } catch { return 1; }
  }

  private mergeProjectionOutbox(aggregate: VNextAggregate) {
    const existing = this.state.storage.sql.exec<{ payload_json: string }>("SELECT payload_json FROM authority_vnext_projection_outbox WHERE id=1").toArray()[0];
    const payload = existing ? JSON.parse(existing.payload_json) as ProjectionPayload : { games: [] };
    const game: ArchiveProjectionGameV3 = {
      projectionVersion: 3,
      rosterStrategy: "reconcile",
      roomId: aggregate.roomId,
      dissolved: aggregate.dissolved,
      room: aggregate.room,
      players: aggregate.players,
      questions: aggregate.questions,
      questionSetManifestVersion: aggregate.questionSetManifestVersion ?? null,
      dirtyQuestionLabelIds: aggregate.dirtyQuestionLabelIds ?? [],
      gameSession: aggregate.gameSession,
      publicActivityAt: nowIso(aggregate.lastPublicActivityAtMs),
      ...(!aggregate.resultArchiveSuppressed
        ? { archive: this.createGameResultArchive(aggregate) }
        : {}),
    };
    payload.games = [...payload.games.filter((item) => item.gameSession?.id !== aggregate.gameId), game];
    const payloadJson = JSON.stringify(payload);
    if (new TextEncoder().encode(payloadJson).byteLength > FINAL_PROJECTION_LIMIT_BYTES) throw new Error("authority vNext 最终投影队列已满，请等待长期结果同步后再开始下一局。");
    this.state.storage.sql.exec(`INSERT INTO authority_vnext_projection_outbox(id,payload_json,attempts,updated_at) VALUES(1,?,0,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`, payloadJson, Date.now());
  }

  private captureCurrentQuestionArchive() {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    aggregate.pendingQuestionArchive = {
      gameId: aggregate.gameId,
      questionIndex: session.currentQuestionIndex,
      state: {
        gameSession: clone(session),
        answers: clone(aggregate.answers),
        buzzerAnswers: clone(aggregate.buzzerAnswers),
        questionResults: clone(aggregate.questionResults),
      },
    };
  }

  private readActiveRow() {
    return this.state.storage.sql.exec<ActiveRow>("SELECT room_id,game_id,cutover_state,state_version,state_json FROM authority_vnext_active_game WHERE id=1").toArray()[0] ?? null;
  }

  private readAggregate() {
    const row = this.readActiveRow();
    if (!row) return null;
    const parsed = JSON.parse(row.state_json) as VNextAggregate;
    if (parsed.authorityVersion !== 2 || parsed.schemaVersion !== 1) throw new Error("authority vNext active_game 版本不兼容。");
    parsed.publicStateVersion ??= 0;
    parsed.lastPublicActivityAtMs ??= parsed.lastCheckpointAtMs;
    if (!Array.isArray(parsed.dirtyQuestionLabelIds)) {
      parsed.dirtyQuestionLabelIds = parsed.questions
        .filter((question) => question.labelText?.trim())
        .map((question) => question.id);
    }
    parsed.questionSetManifestVersion ??= null;
    return parsed;
  }

  private writeActive(aggregate: VNextAggregate) {
    const stateJson = JSON.stringify(aggregate);
    this.state.storage.sql.exec(
      `INSERT INTO authority_vnext_active_game(id,room_id,game_id,authority_version,schema_version,cutover_state,state_version,state_json,updated_at)
       VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,game_id=excluded.game_id,
       authority_version=excluded.authority_version,schema_version=excluded.schema_version,cutover_state=excluded.cutover_state,
       state_version=excluded.state_version,state_json=excluded.state_json,updated_at=excluded.updated_at`,
      aggregate.roomId, aggregate.gameId, 2, 1, aggregate.cutoverState, aggregate.stateVersion, stateJson, Date.now(),
    );
  }

  private requireActive() {
    const aggregate = this.aggregate ?? this.readAggregate();
    if (!aggregate || aggregate.cutoverState !== "active" || !aggregate.gameSession) throw new Error("authority vNext 游戏未处于活动状态。");
    this.aggregate = aggregate;
    return aggregate;
  }

  private requireActiveOrEnded() {
    const aggregate = this.aggregate ?? this.readAggregate();
    if (!aggregate || aggregate.cutoverState === "initializing" || !aggregate.gameSession) throw new Error("authority vNext 游戏尚未完成初始化。");
    this.aggregate = aggregate;
    return aggregate;
  }

  private assertPresenter(playerId: string) {
    if (this.requireActive().gameSession!.presenterPlayerId !== playerId) throw new TerminalMutationError("只有出题人可以执行此操作。");
  }

  private assertCanAnswer(playerId: string, receivedAtMs: number) {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    if (playerId === session.presenterPlayerId || !session.eligiblePlayerIds?.includes(playerId)) throw new TerminalMutationError("你不是当前题的答题者。");
    if (!session.roundStartedAt) throw new TerminalMutationError("本轮尚未开始。");
    if (receivedAtMs > new Date(session.roundStartedAt).getTime() + session.roundSeconds * 1000 + 3000) throw new TerminalMutationError("本轮答题时间已结束。");
  }

  private assertTeamVoter(playerId: string, phase: "REVEAL_VOTE" | "GUESS_VOTE", receivedAtMs: number) {
    const session = this.requireActive().gameSession!;
    const state = session.teamBattleState;
    if (!state || state.phase !== phase || !getTeamMembers(state, state.activeTeam).includes(playerId)) throw new TerminalMutationError("还没轮到你所在队伍投票。");
    if (state.voteDeadlineAt && receivedAtMs >= new Date(state.voteDeadlineAt).getTime()) throw new TerminalMutationError("本轮投票时间已结束。");
    return state.activeTeam;
  }

  private addMissingForfeits(action: VNextPendingMutation) {
    const aggregate = this.requireActive();
    const session = aggregate.gameSession!;
    const added: Answer[] = [];
    for (const playerId of this.currentRoundEligiblePlayerIds(aggregate)) {
      const hasAction = aggregate.answers.some((answer) => answer.questionIndex === session.currentQuestionIndex && answer.revealRound === session.currentRevealRound && answer.playerId === playerId) || aggregate.buzzerAnswers.some((answer) => answer.questionIndex === session.currentQuestionIndex && answer.revealRound === session.currentRevealRound && answer.playerId === playerId);
      if (!hasAction) {
        const answer = { id: `${action.actionId}:${playerId}`, gameSessionId: session.id, questionIndex: session.currentQuestionIndex, revealRound: session.currentRevealRound, playerId, answerText: FORFEIT_ANSWER_TEXT, submittedAt: nowIso(action.serverReceivedAtMs) };
        aggregate.answers.push(answer);
        added.push(answer);
      }
    }
    return added;
  }

  private activeQuestionGuesserIds(aggregate: VNextAggregate) {
    const activePlayerIds = new Set(
      aggregate.players
        .filter((player) => player.role === "PLAYER" && player.id !== aggregate.gameSession!.presenterPlayerId)
        .map((player) => player.id),
    );
    return (aggregate.gameSession!.eligiblePlayerIds ?? []).filter((playerId) => activePlayerIds.has(playerId));
  }

  private currentRoundEligiblePlayerIds(aggregate: VNextAggregate, questionGuesserIds = this.activeQuestionGuesserIds(aggregate)) {
    const session = aggregate.gameSession!;
    const correctPlayerIds = new Set(
      aggregate.questionResults
        .filter((result) => result.questionIndex === session.currentQuestionIndex)
        .map((result) => result.playerId),
    );
    return questionGuesserIds.filter((playerId) => !correctPlayerIds.has(playerId));
  }

  private startTeamVoteDeadline(state: TeamBattleState, phase: "REVEAL_VOTE" | "GUESS_VOTE", receivedAtMs: number) {
    const aggregate = this.requireActive();
    if (!getTeamMembers(state, "red").length && !getTeamMembers(state, "blue").length) {
      state.phase = phase;
      state.voteDeadlineAt = null;
      aggregate.deadline = null;
      return;
    }
    const runAtMs = receivedAtMs + teamVoteSeconds(state, phase) * 1000;
    state.phase = phase;
    state.voteDeadlineAt = nowIso(runAtMs);
    aggregate.deadline = {
      kind: "team-vote",
      gameId: aggregate.gameId,
      questionIndex: aggregate.gameSession!.currentQuestionIndex,
      phaseKey: `${phase}:${state.turnNumber}`,
      runAtMs,
    };
  }

  private shortenTeamVoteDeadlineIfComplete(state: TeamBattleState, receivedAtMs: number) {
    if ((state.phase !== "REVEAL_VOTE" && state.phase !== "GUESS_VOTE") || !state.voteDeadlineAt) return false;
    const members = getTeamMembers(state, state.activeTeam);
    const votes = state.phase === "REVEAL_VOTE" ? state.revealVotes : state.guessVotes;
    if (!members.length || !members.every((playerId) => Object.prototype.hasOwnProperty.call(votes, playerId))) return false;
    const currentRunAtMs = new Date(state.voteDeadlineAt).getTime();
    const shortenedRunAtMs = receivedAtMs + TEAM_BATTLE_ALL_SUBMITTED_GRACE_SECONDS * 1000;
    if (!Number.isFinite(currentRunAtMs) || currentRunAtMs <= shortenedRunAtMs) return false;
    const aggregate = this.requireActive();
    state.voteDeadlineAt = nowIso(shortenedRunAtMs);
    aggregate.deadline = {
      kind: "team-vote",
      gameId: aggregate.gameId,
      questionIndex: aggregate.gameSession!.currentQuestionIndex,
      phaseKey: `${state.phase}:${state.turnNumber}`,
      runAtMs: shortenedRunAtMs,
    };
    return true;
  }

  private resetTeamState(previous: TeamBattleState | null | undefined, players: Player[], presenterId: string, questionIndex: number): TeamBattleState {
    const ids = players.filter((player) => player.role === "PLAYER" && player.id !== presenterId).map((player) => player.id);
    const aggregate = this.requireActive();
    const initial = previous?.initialTeams
      ? { red: [...previous.initialTeams.red], blue: [...previous.initialTeams.blue] }
      : { red: ids.filter((_, index) => index % 2 === 0), blue: ids.filter((_, index) => index % 2 === 1) };
    const alreadyAssigned = new Set([...initial.red, ...initial.blue]);
    const valid = new Set(ids);
    const currentCounts = {
      red: initial.red.filter((id) => valid.has(id)).length,
      blue: initial.blue.filter((id) => valid.has(id)).length,
    };
    for (const playerId of ids) {
      if (alreadyAssigned.has(playerId)) continue;
      const manualTeam = aggregate.room?.teamAssignmentMode === "MANUAL" ? aggregate.room.teamAssignments?.[playerId] : null;
      const targetTeam = manualTeam ?? (currentCounts.red <= currentCounts.blue ? "red" : "blue");
      initial[targetTeam].push(playerId);
      currentCounts[targetTeam] += 1;
      alreadyAssigned.add(playerId);
    }
    const teams = { red: initial.red.filter((id) => valid.has(id)), blue: initial.blue.filter((id) => valid.has(id)) };
    const activeTeam: TeamBattleTeam = questionIndex % 2 === 0 ? "red" : "blue";
    const nextActiveTeam = teams[activeTeam].length ? activeTeam : oppositeTeam(activeTeam);
    const presenterBlockEnabled = previous?.presenterBlockEnabled !== false;
    return {
      teams,
      initialTeams: initial,
      teamMemberNames: Object.fromEntries(players.map((player) => [player.id, player.nickname])),
      activeTeam: nextActiveTeam,
      phase: presenterBlockEnabled ? "PRESENTER_BLOCK" : "REVEAL_VOTE",
      presenterBlockEnabled,
      revealBlockCount: previous?.revealBlockCount ?? 45,
      disabledBlocks: [],
      revealLimit: 1,
      turnNumber: 1,
      revealVoteSeconds: normalizeTeamVoteSeconds(previous?.revealVoteSeconds, DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS),
      guessVoteSeconds: normalizeTeamVoteSeconds(previous?.guessVoteSeconds, DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS),
      voteDeadlineAt: null,
      revealVotes: {},
      guessVotes: {},
      guessProposals: [],
      previousTurnAction: null,
      pendingGuess: null,
      correctGuess: null,
      teamScores: previous?.teamScores ?? { red: 0, blue: 0 },
      message: presenterBlockEnabled ? "等待出题人禁用格子" : `${teamName(nextActiveTeam)}选格`,
    };
  }

  private eligiblePlayers(players: Player[], presenterId: string) {
    return players.filter((player) => player.role === "PLAYER" && player.id !== presenterId).map((player) => player.id);
  }

  private shuffle<T>(items: T[]) {
    const shuffled = items.slice();
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.min(index, Math.floor(this.random() * (index + 1)));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  private recalculateScores() {
    const aggregate = this.requireActive();
    const totals = new Map<string, { score: number; correctCount: number }>(Object.entries(aggregate.scoreBaseline ?? {}).map(([playerId, value]) => [playerId, { ...value }]));
    for (const result of aggregate.questionResults) {
      const current = totals.get(result.playerId) ?? { score: 0, correctCount: 0 };
      current.score += result.scoreAwarded;
      current.correctCount += 1;
      totals.set(result.playerId, current);
    }
    for (const score of aggregate.scores) Object.assign(score, totals.get(score.playerId) ?? { score: 0, correctCount: 0 });
  }

  private leaderboard(): LeaderboardEntry[] {
    return this.leaderboardFor(this.requireActiveOrEnded());
  }

  private leaderboardFor(aggregate: VNextAggregate): LeaderboardEntry[] {
    const names = new Map([
      ...(aggregate.gameParticipants ?? []).map((player) => [player.id, player.nickname] as const),
      ...aggregate.players.map((player) => [player.id, player.nickname] as const),
    ]);
    const participantIds = this.participantIds(aggregate);
    const sorted = aggregate.scores
      .filter((score) => participantIds.has(score.playerId))
      .map((score) => ({ playerId: score.playerId, nickname: names.get(score.playerId) ?? "玩家", score: score.score, correctCount: score.correctCount }))
      .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount || a.nickname.localeCompare(b.nickname));
    let previousScore: number | null = null;
    let previousRank = 0;
    return sorted.map((item, index) => {
      const rank = item.score === previousScore ? previousRank : index + 1;
      previousScore = item.score;
      previousRank = rank;
      return { ...item, rank };
    });
  }

  private gameResultSnapshot(): GameResultSnapshot {
    const aggregate = this.requireActiveOrEnded();
    const questionSet = aggregate.questionSet
      ? { ...aggregate.questionSet, questions: clone(aggregate.questions) }
      : null;
    const archive = this.createGameResultArchive(aggregate);
    return { gameSession: clone(aggregate.gameSession!), leaderboard: clone(archive.leaderboard), questionSet, questionScores: clone(archive.questionScores) };
  }

  private createGameResultArchive(aggregate: VNextAggregate): GameResultArchive {
    const session = aggregate.gameSession;
    if (!session) throw new Error("authority vNext 结算归档缺少游戏状态。");
    if (aggregate.questions.length > 30) throw new Error("authority vNext 结算归档题目数量超出上限。");
    const leaderboard = this.leaderboardFor(aggregate);
    if (leaderboard.length > 50) throw new Error("authority vNext 结算归档参赛者数量超出上限。");
    const participantIds = new Set(leaderboard.map((entry) => entry.playerId));
    const scoreByQuestionPlayer = new Map<string, GameResultQuestionScore>();
    for (const result of aggregate.finalQuestionResults ?? aggregate.questionResults) {
      if (!participantIds.has(result.playerId) || result.scoreAwarded <= 0) continue;
      if (!Number.isInteger(result.questionIndex) || result.questionIndex < 0 || result.questionIndex >= aggregate.questions.length) {
        throw new Error("authority vNext 结算归档包含无效题号。");
      }
      if (!Number.isInteger(result.scoreAwarded)) throw new Error("authority vNext 结算归档包含无效得分。");
      const key = `${result.questionIndex}:${result.playerId}`;
      const current = scoreByQuestionPlayer.get(key);
      scoreByQuestionPlayer.set(key, {
        playerId: result.playerId,
        questionIndex: result.questionIndex,
        scoreAwarded: (current?.scoreAwarded ?? 0) + result.scoreAwarded,
      });
    }
    const questionScores = [...scoreByQuestionPlayer.values()]
      .sort((left, right) => left.questionIndex - right.questionIndex || left.playerId.localeCompare(right.playerId));
    const totals = new Map<string, { score: number; correctCount: number }>();
    for (const score of questionScores) {
      const total = totals.get(score.playerId) ?? { score: 0, correctCount: 0 };
      total.score += score.scoreAwarded;
      total.correctCount += 1;
      totals.set(score.playerId, total);
    }
    for (const entry of leaderboard) {
      const total = totals.get(entry.playerId) ?? { score: 0, correctCount: 0 };
      if (entry.score !== total.score || entry.correctCount !== total.correctCount) {
        throw new Error("authority vNext 结算归档排行榜与逐题得分不一致。");
      }
    }
    const archive: GameResultArchive = {
      version: 1,
      gameMode: session.gameMode,
      questionCount: aggregate.questions.length,
      completedAt: session.completedNormallyAt ?? session.endedAt ?? nowIso(),
      leaderboard: clone(leaderboard),
      questionScores,
    };
    if (jsonBytes(archive) > GAME_RESULT_ARCHIVE_LIMIT_BYTES) throw new Error("authority vNext 结算归档超过512KiB上限。");
    return archive;
  }

  private participantIds(aggregate: VNextAggregate) {
    return new Set(
      (aggregate.gameParticipants ?? aggregate.players)
        .filter((player) => player.role === "PLAYER" && player.id !== aggregate.gameSession?.presenterPlayerId)
        .map((player) => player.id),
    );
  }

  private publicAnswerProgress(
    answers: Answer[],
    buzzerAnswers: BuzzerAnswer[],
    changes: {
      gameSession?: GameSession;
      canceledPlayerIds?: string[];
      scores?: PlayerScore[];
      questionResults?: QuestionResult[];
      removedQuestionResultPlayerIds?: string[];
    } = {},
  ): RealtimeDelta {
    return {
      scope: "game",
      type: "answer_progress_changed",
      ...(changes.gameSession ? { gameSession: clone(changes.gameSession) } : {}),
      answers: answers.map(({ answerText, ...answer }) => ({ ...clone(answer), forfeited: answerText === FORFEIT_ANSWER_TEXT })),
      buzzerAnswers: buzzerAnswers.map(({ answerText: _answerText, ...answer }) => clone(answer)),
      ...(changes.canceledPlayerIds?.length ? { canceledPlayerIds: clone(changes.canceledPlayerIds) } : {}),
      scores: clone(changes.scores ?? []),
      questionResults: clone(changes.questionResults ?? []),
      ...(changes.removedQuestionResultPlayerIds?.length ? { removedQuestionResultPlayerIds: clone(changes.removedQuestionResultPlayerIds) } : {}),
    };
  }

  private playerJudgementDeltas(
    answers: BuzzerAnswer[],
    outcome: {
      sessionChanged: boolean;
      changedScores: PlayerScore[];
      changedQuestionResults: QuestionResult[];
      removedQuestionResultPlayerIds: string[];
    },
  ) {
    const session = this.requireActive().gameSession!;
    return answers.map((answer) => ({
      playerId: answer.playerId,
      delta: {
        scope: "game" as const,
        type: "answer_judgements_changed" as const,
        ...(outcome.sessionChanged ? { gameSession: clone(session) } : {}),
        answers: [clone(answer)],
        scores: clone(outcome.changedScores.filter((score) => score.playerId === answer.playerId)),
        questionResults: clone(outcome.changedQuestionResults.filter((result) => result.playerId === answer.playerId)),
        removedQuestionResultPlayerIds: outcome.removedQuestionResultPlayerIds.filter((playerId) => playerId === answer.playerId),
      },
    }));
  }

  private playerAnswerBackfills(playerIds: string[], answers: BuzzerAnswer[]) {
    if (!playerIds.length || !answers.length) return [];
    const session = this.requireActive().gameSession!;
    if (session.gameMode === "TEAM_BATTLE") return [];
    const deltas: RealtimeDelta[] = [];
    for (let index = 0; index < answers.length; index += ANSWER_TEXT_BACKFILL_CHUNK_SIZE) {
      deltas.push({
        scope: "game",
        type: "answer_text_backfill",
        gameSessionId: session.id,
        questionIndex: session.currentQuestionIndex,
        buzzerAnswers: clone(answers.slice(index, index + ANSWER_TEXT_BACKFILL_CHUNK_SIZE)),
      });
    }
    return playerIds.map((playerId) => ({ playerId, deltas: clone(deltas) }));
  }

  private committedDuplicateOutcome(envelope: VNextMutationEnvelope): VNextMutationOutcome {
    const aggregate = this.requireActiveOrEnded();
    const session = aggregate.gameSession!;
    const room = aggregate.room ? clone(aggregate.room) : this.committedRoomFallback(envelope.actorId);
    const answer = this.committedAnswerFor(envelope, envelope.name === "submitForfeitAnswer");
    const buzzerAnswer = this.committedBuzzerFor(envelope, answer);
    const questionResults = clone(aggregate.questionResults.filter((result) => result.questionIndex === session.currentQuestionIndex));
    const buzzerAnswers = clone(aggregate.buzzerAnswers.filter((item) => item.questionIndex === session.currentQuestionIndex));
    const scores = clone(aggregate.scores);
    let data: unknown;
    switch (envelope.name) {
      case "confirmRevealBlocks":
      case "submitTeamBattleRevealVote":
      case "submitTeamBattleGuessVote":
        data = clone(session);
        break;
      case "submitAnswer":
        data = { ...answer, buzzerAnswer };
        break;
      case "submitForfeitAnswer":
        data = answer;
        break;
      case "cancelForfeitAnswer":
        data = { gameSession: clone(session), canceledAnswerId: this.committedCanceledAnswerId(envelope) };
        break;
      case "submitBuzzerAnswer":
        data = buzzerAnswer;
        break;
      case "judgeBuzzerAnswer": {
        const answerId = getString(envelope.payload.buzzerAnswerId);
        data = {
          gameSession: clone(session),
          judgedAnswer: clone(aggregate.buzzerAnswers.find((item) => item.id === answerId) ?? buzzerAnswer),
          scores,
          questionResults,
          buzzerAnswers,
        };
        break;
      }
      case "setAnswerJudgements":
      case "markPendingRoundAnswersWrong":
        data = { gameSession: clone(session), judgedAnswers: buzzerAnswers, scores, questionResults };
        break;
      case "settleBuzzerRound":
      case "autoForfeitExpiredRound":
      case "completeTeamBattleBlockSelection":
      case "finalizeTeamBattleVote":
      case "judgeTeamBattleGuess":
      case "advanceTeamBattleTurn":
      case "revealTeamBattleAnswer":
        data = { gameSession: clone(session) };
        break;
      case "gradeAnswersAndAdvance": {
        const requested = Array.isArray(envelope.payload.correctPlayerIds)
          ? envelope.payload.correctPlayerIds.filter((playerId): playerId is string => typeof playerId === "string")
          : [];
        const scoredPlayers = new Set(questionResults.map((result) => result.playerId));
        data = { gameSession: clone(session), room: aggregate.room ? room : null, newlyScoredPlayerIds: requested.filter((playerId) => scoredPlayers.has(playerId)) };
        break;
      }
      case "updateQuestionLabel": {
        const questionId = getString(envelope.payload.questionId);
        data = clone(aggregate.questions.find((question) => question.id === questionId) ?? aggregate.questions[session.currentQuestionIndex] ?? aggregate.questions[0]);
        break;
      }
      case "joinRoom":
        data = { room: aggregate.room ? room : null, error: null, errorCode: null };
        break;
      case "leaveRoom":
        data = aggregate.room ? room : null;
        break;
      case "kickPlayerFromRoom":
      case "updatePlayerRole":
      case "cancelCurrentRound":
      case "returnRoomToLobby":
        data = room;
        break;
      case "dissolveRoom":
        data = null;
        break;
      case "advanceReviewedQuestion":
      case "skipCurrentQuestion":
      case "endCurrentGameEarly":
        data = { gameSession: clone(session), room: envelope.name === "endCurrentGameEarly" ? room : aggregate.room ? room : null, ...(envelope.name !== "endCurrentGameEarly" ? { skipped: envelope.name === "skipCurrentQuestion" } : {}) };
        break;
      default:
        throw new Error(`authority vNext committed duplicate 未定义操作契约：${envelope.name}`);
    }
    return { data, provisional: false, duplicate: true, publicDeltas: [], presenterDeltas: [], playerDeltas: [] };
  }

  private committedAnswerFor(envelope: VNextMutationEnvelope, forfeited: boolean): Answer {
    const aggregate = this.requireActiveOrEnded();
    const candidates = aggregate.answers
      .filter((answer) => answer.gameSessionId === aggregate.gameId && answer.questionIndex === envelope.questionIndex && answer.playerId === envelope.actorId)
      .sort((left, right) => right.revealRound - left.revealRound || right.submittedAt.localeCompare(left.submittedAt));
    if (candidates[0]) return clone(candidates[0]);
    return {
      id: envelope.actionId,
      gameSessionId: aggregate.gameId,
      questionIndex: envelope.questionIndex,
      revealRound: aggregate.gameSession?.currentRevealRound ?? 1,
      playerId: envelope.actorId,
      answerText: forfeited ? FORFEIT_ANSWER_TEXT : getString(envelope.payload.answerText) ?? "",
      submittedAt: nowIso(aggregate.lastCheckpointAtMs),
    };
  }

  private committedBuzzerFor(envelope: VNextMutationEnvelope, answer?: Answer): BuzzerAnswer {
    const aggregate = this.requireActiveOrEnded();
    const answerId = getString(envelope.payload.buzzerAnswerId);
    const existing = aggregate.buzzerAnswers.find((item) => item.id === answerId)
      ?? aggregate.buzzerAnswers
        .filter((item) => item.gameSessionId === aggregate.gameId && item.questionIndex === envelope.questionIndex && item.playerId === envelope.actorId)
        .sort((left, right) => right.revealRound - left.revealRound || right.submittedAt.localeCompare(left.submittedAt))[0];
    if (existing) return clone(existing);
    const submittedAt = answer?.submittedAt ?? nowIso(aggregate.lastCheckpointAtMs);
    return {
      id: envelope.name === "submitAnswer" ? `${answer?.id ?? envelope.actionId}:b` : envelope.actionId,
      gameSessionId: aggregate.gameId,
      questionIndex: envelope.questionIndex,
      revealRound: answer?.revealRound ?? aggregate.gameSession?.currentRevealRound ?? 1,
      playerId: envelope.actorId,
      answerText: answer?.answerText ?? getString(envelope.payload.answerText) ?? "",
      status: typeof envelope.payload.isCorrect === "boolean" ? envelope.payload.isCorrect ? "correct" : "wrong" : "pending",
      scoreAwarded: 0,
      submittedAt,
      serverReceivedAt: submittedAt,
    };
  }

  private committedCanceledAnswerId(envelope: VNextMutationEnvelope) {
    const aggregate = this.requireActiveOrEnded();
    return aggregate.answers.find((answer) => answer.gameSessionId === aggregate.gameId && answer.questionIndex === envelope.questionIndex && answer.playerId === envelope.actorId)?.id
      ?? `${aggregate.gameId}:${envelope.questionIndex}:${envelope.actorId}:canceled`;
  }

  private committedRoomFallback(actorId: string): Room {
    const aggregate = this.requireActiveOrEnded();
    const hostPlayerId = aggregate.players.find((player) => player.isHost)?.id ?? aggregate.players[0]?.id ?? actorId;
    return {
      id: aggregate.roomId,
      code: "",
      hostPlayerId,
      players: clone(aggregate.players),
      status: aggregate.gameSession?.status === "GAME_RESULT" ? "GAME_RESULT" : "LOBBY",
      currentPresenterPlayerId: aggregate.gameSession?.presenterPlayerId ?? null,
      currentGameId: aggregate.gameSession?.status === "GAME_RESULT" ? aggregate.gameId : null,
      createdAt: 0,
    };
  }

  private publicSessionOutcome(session: GameSession, forceCheckpoint?: CheckpointTrigger, deadlineChanged = false): VNextMutationOutcome {
    return { data: { gameSession: clone(session) }, provisional: true, publicDeltas: [{ scope: "game", type: "game_session_updated", gameSession: clone(session) }], presenterDeltas: [], playerDeltas: [], forceCheckpoint, deadlineChanged };
  }

  private directSessionOutcome(session: GameSession, forceCheckpoint?: CheckpointTrigger, deadlineChanged = false): VNextMutationOutcome {
    return { ...this.publicSessionOutcome(session, forceCheckpoint, deadlineChanged), data: clone(session) };
  }

  private terminalError(message: string): VNextMutationOutcome {
    return { error: message, terminal: true, provisional: true, publicDeltas: [], presenterDeltas: [], playerDeltas: [] };
  }

  private nonTerminalError(message: string): VNextMutationOutcome {
    return { error: message, terminal: false, provisional: false, publicDeltas: [], presenterDeltas: [], playerDeltas: [] };
  }

  private markDirty() {
    this.dirtyActionCount += 1;
    this.dirtyGeneration += 1;
    if (this.aggregate) this.aggregate.stateVersion += 1;
  }

  private advancesPublicActivity(name: string, outcome: VNextMutationOutcome) {
    if (
      name === "joinRoom" ||
      name === "leaveRoom" ||
      name === "kickPlayerFromRoom" ||
      name === "updatePlayerRole" ||
      name === "dissolveRoom" ||
      name === "updateQuestionLabel" ||
      name === "submitTeamBattleRevealVote" ||
      name === "submitTeamBattleGuessVote"
    ) {
      return false;
    }
    if (name === "cancelCurrentRound" || name === "returnRoomToLobby") return true;
    return outcome.forceCheckpoint === "phase-boundary" || outcome.forceCheckpoint === "game-end";
  }

  private rememberAction(actionId: string, outcome: VNextMutationOutcome) {
    this.recentActions.delete(actionId);
    this.recentActions.set(actionId, clone(outcome));
    while (this.recentActions.size > RECENT_ACTION_LIMIT) this.recentActions.delete(this.recentActions.keys().next().value as string);
  }

  private trimCommittedRejections(aggregate: VNextAggregate) {
    const keys = Object.keys(aggregate.terminalRejections);
    for (const key of keys.slice(0, Math.max(0, keys.length - COMMITTED_REJECTION_LIMIT))) delete aggregate.terminalRejections[key];
  }

  private safeDeserializeAttachment(socket: WebSocket): VNextSocketAttachment | null {
    try {
      const value = socket.deserializeAttachment() as Partial<VNextSocketAttachment> | null;
      if (!value || value.attachmentVersion !== 1 || !Array.isArray(value.pending)) return null;
      return { attachmentVersion: 1, topic: typeof value.topic === "string" ? value.topic : "", playerId: getString(value.playerId) ?? undefined, role: value.role, pending: value.pending.filter((item): item is VNextPendingMutation => isRecord(item) && typeof item.actionId === "string" && typeof item.actorId === "string" && Number.isInteger(item.clientSeq)), serializedBytes: typeof value.serializedBytes === "number" ? value.serializedBytes : 0 };
    } catch (error) {
      console.warn(JSON.stringify({ event: "authority_vnext_attachment_deserialize_failed", authorityVersion: 2, error: String(error) }));
      return null;
    }
  }

  private safeAppendAttachment(socket: WebSocket, action: VNextPendingMutation) {
    const current = this.safeDeserializeAttachment(socket) ?? { attachmentVersion: 1 as const, topic: "", playerId: action.actorId, pending: [], serializedBytes: 0 };
    current.playerId ??= action.actorId;
    current.pending = [...current.pending.filter((item) => !(item.actorId === action.actorId && item.clientSeq === action.clientSeq)), action];
    current.serializedBytes = jsonBytes({ ...current, serializedBytes: 0 });
    if (current.serializedBytes >= ATTACHMENT_BUDGET_BYTES) this.state.waitUntil(this.forceCheckpoint("attachment-budget").catch((error) => console.error(JSON.stringify({ event: "authority_vnext_attachment_checkpoint_failed", authorityVersion: 2, error: String(error) }))));
    if (current.serializedBytes >= ATTACHMENT_LIMIT_BYTES) current.pending = [];
    try {
      current.serializedBytes = jsonBytes({ ...current, serializedBytes: 0 });
      socket.serializeAttachment(current);
    } catch (error) {
      console.warn(JSON.stringify({ event: "authority_vnext_attachment_serialize_failed", authorityVersion: 2, bytes: current.serializedBytes, error: String(error) }));
      this.state.waitUntil(this.forceCheckpoint("attachment-budget").catch((checkpointError) => console.error(JSON.stringify({ event: "authority_vnext_attachment_checkpoint_failed", authorityVersion: 2, error: String(checkpointError) }))));
      try { socket.serializeAttachment({ attachmentVersion: 1, topic: current.topic, playerId: current.playerId, pending: [], serializedBytes: 0 } satisfies VNextSocketAttachment); } catch { /* Client Outbox is the fallback. */ }
    }
  }

  private compactAttachments(committed: Record<string, number>) {
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.safeDeserializeAttachment(socket);
      if (!attachment) continue;
      attachment.pending = attachment.pending.filter((action) => action.clientSeq > (committed[action.actorId] ?? 0));
      attachment.serializedBytes = jsonBytes({ ...attachment, serializedBytes: 0 });
      try { socket.serializeAttachment(attachment); } catch { /* Client Outbox retains unacked entries. */ }
    }
  }

  private logCheckpoint(trigger: CheckpointTrigger, changedRows: number, activeGameBytes: number, durationMs: number, version: number) {
    this.metrics.checkpoints += 1;
    this.metrics.checkpointChangedRows += changedRows;
    this.metrics.maxActiveGameBytes = Math.max(this.metrics.maxActiveGameBytes, activeGameBytes);
    this.metrics.checkpointTriggers[trigger] = (this.metrics.checkpointTriggers[trigger] ?? 0) + 1;
    console.info(JSON.stringify({ event: "authority_vnext_checkpoint", authorityVersion: 2, trigger, dirtyActionCount: this.dirtyActionCount, checkpointVersion: version, checkpointDurationMs: durationMs, estimatedSqlChangedRows: changedRows, activeGameBytes, d1Reads: this.metrics.d1Reads, d1Writes: this.metrics.d1Writes, broadcasts: this.metrics.broadcasts, broadcastBytes: this.metrics.broadcastBytes, provisionalAcks: this.metrics.provisionalAcks, durableAcks: this.metrics.durableAcks, duplicates: this.metrics.duplicates, alarmScheduled: this.metrics.alarmScheduled, alarmIgnored: this.metrics.alarmIgnored, alarmExecuted: this.metrics.alarmExecuted, alarmRetried: this.metrics.alarmRetried }));
  }
}
