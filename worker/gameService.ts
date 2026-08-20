import { AsyncLocalStorage } from "node:async_hooks";
import { createRoomCode } from "../src/lib/id";
import { CURRENT_ROOM_RUNTIME_GENERATION } from "../src/lib/roomRuntime";
import { normalizeBangumiQuestionTags } from "../src/lib/bangumiTags";
import {
  DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
  DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
  MAX_GAME_QUESTION_COUNT,
  MAX_TEAM_BATTLE_GUESS_LENGTH,
  MAX_ROOM_NOTICE_LENGTH,
  TEAM_BATTLE_ALL_SUBMITTED_GRACE_SECONDS,
} from "../src/types/game";
import { createD1QueryClient, type GameDatabase, type GameDatabaseMutationTracker } from "./d1QueryCompat";
import {
  decodeQuestionSetManifest,
  encodeQuestionSetManifest,
  QUESTION_SET_MANIFEST_VERSION,
} from "./questionSetManifest";
import {
  decodeRoomState,
  encodeRoomState,
  ROOM_STATE_MANIFEST_VERSION,
} from "./roomStateManifest";
import type {
  Answer,
  BangumiAnimeTag,
  BangumiCharacterTag,
  BuzzerAnswer,
  CommunityQuestionSetPage,
  CommunityQuestionSetSort,
  CommunityQuestionSetSummary,
  DbAnswer,
  DbBuzzerAnswer,
  DbGameSession,
  DbPlayer,
  DbPlayerScore,
  DbQuestion,
  DbQuestionResult,
  DbQuestionSet,
  DbRoom,
  GameSession,
  GameMode,
  GameBootstrapSnapshot,
  GameResultQuestionScore,
  GameResultSnapshot,
  LeaderboardEntry,
  Player,
  PlayerRole,
  PlayerScore,
  Question,
  QuestionResult,
  QuestionSet,
  QuestionSetCreationMethod,
  RoundSnapshot,
  Room,
  RoomQuestionSource,
  RoomVisibility,
  TeamBattleGuessVote,
  TeamBattleGuessProposal,
  TeamBattlePreviousTurnAction,
  TeamBattleResolvedGuess,
  TeamBattleState,
  TeamBattleTeam,
  TeamAssignmentMode,
} from "../src/types/game";

type D1QueryClient = ReturnType<typeof createD1QueryClient>;
type DbQuestionSnapshot = {
  game_session_id: string;
  question_index: number;
  eligible_player_count: number;
  eligible_player_ids?: string | null;
  created_at: string;
};
type DbQuestionEligiblePlayer = {
  game_session_id: string;
  question_index: number;
  player_id: string;
  created_at: string;
};
type DbGameParticipant = {
  game_session_id: string;
  player_id: string;
  nickname: string;
  role: PlayerRole;
  joined_at: string;
  created_at: string;
};
type DbGameResultArchive = {
  game_session_id: string;
  room_id: string;
  question_set_id: string;
  archive_version: number;
  completed_at: string;
  result_json: string;
  created_at: string;
};

const d1Context = new AsyncLocalStorage<D1QueryClient>();
const mutationTrackerContext = new AsyncLocalStorage<GameDatabaseMutationTracker>();
const unboundD1 = createD1QueryClient(null);
const DEFAULT_ROUND_SECONDS = 45;
const DEFAULT_ROUND_SCORES = [5, 3, 1];
const MAX_QUESTION_SET_QUESTIONS = MAX_GAME_QUESTION_COUNT;
const MAX_HOMEPAGE_QUESTION_SET_TITLE_LENGTH = 80;
const MAX_HOMEPAGE_QUESTION_SET_DESCRIPTION_LENGTH = 300;
const MAX_HOMEPAGE_QUESTION_LABEL_LENGTH = 100;
const d1: D1QueryClient = {
  hasDatabase() {
    return getD1().hasDatabase();
  },
  from(table: string) {
    return getD1().from(table);
  },
  insertAtomically(operations) {
    return getD1().insertAtomically(operations);
  },
  executeAtomically(operations) {
    return getD1().executeAtomically(operations);
  },
};

function getD1() {
  return d1Context.getStore() ?? unboundD1;
}

export function runWithGameDatabase<T>(db: GameDatabase, callback: () => Promise<T>, mutationTracker?: GameDatabaseMutationTracker) {
  return mutationTrackerContext.run(
    mutationTracker ?? { successfulWrites: 0 },
    () => d1Context.run(createD1QueryClient(db, mutationTracker), callback),
  );
}

function markCurrentMutationValidated() {
  mutationTrackerContext.getStore()?.markValidated?.();
}

function assertD1Env() {
  if (!d1.hasDatabase()) {
    throw new Error("数据库未连接，请确认服务已绑定游戏数据库。");
  }
}

function getD1PublicConfig(): never {
  throw new Error("当前版本不再支持直接访问数据库公共配置，请通过游戏服务操作房间。");
}

function toPlayer(player: DbPlayer): Player {
  return {
    id: player.id,
    roomId: player.room_id,
    nickname: player.nickname,
    isHost: player.is_host,
    role: normalizePlayerRole(player.role),
    joinedAt: player.joined_at,
    lastSeenAt: player.last_seen_at,
  };
}

function getRoomStatePlayers(room: DbRoom) {
  if (Number(room.runtime_generation) !== CURRENT_ROOM_RUNTIME_GENERATION) {
    throw new Error("该房间创建于服务器维护前，已经停止使用，请创建新房间。");
  }
  return decodeRoomState(room);
}

function normalizePlayerRole(role: unknown): PlayerRole {
  return role === "SPECTATOR" ? "SPECTATOR" : "PLAYER";
}

function isPlayerRole(role: unknown): role is PlayerRole {
  return role === "PLAYER" || role === "SPECTATOR";
}

function isGamePlayer(player: Pick<DbPlayer, "role">) {
  return normalizePlayerRole(player.role) === "PLAYER";
}

function countGamePlayers(players: Pick<DbPlayer, "role">[]) {
  return players.filter(isGamePlayer).length;
}

function countSpectators(players: Pick<DbPlayer, "role">[]) {
  return players.length - countGamePlayers(players);
}

function isGameMode(value: unknown): value is GameMode {
  return value === "ROUND_REVEAL" || value === "BUZZER_FIRST_CORRECT" || value === "BUZZER_RANKED" || value === "TEAM_BATTLE";
}

function normalizeMaxRevealRounds(value: unknown) {
  return Math.max(1, Math.min(10, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : 3)));
}

function normalizeRoundSeconds(value: unknown) {
  return Math.max(1, Math.min(600, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_ROUND_SECONDS)));
}

function normalizeTeamAssignmentMode(value: unknown): TeamAssignmentMode {
  return value === "MANUAL" ? "MANUAL" : "AUTO";
}

function normalizeTeamAssignments(value: unknown): Partial<Record<string, TeamBattleTeam>> {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      source = {};
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, TeamBattleTeam] => entry[1] === "red" || entry[1] === "blue"),
  );
}

function sanitizeTeamAssignments(room: DbRoom, players: DbPlayer[]) {
  const assignments = normalizeTeamAssignments(room.lobby_team_assignments);
  if (room.current_presenter_player_id) delete assignments[room.current_presenter_player_id];
  if (players.length === 0) return assignments;
  const eligible = new Set(
    players
      .filter(isGamePlayer)
      .filter((player) => player.id !== room.current_presenter_player_id)
      .map((player) => player.id),
  );
  return Object.fromEntries(Object.entries(assignments).filter(([playerId]) => eligible.has(playerId)));
}

function normalizeTeamBattleVoteSeconds(value: unknown, fallback: number) {
  return Math.max(1, Math.min(600, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : fallback)));
}

function normalizePlayerCapacity(value: unknown) {
  return Math.max(1, Math.min(50, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : 50)));
}

function normalizeSpectatorCapacity(value: unknown) {
  return Math.max(0, Math.min(50, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : 50)));
}

function normalizeQuestionCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_QUESTION_SET_QUESTIONS
    ? value
    : null;
}

// 房间级“包含 R18 题目”开关的权威过滤：关闭时排除 is_r18=true 的候选题。
// 旧题缺 is_r18 视为 false，因此默认关闭时旧题库不受影响。
function filterQuestionsByR18(questions: readonly DbQuestion[], includeR18: boolean) {
  return includeR18 ? [...questions] : questions.filter((question) => !isDbTruthy(question.is_r18));
}

async function getEligibleQuestionCountForPreparedSet(questionSetId: string, includeR18: boolean) {
  const { data: questionSet, error } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", questionSetId)
    .maybeSingle<DbQuestionSet>();
  if (error) throw new Error(error.message);
  if (!questionSet) return 0;
  const questions = await getDbQuestionsForQuestionSet(questionSet);
  return filterQuestionsByR18(questions, includeR18).length;
}

function requireQuestionCount(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_QUESTION_SET_QUESTIONS) {
    throw new Error(`本局题数必须是 1 到 ${MAX_QUESTION_SET_QUESTIONS} 之间的整数，或选择全部题目。`);
  }
  return value;
}

function requireStartQuestionCount(value: unknown, availableQuestionCount: number) {
  if (value == null) return Math.min(availableQuestionCount, MAX_QUESTION_SET_QUESTIONS);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_QUESTION_SET_QUESTIONS) {
    rejectStartGame(`开始游戏失败：本局题数必须是 1 到 ${MAX_QUESTION_SET_QUESTIONS} 之间的整数，或选择全部题目。`);
  }
  if (value > availableQuestionCount) {
    rejectStartGame(`开始游戏失败：本局抽取 ${value} 道题，但当前题库只有 ${availableQuestionCount} 道题。`);
  }
  return value;
}

function requirePlayerCapacity(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("玩家人数上限必须是 1 到 50 之间的整数。");
  }
  return value;
}

function requireSpectatorCapacity(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 50) {
    throw new Error("观战人数上限必须是 0 到 50 之间的整数。");
  }
  return value;
}

function normalizeRoundScores(value: unknown, maxRevealRounds: number) {
  let source: unknown[] = [];
  if (Array.isArray(value)) {
    source = value;
  } else if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      source = Array.isArray(parsed) ? parsed : [];
    } catch {
      source = [];
    }
  }

  return Array.from({ length: maxRevealRounds }, (_, index) => {
    const score = source[index] ?? DEFAULT_ROUND_SCORES[index] ?? Math.max(1, maxRevealRounds - index);
    return Math.max(0, Math.floor(typeof score === "number" && Number.isFinite(score) ? score : 0));
  });
}

function toRoom(room: DbRoom, players: DbPlayer[] = getRoomStatePlayers(room)): Room {
  const maxRevealRounds = normalizeMaxRevealRounds(room.lobby_max_reveal_rounds);
  return {
    id: room.id,
    code: room.room_code,
    hostPlayerId: room.host_player_id,
    players: players.map(toPlayer),
    status: room.game_status,
    currentPresenterPlayerId: room.current_presenter_player_id,
    currentGameId: room.current_game_id,
    preparedQuestionSetId: room.prepared_question_set_id ?? null,
    preparedQuestionCount: normalizeQuestionCount(room.prepared_question_count),
    questionCount: normalizeQuestionCount(room.lobby_question_count),
    visibility: room.room_visibility ?? "PRIVATE",
    name: room.room_name ?? null,
    notice: room.room_notice ?? null,
    playerCount: room.member_count ?? countGamePlayers(players),
    playerCapacity: normalizePlayerCapacity(room.lobby_player_capacity),
    spectatorCapacity: normalizeSpectatorCapacity(room.lobby_spectator_capacity),
    preparedQuestionSource: room.prepared_question_source ?? null,
    gameMode: room.lobby_game_mode ?? "ROUND_REVEAL",
    maxRevealRounds,
    roundSeconds: normalizeRoundSeconds(room.lobby_round_seconds),
    roundScores: normalizeRoundScores(room.lobby_round_scores, maxRevealRounds),
    teamRevealVoteSeconds: normalizeTeamBattleVoteSeconds(
      room.lobby_team_reveal_vote_seconds,
      DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
    ),
    teamGuessVoteSeconds: normalizeTeamBattleVoteSeconds(
      room.lobby_team_guess_vote_seconds,
      DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
    ),
    teamPresenterBlockEnabled:
      room.lobby_team_presenter_block_enabled === 1 || room.lobby_team_presenter_block_enabled === true,
    spectatorQuestionPreviewEnabled:
      room.lobby_spectator_question_preview_enabled !== 0 && room.lobby_spectator_question_preview_enabled !== false,
    spectatorPlayerAnswersEnabled:
      room.lobby_spectator_player_answers_enabled !== 0 && room.lobby_spectator_player_answers_enabled !== false,
    teamAssignmentMode: normalizeTeamAssignmentMode(room.lobby_team_assignment_mode),
    teamAssignments: sanitizeTeamAssignments(room, players),
    includeR18: isDbTruthy(room.lobby_include_r18),
    createdAt: room.created_at,
    updatedAt: room.updated_at,
  };
}

function toQuestion(question: DbQuestion): Question {
  return {
    id: question.id,
    questionSetId: question.question_set_id,
    imageUrl: question.image_url,
    orderIndex: question.order_index,
    isR18: isDbTruthy(question.is_r18),
    labelText: question.label_text ?? null,
    labelSource: question.label_source ?? null,
    labelSourceAnswerId: question.label_source_answer_id ?? null,
    labelUpdatedByPlayerId: question.label_updated_by_player_id ?? null,
    labelUpdatedAt: question.label_updated_at ?? null,
    createdAt: question.created_at,
  };
}

function toQuestionSet(questionSet: DbQuestionSet, questions: DbQuestion[] = []): QuestionSet {
  const questionUrlsText = questions
    .slice()
    .sort((a, b) => a.order_index - b.order_index)
    .map((question) => question.image_url)
    .join("\n");

  return {
    id: questionSet.id,
    title: questionSet.title,
    description: questionSet.description,
    createdByPlayerId: questionSet.created_by_player_id,
    createdByNickname: questionSet.created_by_nickname ?? null,
    source: questionSet.source,
    creationMethod: questionSet.creation_method ?? null,
    isPublic: questionSet.is_public,
    imageUrlsText: questionSet.image_urls_text ?? questionUrlsText,
    imageCount: questionSet.image_count,
    ratingAvg: questionSet.rating_avg,
    ratingCount: questionSet.rating_count,
    playCount: questionSet.play_count ?? 0,
    createdAt: questionSet.created_at,
    updatedAt: questionSet.updated_at,
    questions: questions.map(toQuestion),
  };
}

function toGameQuestionSet(questionSet: DbQuestionSet, questions: DbQuestion[]) {
  return {
    ...toQuestionSet(questionSet, questions),
    imageUrlsText: questions.map((question) => question.image_url).join("\n"),
  };
}

async function getPlayerNickname(playerId: string, roomId?: string) {
  assertD1Env();
  if (!roomId) return null;
  const room = await getDbRoomById(roomId);
  if (!room) return null;
  return getRoomStatePlayers(room).find((player) => player.id === playerId)?.nickname.trim() || null;
}

function toGameSession(gameSession: DbGameSession): GameSession {
  const revealedBlocks = Array.isArray(gameSession.revealed_blocks)
    ? Array.from(
        new Set(
          gameSession.revealed_blocks.filter(
            (block): block is number => Number.isInteger(block) && block >= 0 && block < REVEAL_BLOCK_COUNT,
          ),
        ),
      ).sort((a, b) => a - b)
    : [];
  const roundScores = Array.isArray(gameSession.round_scores)
    ? gameSession.round_scores.filter((score): score is number => Number.isFinite(score))
    : DEFAULT_ROUND_SCORES;
  const teamBattleState = parseTeamBattleState(gameSession.team_battle_state);

  return {
    id: gameSession.id,
    roomId: gameSession.room_id,
    questionSetId: gameSession.question_set_id,
    presenterPlayerId: gameSession.presenter_player_id,
    status: gameSession.status,
    gameMode: gameSession.game_mode ?? "ROUND_REVEAL",
    currentQuestionIndex: gameSession.current_question_index,
    currentRevealRound: gameSession.current_reveal_round,
    revealedBlocks,
    maxRevealRounds: gameSession.max_reveal_rounds ?? 3,
    roundSeconds: gameSession.round_seconds ?? DEFAULT_ROUND_SECONDS,
    roundScores,
    questionCount: normalizeSelectedQuestionIds(gameSession.selected_question_ids).length || undefined,
    roundStartedAt: gameSession.round_started_at,
    serverNow: new Date().toISOString(),
    teamBattleState,
    createdAt: gameSession.created_at,
    endedAt: gameSession.ended_at,
    completedNormallyAt: gameSession.completed_normally_at ?? null,
  };
}

function parseTeamBattleState(value: unknown): TeamBattleState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<TeamBattleState>;
  const teamsRecord = record.teams && typeof record.teams === "object" ? record.teams : null;
  const redTeam = Array.isArray(teamsRecord?.red) ? teamsRecord.red.filter((id): id is string => typeof id === "string") : [];
  const blueTeam = Array.isArray(teamsRecord?.blue) ? teamsRecord.blue.filter((id): id is string => typeof id === "string") : [];
  const initialTeamsRecord = record.initialTeams && typeof record.initialTeams === "object" ? record.initialTeams : null;
  const initialRedTeam = Array.isArray(initialTeamsRecord?.red)
    ? initialTeamsRecord.red.filter((id): id is string => typeof id === "string")
    : redTeam;
  const initialBlueTeam = Array.isArray(initialTeamsRecord?.blue)
    ? initialTeamsRecord.blue.filter((id): id is string => typeof id === "string")
    : blueTeam;
  const teamMemberNames = normalizeTeamMemberNames(record.teamMemberNames);
  const activeTeam = record.activeTeam === "blue" ? "blue" : "red";
  const phase =
    record.phase === "PRESENTER_BLOCK" ||
    record.phase === "GUESS_VOTE" ||
    record.phase === "JUDGING" ||
    record.phase === "TURN_RESULT" ||
    record.phase === "REVIEW"
      ? record.phase
      : "REVEAL_VOTE";
  const teamScoresRecord = record.teamScores && typeof record.teamScores === "object" ? record.teamScores : null;

  return {
    teams: {
      red: redTeam,
      blue: blueTeam,
    },
    initialTeams: {
      red: initialRedTeam,
      blue: initialBlueTeam,
    },
    teamMemberNames,
    activeTeam,
    phase,
    presenterBlockEnabled: typeof record.presenterBlockEnabled === "boolean" ? record.presenterBlockEnabled : undefined,
    revealBlockCount: normalizeRevealBlockCount(record.revealBlockCount),
    disabledBlocks: Array.isArray(record.disabledBlocks)
      ? normalizeDisabledBlocks(record.disabledBlocks, normalizeRevealBlockCount(record.revealBlockCount))
      : undefined,
    revealLimit: Math.max(1, Math.min(10, Math.floor(Number(record.revealLimit) || 1))),
    turnNumber: Math.max(1, Math.floor(Number(record.turnNumber) || 1)),
    revealVoteSeconds: normalizeTeamBattleVoteSeconds(
      record.revealVoteSeconds,
      DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
    ),
    guessVoteSeconds: normalizeTeamBattleVoteSeconds(
      record.guessVoteSeconds,
      DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
    ),
    voteDeadlineAt: typeof record.voteDeadlineAt === "string" ? record.voteDeadlineAt : null,
    revealVotes: normalizeRevealVotes(record.revealVotes),
    guessVotes: normalizeGuessVotes(record.guessVotes),
    guessProposals: normalizeGuessProposals(record.guessProposals),
    previousTurnAction: normalizePreviousTurnAction(record.previousTurnAction),
    pendingGuess: normalizeResolvedTeamGuess(record.pendingGuess),
    correctGuess: normalizeResolvedTeamGuess(record.correctGuess),
    teamScores: {
      red: Math.max(0, Math.floor(Number(teamScoresRecord?.red) || 0)),
      blue: Math.max(0, Math.floor(Number(teamScoresRecord?.blue) || 0)),
    },
    message: typeof record.message === "string" ? record.message : null,
  };
}

function normalizeResolvedTeamGuess(value: unknown): TeamBattleResolvedGuess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as { team?: unknown; answerText?: unknown; proposerPlayerId?: unknown; proposerName?: unknown };
  if ((record.team !== "red" && record.team !== "blue") || typeof record.answerText !== "string") {
    return null;
  }

  return {
    team: record.team,
    answerText: record.answerText,
    proposerPlayerId: typeof record.proposerPlayerId === "string" ? record.proposerPlayerId : undefined,
    proposerName: typeof record.proposerName === "string" ? record.proposerName : undefined,
  };
}

function normalizePreviousTurnAction(value: unknown): TeamBattlePreviousTurnAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as { team?: unknown; type?: unknown; answerText?: unknown };
  if (record.team !== "red" && record.team !== "blue") {
    return null;
  }

  if (record.type === "skip") {
    return { team: record.team, type: "skip" };
  }

  if (record.type === "guess" && typeof record.answerText === "string" && record.answerText.trim()) {
    return { team: record.team, type: "guess", answerText: record.answerText.trim() };
  }

  return null;
}

function normalizeTeamMemberNames(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const names: Record<string, string> = {};
  for (const [playerId, nickname] of Object.entries(value)) {
    if (typeof nickname === "string" && nickname.trim()) {
      names[playerId] = nickname.trim();
    }
  }

  return names;
}

function normalizeRevealVotes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const votes: Record<string, number[]> = {};
  for (const [playerId, blocks] of Object.entries(value)) {
    if (Array.isArray(blocks)) {
      votes[playerId] = Array.from(
        new Set(blocks.filter((block): block is number => Number.isInteger(block) && block >= 0 && block < REVEAL_BLOCK_COUNT)),
      ).sort((a, b) => a - b);
    }
  }

  return votes;
}

function normalizeGuessVotes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const votes: Record<string, TeamBattleGuessVote> = {};
  for (const [playerId, vote] of Object.entries(value)) {
    if (!vote || typeof vote !== "object" || Array.isArray(vote)) {
      continue;
    }

    const record = vote as Partial<TeamBattleGuessVote>;
    if (record.type === "skip") {
      votes[playerId] = { type: "skip" };
    } else if (record.type === "guess" && typeof record.answerText === "string" && record.answerText.trim()) {
      votes[playerId] = { type: "guess", answerText: record.answerText.trim() };
    }
  }

  return votes;
}

function normalizeGuessProposals(value: unknown) {
  if (!Array.isArray(value)) return [];
  const proposals: TeamBattleGuessProposal[] = [];
  const seenAnswers = new Set<string>();
  for (const proposal of value) {
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) continue;
    const record = proposal as Partial<TeamBattleGuessProposal>;
    const answerText = typeof record.answerText === "string" ? record.answerText.trim() : "";
    if (
      !answerText ||
      seenAnswers.has(answerText) ||
      typeof record.proposerPlayerId !== "string" ||
      typeof record.proposerName !== "string"
    ) continue;
    seenAnswers.add(answerText);
    proposals.push({
      answerText,
      proposerPlayerId: record.proposerPlayerId,
      proposerName: record.proposerName,
    });
  }
  return proposals;
}

function rebuildTeamGuessProposals(state: TeamBattleState) {
  const proposals = normalizeGuessProposals(state.guessProposals);
  const proposalByAnswer = new Map(proposals.map((proposal) => [proposal.answerText, proposal]));
  for (const [voterId, vote] of Object.entries(state.guessVotes)) {
    if (vote.type !== "guess") continue;
    const answerText = vote.answerText?.trim() ?? "";
    if (!answerText) continue;
    let proposal = proposalByAnswer.get(answerText);
    if (!proposal) {
      proposal = {
        answerText,
        proposerPlayerId: voterId,
        proposerName: state.teamMemberNames?.[voterId] ?? "已离开玩家",
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
      .map((vote) => vote.answerText?.trim() ?? "")
      .filter(Boolean),
  );
  state.guessProposals = (state.guessProposals ?? []).filter((proposal) => activeAnswers.has(proposal.answerText));
}

function randomInt(maxExclusive: number) {
  return Math.floor(Math.random() * maxExclusive);
}

function secureRandomInt(maxExclusive: number) {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x100000000) {
    throw new Error("随机抽题范围无效。");
  }
  const range = 0x100000000;
  const acceptedLimit = Math.floor(range / maxExclusive) * maxExclusive;
  const randomValue = new Uint32Array(1);
  do {
    crypto.getRandomValues(randomValue);
  } while (randomValue[0] >= acceptedLimit);
  return randomValue[0] % maxExclusive;
}

export function selectQuestionsForGame<T>(
  questions: readonly T[],
  questionCount: number,
  getRandomInt: (maxExclusive: number) => number = secureRandomInt,
) {
  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > questions.length) {
    throw new Error("本局抽取题数无效。");
  }
  if (questionCount === questions.length) return [...questions];

  const shuffled = [...questions];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = getRandomInt(index + 1);
    if (!Number.isInteger(swapIndex) || swapIndex < 0 || swapIndex > index) {
      throw new Error("随机抽题结果无效。");
    }
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, questionCount);
}

function shuffleItems<T>(items: T[]) {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function getTeamBattleVoteSeconds(state: TeamBattleState, phase: "REVEAL_VOTE" | "GUESS_VOTE") {
  return phase === "REVEAL_VOTE"
    ? normalizeTeamBattleVoteSeconds(state.revealVoteSeconds, DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS)
    : normalizeTeamBattleVoteSeconds(state.guessVoteSeconds, DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS);
}

function withFixedTeamBattleDeadline(
  state: TeamBattleState,
  phase: "REVEAL_VOTE" | "GUESS_VOTE",
  nowMs = Date.now(),
): TeamBattleState {
  if (state.teams.red.length === 0 && state.teams.blue.length === 0) {
    return { ...state, phase, voteDeadlineAt: null };
  }
  return {
    ...state,
    phase,
    voteDeadlineAt: new Date(nowMs + getTeamBattleVoteSeconds(state, phase) * 1000).toISOString(),
  };
}

function withShortenedTeamBattleDeadlineAfterAllSubmitted(state: TeamBattleState, nowMs: number) {
  if ((state.phase !== "REVEAL_VOTE" && state.phase !== "GUESS_VOTE") || !state.voteDeadlineAt) return state;
  const members = state.teams[state.activeTeam];
  const votes = state.phase === "REVEAL_VOTE" ? state.revealVotes : state.guessVotes;
  if (!members.length || !members.every((playerId) => Object.prototype.hasOwnProperty.call(votes, playerId))) return state;
  const currentRunAtMs = new Date(state.voteDeadlineAt).getTime();
  const shortenedRunAtMs = nowMs + TEAM_BATTLE_ALL_SUBMITTED_GRACE_SECONDS * 1000;
  if (!Number.isFinite(currentRunAtMs) || currentRunAtMs <= shortenedRunAtMs) return state;
  return { ...state, voteDeadlineAt: new Date(shortenedRunAtMs).toISOString() };
}

function createInitialTeamBattleState(
  players: DbPlayer[],
  presenterPlayerId: string,
  options?: {
    previousScores?: Record<TeamBattleTeam, number>;
    revealVoteSeconds?: number;
    guessVoteSeconds?: number;
    presenterBlockEnabled?: boolean;
    manualAssignments?: Partial<Record<string, TeamBattleTeam>>;
  },
): TeamBattleState {
  const eligibleGuessers = players.filter((player) => isGamePlayer(player) && player.id !== presenterPlayerId);
  const guessers = options?.manualAssignments ? eligibleGuessers : shuffleItems(eligibleGuessers);
  const largerTeamSize = Math.ceil(guessers.length / 2);
  const redGetsExtraPlayer = guessers.length % 2 === 1 ? randomInt(2) === 0 : true;
  const redTeamSize = redGetsExtraPlayer ? largerTeamSize : Math.floor(guessers.length / 2);
  const red = options?.manualAssignments
    ? guessers.filter((player) => options.manualAssignments?.[player.id] === "red").map((player) => player.id)
    : guessers.slice(0, redTeamSize).map((player) => player.id);
  const blue = options?.manualAssignments
    ? guessers.filter((player) => options.manualAssignments?.[player.id] === "blue").map((player) => player.id)
    : guessers.slice(redTeamSize).map((player) => player.id);
  const teamMemberNames = Object.fromEntries(guessers.map((player) => [player.id, player.nickname.trim() || "已离开玩家"]));
  const presenterBlockEnabled = options?.presenterBlockEnabled === true;

  return {
    teams: { red, blue },
    initialTeams: { red, blue },
    teamMemberNames,
    activeTeam: "red",
    phase: presenterBlockEnabled ? "PRESENTER_BLOCK" : "REVEAL_VOTE",
    presenterBlockEnabled,
    disabledBlocks: [],
    revealLimit: 1,
    turnNumber: 1,
    revealVoteSeconds: normalizeTeamBattleVoteSeconds(
      options?.revealVoteSeconds,
      DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
    ),
    guessVoteSeconds: normalizeTeamBattleVoteSeconds(
      options?.guessVoteSeconds,
      DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
    ),
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    guessProposals: [],
    previousTurnAction: null,
    pendingGuess: null,
    correctGuess: null,
    teamScores: options?.previousScores ?? { red: 0, blue: 0 },
    message: presenterBlockEnabled ? "等待出题人禁用格子" : "红队选格",
  };
}

async function resetTeamBattleStateForQuestion(
  state: TeamBattleState,
  roomId: string,
  presenterPlayerId: string,
  questionIndex: number,
): Promise<TeamBattleState> {
  const players = getRoomStatePlayers(room);
  const activeGuessers = players.filter((player) => isGamePlayer(player) && player.id !== presenterPlayerId);
  const activeGuesserById = new Map(activeGuessers.map((player) => [player.id, player]));
  const assigned = new Set<string>();
  const teams: Record<TeamBattleTeam, string[]> = {
    red: [],
    blue: [],
  };

  for (const team of ["red", "blue"] as const) {
    for (const memberId of state.teams[team]) {
      if (activeGuesserById.has(memberId) && !assigned.has(memberId)) {
        teams[team].push(memberId);
        assigned.add(memberId);
      }
    }
  }

  const newGuessers = activeGuessers.filter((player) => !assigned.has(player.id));
  for (const player of newGuessers) {
    const targetTeam = teams.red.length <= teams.blue.length ? "red" : "blue";
    teams[targetTeam].push(player.id);
    assigned.add(player.id);
  }

  const teamMemberNames = Object.fromEntries(
    [...teams.red, ...teams.blue].map((playerId) => [
      playerId,
      activeGuesserById.get(playerId)?.nickname.trim() || state.teamMemberNames?.[playerId] || "已离开玩家",
    ]),
  );
  const initialTeams: Record<TeamBattleTeam, string[]> = {
    red: [...(state.initialTeams?.red ?? state.teams.red)],
    blue: [...(state.initialTeams?.blue ?? state.teams.blue)],
  };
  for (const team of ["red", "blue"] as const) {
    for (const memberId of teams[team]) {
      if (!initialTeams.red.includes(memberId) && !initialTeams.blue.includes(memberId)) {
        initialTeams[team].push(memberId);
      }
    }
  }
  const activeTeam = getAvailableTeamBattleStartingTeam(teams, questionIndex);
  const presenterBlockEnabled = state.presenterBlockEnabled !== false;

  const nextState: TeamBattleState = {
    teams,
    initialTeams,
    teamMemberNames: {
      ...(state.teamMemberNames ?? {}),
      ...teamMemberNames,
    },
    activeTeam,
    phase: presenterBlockEnabled ? "PRESENTER_BLOCK" : "REVEAL_VOTE",
    presenterBlockEnabled,
    disabledBlocks: [],
    revealLimit: 1,
    turnNumber: state.turnNumber + 1,
    revealVoteSeconds: getTeamBattleVoteSeconds(state, "REVEAL_VOTE"),
    guessVoteSeconds: getTeamBattleVoteSeconds(state, "GUESS_VOTE"),
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    guessProposals: [],
    previousTurnAction: null,
    pendingGuess: null,
    correctGuess: null,
    teamScores: state.teamScores,
    message: presenterBlockEnabled
      ? newGuessers.length > 0
        ? "新玩家已分队 · 等待出题人禁用格子"
        : "等待出题人禁用格子"
      : newGuessers.length > 0
        ? `新玩家已分队 · ${getTeamName(activeTeam)}选格`
        : `${getTeamName(activeTeam)}选格`,
  };
  return presenterBlockEnabled ? nextState : startTeamBattleVotePhase(nextState, "REVEAL_VOTE", Date.now());
}

function getOpposingTeam(team: TeamBattleTeam): TeamBattleTeam {
  return team === "red" ? "blue" : "red";
}

function getTeamBattleStartingTeamForQuestion(questionIndex: number): TeamBattleTeam {
  return questionIndex % 2 === 0 ? "red" : "blue";
}

function getAvailableTeamBattleStartingTeam(teams: Record<TeamBattleTeam, string[]>, questionIndex: number): TeamBattleTeam {
  const preferredTeam = getTeamBattleStartingTeamForQuestion(questionIndex);

  return teams[preferredTeam].length > 0 ? preferredTeam : getOpposingTeam(preferredTeam);
}

function getTeamName(team: TeamBattleTeam) {
  return team === "red" ? "红队" : "蓝队";
}

function getTeamMembers(state: TeamBattleState, team: TeamBattleTeam) {
  return state.teams[team] ?? [];
}

function getPlayerTeam(state: TeamBattleState, playerId: string): TeamBattleTeam | null {
  if (state.teams.red.includes(playerId)) {
    return "red";
  }
  if (state.teams.blue.includes(playerId)) {
    return "blue";
  }
  return null;
}

export function removePlayerFromTeamBattleState(
  state: TeamBattleState,
  playerId: string,
  nowMs = Date.now(),
  revealedBlocks: number[] = [],
): TeamBattleState {
  const teams = {
    red: state.teams.red.filter((memberId) => memberId !== playerId),
    blue: state.teams.blue.filter((memberId) => memberId !== playerId),
  };

  if (teams.red.length === state.teams.red.length && teams.blue.length === state.teams.blue.length) {
    return state;
  }

  const revealVotes = { ...state.revealVotes };
  const guessVotes = { ...state.guessVotes };
  delete revealVotes[playerId];
  delete guessVotes[playerId];

  let nextState: TeamBattleState = {
    ...state,
    teams,
    revealVotes,
    guessVotes,
  };
  pruneUnusedTeamGuessProposals(nextState);

  if (nextState.phase !== "TURN_RESULT" && teams[nextState.activeTeam].length === 0) {
    const nextTeam = getOpposingTeam(nextState.activeTeam);
    if (teams[nextTeam].length > 0) {
      const switchedState: TeamBattleState = {
        ...nextState,
        activeTeam: nextTeam,
        voteDeadlineAt: null,
        revealVotes: {},
        guessVotes: {},
        guessProposals: [],
        pendingGuess: null,
        message: `${getTeamName(getOpposingTeam(nextTeam))}没有在线队员，轮到${getTeamName(nextTeam)}。`,
      };
      nextState = switchedState.phase === "REVEAL_VOTE" || switchedState.phase === "GUESS_VOTE"
        ? withFixedTeamBattleDeadline(switchedState, switchedState.phase)
        : switchedState.phase === "JUDGING"
          ? withFixedTeamBattleDeadline(
              switchedState,
              getSelectableTeamBattleBlocks(
                { revealedBlocks },
                switchedState,
                normalizeRevealBlockCount(switchedState.revealBlockCount),
              ).length === 0
                ? "GUESS_VOTE"
                : "REVEAL_VOTE",
            )
          : switchedState;
    } else {
      nextState = {
        ...nextState,
        voteDeadlineAt: null,
        revealVotes: {},
        guessVotes: {},
        guessProposals: [],
        pendingGuess: null,
        message: "双方都没有在线队员，已停止自动投票，请出题人公布答案或结束游戏。",
      };
    }
  }
  return withShortenedTeamBattleDeadlineAfterAllSubmitted(nextState, nowMs);
}

async function removePlayerFromCurrentTeamBattle(gameSessionId: string, playerId: string) {
  const { data: gameSession, error } = await d1.from("game_sessions").select("*").eq("id", gameSessionId).maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!gameSession || gameSession.status !== "PLAYING" || gameSession.game_mode !== "TEAM_BATTLE") {
    return;
  }

  const state = parseTeamBattleState(gameSession.team_battle_state);
  if (!state) {
    return;
  }

  const nextState = removePlayerFromTeamBattleState(state, playerId, Date.now(), toGameSession(gameSession).revealedBlocks);
  if (nextState === state) {
    return;
  }

  const { error: updateError } = await updateTeamBattleState(gameSessionId, nextState);
  if (updateError) {
    throw new Error(updateError.message);
  }
}

