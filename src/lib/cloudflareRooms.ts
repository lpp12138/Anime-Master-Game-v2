"use client";

import { callGameRpc } from "@/lib/cloudflareClient";
import type {
  Answer,
  BuzzerAnswer,
  CommunityQuestionSetPage,
  CommunityQuestionSetSort,
  DbRoom,
  GameBootstrapSnapshot,
  GameMode,
  GameResultSnapshot,
  GameSession,
  LeaderboardEntry,
  Player,
  PlayerRole,
  TeamAssignmentMode,
  TeamBattleTeam,
  PlayerScore,
  Question,
  QuestionSetCreationMethod,
  QuestionResult,
  QuestionSet,
  RoundSnapshot,
  Room,
  RoomVisibility,
  TeamBattleGuessVote,
} from "@/types/game";

export type QuestionImportItem = {
  imageUrl: string;
  labelText?: string | null;
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

  for (const item of items) {
    const imageUrl = item.imageUrl.trim();
    if (!imageUrl || !isHttpImageUrl(imageUrl) || seenUrls.has(imageUrl)) {
      continue;
    }

    seenUrls.add(imageUrl);
    normalizedItems.push({
      imageUrl,
      labelText: item.labelText?.trim() || null,
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

    items.push({
      imageUrl: record.image_url,
      labelText: typeof record.label_text === "string" ? record.label_text : null,
    });
  }

  return normalizeQuestionImportItems(items);
}

const rpc = <T>(name: string, ...args: unknown[]) => callGameRpc<T>(name, args);

export const createRoom = (playerId: string, nickname: string, options?: { visibility?: RoomVisibility; name?: string }) =>
  options
    ? rpc<Room>("createRoom", playerId, nickname, options)
    : rpc<Room>("createRoom", playerId, nickname);

export const getRoomByCode = (roomCode: string) => rpc<DbRoom | null>("getRoomByCode", roomCode);

export const getRoomWithPlayers = (roomCode: string) => rpc<Room | null>("getRoomWithPlayers", roomCode);

export const getPlayersByRoomId = (roomId: string) => rpc<Player[]>("getPlayersByRoomId", roomId);

export const joinRoom = (roomCode: string, playerId: string, nickname: string, role?: PlayerRole, team?: TeamBattleTeam) =>
  rpc<{ room: Room | null; error: string | null; errorCode?: string | null }>("joinRoom", roomCode, playerId, nickname, role, team);

export const updatePlayerRole = (roomId: string, actorPlayerId: string, targetPlayerId: string, role: PlayerRole, team?: TeamBattleTeam) =>
  rpc<Room>("updatePlayerRole", roomId, actorPlayerId, targetPlayerId, role, team);

export const leaveRoom = (roomId: string, playerId: string) => rpc<Room | null>("leaveRoom", roomId, playerId);

export const kickPlayerFromRoom = (roomId: string, hostPlayerId: string, targetPlayerId: string) =>
  rpc<Room>("kickPlayerFromRoom", roomId, hostPlayerId, targetPlayerId);

export const dissolveRoom = (roomId: string, playerId: string) => rpc<void>("dissolveRoom", roomId, playerId);

export function dissolveRoomOnPageExit(roomId: string, playerId: string) {
  try {
    void fetch(`${(import.meta.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "")}/api/rpc`, {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "dissolveRoom", args: [roomId, playerId] }),
    });
  } catch {
    // Page-exit cleanup is best effort.
  }
}

export const selectPresenterForRound = (roomId: string, hostPlayerId: string, presenterPlayerId: string) =>
  rpc<Room>("selectPresenterForRound", roomId, hostPlayerId, presenterPlayerId);

export const selectTeamForPlayer = (roomId: string, playerId: string, team: TeamBattleTeam) =>
  rpc<Room>("selectTeamForPlayer", { roomId, playerId, team });

export const cancelCurrentRound = (roomId: string, hostPlayerId: string) =>
  rpc<Room>("cancelCurrentRound", roomId, hostPlayerId);

export const cancelPresenterSetup = (roomId: string, presenterPlayerId: string) =>
  rpc<Room>("cancelPresenterSetup", roomId, presenterPlayerId);

export const createUploadedQuestionSet = (params: {
  roomId: string;
  presenterPlayerId: string;
  title: string;
  description?: string;
  imageUrls?: string[];
  questions?: QuestionImportItem[];
  creationMethod?: QuestionSetCreationMethod;
}) => rpc<QuestionSet>("createUploadedQuestionSet", params);

export const getQuestionSetById = (questionSetId: string) =>
  rpc<QuestionSet | null>("getQuestionSetById", questionSetId);

export const getCommunityQuestionSets = (params: {
  sort?: CommunityQuestionSetSort;
  search?: string;
  creationMethod?: QuestionSetCreationMethod;
  offset?: number;
  limit?: number;
  includeTotal?: boolean;
} = {}) => rpc<CommunityQuestionSetPage>("getCommunityQuestionSets", params);

