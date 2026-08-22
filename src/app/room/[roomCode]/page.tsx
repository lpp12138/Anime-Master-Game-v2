"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "@/lib/router";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/Button";
import { ImageRevealGame } from "@/components/ImageRevealGame";
import { Panel } from "@/components/Panel";
import { QuestionGuideButton } from "@/components/QuestionGuideButton";
import { QuestionSetUploader } from "@/components/QuestionSetUploader";
import { RoomChatBar, useRoomChat } from "@/components/RoomChat";
import { bindGameSessionRealtimeTopic, ensureRealtimeTopic, isRoomVersionExpiredError, subscribeRealtimeTopic } from "@/lib/cloudflareClient";
import { clearLocalRoomSession, getLocalSession, saveLocalSession } from "@/lib/localSession";
import { clearAllRoomChatMessages, clearRoomChatMessages } from "@/lib/roomChat";
import { GAME_MODE_LABELS } from "@/lib/gameModeLabels";
import { ROOM_VERSION_EXPIRED_EVENT, ROOM_VERSION_EXPIRED_MESSAGE } from "@/lib/roomRuntime";
import {
  cancelCurrentRound,
  cancelPresenterSetup,
  dissolveRoom,
  getGameResultSnapshot,
  getRoomWithPlayers,
  getQuestionSetRatingProgress,
  joinRoom,
  kickPlayerFromRoom,
  leaveRoom,
  rateCommunityQuestionSet,
  returnRoomToLobby,
  selectPresenterForRound,
  selectTeamForPlayer,
  startGameWithQuestionSet,
  updateRoomGameSettings,
  updateRoomNotice,
  updatePlayerRole,
} from "@/lib/cloudflareRooms";
import type {
  GameMode,
  GameResultQuestionScore,
  GameResultSnapshot,
  GameSession,
  LeaderboardEntry,
  Player,
  PlayerRole,
  QuestionSet,
  RealtimeDelta,
  Room,
  RoomStatus,
  TeamBattleTeam,
  TeamAssignmentMode,
} from "@/types/game";
import {
  DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
  DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
  MAX_GAME_QUESTION_COUNT,
  MAX_ROOM_NOTICE_LENGTH,
} from "@/types/game";

const statusText: Record<RoomStatus, string> = {
  LOBBY: "房间大厅",
  QUESTION_SETUP: "出题人准备题库",
  PLAYING: "游戏中",
  GAME_RESULT: "本局结算",
};
const PLAYER_CAPACITY_FULL_ERROR_CODE = "PLAYER_CAPACITY_FULL";
const TEAM_SELECTION_REQUIRED_ERROR_CODE = "TEAM_SELECTION_REQUIRED";
const RED_TEAM_CHOICE_BUTTON_CLASS = "min-h-10 rounded-md bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50";
const BLUE_TEAM_CHOICE_BUTTON_CLASS = "min-h-10 rounded-md bg-sky-50 px-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50";
const START_GAME_ATTEMPT_STORAGE_PREFIX = "anime-master:start-game-attempt:";
const START_GAME_ATTEMPT_TTL_MS = 30 * 60 * 1000;
const START_GAME_REQUEST_ID_CONFLICT = "START_GAME_REQUEST_ID_CONFLICT";
const gameResultSnapshotCache = new Map<string, GameResultSnapshot>();

type GameSettings = {
  gameMode: GameMode;
  maxRevealRounds: number;
  roundSeconds: number;
  roundScores: number[];
  teamRevealVoteSeconds: number;
  teamGuessVoteSeconds: number;
  teamPresenterBlockEnabled: boolean;
  spectatorQuestionPreviewEnabled: boolean;
  spectatorPlayerAnswersEnabled: boolean;
  playerCapacity: number;
  spectatorCapacity: number;
  teamAssignmentMode: TeamAssignmentMode;
  questionCount: number | null;
  /** 房间级“包含 R18 题目”开关；默认关闭。 */
  includeR18: boolean;
  /** 房间级“翻格解锁 Tag 提示”开关；默认关闭。 */
  tagHintsEnabled: boolean;
  /** 每翻出多少格解锁一个 Tag 提示（1-15）；默认 5。 */
  tagHintBlockStep: number;
};

const defaultGameSettings: GameSettings = {
  gameMode: "ROUND_REVEAL",
  maxRevealRounds: 3,
  roundSeconds: 45,
  roundScores: [5, 3, 1],
  teamRevealVoteSeconds: DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
  teamGuessVoteSeconds: DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
  teamPresenterBlockEnabled: false,
  spectatorQuestionPreviewEnabled: true,
  spectatorPlayerAnswersEnabled: true,
  playerCapacity: 50,
  spectatorCapacity: 50,
  teamAssignmentMode: "MANUAL",
  questionCount: null,
  includeR18: false,
  tagHintsEnabled: false,
  tagHintBlockStep: 5,
};

function createStartRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `start_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

type StartGameAttempt = {
  key: string;
  requestId: string;
  createdAt: number;
};

function getStoredStartGameAttempt(roomId: string): StartGameAttempt | null {
  try {
    const storageKey = `${START_GAME_ATTEMPT_STORAGE_PREFIX}${roomId}`;
    const value = window.sessionStorage.getItem(storageKey);
    if (!value) {
      return null;
    }

    const parsed = JSON.parse(value) as { key?: unknown; requestId?: unknown; createdAt?: unknown };
    if (
      typeof parsed.key === "string" &&
      typeof parsed.requestId === "string" &&
      typeof parsed.createdAt === "number" &&
      Date.now() - parsed.createdAt < START_GAME_ATTEMPT_TTL_MS
    ) {
      return { key: parsed.key, requestId: parsed.requestId, createdAt: parsed.createdAt };
    }

    window.sessionStorage.removeItem(storageKey);
  } catch {
    // sessionStorage may be unavailable in restricted browsing modes.
  }

  return null;
}

function storeStartGameAttempt(roomId: string, attempt: StartGameAttempt | null) {
  try {
    const storageKey = `${START_GAME_ATTEMPT_STORAGE_PREFIX}${roomId}`;
    if (attempt) {
      window.sessionStorage.setItem(storageKey, JSON.stringify(attempt));
    } else {
      window.sessionStorage.removeItem(storageKey);
    }
  } catch {
    // The in-memory ref still preserves retries while this page remains mounted.
  }
}

function normalizeGameSettings(settings: Partial<GameSettings>): GameSettings {
  const rawMaxRevealRounds =
    typeof settings.maxRevealRounds === "number" && Number.isFinite(settings.maxRevealRounds)
      ? settings.maxRevealRounds
      : defaultGameSettings.maxRevealRounds;
  const rawRoundSeconds =
    typeof settings.roundSeconds === "number" && Number.isFinite(settings.roundSeconds)
      ? settings.roundSeconds
      : defaultGameSettings.roundSeconds;
  const maxRevealRounds = Math.max(1, Math.min(10, Math.floor(rawMaxRevealRounds)));
  const sourceScores = Array.isArray(settings.roundScores) ? settings.roundScores : defaultGameSettings.roundScores;
  const normalizeTeamSeconds = (value: unknown, fallback: number) =>
    Math.max(1, Math.min(600, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : fallback)));

  return {
    gameMode: settings.gameMode ?? defaultGameSettings.gameMode,
    maxRevealRounds,
    roundSeconds: Math.max(1, Math.min(600, Math.floor(rawRoundSeconds))),
    roundScores: Array.from({ length: maxRevealRounds }, (_, index) => {
      const score = sourceScores[index] ?? Math.max(1, maxRevealRounds - index);
      return Math.max(0, Math.floor(typeof score === "number" && Number.isFinite(score) ? score : 0));
    }),
    teamRevealVoteSeconds: normalizeTeamSeconds(
      settings.teamRevealVoteSeconds,
      DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS,
    ),
    teamGuessVoteSeconds: normalizeTeamSeconds(
      settings.teamGuessVoteSeconds,
      DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS,
    ),
    teamPresenterBlockEnabled: settings.teamPresenterBlockEnabled === true,
    spectatorQuestionPreviewEnabled: settings.spectatorQuestionPreviewEnabled !== false,
    spectatorPlayerAnswersEnabled: settings.spectatorPlayerAnswersEnabled !== false,
    playerCapacity: Math.max(1, Math.min(50, Math.floor(settings.playerCapacity ?? 50))),
    spectatorCapacity: Math.max(0, Math.min(50, Math.floor(settings.spectatorCapacity ?? 50))),
    teamAssignmentMode: settings.teamAssignmentMode === "AUTO" ? "AUTO" : "MANUAL",
    questionCount:
      typeof settings.questionCount === "number" &&
      Number.isInteger(settings.questionCount) &&
      settings.questionCount >= 1 &&
      settings.questionCount <= MAX_GAME_QUESTION_COUNT
        ? settings.questionCount
        : null,
    includeR18: settings.includeR18 === true,
    tagHintsEnabled: settings.tagHintsEnabled === true,
    tagHintBlockStep:
      typeof settings.tagHintBlockStep === "number" &&
      Number.isInteger(settings.tagHintBlockStep) &&
      settings.tagHintBlockStep >= 1 &&
      settings.tagHintBlockStep <= 15
        ? settings.tagHintBlockStep
        : 5,
  };
}

function getRoomGameSettings(room: Room | null | undefined): GameSettings {
  return normalizeGameSettings({
    gameMode: room?.gameMode,
    maxRevealRounds: room?.maxRevealRounds,
    roundSeconds: room?.roundSeconds,
    roundScores: room?.roundScores,
    teamRevealVoteSeconds: room?.teamRevealVoteSeconds,
    teamGuessVoteSeconds: room?.teamGuessVoteSeconds,
    teamPresenterBlockEnabled: room?.teamPresenterBlockEnabled,
    spectatorQuestionPreviewEnabled: room?.spectatorQuestionPreviewEnabled,
    spectatorPlayerAnswersEnabled: room?.spectatorPlayerAnswersEnabled,
    playerCapacity: room?.playerCapacity,
    spectatorCapacity: room?.spectatorCapacity,
    teamAssignmentMode: room?.teamAssignmentMode,
    questionCount: room?.questionCount,
    includeR18: room?.includeR18 === true,
    tagHintsEnabled: room?.tagHintsEnabled === true,
    tagHintBlockStep: room?.tagHintBlockStep,
  });
}

function areGameSettingsEqual(left: GameSettings, right: GameSettings) {
  return (
    left.gameMode === right.gameMode &&
    left.maxRevealRounds === right.maxRevealRounds &&
    left.roundSeconds === right.roundSeconds &&
    left.roundScores.length === right.roundScores.length &&
    left.roundScores.every((score, index) => score === right.roundScores[index]) &&
    left.teamRevealVoteSeconds === right.teamRevealVoteSeconds &&
    left.teamGuessVoteSeconds === right.teamGuessVoteSeconds &&
    left.teamPresenterBlockEnabled === right.teamPresenterBlockEnabled &&
    left.spectatorQuestionPreviewEnabled === right.spectatorQuestionPreviewEnabled &&
    left.spectatorPlayerAnswersEnabled === right.spectatorPlayerAnswersEnabled &&
    left.playerCapacity === right.playerCapacity &&
    left.spectatorCapacity === right.spectatorCapacity &&
    left.teamAssignmentMode === right.teamAssignmentMode &&
    left.questionCount === right.questionCount &&
    left.includeR18 === right.includeR18 &&
    left.tagHintsEnabled === right.tagHintsEnabled &&
    left.tagHintBlockStep === right.tagHintBlockStep
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRoom(value: unknown): value is Room {
  return isRecord(value) && typeof value.code === "string" && typeof value.status === "string";
}

function isQuestionSet(value: unknown): value is QuestionSet {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && "imageCount" in value;
}

function isGameResultSnapshot(value: unknown): value is GameResultSnapshot {
  return (
    isRecord(value) &&
    isRecord(value.gameSession) &&
    Array.isArray(value.leaderboard) &&
    ("questionSet" in value) &&
    Array.isArray(value.questionScores)
  );
}

function getBroadcastRoom(result: unknown) {
  if (isRoom(result)) {
    return result;
  }

  if (isRecord(result) && isRoom(result.room)) {
    return result.room;
  }

  return null;
}

function getBroadcastQuestionSet(result: unknown) {
  if (isQuestionSet(result)) {
    return result;
  }

  if (isRecord(result) && isQuestionSet(result.questionSet)) {
    return result.questionSet;
  }

  return null;
}

function getBroadcastGameResultSnapshot(message: {
  result?: unknown;
  delta?: RealtimeDelta;
  deltas?: RealtimeDelta[];
  gameResultSnapshot?: GameResultSnapshot;
}) {
  if (isGameResultSnapshot(message.gameResultSnapshot)) {
    return message.gameResultSnapshot;
  }

  for (const delta of message.deltas ?? []) {
    if (delta.scope === "game" && delta.type === "game_result_snapshot") {
      return delta.snapshot;
    }
  }

  if (message.delta?.scope === "game" && message.delta.type === "game_result_snapshot") {
    return message.delta.snapshot;
  }

  if (isRecord(message.result) && isGameResultSnapshot(message.result.gameResultSnapshot)) {
    return message.result.gameResultSnapshot;
  }

  return null;
}

function cacheGameResultSnapshot(snapshot: GameResultSnapshot | null) {
  if (snapshot?.gameSession.id) {
    gameResultSnapshotCache.set(snapshot.gameSession.id, snapshot);
  }
}

function applyCachedGameResultSnapshot(
  snapshot: GameResultSnapshot,
  setters: {
    setLeaderboard: (leaderboard: LeaderboardEntry[]) => void;
    setGameSession: (gameSession: GameSession) => void;
    setQuestionSet: (questionSet: QuestionSet | null) => void;
    setQuestionScores: (questionScores: GameResultQuestionScore[]) => void;
  },
) {
  setters.setLeaderboard(snapshot.leaderboard);
  setters.setGameSession(snapshot.gameSession);
  setters.setQuestionSet(snapshot.questionSet);
  setters.setQuestionScores(snapshot.questionScores);
}

type GameModeCopy = {
  title: string;
  summary: string;
  rules: string[];
  settingsNote?: string;
};

const gameModeCopy: Record<GameMode, GameModeCopy> = {
  ROUND_REVEAL: {
    title: GAME_MODE_LABELS.ROUND_REVEAL,
    summary: "按轮得分，越早猜中分越高",
    rules: [
      "出题人逐轮打开画面，默认共 3 轮",
      "玩家在倒计时内提交答案",
      "猜中得当前轮分数，默认 5/3/1 分",
    ],
  },
  BUZZER_FIRST_CORRECT: {
    title: GAME_MODE_LABELS.BUZZER_FIRST_CORRECT,
    summary: "第一个答对的人得分，本题立即结束",
    rules: [
      "出题人逐轮打开画面，默认共 3 轮",
      "玩家在倒计时内抢答",
      "每轮限答 1 次",
      "第一个答对的人得 1 分，本题立即结束",
    ],
  },
  BUZZER_RANKED: {
    title: GAME_MODE_LABELS.BUZZER_RANKED,
    summary: "多人可得分，按答对顺序递减",
    rules: [
      "出题人逐轮打开画面，默认共 3 轮",
      "玩家在倒计时内抢答",
      "每轮限答 1 次",
      "多名玩家可答对得分，按答对顺序递减，最低 1 分",
    ],
  },
  TEAM_BATTLE: {
    title: GAME_MODE_LABELS.TEAM_BATTLE,
    summary: "两队在同一张截图上较量，谁先猜对谁得分",
    rules: [
      "红蓝两队看同一张被遮住的截图",
      "两队轮流行动，每次打开 1 个区块",
      "当前队伍可以猜答案；猜对得 1 分，本题立即结束",
      "猜错后，对方可额外打开 1 个区块",
    ],
    settingsNote: "至少需要 2 名答题玩家",
  },
};

const gameModeCommonRule = "每题截图会被格子遮住，出题人逐轮打开画面；玩家根据线索猜动画名";

function getPresenterName(players: Player[], presenterPlayerId?: string | null) {
  return players.find((player) => player.id === presenterPlayerId)?.nickname ?? "未选择";
}

function getTeamName(team: TeamBattleTeam) {
  return team === "red" ? "红队" : "蓝队";
}

function getTeamStyles(team: TeamBattleTeam) {
  return team === "red"
    ? {
        panel: "bg-red-50/60",
        badge: "bg-red-100 text-red-700 ring-red-200",
      }
    : {
        panel: "bg-sky-50/70",
        badge: "bg-sky-100 text-sky-700 ring-sky-200",
      };
}

function getRealtimeDeltas(message: { delta?: RealtimeDelta; deltas?: RealtimeDelta[] }) {
  return message.deltas ?? (message.delta ? [message.delta] : []);
}

function getRealtimeVersion(message: { version?: number }) {
  return typeof message.version === "number" && Number.isFinite(message.version) ? message.version : null;
}

function isQuestionSetUpdatedDelta(
  delta: RealtimeDelta,
): delta is Extract<RealtimeDelta, { scope: "question-set"; type: "question_set_updated" }> {
  return delta.scope === "question-set" && delta.type === "question_set_updated";
}

function isRoomUpdatedDelta(delta: RealtimeDelta): delta is Extract<RealtimeDelta, { scope: "room"; type: "room_updated" }> {
  return delta.scope === "room" && delta.type === "room_updated";
}

function isRoomNoticeUpdatedDelta(
  delta: RealtimeDelta,
): delta is Extract<RealtimeDelta, { scope: "room"; type: "room_notice_updated" }> {
  return delta.scope === "room" && delta.type === "room_notice_updated";
}

function isRoomDissolvedDelta(delta: RealtimeDelta): delta is Extract<RealtimeDelta, { scope: "room"; type: "room_dissolved" }> {
  return delta.scope === "room" && delta.type === "room_dissolved";
}

function getResultRankStyles(rank: number) {
  if (rank === 1) {
    return {
      row: "bg-amber-50/80",
      badge: "bg-gradient-to-br from-yellow-100 via-amber-400 to-yellow-700 text-amber-950 ring-amber-400",
    };
  }

  if (rank === 2) {
    return {
      row: "bg-slate-100/80",
      badge: "bg-gradient-to-br from-slate-50 via-slate-300 to-slate-500 text-slate-950 ring-slate-400",
    };
  }

  if (rank === 3) {
    return {
      row: "bg-orange-50/70",
      badge: "bg-gradient-to-br from-orange-200 via-orange-700 to-stone-700 text-white ring-orange-400",
    };
  }

  return {
    row: "",
    badge: "bg-white text-slate-600 ring-[var(--line)]",
  };
}

function getCompetitionRankByScore<T extends { score: number }>(rows: T[], index: number): number {
  const previousRow = rows[index - 1];

  return previousRow && previousRow.score === rows[index].score ? getCompetitionRankByScore(rows, index - 1) : index + 1;
}

function getQuestionScoreClass(score: number, maxScore: number) {
  if (score <= 0) {
    return "bg-slate-50 text-slate-300 ring-slate-100";
  }

  if (score === maxScore) {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }

  return "bg-white text-slate-800 ring-slate-200";
}

function getRoomCodeFromLocation() {
  const roomMatch = window.location.pathname.match(/^\/room\/([^/]+)/);
  return roomMatch ? decodeURIComponent(roomMatch[1]) : "";
}

function getPlayerJoinedAtTime(player: Player) {
  if (typeof player.joinedAt === "number") {
    return player.joinedAt;
  }

  const timestamp = Date.parse(player.joinedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function sortPlayersByJoinedAt(players: Player[]) {
  return [...players].sort((a, b) => getPlayerJoinedAtTime(a) - getPlayerJoinedAtTime(b) || a.id.localeCompare(b.id));
}

function getGamePlayers(players: Player[]) {
  return players.filter((player) => player.role !== "SPECTATOR");
}

function getSpectators(players: Player[]) {
  return players.filter((player) => player.role === "SPECTATOR");
}

function isPlayerCapacityError(errorCode: string | null | undefined) {
  return errorCode === PLAYER_CAPACITY_FULL_ERROR_CODE;
}

function isTeamSelectionRequired(errorCode: string | null | undefined) {
  return errorCode === TEAM_SELECTION_REQUIRED_ERROR_CODE;
}

function canSwitchPlayerRole(room: Room | null | undefined, isCurrentPresenter: boolean) {
  return Boolean(room && (room.status === "LOBBY" || (room.status === "QUESTION_SETUP" && !isCurrentPresenter)));
}

function PlayerList({
  players,
  playerId,
  presenterPlayerId,
  gameMode,
  teamAssignmentMode,
  teamAssignments,
  pendingTeam,
  onSelectTeam,
  spectatorAction,
  action,
}: {
  players: Player[];
  playerId: string;
  presenterPlayerId?: string | null;
  gameMode: GameMode;
  teamAssignmentMode?: TeamAssignmentMode;
  teamAssignments?: Partial<Record<string, TeamBattleTeam>>;
  pendingTeam?: TeamBattleTeam | null;
  onSelectTeam?: (team: TeamBattleTeam) => void;
  spectatorAction?: ReactNode;
  action?: ReactNode;
}) {
  const sortedPlayers = sortPlayersByJoinedAt(getGamePlayers(players)).sort((left, right) => {
    if (gameMode !== "TEAM_BATTLE" || teamAssignmentMode !== "MANUAL") return 0;
    const order = (player: Player) => player.id === presenterPlayerId ? 2 : teamAssignments?.[player.id] === "red" ? 0 : teamAssignments?.[player.id] === "blue" ? 1 : 2;
    return order(left) - order(right);
  });
  const sortedSpectators = sortPlayersByJoinedAt(getSpectators(players));
  const title = `玩家 ${sortedPlayers.length}`;

  return (
    <div className="space-y-4">
      <Panel title={title} action={action}>
        <div className="space-y-3">
          {sortedPlayers.length > 0 ? (
            sortedPlayers.map((player, index) => {
              const isPresenter = player.id === presenterPlayerId;
              const assignedTeam =
                gameMode === "TEAM_BATTLE" && teamAssignmentMode === "MANUAL" && !isPresenter
                  ? teamAssignments?.[player.id] ?? null
                  : null;
              const canChooseTeam = gameMode === "TEAM_BATTLE" && teamAssignmentMode === "MANUAL" && player.id === playerId && !isPresenter;

              return (
                <div
                  className={`rounded-md border bg-white px-3 py-3 shadow-sm ${assignedTeam === "red" ? "border-rose-200" : assignedTeam === "blue" ? "border-sky-200" : "border-[var(--line)]"}`}
                  key={player.id}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-md text-sm font-bold text-white ${assignedTeam === "red" ? "bg-rose-600" : assignedTeam === "blue" ? "bg-sky-600" : "bg-slate-900"}`}>
                        {index + 1}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{player.nickname}</p>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                          {player.id === playerId ? <span>你</span> : null}
                          {isPresenter ? <span>本局出题人 · 裁判</span> : null}
                          {assignedTeam === "red" ? <span className="font-semibold text-rose-700">红队</span> : null}
                          {assignedTeam === "blue" ? <span className="font-semibold text-sky-700">蓝队</span> : null}
                          {gameMode === "TEAM_BATTLE" && teamAssignmentMode === "MANUAL" && !isPresenter && !assignedTeam ? <span className="font-semibold text-amber-700">未入队</span> : null}
                        </div>
                      </div>
                    </div>
                    <span className={player.isHost ? "shrink-0 rounded bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700" : "shrink-0 rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600"}>
                      {player.isHost ? "房主" : "玩家"}
                    </span>
                  </div>
                  {canChooseTeam ? (
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3">
                      <button className={RED_TEAM_CHOICE_BUTTON_CLASS} disabled={Boolean(pendingTeam)} type="button" onClick={() => onSelectTeam?.("red")}>{pendingTeam === "red" ? "加入中…" : assignedTeam === "red" ? "已在红队" : "加入红队"}</button>
                      <button className={BLUE_TEAM_CHOICE_BUTTON_CLASS} disabled={Boolean(pendingTeam)} type="button" onClick={() => onSelectTeam?.("blue")}>{pendingTeam === "blue" ? "加入中…" : assignedTeam === "blue" ? "已在蓝队" : "加入蓝队"}</button>
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="rounded-md border border-[var(--line)] bg-slate-50 px-3 py-3 text-sm text-[var(--muted)]">
              当前没有可参赛玩家
            </p>
          )}
        </div>
      </Panel>

      <Panel title={`观战区 ${sortedSpectators.length}`} action={spectatorAction}>
        <div className="space-y-2">
          {sortedSpectators.length > 0 ? (
            sortedSpectators.map((player) => (
              <div
                className="flex items-center justify-between gap-3 rounded-md border border-[var(--line)] bg-slate-50 px-3 py-2"
                key={player.id}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-950">{player.nickname}</p>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                    {player.id === playerId ? <span>你</span> : null}
                    {player.isHost ? <span>房主</span> : null}
                  </div>
                </div>
                <span className="shrink-0 rounded bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700">观战</span>
              </div>
            ))
          ) : (
            <p className="rounded-md border border-[var(--line)] bg-white px-3 py-3 text-sm text-[var(--muted)]">
              还没有观战者
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}

function StepGuide({ room, isHost, isCurrentPresenter }: { room: Room; isHost: boolean; isCurrentPresenter: boolean }) {
  let text = "等待房主选择本局出题人";

  if (room.status === "LOBBY") {
    text = isHost ? "先在大厅设置本局参数，然后选择一名出题人" : "等待房主设置参数并选择出题人";
  } else if (room.status === "QUESTION_SETUP") {
    text = isCurrentPresenter
      ? "上传图片、导入题单JSONL或选择社区题库。确认后等待房主开始。"
      : room.preparedQuestionSetId
        ? "出题人已准备好题库，等待房主开始游戏"
        : "等待出题人准备题库";
  } else if (room.status === "GAME_RESULT") {
    text = isHost ? "查看排行榜、发布或评分题库后，可以回到房间大厅开始下一局" : "查看排行榜并评分，等待房主回到大厅";
  }

  return <p className="mt-4 rounded-md border border-rose-100 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">{text}</p>;
}

function getLobbyActionText(room: Room, isHost: boolean, isCurrentPresenter: boolean) {
  if (room.status === "LOBBY") {
    return isHost ? "选择本局出题人" : "等待房主选择出题人";
  }

  if (room.status === "QUESTION_SETUP") {
    if (isCurrentPresenter && !room.preparedQuestionSetId) {
      return "准备题库";
    }

    if (room.preparedQuestionSetId) {
      return isHost ? "题库已准备，可以开始" : "题库已准备，等待房主开始";
    }

    return "等待出题人准备题库";
  }

  return statusText[room.status];
}

function PresenterPicker({
  room,
  pendingPresenterId,
  onSelectPresenter,
}: {
  room: Room;
  pendingPresenterId: string;
  onSelectPresenter: (presenterPlayerId: string) => void;
}) {
  const gamePlayers = getGamePlayers(room.players);

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {gamePlayers.length > 0 ? (
        gamePlayers.map((player) => (
          <button
            className="flex min-h-14 w-full items-center justify-between gap-3 rounded-md border border-[var(--line)] bg-white px-3 py-2 text-left transition hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(pendingPresenterId)}
            key={player.id}
            type="button"
            onClick={() => onSelectPresenter(player.id)}
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-slate-950">{player.nickname}</span>
              <span className="mt-0.5 block text-xs text-[var(--muted)]">{player.isHost ? "房主" : "玩家"}</span>
            </span>
            <span className="shrink-0 text-sm font-semibold text-[var(--primary)]">
              {pendingPresenterId === player.id ? "选择中…" : "选择"}
            </span>
          </button>
        ))
      ) : (
        <p className="rounded-md border border-[var(--line)] bg-slate-50 px-3 py-3 text-sm text-[var(--muted)]">
          当前没有玩家身份的成员，无法选择出题人
        </p>
      )}
    </div>
  );
}