async function assertRemovingPlayerKeepsTeamBattlePlayable(gameSessionId: string, playerId: string) {
  const { data: gameSession, error } = await d1.from("game_sessions").select("*").eq("id", gameSessionId).maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!gameSession || gameSession.status !== "PLAYING" || gameSession.game_mode !== "TEAM_BATTLE") {
    return;
  }

  const state = parseTeamBattleState(gameSession.team_battle_state);
  if (!state) {
    return;
  }

  const playerTeam = getPlayerTeam(state, playerId);
  if (playerTeam && getTeamMembers(state, playerTeam).length <= 1) {
    throw new Error("踢出该玩家会导致队伍为空，请取消本局后重新开始。");
  }
}

async function removePlayerFromCurrentGame(gameSessionId: string, playerId: string) {
  const { data: gameSession, error } = await d1.from("game_sessions").select("*").eq("id", gameSessionId).maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!gameSession || gameSession.status !== "PLAYING") {
    return;
  }

  if (gameSession.game_mode === "TEAM_BATTLE") {
    await removePlayerFromCurrentTeamBattle(gameSession.id, playerId);
  }
}

function assertTeamBattleSession(gameSession: DbGameSession) {
  const session = toGameSession(gameSession);
  if (session.gameMode !== "TEAM_BATTLE" || !session.teamBattleState) {
    throw new Error("当前游戏不是红蓝对抗模式，不能执行该操作。");
  }
  return session;
}

function voteDeadlineReached(state: TeamBattleState) {
  return Boolean(state.voteDeadlineAt && Date.now() >= new Date(state.voteDeadlineAt).getTime());
}

function randomChoice<T>(items: T[]) {
  return items[randomInt(items.length)];
}

function isForfeitAnswer(answer: Pick<DbAnswer, "answer_text"> | Pick<Answer, "answerText">) {
  return "answer_text" in answer ? answer.answer_text === FORFEIT_ANSWER_TEXT : answer.answerText === FORFEIT_ANSWER_TEXT;
}

function getCorrectAnswersForLabel<T extends { player_id: string; submitted_at: string; reveal_round: number; id: string }>(
  answers: T[],
  questionResults: DbQuestionResult[],
) {
  const correctAnswerKeySet = new Set(
    questionResults.map((result) => getPlayerRoundAnswerKey(result.player_id, result.scored_round)),
  );

  return answers
    .filter((answer) => correctAnswerKeySet.has(getPlayerRoundAnswerKey(answer.player_id, answer.reveal_round)))
    .sort(compareAnswerOrder);
}

function getPlayerRoundAnswerKey(playerId: string, revealRound: number) {
  return `${playerId}:${revealRound}`;
}

function compareAnswerOrder(
  left: { submitted_at: string; server_received_at?: string | null; reveal_round: number; id: string },
  right: { submitted_at: string; server_received_at?: string | null; reveal_round: number; id: string },
) {
  const submittedAtDiff = new Date(left.submitted_at).getTime() - new Date(right.submitted_at).getTime();
  if (Number.isFinite(submittedAtDiff) && submittedAtDiff !== 0) {
    return submittedAtDiff;
  }

  const submittedAtTextDiff = left.submitted_at.localeCompare(right.submitted_at);
  if (submittedAtTextDiff !== 0) {
    return submittedAtTextDiff;
  }

  const receivedAtDiff =
    new Date(left.server_received_at ?? left.submitted_at).getTime() -
    new Date(right.server_received_at ?? right.submitted_at).getTime();
  if (Number.isFinite(receivedAtDiff) && receivedAtDiff !== 0) {
    return receivedAtDiff;
  }

  return left.reveal_round - right.reveal_round || left.id.localeCompare(right.id);
}

function compareRankedAnswerOrder(
  left: { submitted_at: string; server_received_at?: string | null; reveal_round: number; id: string },
  right: { submitted_at: string; server_received_at?: string | null; reveal_round: number; id: string },
) {
  const leftReceivedAt = left.server_received_at ?? left.submitted_at;
  const rightReceivedAt = right.server_received_at ?? right.submitted_at;
  const receivedAtDiff = new Date(leftReceivedAt).getTime() - new Date(rightReceivedAt).getTime();
  if (Number.isFinite(receivedAtDiff) && receivedAtDiff !== 0) {
    return receivedAtDiff;
  }

  const receivedAtTextDiff = leftReceivedAt.localeCompare(rightReceivedAt);
  if (receivedAtTextDiff !== 0) {
    return receivedAtTextDiff;
  }

  const submittedAtDiff = new Date(left.submitted_at).getTime() - new Date(right.submitted_at).getTime();
  if (Number.isFinite(submittedAtDiff) && submittedAtDiff !== 0) {
    return submittedAtDiff;
  }

  return left.submitted_at.localeCompare(right.submitted_at) ||
    left.reveal_round - right.reveal_round ||
    left.id.localeCompare(right.id);
}

function canUseForfeitAnswer(gameMode: GameMode) {
  return gameMode !== "TEAM_BATTLE";
}

function isBuzzerAnswerReadyForJudging(answer: Pick<DbBuzzerAnswer, "submitted_at" | "server_received_at">, nowMs = Date.now()) {
  return nowMs - new Date(answer.server_received_at ?? answer.submitted_at).getTime() >= BUZZER_JUDGING_STABILIZE_MS;
}

function parseEligiblePlayerIds(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((playerId): playerId is string => typeof playerId === "string") : null;
  } catch {
    return null;
  }
}

function getQuestionEligiblePlayerIdsFromSnapshot(snapshot: DbQuestionSnapshot) {
  const playerIds = parseEligiblePlayerIds(snapshot.eligible_player_ids);
  return playerIds ?? null;
}

function isMissingEligibilityTableError(error: { message?: string } | null) {
  const message = error?.message ?? "";
  return /no such table/i.test(message) && /question_(snapshots|eligible_players)/i.test(message);
}

function isMissingGameParticipantsTableError(error: { message?: string } | null) {
  const message = error?.message ?? "";
  return /no such table/i.test(message) && /game_participants/i.test(message);
}

function isMissingGameResultArchivesTableError(error: { message?: string } | null) {
  const message = error?.message ?? "";
  return /no such table/i.test(message) && /game_result_archives/i.test(message);
}

function parseGameResultArchive(row: DbGameResultArchive) {
  let value: unknown;
  try {
    value = JSON.parse(row.result_json) as unknown;
  } catch {
    throw new Error("结算归档损坏：JSON无法解析。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("结算归档格式无效。");
  const archive = value as Record<string, unknown>;
  if (archive.version !== 1 || row.archive_version !== 1) throw new Error("结算归档版本不兼容。");
  if (!Number.isInteger(archive.questionCount) || Number(archive.questionCount) < 0 || Number(archive.questionCount) > 30) {
    throw new Error("结算归档题目数量无效。");
  }
  if (!Array.isArray(archive.leaderboard) || archive.leaderboard.length > 50 || !Array.isArray(archive.questionScores)) {
    throw new Error("结算归档排行榜或逐题得分无效。");
  }
  const leaderboard: LeaderboardEntry[] = archive.leaderboard.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("结算归档排行榜条目无效。");
    const item = entry as Record<string, unknown>;
    if (
      typeof item.playerId !== "string" ||
      typeof item.nickname !== "string" ||
      !Number.isInteger(item.rank) || Number(item.rank) < 1 ||
      !Number.isInteger(item.score) || Number(item.score) < 0 ||
      !Number.isInteger(item.correctCount) || Number(item.correctCount) < 0
    ) throw new Error("结算归档排行榜条目无效。");
    return { playerId: item.playerId, nickname: item.nickname, rank: Number(item.rank), score: Number(item.score), correctCount: Number(item.correctCount) };
  });
  const participantIds = new Set(leaderboard.map((entry) => entry.playerId));
  if (participantIds.size !== leaderboard.length) throw new Error("结算归档排行榜包含重复玩家。");
  const scoreKeys = new Set<string>();
  const questionScores: GameResultQuestionScore[] = archive.questionScores.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("结算归档逐题得分条目无效。");
    const item = entry as Record<string, unknown>;
    if (
      typeof item.playerId !== "string" || !participantIds.has(item.playerId) ||
      !Number.isInteger(item.questionIndex) || Number(item.questionIndex) < 0 || Number(item.questionIndex) >= Number(archive.questionCount) ||
      !Number.isInteger(item.scoreAwarded) || Number(item.scoreAwarded) <= 0
    ) throw new Error("结算归档逐题得分条目无效。");
    const key = `${item.questionIndex}:${item.playerId}`;
    if (scoreKeys.has(key)) throw new Error("结算归档包含重复逐题得分。");
    scoreKeys.add(key);
    return { playerId: item.playerId, questionIndex: Number(item.questionIndex), scoreAwarded: Number(item.scoreAwarded) };
  });
  return { leaderboard, questionScores };
}

async function getGameResultArchive(gameSessionId: string) {
  const { data, error } = await d1
    .from("game_result_archives")
    .select("*")
    .eq("game_session_id", gameSessionId)
    .maybeSingle<DbGameResultArchive>();
  if (error) {
    if (isMissingGameResultArchivesTableError(error)) return null;
    throw new Error(error.message);
  }
  return data ? parseGameResultArchive(data) : null;
}

function toGameResultQuestionScores(results: QuestionResult[]): GameResultQuestionScore[] {
  const scores = new Map<string, GameResultQuestionScore>();
  for (const result of results) {
    if (result.scoreAwarded <= 0) continue;
    const key = `${result.questionIndex}:${result.playerId}`;
    const current = scores.get(key);
    scores.set(key, {
      playerId: result.playerId,
      questionIndex: result.questionIndex,
      scoreAwarded: (current?.scoreAwarded ?? 0) + result.scoreAwarded,
    });
  }
  return [...scores.values()].sort((left, right) => left.questionIndex - right.questionIndex || left.playerId.localeCompare(right.playerId));
}

async function getCurrentRoomGamePlayers(roomId: string) {
  return (await getDbPlayersByRoomId(roomId)).filter(isGamePlayer);
}

async function getCurrentRoomEligiblePlayerIds(roomId: string, presenterPlayerId: string) {
  return (await getCurrentRoomGamePlayers(roomId)).filter((player) => player.id !== presenterPlayerId).map((player) => player.id);
}

async function getQuestionEligiblePlayerIdsFromDb(gameSessionId: string, questionIndex: number) {
  const { data, error } = await d1
    .from("question_eligible_players")
    .select("*")
    .eq("game_session_id", gameSessionId)
    .eq("question_index", questionIndex)
    .order("created_at", { ascending: true })
    .returns<DbQuestionEligiblePlayer[]>();

  if (error) {
    if (isMissingEligibilityTableError(error)) {
      return null;
    }

    throw new Error(error.message);
  }

  return (data ?? []).map((row) => row.player_id);
}

async function getQuestionSnapshotFromDb(gameSessionId: string, questionIndex: number) {
  const { data, error } = await d1
    .from("question_snapshots")
    .select("*")
    .eq("game_session_id", gameSessionId)
    .eq("question_index", questionIndex)
    .maybeSingle<DbQuestionSnapshot>();

  if (error) {
    if (isMissingEligibilityTableError(error)) {
      return null;
    }

    throw new Error(error.message);
  }

  return data;
}

async function getStoredQuestionEligiblePlayerIds(gameSessionId: string, questionIndex: number) {
  const eligiblePlayerIdsFromDb = await getQuestionEligiblePlayerIdsFromDb(gameSessionId, questionIndex);
  if (eligiblePlayerIdsFromDb && eligiblePlayerIdsFromDb.length > 0) {
    return eligiblePlayerIdsFromDb;
  }

  const snapshot = await getQuestionSnapshotFromDb(gameSessionId, questionIndex);
  return snapshot ? getQuestionEligiblePlayerIdsFromSnapshot(snapshot) ?? [] : [];
}

async function createGameParticipantSnapshot(gameSessionId: string, players: DbPlayer[]) {
  if (players.length === 0) {
    return;
  }

  const { error } = await d1.from("game_participants").upsert(
    players.map((player) => ({
      game_session_id: gameSessionId,
      player_id: player.id,
      nickname: player.nickname.trim() || "已离开玩家",
      role: player.role ?? "PLAYER",
      joined_at: player.joined_at,
    })),
    {
      onConflict: "game_session_id,player_id",
    },
  );

  if (error) {
    if (isMissingGameParticipantsTableError(error)) {
      return;
    }

    throw new Error(error.message);
  }
}

async function getGameParticipantSnapshot(gameSession: GameSession) {
  const { data, error } = await d1
    .from("game_participants")
    .select("*")
    .eq("game_session_id", gameSession.id)
    .order("joined_at", { ascending: true })
    .returns<DbGameParticipant[]>();

  if (error) {
    if (!isMissingGameParticipantsTableError(error)) {
      throw new Error(error.message);
    }
  }

  const [
    roomPlayers,
    firstQuestionEligiblePlayerIds,
    scores,
    questionResults,
  ] = await Promise.all([
    getDbPlayersByRoomId(gameSession.roomId),
    getStoredQuestionEligiblePlayerIds(gameSession.id, 0),
    getPlayerScores(gameSession.id),
    getQuestionResultsForGameSession(gameSession.id),
  ]);

  const roomPlayerById = new Map(roomPlayers.map((player) => [player.id, player]));
  const storedParticipantById = new Map((data ?? []).map((participant) => [participant.player_id, participant]));
  const participantIds = new Set<string>(firstQuestionEligiblePlayerIds);
  for (const participant of data ?? []) {
    participantIds.add(participant.player_id);
  }
  for (const score of scores) {
    participantIds.add(score.playerId);
  }
  for (const result of questionResults) {
    participantIds.add(result.playerId);
  }

  return Array.from(participantIds).map((playerId) => {
    const storedParticipant = storedParticipantById.get(playerId);
    if (storedParticipant) {
      return storedParticipant;
    }

    const player = roomPlayerById.get(playerId);
    return {
      game_session_id: gameSession.id,
      player_id: playerId,
      nickname: player?.nickname.trim() || gameSession.teamBattleState?.teamMemberNames?.[playerId] || "已离开玩家",
      role: player?.role ?? "PLAYER",
      joined_at: player?.joined_at ?? gameSession.createdAt,
      created_at: gameSession.createdAt,
    };
  });
}

async function insertQuestionEligibilitySnapshot(params: {
  gameSessionId: string;
  questionIndex: number;
  eligiblePlayerIds: string[];
}) {
  const { error: snapshotError } = await d1.from("question_snapshots").insert(
    {
      game_session_id: params.gameSessionId,
      question_index: params.questionIndex,
      eligible_player_count: params.eligiblePlayerIds.length,
      eligible_player_ids: JSON.stringify(params.eligiblePlayerIds),
    },
  );

  if (snapshotError) {
    if (isMissingEligibilityTableError(snapshotError)) {
      return params.eligiblePlayerIds;
    }

    if (isUniqueViolation(snapshotError)) {
      const { data: existingSnapshot, error: existingSnapshotError } = await d1
        .from("question_snapshots")
        .select("*")
        .eq("game_session_id", params.gameSessionId)
        .eq("question_index", params.questionIndex)
        .maybeSingle<DbQuestionSnapshot>();

      if (existingSnapshotError) {
        if (isMissingEligibilityTableError(existingSnapshotError)) {
          return params.eligiblePlayerIds;
        }

        throw new Error(existingSnapshotError.message);
      }

      if (existingSnapshot) {
        return getQuestionEligiblePlayerIdsFromSnapshot(existingSnapshot) ??
          await getQuestionEligiblePlayerIdsFromDb(params.gameSessionId, params.questionIndex) ??
          params.eligiblePlayerIds;
      }
    }

    throw new Error(snapshotError.message);
  }

  if (params.eligiblePlayerIds.length > 0) {
    const { error: eligiblePlayersError } = await d1.from("question_eligible_players").upsert(
      params.eligiblePlayerIds.map((playerId) => ({
        game_session_id: params.gameSessionId,
        question_index: params.questionIndex,
        player_id: playerId,
      })),
      {
        onConflict: "game_session_id,question_index,player_id",
      },
    );

    if (eligiblePlayersError) {
      if (isMissingEligibilityTableError(eligiblePlayersError)) {
        return params.eligiblePlayerIds;
      }

      throw new Error(eligiblePlayersError.message);
    }
  }

  return params.eligiblePlayerIds;
}

async function createQuestionEligibilitySnapshot(params: {
  gameSessionId: string;
  roomId: string;
  questionIndex: number;
  presenterPlayerId: string;
}) {
  const eligiblePlayerIds = await getCurrentRoomEligiblePlayerIds(params.roomId, params.presenterPlayerId);

  return await insertQuestionEligibilitySnapshot({
    gameSessionId: params.gameSessionId,
    questionIndex: params.questionIndex,
    eligiblePlayerIds,
  });
}

async function createQuestionEligibilitySnapshotFromPlayers(params: {
  gameSessionId: string;
  questionIndex: number;
  presenterPlayerId: string;
  players: DbPlayer[];
}) {
  const eligiblePlayerIds = params.players
    .filter((player) => isGamePlayer(player) && player.id !== params.presenterPlayerId)
    .map((player) => player.id);

  return await insertQuestionEligibilitySnapshot({
    gameSessionId: params.gameSessionId,
    questionIndex: params.questionIndex,
    eligiblePlayerIds,
  });
}

async function getOrCreateQuestionEligiblePlayerIds(params: {
  gameSessionId: string;
  roomId: string;
  questionIndex: number;
  presenterPlayerId: string;
  knownEligiblePlayerIds?: string[];
}) {
  if (params.knownEligiblePlayerIds) {
    return params.knownEligiblePlayerIds;
  }

  const { data: snapshot, error: snapshotError } = await d1
    .from("question_snapshots")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .maybeSingle<DbQuestionSnapshot>();

  if (snapshotError) {
    if (isMissingEligibilityTableError(snapshotError)) {
      return await getCurrentRoomEligiblePlayerIds(params.roomId, params.presenterPlayerId);
    }

    throw new Error(snapshotError.message);
  }

  if (snapshot) {
    return getQuestionEligiblePlayerIdsFromSnapshot(snapshot) ??
      await getQuestionEligiblePlayerIdsFromDb(params.gameSessionId, params.questionIndex) ??
      await getCurrentRoomEligiblePlayerIds(params.roomId, params.presenterPlayerId);
  }

  return await createQuestionEligibilitySnapshot(params);
}

async function hydrateGameSessionEligibility(gameSession: GameSession) {
  const eligiblePlayerIds = await getOrCreateQuestionEligiblePlayerIds({
    gameSessionId: gameSession.id,
    roomId: gameSession.roomId,
    questionIndex: gameSession.currentQuestionIndex,
    presenterPlayerId: gameSession.presenterPlayerId,
    knownEligiblePlayerIds: gameSession.eligiblePlayerIds,
  });

  return {
    ...gameSession,
    eligiblePlayerIds,
  };
}

async function getEligiblePlayerSetForCurrentQuestion(gameSession: GameSession) {
  const eligiblePlayerIds = await getOrCreateQuestionEligiblePlayerIds({
    gameSessionId: gameSession.id,
    roomId: gameSession.roomId,
    questionIndex: gameSession.currentQuestionIndex,
    presenterPlayerId: gameSession.presenterPlayerId,
    knownEligiblePlayerIds: gameSession.eligiblePlayerIds,
  });

  return new Set(eligiblePlayerIds);
}

async function assertPlayerEligibleForCurrentQuestion(gameSession: GameSession, playerId: string) {
  const eligiblePlayerSet = await getEligiblePlayerSetForCurrentQuestion(gameSession);

  if (!eligiblePlayerSet.has(playerId)) {
    throw new Error("你是本题开始后加入的玩家，本题不能作答，请等待下一题。");
  }
}

async function assertGamePlayerInRoom(roomId: string, playerId: string) {
  const player = (await getDbPlayersByRoomId(roomId)).find((item) => item.id === playerId);

  if (!player || !isGamePlayer(player)) {
    throw new Error("观战者不能执行玩家操作。");
  }

  return player;
}

async function getRoundActionState(gameSession: GameSession) {
  const [
    { data: questionResults, error: resultsError },
    { data: currentRoundBuzzerAnswers, error: buzzerAnswersError },
    { data: currentRoundAnswers, error: answersError },
    roomPlayers,
    guesserIds,
  ] = await Promise.all([
    d1
      .from("question_results")
      .select("player_id")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", gameSession.currentQuestionIndex)
      .returns<Pick<DbQuestionResult, "player_id">[]>(),
    d1
      .from("buzzer_answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", gameSession.currentQuestionIndex)
      .eq("reveal_round", gameSession.currentRevealRound)
      .returns<DbBuzzerAnswer[]>(),
    d1
      .from("answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", gameSession.currentQuestionIndex)
      .eq("reveal_round", gameSession.currentRevealRound)
      .returns<DbAnswer[]>(),
    getDbPlayersByRoomId(gameSession.roomId),
    getOrCreateQuestionEligiblePlayerIds({
      gameSessionId: gameSession.id,
      roomId: gameSession.roomId,
      questionIndex: gameSession.currentQuestionIndex,
      presenterPlayerId: gameSession.presenterPlayerId,
      knownEligiblePlayerIds: gameSession.eligiblePlayerIds,
    }),
  ]);

  if (resultsError) {
    throw new Error(resultsError.message);
  }
  if (buzzerAnswersError) {
    throw new Error(buzzerAnswersError.message);
  }
  if (answersError) {
    throw new Error(answersError.message);
  }
  const correctSet = new Set((questionResults ?? []).map((result) => result.player_id));
  const activeRoomPlayerSet = new Set(roomPlayers.filter(isGamePlayer).map((player) => player.id));
  const activeGuesserIds = guesserIds.filter((guesserId) => activeRoomPlayerSet.has(guesserId));
  const guesserIdSet = new Set(activeGuesserIds);
  const activeCurrentRoundBuzzerAnswers = (currentRoundBuzzerAnswers ?? []).filter((answer) => guesserIdSet.has(answer.player_id));
  const activeCurrentRoundAnswers = (currentRoundAnswers ?? []).filter((answer) => guesserIdSet.has(answer.player_id));
  const eligibleGuesserIds = activeGuesserIds.filter((guesserId) => !correctSet.has(guesserId));
  const buzzerAnswerByPlayerId = new Map(activeCurrentRoundBuzzerAnswers.map((answer) => [answer.player_id, answer]));
  const answerByPlayerId = new Map(activeCurrentRoundAnswers.map((answer) => [answer.player_id, answer]));
  const hasPlayerActed = (guesserId: string) =>
    gameSession.gameMode === "ROUND_REVEAL"
      ? answerByPlayerId.has(guesserId)
      : answerByPlayerId.has(guesserId) || buzzerAnswerByPlayerId.has(guesserId);

  return {
    guesserIds: activeGuesserIds,
    correctSet,
    eligibleGuesserIds,
    currentRoundBuzzerAnswers: activeCurrentRoundBuzzerAnswers,
    currentRoundAnswers: activeCurrentRoundAnswers,
    buzzerAnswerByPlayerId,
    answerByPlayerId,
    hasPendingAnswers: activeCurrentRoundBuzzerAnswers.some((answer) => answer.status === "pending"),
    allEligiblePlayersUsedChance:
      eligibleGuesserIds.length === 0 || eligibleGuesserIds.every((guesserId) => hasPlayerActed(guesserId)),
    hasPlayerActed,
  };
}

async function hasCorrectResultForCurrentQuestion(gameSession: GameSession) {
  const { data, error } = await d1
    .from("question_results")
    .select("id")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

async function areAllGuessersCorrectForQuestion(params: {
  roomId: string;
  gameSessionId: string;
  questionIndex: number;
  presenterPlayerId: string;
}) {
  const [guesserIds, { data: questionResults, error: questionResultsError }] = await Promise.all([
    getOrCreateQuestionEligiblePlayerIds(params),
    d1
      .from("question_results")
      .select("player_id")
      .eq("game_session_id", params.gameSessionId)
      .eq("question_index", params.questionIndex)
      .returns<Pick<DbQuestionResult, "player_id">[]>(),
  ]);

  if (questionResultsError) {
    throw new Error(questionResultsError.message);
  }

  const correctSet = new Set((questionResults ?? []).map((result) => result.player_id));

  return guesserIds.length > 0 && guesserIds.every((guesserId) => correctSet.has(guesserId));
}

function updateTeamBattleState(gameSessionId: string, state: TeamBattleState, extra?: Record<string, unknown>) {
  return d1
    .from("game_sessions")
    .update({
      team_battle_state: state,
      ...extra,
    })
    .eq("id", gameSessionId)
    .eq("status", "PLAYING")
    .select()
    .single<DbGameSession>();
}

function toBuzzerAnswer(answer: DbBuzzerAnswer): BuzzerAnswer {
  return {
    id: answer.id,
    gameSessionId: answer.game_session_id,
    questionIndex: answer.question_index,
    revealRound: answer.reveal_round,
    playerId: answer.player_id,
    answerText: answer.answer_text,
    status: answer.status,
    scoreAwarded: answer.score_awarded,
    submittedAt: answer.submitted_at,
    serverReceivedAt: answer.server_received_at ?? answer.submitted_at,
    judgedAt: answer.judged_at,
    judgedByPlayerId: answer.judged_by_player_id,
  };
}

function toAnswer(answer: DbAnswer): Answer {
  return {
    id: answer.id,
    gameSessionId: answer.game_session_id,
    questionIndex: answer.question_index,
    revealRound: answer.reveal_round,
    playerId: answer.player_id,
    answerText: answer.answer_text,
    submittedAt: answer.submitted_at,
  };
}

function toPlayerScore(playerScore: DbPlayerScore): PlayerScore {
  return {
    id: playerScore.id,
    gameSessionId: playerScore.game_session_id,
    playerId: playerScore.player_id,
    score: playerScore.score,
    correctCount: playerScore.correct_count,
  };
}

function toQuestionResult(questionResult: DbQuestionResult): QuestionResult {
  return {
    id: questionResult.id,
    gameSessionId: questionResult.game_session_id,
    questionIndex: questionResult.question_index,
    playerId: questionResult.player_id,
    scoredRound: questionResult.scored_round,
    scoreAwarded: questionResult.score_awarded,
    judgedByPlayerId: questionResult.judged_by_player_id,
    judgedAt: questionResult.judged_at,
  };
}

function isUniqueViolation(error: { code?: string } | null) {
  return error?.code === "23505";
}

const REVEAL_BLOCK_COUNT = 45;
const PORTRAIT_REVEAL_BLOCK_COUNT = 35;
const ALL_REVEALED_BLOCKS = Array.from({ length: REVEAL_BLOCK_COUNT }, (_, index) => index);
const MAX_PLAYERS_PER_ROOM = 50;
const PLAYER_CAPACITY_FULL_ERROR_CODE = "PLAYER_CAPACITY_FULL";
const SPECTATOR_CAPACITY_FULL_ERROR_CODE = "SPECTATOR_CAPACITY_FULL";
const TEAM_SELECTION_REQUIRED_ERROR_CODE = "TEAM_SELECTION_REQUIRED";
const ROUND_DEADLINE_GRACE_MS = 3000;
const BUZZER_JUDGING_STABILIZE_MS = 3000;
const BUZZER_CLIENT_TIME_MAX_EARLY_MS = BUZZER_JUDGING_STABILIZE_MS;
const FORFEIT_ANSWER_TEXT = "__FORFEIT__";

type ServerTimedActionParams = {
  serverReceivedAtMs?: number | null;
};

function getServerReceivedAtMs(params?: ServerTimedActionParams) {
  return typeof params?.serverReceivedAtMs === "number" && Number.isFinite(params.serverReceivedAtMs)
    ? params.serverReceivedAtMs
    : Date.now();
}

function getRoundDeadlineMs(gameSession: Pick<GameSession, "roundStartedAt" | "roundSeconds">) {
  if (!gameSession.roundStartedAt) {
    return null;
  }

  return new Date(gameSession.roundStartedAt).getTime() + gameSession.roundSeconds * 1000;
}

function hasRoundAcceptWindowExpired(gameSession: Pick<GameSession, "roundStartedAt" | "roundSeconds">, receivedAtMs: number) {
  const deadlineMs = getRoundDeadlineMs(gameSession);
  return deadlineMs != null && receivedAtMs > deadlineMs + ROUND_DEADLINE_GRACE_MS;
}

function hasRoundForfeitDeadlineArrived(gameSession: Pick<GameSession, "roundStartedAt" | "roundSeconds">, receivedAtMs: number) {
  const deadlineMs = getRoundDeadlineMs(gameSession);
  return deadlineMs != null && receivedAtMs >= deadlineMs + ROUND_DEADLINE_GRACE_MS;
}

function normalizeRevealBlockCount(value: unknown) {
  return Number(value) === PORTRAIT_REVEAL_BLOCK_COUNT ? PORTRAIT_REVEAL_BLOCK_COUNT : REVEAL_BLOCK_COUNT;
}

function normalizeDisabledBlocks(value: unknown, revealBlockCount: number) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((block): block is number => Number.isInteger(block) && block >= 0 && block < revealBlockCount)),
  ).sort((a, b) => a - b);
}