export const getCommunityQuestionSetDetail = (questionSetId: string) =>
  rpc<QuestionSet | null>("getCommunityQuestionSetDetail", questionSetId);

export const prepareQuestionSetForStart = (params: {
  roomId: string;
  presenterPlayerId: string;
  questionSetId: string;
}) => rpc<Room>("prepareQuestionSetForStart", params);

export const updateRoomGameSettings = (params: {
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
}) => rpc<Room>("updateRoomGameSettings", params);

export const updateRoomNotice = (params: { roomId: string; hostPlayerId: string; notice: string }) =>
  rpc<{ roomId: string; notice: string | null; updatedAt: string; changed: boolean }>("updateRoomNotice", params);

export const startGameWithQuestionSet = (params: {
  startRequestId: string;
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
}) => rpc<{ gameSession: GameSession; room: Room }>("startGameWithQuestionSet", params);

export const getGameSessionById = (gameSessionId: string) =>
  rpc<GameSession | null>("getGameSessionById", gameSessionId);

export const getQuestionsByQuestionSetId = (questionSetId: string) =>
  rpc<Question[]>("getQuestionsByQuestionSetId", questionSetId);

export const confirmRevealBlocks = (params: {
  gameSessionId: string;
  presenterPlayerId: string;
  selectedBlocks: number[];
  revealBlockCount?: number;
}) => rpc<GameSession & { roundSnapshot?: RoundSnapshot }>("confirmRevealBlocks", params);

export const getAnswersForQuestionRound = (params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
}) => rpc<Answer[]>("getAnswersForQuestionRound", params);

export const getAnswersForQuestion = (params: { gameSessionId: string; questionIndex: number }) =>
  rpc<Answer[]>("getAnswersForQuestion", params);

export const getAnswerForPlayerRound = (params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
  playerId: string;
}) => rpc<Answer | null>("getAnswerForPlayerRound", params);

export const getBuzzerAnswersForQuestionRound = (params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
}) => rpc<BuzzerAnswer[]>("getBuzzerAnswersForQuestionRound", params);

export const getBuzzerAnswersForQuestion = (params: { gameSessionId: string; questionIndex: number }) =>
  rpc<BuzzerAnswer[]>("getBuzzerAnswersForQuestion", params);

export const getBuzzerAnswerForPlayerRound = (params: {
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
  playerId: string;
}) => rpc<BuzzerAnswer | null>("getBuzzerAnswerForPlayerRound", params);

export const getRoundSnapshot = (gameSessionId: string) => rpc<RoundSnapshot>("getRoundSnapshot", gameSessionId);

export const getGameBootstrapSnapshot = (gameSessionId: string) =>
  rpc<GameBootstrapSnapshot>("getGameBootstrapSnapshot", gameSessionId);

export const getGameResultSnapshot = (gameSessionId: string) =>
  rpc<GameResultSnapshot>("getGameResultSnapshot", gameSessionId);

export const getPlayerScores = (gameSessionId: string) => rpc<PlayerScore[]>("getPlayerScores", gameSessionId);

export const getLeaderboardForGameSession = (gameSessionId: string) =>
  rpc<LeaderboardEntry[]>("getLeaderboardForGameSession", gameSessionId);

export const publishQuestionSetToCommunity = (params: {
  questionSetId: string;
  playerId: string;
  title: string;
  description?: string;
  creationMethod: QuestionSetCreationMethod;
  roomId?: string;
}) => rpc<QuestionSet>("publishQuestionSetToCommunity", params);

export const rateCommunityQuestionSet = (params: { questionSetId: string; playerId: string; rating: number; roomId: string }) =>
  rpc<QuestionSet>("rateCommunityQuestionSet", params);

export const getQuestionSetRatingProgress = (params: { questionSetId: string; playerIds: string[]; playerId?: string }) =>
  rpc<{ ratedCount: number; totalCount: number; ratedPlayerIds: string[]; playerRating: number | null }>(
    "getQuestionSetRatingProgress",
    params,
  );

export const getQuestionResultsForQuestion = (params: { gameSessionId: string; questionIndex: number }) =>
  rpc<QuestionResult[]>("getQuestionResultsForQuestion", params);

export const getQuestionResultsForGameSession = (gameSessionId: string) =>
  rpc<QuestionResult[]>("getQuestionResultsForGameSession", gameSessionId);

export const submitAnswer = (params: { gameSessionId: string; playerId: string; answerText: string }) =>
  rpc<Answer & { buzzerAnswer?: BuzzerAnswer }>("submitAnswer", params);

export const submitForfeitAnswer = (params: { gameSessionId: string; playerId: string }) =>
  rpc<Answer>("submitForfeitAnswer", params);

export const autoForfeitExpiredRound = (params: { gameSessionId: string }) =>
  rpc<{ gameSession: GameSession }>("autoForfeitExpiredRound", params);