function PresenterPickerModal({
  room,
  isOpen,
  pendingPresenterId,
  onSelectPresenter,
  onClose,
}: {
  room: Room;
  isOpen: boolean;
  pendingPresenterId: string;
  onSelectPresenter: (presenterPlayerId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 px-4 py-6" role="presentation" onMouseDown={onClose}>
      <div
        aria-modal="true"
        className="max-h-[calc(100dvh-48px)] w-full max-w-xl overflow-y-auto rounded-lg border border-[var(--line)] bg-white p-5 shadow-2xl"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-950">选择出题人</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--muted)]">选中后由这名玩家准备题库，房主稍后开始游戏</p>
          </div>
          <button
            aria-label="关闭选择出题人弹窗"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-[var(--line)] text-xl leading-none text-slate-500 transition hover:bg-slate-50"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="mt-5">
          <PresenterPicker room={room} pendingPresenterId={pendingPresenterId} onSelectPresenter={onSelectPresenter} />
        </div>
      </div>
    </div>
  );
}

function KickPlayerModal({
  room,
  isOpen,
  pendingKickPlayerId,
  onKickPlayer,
  onClose,
}: {
  room: Room;
  isOpen: boolean;
  pendingKickPlayerId: string;
  onKickPlayer: (targetPlayerId: string) => void;
  onClose: () => void;
}) {
  const kickablePlayers = sortPlayersByJoinedAt(room.players.filter((player) => player.id !== room.hostPlayerId));

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pendingKickPlayerId) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, pendingKickPlayerId]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 px-4 py-6"
      role="presentation"
      onMouseDown={() => {
        if (!pendingKickPlayerId) {
          onClose();
        }
      }}
    >
      <div
        aria-modal="true"
        className="max-h-[calc(100dvh-48px)] w-full max-w-xl overflow-y-auto rounded-lg border border-[var(--line)] bg-white p-5 shadow-2xl"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-950">踢出玩家</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--muted)]">选择要移出房间的玩家</p>
          </div>
          <button
            aria-label="关闭踢出玩家弹窗"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-[var(--line)] text-xl leading-none text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={Boolean(pendingKickPlayerId)}
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {kickablePlayers.length > 0 ? (
          <div className="mt-5 grid gap-2">
            {kickablePlayers.map((player) => {
              const isPresenter = player.id === room.currentPresenterPlayerId;
              const canKickPlayer = !(room.status === "PLAYING" && isPresenter);
              return (
                <div
                  className="flex items-center justify-between gap-3 rounded-md border border-[var(--line)] bg-white px-3 py-3 shadow-sm"
                  key={player.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-950">{player.nickname}</p>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                      <span>{player.role === "SPECTATOR" ? "观战" : "玩家"}</span>
                      {isPresenter ? <span>当前出题人</span> : null}
                    </div>
                  </div>
                  <Button
                    className="h-10 shrink-0 px-3"
                    disabled={Boolean(pendingKickPlayerId) || !canKickPlayer}
                    type="button"
                    variant="secondary"
                    onClick={() => onKickPlayer(player.id)}
                  >
                    {pendingKickPlayerId === player.id ? "踢出中…" : canKickPlayer ? "踢出" : "不可踢"}
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-5 rounded-md border border-[var(--line)] bg-slate-50 px-4 py-3 text-sm text-[var(--muted)]">
            当前没有可踢出的玩家
          </p>
        )}
      </div>
    </div>
  );
}

function CancelRoundConfirmModal({
  isOpen,
  isCancelingRound,
  onConfirm,
  onClose,
}: {
  isOpen: boolean;
  isCancelingRound: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isCancelingRound) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCancelingRound, isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 px-4 py-6"
      role="presentation"
      onMouseDown={() => {
        if (!isCancelingRound) {
          onClose();
        }
      }}
    >
      <div
        aria-modal="true"
        className="w-full max-w-md rounded-lg border border-[var(--line)] bg-white p-5 shadow-2xl"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-950">取消本局？</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              确认后会结束当前游戏流程，所有玩家回到房间大厅。
            </p>
          </div>
          <button
            aria-label="关闭取消本局确认弹窗"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-[var(--line)] text-xl leading-none text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isCancelingRound}
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose} disabled={isCancelingRound}>
            继续本局
          </Button>
          <Button type="button" onClick={onConfirm} disabled={isCancelingRound}>
            {isCancelingRound ? "取消中…" : "确认取消"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function GameSettingsPanel({
  settings,
  canEdit,
  hasQuestionSet,
  preparedQuestionCount,
  onChange,
}: {
  settings: GameSettings;
  canEdit: boolean;
  /** 是否已选择题库；未选择时不展示 R18 开关与题数滑条，只提示选择题库后可设置。 */
  hasQuestionSet: boolean;
  preparedQuestionCount?: number | null;
  onChange: (settings: GameSettings) => void;
}) {
  const isRoundRevealMode = settings.gameMode === "ROUND_REVEAL";
  const isTeamBattleMode = settings.gameMode === "TEAM_BATTLE";
  const copy = gameModeCopy[settings.gameMode];
  const availableQuestionCount =
    typeof preparedQuestionCount === "number" && preparedQuestionCount >= 1
      ? Math.min(MAX_GAME_QUESTION_COUNT, Math.floor(preparedQuestionCount))
      : 0;
  const sliderQuestionCount =
    settings.questionCount != null && settings.questionCount < availableQuestionCount
      ? settings.questionCount
      : availableQuestionCount;
  // 拖动/键盘调整期间只更新本地草稿，pointer 释放（Pointer Events 已覆盖触摸）、
  // 键盘操作结束或 blur 时才提交，避免 range 每个 onChange 都发 RPC 造成并发写与服务端乱序。
  const [sliderDraft, setSliderDraft] = useState<number | null>(null);
  const displayedSliderCount = Math.min(sliderDraft ?? sliderQuestionCount, availableQuestionCount || 1) || 1;
  const sliderAtMax = displayedSliderCount >= availableQuestionCount;
  const questionCountLabel =
    availableQuestionCount === 0
      ? "当前筛选没有可用题目，请开启包含 R18 或更换题库"
      : sliderAtMax
        ? availableQuestionCount >= MAX_GAME_QUESTION_COUNT
          // 上限 30 时无法区分题库正好 30 题还是超过 30 题，不承诺“全部保持顺序”。
          ? `本局最多 ${MAX_GAME_QUESTION_COUNT} 道（大题库会随机抽取）`
          : `全部 ${availableQuestionCount} 道（保持题库顺序）`
        : `随机抽取 ${displayedSliderCount} 道（无重复）`;

  function commitSliderDraft() {
    if (sliderDraft == null) return;
    // 滑到最大映射为 null（全部可用题目）；少于最大时随机无放回抽取。
    const nextCount = sliderDraft >= availableQuestionCount ? null : sliderDraft;
    setSliderDraft(null);
    // 避免重复提交相同值：与已生效设置一致时不再发 RPC。
    if (nextCount === settings.questionCount) return;
    onChange({ ...settings, questionCount: nextCount });
  }

  // 失去编辑权或题库不可用（如开关切换后可用题数为 0）时丢弃未提交草稿，避免恢复后滑条跳变。
  useEffect(() => {
    if (!canEdit || availableQuestionCount === 0) setSliderDraft(null);
  }, [canEdit, availableQuestionCount]);

  function updateRounds(nextRounds: number) {
    onChange({
      ...settings,
      maxRevealRounds: nextRounds,
      roundScores: Array.from(
        { length: nextRounds },
        (_, index) => settings.roundScores[index] ?? Math.max(1, nextRounds - index),
      ),
    });
  }

  function updateScore(index: number, score: number) {
    onChange({
      ...settings,
      roundScores: settings.roundScores.map((currentScore, scoreIndex) => (scoreIndex === index ? score : currentScore)),
    });
  }

  return (
    <div className="rounded-md border border-[var(--line)] bg-white">
      <div className="border-b border-[var(--line)] bg-slate-50 px-4 py-3">
        <p className="text-sm font-semibold text-slate-950">游戏说明</p>
        <p className="mt-1 text-sm leading-6 text-slate-700">{gameModeCommonRule}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
        <div className="p-4">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-900">游戏模式</span>
            <select
              className="h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none transition disabled:bg-slate-100 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
              disabled={!canEdit}
              value={settings.gameMode}
              onChange={(event) => onChange({ ...settings, gameMode: event.target.value as GameMode })}
            >
              {(Object.keys(gameModeCopy) as GameMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {gameModeCopy[mode].title}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{copy.summary}</p>
          {!canEdit ? <p className="mt-3 text-sm text-[var(--muted)]">当前只能查看，不能修改</p> : null}
        </div>

        <div className="border-t border-[var(--line)] p-4 lg:border-l lg:border-t-0">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-900">具体规则</p>
            <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">{copy.title}</span>
          </div>
          <ol className="mt-3 grid gap-2">
            {copy.rules.map((rule, index) => (
              <li className="flex gap-2 text-sm leading-6 text-slate-700" key={rule}>
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-slate-900 text-[11px] font-bold text-white">
                  {index + 1}
                </span>
                <span>{rule}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="border-t border-[var(--line)] bg-amber-50/60 px-4 py-4">
        {!hasQuestionSet ? (
          <p className="text-sm leading-6 text-[var(--muted)]">选择题库后可设置 R18 与随机题数</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <label className="flex min-w-0 cursor-pointer items-center gap-2">
                <input
                  aria-label="包含 R18 题目"
                  checked={settings.includeR18}
                  className="h-4 w-4 shrink-0 accent-rose-600"
                  disabled={!canEdit}
                  type="checkbox"
                  onChange={(event) =>
                    onChange({ ...settings, includeR18: event.target.checked })
                  }
                />
                <span className="text-sm font-semibold text-slate-900">包含 R18 题目</span>
              </label>
              <p className="min-w-0 text-xs leading-5 text-[var(--muted)]">
                默认关闭；关闭时本局不抽取标记为 R18 的题目，由服务端按开关过滤，可用题数会相应减少。
              </p>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <label className="flex min-w-0 cursor-pointer items-center gap-2">
                <input
                  aria-label="翻格解锁 Tag 提示"
                  checked={settings.tagHintsEnabled}
                  className="h-4 w-4 shrink-0 accent-violet-600"
                  disabled={!canEdit}
                  type="checkbox"
                  onChange={(event) =>
                    onChange({ ...settings, tagHintsEnabled: event.target.checked })
                  }
                />
                <span className="text-sm font-semibold text-slate-900">翻格解锁 Tag 提示</span>
              </label>
              <label className="flex min-w-0 items-center gap-2">
                <span className="text-xs font-semibold text-slate-700">每</span>
                <select
                  aria-label="Tag 提示解锁步长"
                  className="h-8 rounded-md border border-[var(--line)] bg-white px-2 text-sm"
                  disabled={!canEdit || !settings.tagHintsEnabled}
                  value={settings.tagHintBlockStep}
                  onChange={(event) =>
                    onChange({ ...settings, tagHintBlockStep: Number(event.target.value) })
                  }
                >
                  {[1, 2, 3, 4, 5, 6, 8, 10, 15].map((step) => (
                    <option key={step} value={step}>{step} 格</option>
                  ))}
                </select>
                <span className="text-xs font-semibold text-slate-700">解锁 1 个 Tag</span>
              </label>
              <p className="min-w-0 w-full text-xs leading-5 text-[var(--muted)]">
                默认关闭；开启后，游戏中每翻出指定格数会解锁当前图片的 1 个作品属性 Tag（异世界、年份等，来自 Bangumi），显示在图片下方、聊天框上方；未解锁的 Tag 以问号隐藏。
              </p>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span className="text-sm font-semibold text-slate-900">本局抽取题数</span>
                <span className="min-w-0 rounded bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900">
                  {availableQuestionCount > 0 ? questionCountLabel : "当前筛选没有可用题目，请开启包含 R18 或更换题库"}
                </span>
              </div>
              <div className="w-full max-w-md">
                <input
                  aria-label="本局抽取题数"
                  aria-valuetext={questionCountLabel}
                  className="h-8 w-full accent-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canEdit || availableQuestionCount === 0}
                  max={availableQuestionCount || 1}
                  min={1}
                  step={1}
                  type="range"
                  value={displayedSliderCount}
                  onChange={(event) => {
                    const nextCount = Number(event.target.value);
                    if (!Number.isInteger(nextCount) || nextCount < 1) return;
                    // 拖动过程中只更新本地显示，提交交给 onPointerUp/onKeyUp/onBlur。
                    setSliderDraft(Math.min(nextCount, availableQuestionCount || 1));
                  }}
                  onPointerUp={commitSliderDraft}
                  onKeyUp={(event) => {
                    // 键盘每步调整（方向键/Home/End/PageUp/PageDown）松开即提交最终值。
                    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
                      commitSliderDraft();
                    }
                  }}
                  onBlur={commitSliderDraft}
                />
                <div className="flex justify-between px-0.5 text-[11px] font-medium text-amber-800" aria-hidden="true">
                  <span>1</span>
                  <span>{availableQuestionCount || 1}</span>
                </div>
              </div>
            </div>
            <p className="mt-2 text-xs leading-5 text-[var(--muted)]">
              滑到最大时：不超过 30 道按题库顺序全部使用，超过 30 道由服务端随机抽满 30 道；少于最大时随机、无重复抽取并打乱顺序。开局后结果固定，刷新或重连不会重新抽题。
            </p>
          </>
        )}
      </div>

      <details className="border-t border-[var(--line)] px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">高级设置</summary>
        {copy.settingsNote ? <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{copy.settingsNote}</p> : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-900">玩家人数上限</span>
            <input
              className="h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none transition disabled:bg-slate-100 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
              disabled={!canEdit}
              min={1}
              max={50}
              type="number"
              value={settings.playerCapacity}
              onChange={(event) => onChange({
                ...settings,
                playerCapacity: Math.max(1, Math.min(50, Number(event.target.value) || 1)),
              })}
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-900">观战人数上限</span>
            <input
              className="h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none transition disabled:bg-slate-100 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
              disabled={!canEdit}
              min={0}
              max={50}
              type="number"
              value={settings.spectatorCapacity}
              onChange={(event) => onChange({
                ...settings,
                spectatorCapacity: Math.max(0, Math.min(50, Number(event.target.value) || 0)),
              })}
            />
          </label>
        </div>

        {!isTeamBattleMode ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-900">最多轮数</span>
              <input
                className="h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none transition disabled:bg-slate-100 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                disabled={!canEdit}
                min={1}
                max={10}
                type="number"
                value={settings.maxRevealRounds}
                onChange={(event) => updateRounds(Math.max(1, Math.min(10, Number(event.target.value) || 1)))}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-900">每轮秒数</span>
              <input
                className="h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none transition disabled:bg-slate-100 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                disabled={!canEdit}
                min={1}
                max={600}
                type="number"
                value={settings.roundSeconds}
                onChange={(event) =>
                  onChange({ ...settings, roundSeconds: Math.max(1, Math.min(600, Number(event.target.value) || 45)) })
                }
              />
            </label>
          </div>
        ) : null}

        {isRoundRevealMode ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {Array.from({ length: settings.maxRevealRounds }, (_, index) => (
              <label className="block" key={index}>
                <span className="mb-2 block text-sm font-medium text-slate-900">第 {index + 1} 轮分数</span>
                <input
                  className="h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none transition disabled:bg-slate-100 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                  disabled={!canEdit}
                  min={0}
                  type="number"
                  value={settings.roundScores[index] ?? 0}
                  onChange={(event) => updateScore(index, Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
            ))}
          </div>
        ) : isTeamBattleMode ? (
          <div className="mt-4 space-y-3">
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-slate-900">分队方式</legend>
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1.5">
                {(["AUTO", "MANUAL"] as const).map((mode) => {
                  const selected = settings.teamAssignmentMode === mode;
                  return (
                    <button
                      aria-pressed={selected}
                      className={`min-h-11 rounded-md px-3 text-sm font-semibold transition ${selected ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-950"}`}
                      disabled={!canEdit}
                      key={mode}
                      type="button"
                      onClick={() => onChange({ ...settings, teamAssignmentMode: mode })}
                    >
                      {mode === "AUTO" ? "自动分队" : "手动分队"}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--muted)]">
                {settings.teamAssignmentMode === "MANUAL"
                  ? "玩家在大厅自行选择红队或蓝队；切换回自动会清空当前分队。"
                  : "开始游戏时随机且尽量平均地分成红蓝两队。"}
              </p>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-slate-900">选格投票秒数</span>
                <input
                  className="h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none transition disabled:bg-slate-100 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                  disabled={!canEdit}
                  min={1}
                  max={600}
                  type="number"
                  value={settings.teamRevealVoteSeconds}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      teamRevealVoteSeconds: Math.max(
                        1,
                        Math.min(600, Number(event.target.value) || DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS),
                      ),
                    })
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-slate-900">猜测投票秒数</span>
                <input
                  className="h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none transition disabled:bg-slate-100 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                  disabled={!canEdit}
                  min={1}
                  max={600}
                  type="number"
                  value={settings.teamGuessVoteSeconds}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      teamGuessVoteSeconds: Math.max(
                        1,
                        Math.min(600, Number(event.target.value) || DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS),
                      ),
                    })
                  }
                />
              </label>
            </div>
            <label className="flex items-start justify-between gap-4 rounded-md border border-[var(--line)] bg-white px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-slate-900">出题人禁用格子</span>
                <span className="mt-1 block text-xs leading-5 text-[var(--muted)]">每题开始前增加禁选阶段；默认关闭。</span>
              </span>
              <input
                checked={settings.teamPresenterBlockEnabled}
                className="mt-1 h-5 w-5 shrink-0 accent-[var(--primary)]"
                disabled={!canEdit}
                type="checkbox"
                onChange={(event) => onChange({ ...settings, teamPresenterBlockEnabled: event.target.checked })}
              />
            </label>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 px-4 py-3 text-sm leading-6 text-[var(--muted)]">
              猜对队伍得 1 分；投票截止前可反复修改。
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-md border border-[var(--line)] bg-slate-50 px-4 py-3 text-sm leading-6 text-[var(--muted)]">
            {settings.gameMode === "BUZZER_FIRST_CORRECT" ? "固定得分：首个答对 +1" : "固定得分：按答对名次递减，最低 1 分"}
          </div>
        )}

        <div className={`mt-4 grid gap-3 ${settings.gameMode === "TEAM_BATTLE" ? "" : "sm:grid-cols-2"}`}>
          <label className="flex items-start justify-between gap-4 rounded-md border border-[var(--line)] bg-white px-4 py-3">
            <span>
              <span className="block text-sm font-medium text-slate-900">允许观战提前看题</span>
              <span className="mt-1 block text-xs text-[var(--muted)]">可看原图和正确答案</span>
            </span>
            <input
              checked={settings.spectatorQuestionPreviewEnabled}
              className="mt-1 h-5 w-5 shrink-0 accent-[var(--primary)]"
              disabled={!canEdit}
              type="checkbox"
              onChange={(event) => onChange({ ...settings, spectatorQuestionPreviewEnabled: event.target.checked })}
            />
          </label>
          {settings.gameMode !== "TEAM_BATTLE" ? (
            <label className="flex items-start justify-between gap-4 rounded-md border border-[var(--line)] bg-white px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-slate-900">允许观战查看回答</span>
                <span className="mt-1 block text-xs text-[var(--muted)]">显示玩家提交内容</span>
              </span>
              <input
                checked={settings.spectatorPlayerAnswersEnabled}
                className="mt-1 h-5 w-5 shrink-0 accent-[var(--primary)]"
                disabled={!canEdit}
                type="checkbox"
                onChange={(event) => onChange({ ...settings, spectatorPlayerAnswersEnabled: event.target.checked })}
              />
            </label>
          ) : null}
        </div>
      </details>
    </div>
  );
}

function LobbyMainPanel({
  room,
  settings,
  isHost,
  presenterName,
  isStartingGame,
  isUpdatingSettings,
  isCancelingRound,
  roomChat,
  onSettingsChange,
  onOpenPresenterPicker,
  onStartGame,
  onCancelRound,
}: {
  room: Room;
  settings: GameSettings;
  isHost: boolean;
  presenterName: string;
  isStartingGame: boolean;
  isUpdatingSettings: boolean;
  isCancelingRound: boolean;
  roomChat?: ReactNode;
  onSettingsChange: (settings: GameSettings) => void;
  onOpenPresenterPicker: () => void;
  onStartGame: () => void;
  onCancelRound: () => void;
}) {
  const actionText = getLobbyActionText(room, isHost, false);
  const hasQuestionSet = Boolean(room.preparedQuestionSetId);
  const preparedQuestionCount = room.preparedQuestionCount;
  const hasUsableQuestionSet =
    hasQuestionSet && typeof preparedQuestionCount === "number" && preparedQuestionCount >= 1;
  const canEditSettings = isHost && (room.status === "LOBBY" || room.status === "QUESTION_SETUP");
  const gamePlayerCount = getGamePlayers(room.players).length;
  const manualTeamStartIssue = (() => {
    if (settings.gameMode !== "TEAM_BATTLE" || settings.teamAssignmentMode !== "MANUAL") return null;
    const answerers = getGamePlayers(room.players).filter((player) => player.id !== room.currentPresenterPlayerId);
    const unassigned = answerers.filter((player) => !room.teamAssignments?.[player.id]);
    if (unassigned.length > 0) return `${unassigned.map((player) => player.nickname).join("、")}尚未选择队伍`;
    if (!answerers.some((player) => room.teamAssignments?.[player.id] === "red")) return "红队至少需要 1 名答题玩家";
    if (!answerers.some((player) => room.teamAssignments?.[player.id] === "blue")) return "蓝队至少需要 1 名答题玩家";
    return null;
  })();

  return (
    <Panel title="房间大厅">
      <div className="rounded-md border border-rose-100 bg-rose-50 px-5 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase text-rose-500">当前步骤</p>
            <p className="mt-1 text-2xl font-bold text-rose-950">{actionText}</p>
            <p className="mt-2 text-sm leading-6 text-rose-800">
              {room.status === "LOBBY"
                ? isHost
                  ? "先确认玩法，再选择一名出题人"
                  : "房主会选择玩法和出题人"
                : hasQuestionSet
                  ? isHost
                    ? "可以继续调整玩法，确认后开始游戏"
                    : "等待房主开始游戏"
                  : `当前出题人是 ${presenterName}`}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            {isHost && room.status === "LOBBY" ? (
              <Button type="button" onClick={onOpenPresenterPicker} disabled={gamePlayerCount === 0}>
                选择出题人
              </Button>
            ) : null}
            {isHost && room.status === "QUESTION_SETUP" ? (
              <>
                <Button type="button" onClick={onStartGame} disabled={isStartingGame || isUpdatingSettings || !hasUsableQuestionSet || Boolean(manualTeamStartIssue)}>
                  {isStartingGame ? "启动中…" : "开始游戏"}
                </Button>
                <Button type="button" variant="secondary" onClick={onCancelRound} disabled={isCancelingRound}>
                  {isCancelingRound ? "取消中…" : "取消本局"}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {hasQuestionSet && !hasUsableQuestionSet ? (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          当前筛选没有可用题目，请开启“包含 R18 题目”或更换题库
        </p>
      ) : null}

      {hasQuestionSet && manualTeamStartIssue ? (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          暂时不能开始：{manualTeamStartIssue}
        </p>
      ) : null}

      <div className="mt-5">
        <GameSettingsPanel
          settings={settings}
          canEdit={canEditSettings}
          hasQuestionSet={hasQuestionSet}
          preparedQuestionCount={room.preparedQuestionCount}
          onChange={onSettingsChange}
        />
      </div>

      {roomChat ? <div className="relative z-20 mt-5 border-t border-[var(--line)] pt-5">{roomChat}</div> : null}
    </Panel>
  );
}

type RatingProgress = {
  ratedCount: number;
  totalCount: number;
  ratedPlayerIds: string[];
  playerRating: number | null;
};

function GameResultPanel({
  room,
  currentGameId,
  playerId,
  isHost,
  isDissolving,
  isReturningToLobby,
  onDissolveRoom,
  onReturnToLobby,
  onError,
}: {
  room: Room;
  currentGameId?: string | null;
  playerId: string;
  isHost: boolean;
  isDissolving: boolean;
  isReturningToLobby: boolean;
  onDissolveRoom: () => void;
  onReturnToLobby: () => void;
  onError: (message: string) => void;
}) {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [gameSession, setGameSession] = useState<GameSession | null>(null);
  const [questionSet, setQuestionSet] = useState<QuestionSet | null>(null);
  const [questionScores, setQuestionScores] = useState<GameResultQuestionScore[]>([]);
  const [ratingProgress, setRatingProgress] = useState<RatingProgress | null>(null);
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] = useState(false);
  const [ratingValue, setRatingValue] = useState(5);
  const [isRating, setIsRating] = useState(false);
  const [isQuestionBrowserOpen, setIsQuestionBrowserOpen] = useState(false);

  const playerIds = useMemo(() => getGamePlayers(room.players).map((player) => player.id), [room.players]);
  const canRateQuestionSet = room.players.find((player) => player.id === playerId)?.role === "PLAYER";
  const questionPreviewItems = useMemo(
    () => (questionSet?.questions ?? []).slice().sort((a, b) => a.orderIndex - b.orderIndex),
    [questionSet?.questions],
  );

  useEffect(() => {
    if (!room.id || !currentGameId) {
      return;
    }

    const unbindGameSessionTopic = bindGameSessionRealtimeTopic(currentGameId, `room:${room.id}`);
    ensureRealtimeTopic(`room:${room.id}`, playerId);

    return () => {
      unbindGameSessionTopic();
    };
  }, [currentGameId, room.id]);

  useEffect(() => {
    if (!room.id || !currentGameId) {
      return;
    }

    return subscribeRealtimeTopic(`room:${room.id}`, (message) => {
      const snapshot = getBroadcastGameResultSnapshot(message);
      if (snapshot?.gameSession.id !== currentGameId) {
        return;
      }

      cacheGameResultSnapshot(snapshot);
      applyCachedGameResultSnapshot(snapshot, {
        setLeaderboard,
        setGameSession,
        setQuestionSet,
        setQuestionScores,
      });
    }, { playerId });
  }, [currentGameId, playerId, room.id]);

  useEffect(() => {
    let isMounted = true;

    async function loadLeaderboard() {
      if (!currentGameId) {
        setLeaderboard([]);
        setGameSession(null);
        setQuestionSet(null);
        setQuestionScores([]);
        setRatingProgress(null);
        return;
      }

      const cachedSnapshot = gameResultSnapshotCache.get(currentGameId);
      if (cachedSnapshot) {
        applyCachedGameResultSnapshot(cachedSnapshot, {
          setLeaderboard,
          setGameSession,
          setQuestionSet,
          setQuestionScores,
        });
        return;
      }

      setIsLoadingLeaderboard(true);
      try {
        const snapshot = await getGameResultSnapshot(currentGameId);

        if (isMounted) {
          cacheGameResultSnapshot(snapshot);
          applyCachedGameResultSnapshot(snapshot, {
            setLeaderboard,
            setGameSession,
            setQuestionSet,
            setQuestionScores,
          });
        }
      } catch (caughtError) {
        if (isMounted) {
          onError(caughtError instanceof Error ? caughtError.message : "加载排行榜失败");
        }
      } finally {
        if (isMounted) {
          setIsLoadingLeaderboard(false);
        }
      }
    }

    loadLeaderboard();

    return () => {
      isMounted = false;
    };
  }, [currentGameId, onError]);

  useEffect(() => {
    let isMounted = true;

    async function refreshRatingProgress() {
      if (!questionSet?.isPublic || !questionSet.id) {
        setRatingProgress(null);
        return;
      }

      try {
        const nextProgress = await getQuestionSetRatingProgress({
          questionSetId: questionSet.id,
          playerIds,
          playerId,
        });

        if (isMounted) {
          setRatingProgress(nextProgress);
          if (nextProgress.playerRating) {
            setRatingValue(nextProgress.playerRating);
          }
        }
      } catch (caughtError) {
        if (isMounted) {
          onError(caughtError instanceof Error ? caughtError.message : "加载评分进度失败");
        }
      }
    }

    refreshRatingProgress();

    return () => {
      isMounted = false;
    };
  }, [onError, playerId, playerIds, questionSet?.id, questionSet?.isPublic]);

  useEffect(() => {
    if (!room.id || !questionSet?.id) {
      return;
    }

    return subscribeRealtimeTopic(`room:${room.id}`, (message) => {
      const questionSetDelta = getRealtimeDeltas(message).find(
        (delta): delta is Extract<RealtimeDelta, { scope: "question-set"; type: "question_set_updated" }> =>
          isQuestionSetUpdatedDelta(delta) && delta.questionSet.id === questionSet.id,
      );
      const pushedQuestionSet = questionSetDelta?.questionSet ?? getBroadcastQuestionSet(message.result);
      if (pushedQuestionSet?.id === questionSet.id) {
        setQuestionSet(pushedQuestionSet);
        if (currentGameId) {
          const cachedSnapshot = gameResultSnapshotCache.get(currentGameId);
          if (cachedSnapshot) {
            gameResultSnapshotCache.set(currentGameId, {
              ...cachedSnapshot,
              questionSet: pushedQuestionSet,
            });
          }
        }

        if (questionSetDelta?.ratedPlayerId) {
          setRatingProgress((currentProgress) => {
            if (!currentProgress) {
              return currentProgress;
            }

            const ratedPlayerIds = Array.from(new Set([...currentProgress.ratedPlayerIds, questionSetDelta.ratedPlayerId ?? ""])).filter(
              Boolean,
            );

            return {
              ...currentProgress,
              ratedPlayerIds,
              ratedCount: ratedPlayerIds.length,
              playerRating:
                questionSetDelta.ratedPlayerId === playerId && typeof questionSetDelta.rating === "number"
                  ? questionSetDelta.rating
                  : currentProgress.playerRating,
            };
          });
        }
        return;
      }
    }, { playerId });
  }, [currentGameId, playerId, questionSet?.id, room.id]);

  useEffect(() => {
    if (!isQuestionBrowserOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsQuestionBrowserOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isQuestionBrowserOpen]);

  async function handleRateQuestionSet() {
    if (!questionSet || !room.id) {
      return;
    }

    setIsRating(true);
    try {
      const rated = await rateCommunityQuestionSet({
        questionSetId: questionSet.id,
        playerId,
        rating: ratingValue,
        roomId: room.id,
      });
      setQuestionSet(rated);
      setRatingProgress((currentProgress) => {
        if (!currentProgress) {
          return currentProgress;
        }

        const ratedPlayerIds = Array.from(new Set([...currentProgress.ratedPlayerIds, playerId]));
        return {
          ...currentProgress,
          ratedPlayerIds,
          ratedCount: ratedPlayerIds.length,
          playerRating: ratingValue,
        };
      });
    } catch (caughtError) {
      onError(caughtError instanceof Error ? caughtError.message : "评分失败");
    } finally {
      setIsRating(false);
    }
  }

  const canRate = Boolean(questionSet?.isPublic && canRateQuestionSet);
  const presenterName = getPresenterName(room.players, room.currentPresenterPlayerId);
  const isTeamBattleResult = gameSession?.gameMode === "TEAM_BATTLE" && Boolean(gameSession.teamBattleState);
  const playerById = new Map(room.players.map((player) => [player.id, player]));
  const questionCount = gameSession?.questionCount ?? questionSet?.questions?.length ?? questionSet?.imageCount ?? 0;
  const questionIndexes = Array.from({ length: questionCount }, (_, index) => index);
  const scoreByPlayerQuestion = new Map<string, number>();
  const scoreByTeamQuestion = new Map<string, number>();

  for (const result of questionScores) {
    const playerKey = `${result.playerId}:${result.questionIndex}`;
    scoreByPlayerQuestion.set(playerKey, (scoreByPlayerQuestion.get(playerKey) ?? 0) + result.scoreAwarded);

    if (gameSession?.teamBattleState && result.scoreAwarded > 0) {
      const team = (["red", "blue"] as const).find((currentTeam) =>
        gameSession.teamBattleState?.teams[currentTeam].includes(result.playerId),
      );

      if (team) {
        const teamKey = `${team}:${result.questionIndex}`;
        scoreByTeamQuestion.set(teamKey, Math.max(scoreByTeamQuestion.get(teamKey) ?? 0, result.scoreAwarded));
      }
    }
  }

  const teamRows = gameSession?.teamBattleState
    ? (["red", "blue"] as const)
        .map((team) => ({
          team,
          score: gameSession.teamBattleState?.teamScores[team] ?? 0,
          members: (gameSession.teamBattleState?.initialTeams?.[team] ?? gameSession.teamBattleState?.teams[team] ?? []).flatMap((memberId) => {
            const player = playerById.get(memberId);

            const nickname = player?.nickname ?? gameSession.teamBattleState?.teamMemberNames?.[memberId] ?? "已离开玩家";
            return [{ id: memberId, nickname }];
          }),
          questionScores: questionIndexes.map((questionIndex) => scoreByTeamQuestion.get(`${team}:${questionIndex}`) ?? 0),
        }))
        .sort((a, b) => b.score - a.score || (a.team === "red" ? -1 : 1))
        .map((row, index, rows) => ({
          ...row,
          rank: getCompetitionRankByScore(rows, index),
        }))
    : [];
  const playerRows = leaderboard.map((entry) => ({
    ...entry,
    questionScores: questionIndexes.map((questionIndex) => scoreByPlayerQuestion.get(`${entry.playerId}:${questionIndex}`) ?? 0),
  }));
  const questionMaxScores = questionIndexes.map((_, questionIndex) => {
    const scores = isTeamBattleResult
      ? teamRows.map((row) => row.questionScores[questionIndex] ?? 0)
      : playerRows.map((row) => row.questionScores[questionIndex] ?? 0);

    return Math.max(0, ...scores);
  });
  const ratingPercent =
    ratingProgress && ratingProgress.totalCount > 0 ? Math.round((ratingProgress.ratedCount / ratingProgress.totalCount) * 100) : 0;
  const questionScoreColumnWidth = 56;
  const teamLeaderboardWidth = 64 + 112 + 88 + 224 + questionCount * questionScoreColumnWidth;
  const playerLeaderboardWidth = 64 + 176 + 88 + 72 + questionCount * questionScoreColumnWidth;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="题库评分">
          {canRate ? (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-3xl font-bold text-slate-950">{Number(questionSet?.ratingAvg ?? 0).toFixed(1)}</p>
                  <p className="mt-1 text-sm text-[var(--muted)]">{questionSet?.ratingCount ?? 0} 人评分</p>
                </div>
                <p className="text-sm font-semibold text-slate-950">
                  {ratingProgress?.ratedCount ?? 0}/{ratingProgress?.totalCount ?? playerIds.length} 已完成
                </p>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-[var(--primary)]" style={{ width: `${ratingPercent}%` }} />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <select
                  className="h-10 rounded-md border border-[var(--line)] bg-white px-3 text-sm"
                  value={ratingValue}
                  onChange={(event) => setRatingValue(Number(event.target.value))}
                >
                  {[1, 2, 3, 4, 5].map((rating) => (
                    <option key={rating} value={rating}>
                      {rating} 星
                    </option>
                  ))}
                </select>
                <Button type="button" onClick={handleRateQuestionSet} disabled={isRating}>
                  {isRating ? "提交中…" : ratingProgress?.playerRating ? "修改评分" : "提交评分"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm leading-6 text-[var(--muted)]">
              {questionSet?.isPublic ? "观战者不参与本局题库评分" : "本局题库未发布到社区，暂不开放评分"}
            </p>
          )}
        </Panel>

        <Panel title="操作">
          <div className="rounded-md border border-[var(--line)] bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-950">{isHost ? "本局已结算" : "等待房主返回大厅"}</p>
            <p className={`mt-1 text-sm ${isHost ? "font-medium text-slate-950" : "text-[var(--muted)]"}`}>
              {isHost ? "看完排行榜后，建议解散当前房间并重开，避免离线玩家残留。" : "房主返回大厅后即可开始下一局"}
            </p>
          </div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsQuestionBrowserOpen(true)}
              disabled={questionPreviewItems.length === 0}
            >
              浏览题库
            </Button>
            {isHost ? (
              <div className="flex flex-col gap-3 sm:ml-auto sm:flex-row">
                <Button type="button" onClick={onDissolveRoom} disabled={isDissolving || isReturningToLobby}>
                  {isDissolving ? "解散中…" : "解散房间"}
                </Button>
                <Button type="button" onClick={onReturnToLobby} disabled={isDissolving || isReturningToLobby}>
                  {isReturningToLobby ? "返回中…" : "返回大厅"}
                </Button>
              </div>
            ) : (
              <p className="text-sm font-medium text-[var(--muted)] sm:ml-auto">等待房主操作</p>
            )}
          </div>
        </Panel>
      </div>

      <Panel
        title="本局排行榜"
        action={<span className="text-sm font-medium text-[var(--muted)]">出题人：{presenterName}</span>}
      >
        {isLoadingLeaderboard ? (
          <p className="text-sm text-[var(--muted)]">正在读取本局分数…</p>
        ) : isTeamBattleResult ? (
          <div className="overflow-x-auto rounded-lg border border-[var(--line)] bg-white">
            <table className="w-full table-fixed text-left text-sm" style={{ minWidth: `${teamLeaderboardWidth}px` }}>
              <colgroup>
                <col className="w-16" />
                <col className="w-28" />
                <col className="w-[88px]" />
                <col className="w-56" />
                {questionIndexes.map((questionIndex) => (
                  <col className="w-14" key={questionIndex} />
                ))}
                <col />
              </colgroup>
              <thead className="border-b border-[var(--line)] bg-slate-50 text-xs font-semibold text-slate-500">
                <tr>
                  <th className="px-4 py-3">排名</th>
                  <th className="px-3 py-3">队伍</th>
                  <th className="px-3 py-3 text-center">总分</th>
                  <th className="px-3 py-3">成员</th>
                  {questionIndexes.map((questionIndex) => (
                    <th className="px-2 py-3 text-center" key={questionIndex}>
                      Q{questionIndex + 1}
                    </th>
                  ))}
                  <th aria-hidden="true" className="px-0 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)] text-slate-700">
                {teamRows.map((row) => {
                  const rank = row.rank;
                  const styles = getTeamStyles(row.team);
                  const rankStyles = getResultRankStyles(rank);

                  return (
                    <tr className={[rankStyles.row, rank === 1 ? styles.panel : "", "transition hover:bg-slate-50"].join(" ")} key={row.team}>
                      <td className="px-4 py-3">
                        <span
                          className={[
                            "inline-grid h-8 min-w-8 place-items-center rounded-md px-2 text-sm font-bold ring-1 ring-inset tabular-nums",
                            rankStyles.badge,
                          ].join(" ")}
                        >
                          {rank}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span className={["inline-flex rounded px-2 py-1 text-xs font-bold ring-1 ring-inset", styles.badge].join(" ")}>
                          {getTeamName(row.team)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center text-base font-bold tabular-nums text-slate-950">{row.score}</td>
                      <td className="px-3 py-3">
                        <span className="block truncate text-sm text-[var(--muted)]" title={row.members.map((member) => member.nickname).join("、")}>
                          {row.members.map((member) => member.nickname).join("、")}
                        </span>
                      </td>
                      {row.questionScores.map((score, questionIndex) => (
                        <td className="px-2 py-3 text-center" key={questionIndex}>
                          <span
                            className={[
                              "inline-grid h-7 min-w-7 place-items-center rounded px-1.5 text-xs font-bold ring-1 ring-inset tabular-nums",
                              getQuestionScoreClass(score, questionMaxScores[questionIndex]),
                            ].join(" ")}
                          >
                            {score}
                          </span>
                        </td>
                      ))}
                      <td aria-hidden="true" className="px-0 py-3" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : leaderboard.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">本局没有玩家得分</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--line)] bg-white">
            <table className="w-full table-fixed text-left text-sm" style={{ minWidth: `${playerLeaderboardWidth}px` }}>
              <colgroup>
                <col className="w-16" />
                <col className="w-44" />
                <col className="w-[88px]" />
                <col className="w-[72px]" />
                {questionIndexes.map((questionIndex) => (
                  <col className="w-14" key={questionIndex} />
                ))}
                <col />
              </colgroup>
              <thead className="border-b border-[var(--line)] bg-slate-50 text-xs font-semibold text-slate-500">
                <tr>
                  <th className="px-4 py-3">排名</th>
                  <th className="px-3 py-3">玩家</th>
                  <th className="px-3 py-3 text-center">总分</th>
                  <th className="px-3 py-3 text-center">答对</th>
                  {questionIndexes.map((questionIndex) => (
                    <th className="px-2 py-3 text-center" key={questionIndex}>
                      Q{questionIndex + 1}
                    </th>
                  ))}
                  <th aria-hidden="true" className="px-0 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)] text-slate-700">
                {playerRows.map((entry) => {
                  const rankStyles = getResultRankStyles(entry.rank);

                  return (
                    <tr className={[rankStyles.row, "transition hover:bg-slate-50"].join(" ")} key={entry.playerId}>
                      <td className="px-4 py-3">
                        <span
                          className={[
                            "inline-grid h-8 min-w-8 place-items-center rounded-md px-2 text-sm font-bold ring-1 ring-inset tabular-nums",
                            rankStyles.badge,
                          ].join(" ")}
                        >
                          {entry.rank}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span className="block truncate font-semibold text-slate-950" title={entry.nickname}>
                          {entry.nickname}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center text-base font-bold tabular-nums text-slate-950">{entry.score}</td>
                      <td className="px-3 py-3 text-center font-medium tabular-nums">{entry.correctCount}</td>
                      {entry.questionScores.map((score, questionIndex) => (
                        <td className="px-2 py-3 text-center" key={questionIndex}>
                          <span
                            className={[
                              "inline-grid h-7 min-w-7 place-items-center rounded px-1.5 text-xs font-bold ring-1 ring-inset tabular-nums",
                              getQuestionScoreClass(score, questionMaxScores[questionIndex]),
                            ].join(" ")}
                          >
                            {score}
                          </span>
                        </td>
                      ))}
                      <td aria-hidden="true" className="px-0 py-3" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {isQuestionBrowserOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 px-4 py-6"
          role="presentation"
          onMouseDown={() => setIsQuestionBrowserOpen(false)}
        >
          <div
            aria-modal="true"
            className="flex max-h-[calc(100dvh-48px)] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-2xl"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-slate-950">浏览题库</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {questionSet?.title ? `${questionSet.title} · ${questionPreviewItems.length} 题` : `${questionPreviewItems.length} 题`}
                </p>
              </div>
              <button
                aria-label="关闭浏览题库弹窗"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-[var(--line)] text-xl leading-none text-slate-500 transition hover:bg-slate-50"
                type="button"
                onClick={() => setIsQuestionBrowserOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-4">
              {questionPreviewItems.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {questionPreviewItems.map((question, index) => (
                    <article className="overflow-hidden rounded-md border border-[var(--line)] bg-slate-50" key={question.id}>
                      <div className="aspect-video bg-slate-950">
                        <img
                          alt={`第 ${index + 1} 题图片`}
                          className="h-full w-full object-contain"
                          loading="lazy"
                          src={question.imageUrl}
                        />
                      </div>
                      <div className="px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-bold text-slate-950">Q{index + 1}</p>
                          {question.labelText ? (
                            <span className="truncate text-xs font-semibold text-[var(--primary)]" title={question.labelText}>
                              {question.labelText}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="rounded-md border border-[var(--line)] bg-slate-50 px-4 py-5 text-sm text-[var(--muted)]">
                  当前没有可浏览的题目图片
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function RoomPage({ initialRoomCode = "" }: { initialRoomCode?: string } = {}) {
  const params = useParams<{ roomCode: string }>();
  const router = useRouter();
  const roomCode = params.roomCode || initialRoomCode || getRoomCodeFromLocation();
  const [room, setRoom] = useState<Room | null>(null);
  const [playerId, setPlayerId] = useState("");
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState("");
  const [roomExpired, setRoomExpired] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isDissolving, setIsDissolving] = useState(false);
  const [pendingPresenterId, setPendingPresenterId] = useState("");
  const [isCancelingRound, setIsCancelingRound] = useState(false);
  const [isReturningToLobby, setIsReturningToLobby] = useState(false);
  const [isStartingGame, setIsStartingGame] = useState(false);
  const [isUpdatingSettings, setIsUpdatingSettings] = useState(false);
  const [isSavingRoomNotice, setIsSavingRoomNotice] = useState(false);
  const [roomNoticeDraft, setRoomNoticeDraft] = useState("");
  const [isRoomNoticeDirty, setIsRoomNoticeDirty] = useState(false);
  const [isLeavingRoom, setIsLeavingRoom] = useState(false);
  const [isSwitchingRole, setIsSwitchingRole] = useState(false);
  const [pendingJoinRole, setPendingJoinRole] = useState<PlayerRole | null>(null);
  const [pendingTeam, setPendingTeam] = useState<TeamBattleTeam | null>(null);
  const [isPresenterPickerOpen, setIsPresenterPickerOpen] = useState(false);
  const [isKickPlayerModalOpen, setIsKickPlayerModalOpen] = useState(false);
  const [isCancelRoundModalOpen, setIsCancelRoundModalOpen] = useState(false);
  const [pendingKickPlayerId, setPendingKickPlayerId] = useState("");
  const settingsUpdateSeqRef = useRef(0);
  const startGameAttemptRef = useRef<StartGameAttempt | null>(null);
  const lastRoomRealtimeVersionRef = useRef<number | null>(null);
  const missedRoomRealtimeVersionRef = useRef(false);
  const roomCatchUpTargetVersionRef = useRef<number | null>(null);
  const [gameSettings, setGameSettings] = useState<GameSettings>(defaultGameSettings);

  useEffect(() => {
    if (room?.status !== "QUESTION_SETUP") {
      startGameAttemptRef.current = null;
      if (room?.id) {
        storeStartGameAttempt(room.id, null);
      }
    }
  }, [room?.id, room?.status]);

  useEffect(() => {
    setRoomNoticeDraft(room?.notice ?? "");
    setIsRoomNoticeDirty(false);
  }, [room?.id]);

  useEffect(() => {
    if (!isRoomNoticeDirty) setRoomNoticeDraft(room?.notice ?? "");
  }, [room?.notice, isRoomNoticeDirty]);

  useEffect(() => {
    if (!error) {
      return;
    }

    const timer = window.setTimeout(() => {
      setError("");
    }, 5000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [error]);

  useEffect(() => {
    let isMounted = true;

    async function loadRoom() {
      setIsLoading(true);
      setError("");

      const session = getLocalSession();
      setPlayerId(session.playerId);
      setNickname(session.nickname);

      if (!session.nickname) {
        router.push(`/?roomCode=${encodeURIComponent(roomCode)}`);
        return;
      }

      try {
        const latestRoom = await getRoomWithPlayers(roomCode);

        if (!latestRoom) {
          if (isMounted) {
            setError("没有找到房间");
            setRoom(null);
          }
          return;
        }

        const existingMember = latestRoom.players.find((player) => player.id === session.playerId);
        if (existingMember) {
          saveLocalSession({
            playerId: session.playerId,
            nickname: existingMember.nickname,
            roomCode,
            isHost: latestRoom.hostPlayerId === session.playerId,
          });

          if (isMounted) {
            setNickname(existingMember.nickname);
            setRoom(latestRoom);
          }
          return;
        }

        if (!existingMember && latestRoom.status === "PLAYING") {
          saveLocalSession({
            playerId: session.playerId,
            nickname: session.nickname,
            roomCode,
            isHost: latestRoom.hostPlayerId === session.playerId,
          });

          if (isMounted) {
            setRoom(latestRoom);
          }
          return;
        }

        const joined = await joinRoom(roomCode, session.playerId, session.nickname);

        if (joined.error || !joined.room) {
          const isExpectedChoice = isPlayerCapacityError(joined.errorCode) || isTeamSelectionRequired(joined.errorCode);
          if (isMounted) {
            setError(isExpectedChoice ? "" : joined.error ?? "没有找到房间");
            setRoom(latestRoom);
          }
          return;
        }

        saveLocalSession({
          playerId: session.playerId,
          nickname: session.nickname,
          roomCode,
          isHost: joined.room.hostPlayerId === session.playerId,
        });

        if (isMounted) {
          setRoom(joined.room);
        }
      } catch (caughtError) {
        if (isMounted) {
          if (isRoomVersionExpiredError(caughtError)) {
            clearLocalRoomSession();
            clearAllRoomChatMessages();
            setRoomExpired(true);
            setRoom(null);
            setError("");
          } else {
            setError(caughtError instanceof Error ? caughtError.message : "加载房间失败，请稍后重试");
          }
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadRoom();

    return () => {
      isMounted = false;
    };
  }, [roomCode]);

  useEffect(() => {
    function handleExpiredRoom(event: Event) {
      const detail = (event as CustomEvent<{ topic?: string }>).detail;
      if (room?.id && detail?.topic !== `room:${room.id}`) return;
      clearLocalRoomSession();
      const expiredRoomId = detail?.topic?.startsWith("room:") ? detail.topic.slice("room:".length) : room?.id;
      if (expiredRoomId) clearRoomChatMessages(expiredRoomId);
      else clearAllRoomChatMessages();
      setRoomExpired(true);
      setRoom(null);
      setError("");
      setIsLoading(false);
    }

    window.addEventListener(ROOM_VERSION_EXPIRED_EVENT, handleExpiredRoom);
    return () => window.removeEventListener(ROOM_VERSION_EXPIRED_EVENT, handleExpiredRoom);
  }, [room?.id]);

  useEffect(() => {
    if (!room?.id || !playerId) {
      return;
    }

    const activeRoomId = room.id;
    let isActive = true;

    function markRoomDissolved() {
      if (!isActive) {
        return;
      }

      clearLocalRoomSession();
      clearRoomChatMessages(activeRoomId);
      setRoom(null);
      setError("房间已被房主解散");
    }

    function markPlayerRemoved() {
      if (!isActive) {
        return;
      }

      clearLocalRoomSession();
      clearRoomChatMessages(activeRoomId);
      setRoom(null);
      router.push("/?roomNotice=kicked");
    }

    function applyRoomUpdate(pushedRoom: Room) {
      const activeRoom = room;
      if (!isActive || !activeRoom || pushedRoom.id !== activeRoom.id) {
        return;
      }

      const pushedUpdatedAtMs = pushedRoom.updatedAt ? new Date(pushedRoom.updatedAt).getTime() : null;
      const activeUpdatedAtMs = activeRoom.updatedAt ? new Date(activeRoom.updatedAt).getTime() : null;
      if (
        pushedUpdatedAtMs != null &&
        activeUpdatedAtMs != null &&
        Number.isFinite(pushedUpdatedAtMs) &&
        Number.isFinite(activeUpdatedAtMs) &&
        pushedUpdatedAtMs < activeUpdatedAtMs
      ) {
        return;
      }

      const wasRoomMember = activeRoom.players.some((player) => player.id === playerId);
      if (wasRoomMember && pushedRoom.players.length > 0 && !pushedRoom.players.some((player) => player.id === playerId)) {
        markPlayerRemoved();
        return;
      }

      setRoom((currentRoom) =>
        currentRoom
          ? {
              ...currentRoom,
              ...pushedRoom,
              players: pushedRoom.players.length > 0 ? pushedRoom.players : currentRoom.players,
            }
          : pushedRoom,
      );
    }

    let refreshPromise: Promise<void> | null = null;
    let refreshRetryTimer: number | null = null;
    let refreshRetryAttempt = 0;
    lastRoomRealtimeVersionRef.current = null;
    missedRoomRealtimeVersionRef.current = false;
    roomCatchUpTargetVersionRef.current = null;

    function shouldContinueRoomCatchUp(coveredTargetVersion: number | null) {
      const latestTargetVersion = roomCatchUpTargetVersionRef.current;
      return (
        latestTargetVersion != null &&
        (coveredTargetVersion == null || latestTargetVersion > coveredTargetVersion)
      );
    }

    function scheduleRoomCatchUpRetry(delay: number) {
      if (!isActive || refreshRetryTimer != null) {
        return;
      }
      refreshRetryTimer = window.setTimeout(() => {
        refreshRetryTimer = null;
        if (isActive && missedRoomRealtimeVersionRef.current) {
          void refreshLatestRoom();
        }
      }, delay);
    }

    async function refreshLatestRoom() {
      if (refreshPromise) {
        return refreshPromise;
      }
      if (refreshRetryTimer != null) {
        return;
      }

      const startTargetVersion = roomCatchUpTargetVersionRef.current;
      const runPromise = doRefreshLatestRoom(startTargetVersion);
      refreshPromise = runPromise.then(() => undefined).finally(() => {
        refreshPromise = null;
      });
      void runPromise.then((didRefresh) => {
        if (!isActive) {
          return;
        }
        if (didRefresh) {
          refreshRetryAttempt = 0;
          if (shouldContinueRoomCatchUp(startTargetVersion)) {
            scheduleRoomCatchUpRetry(0);
          }
          return;
        }
        if (missedRoomRealtimeVersionRef.current) {
          const baseRetryDelay = Math.min(15000, 500 * 2 ** Math.min(refreshRetryAttempt, 5));
          const retryDelay = Math.round(baseRetryDelay * (0.8 + Math.random() * 0.4));
          refreshRetryAttempt += 1;
          scheduleRoomCatchUpRetry(retryDelay);
        }
      });
      return refreshPromise;
    }

    async function doRefreshLatestRoom(coveredTargetVersion: number | null) {
      try {
        const latestRoom = await getRoomWithPlayers(roomCode);

        if (!isActive) {
          return false;
        }

        if (!latestRoom) {
          markRoomDissolved();
          return true;
        }

        applyRoomUpdate(latestRoom);
        if (coveredTargetVersion != null) {
          lastRoomRealtimeVersionRef.current = Math.max(
            lastRoomRealtimeVersionRef.current ?? 0,
            coveredTargetVersion,
          );
        }
        if (shouldContinueRoomCatchUp(coveredTargetVersion)) {
          missedRoomRealtimeVersionRef.current = true;
        } else {
          roomCatchUpTargetVersionRef.current = null;
          missedRoomRealtimeVersionRef.current = false;
        }
        return true;
      } catch {
        // Realtime remains the primary path; this catch-up read is best effort.
        return false;
      }
    }

    const unsubscribe = subscribeRealtimeTopic(
      `room:${room.id}`,
      (message) => {
        const messageVersion = getRealtimeVersion(message);
        if (message.name === "authorityCutover") {
          lastRoomRealtimeVersionRef.current = null;
          missedRoomRealtimeVersionRef.current = true;
          roomCatchUpTargetVersionRef.current = null;
          void refreshLatestRoom();
          return;
        }
        if (message.name === "authorityRecovered") {
          missedRoomRealtimeVersionRef.current = true;
          if (messageVersion != null) {
            roomCatchUpTargetVersionRef.current = Math.max(roomCatchUpTargetVersionRef.current ?? 0, messageVersion);
          }
          void refreshLatestRoom();
          return;
        }
        if (messageVersion != null) {
          const lastVersion = lastRoomRealtimeVersionRef.current;
          if (lastVersion != null && messageVersion <= lastVersion) {
            return;
          }

          if (missedRoomRealtimeVersionRef.current) {
            roomCatchUpTargetVersionRef.current = Math.max(roomCatchUpTargetVersionRef.current ?? 0, messageVersion);
            void refreshLatestRoom();
            return;
          }

          if (lastVersion != null && messageVersion > lastVersion + 1) {
            missedRoomRealtimeVersionRef.current = true;
            roomCatchUpTargetVersionRef.current = Math.max(roomCatchUpTargetVersionRef.current ?? 0, messageVersion);
            void refreshLatestRoom();
            return;
          }

          lastRoomRealtimeVersionRef.current = messageVersion;
        }

        if (missedRoomRealtimeVersionRef.current) {
          void refreshLatestRoom();
          return;
        }

        const dissolvedDelta = getRealtimeDeltas(message).find(isRoomDissolvedDelta);
        if (dissolvedDelta?.roomId === room.id) {
          markRoomDissolved();
          return;
        }

        const roomDelta = getRealtimeDeltas(message).find(isRoomUpdatedDelta);
        const roomNoticeDelta = getRealtimeDeltas(message).find(isRoomNoticeUpdatedDelta);
        cacheGameResultSnapshot(getBroadcastGameResultSnapshot(message));
        const pushedRoom = roomDelta?.room ?? getBroadcastRoom(message.result);
        if (pushedRoom && pushedRoom.id === room.id) {
          applyRoomUpdate(pushedRoom);
          return;
        }
        if (roomNoticeDelta && roomNoticeDelta.roomId === room.id) {
          const noticeUpdate = roomNoticeDelta;
          setRoom((currentRoom) =>
            currentRoom?.id === noticeUpdate.roomId
              ? { ...currentRoom, notice: noticeUpdate.notice, updatedAt: noticeUpdate.updatedAt }
              : currentRoom,
          );
          return;
        }
      },
      {
        playerId,
        onOpen: () => {
          missedRoomRealtimeVersionRef.current = true;
          void refreshLatestRoom();
        },
      },
    );

    return () => {
      isActive = false;
      if (refreshRetryTimer != null) {
        window.clearTimeout(refreshRetryTimer);
      }
      unsubscribe();
    };
  }, [playerId, room?.id, roomCode]);

  const currentPlayer = useMemo(
    () => room?.players.find((player) => player.id === playerId) ?? null,
    [playerId, room],
  );
  const isTeamChatContext = room?.status === "PLAYING" && room.gameMode === "TEAM_BATTLE";
  const teamChatAvailable = Boolean(
    isTeamChatContext &&
    currentPlayer?.role === "PLAYER" &&
    room.currentPresenterPlayerId !== playerId
  );
  const roomChat = useRoomChat({
    roomId: currentPlayer ? room?.id : null,
    playerId,
    players: room?.players ?? [],
    channelLabelsVisible: isTeamChatContext,
    teamChannelAvailable: teamChatAvailable,
  });

  const isHost = Boolean(currentPlayer?.isHost);
  const isCurrentSpectator = currentPlayer?.role === "SPECTATOR";
  const presenterName = room ? getPresenterName(room.players, room.currentPresenterPlayerId) : "未选择";
  const isCurrentPresenter = room?.currentPresenterPlayerId === playerId;
  const canKickPlayers = Boolean(isHost && (room?.status === "LOBBY" || room?.status === "QUESTION_SETUP" || room?.status === "PLAYING"));
  const canSwitchRole = Boolean(currentPlayer && canSwitchPlayerRole(room, isCurrentPresenter));
  const canEditRoomNotice = Boolean(isHost && (room?.status === "LOBBY" || room?.status === "QUESTION_SETUP"));
  const hasRoomNoticeChanges = roomNoticeDraft.trim() !== (room?.notice ?? "");
  const shouldShowQuestionSetup = room?.status === "QUESTION_SETUP" && isCurrentPresenter && !room.preparedQuestionSetId;
  const shouldShowLobby =
    room?.status === "LOBBY" || (room?.status === "QUESTION_SETUP" && (!isCurrentPresenter || Boolean(room.preparedQuestionSetId)));
  const isManualTeamRoom = Boolean(room?.gameMode === "TEAM_BATTLE" && room.teamAssignmentMode === "MANUAL");
  const needsManualJoinChoice = Boolean(isManualTeamRoom && room?.status === "PLAYING");
  const isPlayerCapacityFull = Boolean(room && getGamePlayers(room.players).length >= (room.playerCapacity ?? 50));
  const isSpectatorCapacityFull = Boolean(room && getSpectators(room.players).length >= (room.spectatorCapacity ?? 50));

  useEffect(() => {
    setGameSettings((currentSettings) => {
      const roomSettings = getRoomGameSettings(room);
      return areGameSettingsEqual(currentSettings, roomSettings) ? currentSettings : roomSettings;
    });
  }, [room]);

  async function handleExitRoom() {
    if (!room?.id || !playerId || (room.status === "PLAYING" && isCurrentPresenter)) {
      return;
    }

    setIsLeavingRoom(true);
    setError("");

    try {
      await leaveRoom(room.id, playerId);
      clearLocalRoomSession();
      clearRoomChatMessages(room.id);
      router.push("/");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "退出房间失败，请稍后重试");
    } finally {
      setIsLeavingRoom(false);
    }
  }

  async function handleSaveRoomNotice() {
    if (!room?.id || !playerId || !canEditRoomNotice || !hasRoomNoticeChanges || isSavingRoomNotice) return;

    setIsSavingRoomNotice(true);
    setError("");
    try {
      const result = await updateRoomNotice({
        roomId: room.id,
        hostPlayerId: playerId,
        notice: roomNoticeDraft,
      });
      setRoom((currentRoom) =>
        currentRoom?.id === result.roomId
          ? { ...currentRoom, notice: result.notice, updatedAt: result.updatedAt }
          : currentRoom,
      );
      setRoomNoticeDraft(result.notice ?? "");
      setIsRoomNoticeDirty(false);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "修改房间信息失败，请稍后重试");
    } finally {
      setIsSavingRoomNotice(false);
    }
  }

  async function handleDissolveRoom() {
    if (!room?.id || !playerId || !isHost) {
      return;
    }

    const confirmed = window.confirm("确定要解散房间吗？");

    if (!confirmed) {
      return;
    }

    setIsDissolving(true);
    setError("");

    try {
      await dissolveRoom(room.id, playerId);
      clearLocalRoomSession();
      clearRoomChatMessages(room.id);
      router.push("/");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "解散房间失败，请稍后重试");
    } finally {
      setIsDissolving(false);
    }
  }

  async function handleKickPlayer(targetPlayerId: string) {
    if (!room?.id || !playerId || !isHost || !canKickPlayers || targetPlayerId === playerId) {
      return;
    }

    setPendingKickPlayerId(targetPlayerId);
    setError("");

    try {
      const nextRoom = await kickPlayerFromRoom(room.id, playerId, targetPlayerId);
      setRoom((currentRoom) => (currentRoom ? { ...currentRoom, ...nextRoom } : nextRoom));
      setIsKickPlayerModalOpen(false);
      setIsPresenterPickerOpen(false);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "踢出玩家失败，请稍后重试");
    } finally {
      setPendingKickPlayerId("");
    }
  }

  async function handleSwitchRole(role: PlayerRole, team?: TeamBattleTeam) {
    if (!room?.id || !playerId || !canSwitchPlayerRole(room, isCurrentPresenter) || currentPlayer?.role === role) {
      return;
    }

    setIsSwitchingRole(true);
    setError("");

    try {
      const nextRoom = await updatePlayerRole(room.id, playerId, playerId, role, team);
      setRoom((currentRoom) => (currentRoom ? { ...currentRoom, ...nextRoom } : nextRoom));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "身份切换失败，请稍后重试");
    } finally {
      setIsSwitchingRole(false);
    }
  }

  async function handleJoinRoomAsRole(role: PlayerRole, team?: TeamBattleTeam) {
    if (!room || currentPlayer || pendingJoinRole) {
      return;
    }

    setPendingJoinRole(role);
    setError("");

    try {
      const joined = await joinRoom(roomCode, playerId, nickname, role, team);
      if (joined.error || !joined.room) {
        setError(joined.error ?? "加入房间失败，请稍后重试");
        return;
      }

      saveLocalSession({
        playerId,
        nickname,
        roomCode,
        isHost: joined.room.hostPlayerId === playerId,
      });
      setRoom(joined.room);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "加入房间失败，请稍后重试");
    } finally {
      setPendingJoinRole(null);
    }
  }

  async function handleSelectTeam(team: TeamBattleTeam) {
    if (!room?.id || !playerId || pendingTeam || room.status === "PLAYING") return;
    setPendingTeam(team);
    setError("");
    try {
      const nextRoom = await selectTeamForPlayer(room.id, playerId, team);
      setRoom(nextRoom);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "更换队伍失败，请稍后重试");
    } finally {
      setPendingTeam(null);
    }
  }

  async function handleSelectPresenter(presenterPlayerId: string) {
    if (!room?.id || !playerId || !isHost || room.status !== "LOBBY") {
      return;
    }

    setPendingPresenterId(presenterPlayerId);
    setError("");

    try {
      const nextRoom = await selectPresenterForRound(room.id, playerId, presenterPlayerId);
      setRoom((currentRoom) => (currentRoom ? { ...currentRoom, ...nextRoom, players: currentRoom.players } : currentRoom));
      setIsPresenterPickerOpen(false);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "选择出题人失败，请稍后重试");
    } finally {
      setPendingPresenterId("");
    }
  }

  async function handleCancelRound() {
    if (!room?.id || !playerId || !isHost || room.status === "LOBBY") {
      return;
    }

    setIsCancelingRound(true);
    setError("");

    try {
      const nextRoom = await cancelCurrentRound(room.id, playerId);
      setRoom((currentRoom) => (currentRoom ? { ...currentRoom, ...nextRoom, players: currentRoom.players } : currentRoom));
      setIsCancelRoundModalOpen(false);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "取消本局失败，请稍后重试");
    } finally {
      setIsCancelingRound(false);
    }
  }

  function handleRequestCancelRound() {
    if (!room?.id || !playerId || !isHost || room.status === "LOBBY") {
      return;
    }

    setError("");
    setIsCancelRoundModalOpen(true);
  }

  async function handleCancelPresenterSetup() {
    if (!room?.id || !playerId || !isCurrentPresenter || room.status !== "QUESTION_SETUP") {
      return;
    }

    const confirmed = window.confirm("确定不当本局出题人吗？房主需要重新选择出题人。");

    if (!confirmed) {
      return;
    }

    setIsCancelingRound(true);
    setError("");

    try {
      const nextRoom = await cancelPresenterSetup(room.id, playerId);
      setRoom((currentRoom) => (currentRoom ? { ...currentRoom, ...nextRoom, players: currentRoom.players } : nextRoom));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "撤回出题人失败，请稍后重试");
    } finally {
      setIsCancelingRound(false);
    }
  }

  async function handleReturnToLobby() {
    if (!room?.id || !playerId || !isHost || room.status !== "GAME_RESULT") {
      return;
    }

    setIsReturningToLobby(true);
    setError("");

    try {
      const nextRoom = await returnRoomToLobby(room.id, playerId);
      setRoom((currentRoom) => (currentRoom ? { ...currentRoom, ...nextRoom, players: currentRoom.players } : currentRoom));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "回到房间大厅失败，请稍后重试");
    } finally {
      setIsReturningToLobby(false);
    }
  }

  async function handleGameSettingsChange(nextSettings: GameSettings) {
    if (!room?.id || !playerId || !isHost || (room.status !== "LOBBY" && room.status !== "QUESTION_SETUP")) {
      return;
    }

    const normalizedSettings = normalizeGameSettings(nextSettings);
    if (areGameSettingsEqual(normalizedSettings, gameSettings)) {
      return;
    }

    const updateSeq = settingsUpdateSeqRef.current + 1;
    settingsUpdateSeqRef.current = updateSeq;
    setGameSettings(normalizedSettings);
    setIsUpdatingSettings(true);
    setError("");

    try {
      const nextRoom = await updateRoomGameSettings({
        roomId: room.id,
        hostPlayerId: playerId,
        gameMode: normalizedSettings.gameMode,
        maxRevealRounds: normalizedSettings.maxRevealRounds,
        roundSeconds: normalizedSettings.roundSeconds,
        roundScores: normalizedSettings.roundScores,
        teamRevealVoteSeconds: normalizedSettings.teamRevealVoteSeconds,
        teamGuessVoteSeconds: normalizedSettings.teamGuessVoteSeconds,
        teamPresenterBlockEnabled: normalizedSettings.teamPresenterBlockEnabled,
        spectatorQuestionPreviewEnabled: normalizedSettings.spectatorQuestionPreviewEnabled,
        spectatorPlayerAnswersEnabled: normalizedSettings.spectatorPlayerAnswersEnabled,
        playerCapacity: normalizedSettings.playerCapacity,
        spectatorCapacity: normalizedSettings.spectatorCapacity,
        teamAssignmentMode: normalizedSettings.teamAssignmentMode,
        questionCount: normalizedSettings.questionCount,
        includeR18: normalizedSettings.includeR18,
        tagHintsEnabled: normalizedSettings.tagHintsEnabled,
        tagHintBlockStep: normalizedSettings.tagHintBlockStep,
      });

      if (settingsUpdateSeqRef.current === updateSeq) {
        setRoom((currentRoom) =>
          currentRoom
            ? {
                ...currentRoom,
                ...nextRoom,
                players: nextRoom.players.length > 0 ? nextRoom.players : currentRoom.players,
              }
            : nextRoom,
        );
      }
    } catch (caughtError) {
      if (settingsUpdateSeqRef.current === updateSeq) {
        setGameSettings(getRoomGameSettings(room));
        setError(caughtError instanceof Error ? caughtError.message : "修改游戏模式失败，请稍后重试");
      }
    } finally {
      if (settingsUpdateSeqRef.current === updateSeq) setIsUpdatingSettings(false);
    }
  }

  async function handleStartGame() {
    if (!room?.id || !playerId || !isHost || room.status !== "QUESTION_SETUP" || !room.currentPresenterPlayerId || !room.preparedQuestionSetId) {
      return;
    }

    const roomId = room.id;
    const presenterPlayerId = room.currentPresenterPlayerId;
    const questionSetId = room.preparedQuestionSetId;

    setIsStartingGame(true);
    setError("");

    try {
      const startAttemptKey = JSON.stringify([
        roomId,
        presenterPlayerId,
        questionSetId,
        gameSettings.questionCount,
        gameSettings.includeR18,
      ]);
      if (!startGameAttemptRef.current) {
        startGameAttemptRef.current = getStoredStartGameAttempt(roomId);
      }
      if (startGameAttemptRef.current?.key !== startAttemptKey) {
        startGameAttemptRef.current = {
          key: startAttemptKey,
          requestId: createStartRequestId(),
          createdAt: Date.now(),
        };
        storeStartGameAttempt(roomId, startGameAttemptRef.current);
      }

      const requestStart = (startRequestId: string) =>
        startGameWithQuestionSet({
          startRequestId,
          roomId,
          hostPlayerId: playerId,
          presenterPlayerId,
          questionSetId,
          gameMode: gameSettings.gameMode,
          maxRevealRounds: gameSettings.maxRevealRounds,
          roundSeconds: gameSettings.roundSeconds,
          roundScores: gameSettings.roundScores,
          teamRevealVoteSeconds: gameSettings.teamRevealVoteSeconds,
          teamGuessVoteSeconds: gameSettings.teamGuessVoteSeconds,
          teamPresenterBlockEnabled: gameSettings.teamPresenterBlockEnabled,
          questionCount: gameSettings.questionCount,
        });

      let started: Awaited<ReturnType<typeof requestStart>>;
      try {
        started = await requestStart(startGameAttemptRef.current.requestId);
      } catch (startError) {
        if (!(startError instanceof Error) || !startError.message.includes(START_GAME_REQUEST_ID_CONFLICT)) {
          throw startError;
        }

        startGameAttemptRef.current = {
          key: startAttemptKey,
          requestId: createStartRequestId(),
          createdAt: Date.now(),
        };
        storeStartGameAttempt(roomId, startGameAttemptRef.current);
        started = await requestStart(startGameAttemptRef.current.requestId);
      }

      startGameAttemptRef.current = null;
      storeStartGameAttempt(roomId, null);
      setRoom((currentRoom) => (currentRoom ? { ...currentRoom, ...started.room, players: currentRoom.players } : started.room));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "开始游戏失败，请稍后重试");
    } finally {
      setIsStartingGame(false);
    }
  }

  return (
    <AppShell>
      {!roomExpired && room?.status !== "PLAYING" ? (
        <div className="mb-5 grid gap-3 lg:grid-cols-[auto_minmax(16rem,1fr)_auto] lg:items-center">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 lg:max-w-md">
            <h1 className="text-2xl font-bold text-slate-950 sm:text-3xl">房间 {roomCode}</h1>
            <p className="text-sm text-[var(--muted)] sm:text-base">
              当前玩家：{nickname || "未设置昵称"}
              {isHost ? <span className="ml-2 rounded bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700">房主</span> : null}
            </p>
          </div>
          <div className="min-w-0 lg:px-2">
            {canEditRoomNotice ? (
              <form
                className="flex min-w-0 gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSaveRoomNotice();
                }}
              >
                <label className="sr-only" htmlFor="room-notice-input">房间信息</label>
                <input
                  aria-describedby="room-notice-limit"
                  className="h-12 min-w-0 flex-1 rounded-md border border-[var(--line)] bg-white px-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-rose-300 focus:ring-2 focus:ring-rose-100 disabled:cursor-not-allowed disabled:bg-slate-50"
                  disabled={isSavingRoomNotice}
                  id="room-notice-input"
                  maxLength={MAX_ROOM_NOTICE_LENGTH}
                  placeholder="房间信息，例如：满 8 人开始"
                  type="text"
                  value={roomNoticeDraft}
                  onChange={(event) => {
                    setRoomNoticeDraft(event.target.value);
                    setIsRoomNoticeDirty(event.target.value.trim() !== (room?.notice ?? ""));
                  }}
                />
                <span className="sr-only" id="room-notice-limit">最多 {MAX_ROOM_NOTICE_LENGTH} 个字符</span>
                <Button
                  className="min-w-20 shrink-0"
                  disabled={isSavingRoomNotice || !hasRoomNoticeChanges}
                  type="submit"
                  variant="secondary"
                >
                  {isSavingRoomNotice ? "保存中…" : "保存"}
                </Button>
              </form>
            ) : (
              <p
                className="flex h-12 min-w-0 items-center rounded-md border border-[var(--line)] bg-slate-50 px-3 text-sm text-slate-700"
                title={room?.notice || "房主暂未填写房间信息"}
              >
                <span className="shrink-0 font-semibold text-slate-950">房间信息：</span>
                <span className="truncate">{room?.notice || "房主暂未填写"}</span>
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-start gap-3 lg:justify-end">
            <QuestionGuideButton />
            {room ? (
              isHost ? (
                <Button type="button" variant="secondary" onClick={handleDissolveRoom} disabled={isDissolving}>
                  {isDissolving ? "解散中…" : "解散房间"}
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={handleExitRoom} disabled={isLeavingRoom}>
                  {isLeavingRoom ? "退出中…" : "退出房间"}
                </Button>
              )
            ) : null}
          </div>
        </div>
      ) : null}

      {!roomExpired && room?.status !== "PLAYING" && currentPlayer && !shouldShowLobby ? (
        <div className="relative z-20 mb-5">
          <RoomChatBar controller={roomChat} playerId={playerId} />
        </div>
      ) : null}

      {error ? (
        <div className="fixed left-1/2 top-4 z-50 w-[calc(100vw-24px)] max-w-xl -translate-x-1/2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 shadow-lg">
          {error}
        </div>
      ) : null}

      {room && canKickPlayers ? (
        <KickPlayerModal
          room={room}
          isOpen={isKickPlayerModalOpen}
          pendingKickPlayerId={pendingKickPlayerId}
          onKickPlayer={handleKickPlayer}
          onClose={() => setIsKickPlayerModalOpen(false)}
        />
      ) : null}

      {room ? (
        <CancelRoundConfirmModal
          isOpen={isCancelRoundModalOpen}
          isCancelingRound={isCancelingRound}
          onConfirm={handleCancelRound}
          onClose={() => setIsCancelRoundModalOpen(false)}
        />
      ) : null}

      {roomExpired ? (
        <div className="mx-auto max-w-2xl">
          <Panel title="房间版本已过期">
            <p className="text-sm leading-6 text-[var(--muted)]">{ROOM_VERSION_EXPIRED_MESSAGE}</p>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">昵称已经保留，返回首页后可以直接创建或加入新房间。</p>
            <Button className="mt-5" type="button" onClick={() => router.push("/")}>
              返回首页创建新房间
            </Button>
          </Panel>
        </div>
      ) : isLoading ? (
        <Panel title="加载房间">
          <p className="text-sm leading-6 text-[var(--muted)]">正在读取房间和玩家列表…</p>
        </Panel>
      ) : !room ? (
        <Panel title="无法加载房间">
          <p className="text-sm leading-6 text-red-700">房间不存在、已被解散，或当前无法连接服务</p>
          <Button className="mt-4" type="button" onClick={() => router.push("/")}>
            回到首页
          </Button>
        </Panel>
      ) : !currentPlayer && isPlayerCapacityFull && isSpectatorCapacityFull ? (
        <div className="mx-auto max-w-2xl">
          <Panel title="房间已满">
            <p className="text-sm leading-6 text-[var(--muted)]">当前玩家位和观战位都已满，请等待其他成员离开或房主提高人数上限。</p>
          </Panel>
        </div>
      ) : !currentPlayer && needsManualJoinChoice ? (
        <div className="mx-auto max-w-2xl">
          <Panel title="选择队伍加入">
            <p className="text-sm leading-6 text-[var(--muted)]">
              手动分队已开启。请选择红队或蓝队；若游戏已经开始，本题先观看并从下一题正式参赛。
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <button className={RED_TEAM_CHOICE_BUTTON_CLASS} type="button" onClick={() => handleJoinRoomAsRole("PLAYER", "red")} disabled={Boolean(pendingJoinRole) || isPlayerCapacityFull}>{pendingJoinRole === "PLAYER" ? "加入中…" : isPlayerCapacityFull ? "玩家已满" : "加入红队"}</button>
              <button className={BLUE_TEAM_CHOICE_BUTTON_CLASS} type="button" onClick={() => handleJoinRoomAsRole("PLAYER", "blue")} disabled={Boolean(pendingJoinRole) || isPlayerCapacityFull}>{pendingJoinRole === "PLAYER" ? "加入中…" : isPlayerCapacityFull ? "玩家已满" : "加入蓝队"}</button>
              <Button type="button" variant="secondary" onClick={() => handleJoinRoomAsRole("SPECTATOR")} disabled={Boolean(pendingJoinRole) || isSpectatorCapacityFull}>{pendingJoinRole === "SPECTATOR" ? "加入中…" : isSpectatorCapacityFull ? "观战已满" : "作为观战加入"}</Button>
            </div>
          </Panel>
        </div>
      ) : !currentPlayer && room.status === "PLAYING" ? (
        <div className="mx-auto max-w-2xl">
          <Panel title="选择加入方式">
            <p className="text-sm leading-6 text-[var(--muted)]">
              本局已经开始。选择玩家后当前题不能作答，下一题开始参与；选择观战后本局只观看。
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Button
                type="button"
                onClick={() => handleJoinRoomAsRole("PLAYER")}
                disabled={Boolean(pendingJoinRole) || isPlayerCapacityFull}
              >
                {pendingJoinRole === "PLAYER" ? "加入中…" : isPlayerCapacityFull ? "玩家已满" : "作为玩家加入"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => handleJoinRoomAsRole("SPECTATOR")}
                disabled={Boolean(pendingJoinRole) || isSpectatorCapacityFull}
              >
                {pendingJoinRole === "SPECTATOR" ? "加入中…" : isSpectatorCapacityFull ? "观战已满" : "作为观战加入"}
              </Button>
            </div>
          </Panel>
        </div>
      ) : !currentPlayer ? (
        <div className="mx-auto max-w-2xl">
          <Panel title="玩家已满">
            <p className="text-sm leading-6 text-[var(--muted)]">
              当前玩家位已满，暂时无法作为玩家加入。你可以先观战，或等待房主调整玩家名单。
            </p>
            <Button
              className="mt-5"
              type="button"
              variant="secondary"
              onClick={() => handleJoinRoomAsRole("SPECTATOR")}
              disabled={Boolean(pendingJoinRole)}
            >
              {pendingJoinRole === "SPECTATOR" ? "加入中…" : "作为观战加入"}
            </Button>
          </Panel>
        </div>
      ) : room.status === "PLAYING" ? (
        <main className="relative left-1/2 w-[calc(100vw-2rem)] -translate-x-1/2 space-y-4 sm:w-[calc(100vw-4rem)]">
          <ImageRevealGame
            room={room}
            playerId={playerId}
            isPresenter={isCurrentPresenter}
            isSpectator={isCurrentSpectator}
            roomChat={<RoomChatBar controller={roomChat} playerId={playerId} />}
            footerActions={
              isHost ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setIsKickPlayerModalOpen(true)}
                    disabled={room.players.length <= 1}
                  >
                    踢出玩家
                  </Button>
                  <Button type="button" variant="secondary" onClick={handleRequestCancelRound} disabled={isCancelingRound}>
                    {isCancelingRound ? "取消中…" : "取消本局"}
                  </Button>
                </>
              ) : !isCurrentPresenter ? (
                <Button type="button" variant="secondary" onClick={handleExitRoom} disabled={isLeavingRoom}>
                  {isLeavingRoom ? "退出中…" : "退出房间"}
                </Button>
              ) : null
            }
            onError={setError}
            onRoomUpdated={(nextRoom) =>
              setRoom((currentRoom) =>
                currentRoom
                  ? {
                      ...currentRoom,
                      ...nextRoom,
                      players: nextRoom.players.length > 0 ? nextRoom.players : currentRoom.players,
                    }
                  : nextRoom,
              )
            }
          />
        </main>
      ) : shouldShowLobby ? (
        <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside>
            <PlayerList
              players={room.players}
              playerId={playerId}
              presenterPlayerId={room.currentPresenterPlayerId}
              gameMode={gameSettings.gameMode}
              teamAssignmentMode={room.teamAssignmentMode}
              teamAssignments={room.teamAssignments}
              pendingTeam={pendingTeam}
              onSelectTeam={handleSelectTeam}
              spectatorAction={
                canSwitchRole ? (
                  isCurrentSpectator && isManualTeamRoom ? (
                    <div className="flex gap-2">
                      <button className={RED_TEAM_CHOICE_BUTTON_CLASS} type="button" onClick={() => handleSwitchRole("PLAYER", "red")} disabled={isSwitchingRole}>加入红队</button>
                      <button className={BLUE_TEAM_CHOICE_BUTTON_CLASS} type="button" onClick={() => handleSwitchRole("PLAYER", "blue")} disabled={isSwitchingRole}>加入蓝队</button>
                    </div>
                  ) : (
                    <Button className="h-9 px-3" type="button" variant="secondary" onClick={() => handleSwitchRole(isCurrentSpectator ? "PLAYER" : "SPECTATOR")} disabled={isSwitchingRole}>
                      {isSwitchingRole ? "切换中…" : isCurrentSpectator ? "退出观战" : "加入观战"}
                    </Button>
                  )
                ) : null
              }
              action={
                canKickPlayers ? (
                  <Button
                    className="h-9 px-3"
                    type="button"
                    variant="secondary"
                    onClick={() => setIsKickPlayerModalOpen(true)}
                    disabled={room.players.length <= 1}
                  >
                    踢出玩家
                  </Button>
                ) : null
              }
            />
          </aside>
          <LobbyMainPanel
            room={room}
            settings={gameSettings}
            isHost={isHost}
            presenterName={presenterName}
            isStartingGame={isStartingGame}
            isUpdatingSettings={isUpdatingSettings}
            isCancelingRound={isCancelingRound}
            roomChat={<RoomChatBar compactMessageCount={1} controller={roomChat} playerId={playerId} />}
            onSettingsChange={handleGameSettingsChange}
            onOpenPresenterPicker={() => setIsPresenterPickerOpen(true)}
            onStartGame={handleStartGame}
            onCancelRound={handleRequestCancelRound}
          />
          <PresenterPickerModal
            room={room}
            isOpen={isPresenterPickerOpen}
            pendingPresenterId={pendingPresenterId}
            onSelectPresenter={handleSelectPresenter}
            onClose={() => setIsPresenterPickerOpen(false)}
          />
        </div>
      ) : shouldShowQuestionSetup ? (
        <div className="mx-auto max-w-5xl">
          <Panel title="准备题库">
            <QuestionSetUploader
              room={room}
              presenterPlayerId={playerId}
              isCancelingPresenterSetup={isCancelingRound}
              onRoomUpdated={(nextRoom) =>
                setRoom((currentRoom) => (currentRoom ? { ...nextRoom, players: currentRoom.players } : nextRoom))
              }
              onError={setError}
              onClearError={() => setError("")}
              onCancelPresenterSetup={handleCancelPresenterSetup}
            />
          </Panel>
        </div>
      ) : room.status === "GAME_RESULT" ? (
        <GameResultPanel
          room={room}
          currentGameId={room.currentGameId}
          playerId={playerId}
          isHost={isHost}
          isDissolving={isDissolving}
          isReturningToLobby={isReturningToLobby}
          onDissolveRoom={handleDissolveRoom}
          onReturnToLobby={handleReturnToLobby}
          onError={setError}
        />
      ) : (
        <Panel title="当前游戏状态">
          <StepGuide room={room} isHost={isHost} isCurrentPresenter={isCurrentPresenter} />
        </Panel>
      )}
    </AppShell>
  );
}