function getVisibleRevealedBlockCount(blocks: number[], revealBlockCount: number) {
  return blocks.filter((block) => block >= 0 && block < revealBlockCount).length;
}

function getRevealBlocks(revealBlockCount: number) {
  return Array.from({ length: revealBlockCount }, (_, index) => index);
}

function getSelectableTeamBattleBlocks(session: Pick<GameSession, "revealedBlocks">, state: TeamBattleState, revealBlockCount: number) {
  const revealed = new Set(session.revealedBlocks);
  const disabled = new Set(normalizeDisabledBlocks(state.disabledBlocks, revealBlockCount));
  return getRevealBlocks(revealBlockCount).filter((block) => !revealed.has(block) && !disabled.has(block));
}

function isDbTruthy(value: unknown) {
  return value === true || value === 1;
}

export type QuestionImportItem = {
  imageUrl: string;
  labelText?: string | null;
  animeTags?: BangumiAnimeTag[];
  characterTags?: BangumiCharacterTag[];
  isR18?: boolean;
};

function isHttpImageUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseImageUrlsText(imageUrlsText: string) {
  return Array.from(
    new Set(
      imageUrlsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && isHttpImageUrl(line)),
    ),
  );
}

function normalizeQuestionImportItems(items: QuestionImportItem[]) {
  const seenUrls = new Set<string>();
  const normalizedItems: QuestionImportItem[] = [];

  for (const [index, item] of items.entries()) {
    const imageUrl = item.imageUrl.trim();

    if (!imageUrl || !isHttpImageUrl(imageUrl) || seenUrls.has(imageUrl)) {
      continue;
    }

    // 直接 questions payload 是未信任输入：isR18/is_r18 只接受 boolean，
    // null/字符串/数字拒绝，两个字段同时存在且值冲突拒绝。
    const isR18 = parseImportedIsR18(item as unknown as Record<string, unknown>, `第 ${index + 1} 题`);
    const tags = normalizeBangumiQuestionTags(item.animeTags, item.characterTags);
    seenUrls.add(imageUrl);
    normalizedItems.push({
      imageUrl,
      labelText: item.labelText?.trim() || null,
      isR18,
      animeTags: tags.animeTags,
      characterTags: tags.characterTags,
    });
  }

  return normalizedItems;
}

export function parseQuestionImportText(importText: string): QuestionImportItem[] {
  const items: QuestionImportItem[] = [];

  for (const [index, rawLine] of importText.split(/\r?\n/).entries()) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (!line.startsWith("{")) {
      if (isHttpImageUrl(line)) {
        items.push({ imageUrl: line });
      }
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`第 ${index + 1} 行不是有效 JSON。`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(`第 ${index + 1} 行必须是 JSON 对象。`);
    }

    const record = parsed as Record<string, unknown>;

    if (typeof record.image_url !== "string" || !isHttpImageUrl(record.image_url.trim())) {
      throw new Error(`第 ${index + 1} 行缺少有效的 image_url。`);
    }

    if (record.label_text != null && typeof record.label_text !== "string") {
      throw new Error(`第 ${index + 1} 行的 label_text 必须是字符串。`);
    }

    const labelText = typeof record.label_text === "string" ? record.label_text : null;
    const isR18 = parseImportedIsR18(record, `第 ${index + 1} 行`);

    items.push({
      imageUrl: record.image_url,
      labelText,
      isR18,
    });
  }

  return normalizeQuestionImportItems(items);
}

function parseImportedIsR18(record: Record<string, unknown>, location: string) {
  const legacy = record.is_r18;
  const camel = record.isR18;
  if (legacy !== undefined && camel !== undefined && legacy !== camel) {
    throw new Error(`${location}的 is_r18 与 isR18 不一致。`);
  }
  // 两个字段都只接受 boolean；null/字符串/数字一律拒绝，缺省视为 false。
  // 不能用 legacy ?? camel：is_r18: null 会被当成缺省而静默放过。
  const raw = legacy !== undefined ? legacy : camel;
  if (raw !== undefined && typeof raw !== "boolean") {
    throw new Error(`${location}的 is_r18 必须是布尔值。`);
  }
  return raw === true;
}

function imageUrlsToText(imageUrls: string[]) {
  return imageUrls.map((url) => url.trim()).filter(Boolean).join("\n");
}

export type CreateRoomOptions = {
  visibility?: RoomVisibility;
  name?: string;
};

const MAX_PUBLIC_ROOM_NAME_LENGTH = 40;

export async function createRoom(playerId: string, nickname: string, options: CreateRoomOptions | null = {}) {
  assertD1Env();

  const normalizedNickname = nickname.trim();
  if (!normalizedNickname) throw new Error("请输入昵称。");
  if (normalizedNickname.length > 20) throw new Error("昵称最多 20 个字符。");
  const visibility: RoomVisibility = options?.visibility === "PUBLIC" ? "PUBLIC" : "PRIVATE";
  const requestedName = options?.name?.trim() ?? "";
  if (requestedName.length > MAX_PUBLIC_ROOM_NAME_LENGTH) {
    throw new Error(`房间名称最多 ${MAX_PUBLIC_ROOM_NAME_LENGTH} 个字符。`);
  }
  const roomName = visibility === "PUBLIC" ? (requestedName || `${normalizedNickname}的房间`) : null;

  let roomCode = createRoomCode();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const hostPlayer: DbPlayer = {
      id: playerId,
      room_id: roomId,
      nickname: normalizedNickname,
      is_host: true,
      role: "PLAYER",
      joined_at: createdAt,
      last_seen_at: createdAt,
    };
    const { data: room, error: roomError } = await d1
      .from("rooms")
      .insert({
        id: roomId,
        room_code: roomCode,
        host_player_id: playerId,
        lobby_round_seconds: DEFAULT_ROUND_SECONDS,
        lobby_round_scores: DEFAULT_ROUND_SCORES,
        lobby_team_reveal_vote_seconds: DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
        lobby_team_guess_vote_seconds: DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
        lobby_team_presenter_block_enabled: 0,
        lobby_spectator_question_preview_enabled: 1,
        lobby_spectator_player_answers_enabled: 1,
        lobby_player_capacity: MAX_PLAYERS_PER_ROOM,
        lobby_spectator_capacity: MAX_PLAYERS_PER_ROOM,
        lobby_team_assignment_mode: "MANUAL",
        lobby_team_assignments: "{}",
        runtime_generation: CURRENT_ROOM_RUNTIME_GENERATION,
        room_state_version: ROOM_STATE_MANIFEST_VERSION,
        room_state_revision: 0,
        room_state_json: encodeRoomState(roomId, playerId, [hostPlayer]),
        room_visibility: visibility,
        room_name: roomName,
        member_count: 1,
        spectator_count: 0,
        public_activity_at: visibility === "PUBLIC" ? createdAt : null,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .select()
      .single<DbRoom>();

    if (roomError) {
      if (isUniqueViolation(roomError)) {
        roomCode = createRoomCode();
        continue;
      }

      throw new Error(roomError.message);
    }

    return toRoom(room, [hostPlayer]);
  }

  throw new Error("创建房间失败：连续生成的房间号都已被占用，请重试。");
}

export async function getRoomByCode(roomCode: string) {
  assertD1Env();

  const { data: room, error } = await d1
    .from("rooms")
    .select("*")
    .eq("room_code", roomCode)
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  return room;
}

export async function getRoomWithPlayers(roomCode: string) {
  const room = await getRoomByCode(roomCode);

  if (!room) {
    return null;
  }

  return toRoom(room);
}

async function getDbRoomById(roomId: string) {
  const { data: room, error } = await d1
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!room) {
    return null;
  }

  return room;
}

async function updateRoomAggregate(
  room: DbRoom,
  players: DbPlayer[],
  roomUpdates: Partial<DbRoom> = {},
) {
  const hostPlayerId = roomUpdates.host_player_id ?? room.host_player_id;
  const roomStateJson = encodeRoomState(room.id, hostPlayerId, players);
  const currentRevision = room.room_state_revision ?? 0;
  const hasRoomChanges = Object.entries(roomUpdates).some(
    ([key, value]) => room[key as keyof DbRoom] !== value,
  );
  if (!hasRoomChanges && roomStateJson === room.room_state_json) return room;

  const { data, error } = await d1
    .from("rooms")
    .update({
      ...roomUpdates,
      member_count: countGamePlayers(players),
      spectator_count: countSpectators(players),
      room_state_json: roomStateJson,
      room_state_revision: currentRevision + 1,
    })
    .eq("id", room.id)
    .eq("runtime_generation", CURRENT_ROOM_RUNTIME_GENERATION)
    .eq("room_state_version", ROOM_STATE_MANIFEST_VERSION)
    .eq("room_state_revision", currentRevision)
    .select()
    .maybeSingle<DbRoom>();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("房间状态已变化，请按最新状态重试。");
  return data;
}

async function getRoomWithPlayersById(roomId: string) {
  const room = await getDbRoomById(roomId);
  if (!room) {
    return null;
  }

  return toRoom(room);
}

export async function getDeadlineStateForRoomId(roomId: string) {
  const room = await getDbRoomById(roomId);
  if (!room) {
    return { room: null, gameSession: null };
  }

  const gameSession = room.current_game_id ? await getGameSessionById(room.current_game_id) : null;
  return {
    room: toRoom(room),
    gameSession,
  };
}

export async function getRoomIdForGameSession(gameSessionId: string) {
  const { data, error } = await d1
    .from("game_sessions")
    .select("room_id")
    .eq("id", gameSessionId)
    .maybeSingle<Pick<DbGameSession, "room_id">>();

  if (error) {
    throw new Error(error.message);
  }
  return data?.room_id ?? null;
}

async function getDbPlayersByRoomId(roomId: string) {
  assertD1Env();
  const room = await getDbRoomById(roomId);
  return room ? getRoomStatePlayers(room) : [];
}

export async function getPlayersByRoomId(roomId: string) {
  const players = await getDbPlayersByRoomId(roomId);
  return players.map(toPlayer);
}

export async function joinRoom(roomCode: string, playerId: string, nickname: string, role?: PlayerRole, team?: TeamBattleTeam) {
  const room = await getRoomByCode(roomCode);

  if (!room) {
    return {
      room: null,
      error: "房间不存在，请检查房间号是否正确。",
    };
  }

  const players = getRoomStatePlayers(room);
  const duplicatedNickname = players.some(
    (player) => player.id !== playerId && player.nickname.trim().toLowerCase() === nickname.trim().toLowerCase(),
  );

  if (duplicatedNickname) {
    return {
      room: null,
      error: "该昵称已在房间内使用，请换一个昵称。",
    };
  }

  const existingPlayer = players.find((player) => player.id === playerId);
  const isExistingPlayer = Boolean(existingPlayer);
  const requestedRole = isPlayerRole(role) ? role : "PLAYER";
  const requestedTeam = team === "red" || team === "blue" ? team : null;
  let nextRole = existingPlayer ? normalizePlayerRole(existingPlayer.role) : requestedRole;

  if (existingPlayer && role && requestedRole !== nextRole) {
    const canSwitchRole = room.game_status === "LOBBY" || room.game_status === "QUESTION_SETUP";
    if (!canSwitchRole) {
      return {
        room: null,
        error: "游戏进行中不能切换玩家/观战身份。",
      };
    }
    if (room.game_status === "QUESTION_SETUP" && existingPlayer.id === room.current_presenter_player_id) {
      return {
        room: null,
        error: "当前出题人不能切换为观战身份。",
      };
    }
    nextRole = requestedRole;
  }

  const playerCapacity = normalizePlayerCapacity(room.lobby_player_capacity);
  const spectatorCapacity = normalizeSpectatorCapacity(room.lobby_spectator_capacity);
  if (nextRole === "PLAYER" && (!existingPlayer || !isGamePlayer(existingPlayer)) && countGamePlayers(players) >= playerCapacity) {
    return {
      room: null,
      errorCode: PLAYER_CAPACITY_FULL_ERROR_CODE,
      error: `玩家已满，当前房间最多支持 ${playerCapacity} 名玩家；可以选择观战加入。`,
    };
  }
  if (nextRole === "SPECTATOR" && (!existingPlayer || isGamePlayer(existingPlayer)) && countSpectators(players) >= spectatorCapacity) {
    return {
      room: null,
      errorCode: SPECTATOR_CAPACITY_FULL_ERROR_CODE,
      error: `观战人数已满，当前房间最多支持 ${spectatorCapacity} 名观战者。`,
    };
  }

  const existingAssignments = normalizeTeamAssignments(room.lobby_team_assignments);
  const needsManualTeam = room.lobby_game_mode === "TEAM_BATTLE"
    && normalizeTeamAssignmentMode(room.lobby_team_assignment_mode) === "MANUAL"
    && room.game_status === "PLAYING"
    && nextRole === "PLAYER"
    && playerId !== room.current_presenter_player_id;
  if (needsManualTeam && !requestedTeam && !existingAssignments[playerId]) {
    return {
      room: null,
      errorCode: TEAM_SELECTION_REQUIRED_ERROR_CODE,
      error: "手动分队已开启，请先选择加入红队或蓝队。",
    };
  }

  const isHost = room.host_player_id === playerId;
  const now = new Date().toISOString();
  const joinedPlayer: DbPlayer = existingPlayer
    ? {
        ...existingPlayer,
        nickname: nickname.trim(),
        is_host: isHost,
        role: nextRole,
      }
    : {
        id: playerId,
        room_id: room.id,
        nickname: nickname.trim(),
        is_host: isHost,
        role: nextRole,
        joined_at: now,
        last_seen_at: now,
      };
  const nextPlayers = existingPlayer
    ? players.map((player) => player.id === playerId ? joinedPlayer : player)
    : [...players, joinedPlayer];

  const nextAssignments = { ...existingAssignments };
  if (nextRole === "SPECTATOR" || playerId === room.current_presenter_player_id) delete nextAssignments[playerId];
  else if (requestedTeam) nextAssignments[playerId] = requestedTeam;
  const assignmentsChanged = JSON.stringify(nextAssignments) !== JSON.stringify(existingAssignments);
  const updatedRoom = await updateRoomAggregate(
    room,
    nextPlayers,
    assignmentsChanged ? { lobby_team_assignments: JSON.stringify(nextAssignments) } : {},
  );
  if (
    room.game_status === "PLAYING" &&
    room.current_game_id &&
    isGamePlayer(joinedPlayer)
  ) {
    await createGameParticipantSnapshot(room.current_game_id, [joinedPlayer]);
  }

  return {
    room: toRoom(updatedRoom, nextPlayers),
    error: null,
  };
}

export async function leaveRoom(roomId: string, playerId: string) {
  assertD1Env();

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    return null;
  }

  const isLeavingPresenter = room.current_presenter_player_id === playerId;
  if (isLeavingPresenter && room.game_status === "PLAYING") {
    throw new Error("游戏进行中，出题人不能直接离开房间。");
  }

  const isLeavingHost = room.host_player_id === playerId;
  const currentPlayers = getRoomStatePlayers(room);
  const remainingPlayers = currentPlayers.filter((player) => player.id !== playerId);
  if (remainingPlayers.length === currentPlayers.length) return toRoom(room, currentPlayers);

  if (room.game_status === "PLAYING" && room.current_game_id) {
    await removePlayerFromCurrentGame(room.current_game_id, playerId);
  }

  const currentHostStillPresent = remainingPlayers.some((player) => player.id === room.host_player_id);
  const shouldPromoteHost = isLeavingHost || !currentHostStillPresent;
  const nextHost = shouldPromoteHost
    ? remainingPlayers[0] ?? null
    : remainingPlayers.find((player) => player.id === room.host_player_id) ?? null;

  if (!nextHost) {
    const { error: roomDeleteError } = await d1.from("rooms").delete().eq("id", roomId);
    if (roomDeleteError) {
      throw new Error(roomDeleteError.message);
    }
    return null;
  }

  const assignments = normalizeTeamAssignments(room.lobby_team_assignments);
  delete assignments[playerId];
  const roomUpdates: Partial<DbRoom> = {
    host_player_id: nextHost.id,
    lobby_team_assignments: JSON.stringify(assignments),
  };
  if (isLeavingPresenter && room.game_status === "QUESTION_SETUP") {
    roomUpdates.game_status = "LOBBY";
    roomUpdates.current_presenter_player_id = null;
    roomUpdates.prepared_question_set_id = null;
    roomUpdates.prepared_question_count = null;
    roomUpdates.lobby_question_count = null;
    roomUpdates.prepared_question_source = null;
  }

  const updatedRoom = await updateRoomAggregate(room, remainingPlayers, roomUpdates);
  return toRoom(updatedRoom);
}

export async function kickPlayerFromRoom(roomId: string, hostPlayerId: string, targetPlayerId: string) {
  assertD1Env();

  if (!targetPlayerId) {
    throw new Error("请选择要踢出的玩家。");
  }

  if (hostPlayerId === targetPlayerId) {
    throw new Error("房主不能踢出自己，如需退出请解散房间。");
  }

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    throw new Error("踢出玩家失败：房间不存在或已被解散。");
  }

  if (room.host_player_id !== hostPlayerId) {
    throw new Error("只有房主可以踢出玩家。");
  }

  const currentPlayers = getRoomStatePlayers(room);
  const targetPlayer = currentPlayers.find((player) => player.id === targetPlayerId) ?? null;

  if (!targetPlayer) {
    throw new Error("踢出玩家失败：该玩家已不在房间。");
  }

  if (targetPlayer.is_host || targetPlayer.id === room.host_player_id) {
    throw new Error("不能踢出房主。");
  }

  if (room.game_status === "PLAYING" && room.current_presenter_player_id === targetPlayerId) {
    throw new Error("游戏进行中不能踢出当前出题人。如出题人掉线，请房主取消本局。");
  }

  if (room.game_status === "PLAYING" && room.current_game_id) {
    await assertRemovingPlayerKeepsTeamBattlePlayable(room.current_game_id, targetPlayerId);
  }

  const nextPlayers = currentPlayers.filter((player) => player.id !== targetPlayerId);
  const assignments = normalizeTeamAssignments(room.lobby_team_assignments);
  delete assignments[targetPlayerId];
  const roomUpdates: Partial<DbRoom> = {
    lobby_team_assignments: JSON.stringify(assignments),
  };
  if (room.game_status === "PLAYING" && room.current_game_id) {
    await removePlayerFromCurrentGame(room.current_game_id, targetPlayerId);
  }

  if (room.current_presenter_player_id === targetPlayerId && room.game_status === "QUESTION_SETUP") {
    Object.assign(roomUpdates, {
      current_presenter_player_id: null,
      current_game_id: null,
      prepared_question_set_id: null,
      prepared_question_count: null,
      lobby_question_count: null,
      prepared_question_source: null,
      game_status: "LOBBY",
    } satisfies Partial<DbRoom>);
  }

  const updatedRoom = await updateRoomAggregate(room, nextPlayers, roomUpdates);
  return toRoom(updatedRoom);
}

export async function dissolveRoom(roomId: string, playerId: string) {
  assertD1Env();

  const { data: deletedRoom, error } = await d1
    .from("rooms")
    .delete()
    .eq("id", roomId)
    .eq("host_player_id", playerId)
    .select("id")
    .maybeSingle<Pick<DbRoom, "id">>();

  if (error) {
    throw new Error(error.message);
  }
  if (!deletedRoom) {
    throw new Error("解散房间失败：只有房主可以解散当前房间。");
  }
}

export function dissolveRoomOnPageExit(roomId: string, playerId: string) {
  try {
    const { d1Url, d1AnonKey } = getD1PublicConfig();
    const url = new URL(`${d1Url}/rest/v1/rooms`);
    url.searchParams.set("id", `eq.${roomId}`);
    url.searchParams.set("host_player_id", `eq.${playerId}`);

    void fetch(url.toString(), {
      method: "DELETE",
      keepalive: true,
      headers: {
        apikey: d1AnonKey,
        Authorization: `Bearer ${d1AnonKey}`,
        Prefer: "return=minimal",
      },
    });
  } catch {
    // Page-exit cleanup is best effort; explicit host navigation still awaits dissolveRoom.
  }
}

export async function selectPresenterForRound(roomId: string, hostPlayerId: string, presenterPlayerId: string) {
  assertD1Env();

  const { data: currentRoom, error: currentRoomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .eq("host_player_id", hostPlayerId)
    .eq("game_status", "LOBBY")
    .maybeSingle<DbRoom>();
  if (currentRoomError) throw new Error(currentRoomError.message);
  if (!currentRoom) throw new Error("只有房主可以在大厅阶段选择出题人。");
  const players = getRoomStatePlayers(currentRoom);
  const presenter = players.find((player) => player.id === presenterPlayerId);
  if (!presenter) throw new Error("选择出题人失败：该玩家不在当前房间。");
  if (!isGamePlayer(presenter)) throw new Error("选择出题人失败：观战者不能当出题人。");
  const nextAssignments = normalizeTeamAssignments(currentRoom.lobby_team_assignments);
  delete nextAssignments[presenterPlayerId];

  const room = await updateRoomAggregate(currentRoom, players, {
      current_presenter_player_id: presenterPlayerId,
      game_status: "QUESTION_SETUP",
      current_game_id: null,
      prepared_question_set_id: null,
      prepared_question_count: null,
      lobby_question_count: null,
      prepared_question_source: null,
      lobby_team_assignments: JSON.stringify(nextAssignments),
      public_activity_at: new Date().toISOString(),
  });

  return toRoom(room);
}

export async function selectTeamForPlayer(params: { roomId: string; playerId: string; team: TeamBattleTeam }) {
  assertD1Env();
  if (params.team !== "red" && params.team !== "blue") throw new Error("请选择有效的队伍。");
  const { data: room, error: roomError } = await d1.from("rooms").select("*").eq("id", params.roomId).maybeSingle<DbRoom>();
  if (roomError) throw new Error(roomError.message);
  if (!room || (room.game_status !== "LOBBY" && room.game_status !== "QUESTION_SETUP")) {
    throw new Error("只有游戏开始前可以更换队伍。");
  }
  if (room.lobby_game_mode !== "TEAM_BATTLE" || normalizeTeamAssignmentMode(room.lobby_team_assignment_mode) !== "MANUAL") {
    throw new Error("当前房间未开启手动分队。");
  }
  if (room.current_presenter_player_id === params.playerId) throw new Error("出题人不需要加入队伍。");
  const players = getRoomStatePlayers(room);
  const player = players.find((item) => item.id === params.playerId);
  if (!player || !isGamePlayer(player)) throw new Error("只有玩家身份可以加入队伍。");
  const assignments = normalizeTeamAssignments(room.lobby_team_assignments);
  if (assignments[params.playerId] === params.team) return toRoom(room, players);
  assignments[params.playerId] = params.team;
  const updatedRoom = await updateRoomAggregate(room, players, {
    lobby_team_assignments: JSON.stringify(assignments),
  });
  return toRoom(updatedRoom);
}

export async function cancelCurrentRound(roomId: string, hostPlayerId: string) {
  assertD1Env();

  const { data: room, error } = await d1
    .from("rooms")
    .update({
      current_presenter_player_id: null,
      current_game_id: null,
      prepared_question_set_id: null,
      prepared_question_count: null,
      lobby_question_count: null,
      prepared_question_source: null,
      game_status: "LOBBY",
      public_activity_at: new Date().toISOString(),
    })
    .eq("id", roomId)
    .eq("host_player_id", hostPlayerId)
    .select()
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!room) {
    throw new Error("取消本轮失败：只有房主可以取消当前出题流程。");
  }

  return toRoom(room);
}

export async function cancelPresenterSetup(roomId: string, presenterPlayerId: string) {
  assertD1Env();

  const { data: room, error } = await d1
    .from("rooms")
    .update({
      current_presenter_player_id: null,
      current_game_id: null,
      prepared_question_set_id: null,
      prepared_question_count: null,
      lobby_question_count: null,
      prepared_question_source: null,
      game_status: "LOBBY",
      public_activity_at: new Date().toISOString(),
    })
    .eq("id", roomId)
    .eq("current_presenter_player_id", presenterPlayerId)
    .eq("game_status", "QUESTION_SETUP")
    .select()
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!room) {
    throw new Error("撤回出题人失败：只有当前出题人可以在准备阶段撤回。");
  }

  return toRoom(room);
}

export async function createUploadedQuestionSet(params: {
  roomId: string;
  presenterPlayerId: string;
  title: string;
  description?: string;
  imageUrls?: string[];
  questions?: QuestionImportItem[];
  creationMethod?: QuestionSetCreationMethod;
}) {
  assertD1Env();

  const title = params.title.trim();
  const questionItems = normalizeQuestionImportItems(
    params.questions ?? params.imageUrls?.map((imageUrl) => ({ imageUrl })) ?? [],
  );
  const imageUrls = questionItems.map((item) => item.imageUrl);

  if (!title) {
    throw new Error("请先输入题库标题。");
  }

  if (imageUrls.length === 0) {
    throw new Error("没有检测到有效图片链接，请至少提供一张 http/https 图片。");
  }
  if (imageUrls.length > MAX_QUESTION_SET_QUESTIONS) {
    throw new Error(`单个题库最多包含 ${MAX_QUESTION_SET_QUESTIONS} 道题。`);
  }

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", params.roomId)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("game_status", "QUESTION_SETUP")
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    throw new Error("创建题库失败：当前房间不在出题阶段，或你不是本轮出题人。");
  }

  const createdByNickname = await getPlayerNickname(params.presenterPlayerId, params.roomId);
  const questionSetId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const questions: DbQuestion[] = questionItems.map((item, index) => {
    const labelText = item.labelText;
    return {
      id: crypto.randomUUID(),
      question_set_id: questionSetId,
      image_url: item.imageUrl,
      order_index: index,
      is_r18: item.isR18 === true,
      label_text: labelText,
      label_source: labelText ? "manual" : null,
      label_source_answer_id: null,
      label_updated_by_player_id: labelText ? params.presenterPlayerId : null,
      label_updated_at: labelText ? createdAt : null,
      created_at: createdAt,
    };
  });

  const { data: questionSet, error: questionSetError } = await d1
    .from("question_sets")
    .insert({
      id: questionSetId,
      title,
      description: params.description?.trim() || null,
      created_by_player_id: params.presenterPlayerId,
      created_by_nickname: createdByNickname,
      source: "uploaded",
      creation_method: params.creationMethod ?? "player_manual",
      is_public: false,
      image_count: imageUrls.length,
      image_urls_text: null,
      manifest_version: QUESTION_SET_MANIFEST_VERSION,
      manifest_revision: 0,
      manifest_json: encodeQuestionSetManifest(questions.map(toQuestion)),
      created_at: createdAt,
      updated_at: createdAt,
    })
    .select()
    .single<DbQuestionSet>();

  if (questionSetError) {
    throw new Error(questionSetError.message);
  }
  return toQuestionSet(questionSet, questions);
}

export class HomepageCommunityQuestionSetPersistenceError extends Error {
  constructor(public readonly cause: unknown) {
    super("题库保存失败，请稍后重试。");
    this.name = "HomepageCommunityQuestionSetPersistenceError";
  }
}

export class HomepageCommunityQuestionSetConflictError extends Error {
  constructor() {
    super("投稿内容已发生变化，请作为一次新投稿重试。");
    this.name = "HomepageCommunityQuestionSetConflictError";
  }
}

type CommunityQuestionSetSubmissionRow = {
  submission_id: string;
  submission_fingerprint: string;
  question_set_id: string;
  start_order_index: number;
  added_image_count: number;
  created_at: string;
};

export async function getHomepageCommunityQuestionSetBySubmissionId(submissionId: string) {
  assertD1Env();
  const { data: submission, error: submissionError } = await d1
    .from("community_question_set_submissions")
    .select("*")
    .eq("submission_id", submissionId)
    .maybeSingle<CommunityQuestionSetSubmissionRow>();
  if (submissionError) throw new HomepageCommunityQuestionSetPersistenceError(submissionError.message);
  if (!submission) return null;

  const { data: questionSet, error: questionSetError } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", submission.question_set_id)
    .maybeSingle<DbQuestionSet>();
  if (questionSetError || !questionSet) {
    throw new HomepageCommunityQuestionSetPersistenceError(
      questionSetError?.message ?? `投稿 ${submissionId} 对应的题库不存在。`,
    );
  }
  return {
    questionSet: toQuestionSet(questionSet),
    submissionFingerprint: submission.submission_fingerprint,
    appended: submission.start_order_index > 0,
    addedImageCount: submission.added_image_count,
  };
}

async function getHomepageCommunityCollection(title: string) {
  const { data, error } = await d1
    .from("question_sets")
    .select("*")
    .eq("community_collection_title", title)
    .maybeSingle<DbQuestionSet>();
  if (error) throw new HomepageCommunityQuestionSetPersistenceError(error.message);
  return data;
}

function getAppendableHomepageQuestions(questionSet: DbQuestionSet, title: string) {
  if (
    !questionSet.is_public
    || questionSet.title !== title
    || questionSet.community_collection_title !== title
    || !questionSet.community_submission_id
    || questionSet.community_structure_edited === 1
    || questionSet.community_structure_edited === true
    || questionSet.manifest_version !== QUESTION_SET_MANIFEST_VERSION
  ) {
    throw new HomepageCommunityQuestionSetPersistenceError(`同名题库“${title}”不是可追加的社区截图题库。`);
  }
  try {
    const questions = decodeQuestionSetManifest(questionSet);
    if (!questions || questions.length !== questionSet.image_count) {
      throw new Error("manifest 与题目数量不一致。");
    }
    return questions;
  } catch (error) {
    throw new HomepageCommunityQuestionSetPersistenceError(error);
  }
}