export const cancelForfeitAnswer = (params: { gameSessionId: string; playerId: string }) =>
  rpc<{ gameSession: GameSession; canceledAnswerId: string }>("cancelForfeitAnswer", params);

export const submitBuzzerAnswer = (params: { gameSessionId: string; playerId: string; answerText: string; clientRoundElapsedMs?: number | null }) =>
  rpc<BuzzerAnswer>("submitBuzzerAnswer", params);

export const judgeBuzzerAnswer = (params: {
  gameSessionId: string;
  presenterPlayerId: string;
  buzzerAnswerId: string;
  isCorrect: boolean;
}) =>
  rpc<{
    gameSession: GameSession;
    judgedAnswer: BuzzerAnswer;
    scores?: PlayerScore[];
    questionResults?: QuestionResult[];
    buzzerAnswers?: BuzzerAnswer[];
  }>("judgeBuzzerAnswer", params);

export type AnswerJudgementChange = {
  buzzerAnswerId: string;
  isCorrect: boolean;
};

export type AnswerJudgementResult = {
  gameSession: GameSession;
  judgedAnswers: BuzzerAnswer[];
  scores: PlayerScore[];
  questionResults: QuestionResult[];
};

export const setAnswerJudgements = (params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedQuestionIndex: number;
  expectedRevealRound: number;
  judgements: AnswerJudgementChange[];
}) => rpc<AnswerJudgementResult>("setAnswerJudgements", params);

export const markPendingRoundAnswersWrong = (params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedQuestionIndex: number;
  expectedRevealRound: number;
}) => rpc<AnswerJudgementResult>("markPendingRoundAnswersWrong", params);

export const settleBuzzerRound = (params: { gameSessionId: string; presenterPlayerId: string }) =>
  rpc<{ gameSession: GameSession }>("settleBuzzerRound", params);

export const completeTeamBattleBlockSelection = (params: {
  gameSessionId: string;
  presenterPlayerId: string;
  disabledBlocks: number[];
  revealBlockCount?: number;
}) => rpc<{ gameSession: GameSession }>("completeTeamBattleBlockSelection", params);

export const submitTeamBattleRevealVote = (params: { gameSessionId: string; playerId: string; selectedBlocks: number[]; revealBlockCount?: number }) =>
  rpc<GameSession>("submitTeamBattleRevealVote", params);

export const submitTeamBattleGuessVote = (params: { gameSessionId: string; playerId: string; vote: TeamBattleGuessVote }) =>
  rpc<GameSession>("submitTeamBattleGuessVote", params);

export const finalizeTeamBattleVote = (params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedPhase: "REVEAL_VOTE" | "GUESS_VOTE";
  expectedTurnNumber: number;
  expectedVoteDeadlineAt: string;
}) =>
  rpc<{ gameSession: GameSession }>("finalizeTeamBattleVote", params);

export const judgeTeamBattleGuess = (params: { gameSessionId: string; presenterPlayerId: string; isCorrect: boolean }) =>
  rpc<{ gameSession: GameSession }>("judgeTeamBattleGuess", params);

export const advanceTeamBattleTurn = (params: { gameSessionId: string; presenterPlayerId: string; expectedTurnNumber: number }) =>
  rpc<{ gameSession: GameSession }>("advanceTeamBattleTurn", params);

export const revealTeamBattleAnswer = (params: { gameSessionId: string; presenterPlayerId: string }) =>
  rpc<{ gameSession: GameSession }>("revealTeamBattleAnswer", params);

export const gradeAnswersAndAdvance = (params: {
  gameSessionId: string;
  presenterPlayerId: string;
  correctPlayerIds: string[];
}) => rpc<{ gameSession: GameSession; room: Room | null; newlyScoredPlayerIds: string[] }>("gradeAnswersAndAdvance", params);

export const advanceReviewedQuestion = (params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedQuestionIndex: number;
}) =>
  rpc<{ gameSession: GameSession; room: Room | null }>("advanceReviewedQuestion", params);

export const updateQuestionLabel = (params: {
  gameSessionId: string;
  presenterPlayerId: string;
  questionId: string;
  labelText: string;
  source: "manual" | "answer";
  answerId?: string | null;
}) => rpc<Question>("updateQuestionLabel", params);

export const skipCurrentQuestion = (params: {
  gameSessionId: string;
  presenterPlayerId: string;
  expectedQuestionIndex: number;
}) =>
  rpc<{ gameSession: GameSession; room: Room | null }>("skipCurrentQuestion", params);

export const endCurrentGameEarly = (params: { gameSessionId: string; presenterPlayerId: string }) =>
  rpc<{ gameSession: GameSession; room: Room }>("endCurrentGameEarly", params);

export const returnRoomToLobby = (roomId: string, hostPlayerId: string) =>
  rpc<Room>("returnRoomToLobby", roomId, hostPlayerId);