async function findOrClaimHomepageCommunityCollection(title: string) {
  const existing = await getHomepageCommunityCollection(title);
  if (existing) return existing;

  const { data: candidates, error } = await d1
    .from("question_sets")
    .select("*")
    .eq("title", title)
    .eq("is_public", true)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(30)
    .returns<DbQuestionSet[]>();
  if (error) throw new HomepageCommunityQuestionSetPersistenceError(error.message);

  for (const candidate of candidates ?? []) {
    if (
      candidate.community_collection_title != null
      || !candidate.community_submission_id
      || candidate.community_structure_edited === 1
      || candidate.community_structure_edited === true
      || candidate.manifest_version !== QUESTION_SET_MANIFEST_VERSION
    ) continue;
    try {
      const questions = decodeQuestionSetManifest(candidate);
      if (!questions || questions.length !== candidate.image_count) continue;
    } catch {
      continue;
    }

    const { data: claimed, error: claimError } = await d1
      .from("question_sets")
      .update({ community_collection_title: title })
      .eq("id", candidate.id)
      .is("community_collection_title", null)
      .eq("community_structure_edited", 0)
      .select()
      .maybeSingle<DbQuestionSet>();
    if (claimed) return claimed;
    if (claimError && claimError.code !== "23505") {
      throw new HomepageCommunityQuestionSetPersistenceError(claimError.message);
    }
    const concurrentlyClaimed = await getHomepageCommunityCollection(title);
    if (concurrentlyClaimed) return concurrentlyClaimed;
  }
  return null;
}

function buildHomepageCommunityQuestions(
  questionSetId: string,
  questionItems: QuestionImportItem[],
  startOrderIndex: number,
  playerId: string,
  createdAt: string,
) {
  return questionItems.map((item, index): DbQuestion => {
    const labelText = item.labelText?.trim() || null;
    return {
      id: crypto.randomUUID(),
      question_set_id: questionSetId,
      image_url: item.imageUrl,
      order_index: startOrderIndex + index,
      is_r18: item.isR18 === true,
      label_text: labelText,
      label_source: labelText ? "manual" : null,
      label_source_answer_id: null,
      label_updated_by_player_id: labelText ? playerId : null,
      label_updated_at: labelText ? createdAt : null,
      created_at: createdAt,
    };
  });
}

function buildHomepageImageIndexRows(questions: DbQuestion[], questionItems: QuestionImportItem[], createdAt: string) {
  return questions.map((question, index) => ({
    question_id: question.id,
    question_set_id: question.question_set_id,
    image_url: question.image_url,
    answer_text: question.label_text!,
    order_index: question.order_index,
    is_r18: question.is_r18 === true ? 1 : 0,
    anime_subject_id: questionItems[index].animeTags?.[0]?.id ?? null,
    anime_tags_json: questionItems[index].animeTags ?? [],
    character_tags_json: questionItems[index].characterTags ?? [],
    created_at: createdAt,
  }));
}

async function appendHomepageCommunityQuestions(params: {
  questionSet: DbQuestionSet;
  title: string;
  submissionId: string;
  submissionFingerprint: string;
  playerId: string;
  questionItems: QuestionImportItem[];
}) {
  const existingQuestions = getAppendableHomepageQuestions(params.questionSet, params.title);
  const startOrderIndex = existingQuestions.length;
  const revision = params.questionSet.manifest_revision;
  if (!Number.isInteger(revision) || (revision ?? -1) < 0 || typeof params.questionSet.manifest_json !== "string") {
    throw new HomepageCommunityQuestionSetPersistenceError("同名题库 manifest 修订号无效。");
  }

  const createdAt = new Date().toISOString();
  const appendedQuestions = buildHomepageCommunityQuestions(
    params.questionSet.id,
    params.questionItems,
    startOrderIndex,
    params.playerId,
    createdAt,
  );
  const combinedQuestions = [...existingQuestions, ...appendedQuestions];
  const nextManifest = encodeQuestionSetManifest(combinedQuestions.map(toQuestion));
  const nextRevision = revision + 1;
  const nextImageCount = combinedQuestions.length;
  const guardQuery = `SELECT 1 FROM question_sets
    WHERE id=? AND community_collection_title=? AND manifest_revision=? AND image_count=? AND manifest_json=?`;
  const guardBindings = [
    params.questionSet.id,
    params.title,
    nextRevision,
    nextImageCount,
    nextManifest,
  ] as const;
  const imageIndexRows = buildHomepageImageIndexRows(appendedQuestions, params.questionItems, createdAt);

  const { data: rows, error } = await d1.executeAtomically([
    {
      query: `UPDATE question_sets
        SET image_count=?, manifest_revision=?, manifest_json=?, updated_at=?
        WHERE id=? AND community_collection_title=? AND manifest_version=?
          AND manifest_revision=? AND image_count=? AND manifest_json=?
        RETURNING *`,
      bindings: [
        nextImageCount,
        nextRevision,
        nextManifest,
        createdAt,
        params.questionSet.id,
        params.title,
        QUESTION_SET_MANIFEST_VERSION,
        revision,
        startOrderIndex,
        params.questionSet.manifest_json,
      ],
    },
    ...imageIndexRows.map((row) => ({
      query: `INSERT INTO question_image_index (
          question_id, question_set_id, image_url, answer_text, order_index,
          anime_subject_id, anime_tags_json, character_tags_json, created_at, is_r18
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (${guardQuery})
        RETURNING *`,
      bindings: [
        row.question_id,
        row.question_set_id,
        row.image_url,
        row.answer_text,
        row.order_index,
        row.anime_subject_id,
        JSON.stringify(row.anime_tags_json),
        JSON.stringify(row.character_tags_json),
        row.created_at,
        row.is_r18,
        ...guardBindings,
      ],
    })),
    {
      query: `INSERT INTO community_question_set_submissions (
          submission_id, submission_fingerprint, question_set_id,
          start_order_index, added_image_count, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?
        WHERE EXISTS (${guardQuery})
        RETURNING *`,
      bindings: [
        params.submissionId,
        params.submissionFingerprint,
        params.questionSet.id,
        startOrderIndex,
        appendedQuestions.length,
        createdAt,
        ...guardBindings,
      ],
    },
  ]);
  if (error?.code === "23505") return null;
  if (error) throw new HomepageCommunityQuestionSetPersistenceError(error.message);

  const expectedStatementCount = imageIndexRows.length + 2;
  if (rows?.length === expectedStatementCount && rows.every((statementRows) => statementRows.length === 1)) {
    const updatedQuestionSet = rows[0][0] as DbQuestionSet;
    return {
      questionSet: toQuestionSet(updatedQuestionSet, combinedQuestions),
      submissionFingerprint: params.submissionFingerprint,
      appended: true,
      addedImageCount: appendedQuestions.length,
    };
  }
  if (rows?.length === expectedStatementCount && rows.every((statementRows) => statementRows.length === 0)) {
    return null;
  }
  throw new HomepageCommunityQuestionSetPersistenceError("题库追加事务返回了不一致的写入结果。");
}

export async function createHomepageCommunityQuestionSet(params: {
  submissionId: string;
  submissionFingerprint: string;
  playerId: string;
  nickname: string;
  title: string;
  description?: string;
  questions: QuestionImportItem[];
}) {
  assertD1Env();

  const submissionId = params.submissionId.trim();
  const submissionFingerprint = params.submissionFingerprint.trim();
  const playerId = params.playerId.trim();
  const nickname = params.nickname.replace(/[\r\n]+/g, " ").trim();
  const title = params.title.replace(/[\r\n]+/g, " ").trim();
  const description = params.description?.trim() || null;
  if (!/^[a-zA-Z0-9_-]{16,160}$/.test(submissionId)) throw new Error("投稿标识无效，请刷新页面后重试。");
  if (!/^[0-9a-f]{64}$/.test(submissionFingerprint)) throw new Error("投稿内容指纹无效，请刷新页面后重试。");
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(playerId)) throw new Error("上传者标识无效，请刷新页面后重试。");
  if (!nickname) throw new Error("请输入上传者昵称。");
  if (nickname.length > 20) throw new Error("上传者昵称最多 20 个字符。");
  if (!title) throw new Error("请输入题库标题。");
  if (title.length > MAX_HOMEPAGE_QUESTION_SET_TITLE_LENGTH) {
    throw new Error(`题库标题最多 ${MAX_HOMEPAGE_QUESTION_SET_TITLE_LENGTH} 个字符。`);
  }
  if (description && description.length > MAX_HOMEPAGE_QUESTION_SET_DESCRIPTION_LENGTH) {
    throw new Error(`题库说明最多 ${MAX_HOMEPAGE_QUESTION_SET_DESCRIPTION_LENGTH} 个字符。`);
  }
  if (!Array.isArray(params.questions) || params.questions.length === 0) throw new Error("请至少上传一张截图。");
  if (params.questions.length > MAX_QUESTION_SET_QUESTIONS) {
    throw new Error(`单次投稿最多包含 ${MAX_QUESTION_SET_QUESTIONS} 道题。`);
  }
  if (params.questions.some((question) => !question.labelText?.trim())) {
    throw new Error("每张截图都必须填写正确答案。");
  }
  if (params.questions.some((question) => (question.labelText?.trim().length ?? 0) > MAX_HOMEPAGE_QUESTION_LABEL_LENGTH)) {
    throw new Error(`单题答案最多 ${MAX_HOMEPAGE_QUESTION_LABEL_LENGTH} 个字符。`);
  }

  const questionItems = normalizeQuestionImportItems(params.questions);
  if (questionItems.length !== params.questions.length) throw new Error("题库中包含无效或重复的图片。");
  if (questionItems.some((question) => !question.labelText)) throw new Error("每张截图都必须填写正确答案。");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const priorSubmission = await getHomepageCommunityQuestionSetBySubmissionId(submissionId);
    if (priorSubmission) {
      if (priorSubmission.submissionFingerprint !== submissionFingerprint) {
        throw new HomepageCommunityQuestionSetConflictError();
      }
      return priorSubmission;
    }

    const collection = await findOrClaimHomepageCommunityCollection(title);
    if (collection) {
      const appended = await appendHomepageCommunityQuestions({
        questionSet: collection,
        title,
        submissionId,
        submissionFingerprint,
        playerId,
        questionItems,
      });
      if (appended) return appended;
      continue;
    }

    const questionSetId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const questions = buildHomepageCommunityQuestions(questionSetId, questionItems, 0, playerId, createdAt);
    const questionSetRecord = {
      id: questionSetId,
      title,
      description,
      created_by_player_id: playerId,
      created_by_nickname: nickname,
      source: "uploaded",
      creation_method: "player_manual",
      is_public: true,
      image_count: questions.length,
      image_urls_text: null,
      manifest_version: QUESTION_SET_MANIFEST_VERSION,
      manifest_revision: 0,
      manifest_json: encodeQuestionSetManifest(questions.map(toQuestion)),
      community_submission_id: submissionId,
      community_submission_fingerprint: submissionFingerprint,
      community_collection_title: title,
      community_structure_edited: 0,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const imageIndexRows = buildHomepageImageIndexRows(questions, questionItems, createdAt);
    const submissionRecord: CommunityQuestionSetSubmissionRow = {
      submission_id: submissionId,
      submission_fingerprint: submissionFingerprint,
      question_set_id: questionSetId,
      start_order_index: 0,
      added_image_count: questions.length,
      created_at: createdAt,
    };
    const { data: insertedRows, error } = await d1.insertAtomically([
      { table: "question_sets", records: [questionSetRecord] },
      { table: "question_image_index", records: imageIndexRows },
      { table: "community_question_set_submissions", records: [submissionRecord] },
    ]);
    const questionSet = insertedRows?.[0]?.[0] as DbQuestionSet | undefined;
    const insertedSubmission = insertedRows?.[2]?.[0] as CommunityQuestionSetSubmissionRow | undefined;
    if (error?.code === "23505") continue;
    if (error || !questionSet || !insertedSubmission) {
      throw new HomepageCommunityQuestionSetPersistenceError(
        error?.message ?? "题库原子写入没有返回完整记录。",
      );
    }
    return {
      questionSet: toQuestionSet(questionSet, questions),
      submissionFingerprint,
      appended: false,
      addedImageCount: questions.length,
    };
  }

  const existing = await getHomepageCommunityQuestionSetBySubmissionId(submissionId);
  if (existing) {
    if (existing.submissionFingerprint !== submissionFingerprint) {
      throw new HomepageCommunityQuestionSetConflictError();
    }
    return existing;
  }
  throw new HomepageCommunityQuestionSetPersistenceError("同名题库并发追加冲突，请稍后重试。");
}

export async function assertCanCreateUploadedQuestionSet(params: { roomId: string; presenterPlayerId: string }) {
  assertD1Env();

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", params.roomId)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("game_status", "QUESTION_SETUP")
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    throw new Error("创建题库失败：当前房间不在出题阶段，或你不是本轮出题人。");
  }
}

export async function createQuestionSetFromUrlText(params: {
  roomId: string;
  presenterPlayerId: string;
  title: string;
  description?: string;
  imageUrlsText: string;
}) {
  const questions = parseQuestionImportText(params.imageUrlsText);

  if (questions.length === 0) {
    throw new Error("没有检测到有效图片链接。请使用 http/https 图片链接，或每行一个包含 image_url 的 JSON 对象。");
  }

  return createUploadedQuestionSet({
    roomId: params.roomId,
    presenterPlayerId: params.presenterPlayerId,
    title: params.title,
    description: params.description,
    questions,
    creationMethod: "creation_tool_assisted",
  });
}

export async function getQuestionSetById(questionSetId: string) {
  assertD1Env();

  const { data: questionSet, error } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", questionSetId)
    .maybeSingle<DbQuestionSet>();

  if (error) {
    throw new Error(error.message);
  }

  if (!questionSet) {
    return null;
  }

  const questions = await getDbQuestionsForQuestionSet(questionSet);
  return toQuestionSet(questionSet, questions);
}

const COMMUNITY_QUESTION_SET_PAGE_SIZE = 24;
const COMMUNITY_QUESTION_SET_MAX_PAGE_SIZE = 30;
const COMMUNITY_QUESTION_SET_SEARCH_COLUMNS = ["title", "description", "created_by_nickname"];
const COMMUNITY_QUESTION_SET_SUMMARY_COLUMNS = [
  "id",
  "title",
  "description",
  "created_by_player_id",
  "created_by_nickname",
  "source",
  "creation_method",
  "is_public",
  "image_count",
  "rating_avg",
  "rating_count",
  "play_count",
  "created_at",
  "updated_at",
].join(",");

function normalizeCommunityQuestionSetSort(value: unknown): CommunityQuestionSetSort {
  return value === "rating" || value === "plays" ? value : "latest";
}

function normalizeQuestionSetCreationMethod(value: unknown): QuestionSetCreationMethod | null {
  return value === "player_manual" || value === "creation_tool_assisted" ? value : null;
}

function normalizeCommunityQuestionSetSearch(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

function getCommunityQuestionSetSearchTerms(search: string) {
  return search.split(/\s+/).filter(Boolean).slice(0, 5);
}

function buildCommunityQuestionSetQuery(searchTerms: string[], creationMethod?: QuestionSetCreationMethod) {
  let query = d1.from("question_sets").eq("is_public", true);
  if (creationMethod) {
    query = query.eq("creation_method", creationMethod);
  }
  for (const term of searchTerms) {
    query = query.containsAny(COMMUNITY_QUESTION_SET_SEARCH_COLUMNS, term);
  }
  return query;
}

export async function getCommunityQuestionSets(params: {
  sort?: CommunityQuestionSetSort;
  search?: string;
  offset?: number;
  limit?: number;
  includeTotal?: boolean;
  creationMethod?: QuestionSetCreationMethod;
} = {}): Promise<CommunityQuestionSetPage> {
  assertD1Env();

  const sort = normalizeCommunityQuestionSetSort(params.sort);
  const searchTerms = getCommunityQuestionSetSearchTerms(normalizeCommunityQuestionSetSearch(params.search));
  const creationMethod = normalizeQuestionSetCreationMethod(params.creationMethod);
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const limit = Math.max(
    1,
    Math.min(COMMUNITY_QUESTION_SET_MAX_PAGE_SIZE, Math.floor(Number(params.limit) || COMMUNITY_QUESTION_SET_PAGE_SIZE)),
  );
  let query = buildCommunityQuestionSetQuery(searchTerms, creationMethod ?? undefined).select(COMMUNITY_QUESTION_SET_SUMMARY_COLUMNS);

  if (sort === "rating") {
    query = query
      .order("rating_avg", { ascending: false })
      .order("rating_count", { ascending: false })
      .order("created_at", { ascending: false });
  } else if (sort === "plays") {
    query = query.order("play_count", { ascending: false }).order("created_at", { ascending: false });
  } else {
    query = query.order("created_at", { ascending: false });
  }
  query = query.order("id", { ascending: false });

  const pagePromise = query.limit(limit + 1).offset(offset).returns<DbQuestionSet[]>();
  const countPromise = params.includeTotal === false
    ? Promise.resolve({ data: null, error: null })
    : buildCommunityQuestionSetQuery(searchTerms, creationMethod ?? undefined).count().single<{ count: number }>();
  const [{ data, error }, { data: countRow, error: countError }] = await Promise.all([pagePromise, countPromise]);

  if (error) {
    throw new Error(error.message);
  }
  if (countError) {
    throw new Error(countError.message);
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toCommunityQuestionSetSummary);

  return {
    items,
    total: countRow?.count ?? null,
    hasMore,
    nextOffset: offset + items.length,
  };
}

function toCommunityQuestionSetSummary(questionSet: DbQuestionSet): CommunityQuestionSetSummary {
  return {
    id: questionSet.id,
    title: questionSet.title,
    description: questionSet.description,
    createdByPlayerId: questionSet.created_by_player_id,
    createdByNickname: questionSet.created_by_nickname ?? null,
    source: questionSet.source,
    creationMethod: questionSet.creation_method ?? null,
    isPublic: questionSet.is_public,
    imageCount: questionSet.image_count,
    ratingAvg: questionSet.rating_avg,
    ratingCount: questionSet.rating_count,
    playCount: questionSet.play_count ?? 0,
    createdAt: questionSet.created_at,
    updatedAt: questionSet.updated_at,
  };
}

export async function getCommunityQuestionSetDetail(questionSetId: string) {
  assertD1Env();

  const { data: questionSet, error } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", questionSetId)
    .eq("is_public", true)
    .maybeSingle<DbQuestionSet>();

  if (error) {
    throw new Error(error.message);
  }
  if (!questionSet) {
    return null;
  }

  const questions = await getDbQuestionsForQuestionSet(questionSet);
  return toQuestionSet(questionSet, questions);
}

export async function prepareQuestionSetForStart(params: {
  roomId: string;
  presenterPlayerId: string;
  questionSetId: string;
}) {
  assertD1Env();

  const { data: questionSet, error: questionSetError } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", params.questionSetId)
    .maybeSingle<DbQuestionSet>();

  if (questionSetError) {
    throw new Error(questionSetError.message);
  }

  if (!questionSet || questionSet.image_count <= 0) {
    throw new Error("题库不存在，或题库中没有图片。");
  }

  if (questionSet.created_by_player_id !== params.presenterPlayerId && !questionSet.is_public) {
    throw new Error("不能使用他人的未公开题库。");
  }

  const preparedQuestionSource: RoomQuestionSource = questionSet.is_public
    ? "COMMUNITY"
    : questionSet.creation_method === "creation_tool_assisted"
      ? "CREATION_TOOL"
      : "MANUAL";

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", params.roomId)
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room || room.current_presenter_player_id !== params.presenterPlayerId || room.game_status !== "QUESTION_SETUP") {
    throw new Error("准备题库失败：当前房间不在出题阶段，或你不是本轮出题人。");
  }

  // 房间级“包含 R18 题目”开关默认关闭：准备时就按开关权威计算本局可用题数，
  // 而不是等开局才由 startGameWithQuestionSet 拒绝。
  // 筛选后 0 题不拒绝选择：仍记录题库，prepared_question_count 置 NULL 表示
  // 当前筛选 0 可用；UI 会显示警告并禁用开始按钮，房主打开 R18 开关后重算即可开始。
  const includeR18 = isDbTruthy(room.lobby_include_r18);
  const questions = await getDbQuestionsForQuestionSet(questionSet);
  const eligibleQuestions = filterQuestionsByR18(questions, includeR18);

  const { data: updatedRoom, error } = await d1
    .from("rooms")
    .update({
      prepared_question_set_id: params.questionSetId,
      // 社区题库可累计超过 30 题；每局仍最多 30 题，这里只记录本局上限。
      // 关闭 R18 时按过滤后的可用题数计算；筛选后 0 题时置 NULL（表示 0 可用）。
      prepared_question_count: eligibleQuestions.length === 0
        ? null
        : Math.min(eligibleQuestions.length, MAX_QUESTION_SET_QUESTIONS),
      lobby_question_count: null,
      prepared_question_source: preparedQuestionSource,
      public_activity_at: new Date().toISOString(),
    })
    .eq("id", params.roomId)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("game_status", "QUESTION_SETUP")
    .select()
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!updatedRoom) {
    throw new Error("准备题库失败：当前房间不在出题阶段，或你不是本轮出题人。");
  }

  return toRoom(updatedRoom);
}

export async function updateRoomNotice(params: {
  roomId: string;
  hostPlayerId: string;
  notice: string;
}) {
  assertD1Env();

  const normalizedNotice = params.notice.replace(/[\r\n]+/g, " ").trim();
  if (normalizedNotice.length > MAX_ROOM_NOTICE_LENGTH) {
    throw new Error(`房间信息最多 ${MAX_ROOM_NOTICE_LENGTH} 个字符。`);
  }
  const notice = normalizedNotice || null;
  const { data: currentRoom, error: currentRoomError } = await d1
    .from("rooms")
    .select("id,host_player_id,game_status,room_notice,room_visibility,updated_at")
    .eq("id", params.roomId)
    .eq("host_player_id", params.hostPlayerId)
    .maybeSingle<Pick<DbRoom, "id" | "host_player_id" | "game_status" | "room_notice" | "room_visibility" | "updated_at">>();

  if (currentRoomError) throw new Error(currentRoomError.message);
  if (!currentRoom || (currentRoom.game_status !== "LOBBY" && currentRoom.game_status !== "QUESTION_SETUP")) {
    throw new Error("只有房主可以在房间大厅或题库准备阶段修改房间信息。");
  }
  if ((currentRoom.room_notice ?? null) === notice) {
    return {
      roomId: currentRoom.id,
      notice,
      updatedAt: currentRoom.updated_at,
      changed: false,
    };
  }

  const { data: updatedRoom, error } = await d1
    .from("rooms")
    .update({
      room_notice: notice,
      ...(currentRoom.room_visibility === "PUBLIC" ? { public_activity_at: new Date().toISOString() } : {}),
    })
    .eq("id", params.roomId)
    .eq("host_player_id", params.hostPlayerId)
    .eq("game_status", currentRoom.game_status)
    .select("id,room_notice,updated_at")
    .maybeSingle<Pick<DbRoom, "id" | "room_notice" | "updated_at">>();

  if (error) throw new Error(error.message);
  if (!updatedRoom) throw new Error("修改房间信息失败：房间状态已变化，请按最新状态重试。");
  return {
    roomId: updatedRoom.id,
    notice: updatedRoom.room_notice ?? null,
    updatedAt: updatedRoom.updated_at,
    changed: true,
  };
}

export async function updateRoomGameSettings(params: {
  roomId: string;
  hostPlayerId: string;
  gameMode: GameMode;
  maxRevealRounds?: number;
  roundSeconds?: number;
  roundScores?: number[];
  teamRevealVoteSeconds?: number;
  teamGuessVoteSeconds?: number;
  teamPresenterBlockEnabled?: boolean;
  spectatorQuestionPreviewEnabled?: boolean;
  spectatorPlayerAnswersEnabled?: boolean;
  playerCapacity?: number;
  spectatorCapacity?: number;
  teamAssignmentMode?: TeamAssignmentMode;
  questionCount?: number | null;
  /** 房间级“包含 R18 题目”开关；省略时保持当前值。关闭时服务端按它排除候选题。 */
  includeR18?: boolean;
}) {
  assertD1Env();

  if (!isGameMode(params.gameMode)) {
    throw new Error("不支持的游戏模式。");
  }

  const maxRevealRounds = normalizeMaxRevealRounds(params.maxRevealRounds);
  const roundSeconds = normalizeRoundSeconds(params.roundSeconds);
  const roundScores = normalizeRoundScores(params.roundScores, maxRevealRounds);
  const teamRevealVoteSeconds = normalizeTeamBattleVoteSeconds(
    params.teamRevealVoteSeconds,
    DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
  );
  const teamGuessVoteSeconds = normalizeTeamBattleVoteSeconds(
    params.teamGuessVoteSeconds,
    DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
  );
  const { data: currentRoom, error: currentRoomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", params.roomId)
    .eq("host_player_id", params.hostPlayerId)
    .maybeSingle<DbRoom>();

  if (currentRoomError) {
    throw new Error(currentRoomError.message);
  }

  if (!currentRoom || (currentRoom.game_status !== "LOBBY" && currentRoom.game_status !== "QUESTION_SETUP")) {
    throw new Error("只有房主可以在房间大厅或题库准备阶段修改游戏模式。");
  }
  const teamPresenterBlockEnabled = params.teamPresenterBlockEnabled ?? (
    currentRoom.lobby_team_presenter_block_enabled === 1 || currentRoom.lobby_team_presenter_block_enabled === true
  );
  const spectatorQuestionPreviewEnabled = params.spectatorQuestionPreviewEnabled ?? (
    currentRoom.lobby_spectator_question_preview_enabled !== 0 && currentRoom.lobby_spectator_question_preview_enabled !== false
  );
  const spectatorPlayerAnswersEnabled = params.spectatorPlayerAnswersEnabled ?? (
    currentRoom.lobby_spectator_player_answers_enabled !== 0 && currentRoom.lobby_spectator_player_answers_enabled !== false
  );
  const playerCapacity = params.playerCapacity === undefined
    ? normalizePlayerCapacity(currentRoom.lobby_player_capacity)
    : requirePlayerCapacity(params.playerCapacity);
  const spectatorCapacity = params.spectatorCapacity === undefined
    ? normalizeSpectatorCapacity(currentRoom.lobby_spectator_capacity)
    : requireSpectatorCapacity(params.spectatorCapacity);
  let questionCount = params.questionCount === undefined
    ? normalizeQuestionCount(currentRoom.lobby_question_count)
    : requireQuestionCount(params.questionCount);
  // includeR18 来自不可信 RPC 输入：提供了但非 boolean（含 null/数字/字符串）必须明确拒绝，
  // 不能静默当成 false，避免客户端误传时悄悄改变开关语义。
  let includeR18 = isDbTruthy(currentRoom.lobby_include_r18);
  if (params.includeR18 !== undefined) {
    if (typeof params.includeR18 !== "boolean") {
      throw new Error("“包含 R18 题目”开关必须是布尔值（true 或 false）。");
    }
    includeR18 = params.includeR18;
  }
  const includeR18Changed = includeR18 !== isDbTruthy(currentRoom.lobby_include_r18);
  let preparedQuestionCount = normalizeQuestionCount(currentRoom.prepared_question_count);
  // 已准备题库时按最新开关重新计算本局可用题数（每局仍最多 30），并在开关
  // 切换导致可用题数减少时收紧当前随机题数，避免开局时用过期设置被拒绝。
  let nextPreparedQuestionCount: number | null = null;
  if (typeof currentRoom.prepared_question_set_id === "string") {
    const eligibleQuestionCount = await getEligibleQuestionCountForPreparedSet(
      currentRoom.prepared_question_set_id,
      includeR18,
    );
    if (eligibleQuestionCount === 0) {
      // 当前筛选下题库 0 可用：开关切换不拒绝（房主可再打开 R18 恢复），
      // prepared_question_count 置 NULL 表示 0 可用，同时清空随机题数；
      // 开局由 startGameWithQuestionSet 的 0 候选权威拒绝兜底。
      nextPreparedQuestionCount = null;
      questionCount = null;
    } else {
      nextPreparedQuestionCount = Math.min(eligibleQuestionCount, MAX_QUESTION_SET_QUESTIONS);
    }
  }
  if (nextPreparedQuestionCount != null) {
    preparedQuestionCount = nextPreparedQuestionCount;
    if (questionCount != null && questionCount > preparedQuestionCount) {
      if (includeR18Changed) {
        // 开关切换导致的题数收紧：直接修到当前可用上限，等价的“全部题目”映射为 null。
        questionCount = preparedQuestionCount;
      } else {
        throw new Error(`本局抽取题数不能超过当前题库的 ${preparedQuestionCount} 道题。`);
      }
    }
  } else if (questionCount != null && preparedQuestionCount != null && questionCount > preparedQuestionCount) {
    throw new Error(`本局抽取题数不能超过当前题库的 ${preparedQuestionCount} 道题。`);
  }
  if (questionCount != null && preparedQuestionCount != null && questionCount === preparedQuestionCount) questionCount = null;
  const currentPlayers = getRoomStatePlayers(currentRoom);
  const playerCount = countGamePlayers(currentPlayers);
  const spectatorCount = countSpectators(currentPlayers);
  if (playerCapacity < playerCount) {
    throw new Error(`当前已有 ${playerCount} 名玩家，玩家人数上限不能低于 ${playerCount}。`);
  }
  if (spectatorCapacity < spectatorCount) {
    throw new Error(`当前已有 ${spectatorCount} 名观战者，观战人数上限不能低于 ${spectatorCount}。`);
  }
  const teamAssignmentMode = normalizeTeamAssignmentMode(params.teamAssignmentMode ?? currentRoom.lobby_team_assignment_mode);
  const roomUpdates: Partial<DbRoom> = {
    lobby_game_mode: params.gameMode,
    lobby_max_reveal_rounds: maxRevealRounds,
    lobby_round_seconds: roundSeconds,
    lobby_round_scores: roundScores,
    lobby_team_reveal_vote_seconds: teamRevealVoteSeconds,
    lobby_team_guess_vote_seconds: teamGuessVoteSeconds,
    lobby_team_presenter_block_enabled: teamPresenterBlockEnabled ? 1 : 0,
    lobby_spectator_question_preview_enabled: spectatorQuestionPreviewEnabled ? 1 : 0,
    lobby_spectator_player_answers_enabled: spectatorPlayerAnswersEnabled ? 1 : 0,
    lobby_player_capacity: playerCapacity,
    lobby_spectator_capacity: spectatorCapacity,
    lobby_question_count: questionCount,
    lobby_team_assignment_mode: teamAssignmentMode,
    lobby_include_r18: includeR18 ? 1 : 0,
    // 已准备题库时始终按最新开关重写可用题数（0 可用时写 NULL），
    // 未准备题库时保持原样，避免覆盖其他阶段的清理语义。
    ...(typeof currentRoom.prepared_question_set_id === "string"
      ? { prepared_question_count: nextPreparedQuestionCount }
      : {}),
    ...(params.gameMode !== "TEAM_BATTLE" || teamAssignmentMode === "AUTO"
      ? { lobby_team_assignments: "{}" }
      : {}),
  };
  const settingsUnchanged = Object.entries(roomUpdates).every(([key, value]) => {
    const currentValue = currentRoom[key as keyof DbRoom];
    if (key === "lobby_round_scores") {
      return JSON.stringify(normalizeRoundScores(currentValue, maxRevealRounds)) === JSON.stringify(value);
    }
    return currentValue === value;
  });
  if (settingsUnchanged) return toRoom(currentRoom);

  const { data: room, error } = await d1
    .from("rooms")
    .update({ ...roomUpdates, public_activity_at: new Date().toISOString() })
    .eq("id", params.roomId)
    .eq("host_player_id", params.hostPlayerId)
    .eq("game_status", currentRoom.game_status)
    .select()
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!room) {
    throw new Error("修改游戏模式失败：房间状态已变化，请刷新后重试。");
  }

  return toRoom(room);
}

async function cleanupFailedGameSession(gameSessionId: string) {
  const { error } = await d1.from("game_sessions").delete().eq("id", gameSessionId);
  if (error) {
    console.error(
      JSON.stringify({
        event: "start_game_cleanup_failed",
        gameSessionId,
        error: error.message,
      }),
    );
  }
}

async function getCommittedStartedGameRoom(roomId: string, gameSessionId: string) {
  const room = await getDbRoomById(roomId);
  if (room?.game_status !== "PLAYING" || room.current_game_id !== gameSessionId) {
    return null;
  }

  return toRoom(room);
}

const START_GAME_REQUEST_ID_CONFLICT = "START_GAME_REQUEST_ID_CONFLICT";

export class StartGameRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartGameRejectedError";
  }
}

function rejectStartGame(message: string): never {
  throw new StartGameRejectedError(message);
}

function normalizeStartRequestId(value: unknown) {
  if (typeof value !== "string") {
    rejectStartGame("页面版本已更新，请刷新后重试。");
  }

  const normalized = value.trim();
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(normalized)) {
    rejectStartGame("开始游戏失败：请求标识无效，请刷新后重试。");
  }

  return normalized;
}

export async function startGameWithQuestionSet(params: {
  startRequestId?: string;
  roomId: string;
  hostPlayerId: string;
  presenterPlayerId: string;
  questionSetId: string;
  gameMode?: GameMode;
  maxRevealRounds?: number;
  roundSeconds?: number;
  roundScores?: number[];
  teamRevealVoteSeconds?: number;
  teamGuessVoteSeconds?: number;
  teamPresenterBlockEnabled?: boolean;
  questionCount?: number | null;
  authorityVersion?: 2;
}) {
  assertD1Env();

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", params.roomId)
    .eq("host_player_id", params.hostPlayerId)
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    rejectStartGame("开始游戏失败：只有房主可以使用已准备好的题库开始游戏。");
  }
  const roomPlayers = getRoomStatePlayers(room);

  if (room.game_status === "PLAYING" && room.current_game_id) {
    let currentDbGameSession: DbGameSession | null = null;
    const currentGameSession = params.authorityVersion === 2
      ? await (async () => {
          const { data, error } = await d1.from("game_sessions").select("*").eq("id", room.current_game_id).maybeSingle<DbGameSession>();
          if (error) throw new Error(error.message);
          if (!data) return null;
          currentDbGameSession = data;
          const currentPlayers = roomPlayers;
          return {
            ...toGameSession(data),
            eligiblePlayerIds: currentPlayers.filter(isGamePlayer).filter((player) => player.id !== data.presenter_player_id).map((player) => player.id),
          };
        })()
      : await getGameSessionById(room.current_game_id);
    if (
      currentGameSession?.status === "PLAYING" &&
      currentGameSession.presenterPlayerId === params.presenterPlayerId &&
      currentGameSession.questionSetId === params.questionSetId
    ) {
      const currentPlayers = roomPlayers;
      if (params.authorityVersion === 2) {
        const { data: currentQuestionSet, error: currentQuestionSetError } = await d1
          .from("question_sets")
          .select("*")
          .eq("id", params.questionSetId)
          .maybeSingle<DbQuestionSet>();
        if (currentQuestionSetError || !currentQuestionSet) throw new Error(currentQuestionSetError?.message ?? "题库不存在。");
        if (!currentDbGameSession) throw new Error("本局抽题快照不存在。");
        const currentQuestions = await getDbQuestionsForGameSession(currentDbGameSession, currentQuestionSet);
        return {
          gameSession: currentGameSession,
          room: toRoom(room, currentPlayers),
          __authorityVNextBootstrap: {
            players: currentPlayers.map(toPlayer),
            questionSet: toGameQuestionSet(currentQuestionSet, currentQuestions),
            questions: currentQuestions.map(toQuestion),
            questionSetManifestVersion: currentQuestionSet.manifest_version ?? null,
          },
        };
      }
      return {
        gameSession: currentGameSession,
        room: toRoom(room, currentPlayers),
      };
    }
  }

  if (
    room.current_presenter_player_id !== params.presenterPlayerId ||
    room.prepared_question_set_id !== params.questionSetId ||
    room.game_status !== "QUESTION_SETUP"
  ) {
    rejectStartGame("开始游戏失败：只有房主可以使用已准备好的题库开始游戏。");
  }

  const gameSessionId = normalizeStartRequestId(params.startRequestId);

  const { data: questionSet, error: questionSetError } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", params.questionSetId)
    .maybeSingle<DbQuestionSet>();

  if (questionSetError) {
    throw new Error(questionSetError.message);
  }

  if (!questionSet || questionSet.image_count <= 0) {
    rejectStartGame("开始游戏失败：题库不存在，或题库中没有图片。");
  }

  if (questionSet.created_by_player_id !== params.presenterPlayerId && !questionSet.is_public) {
    rejectStartGame("开始游戏失败：不能使用他人的未公开题库。");
  }

  const maxRevealRounds = normalizeMaxRevealRounds(params.maxRevealRounds ?? room.lobby_max_reveal_rounds);
  const roundSeconds = normalizeRoundSeconds(params.roundSeconds ?? room.lobby_round_seconds);
  const teamRevealVoteSeconds = normalizeTeamBattleVoteSeconds(
    params.teamRevealVoteSeconds ?? room.lobby_team_reveal_vote_seconds,
    DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
  );
  const teamGuessVoteSeconds = normalizeTeamBattleVoteSeconds(
    params.teamGuessVoteSeconds ?? room.lobby_team_guess_vote_seconds,
    DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
  );
  const teamPresenterBlockEnabled = params.teamPresenterBlockEnabled ?? (
    room.lobby_team_presenter_block_enabled === 1 || room.lobby_team_presenter_block_enabled === true
  );
  const gameMode = isGameMode(params.gameMode) ? params.gameMode : room.lobby_game_mode ?? "ROUND_REVEAL";
  const players = roomPlayers;
  const activeGamePlayers = players.filter(isGamePlayer);
  const presenter = activeGamePlayers.find((player) => player.id === params.presenterPlayerId);
  if (!presenter) {
    rejectStartGame("开始游戏失败：出题人必须是玩家身份。");
  }

  const teamBattleGuessers = activeGamePlayers.filter((player) => player.id !== params.presenterPlayerId);
  if (gameMode === "TEAM_BATTLE" && teamBattleGuessers.length < 2) {
    rejectStartGame("红蓝对抗模式至少需要 2 名答题者。");
  }

  const teamAssignmentMode = normalizeTeamAssignmentMode(room.lobby_team_assignment_mode);
  const manualAssignments = sanitizeTeamAssignments(room, activeGamePlayers);
  if (gameMode === "TEAM_BATTLE" && teamAssignmentMode === "MANUAL") {
    const unassigned = teamBattleGuessers.filter((player) => !manualAssignments[player.id]);
    const redCount = teamBattleGuessers.filter((player) => manualAssignments[player.id] === "red").length;
    const blueCount = teamBattleGuessers.filter((player) => manualAssignments[player.id] === "blue").length;
    if (unassigned.length > 0) {
      rejectStartGame(`开始游戏失败：${unassigned.map((player) => player.nickname).join("、")}尚未选择队伍。`);
    }
    if (redCount === 0 || blueCount === 0) {
      rejectStartGame(`开始游戏失败：${redCount === 0 ? "红队" : "蓝队"}至少需要 1 名答题玩家。`);
    }
  }

  const teamBattleState = gameMode === "TEAM_BATTLE"
    ? createInitialTeamBattleState(activeGamePlayers, params.presenterPlayerId, {
        revealVoteSeconds: teamRevealVoteSeconds,
        guessVoteSeconds: teamGuessVoteSeconds,
        presenterBlockEnabled: teamPresenterBlockEnabled,
        manualAssignments: teamAssignmentMode === "MANUAL" ? manualAssignments : undefined,
      })
    : null;
  const roundScores = normalizeRoundScores(params.roundScores ?? room.lobby_round_scores, maxRevealRounds);
  const availableQuestions = await getDbQuestionsForQuestionSet(questionSet);
  if (availableQuestions.length !== questionSet.image_count) {
    rejectStartGame("开始游戏失败：题库题目数量不一致，请重新准备题库。");
  }
  // 房间级“包含 R18 题目”开关是开局抽题的权威依据（读取房间持久列，不信任
  // 客户端参数）：关闭时候选池排除 is_r18=true，开启时包含全部。
  const includeR18 = isDbTruthy(room.lobby_include_r18);
  const eligibleQuestions = filterQuestionsByR18(availableQuestions, includeR18);
  if (eligibleQuestions.length === 0) {
    rejectStartGame("开始游戏失败：当前题库没有可用的非 R18 题目，请开启“包含 R18 题目”或更换题库。");
  }
  const configuredQuestionCount = params.questionCount === undefined
    ? room.lobby_question_count
    : params.questionCount;
  const questionCount = requireStartQuestionCount(configuredQuestionCount, eligibleQuestions.length);
  // 抽中顺序在此冻结进 selected_question_ids：重复 startRequestId、刷新、重连、
  // Room DO 恢复和结算回退都只读取该快照，不重新抽取。
  const selectedQuestions = selectQuestionsForGame(eligibleQuestions, questionCount);
  const selectedQuestionIds = selectedQuestions.map((question) => question.id);

  const initialGameSessionValues = {
    room_id: params.roomId,
    question_set_id: params.questionSetId,
    presenter_player_id: params.presenterPlayerId,
    status: "PLAYING",
    game_mode: gameMode,
    current_question_index: 0,
    current_reveal_round: 1,
    revealed_blocks: [],
    max_reveal_rounds: maxRevealRounds,
    round_seconds: roundSeconds,
    round_scores: roundScores,
    selected_question_ids: selectedQuestionIds,
    team_battle_state: teamBattleState,
    round_started_at: null,
    ended_at: null,
  };
  const { data: insertedGameSession, error: gameSessionError } = await d1
    .from("game_sessions")
    .insert({
      id: gameSessionId,
      ...initialGameSessionValues,
    })
    .select()
    .maybeSingle<DbGameSession>();

  let gameSession = insertedGameSession;
  if (gameSessionError || !gameSession) {
    const { data: deletedGameSession, error: cleanupError } = await d1
      .from("game_sessions")
      .delete()
      .eq("id", gameSessionId)
      .eq("room_id", params.roomId)
      .eq("question_set_id", params.questionSetId)
      .eq("presenter_player_id", params.presenterPlayerId)
      .eq("status", "PLAYING")
      .eq("current_question_index", 0)
      .eq("current_reveal_round", 1)
      .eq("revealed_blocks", [])
      .is("round_started_at", null)
      .is("ended_at", null)
      .select()
      .maybeSingle<DbGameSession>();

    if (cleanupError) {
      console.error(
        JSON.stringify({
          event: "start_game_insert_recovery_cleanup_failed",
          gameSessionId,
          roomId: params.roomId,
          insertError: gameSessionError?.message ?? "insert returned no game session",
          cleanupError: cleanupError.message,
        }),
      );
      throw new Error(gameSessionError?.message ?? cleanupError.message);
    }

    if (!deletedGameSession && isUniqueViolation(gameSessionError)) {
      throw new Error(`${START_GAME_REQUEST_ID_CONFLICT}: 开局请求标识已过期。`);
    }

    const { data: reinsertedGameSession, error: recoveryError } = await d1
      .from("game_sessions")
      .insert({
        id: gameSessionId,
        ...initialGameSessionValues,
      })
      .select()
      .maybeSingle<DbGameSession>();

    let recoveredGameSession = reinsertedGameSession;
    if (recoveryError || !recoveredGameSession) {
      const { data: verifiedGameSession, error: verificationError } = await d1
        .from("game_sessions")
        .select("*")
        .eq("id", gameSessionId)
        .eq("room_id", params.roomId)
        .eq("question_set_id", params.questionSetId)
        .eq("presenter_player_id", params.presenterPlayerId)
        .eq("status", "PLAYING")
        .eq("current_question_index", 0)
        .eq("current_reveal_round", 1)
        .maybeSingle<DbGameSession>();

      if (verificationError || !verifiedGameSession) {
        if (!verificationError && isUniqueViolation(recoveryError)) {
          throw new Error(`${START_GAME_REQUEST_ID_CONFLICT}: 开局请求标识已过期。`);
        }

        console.error(
          JSON.stringify({
            event: "start_game_insert_recovery_failed",
            gameSessionId,
            roomId: params.roomId,
            insertError: gameSessionError?.message ?? "insert returned no game session",
            recoveryError: recoveryError?.message ?? "recovery insert returned no game session",
            verificationError: verificationError?.message ?? "recovered game session was not found",
          }),
        );
        throw new Error(
          gameSessionError?.message ?? recoveryError?.message ?? verificationError?.message ?? "开始游戏失败，请稍后重试。",
        );
      }

      recoveredGameSession = verifiedGameSession;
    }

    gameSession = recoveredGameSession;
  }

  let eligiblePlayerIds: string[];
  if (params.authorityVersion === 2) {
    eligiblePlayerIds = activeGamePlayers
      .filter((player) => player.id !== params.presenterPlayerId)
      .map((player) => player.id);
  } else {
    try {
      await createGameParticipantSnapshot(gameSession.id, activeGamePlayers);
      eligiblePlayerIds = await createQuestionEligibilitySnapshotFromPlayers({
        gameSessionId: gameSession.id,
        questionIndex: gameSession.current_question_index,
        presenterPlayerId: params.presenterPlayerId,
        players: activeGamePlayers,
      });
    } catch (error) {
      await cleanupFailedGameSession(gameSession.id);
      throw error;
    }
  }
  const hydratedGameSession = {
    ...toGameSession(gameSession),
    eligiblePlayerIds,
  };

  const { data: updatedRoom, error: updateRoomError } = await d1
    .from("rooms")
    .update({
      current_game_id: gameSession.id,
      prepared_question_set_id: null,
      prepared_question_count: null,
      lobby_question_count: questionCount === eligibleQuestions.length ? null : questionCount,
      game_status: "PLAYING",
      public_activity_at: new Date().toISOString(),
    })
    .eq("id", params.roomId)
    .eq("host_player_id", params.hostPlayerId)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("prepared_question_set_id", params.questionSetId)
    .eq("game_status", "QUESTION_SETUP")
    .select()
    .maybeSingle<DbRoom>();

  if (updateRoomError) {
    try {
      const committedRoom = await getCommittedStartedGameRoom(params.roomId, gameSession.id);
      if (committedRoom) {
        return {
          gameSession: hydratedGameSession,
          room: committedRoom,
        };
      }
    } catch (verificationError) {
      console.error(
        JSON.stringify({
          event: "start_game_commit_verification_failed",
          gameSessionId: gameSession.id,
          roomId: params.roomId,
          error: verificationError instanceof Error ? verificationError.message : String(verificationError),
        }),
      );
      throw new Error(updateRoomError.message);
    }

    await cleanupFailedGameSession(gameSession.id);
    throw new Error(updateRoomError.message);
  }

  if (!updatedRoom) {
    await cleanupFailedGameSession(gameSession.id);
    throw new Error("开始游戏失败：房间状态已变化，请刷新后重试。");
  }

  const vnextQuestions = params.authorityVersion === 2 ? await getDbQuestionsForGameSession(gameSession, questionSet) : [];
  return {
    gameSession: hydratedGameSession,
    room: toRoom(updatedRoom),
    ...(params.authorityVersion === 2
      ? {
          __authorityVNextBootstrap: {
            players: players.map(toPlayer),
            questionSet: toGameQuestionSet(questionSet, vnextQuestions),
            questions: vnextQuestions.map(toQuestion),
            questionSetManifestVersion: questionSet.manifest_version ?? null,
          },
        }
      : {}),
  };
}

export async function updatePlayerRole(roomId: string, actorPlayerId: string, targetPlayerId: string, role: PlayerRole, team?: TeamBattleTeam) {
  assertD1Env();

  if (!isPlayerRole(role)) {
    throw new Error("身份切换失败：未知的玩家身份。");
  }

  if (actorPlayerId !== targetPlayerId) {
    throw new Error("身份切换失败：只能切换自己的玩家/观战身份。");
  }

  const { data: room, error: roomError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .maybeSingle<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  if (!room) {
    throw new Error("身份切换失败：房间不存在。");
  }

  const canSwitchRole = room.game_status === "LOBBY" || room.game_status === "QUESTION_SETUP";
  if (!canSwitchRole) {
    throw new Error("只有在房间大厅或出题准备阶段可以切换玩家/观战身份。");
  }

  if (room.game_status === "QUESTION_SETUP" && role === "SPECTATOR" && targetPlayerId === room.current_presenter_player_id) {
    throw new Error("当前出题人不能切换为观战身份。");
  }

  const players = getRoomStatePlayers(room);
  const targetPlayer = players.find((player) => player.id === targetPlayerId);

  if (!targetPlayer) {
    throw new Error("身份切换失败：你不在当前房间。");
  }

  const playerCapacity = normalizePlayerCapacity(room.lobby_player_capacity);
  const spectatorCapacity = normalizeSpectatorCapacity(room.lobby_spectator_capacity);
  if (role === "PLAYER" && !isGamePlayer(targetPlayer) && countGamePlayers(players) >= playerCapacity) {
    throw new Error(`玩家已满，当前房间最多支持 ${playerCapacity} 名玩家；可以继续观战。`);
  }
  if (role === "SPECTATOR" && isGamePlayer(targetPlayer) && countSpectators(players) >= spectatorCapacity) {
    throw new Error(`观战人数已满，当前房间最多支持 ${spectatorCapacity} 名观战者。`);
  }

  const selectedTeam = team === "red" || team === "blue" ? team : null;
  const assignments = normalizeTeamAssignments(room.lobby_team_assignments);
  if (
    role === "PLAYER"
    && room.lobby_game_mode === "TEAM_BATTLE"
    && normalizeTeamAssignmentMode(room.lobby_team_assignment_mode) === "MANUAL"
    && targetPlayerId !== room.current_presenter_player_id
    && !selectedTeam
    && !assignments[targetPlayerId]
  ) {
    throw new Error("手动分队已开启，请先选择加入红队或蓝队。");
  }

  if (role === "SPECTATOR" || targetPlayerId === room.current_presenter_player_id) delete assignments[targetPlayerId];
  else if (selectedTeam) assignments[targetPlayerId] = selectedTeam;
  const nextPlayers = players.map((player) => player.id === targetPlayerId ? { ...player, role } : player);
  const updatedRoom = await updateRoomAggregate(room, nextPlayers, {
    lobby_team_assignments: JSON.stringify(assignments),
  });
  return toRoom(updatedRoom);
}

export async function getGameSessionById(gameSessionId: string) {
  assertD1Env();

  const { data, error } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", gameSessionId)
    .maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  return data ? await hydrateGameSessionEligibility(toGameSession(data)) : null;
}

async function getLegacyDbQuestionsByQuestionSetId(questionSetId: string) {
  assertD1Env();

  const { data, error } = await d1
    .from("questions")
    .select("*")
    .eq("question_set_id", questionSetId)
    .order("order_index", { ascending: true })
    .returns<DbQuestion[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

function normalizeSelectedQuestionIds(value: unknown) {
  if (value == null || value === "") return [];
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new Error("本局抽题快照已损坏。");
    }
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_QUESTION_SET_QUESTIONS) {
    throw new Error("本局抽题快照无效。");
  }
  const ids = parsed.map((id) => {
    if (typeof id !== "string" || !id.trim() || id.length > 128) throw new Error("本局抽题快照无效。");
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("本局抽题快照包含重复题目。");
  return ids;
}

async function getDbQuestionsForQuestionSet(questionSet: DbQuestionSet) {
  return decodeQuestionSetManifest(questionSet) ?? await getLegacyDbQuestionsByQuestionSetId(questionSet.id);
}

async function getDbQuestionsForGameSession(gameSession: DbGameSession, questionSet?: DbQuestionSet) {
  let resolvedQuestionSet = questionSet;
  if (!resolvedQuestionSet) {
    const { data, error } = await d1
      .from("question_sets")
      .select("*")
      .eq("id", gameSession.question_set_id)
      .maybeSingle<DbQuestionSet>();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("本局题库不存在。");
    resolvedQuestionSet = data;
  }
  if (resolvedQuestionSet.id !== gameSession.question_set_id) throw new Error("本局抽题快照与题库不匹配。");

  const allQuestions = await getDbQuestionsForQuestionSet(resolvedQuestionSet);
  const selectedQuestionIds = normalizeSelectedQuestionIds(gameSession.selected_question_ids);
  if (selectedQuestionIds.length === 0) return allQuestions;
  const questionById = new Map(allQuestions.map((question) => [question.id, question]));
  return selectedQuestionIds.map((questionId, orderIndex) => {
    const question = questionById.get(questionId);
    if (!question) throw new Error("本局抽题快照引用了不存在的题目。");
    return { ...question, order_index: orderIndex };
  });
}

async function getDbGameSessionById(gameSessionId: string) {
  const { data, error } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", gameSessionId)
    .maybeSingle<DbGameSession>();
  if (error) throw new Error(error.message);
  return data;
}

async function getDbQuestionsByQuestionSetId(questionSetId: string) {
  assertD1Env();
  const { data: questionSet, error } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", questionSetId)
    .maybeSingle<DbQuestionSet>();

  if (error) throw new Error(error.message);
  if (!questionSet) return [];
  return await getDbQuestionsForQuestionSet(questionSet);
}

export async function getQuestionsByQuestionSetId(questionSetId: string) {
  const questions = await getDbQuestionsByQuestionSetId(questionSetId);
  return questions.map(toQuestion);
}

async function getQuestionsForGameSession(gameSession: DbGameSession) {
  return (await getDbQuestionsForGameSession(gameSession)).map(toQuestion);
}

async function getQuestionSetForGameSession(gameSession: DbGameSession) {
  const { data: questionSet, error } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", gameSession.question_set_id)
    .maybeSingle<DbQuestionSet>();
  if (error) throw new Error(error.message);
  if (!questionSet) return null;
  const questions = await getDbQuestionsForGameSession(gameSession, questionSet);
  return toGameQuestionSet(questionSet, questions);
}

export async function confirmRevealBlocks(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  selectedBlocks: number[];
  revealBlockCount?: number;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("打开方块失败：当前游戏不存在，或你不是出题人。");
  }

  const roundStartedAt = currentGameSession.round_started_at;
  if (roundStartedAt) {
    throw new Error("本轮尚未结算，请先判定答案或点击进入下一轮。");
  }

  const allGuessersCorrect = await areAllGuessersCorrectForQuestion({
    roomId: currentGameSession.room_id,
    gameSessionId: currentGameSession.id,
    questionIndex: currentGameSession.current_question_index,
    presenterPlayerId: currentGameSession.presenter_player_id,
  });

  if (allGuessersCorrect) {
    return revealQuestionForReview(currentGameSession.id);
  }

  const revealedBlocks = toGameSession(currentGameSession).revealedBlocks;
  const revealBlockCount = normalizeRevealBlockCount(params.revealBlockCount);
  const selectedBlocks = params.selectedBlocks.filter(
    (block) => Number.isInteger(block) && block >= 0 && block < REVEAL_BLOCK_COUNT,
  );
  const nextBlocks = Array.from(new Set([...revealedBlocks, ...selectedBlocks])).sort((a, b) => a - b);

  if (nextBlocks.length === revealedBlocks.length) {
    throw new Error("请至少选择一个尚未打开的方块。");
  }

  const { data: updatedGameSession, error } = await d1
    .from("game_sessions")
    .update({
      revealed_blocks:
        getVisibleRevealedBlockCount(nextBlocks, revealBlockCount) >= revealBlockCount ? ALL_REVEALED_BLOCKS : nextBlocks,
      round_started_at: new Date().toISOString(),
    })
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .select()
    .maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!updatedGameSession) {
    throw new Error("打开方块失败：游戏状态已变化，请刷新后重试。");
  }

  return toGameSession(updatedGameSession);
}

export async function getAnswersForQuestionRound(params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .eq("reveal_round", params.revealRound)
    .order("submitted_at", { ascending: true })
    .returns<DbAnswer[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toAnswer);
}

export async function getAnswersForQuestion(params: {
  gameSessionId: string;
  questionIndex: number;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .order("submitted_at", { ascending: true })
    .returns<DbAnswer[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toAnswer);
}

export async function getAnswerForPlayerRound(params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
  playerId: string;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .eq("reveal_round", params.revealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  return data ? toAnswer(data) : null;
}

export async function getBuzzerAnswersForQuestionRound(params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("buzzer_answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .eq("reveal_round", params.revealRound)
    .order("submitted_at", { ascending: true })
    .returns<DbBuzzerAnswer[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toBuzzerAnswer);
}

export async function getBuzzerAnswersForQuestion(params: {
  gameSessionId: string;
  questionIndex: number;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("buzzer_answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .order("submitted_at", { ascending: true })
    .returns<DbBuzzerAnswer[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toBuzzerAnswer);
}

export async function getBuzzerAnswerForPlayerRound(params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
  playerId: string;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("buzzer_answers")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .eq("reveal_round", params.revealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbBuzzerAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  return data ? toBuzzerAnswer(data) : null;
}

export async function getRoundSnapshot(gameSessionId: string): Promise<RoundSnapshot> {
  assertD1Env();

  const gameSession = await getGameSessionById(gameSessionId);

  if (!gameSession) {
    throw new Error("刷新游戏快照失败：当前游戏不存在。");
  }

  const questionIndex = gameSession.currentQuestionIndex;
  const revealRound = gameSession.currentRevealRound;
  const [
    { data: scores, error: scoresError },
    { data: questionResults, error: questionResultsError },
    { data: currentRoundAnswers, error: currentRoundAnswersError },
    { data: questionAnswers, error: questionAnswersError },
    { data: currentRoundBuzzerAnswers, error: currentRoundBuzzerAnswersError },
    { data: questionBuzzerAnswers, error: questionBuzzerAnswersError },
    roomPlayers,
  ] = await Promise.all([
    d1
      .from("player_scores")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .order("score", { ascending: false })
      .returns<DbPlayerScore[]>(),
    d1
      .from("question_results")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", questionIndex)
      .returns<DbQuestionResult[]>(),
    d1
      .from("answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", questionIndex)
      .eq("reveal_round", revealRound)
      .order("submitted_at", { ascending: true })
      .returns<DbAnswer[]>(),
    d1
      .from("answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", questionIndex)
      .order("submitted_at", { ascending: true })
      .returns<DbAnswer[]>(),
    d1
      .from("buzzer_answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", questionIndex)
      .eq("reveal_round", revealRound)
      .order("submitted_at", { ascending: true })
      .returns<DbBuzzerAnswer[]>(),
    d1
      .from("buzzer_answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", questionIndex)
      .order("submitted_at", { ascending: true })
      .returns<DbBuzzerAnswer[]>(),
    getDbPlayersByRoomId(gameSession.roomId),
  ]);

  if (scoresError) {
    throw new Error(scoresError.message);
  }
  if (questionResultsError) {
    throw new Error(questionResultsError.message);
  }
  if (currentRoundAnswersError) {
    throw new Error(currentRoundAnswersError.message);
  }
  if (questionAnswersError) {
    throw new Error(questionAnswersError.message);
  }
  if (currentRoundBuzzerAnswersError) {
    throw new Error(currentRoundBuzzerAnswersError.message);
  }
  if (questionBuzzerAnswersError) {
    throw new Error(questionBuzzerAnswersError.message);
  }
  const activeRoomGamePlayerSet = new Set(roomPlayers.filter(isGamePlayer).map((player) => player.id));
  const activeEligiblePlayerSet = new Set(
    (gameSession.eligiblePlayerIds ?? []).filter((playerId) => activeRoomGamePlayerSet.has(playerId)),
  );
  const activeCurrentRoundAnswers = (currentRoundAnswers ?? []).filter((answer) => activeEligiblePlayerSet.has(answer.player_id));
  const activeCurrentRoundBuzzerAnswers = (currentRoundBuzzerAnswers ?? []).filter((answer) =>
    activeEligiblePlayerSet.has(answer.player_id),
  );
  const correctQuestionResults = questionResults ?? [];

  return {
    gameSession,
    scores: (scores ?? []).map(toPlayerScore),
    questionResults: (questionResults ?? []).map(toQuestionResult),
    answers: activeCurrentRoundAnswers.map(toAnswer),
    labelAnswers: getCorrectAnswersForLabel(questionAnswers ?? [], correctQuestionResults).map(toAnswer),
    buzzerAnswers: activeCurrentRoundBuzzerAnswers.map(toBuzzerAnswer),
    labelBuzzerAnswers: getCorrectAnswersForLabel(
      (questionBuzzerAnswers ?? []).filter((answer) => answer.status === "correct"),
      correctQuestionResults,
    ).map(toBuzzerAnswer),
  };
}

export async function getGameBootstrapSnapshot(gameSessionId: string): Promise<GameBootstrapSnapshot> {
  assertD1Env();

  const dbGameSession = await getDbGameSessionById(gameSessionId);
  if (!dbGameSession) {
    throw new Error("加载游戏快照失败：当前游戏不存在。");
  }
  const gameSession = await hydrateGameSessionEligibility(toGameSession(dbGameSession));
  const [questions, roundSnapshot] = await Promise.all([
    getQuestionsForGameSession(dbGameSession),
    getRoundSnapshot(gameSession.id),
  ]);

  return {
    gameSession,
    questions,
    roundSnapshot,
  };
}

export async function getPlayerScores(gameSessionId: string) {
  assertD1Env();

  const { data, error } = await d1
    .from("player_scores")
    .select("*")
    .eq("game_session_id", gameSessionId)
    .order("score", { ascending: false })
    .returns<DbPlayerScore[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toPlayerScore);
}

export async function getLeaderboardForGameSession(gameSessionId: string): Promise<LeaderboardEntry[]> {
  assertD1Env();

  const gameSession = await getGameSessionById(gameSessionId);

  if (!gameSession) {
    throw new Error("排行榜加载失败：游戏不存在。");
  }

  const [participants, scores] = await Promise.all([
    getGameParticipantSnapshot(gameSession),
    getPlayerScores(gameSessionId),
  ]);

  const scoreByPlayerId = new Map(scores.map((score) => [score.playerId, score]));

  let previousScore: number | null = null;
  let previousRank = 0;

  return participants
    .filter((participant) => participant.role !== "SPECTATOR" && participant.player_id !== gameSession.presenterPlayerId)
    .map((participant) => {
      const score = scoreByPlayerId.get(participant.player_id);

      return {
        playerId: participant.player_id,
        nickname: participant.nickname,
        rank: 0,
        score: score?.score ?? 0,
        correctCount: score?.correctCount ?? 0,
      };
    })
    .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount || a.nickname.localeCompare(b.nickname))
    .map((entry, index) => {
      const rank = entry.score === previousScore ? previousRank : index + 1;
      previousScore = entry.score;
      previousRank = rank;

      return {
        ...entry,
        rank,
      };
    });
}

export async function getGameResultSnapshot(gameSessionId: string): Promise<GameResultSnapshot> {
  assertD1Env();

  const dbGameSession = await getDbGameSessionById(gameSessionId);
  if (!dbGameSession) {
    throw new Error("加载结算快照失败：游戏不存在。");
  }
  const gameSession = await hydrateGameSessionEligibility(toGameSession(dbGameSession));

  if (gameSession.status === "GAME_RESULT" && gameSession.completedNormallyAt) {
    await recordCompletedQuestionSetPlay({
      gameSessionId: gameSession.id,
      questionSetId: gameSession.questionSetId,
      completedAt: gameSession.completedNormallyAt,
    });
  }

  const [archive, questionSet] = await Promise.all([
    getGameResultArchive(gameSession.id),
    getQuestionSetForGameSession(dbGameSession),
  ]);

  if (archive) {
    return {
      gameSession,
      leaderboard: archive.leaderboard,
      questionSet,
      questionScores: archive.questionScores,
    };
  }

  const [leaderboard, questionResults] = await Promise.all([
    getLeaderboardForGameSession(gameSession.id),
    getQuestionResultsForGameSession(gameSession.id),
  ]);

  return {
    gameSession,
    leaderboard,
    questionSet,
    questionScores: toGameResultQuestionScores(questionResults),
  };
}

export async function getArchivedGameResultSnapshot(gameSessionId: string): Promise<GameResultSnapshot | null> {
  assertD1Env();
  const dbGameSession = await getDbGameSessionById(gameSessionId);
  if (!dbGameSession) return null;
  const gameSession = await hydrateGameSessionEligibility(toGameSession(dbGameSession));
  const archive = await getGameResultArchive(gameSession.id);
  if (!archive) return null;
  const questionSet = await getQuestionSetForGameSession(dbGameSession);
  return {
    gameSession,
    leaderboard: archive.leaderboard,
    questionSet,
    questionScores: archive.questionScores,
  };
}

export async function publishQuestionSetToCommunity(params: {
  questionSetId: string;
  playerId: string;
  title: string;
  description?: string;
  creationMethod: QuestionSetCreationMethod;
}) {
  assertD1Env();

  const title = params.title.trim();

  if (!title) {
    throw new Error("发布社区题库前，请先输入题库标题。");
  }

  const creationMethod = normalizeQuestionSetCreationMethod(params.creationMethod);
  if (!creationMethod) {
    throw new Error("发布社区题库前，请选择出题方式。");
  }

  const createdByNickname = await getPlayerNickname(params.playerId);

  const { data: questionSet, error } = await d1
    .from("question_sets")
    .update({
      title,
      description: params.description?.trim() || null,
      created_by_nickname: createdByNickname ?? undefined,
      creation_method: creationMethod,
      is_public: true,
    })
    .eq("id", params.questionSetId)
    .eq("created_by_player_id", params.playerId)
    .select()
    .maybeSingle<DbQuestionSet>();

  if (error) {
    throw new Error(error.message);
  }

  if (!questionSet) {
    throw new Error("发布失败：题库不存在，或你不是题库创建者。");
  }

  const questions = await getDbQuestionsForQuestionSet(questionSet);
  return toQuestionSet(questionSet, questions);
}

export async function rateCommunityQuestionSet(params: {
  questionSetId: string;
  playerId: string;
  rating: number;
  roomId: string;
}) {
  assertD1Env();

  const rating = Math.max(1, Math.min(5, Math.floor(params.rating)));

  if (!params.roomId) {
    throw new Error("评分失败：缺少房间信息。");
  }

  await assertGamePlayerInRoom(params.roomId, params.playerId);

  const { data: questionSet, error: questionSetError } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", params.questionSetId)
    .eq("is_public", true)
    .maybeSingle<DbQuestionSet>();

  if (questionSetError) {
    throw new Error(questionSetError.message);
  }

  if (!questionSet) {
    throw new Error("评分失败：该社区题库不存在或尚未公开。");
  }

  const { error: ratingError } = await d1.from("question_set_ratings").upsert(
    {
      question_set_id: params.questionSetId,
      player_id: params.playerId,
      rating,
    },
    { onConflict: "question_set_id,player_id" },
  );

  if (ratingError) {
    throw new Error(ratingError.message);
  }

  const { data: ratings, error: ratingsLoadError } = await d1
    .from("question_set_ratings")
    .select("rating")
    .eq("question_set_id", params.questionSetId)
    .returns<{ rating: number }[]>();

  if (ratingsLoadError) {
    throw new Error(ratingsLoadError.message);
  }

  const ratingCount = ratings?.length ?? 0;
  const ratingAvg =
    ratingCount > 0
      ? Math.round((ratings ?? []).reduce((total, item) => total + item.rating, 0) * 100 / ratingCount) / 100
      : 0;

  const { data: updatedQuestionSet, error: updateError } = await d1
    .from("question_sets")
    .update({
      rating_avg: ratingAvg,
      rating_count: ratingCount,
    })
    .eq("id", params.questionSetId)
    .select()
    .single<DbQuestionSet>();

  if (updateError) {
    throw new Error(updateError.message);
  }

  const questions = await getDbQuestionsForQuestionSet(updatedQuestionSet);
  return toQuestionSet(updatedQuestionSet, questions);
}

export async function getQuestionSetRatingProgress(params: {
  questionSetId: string;
  playerIds: string[];
  playerId?: string;
}) {
  assertD1Env();

  const playerIds = Array.from(new Set(params.playerIds.filter((id) => typeof id === "string" && id.trim())));

  if (playerIds.length === 0) {
    return {
      ratedCount: 0,
      totalCount: 0,
      ratedPlayerIds: [],
      playerRating: null,
    };
  }

  const { data: ratings, error } = await d1
    .from("question_set_ratings")
    .select("player_id,rating")
    .eq("question_set_id", params.questionSetId)
    .returns<{ player_id: string; rating: number }[]>();

  if (error) {
    throw new Error(error.message);
  }

  const playerIdSet = new Set(playerIds);
  const roomRatings = (ratings ?? []).filter((rating) => playerIdSet.has(rating.player_id));
  const ratedPlayerIds = roomRatings.map((rating) => rating.player_id);
  const playerRating = roomRatings.find((rating) => rating.player_id === params.playerId)?.rating ?? null;

  return {
    ratedCount: ratedPlayerIds.length,
    totalCount: playerIds.length,
    ratedPlayerIds,
    playerRating,
  };
}

export async function getQuestionResultsForQuestion(params: {
  gameSessionId: string;
  questionIndex: number;
}) {
  assertD1Env();

  const { data, error } = await d1
    .from("question_results")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("question_index", params.questionIndex)
    .returns<DbQuestionResult[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toQuestionResult);
}

export async function getQuestionResultsForGameSession(gameSessionId: string) {
  assertD1Env();

  const { data, error } = await d1
    .from("question_results")
    .select("*")
    .eq("game_session_id", gameSessionId)
    .returns<DbQuestionResult[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(toQuestionResult);
}

async function adjustPlayerScore(params: {
  gameSessionId: string;
  playerId: string;
  scoreDelta: number;
  correctCountDelta?: number;
}) {
  const correctCountDelta = params.correctCountDelta ?? 0;

  if (params.scoreDelta === 0 && correctCountDelta === 0) {
    return;
  }

  const { data: existingScore, error: scoreLoadError } = await d1
    .from("player_scores")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .eq("player_id", params.playerId)
    .maybeSingle<DbPlayerScore>();

  if (scoreLoadError) {
    throw new Error(scoreLoadError.message);
  }

  const { error: scoreError } = await d1.from("player_scores").upsert(
    {
      id: existingScore?.id,
      game_session_id: params.gameSessionId,
      player_id: params.playerId,
      score: Math.max(0, (existingScore?.score ?? 0) + params.scoreDelta),
      correct_count: Math.max(0, (existingScore?.correct_count ?? 0) + correctCountDelta),
    },
    {
      onConflict: "game_session_id,player_id",
    },
  );

  if (scoreError) {
    throw new Error(scoreError.message);
  }
}

async function addScoreToPlayer(params: {
  gameSessionId: string;
  playerId: string;
  scoreAwarded: number;
}) {
  await adjustPlayerScore({
    gameSessionId: params.gameSessionId,
    playerId: params.playerId,
    scoreDelta: params.scoreAwarded,
    correctCountDelta: 1,
  });
}

async function insertQuestionResultsForPlayers(params: {
  gameSessionId: string;
  questionIndex: number;
  playerIds: string[];
  scoredRound: number;
  scoreAwarded: number;
  judgedByPlayerId: string;
}) {
  const uniquePlayerIds = Array.from(new Set(params.playerIds)).filter(Boolean);
  if (uniquePlayerIds.length === 0) {
    return [];
  }

  const { data, error } = await d1
    .from("question_results")
    .insert(
      uniquePlayerIds.map((playerId) => ({
        game_session_id: params.gameSessionId,
        question_index: params.questionIndex,
        player_id: playerId,
        scored_round: params.scoredRound,
        score_awarded: params.scoreAwarded,
        judged_by_player_id: params.judgedByPlayerId,
      })),
      {
        onConflict: "game_session_id,question_index,player_id",
        ignoreDuplicates: true,
      },
    )
    .select("player_id")
    .returns<{ player_id: string }[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((result) => result.player_id);
}

async function bulkAddScoresToPlayers(params: {
  gameSessionId: string;
  playerIds: string[];
  scoreAwarded: number;
}) {
  const uniquePlayerIds = Array.from(new Set(params.playerIds)).filter(Boolean);
  if (uniquePlayerIds.length === 0) {
    return;
  }

  const { data: sessionScores, error: scoreLoadError } = await d1
    .from("player_scores")
    .select("*")
    .eq("game_session_id", params.gameSessionId)
    .returns<DbPlayerScore[]>();

  if (scoreLoadError) {
    throw new Error(scoreLoadError.message);
  }

  const scoreByPlayerId = new Map((sessionScores ?? []).map((score) => [score.player_id, score]));
  const upsertRows = uniquePlayerIds.map((playerId) => {
    const existingScore = scoreByPlayerId.get(playerId);

    return {
      game_session_id: params.gameSessionId,
      player_id: playerId,
      score: (existingScore?.score ?? 0) + params.scoreAwarded,
      correct_count: (existingScore?.correct_count ?? 0) + 1,
    };
  });

  const { error: scoreError } = await d1.from("player_scores").upsert(upsertRows, {
    onConflict: "game_session_id,player_id",
  });

  if (scoreError) {
    throw new Error(scoreError.message);
  }
}

async function recalculateRankedBuzzerScores(params: {
  gameSession: DbGameSession;
}) {
  const [guesserIds, { data: results, error: resultsError }, { data: correctBuzzerAnswers, error: answersError }] =
    await Promise.all([
      getOrCreateQuestionEligiblePlayerIds({
        gameSessionId: params.gameSession.id,
        roomId: params.gameSession.room_id,
        questionIndex: params.gameSession.current_question_index,
        presenterPlayerId: params.gameSession.presenter_player_id,
      }),
      d1
        .from("question_results")
        .select("*")
        .eq("game_session_id", params.gameSession.id)
        .eq("question_index", params.gameSession.current_question_index)
        .returns<DbQuestionResult[]>(),
      d1
        .from("buzzer_answers")
        .select("*")
        .eq("game_session_id", params.gameSession.id)
        .eq("question_index", params.gameSession.current_question_index)
        .eq("status", "correct")
        .returns<DbBuzzerAnswer[]>(),
    ]);

  if (resultsError) {
    throw new Error(resultsError.message);
  }

  if (answersError) {
    throw new Error(answersError.message);
  }

  const guesserCount = guesserIds.length;
  const answerByPlayerId = new Map((correctBuzzerAnswers ?? []).map((answer) => [answer.player_id, answer]));
  const rankedResults = (results ?? [])
    .map((result) => ({ result, answer: answerByPlayerId.get(result.player_id) }))
    .filter((item): item is { result: DbQuestionResult; answer: DbBuzzerAnswer } => Boolean(item.answer))
    .sort(
      (a, b) =>
        compareRankedAnswerOrder(a.answer, b.answer) ||
        new Date(a.result.judged_at).getTime() - new Date(b.result.judged_at).getTime() ||
        a.result.id.localeCompare(b.result.id),
    );
  const scoreByPlayerId = new Map<string, number>();

  for (const [index, item] of rankedResults.entries()) {
    const nextScoreAwarded = Math.max(1, guesserCount - index);
    scoreByPlayerId.set(item.result.player_id, nextScoreAwarded);

    if (item.result.score_awarded !== nextScoreAwarded) {
      await adjustPlayerScore({
        gameSessionId: params.gameSession.id,
        playerId: item.result.player_id,
        scoreDelta: nextScoreAwarded - item.result.score_awarded,
      });

      const { error: resultUpdateError } = await d1
        .from("question_results")
        .update({ score_awarded: nextScoreAwarded })
        .eq("id", item.result.id);

      if (resultUpdateError) {
        throw new Error(resultUpdateError.message);
      }
    }

    if (item.answer.score_awarded !== nextScoreAwarded) {
      const { error: answerUpdateError } = await d1
        .from("buzzer_answers")
        .update({ score_awarded: nextScoreAwarded })
        .eq("id", item.answer.id);

      if (answerUpdateError) {
        throw new Error(answerUpdateError.message);
      }
    }
  }

  return scoreByPlayerId;
}

async function recalculatePlayerScoresFromResults(gameSessionId: string) {
  const [{ data: results, error: resultsError }, { data: existingScores, error: scoresError }] = await Promise.all([
    d1
      .from("question_results")
      .select("*")
      .eq("game_session_id", gameSessionId)
      .returns<DbQuestionResult[]>(),
    d1
      .from("player_scores")
      .select("*")
      .eq("game_session_id", gameSessionId)
      .returns<DbPlayerScore[]>(),
  ]);

  if (resultsError) {
    throw new Error(resultsError.message);
  }
  if (scoresError) {
    throw new Error(scoresError.message);
  }

  const totalsByPlayerId = new Map<string, { score: number; correctCount: number }>();
  for (const result of results ?? []) {
    const current = totalsByPlayerId.get(result.player_id) ?? { score: 0, correctCount: 0 };
    current.score += result.score_awarded;
    current.correctCount += 1;
    totalsByPlayerId.set(result.player_id, current);
  }

  const currentScoreByPlayerId = new Map((existingScores ?? []).map((score) => [score.player_id, score]));
  const playerIds = new Set([...currentScoreByPlayerId.keys(), ...totalsByPlayerId.keys()]);
  if (playerIds.size > 0) {
    const { error } = await d1.from("player_scores").upsert(
      [...playerIds].map((playerId) => {
        const current = currentScoreByPlayerId.get(playerId);
        const totals = totalsByPlayerId.get(playerId) ?? { score: 0, correctCount: 0 };
        return {
          id: current?.id,
          game_session_id: gameSessionId,
          player_id: playerId,
          score: totals.score,
          correct_count: totals.correctCount,
        };
      }),
      { onConflict: "game_session_id,player_id" },
    );

    if (error) {
      throw new Error(error.message);
    }
  }

  return await getPlayerScores(gameSessionId);
}

async function updatePendingBuzzerAnswer(params: {
  id: string;
  answerText: string;
  submittedAt?: string;
  serverReceivedAt?: string;
}) {
  const { data, error } = await d1
    .from("buzzer_answers")
    .update({
      answer_text: params.answerText,
      status: "pending",
      score_awarded: 0,
      submitted_at: params.submittedAt ?? new Date().toISOString(),
      server_received_at: params.serverReceivedAt ?? new Date().toISOString(),
      judged_at: null,
      judged_by_player_id: null,
    })
    .eq("id", params.id)
    .eq("status", "pending")
    .select()
    .maybeSingle<DbBuzzerAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("更新答案失败：该答案已经被判定，不能再修改。");
  }

  return toBuzzerAnswer(data);
}

async function writePendingRoundRevealBuzzerAnswer(params: {
  gameSession: GameSession;
  playerId: string;
  answerText: string;
  existingBuzzerAnswer: DbBuzzerAnswer | null;
  submittedAt: string;
  serverReceivedAt: string;
}) {
  if (params.existingBuzzerAnswer) {
    if (params.existingBuzzerAnswer.status !== "pending") {
      throw new Error("该抢答已经被判定，不能再修改。");
    }

    return await updatePendingBuzzerAnswer({
      id: params.existingBuzzerAnswer.id,
      answerText: params.answerText,
      submittedAt: params.submittedAt,
      serverReceivedAt: params.serverReceivedAt,
    });
  }

  const { data, error } = await d1
    .from("buzzer_answers")
    .insert({
      game_session_id: params.gameSession.id,
      question_index: params.gameSession.currentQuestionIndex,
      reveal_round: params.gameSession.currentRevealRound,
      player_id: params.playerId,
      answer_text: params.answerText,
      status: "pending",
      score_awarded: 0,
      submitted_at: params.submittedAt,
      server_received_at: params.serverReceivedAt,
      judged_at: null,
      judged_by_player_id: null,
    })
    .select()
    .single<DbBuzzerAnswer>();

  if (!error) {
    return toBuzzerAnswer(data);
  }

  if (!isUniqueViolation(error)) {
    throw new Error(error.message);
  }

  const { data: currentBuzzerAnswer, error: currentError } = await d1
    .from("buzzer_answers")
    .select("*")
    .eq("game_session_id", params.gameSession.id)
    .eq("question_index", params.gameSession.currentQuestionIndex)
    .eq("reveal_round", params.gameSession.currentRevealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbBuzzerAnswer>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentBuzzerAnswer || currentBuzzerAnswer.status !== "pending") {
    throw new Error("提交失败：该抢答已经被判定，不能再修改。");
  }

  return await updatePendingBuzzerAnswer({
    id: currentBuzzerAnswer.id,
    answerText: params.answerText,
    submittedAt: params.submittedAt,
    serverReceivedAt: params.serverReceivedAt,
  });
}

async function revealQuestionForReview(gameSessionId: string) {
  const { data: reviewedGameSession, error } = await d1
    .from("game_sessions")
    .update({
      revealed_blocks: ALL_REVEALED_BLOCKS,
      round_started_at: null,
    })
    .eq("id", gameSessionId)
    .select()
    .single<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  return toGameSession(reviewedGameSession);
}

async function forfeitMissingRoundActions(
  currentGameSession: DbGameSession,
  currentSession: GameSession,
  roundActionState?: Awaited<ReturnType<typeof getRoundActionState>>,
) {
  const resolvedRoundActionState = roundActionState ?? await getRoundActionState(currentSession);
  const now = new Date().toISOString();
  const missingGuesserIds = resolvedRoundActionState.eligibleGuesserIds.filter(
    (guesserId) => !resolvedRoundActionState.hasPlayerActed(guesserId),
  );

  if (missingGuesserIds.length === 0) {
    return 0;
  }

  const { error } = await d1.from("answers").insert(
    missingGuesserIds.map((guesserId) => ({
      game_session_id: currentGameSession.id,
      question_index: currentGameSession.current_question_index,
      reveal_round: currentGameSession.current_reveal_round,
      player_id: guesserId,
      answer_text: FORFEIT_ANSWER_TEXT,
      submitted_at: now,
    })),
    {
      onConflict: "game_session_id,question_index,reveal_round,player_id",
      ignoreDuplicates: true,
    },
  );

  if (error) {
    throw new Error(error.message);
  }

  return missingGuesserIds.length;
}

async function settleRevealRoundForNextSelection(currentGameSession: DbGameSession) {
  const maxRevealRounds = currentGameSession.max_reveal_rounds ?? 3;

  const { data: updatedGameSession, error } = await d1
    .from("game_sessions")
    .update({
      current_reveal_round: Math.min(maxRevealRounds, currentGameSession.current_reveal_round + 1),
      round_started_at: null,
    })
    .eq("id", currentGameSession.id)
    .select()
    .single<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  return toGameSession(updatedGameSession);
}

async function settleBuzzerRoundFromDb(currentGameSession: DbGameSession, receivedAtMs = Date.now()) {
  const currentSession = toGameSession(currentGameSession);
  const currentRound = currentGameSession.current_reveal_round;
  const roundEnded = hasRoundForfeitDeadlineArrived(currentSession, receivedAtMs);

  let roundActionState = await getRoundActionState(currentSession);

  if (roundEnded) {
    if (await forfeitMissingRoundActions(currentGameSession, currentSession, roundActionState)) {
      roundActionState = await getRoundActionState(currentSession);
    }
  }

  const hasCorrectAnswer = roundActionState.correctSet.size > 0;
  const allPlayersCorrect =
    roundActionState.guesserIds.length > 0 &&
    roundActionState.guesserIds.every((guesserId) => roundActionState.correctSet.has(guesserId));

  if (allPlayersCorrect || (currentSession.gameMode === "BUZZER_FIRST_CORRECT" && hasCorrectAnswer)) {
    return revealQuestionForReview(currentGameSession.id);
  }

  if (roundActionState.hasPendingAnswers) {
    return currentSession;
  }

  const canSettleBecauseAllChancesUsed = roundActionState.allEligiblePlayersUsedChance;

  if (roundEnded || canSettleBecauseAllChancesUsed) {
    if (currentRound >= currentSession.maxRevealRounds) {
      return revealQuestionForReview(currentGameSession.id);
    }

    return settleRevealRoundForNextSelection(currentGameSession);
  }

  return currentSession;
}

export async function autoForfeitExpiredRound(params: {
  gameSessionId: string;
} & ServerTimedActionParams) {
  assertD1Env();

  const { data: currentGameSession, error } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!currentGameSession) {
    throw new Error("自动放弃失败：当前游戏不存在或已结束。");
  }

  const currentSession = toGameSession(currentGameSession);
  if (!canUseForfeitAnswer(currentSession.gameMode)) {
    return { gameSession: currentSession };
  }

  if (!currentSession.roundStartedAt) {
    return { gameSession: currentSession };
  }

  if (!hasRoundForfeitDeadlineArrived(currentSession, getServerReceivedAtMs(params))) {
    return { gameSession: currentSession };
  }

  await forfeitMissingRoundActions(currentGameSession, currentSession);

  return { gameSession: currentSession };
}

export async function submitAnswer(params: {
  gameSessionId: string;
  playerId: string;
  answerText: string;
} & ServerTimedActionParams) {
  assertD1Env();

  const answerText = params.answerText.trim();

  if (!answerText) {
    throw new Error("请先输入答案。");
  }

  const gameSession = await getGameSessionById(params.gameSessionId);

  if (gameSession?.gameMode !== "ROUND_REVEAL") {
    throw new Error("当前模式不能提交普通答案。");
  }

  if (!gameSession || gameSession.status !== "PLAYING") {
    throw new Error("当前游戏未进行中，不能提交答案。");
  }

  if (gameSession.presenterPlayerId === params.playerId) {
    throw new Error("出题人不能提交答案。");
  }

  await assertGamePlayerInRoom(gameSession.roomId, params.playerId);
  await assertPlayerEligibleForCurrentQuestion(gameSession, params.playerId);

  if (!gameSession.roundStartedAt) {
    throw new Error("本轮尚未开始，暂时不能提交答案。");
  }

  if (hasRoundAcceptWindowExpired(gameSession, getServerReceivedAtMs(params))) {
    throw new Error("本轮答题时间已结束，不能再提交答案。");
  }

  const { data: existingResult, error: resultError } = await d1
    .from("question_results")
    .select("id")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("player_id", params.playerId)
    .maybeSingle<{ id: string }>();

  if (resultError) {
    throw new Error(resultError.message);
  }

  if (existingResult) {
    throw new Error("你已答对本题，不能重复提交答案。");
  }

  const roundActionState = await getRoundActionState(gameSession);
  if (roundActionState.allEligiblePlayersUsedChance) {
    throw new Error("本轮所有玩家都已提交，不能再修改答案。");
  }

  const [{ data: existingAnswer, error: answerLoadError }, { data: existingBuzzerAnswer, error: buzzerLoadError }] =
    await Promise.all([
      d1
        .from("answers")
        .select("*")
        .eq("game_session_id", gameSession.id)
        .eq("question_index", gameSession.currentQuestionIndex)
        .eq("reveal_round", gameSession.currentRevealRound)
        .eq("player_id", params.playerId)
        .maybeSingle<DbAnswer>(),
      d1
        .from("buzzer_answers")
        .select("*")
        .eq("game_session_id", gameSession.id)
        .eq("question_index", gameSession.currentQuestionIndex)
        .eq("reveal_round", gameSession.currentRevealRound)
        .eq("player_id", params.playerId)
        .maybeSingle<DbBuzzerAnswer>(),
    ]);

  if (answerLoadError) {
    throw new Error(answerLoadError.message);
  }

  if (buzzerLoadError) {
    throw new Error(buzzerLoadError.message);
  }

  const serverReceivedAt = new Date(getServerReceivedAtMs(params)).toISOString();
  const submittedAt = serverReceivedAt;
  const buzzerAnswer = await writePendingRoundRevealBuzzerAnswer({
    gameSession,
    playerId: params.playerId,
    answerText,
    existingBuzzerAnswer,
    submittedAt,
    serverReceivedAt,
  });

  const { data, error } = await d1
    .from("answers")
    .upsert(
      {
        id: existingAnswer?.id,
        game_session_id: gameSession.id,
        question_index: gameSession.currentQuestionIndex,
        reveal_round: gameSession.currentRevealRound,
        player_id: params.playerId,
        answer_text: answerText,
        submitted_at: submittedAt,
      },
      {
        onConflict: "game_session_id,question_index,reveal_round,player_id",
      },
    )
    .select()
    .single<DbAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  return {
    ...toAnswer(data),
    buzzerAnswer,
  };
}

export async function submitForfeitAnswer(params: {
  gameSessionId: string;
  playerId: string;
} & ServerTimedActionParams) {
  assertD1Env();

  const gameSession = await getGameSessionById(params.gameSessionId);

  if (!gameSession || gameSession.status !== "PLAYING" || !canUseForfeitAnswer(gameSession.gameMode)) {
    throw new Error("当前不能放弃作答：游戏未进行中，或当前模式不支持放弃作答。");
  }

  if (gameSession.presenterPlayerId === params.playerId || !gameSession.roundStartedAt) {
    throw new Error("当前不能放弃作答：出题人不能作答，或本轮尚未开始。");
  }

  await assertGamePlayerInRoom(gameSession.roomId, params.playerId);
  await assertPlayerEligibleForCurrentQuestion(gameSession, params.playerId);

  if (hasRoundAcceptWindowExpired(gameSession, getServerReceivedAtMs(params))) {
    throw new Error("本轮答题时间已结束，不能再放弃作答。");
  }

  const roundActionState = await getRoundActionState(gameSession);
  if (roundActionState.allEligiblePlayersUsedChance) {
    throw new Error("本轮所有玩家都已提交，不能再改为放弃作答。");
  }

  const { data: existingResult, error: resultError } = await d1
    .from("question_results")
    .select("id")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("player_id", params.playerId)
    .maybeSingle<{ id: string }>();

  if (resultError) {
    throw new Error(resultError.message);
  }

  if (existingResult) {
    throw new Error("你已答对本题，不能放弃作答。");
  }

  const { data: existingBuzzerAnswer, error: buzzerLoadError } = await d1
    .from("buzzer_answers")
    .select("*")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("reveal_round", gameSession.currentRevealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbBuzzerAnswer>();

  if (buzzerLoadError) {
    throw new Error(buzzerLoadError.message);
  }

  if (existingBuzzerAnswer && existingBuzzerAnswer.status !== "pending") {
    throw new Error("你的抢答已经被判定，不能改为放弃作答。");
  }

  const { data: existingAnswer, error: answerLoadError } = await d1
    .from("answers")
    .select("*")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("reveal_round", gameSession.currentRevealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbAnswer>();

  if (answerLoadError) {
    throw new Error(answerLoadError.message);
  }

  if (existingBuzzerAnswer) {
    const { data: deletedBuzzerAnswer, error: deleteBuzzerError } = await d1
      .from("buzzer_answers")
      .delete()
      .eq("id", existingBuzzerAnswer.id)
      .eq("status", "pending")
      .single<DbBuzzerAnswer>();

    if (deleteBuzzerError) {
      throw new Error(deleteBuzzerError.message);
    }

    if (!deletedBuzzerAnswer) {
      throw new Error("取消抢答失败：该抢答已经被判定。");
    }
  }

  const { data, error } = await d1
    .from("answers")
    .upsert(
      {
        id: existingAnswer?.id,
        game_session_id: gameSession.id,
        question_index: gameSession.currentQuestionIndex,
        reveal_round: gameSession.currentRevealRound,
        player_id: params.playerId,
        answer_text: FORFEIT_ANSWER_TEXT,
        submitted_at: new Date().toISOString(),
      },
      {
        onConflict: "game_session_id,question_index,reveal_round,player_id",
      },
    )
    .select()
    .single<DbAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  return toAnswer(data);
}

export async function cancelForfeitAnswer(params: {
  gameSessionId: string;
  playerId: string;
} & ServerTimedActionParams) {
  assertD1Env();

  const gameSession = await getGameSessionById(params.gameSessionId);

  if (!gameSession || gameSession.status !== "PLAYING" || !canUseForfeitAnswer(gameSession.gameMode)) {
    throw new Error("当前不能取消放弃：游戏未进行中，或当前模式不支持取消放弃。");
  }

  if (gameSession.presenterPlayerId === params.playerId || !gameSession.roundStartedAt) {
    throw new Error("当前不能取消放弃：出题人不能作答，或本轮尚未开始。");
  }

  await assertGamePlayerInRoom(gameSession.roomId, params.playerId);
  await assertPlayerEligibleForCurrentQuestion(gameSession, params.playerId);

  if (hasRoundAcceptWindowExpired(gameSession, getServerReceivedAtMs(params))) {
    throw new Error("本轮答题时间已结束，不能再取消放弃。");
  }

  const roundActionState = await getRoundActionState(gameSession);
  if (roundActionState.allEligiblePlayersUsedChance) {
    throw new Error("本轮所有玩家都已提交，不能再取消放弃。");
  }

  const { data: existingAnswer, error: answerLoadError } = await d1
    .from("answers")
    .select("*")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("reveal_round", gameSession.currentRevealRound)
    .eq("player_id", params.playerId)
    .maybeSingle<DbAnswer>();

  if (answerLoadError) {
    throw new Error(answerLoadError.message);
  }

  if (!existingAnswer || !isForfeitAnswer(existingAnswer)) {
    throw new Error("你当前没有放弃作答记录，不能取消。");
  }

  const { data, error } = await d1
    .from("answers")
    .delete()
    .eq("id", existingAnswer.id)
    .single<DbAnswer>();

  if (error) {
    throw new Error(error.message);
  }

  return {
    gameSession,
    canceledAnswerId: data.id,
  };
}

export async function submitBuzzerAnswer(params: {
  gameSessionId: string;
  playerId: string;
  answerText: string;
  clientRoundElapsedMs?: number | null;
} & ServerTimedActionParams) {
  assertD1Env();

  const answerText = params.answerText.trim();

  if (!answerText) {
    throw new Error("请先输入抢答答案。");
  }

  const gameSession = await getGameSessionById(params.gameSessionId);

  if (!gameSession || gameSession.status !== "PLAYING" || gameSession.gameMode === "ROUND_REVEAL" || gameSession.gameMode === "TEAM_BATTLE") {
    throw new Error("当前模式不能提交抢答答案。");
  }

  if (gameSession.presenterPlayerId === params.playerId) {
    throw new Error("出题人不能提交抢答答案。");
  }

  await assertGamePlayerInRoom(gameSession.roomId, params.playerId);
  await assertPlayerEligibleForCurrentQuestion(gameSession, params.playerId);

  if (!gameSession.roundStartedAt) {
    throw new Error("本轮尚未开始，暂时不能抢答。");
  }

  const roundStartedAtMs = new Date(gameSession.roundStartedAt).getTime();
  const serverReceivedAtMs = getServerReceivedAtMs(params);
  const serverRoundElapsedMs = serverReceivedAtMs - roundStartedAtMs;
  const clientRoundElapsedMs = Number.isFinite(params.clientRoundElapsedMs) ? params.clientRoundElapsedMs : null;
  const canUseClientRoundElapsedMs =
    typeof clientRoundElapsedMs === "number" &&
    clientRoundElapsedMs >= 0 &&
    clientRoundElapsedMs >= serverRoundElapsedMs - BUZZER_CLIENT_TIME_MAX_EARLY_MS &&
    clientRoundElapsedMs <= serverRoundElapsedMs;
  const effectiveRoundElapsedMs = canUseClientRoundElapsedMs ? clientRoundElapsedMs : serverRoundElapsedMs;
  const roundDurationMs = gameSession.roundSeconds * 1000;

  if (serverRoundElapsedMs > roundDurationMs + ROUND_DEADLINE_GRACE_MS) {
    throw new Error("本轮抢答时间已结束，不能再提交。");
  }

  const submittedAt = new Date(roundStartedAtMs + effectiveRoundElapsedMs).toISOString();

  const { data: existingResult, error: resultError } = await d1
    .from("question_results")
    .select("id")
    .eq("game_session_id", gameSession.id)
    .eq("question_index", gameSession.currentQuestionIndex)
    .eq("player_id", params.playerId)
    .maybeSingle<{ id: string }>();

  if (resultError) {
    throw new Error(resultError.message);
  }

  if (existingResult) {
    throw new Error("你已答对本题，不能重复抢答。");
  }

  if (gameSession.gameMode === "BUZZER_FIRST_CORRECT" && await hasCorrectResultForCurrentQuestion(gameSession)) {
    throw new Error("本题已有玩家答对，不能继续抢答。");
  }

  if (canUseForfeitAnswer(gameSession.gameMode)) {
    const { data: existingAnswer, error: answerLoadError } = await d1
      .from("answers")
      .select("*")
      .eq("game_session_id", gameSession.id)
      .eq("question_index", gameSession.currentQuestionIndex)
      .eq("reveal_round", gameSession.currentRevealRound)
      .eq("player_id", params.playerId)
      .maybeSingle<DbAnswer>();

    if (answerLoadError) {
      throw new Error(answerLoadError.message);
    }

    if (existingAnswer && isForfeitAnswer(existingAnswer)) {
      throw new Error("你已放弃本轮，取消放弃后才能抢答。");
    }
  }

  const { data, error } = await d1
    .from("buzzer_answers")
    .insert({
      game_session_id: gameSession.id,
      question_index: gameSession.currentQuestionIndex,
      reveal_round: gameSession.currentRevealRound,
      player_id: params.playerId,
      answer_text: answerText,
      submitted_at: submittedAt,
      server_received_at: new Date(serverReceivedAtMs).toISOString(),
    })
    .select()
    .single<DbBuzzerAnswer>();

  if (error) {
    if (isUniqueViolation(error)) {
      throw new Error("你本轮已经提交过抢答。");
    }

    throw new Error(error.message);
  }

  return toBuzzerAnswer(data);
}

export type AnswerJudgementChange = {
  buzzerAnswerId: string;
  isCorrect: boolean;
};

async function loadCurrentAnswerJudgementContext(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedQuestionIndex: number;
  expectedRevealRound: number;
}) {
  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }
  if (!currentGameSession) {
    throw new Error("判定答案失败：当前游戏不存在，或你不是出题人。");
  }
  if (currentGameSession.game_mode === "TEAM_BATTLE") {
    throw new Error("红蓝对抗模式不能使用回答判定面板。");
  }
  if (
    currentGameSession.current_question_index !== params.expectedQuestionIndex ||
    currentGameSession.current_reveal_round !== params.expectedRevealRound
  ) {
    throw new Error("当前轮次已经变化，请按最新回答重新判定。");
  }

  const currentSession = toGameSession(currentGameSession);
  const [
    eligiblePlayerIds,
    roomPlayers,
    { data: roundAnswers, error: roundAnswersError },
    { data: questionResults, error: resultsError },
  ] = await Promise.all([
    getOrCreateQuestionEligiblePlayerIds({
      gameSessionId: currentGameSession.id,
      roomId: currentGameSession.room_id,
      questionIndex: currentGameSession.current_question_index,
      presenterPlayerId: currentGameSession.presenter_player_id,
      knownEligiblePlayerIds: currentSession.eligiblePlayerIds,
    }),
    getDbPlayersByRoomId(currentGameSession.room_id),
    d1
      .from("buzzer_answers")
      .select("*")
      .eq("game_session_id", currentGameSession.id)
      .eq("question_index", currentGameSession.current_question_index)
      .eq("reveal_round", currentGameSession.current_reveal_round)
      .returns<DbBuzzerAnswer[]>(),
    d1
      .from("question_results")
      .select("*")
      .eq("game_session_id", currentGameSession.id)
      .eq("question_index", currentGameSession.current_question_index)
      .returns<DbQuestionResult[]>(),
  ]);

  if (roundAnswersError) throw new Error(roundAnswersError.message);
  if (resultsError) throw new Error(resultsError.message);

  const activePlayerIds = new Set(roomPlayers.filter(isGamePlayer).map((player) => player.id));
  const questionEligiblePlayerIds = new Set(eligiblePlayerIds.filter((playerId) => activePlayerIds.has(playerId)));
  const priorRoundCorrectPlayerIds = new Set(
    (questionResults ?? [])
      .filter((result) => result.scored_round < currentGameSession.current_reveal_round)
      .map((result) => result.player_id),
  );
  const currentRoundEligiblePlayerIds = new Set(
    [...questionEligiblePlayerIds].filter((playerId) => !priorRoundCorrectPlayerIds.has(playerId)),
  );

  return {
    currentGameSession,
    currentSession,
    currentRoundEligiblePlayerIds,
    questionResults: questionResults ?? [],
    roundAnswers: (roundAnswers ?? []).filter((answer) => currentRoundEligiblePlayerIds.has(answer.player_id)),
  };
}

export async function setAnswerJudgements(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedQuestionIndex: number;
  expectedRevealRound: number;
  judgements: AnswerJudgementChange[];
}) {
  assertD1Env();
  const context = await loadCurrentAnswerJudgementContext(params);
  const { currentGameSession, currentSession } = context;
  const normalizedByAnswerId = new Map<string, AnswerJudgementChange>();
  for (const judgement of params.judgements.slice(0, MAX_PLAYERS_PER_ROOM)) {
    if (typeof judgement?.buzzerAnswerId === "string" && typeof judgement.isCorrect === "boolean") {
      normalizedByAnswerId.set(judgement.buzzerAnswerId, judgement);
    }
  }
  const judgements = [...normalizedByAnswerId.values()];
  if (judgements.length === 0) {
    throw new Error("没有需要提交的答案判定。");
  }

  const answerById = new Map(context.roundAnswers.map((answer) => [answer.id, answer]));
  const targetAnswers = judgements.map((judgement) => {
    const answer = answerById.get(judgement.buzzerAnswerId);
    if (!answer || !context.currentRoundEligiblePlayerIds.has(answer.player_id)) {
      throw new Error("部分回答已不属于当前轮，请刷新回答面板后重试。");
    }
    return { answer, judgement };
  });

  if (targetAnswers.some(({ answer }) => answer.status === "pending" && !isBuzzerAnswerReadyForJudging(answer))) {
    throw new Error("请稍等片刻，回答提交满 3 秒后才能判定。");
  }

  const pendingAnswers = context.roundAnswers.filter((answer) => answer.status === "pending").sort(compareAnswerOrder);
  const pendingTargetIds = new Set(targetAnswers.filter(({ answer }) => answer.status === "pending").map(({ answer }) => answer.id));
  if (currentSession.gameMode === "BUZZER_FIRST_CORRECT" && pendingTargetIds.size > 0) {
    for (const pendingAnswer of pendingAnswers) {
      if (!pendingTargetIds.has(pendingAnswer.id)) break;
      if (!isBuzzerAnswerReadyForJudging(pendingAnswer)) {
        throw new Error("请稍等片刻，正在等待可能更早提交的抢答到达。");
      }
    }
    const firstUntargetedIndex = pendingAnswers.findIndex((answer) => !pendingTargetIds.has(answer.id));
    const targetedPendingCount = pendingAnswers.filter((answer) => pendingTargetIds.has(answer.id)).length;
    if (firstUntargetedIndex >= 0 && firstUntargetedIndex < targetedPendingCount) {
      throw new Error("首位答对模式必须按提交顺序判定。");
    }
  }

  if (currentSession.gameMode === "BUZZER_FIRST_CORRECT") {
    const finalStatusByAnswerId = new Map(context.roundAnswers.map((answer) => [answer.id, answer.status]));
    for (const { answer, judgement } of targetAnswers) {
      finalStatusByAnswerId.set(answer.id, judgement.isCorrect ? "correct" : "wrong");
    }
    const orderedAnswers = [...context.roundAnswers].sort(compareAnswerOrder);
    const finalCorrectIndex = orderedAnswers.findIndex((answer) => finalStatusByAnswerId.get(answer.id) === "correct");
    if (
      finalCorrectIndex >= 0 &&
      orderedAnswers.slice(0, finalCorrectIndex).some((answer) => finalStatusByAnswerId.get(answer.id) !== "wrong")
    ) {
      throw new Error("首位答对模式必须先按提交顺序判完更早的回答。");
    }
    const finalCorrectPlayerIds = new Set(
      context.questionResults
        .filter((result) => result.scored_round === currentGameSession.current_reveal_round)
        .map((result) => result.player_id),
    );
    for (const { answer, judgement } of targetAnswers) {
      if (judgement.isCorrect) finalCorrectPlayerIds.add(answer.player_id);
      else finalCorrectPlayerIds.delete(answer.player_id);
    }
    if (finalCorrectPlayerIds.size > 1) {
      throw new Error("首位答对模式只能有一名答对玩家。");
    }
  }

  markCurrentMutationValidated();

  const existingResultByPlayerId = new Map(context.questionResults.map((result) => [result.player_id, result]));
  const judgedAt = new Date().toISOString();
  const roundScore =
    currentSession.gameMode === "BUZZER_FIRST_CORRECT"
      ? 1
      : currentSession.roundScores[currentGameSession.current_reveal_round - 1] ??
        Math.max(1, currentSession.maxRevealRounds - currentGameSession.current_reveal_round + 1);

  for (const { answer, judgement } of targetAnswers) {
    const existingResult = existingResultByPlayerId.get(answer.player_id);
    if (judgement.isCorrect) {
      const { data: result, error: resultError } = await d1.from("question_results").upsert(
        {
          id: existingResult?.id,
          game_session_id: currentGameSession.id,
          question_index: currentGameSession.current_question_index,
          player_id: answer.player_id,
          scored_round: currentGameSession.current_reveal_round,
          score_awarded: roundScore,
          judged_by_player_id: params.presenterPlayerId,
          judged_at: judgedAt,
        },
        { onConflict: "game_session_id,question_index,player_id" },
      ).select().single<DbQuestionResult>();
      if (resultError) throw new Error(resultError.message);
      existingResultByPlayerId.set(answer.player_id, result);
    } else if (existingResult?.scored_round === currentGameSession.current_reveal_round) {
      const { error: resultDeleteError } = await d1.from("question_results").delete().eq("id", existingResult.id);
      if (resultDeleteError) throw new Error(resultDeleteError.message);
      existingResultByPlayerId.delete(answer.player_id);
    }

    const { error: answerUpdateError } = await d1
      .from("buzzer_answers")
      .update({
        status: judgement.isCorrect ? "correct" : "wrong",
        score_awarded: judgement.isCorrect ? roundScore : 0,
        judged_at: judgedAt,
        judged_by_player_id: params.presenterPlayerId,
      })
      .eq("id", answer.id)
      .eq("game_session_id", currentGameSession.id)
      .eq("question_index", currentGameSession.current_question_index)
      .eq("reveal_round", currentGameSession.current_reveal_round);
    if (answerUpdateError) throw new Error(answerUpdateError.message);
  }

  if (currentSession.gameMode === "BUZZER_RANKED") {
    await recalculateRankedBuzzerScores({ gameSession: currentGameSession });
  }
  const scores = await recalculatePlayerScoresFromResults(currentGameSession.id);
  const [questionResults, buzzerAnswers] = await Promise.all([
    getQuestionResultsForQuestion({
      gameSessionId: currentGameSession.id,
      questionIndex: currentGameSession.current_question_index,
    }),
    getBuzzerAnswersForQuestionRound({
      gameSessionId: currentGameSession.id,
      questionIndex: currentGameSession.current_question_index,
      revealRound: currentGameSession.current_reveal_round,
    }),
  ]);
  const originalAnswerById = new Map(context.roundAnswers.map((answer) => [answer.id, answer]));
  const judgedAnswerIds = new Set(targetAnswers.map(({ answer }) => answer.id));
  const judgedAnswers = buzzerAnswers.filter((answer) => {
    if (judgedAnswerIds.has(answer.id)) return true;
    const original = originalAnswerById.get(answer.id);
    return Boolean(original && (original.status !== answer.status || original.score_awarded !== answer.scoreAwarded));
  });
  const hasFirstCorrect =
    currentSession.gameMode === "BUZZER_FIRST_CORRECT" &&
    questionResults.some((result) => result.scoredRound === currentGameSession.current_reveal_round);
  const gameSession = hasFirstCorrect ? await revealQuestionForReview(currentGameSession.id) : currentSession;

  return { gameSession, judgedAnswers, scores, questionResults };
}

export async function markPendingRoundAnswersWrong(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedQuestionIndex: number;
  expectedRevealRound: number;
}) {
  assertD1Env();
  const context = await loadCurrentAnswerJudgementContext(params);
  const roundActionState = await getRoundActionState(context.currentSession);
  const submissionClosed =
    !context.currentSession.roundStartedAt ||
    hasRoundForfeitDeadlineArrived(context.currentSession, Date.now()) ||
    roundActionState.allEligiblePlayersUsedChance ||
    (context.currentSession.gameMode === "BUZZER_FIRST_CORRECT" && context.questionResults.length > 0);
  if (!submissionClosed) {
    throw new Error("本轮仍可提交，暂时不能将未判定回答全部判错。");
  }

  const pendingAnswers = context.roundAnswers.filter((answer) => answer.status === "pending");
  if (pendingAnswers.length === 0) {
    const [scores, questionResults] = await Promise.all([
      getPlayerScores(context.currentGameSession.id),
      getQuestionResultsForQuestion({
        gameSessionId: context.currentGameSession.id,
        questionIndex: context.currentGameSession.current_question_index,
      }),
    ]);
    return { gameSession: context.currentSession, judgedAnswers: [], scores, questionResults };
  }

  return await setAnswerJudgements({
    ...params,
    judgements: pendingAnswers.map((answer) => ({ buzzerAnswerId: answer.id, isCorrect: false })),
  });
}

export async function judgeBuzzerAnswer(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  buzzerAnswerId: string;
  isCorrect: boolean;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("判定抢答失败：当前游戏不存在，或你不是出题人。");
  }

  const currentSession = toGameSession(currentGameSession);

  if (currentSession.gameMode === "TEAM_BATTLE") {
    throw new Error("红蓝对抗模式不能使用普通抢答判定。");
  }

  const eligiblePlayerIds = await getOrCreateQuestionEligiblePlayerIds({
    gameSessionId: currentGameSession.id,
    roomId: currentGameSession.room_id,
    questionIndex: currentGameSession.current_question_index,
    presenterPlayerId: currentGameSession.presenter_player_id,
    knownEligiblePlayerIds: currentSession.eligiblePlayerIds,
  });
  const [roomPlayers, { data: pendingAnswers, error: pendingError }] = await Promise.all([
    getDbPlayersByRoomId(currentGameSession.room_id),
    d1
      .from("buzzer_answers")
      .select("*")
      .eq("game_session_id", currentGameSession.id)
      .eq("question_index", currentGameSession.current_question_index)
      .eq("reveal_round", currentGameSession.current_reveal_round)
      .eq("status", "pending")
      .order("submitted_at", { ascending: true })
      .order("server_received_at", { ascending: true })
      .order("id", { ascending: true })
      .returns<DbBuzzerAnswer[]>(),
  ]);

  if (pendingError) {
    throw new Error(pendingError.message);
  }

  const roomPlayerSet = new Set(roomPlayers.filter(isGamePlayer).map((player) => player.id));
  const activeEligiblePlayerSet = new Set(eligiblePlayerIds.filter((playerId) => roomPlayerSet.has(playerId)));
  const firstPendingAnswer = (pendingAnswers ?? []).find((answer) => activeEligiblePlayerSet.has(answer.player_id)) ?? null;
  if (!firstPendingAnswer || firstPendingAnswer.id !== params.buzzerAnswerId) {
    throw new Error("请先判定最早提交的待判定抢答。");
  }

  if (!isBuzzerAnswerReadyForJudging(firstPendingAnswer)) {
    throw new Error("请稍等片刻，正在等待可能更早提交的抢答到达。");
  }

  let scoreAwarded = 0;
  const judgedAt = new Date().toISOString();

  if (params.isCorrect) {
    if (currentSession.gameMode === "ROUND_REVEAL") {
      scoreAwarded =
        currentSession.roundScores[currentSession.currentRevealRound - 1] ??
        Math.max(1, currentSession.maxRevealRounds - currentSession.currentRevealRound + 1);
    } else if (currentSession.gameMode === "BUZZER_FIRST_CORRECT") {
      if (await hasCorrectResultForCurrentQuestion(currentSession)) {
        throw new Error("本题已有首个答对玩家，不能继续判为答对。");
      }

      scoreAwarded = 1;
    } else {
      const [eligiblePlayerIds, { data: existingResults, error: resultsError }] = await Promise.all([
        getOrCreateQuestionEligiblePlayerIds({
          gameSessionId: currentGameSession.id,
          roomId: currentGameSession.room_id,
          questionIndex: currentGameSession.current_question_index,
          presenterPlayerId: currentGameSession.presenter_player_id,
        }),
        d1
          .from("question_results")
          .select("id")
          .eq("game_session_id", currentGameSession.id)
          .eq("question_index", currentGameSession.current_question_index)
          .returns<{ id: string }[]>(),
      ]);

      if (resultsError) {
        throw new Error(resultsError.message);
      }

      const guesserCount = eligiblePlayerIds.length;
      const correctRank = (existingResults?.length ?? 0) + 1;
      scoreAwarded = Math.max(1, guesserCount - correctRank + 1);
    }

    const { error: resultError } = await d1.from("question_results").insert({
      game_session_id: currentGameSession.id,
      question_index: currentGameSession.current_question_index,
      player_id: firstPendingAnswer.player_id,
      scored_round: currentGameSession.current_reveal_round,
      score_awarded: scoreAwarded,
      judged_by_player_id: params.presenterPlayerId,
    });

    if (resultError && !isUniqueViolation(resultError)) {
      throw new Error(resultError.message);
    }

    if (!resultError) {
      await addScoreToPlayer({
        gameSessionId: currentGameSession.id,
        playerId: firstPendingAnswer.player_id,
        scoreAwarded,
      });
    }
  }

  const { error: updateError } = await d1
    .from("buzzer_answers")
    .update({
      status: params.isCorrect ? "correct" : "wrong",
      score_awarded: scoreAwarded,
      judged_at: judgedAt,
      judged_by_player_id: params.presenterPlayerId,
    })
    .eq("id", firstPendingAnswer.id)
    .eq("status", "pending");

  if (updateError) {
    throw new Error(updateError.message);
  }

  if (params.isCorrect && currentSession.gameMode === "BUZZER_RANKED") {
    const rankedScoreByPlayerId = await recalculateRankedBuzzerScores({
      gameSession: currentGameSession,
    });
    scoreAwarded = rankedScoreByPlayerId.get(firstPendingAnswer.player_id) ?? scoreAwarded;
  }

  const nextGameSession =
    params.isCorrect && currentSession.gameMode === "BUZZER_FIRST_CORRECT"
      ? await revealQuestionForReview(currentGameSession.id)
      : currentSession;
  const scoringDelta = params.isCorrect
    ? await Promise.all([
        getPlayerScores(currentGameSession.id),
        getQuestionResultsForQuestion({
          gameSessionId: currentGameSession.id,
          questionIndex: currentGameSession.current_question_index,
        }),
        getBuzzerAnswersForQuestionRound({
          gameSessionId: currentGameSession.id,
          questionIndex: currentGameSession.current_question_index,
          revealRound: currentGameSession.current_reveal_round,
        }),
      ])
    : null;

  return {
    gameSession: nextGameSession,
    judgedAnswer: {
      ...toBuzzerAnswer(firstPendingAnswer),
      status: params.isCorrect ? "correct" as const : "wrong" as const,
      scoreAwarded,
      judgedAt,
      judgedByPlayerId: params.presenterPlayerId,
    },
    ...(scoringDelta
      ? {
          scores: scoringDelta[0],
          questionResults: scoringDelta[1],
          buzzerAnswers: scoringDelta[2],
        }
      : {}),
  };
}

export async function settleBuzzerRound(params: {
  gameSessionId: string;
  presenterPlayerId: string;
} & ServerTimedActionParams) {
  assertD1Env();

  const { data: currentGameSession, error } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!currentGameSession) {
    throw new Error("结算抢答失败：当前游戏不存在，或你不是出题人。");
  }

  const currentSession = toGameSession(currentGameSession);

  if (currentSession.gameMode === "TEAM_BATTLE") {
    throw new Error("红蓝对抗模式不能使用普通抢答结算。");
  }

  const nextGameSession = await settleBuzzerRoundFromDb(currentGameSession, getServerReceivedAtMs(params));

  return {
    gameSession: nextGameSession,
  };
}

export async function completeTeamBattleBlockSelection(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  disabledBlocks: number[];
  revealBlockCount?: number;
} & ServerTimedActionParams) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) throw new Error(currentError.message);
  if (!currentGameSession) {
    throw new Error("确认禁用失败：当前游戏不存在，或你不是出题人。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;
  const revealBlockCount = normalizeRevealBlockCount(params.revealBlockCount);
  const disabledBlocks = normalizeDisabledBlocks(params.disabledBlocks, revealBlockCount);

  if (state.phase !== "PRESENTER_BLOCK") {
    const isCompletedRetry =
      Array.isArray(state.disabledBlocks) &&
      normalizeRevealBlockCount(state.revealBlockCount) === revealBlockCount &&
      disabledBlocks.length === state.disabledBlocks.length &&
      disabledBlocks.every((block, index) => block === state.disabledBlocks?.[index]);
    if (isCompletedRetry) return { gameSession: session };
    throw new Error("禁用已确认，不能再次修改。");
  }

  const stateWithDisabledBlocks: TeamBattleState = {
    ...state,
    revealBlockCount,
    disabledBlocks,
    revealVotes: {},
    guessVotes: {},
    guessProposals: [],
    pendingGuess: null,
  };
  const selectableBlocks = getSelectableTeamBattleBlocks(session, stateWithDisabledBlocks, revealBlockCount);
  const nextPhase = selectableBlocks.length > 0 ? "REVEAL_VOTE" : "GUESS_VOTE";
  const nextState = withFixedTeamBattleDeadline({
    ...stateWithDisabledBlocks,
    message: selectableBlocks.length > 0
      ? disabledBlocks.length > 0
        ? `已禁用 ${disabledBlocks.length} 格 · ${getTeamName(state.activeTeam)}选格`
        : `未禁用格子 · ${getTeamName(state.activeTeam)}选格`
      : `全部格子已禁用 · ${getTeamName(state.activeTeam)}猜测`,
  }, nextPhase, getServerReceivedAtMs(params));
  if (nextState.teams.red.length === 0 && nextState.teams.blue.length === 0) {
    nextState.message = "禁用完成 · 等待出题人公布答案";
  }

  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState);
  if (error) throw new Error(error.message);
  return { gameSession: toGameSession(updatedGameSession) };
}

export async function submitTeamBattleRevealVote(params: {
  gameSessionId: string;
  playerId: string;
  selectedBlocks: number[];
  revealBlockCount?: number;
} & ServerTimedActionParams) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("红蓝对抗投票失败：当前游戏不存在或已结束。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;
  const revealBlockCount = normalizeRevealBlockCount(params.revealBlockCount ?? state.revealBlockCount);

  await assertGamePlayerInRoom(session.roomId, params.playerId);

  if (state.phase !== "REVEAL_VOTE" || getPlayerTeam(state, params.playerId) !== state.activeTeam) {
    throw new Error("还没轮到你所在队伍投票，或当前不是选格阶段。");
  }
  if (state.voteDeadlineAt && getServerReceivedAtMs(params) >= new Date(state.voteDeadlineAt).getTime()) {
    throw new Error("本轮投票时间已结束，不能再修改选择。");
  }

  const selectableBlocks = getSelectableTeamBattleBlocks(session, state, revealBlockCount);
  const selectableSet = new Set(selectableBlocks);
  const requiredCount = Math.min(state.revealLimit, selectableBlocks.length);
  const selectedBlocks = Array.from(
    new Set(params.selectedBlocks.filter((block) => Number.isInteger(block) && selectableSet.has(block))),
  ).sort((a, b) => a - b);

  if (selectedBlocks.length !== requiredCount) {
    throw new Error("本轮选择的方块数量不正确，请按要求选择尚未打开的方块。");
  }

  const revealVotes = {
    ...state.revealVotes,
    [params.playerId]: selectedBlocks,
  };
  const nextState = withShortenedTeamBattleDeadlineAfterAllSubmitted({
    ...state,
    revealBlockCount,
    revealVotes,
    message: `${getTeamName(state.activeTeam)}正在投票选择 ${requiredCount} 个方块。`,
  }, getServerReceivedAtMs(params));
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState);

  if (error) {
    throw new Error(error.message);
  }

  return toGameSession(updatedGameSession);
}

export async function submitTeamBattleGuessVote(params: {
  gameSessionId: string;
  playerId: string;
  vote: TeamBattleGuessVote;
} & ServerTimedActionParams) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("红蓝对抗猜测投票失败：当前游戏不存在或已结束。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;

  await assertGamePlayerInRoom(session.roomId, params.playerId);

  if (state.phase !== "GUESS_VOTE" || getPlayerTeam(state, params.playerId) !== state.activeTeam) {
    throw new Error("还没轮到你所在队伍投票，或当前不是猜测投票阶段。");
  }
  if (state.voteDeadlineAt && getServerReceivedAtMs(params) >= new Date(state.voteDeadlineAt).getTime()) {
    throw new Error("本轮投票时间已结束，不能再修改选择。");
  }

  const vote =
    params.vote.type === "skip"
      ? { type: "skip" as const }
      : {
          type: "guess" as const,
          answerText: params.vote.answerText?.trim() ?? "",
        };

  if (vote.type === "guess" && !vote.answerText) {
    throw new Error("请输入要猜的答案，或选择跳过。");
  }
  if (vote.type === "guess" && vote.answerText.length > MAX_TEAM_BATTLE_GUESS_LENGTH) {
    throw new Error(`猜测答案不能超过 ${MAX_TEAM_BATTLE_GUESS_LENGTH} 个字符。`);
  }

  const proposalByAnswer = rebuildTeamGuessProposals(state);
  if (vote.type === "guess") {
    let proposal = proposalByAnswer.get(vote.answerText);
    if (!proposal) {
      proposal = {
        answerText: vote.answerText,
        proposerPlayerId: params.playerId,
        proposerName: state.teamMemberNames?.[params.playerId] ?? "已离开玩家",
      };
      state.guessProposals!.push(proposal);
    }
    vote.answerText = proposal.answerText;
  }

  const guessVotes = {
    ...state.guessVotes,
    [params.playerId]: vote,
  };
  const nextState = withShortenedTeamBattleDeadlineAfterAllSubmitted({
    ...state,
    guessVotes,
    message: `${getTeamName(state.activeTeam)}正在投票决定是否猜测。`,
  }, getServerReceivedAtMs(params));
  pruneUnusedTeamGuessProposals(nextState);
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState);

  if (error) {
    throw new Error(error.message);
  }

  return toGameSession(updatedGameSession);
}

export async function finalizeTeamBattleVote(params: {
  gameSessionId: string;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("红蓝对抗结算失败：当前游戏不存在或已结束。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;

  if ((state.phase !== "REVEAL_VOTE" && state.phase !== "GUESS_VOTE") || !voteDeadlineReached(state)) {
    return { gameSession: session };
  }

  if (getTeamMembers(state, state.activeTeam).length === 0) {
    const availableTeam = getOpposingTeam(state.activeTeam);
    const nextState = getTeamMembers(state, availableTeam).length > 0
      ? withFixedTeamBattleDeadline({
          ...state,
          activeTeam: availableTeam,
          revealVotes: {},
          guessVotes: {},
          guessProposals: [],
          pendingGuess: null,
          message: `${getTeamName(state.activeTeam)}没有在线队员，轮到${getTeamName(availableTeam)}。`,
        }, state.phase)
      : {
          ...state,
          voteDeadlineAt: null,
          revealVotes: {},
          guessVotes: {},
          guessProposals: [],
          pendingGuess: null,
          message: "双方都没有在线队员，已停止自动投票，请出题人公布答案或结束游戏。",
        };
    const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState);
    if (error) throw new Error(error.message);
    return { gameSession: toGameSession(updatedGameSession) };
  }

  if (state.phase === "REVEAL_VOTE") {
    const revealBlockCount = normalizeRevealBlockCount(state.revealBlockCount);
    const availableBlocks = getSelectableTeamBattleBlocks(session, state, revealBlockCount);
    const revealCount = Math.min(state.revealLimit, availableBlocks.length);
    const voteCounts = new Map(availableBlocks.map((block) => [block, 0]));

    for (const blocks of Object.values(state.revealVotes)) {
      for (const block of blocks) {
        if (voteCounts.has(block)) {
          voteCounts.set(block, (voteCounts.get(block) ?? 0) + 1);
        }
      }
    }

    const remaining = availableBlocks.slice();
    const selectedBlocks: number[] = [];
    let tieMessage = "";

    while (selectedBlocks.length < revealCount && remaining.length > 0) {
      const highest = Math.max(...remaining.map((block) => voteCounts.get(block) ?? 0));
      const tied = remaining.filter((block) => (voteCounts.get(block) ?? 0) === highest);
      const slots = revealCount - selectedBlocks.length;

      if (tied.length <= slots) {
        selectedBlocks.push(...tied);
      } else {
        const shuffled = tied.slice().sort(() => Math.random() - 0.5);
        selectedBlocks.push(...shuffled.slice(0, slots));
        tieMessage = `由于多个方块同票，随机选择了 ${shuffled.slice(0, slots).map((block) => block + 1).join("、")}。`;
      }

      for (const block of tied) {
        const index = remaining.indexOf(block);
        if (index >= 0) {
          remaining.splice(index, 1);
        }
      }
    }

    const nextBlocks = Array.from(new Set([...session.revealedBlocks, ...selectedBlocks])).sort((a, b) => a - b);
    const nextState = withFixedTeamBattleDeadline({
      ...state,
      phase: "GUESS_VOTE",
      voteDeadlineAt: null,
      revealVotes: {},
      guessVotes: {},
      guessProposals: [],
      pendingGuess: null,
      message: `${getTeamName(state.activeTeam)}打开了 ${selectedBlocks.map((block) => block + 1).join("、")} 号方块。${tieMessage}`,
    }, "GUESS_VOTE");
    const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState, {
      revealed_blocks: nextBlocks,
    });

    if (error) {
      throw new Error(error.message);
    }

    return { gameSession: toGameSession(updatedGameSession) };
  }

  const proposalByAnswer = rebuildTeamGuessProposals(state);
  const optionCounts = new Map<string, { count: number; vote: TeamBattleGuessVote }>();
  for (const vote of Object.values(state.guessVotes)) {
    const key = vote.type === "skip" ? "__skip__" : `guess:${vote.answerText?.trim() ?? ""}`;
    const existing = optionCounts.get(key);
    optionCounts.set(key, {
      count: (existing?.count ?? 0) + 1,
      vote,
    });
  }

  const noVotes = optionCounts.size === 0;
  const highest = noVotes ? 0 : Math.max(...Array.from(optionCounts.values()).map((option) => option.count));
  const tiedOptions = noVotes
    ? [{ count: 0, vote: { type: "skip" as const } }]
    : Array.from(optionCounts.values()).filter((option) => option.count === highest);
  const winningOption = tiedOptions.length > 1 ? randomChoice(tiedOptions) : tiedOptions[0];
  const tieMessage =
    noVotes
      ? "由于无人提交，视为不猜。"
      : tiedOptions.length > 1
      ? `由于最高票选项票数相同，随机选择了${winningOption.vote.type === "skip" ? "不猜" : `猜「${winningOption.vote.answerText}」`}。`
      : "";

  if (winningOption.vote.type === "skip") {
    const nextState: TeamBattleState = {
      ...state,
      phase: "TURN_RESULT",
      voteDeadlineAt: null,
      revealVotes: {},
      guessVotes: {},
      guessProposals: [],
      previousTurnAction: {
        team: state.activeTeam,
        type: "skip",
      },
      pendingGuess: null,
      message: `${getTeamName(state.activeTeam)}选择不猜。${tieMessage}`,
    };
    const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState);

    if (error) {
      throw new Error(error.message);
    }

    return { gameSession: toGameSession(updatedGameSession) };
  }

  const answerText = winningOption.vote.answerText?.trim() ?? "";
  const winningProposal = proposalByAnswer.get(answerText);
  const nextState: TeamBattleState = {
    ...state,
    phase: "JUDGING",
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    guessProposals: [],
    pendingGuess: {
      team: state.activeTeam,
      answerText,
      proposerPlayerId: winningProposal?.proposerPlayerId,
      proposerName: winningProposal?.proposerName,
    },
    message: `${getTeamName(state.activeTeam)}决定猜「${answerText}」。${tieMessage}`,
  };
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState);

  if (error) {
    throw new Error(error.message);
  }

  return { gameSession: toGameSession(updatedGameSession) };
}

export async function judgeTeamBattleGuess(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  isCorrect: boolean;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("红蓝对抗判定失败：当前游戏不存在，或你不是出题人。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;

  if (state.phase !== "JUDGING" || !state.pendingGuess) {
    throw new Error("当前没有待判定的红蓝对抗猜测。");
  }

  if (!params.isCorrect) {
    const nextState: TeamBattleState = {
      ...state,
      phase: "TURN_RESULT",
      voteDeadlineAt: null,
      revealVotes: {},
      guessVotes: {},
      guessProposals: [],
      previousTurnAction: {
        team: state.pendingGuess.team,
        type: "guess",
        answerText: state.pendingGuess.answerText,
      },
      pendingGuess: null,
      message: `${getTeamName(state.pendingGuess.team)}猜测「${state.pendingGuess.answerText}」，猜测错误。`,
    };
    const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState);

    if (error) {
      throw new Error(error.message);
    }

    return { gameSession: toGameSession(updatedGameSession) };
  }

  const winningTeam = state.pendingGuess.team;
  const winningMembers = getTeamMembers(state, winningTeam);
  if (winningMembers.length === 0) {
    throw new Error("红蓝对抗判定失败：猜测队伍已没有在线队员，请取消本局。");
  }

  const nextScores = {
    ...state.teamScores,
    [winningTeam]: state.teamScores[winningTeam] + 1,
  };

  const newlyScoredPlayerIds = await insertQuestionResultsForPlayers({
    gameSessionId: currentGameSession.id,
    questionIndex: currentGameSession.current_question_index,
    playerIds: winningMembers,
    scoredRound: currentGameSession.current_reveal_round,
    scoreAwarded: 1,
    judgedByPlayerId: params.presenterPlayerId,
  });
  await bulkAddScoresToPlayers({
    gameSessionId: currentGameSession.id,
    playerIds: newlyScoredPlayerIds,
    scoreAwarded: 1,
  });

  const nextState: TeamBattleState = {
    ...state,
    phase: "REVIEW",
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    guessProposals: [],
    correctGuess: { ...state.pendingGuess },
    pendingGuess: null,
    teamScores: nextScores,
    message: `${getTeamName(winningTeam)}猜对并获得 1 分，当前展示完整图片。`,
  };
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState, {
    revealed_blocks: ALL_REVEALED_BLOCKS,
    round_started_at: null,
  });

  if (error) {
    throw new Error(error.message);
  }

  return { gameSession: toGameSession(updatedGameSession) };
}

export async function advanceTeamBattleTurn(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedTurnNumber: number;
  serverReceivedAtMs?: number | null;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) throw new Error(currentError.message);
  if (!currentGameSession) {
    throw new Error("进入下一轮失败：当前游戏不存在，或你不是出题人。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;
  if (
    state.phase !== "TURN_RESULT" ||
    !state.previousTurnAction ||
    state.turnNumber !== params.expectedTurnNumber
  ) {
    return { gameSession: session };
  }

  const previousTeam = state.previousTurnAction.team;
  const opposingTeam = getOpposingTeam(previousTeam);
  const nextTeam = getTeamMembers(state, opposingTeam).length > 0
    ? opposingTeam
    : getTeamMembers(state, previousTeam).length > 0
      ? previousTeam
      : null;
  if (!nextTeam) {
    throw new Error("没有可继续行动的队伍，请公布答案或结束游戏。");
  }

  const revealBlockCount = normalizeRevealBlockCount(state.revealBlockCount);
  const nextPhase = getSelectableTeamBattleBlocks(session, state, revealBlockCount).length === 0
    ? "GUESS_VOTE"
    : "REVEAL_VOTE";
  const revealLimit = state.previousTurnAction.type === "guess" ? 2 : 1;
  const nextState = withFixedTeamBattleDeadline({
    ...state,
    activeTeam: nextTeam,
    phase: nextPhase,
    revealLimit,
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    guessProposals: [],
    pendingGuess: null,
    turnNumber: state.turnNumber + 1,
    message: nextPhase === "REVEAL_VOTE"
      ? `${getTeamName(nextTeam)}本回合可以打开 ${revealLimit} 个方块。`
      : `图片已全部打开，轮到${getTeamName(nextTeam)}决定是否猜测。`,
  }, nextPhase, getServerReceivedAtMs(params));
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState, {
    current_reveal_round: currentGameSession.current_reveal_round + 1,
  });
  if (error) throw new Error(error.message);
  return { gameSession: toGameSession(updatedGameSession) };
}

export async function revealTeamBattleAnswer(params: {
  gameSessionId: string;
  presenterPlayerId: string;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("公布答案失败：当前游戏不存在，或你不是出题人。");
  }

  const session = assertTeamBattleSession(currentGameSession);
  const state = session.teamBattleState!;
  const nextState: TeamBattleState = {
    ...state,
    phase: "REVIEW",
    voteDeadlineAt: null,
    revealVotes: {},
    guessVotes: {},
    guessProposals: [],
    pendingGuess: null,
    message: "出题人公布答案，本题双方都不加分。",
  };
  const { data: updatedGameSession, error } = await updateTeamBattleState(currentGameSession.id, nextState, {
    revealed_blocks: ALL_REVEALED_BLOCKS,
    round_started_at: null,
  });

  if (error) {
    throw new Error(error.message);
  }

  return { gameSession: toGameSession(updatedGameSession) };
}

export async function gradeAnswersAndAdvance(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  correctPlayerIds: string[];
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("判分失败：当前游戏不存在，或你不是出题人。");
  }

  if (!currentGameSession.round_started_at) {
    throw new Error("本轮尚未开始，不能进行判分。");
  }

  const currentRound = currentGameSession.current_reveal_round;
  const questionIndex = currentGameSession.current_question_index;
  const currentSession = toGameSession(currentGameSession);
  const roundScore = currentSession.roundScores[currentRound - 1] ?? Math.max(1, currentSession.maxRevealRounds - currentRound + 1);
  const eligiblePlayerIds = await getOrCreateQuestionEligiblePlayerIds({
    gameSessionId: currentGameSession.id,
    roomId: currentGameSession.room_id,
    questionIndex,
    presenterPlayerId: currentGameSession.presenter_player_id,
  });
  const eligiblePlayerSet = new Set(eligiblePlayerIds);
  const uniqueCorrectPlayerIds = Array.from(new Set(params.correctPlayerIds)).filter(
    (playerId) => playerId && playerId !== params.presenterPlayerId && eligiblePlayerSet.has(playerId),
  );
  const newlyScoredPlayerIds = await insertQuestionResultsForPlayers({
    gameSessionId: currentGameSession.id,
    questionIndex,
    playerIds: uniqueCorrectPlayerIds,
    scoredRound: currentRound,
    scoreAwarded: roundScore,
    judgedByPlayerId: params.presenterPlayerId,
  });
  await bulkAddScoresToPlayers({
    gameSessionId: currentGameSession.id,
    playerIds: newlyScoredPlayerIds,
    scoreAwarded: roundScore,
  });

  const { data: questionResults, error: questionResultsError } = await d1
    .from("question_results")
    .select("*")
    .eq("game_session_id", currentGameSession.id)
    .eq("question_index", questionIndex)
    .returns<DbQuestionResult[]>();

  if (questionResultsError) {
    throw new Error(questionResultsError.message);
  }

  const correctSet = new Set((questionResults ?? []).map((result) => result.player_id));
  const allPlayersCorrect = eligiblePlayerIds.length > 0 && eligiblePlayerIds.every((guesserId) => correctSet.has(guesserId));

  if (allPlayersCorrect) {
    const reviewedGameSession = await revealQuestionForReview(currentGameSession.id);

    return {
      gameSession: reviewedGameSession,
      room: null,
      newlyScoredPlayerIds,
    };
  }

  const { data: settledGameSession, error: settleError } = await d1
    .from("game_sessions")
    .update({
      round_started_at: null,
    })
    .eq("id", currentGameSession.id)
    .select()
    .single<DbGameSession>();

  if (settleError) {
    throw new Error(settleError.message);
  }

  return {
    gameSession: toGameSession(settledGameSession),
    room: null,
    newlyScoredPlayerIds,
  };
}

function assertExpectedQuestionIndex(value: number) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("题目状态无效，请刷新后重试。");
  }
}

function resolveExpectedQuestionIndex(value: number | undefined) {
  if (value === undefined) {
    throw new Error("页面版本已更新，请刷新后重试。");
  }

  assertExpectedQuestionIndex(value);
  return value;
}

async function getCompletedQuestionTransitionResult(currentGameSession: DbGameSession, expectedQuestionIndex: number) {
  const advancedToNextQuestion =
    currentGameSession.status === "PLAYING" && currentGameSession.current_question_index === expectedQuestionIndex + 1;
  let advancedToGameResult = false;
  let resultRoom: Room | null = null;

  if (currentGameSession.status === "GAME_RESULT" && currentGameSession.current_question_index === expectedQuestionIndex) {
    const questions = await getQuestionsForGameSession(currentGameSession);
    resultRoom = await getRoomWithPlayersById(currentGameSession.room_id);
    advancedToGameResult =
      Boolean(currentGameSession.completed_normally_at) &&
      expectedQuestionIndex === questions.length - 1 &&
      resultRoom?.currentGameId === currentGameSession.id &&
      (resultRoom.status === "GAME_RESULT" || resultRoom.status === "PLAYING");

    if (advancedToGameResult && resultRoom) {
      return await finishRoomAfterGameSessionEnded(currentGameSession, expectedQuestionIndex);
    }
  }

  if (!advancedToNextQuestion && !advancedToGameResult) {
    return null;
  }

  return {
    gameSession: await hydrateGameSessionEligibility(toGameSession(currentGameSession)),
    room: advancedToGameResult ? resultRoom : null,
  };
}

async function rollbackFinishedGameSession(gameSessionId: string, expectedQuestionIndex: number) {
  const { data, error } = await d1
    .from("game_sessions")
    .update({
      status: "PLAYING",
      ended_at: null,
      completed_normally_at: null,
    })
    .eq("id", gameSessionId)
    .eq("status", "GAME_RESULT")
    .eq("current_question_index", expectedQuestionIndex)
    .select()
    .maybeSingle<DbGameSession>();

  if (error || !data) {
    console.error(
      JSON.stringify({
        event: "finish_game_rollback_failed",
        gameSessionId,
        expectedQuestionIndex,
        error: error?.message ?? "game session state changed before rollback",
      }),
    );
  }
}

async function finishRoomAfterGameSessionEnded(endedGameSession: DbGameSession, expectedQuestionIndex: number) {
  const { data: updatedRoom, error: roomError } = await d1
    .from("rooms")
    .update({
      game_status: "GAME_RESULT",
      public_activity_at: endedGameSession.ended_at ?? new Date().toISOString(),
    })
    .eq("id", endedGameSession.room_id)
    .eq("current_game_id", endedGameSession.id)
    .eq("game_status", "PLAYING")
    .select()
    .maybeSingle<DbRoom>();

  if (updatedRoom) {
    await recordCompletedQuestionSetPlay({
      gameSessionId: endedGameSession.id,
      questionSetId: endedGameSession.question_set_id,
      completedAt: endedGameSession.completed_normally_at,
    });
    return {
      gameSession: toGameSession(endedGameSession),
      room: toRoom(updatedRoom),
    };
  }

  let latestRoom: DbRoom | null = null;
  try {
    latestRoom = await getDbRoomById(endedGameSession.room_id);
  } catch (verificationError) {
    console.error(
      JSON.stringify({
        event: "finish_game_commit_verification_failed",
        gameSessionId: endedGameSession.id,
        roomId: endedGameSession.room_id,
        expectedQuestionIndex,
        error: verificationError instanceof Error ? verificationError.message : String(verificationError),
      }),
    );
    if (roomError) {
      throw new Error(roomError.message);
    }
    throw verificationError;
  }

  if (
    latestRoom?.current_game_id === endedGameSession.id &&
    latestRoom.game_status === "GAME_RESULT"
  ) {
    await recordCompletedQuestionSetPlay({
      gameSessionId: endedGameSession.id,
      questionSetId: endedGameSession.question_set_id,
      completedAt: endedGameSession.completed_normally_at,
    });
    return {
      gameSession: toGameSession(endedGameSession),
      room: toRoom(latestRoom),
    };
  }

  if (latestRoom?.current_game_id === endedGameSession.id && latestRoom.game_status === "PLAYING") {
    await rollbackFinishedGameSession(endedGameSession.id, expectedQuestionIndex);
  }

  if (roomError) {
    throw new Error(roomError.message);
  }
  throw new Error("题目状态已变化，请刷新后重试。");
}

async function recordCompletedQuestionSetPlay(params: {
  gameSessionId: string;
  questionSetId: string;
  completedAt?: string | null;
}) {
  if (!params.completedAt) {
    throw new Error("题库尚未正常完成，不能记录开局次数。");
  }

  const { error } = await d1.from("completed_question_set_plays").insert(
    {
      game_session_id: params.gameSessionId,
      question_set_id: params.questionSetId,
      completed_at: params.completedAt,
    },
    { onConflict: "game_session_id", ignoreDuplicates: true },
  );

  if (error) {
    throw new Error(error.message);
  }
}

async function finishGameAfterQuestionTransition(currentGameSession: DbGameSession, expectedQuestionIndex: number) {
  const completedAt = new Date().toISOString();
  const { data: endedGameSession, error: endGameError } = await d1
    .from("game_sessions")
    .update({
      status: "GAME_RESULT",
      ended_at: completedAt,
      completed_normally_at: completedAt,
    })
    .eq("id", currentGameSession.id)
    .eq("status", "PLAYING")
    .eq("current_question_index", expectedQuestionIndex)
    .select()
    .maybeSingle<DbGameSession>();

  if (endGameError) {
    throw new Error(endGameError.message);
  }

  if (!endedGameSession) {
    const { data: latestGameSession, error: latestError } = await d1
      .from("game_sessions")
      .select("*")
      .eq("id", currentGameSession.id)
      .maybeSingle<DbGameSession>();
    if (latestError) {
      throw new Error(latestError.message);
    }
    const completed = latestGameSession
      ? await getCompletedQuestionTransitionResult(latestGameSession, expectedQuestionIndex)
      : null;
    if (completed) {
      return completed;
    }
    throw new Error("题目状态已变化，请刷新后重试。");
  }

  return await finishRoomAfterGameSessionEnded(endedGameSession, expectedQuestionIndex);
}

export async function advanceReviewedQuestion(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedQuestionIndex?: number;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("进入下一题失败：当前游戏不存在或已结束。");
  }

  if (currentGameSession.presenter_player_id !== params.presenterPlayerId) {
    throw new Error("只有本局出题人可以进入下一题。");
  }

  const expectedQuestionIndex = resolveExpectedQuestionIndex(params.expectedQuestionIndex);
  const completedTransition = await getCompletedQuestionTransitionResult(currentGameSession, expectedQuestionIndex);
  if (completedTransition) {
    return completedTransition;
  }

  if (currentGameSession.status !== "PLAYING") {
    throw new Error("进入下一题失败：当前游戏不存在或已结束。");
  }

  if (currentGameSession.current_question_index !== expectedQuestionIndex) {
    throw new Error("题目状态已变化，请刷新后重试。");
  }

  const { data: room, error: roomLoadError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", currentGameSession.room_id)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("current_game_id", currentGameSession.id)
    .eq("game_status", "PLAYING")
    .maybeSingle<DbRoom>();

  if (roomLoadError) {
    throw new Error(roomLoadError.message);
  }

  if (!room) {
    throw new Error("只有本局出题人可以进入下一题。");
  }

  const currentSession = toGameSession(currentGameSession);
  const isReviewingQuestion =
    !currentSession.roundStartedAt && currentSession.revealedBlocks.length === ALL_REVEALED_BLOCKS.length;

  if (!isReviewingQuestion) {
    throw new Error("当前还没有进入完整图片复盘阶段，不能进入下一题。");
  }

  const questions = await getQuestionsForGameSession(currentGameSession);
  const nextQuestionIndex = currentGameSession.current_question_index + 1;

  if (nextQuestionIndex >= questions.length) {
    return await finishGameAfterQuestionTransition(currentGameSession, expectedQuestionIndex);
  }

  const eligiblePlayerIds = await createQuestionEligibilitySnapshot({
    gameSessionId: currentGameSession.id,
    roomId: currentGameSession.room_id,
    questionIndex: nextQuestionIndex,
    presenterPlayerId: currentGameSession.presenter_player_id,
  });
  const nextTeamBattleState =
    currentSession.gameMode === "TEAM_BATTLE" && currentSession.teamBattleState
      ? await resetTeamBattleStateForQuestion(
          currentSession.teamBattleState,
          currentGameSession.room_id,
          currentGameSession.presenter_player_id,
          nextQuestionIndex,
        )
      : null;

  const { data: updatedGameSession, error } = await d1
    .from("game_sessions")
    .update({
      current_question_index: nextQuestionIndex,
      current_reveal_round: 1,
      revealed_blocks: [],
      team_battle_state: nextTeamBattleState,
      round_started_at: null,
    })
    .eq("id", currentGameSession.id)
    .eq("status", "PLAYING")
    .eq("current_question_index", expectedQuestionIndex)
    .select()
    .maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!updatedGameSession) {
    const { data: latestGameSession, error: latestError } = await d1
      .from("game_sessions")
      .select("*")
      .eq("id", currentGameSession.id)
      .maybeSingle<DbGameSession>();
    if (latestError) {
      throw new Error(latestError.message);
    }
    const completed = latestGameSession
      ? await getCompletedQuestionTransitionResult(latestGameSession, expectedQuestionIndex)
      : null;
    if (completed) {
      return completed;
    }
    throw new Error("题目状态已变化，请刷新后重试。");
  }

  const hydratedGameSession = {
    ...toGameSession(updatedGameSession),
    eligiblePlayerIds,
  };

  return {
    gameSession: hydratedGameSession,
    room: null,
  };
}

export async function updateQuestionLabel(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  questionId: string;
  labelText: string;
  source: "manual" | "answer";
  answerId?: string | null;
}) {
  assertD1Env();

  const labelText = params.labelText.trim();

  if (!labelText) {
    throw new Error("请先填写正确答案。");
  }

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("保存正确答案失败：当前游戏不存在或已结束。");
  }

  const { data: room, error: roomLoadError } = await d1
    .from("rooms")
    .select("*")
    .eq("id", currentGameSession.room_id)
    .eq("current_presenter_player_id", params.presenterPlayerId)
    .eq("current_game_id", currentGameSession.id)
    .eq("game_status", "PLAYING")
    .maybeSingle<DbRoom>();

  if (roomLoadError) {
    throw new Error(roomLoadError.message);
  }

  if (!room) {
    throw new Error("只有本局出题人可以填写正确答案。");
  }

  const currentSession = toGameSession(currentGameSession);
  const isReviewingQuestion =
    !currentSession.roundStartedAt && currentSession.revealedBlocks.length === ALL_REVEALED_BLOCKS.length;

  if (!isReviewingQuestion) {
    throw new Error("当前还没有进入完整图片复盘阶段，不能填写正确答案。");
  }

  const { data: questionSet, error: questionSetError } = await d1
    .from("question_sets")
    .select("*")
    .eq("id", currentGameSession.question_set_id)
    .maybeSingle<DbQuestionSet>();

  if (questionSetError) {
    throw new Error(questionSetError.message);
  }

  if (!questionSet) {
    throw new Error("当前题库不存在，不能填写正确答案。");
  }

  const question = (await getDbQuestionsForGameSession(currentGameSession, questionSet)).find(
    (item) => item.id === params.questionId && item.order_index === currentGameSession.current_question_index,
  );
  if (!question) {
    throw new Error("当前题目不存在，不能填写正确答案。");
  }

  if (question.label_text?.trim()) {
    throw new Error("该题已经有正确答案，不能重复填写。");
  }

  let sourceAnswerId: string | null = null;

  if (params.source === "answer") {
    if (!params.answerId) {
      throw new Error("请选择一个要引用的答案。");
    }

    const { data: answer, error: answerError } = await d1
      .from("answers")
      .select("*")
      .eq("id", params.answerId)
      .eq("game_session_id", currentGameSession.id)
      .eq("question_index", currentGameSession.current_question_index)
      .maybeSingle<DbAnswer>();

    if (answerError) {
      throw new Error(answerError.message);
    }

    if (answer) {
      sourceAnswerId = answer.id;
    } else {
      const { data: buzzerAnswer, error: buzzerAnswerError } = await d1
        .from("buzzer_answers")
        .select("*")
        .eq("id", params.answerId)
        .eq("game_session_id", currentGameSession.id)
        .eq("question_index", currentGameSession.current_question_index)
        .maybeSingle<DbBuzzerAnswer>();

      if (buzzerAnswerError) {
        throw new Error(buzzerAnswerError.message);
      }

      if (!buzzerAnswer) {
        throw new Error("引用的答案不存在，不能作为正确答案。");
      }

      sourceAnswerId = buzzerAnswer.id;
    }
  }

  const labelUpdatedAt = new Date().toISOString();
  if (questionSet.manifest_version != null) {
    let currentQuestionSet = questionSet;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const currentQuestions = decodeQuestionSetManifest(currentQuestionSet);
      const currentQuestion = currentQuestions?.find((item) => item.id === question.id);
      if (!currentQuestion) throw new Error("当前题目不存在，不能填写正确答案。");
      if (currentQuestion.label_text?.trim()) throw new Error("正确答案已被其他操作更新，请刷新后重试。");

      const nextStoredQuestion = {
        ...toQuestion(currentQuestion),
        labelText,
        labelSource: params.source,
        labelSourceAnswerId: sourceAnswerId,
        labelUpdatedByPlayerId: params.presenterPlayerId,
        labelUpdatedAt,
      };
      const nextQuestions = currentQuestions.map((item) => item.id === currentQuestion.id ? nextStoredQuestion : toQuestion(item));
      const revision = currentQuestionSet.manifest_revision ?? 0;
      const { data: updatedQuestionSet, error: manifestUpdateError } = await d1
        .from("question_sets")
        .update({
          manifest_json: encodeQuestionSetManifest(nextQuestions),
          manifest_revision: revision + 1,
        })
        .eq("id", currentQuestionSet.id)
        .eq("manifest_version", QUESTION_SET_MANIFEST_VERSION)
        .eq("manifest_revision", revision)
        .select()
        .maybeSingle<DbQuestionSet>();
      if (manifestUpdateError) throw new Error(manifestUpdateError.message);
      if (updatedQuestionSet) return { ...nextStoredQuestion, orderIndex: currentGameSession.current_question_index };

      const { data: reloaded, error: reloadError } = await d1
        .from("question_sets")
        .select("*")
        .eq("id", currentQuestionSet.id)
        .maybeSingle<DbQuestionSet>();
      if (reloadError) throw new Error(reloadError.message);
      if (!reloaded) throw new Error("当前题库不存在，不能填写正确答案。");
      currentQuestionSet = reloaded;
    }
    throw new Error("正确答案已被其他操作更新，请刷新后重试。");
  }

  const { data: updatedQuestion, error: updateError } = await d1
    .from("questions")
    .update({
      label_text: labelText,
      label_source: params.source,
      label_source_answer_id: sourceAnswerId,
      label_updated_by_player_id: params.presenterPlayerId,
      label_updated_at: labelUpdatedAt,
    })
    .eq("id", question.id)
    .is("label_text", null)
    .select()
    .maybeSingle<DbQuestion>();

  if (updateError) {
    throw new Error(updateError.message);
  }

  if (!updatedQuestion) {
    throw new Error("正确答案已被其他操作更新，请刷新后重试。");
  }

  return { ...toQuestion(updatedQuestion), orderIndex: currentGameSession.current_question_index };
}

export async function skipCurrentQuestion(params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedQuestionIndex?: number;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("跳过题目失败：当前游戏不存在，或你不是出题人。");
  }

  if (currentGameSession.presenter_player_id !== params.presenterPlayerId) {
    throw new Error("跳过题目失败：当前游戏不存在，或你不是出题人。");
  }

  const expectedQuestionIndex = resolveExpectedQuestionIndex(params.expectedQuestionIndex);
  const completedTransition = await getCompletedQuestionTransitionResult(currentGameSession, expectedQuestionIndex);
  if (completedTransition) {
    return completedTransition;
  }

  if (currentGameSession.status !== "PLAYING") {
    throw new Error("跳过题目失败：当前游戏不存在，或你不是出题人。");
  }

  if (currentGameSession.current_question_index !== expectedQuestionIndex) {
    throw new Error("题目状态已变化，请刷新后重试。");
  }

  const questions = await getQuestionsForGameSession(currentGameSession);
  const nextQuestionIndex = currentGameSession.current_question_index + 1;

  if (nextQuestionIndex >= questions.length) {
    return await finishGameAfterQuestionTransition(currentGameSession, expectedQuestionIndex);
  }

  const eligiblePlayerIds = await createQuestionEligibilitySnapshot({
    gameSessionId: currentGameSession.id,
    roomId: currentGameSession.room_id,
    questionIndex: nextQuestionIndex,
    presenterPlayerId: currentGameSession.presenter_player_id,
  });
  const currentSession = toGameSession(currentGameSession);
  const nextTeamBattleState =
    currentSession.gameMode === "TEAM_BATTLE" && currentSession.teamBattleState
      ? await resetTeamBattleStateForQuestion(
          currentSession.teamBattleState,
          currentGameSession.room_id,
          currentGameSession.presenter_player_id,
          nextQuestionIndex,
        )
      : null;

  const { data: updatedGameSession, error } = await d1
    .from("game_sessions")
    .update({
      current_question_index: nextQuestionIndex,
      current_reveal_round: 1,
      revealed_blocks: [],
      team_battle_state: nextTeamBattleState,
      round_started_at: null,
    })
    .eq("id", currentGameSession.id)
    .eq("status", "PLAYING")
    .eq("current_question_index", expectedQuestionIndex)
    .select()
    .maybeSingle<DbGameSession>();

  if (error) {
    throw new Error(error.message);
  }

  if (!updatedGameSession) {
    const { data: latestGameSession, error: latestError } = await d1
      .from("game_sessions")
      .select("*")
      .eq("id", currentGameSession.id)
      .maybeSingle<DbGameSession>();
    if (latestError) {
      throw new Error(latestError.message);
    }
    const completed = latestGameSession
      ? await getCompletedQuestionTransitionResult(latestGameSession, expectedQuestionIndex)
      : null;
    if (completed) {
      return completed;
    }
    throw new Error("题目状态已变化，请刷新后重试。");
  }

  const hydratedGameSession = {
    ...toGameSession(updatedGameSession),
    eligiblePlayerIds,
  };

  return {
    gameSession: hydratedGameSession,
    room: null,
  };
}

export async function endCurrentGameEarly(params: {
  gameSessionId: string;
  presenterPlayerId: string;
}) {
  assertD1Env();

  const { data: currentGameSession, error: currentError } = await d1
    .from("game_sessions")
    .select("*")
    .eq("id", params.gameSessionId)
    .eq("presenter_player_id", params.presenterPlayerId)
    .eq("status", "PLAYING")
    .maybeSingle<DbGameSession>();

  if (currentError) {
    throw new Error(currentError.message);
  }

  if (!currentGameSession) {
    throw new Error("结束游戏失败：当前游戏不存在，或你不是出题人。");
  }

  const endedAt = new Date().toISOString();
  const { data: endedGameSession, error: endGameError } = await d1
    .from("game_sessions")
    .update({
      status: "GAME_RESULT",
      ended_at: endedAt,
    })
    .eq("id", currentGameSession.id)
    .eq("status", "PLAYING")
    .select()
    .single<DbGameSession>();

  if (endGameError) {
    throw new Error(endGameError.message);
  }

  const { data: updatedRoom, error: roomError } = await d1
    .from("rooms")
    .update({
      game_status: "GAME_RESULT",
      public_activity_at: endedAt,
    })
    .eq("id", currentGameSession.room_id)
    .eq("current_game_id", currentGameSession.id)
    .select()
    .single<DbRoom>();

  if (roomError) {
    throw new Error(roomError.message);
  }

  return {
    gameSession: toGameSession(endedGameSession),
    room: toRoom(updatedRoom),
  };
}

export async function returnRoomToLobby(roomId: string, hostPlayerId: string) {
  assertD1Env();

  const { data: room, error } = await d1
    .from("rooms")
    .update({
      current_presenter_player_id: null,
      current_game_id: null,
      prepared_question_set_id: null,
      prepared_question_count: null,
      lobby_question_count: null,
      prepared_question_source: null,
      lobby_team_assignments: "{}",
      game_status: "LOBBY",
      public_activity_at: new Date().toISOString(),
    })
    .eq("id", roomId)
    .eq("host_player_id", hostPlayerId)
    .eq("game_status", "GAME_RESULT")
    .select()
    .maybeSingle<DbRoom>();

  if (error) {
    throw new Error(error.message);
  }

  if (!room) {
    throw new Error("返回大厅失败：只有房主可以在结算页返回大厅。");
  }

  return toRoom(room);
}
