"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, SVGProps } from "react";
import { createPortal, unstable_batchedUpdates } from "react-dom";
import { Button } from "@/components/Button";
import { bindGameSessionRealtimeTopic, ensureRealtimeTopic, subscribeRealtimeTopic, updateGameSessionRealtimeQuestion } from "@/lib/cloudflareClient";
import {
  advanceTeamBattleTurn,
  advanceReviewedQuestion,
  cancelForfeitAnswer,
  completeTeamBattleBlockSelection,
  confirmRevealBlocks,
  finalizeTeamBattleVote,
  getGameBootstrapSnapshot,
  getQuestionSetById,
  getRoundSnapshot,
  judgeTeamBattleGuess,
  markPendingRoundAnswersWrong,
  publishQuestionSetToCommunity,
  revealTeamBattleAnswer,
  setAnswerJudgements,
  settleBuzzerRound,
  skipCurrentQuestion,
  submitAnswer,
  submitBuzzerAnswer,
  submitForfeitAnswer,
  submitTeamBattleGuessVote,
  submitTeamBattleRevealVote,
  updateQuestionLabel,
} from "@/lib/cloudflareRooms";
import { getTeamBattleViewerAccess } from "@/lib/teamBattleView";
import { GAME_MODE_LABELS } from "@/lib/gameModeLabels";
import type {
  Answer,
  BuzzerAnswer,
  DbAnswer,
  DbBuzzerAnswer,
  DbGameSession,
  DbQuestion,
  GameBootstrapSnapshot,
  GameSession,
  Player,
  PlayerScore,
  Question,
  QuestionSet,
  QuestionSetCreationMethod,
  QuestionResult,
  RealtimeDelta,
  RoundSnapshot,
  Room,
  TeamBattleGuessVote,
  TeamBattlePhase,
  TeamBattleTeam,
} from "@/types/game";

type ImageRevealGameProps = {
  room: Room;
  playerId: string;
  isPresenter: boolean;
  isSpectator?: boolean;
  roomChat?: ReactNode;
  footerActions?: ReactNode;
  onError: (message: string) => void;
  onRoomUpdated?: (room: Room) => void;
};

const LANDSCAPE_GRID_COLUMNS = 9;
const PORTRAIT_GRID_COLUMNS = 5;
const LANDSCAPE_TOTAL_BLOCKS = 45;
const PORTRAIT_TOTAL_BLOCKS = 35;
const MAX_REVEAL_BLOCKS = LANDSCAPE_TOTAL_BLOCKS;
const DEFAULT_ROUND_SECONDS = 45;
const ROUND_DEADLINE_GRACE_MS = 3000;
const TEAM_BATTLE_SETTLEMENT_FALLBACK_DELAY_MS = 1000;
const ANSWER_JUDGEMENT_BATCH_WINDOW_MS = 250;
const DEFAULT_ROUND_SCORES = [5, 3, 1];
export const BUZZER_JUDGING_STABILIZE_MS = 3000;
const FORFEIT_ANSWER_TEXT = "__FORFEIT__";
const MAX_IMAGE_AUTO_RETRY_COUNT = 3;
const IMAGE_RETRY_DELAYS_MS = [800, 1600, 3200] as const;
const ROUND_PROMPT_SOUND_STORAGE_KEY = "animeMaster.roundPromptSoundEnabled";
const ROUND_PROMPT_SOUND_VOLUME_STORAGE_KEY = "animeMaster.roundPromptSoundVolume";
const ROUND_PROMPT_SOUND_URL = "/sounds/round-start.mp3";
const DEFAULT_ROUND_PROMPT_SOUND_VOLUME = 80;
// Temporarily disabled: browser audio is unreliable in background/minimized tabs, so the reminder feels inconsistent.
const ROUND_PROMPT_SOUND_FEATURE_ENABLED = false;
let roundPromptAudioElement: HTMLAudioElement | null = null;

function getInitialRoundPromptSoundEnabled() {
  if (!ROUND_PROMPT_SOUND_FEATURE_ENABLED) {
    return false;
  }

  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(ROUND_PROMPT_SOUND_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveRoundPromptSoundEnabled(isEnabled: boolean) {
  try {
    window.localStorage.setItem(ROUND_PROMPT_SOUND_STORAGE_KEY, isEnabled ? "1" : "0");
  } catch {
    // Local storage can be unavailable in restricted browser modes; the in-memory toggle still works for this page.
  }
}

function getInitialRoundPromptSoundVolume() {
  if (typeof window === "undefined") {
    return DEFAULT_ROUND_PROMPT_SOUND_VOLUME;
  }

  try {
    const storedVolume = Number(window.localStorage.getItem(ROUND_PROMPT_SOUND_VOLUME_STORAGE_KEY));
    return Number.isFinite(storedVolume) ? Math.max(0, Math.min(100, Math.round(storedVolume))) : DEFAULT_ROUND_PROMPT_SOUND_VOLUME;
  } catch {
    return DEFAULT_ROUND_PROMPT_SOUND_VOLUME;
  }
}

function saveRoundPromptSoundVolume(volume: number) {
  try {
    window.localStorage.setItem(ROUND_PROMPT_SOUND_VOLUME_STORAGE_KEY, String(volume));
  } catch {
    // Local storage can be unavailable in restricted browser modes; the in-memory slider still works for this page.
  }
}

function getRoundPromptAudioElement() {
  if (typeof window === "undefined") {
    return null;
  }

  if (!roundPromptAudioElement) {
    roundPromptAudioElement = new Audio(ROUND_PROMPT_SOUND_URL);
    roundPromptAudioElement.preload = "auto";
  }

  return roundPromptAudioElement;
}

function playRoundPromptSound(volume = DEFAULT_ROUND_PROMPT_SOUND_VOLUME) {
  const audio = getRoundPromptAudioElement();
  if (!audio) {
    return;
  }

  audio.pause();
  audio.currentTime = 0;
  audio.volume = Math.max(0, Math.min(100, volume)) / 100;
  void audio.play();
}

function isForfeitAnswer(answer: Answer | null | undefined) {
  return answer?.answerText === FORFEIT_ANSWER_TEXT;
}

function getAnswerDisplayText(answer: Answer | null | undefined) {
  if (!answer) {
    return "";
  }

  return isForfeitAnswer(answer) ? "已放弃" : answer.answerText;
}

function buildRetryImageUrl(imageUrl: string, retryAttempt: number, retryToken: number) {
  if (retryAttempt <= 0 && retryToken <= 0) {
    return imageUrl;
  }

  const hashIndex = imageUrl.indexOf("#");
  const urlWithoutHash = hashIndex >= 0 ? imageUrl.slice(0, hashIndex) : imageUrl;
  const hash = hashIndex >= 0 ? imageUrl.slice(hashIndex) : "";
  const separator = urlWithoutHash.includes("?") ? "&" : "?";

  return `${urlWithoutHash}${separator}amgImageRetry=${retryToken}-${retryAttempt}${hash}`;
}

function getRevealGridConfig(isPortrait: boolean) {
  const columns = isPortrait ? PORTRAIT_GRID_COLUMNS : LANDSCAPE_GRID_COLUMNS;
  const blockCount = isPortrait ? PORTRAIT_TOTAL_BLOCKS : LANDSCAPE_TOTAL_BLOCKS;

  return {
    columns,
    rows: blockCount / columns,
    blockCount,
  };
}

function countVisibleRevealedBlocks(revealedBlocks: Iterable<number>, blockCount: number) {
  let count = 0;
  for (const block of revealedBlocks) {
    if (block >= 0 && block < blockCount) {
      count += 1;
    }
  }

  return count;
}

function getHiddenRevealBlocks(blockCount: number) {
  return Array.from({ length: MAX_REVEAL_BLOCKS - blockCount }, (_, index) => blockCount + index);
}

function toGameSession(gameSession: DbGameSession): GameSession {
  const roundScores = Array.isArray(gameSession.round_scores)
    ? gameSession.round_scores.filter((score): score is number => Number.isFinite(score))
    : DEFAULT_ROUND_SCORES;

  return {
    id: gameSession.id,
    roomId: gameSession.room_id,
    questionSetId: gameSession.question_set_id,
    presenterPlayerId: gameSession.presenter_player_id,
    status: gameSession.status,
    gameMode: gameSession.game_mode ?? "ROUND_REVEAL",
    currentQuestionIndex: gameSession.current_question_index,
    currentRevealRound: gameSession.current_reveal_round,
    revealedBlocks: Array.isArray(gameSession.revealed_blocks)
      ? Array.from(
          new Set(
            gameSession.revealed_blocks.filter(
              (block): block is number => Number.isInteger(block) && block >= 0 && block < MAX_REVEAL_BLOCKS,
            ),
          ),
        ).sort((a, b) => a - b)
      : [],
    maxRevealRounds: gameSession.max_reveal_rounds ?? 3,
    roundSeconds: gameSession.round_seconds ?? DEFAULT_ROUND_SECONDS,
    roundScores,
    roundStartedAt: gameSession.round_started_at,
    createdAt: gameSession.created_at,
    endedAt: gameSession.ended_at,
  };
}

export function getRemainingSeconds(roundStartedAt?: string | null, roundSeconds = DEFAULT_ROUND_SECONDS, nowMs = Date.now()) {
  if (!roundStartedAt) {
    return roundSeconds;
  }

  const elapsedSeconds = Math.floor((nowMs - new Date(roundStartedAt).getTime()) / 1000);
  return Math.min(roundSeconds, Math.max(0, roundSeconds - elapsedSeconds));
}

function sortBySubmittedAt<T extends { id: string; submittedAt: string; serverReceivedAt?: string }>(items: T[]) {
  return [...items].sort(
    (a, b) =>
      new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime() ||
      new Date(a.serverReceivedAt ?? a.submittedAt).getTime() - new Date(b.serverReceivedAt ?? b.submittedAt).getTime() ||
      a.id.localeCompare(b.id),
  );
}

function toLabelAnswerFromBuzzerAnswer(answer: BuzzerAnswer): Answer {
  return {
    id: answer.id,
    gameSessionId: answer.gameSessionId,
    questionIndex: answer.questionIndex,
    revealRound: answer.revealRound,
    playerId: answer.playerId,
    answerText: answer.answerText,
    submittedAt: answer.submittedAt,
  };
}

function getCorrectLabelAnswersFromBuzzerAnswers(answers: BuzzerAnswer[]) {
  return sortBySubmittedAt(answers.filter((answer) => answer.status === "correct").map(toLabelAnswerFromBuzzerAnswer));
}

function comparePlayerAnswerOrder(left: BuzzerAnswer, right: BuzzerAnswer) {
  return (
    new Date(left.submittedAt).getTime() - new Date(right.submittedAt).getTime() ||
    left.id.localeCompare(right.id)
  );
}

export function getBuzzerAnswerStabilityDelayMs(
  answer: Pick<BuzzerAnswer, "submittedAt" | "serverReceivedAt">,
  nowMs: number,
) {
  const receivedAtMs = new Date(answer.serverReceivedAt ?? answer.submittedAt).getTime();
  return Math.max(0, receivedAtMs + BUZZER_JUDGING_STABILIZE_MS - nowMs);
}

export function shouldAcceptServerClock(currentEstimatedServerNowMs: number | null, nextServerNowMs: number) {
  return currentEstimatedServerNowMs == null || nextServerNowMs >= currentEstimatedServerNowMs;
}

export function isGameSessionPositionStale(nextGameSession: GameSession, currentGameSession: GameSession | null) {
  if (!currentGameSession || nextGameSession.id !== currentGameSession.id) {
    return false;
  }

  if (nextGameSession.currentQuestionIndex !== currentGameSession.currentQuestionIndex) {
    return nextGameSession.currentQuestionIndex < currentGameSession.currentQuestionIndex;
  }

  if (nextGameSession.currentRevealRound !== currentGameSession.currentRevealRound) {
    return nextGameSession.currentRevealRound < currentGameSession.currentRevealRound;
  }

  const nextRoundStartedAtMs = nextGameSession.roundStartedAt ? new Date(nextGameSession.roundStartedAt).getTime() : null;
  const currentRoundStartedAtMs = currentGameSession.roundStartedAt ? new Date(currentGameSession.roundStartedAt).getTime() : null;
  return (
    nextRoundStartedAtMs != null &&
    currentRoundStartedAtMs != null &&
    Number.isFinite(nextRoundStartedAtMs) &&
    Number.isFinite(currentRoundStartedAtMs) &&
    nextRoundStartedAtMs !== currentRoundStartedAtMs &&
    nextRoundStartedAtMs < currentRoundStartedAtMs
  );
}

export function isBuzzerAnswerReadyForJudging(
  answer: Pick<BuzzerAnswer, "submittedAt" | "serverReceivedAt">,
  nowMs: number,
) {
  return getBuzzerAnswerStabilityDelayMs(answer, nowMs) === 0;
}

export function getRoundActionProgress(
  participantIds: readonly string[],
  actedPlayerIds: ReadonlySet<string>,
) {
  const submittedCount = participantIds.filter((playerId) => actedPlayerIds.has(playerId)).length;
  const totalCount = participantIds.length;

  return {
    submittedCount,
    totalCount,
    progress: totalCount > 0 ? (submittedCount / totalCount) * 100 : 0,
  };
}

function getTeamName(team: TeamBattleTeam) {
  return team === "red" ? "红队" : "蓝队";
}

function getTeamTone(team: TeamBattleTeam) {
  return team === "red"
    ? {
        border: "border-red-200",
        panel: "border-red-200 bg-red-50",
        text: "text-red-700",
        soft: "bg-red-100 text-red-700",
        solid: "bg-red-600 text-white",
        ring: "ring-red-200",
      }
    : {
        border: "border-sky-200",
        panel: "border-sky-200 bg-sky-50",
        text: "text-sky-700",
        soft: "bg-sky-100 text-sky-700",
        solid: "bg-sky-600 text-white",
        ring: "ring-sky-200",
      };
}

function getTeamBattlePhaseLabel(phase: TeamBattlePhase) {
  if (phase === "PRESENTER_BLOCK") {
    return "禁用格子";
  }

  if (phase === "REVEAL_VOTE") {
    return "选格";
  }

  if (phase === "GUESS_VOTE") {
    return "猜测";
  }

  if (phase === "JUDGING") {
    return "判定";
  }

  if (phase === "TURN_RESULT") {
    return "回合结算";
  }

  return "复盘";
}

function getOpposingTeam(team: TeamBattleTeam): TeamBattleTeam {
  return team === "red" ? "blue" : "red";
}

function toQuestion(question: DbQuestion): Question {
  return {
    id: question.id,
    questionSetId: question.question_set_id,
    imageUrl: question.image_url,
    orderIndex: question.order_index,
    isR18: question.is_r18 === true || question.is_r18 === 1,
    labelText: question.label_text ?? null,
    labelSource: question.label_source ?? null,
    labelSourceAnswerId: question.label_source_answer_id ?? null,
    labelUpdatedByPlayerId: question.label_updated_by_player_id ?? null,
    labelUpdatedAt: question.label_updated_at ?? null,
    createdAt: question.created_at,
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

type AnswerBubble = {
  id: string;
  text: string;
  left: number;
  top: number;
  width: number;
};

type ResultPublishNextAction = "advanceReviewedQuestion" | "skipQuestion";

type StandardScoreRowProps = {
  playerId: string;
  nickname: string;
  rank: number;
  score: number;
  correctCount: number;
  alreadyCorrect: boolean;
  hasAnsweredCurrentRound: boolean;
  hasForfeitedCurrentRound: boolean;
  currentQuestionScoreAwarded: number;
  buzzerStatus?: BuzzerAnswer["status"];
  isBuzzerMode: boolean;
  isLeadingPendingBuzzerAnswer: boolean;
  showPlayerAnswer: boolean;
  playerAnswerText: string;
  playerAnswerStatus: ScoreboardAnswerStatus;
  playerAnswerLabel: string;
  onRowRef: (playerId: string, element: HTMLDivElement | null) => void;
};

type ScoreboardAnswerStatus = "correct" | "wrong" | "pending" | "forfeit" | "unanswered";

type ScoreboardAnswerDisplay = {
  text: string;
  status: ScoreboardAnswerStatus;
  label: string;
};

type CompactScoreStatus = {
  label: string;
  className: string;
  textClassName: string;
  content: string | JSX.Element | null;
};

function IconListDense(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M4 6h12M4 10h12M4 14h12" strokeLinecap="round" />
    </svg>
  );
}

function IconListDetail(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M7 5h9M7 10h9M7 15h9" strokeLinecap="round" />
      <path d="M4 5h.01M4 10h.01M4 15h.01" strokeLinecap="round" />
    </svg>
  );
}

function IconXMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" {...props}>
      <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
    </svg>
  );
}

function IconHourglass(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" {...props}>
      <path d="M4 2h12v2h-2l-3 4 3 4h2v2H4v-2h2l3-4-3-4H4V2zm4 2 2 2.5L12 4H8zm2 6.5L8 12h4l-2-1.5z" />
    </svg>
  );
}

function IconFlag(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M6 17V4M6 5h8l-1.5 3L14 11H6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCheck(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" {...props}>
      <path d="M5 10.5l3 3L15 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSpeaker(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M4 8.5h3l4-3.5v10l-4-3.5H4z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 7.5c.8.7 1.2 1.5 1.2 2.5s-.4 1.8-1.2 2.5" strokeLinecap="round" />
    </svg>
  );
}

function getCompactNameClass(nickname: string) {
  const length = Array.from(nickname).length;

  if (length <= 7) {
    return "text-[13px]";
  }

  if (length <= 10) {
    return "text-xs";
  }

  if (length <= 14) {
    return "text-[11px]";
  }

  return "text-[10px]";
}

function getCompactScoreClass(score: number) {
  if (Math.abs(score) >= 1000) {
    return "text-[11px]";
  }

  if (Math.abs(score) >= 100) {
    return "text-xs";
  }

  return "text-sm";
}

function getCompetitionRankByScore<T extends { score: number }>(rows: T[], index: number): number {
  const previousRow = rows[index - 1];

  return previousRow && previousRow.score === rows[index].score ? getCompetitionRankByScore(rows, index - 1) : index + 1;
}

function getScoreboardAnswerDisplay(params: {
  nickname: string;
  alreadyCorrect: boolean;
  currentAnswer?: Answer;
  correctAnswer?: Answer;
  buzzerAnswer?: BuzzerAnswer;
  hasForfeitedCurrentRound: boolean;
  isBuzzerMode: boolean;
  isLeadingPendingBuzzerAnswer: boolean;
}): ScoreboardAnswerDisplay {
  const {
    nickname,
    alreadyCorrect,
    currentAnswer,
    correctAnswer,
    buzzerAnswer,
    hasForfeitedCurrentRound,
    isBuzzerMode,
    isLeadingPendingBuzzerAnswer,
  } = params;

  if (alreadyCorrect || buzzerAnswer?.status === "correct") {
    const text = correctAnswer?.answerText ?? buzzerAnswer?.answerText ?? currentAnswer?.answerText ?? "—";
    return { text, status: "correct", label: `${nickname}回答：${text}，判定正确` };
  }

  if (hasForfeitedCurrentRound) {
    return { text: "放弃", status: "forfeit", label: `${nickname}本轮已放弃` };
  }

  if (buzzerAnswer?.status === "wrong") {
    return {
      text: buzzerAnswer.answerText,
      status: "wrong",
      label: `${nickname}回答：${buzzerAnswer.answerText}，判定错误`,
    };
  }

  if (buzzerAnswer?.status === "pending" || currentAnswer) {
    const text = buzzerAnswer?.answerText ?? currentAnswer?.answerText ?? "—";
    const pendingLabel = isLeadingPendingBuzzerAnswer ? "判定中" : isBuzzerMode ? "排队中" : "待判定";
    return { text, status: "pending", label: `${nickname}回答：${text}，${pendingLabel}` };
  }

  return { text: "", status: "unanswered", label: `${nickname}本轮尚未回答` };
}

function getScoreboardAnswerTone(status: ScoreboardAnswerStatus) {
  if (status === "correct") {
    return "bg-emerald-50 text-emerald-700";
  }

  if (status === "wrong") {
    return "bg-rose-50 text-rose-700";
  }

  if (status === "pending") {
    return "bg-sky-50 text-sky-700";
  }

  if (status === "forfeit") {
    return "bg-slate-200 text-slate-700";
  }

  return "bg-transparent text-slate-400";
}

function PlayerAnswerViewSwitch({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      aria-checked={enabled}
      aria-label="其他玩家回答"
      className="flex w-full items-center justify-between gap-3 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-200 focus-visible:ring-offset-2"
      role="switch"
      type="button"
      onClick={onToggle}
    >
      <span className="min-w-0">
        <span className="block font-semibold text-slate-950">其他玩家回答</span>
        <span className="mt-0.5 block text-xs font-medium text-[var(--muted)]">在积分榜中实时显示</span>
      </span>
      <span
        aria-hidden="true"
        className={[
          "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
          enabled ? "bg-slate-900" : "bg-slate-200",
        ].join(" ")}
      >
        <span
          className={[
            "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out",
            enabled ? "translate-x-5" : "translate-x-0",
          ].join(" ")}
        />
      </span>
    </button>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGameSession(value: unknown): value is GameSession {
  return isRecord(value) && typeof value.id === "string" && typeof value.roomId === "string" && "currentQuestionIndex" in value;
}

function isRoundSnapshot(value: unknown): value is RoundSnapshot {
  return (
    isRecord(value) &&
    isGameSession(value.gameSession) &&
    Array.isArray(value.scores) &&
    Array.isArray(value.questionResults) &&
    Array.isArray(value.answers) &&
    Array.isArray(value.labelAnswers) &&
    Array.isArray(value.buzzerAnswers) &&
    Array.isArray(value.labelBuzzerAnswers)
  );
}

function getRealtimeDeltas(message: { delta?: RealtimeDelta; deltas?: RealtimeDelta[] }) {
  return message.deltas ?? (message.delta ? [message.delta] : []);
}

function getRealtimeVersion(message: { version?: number }) {
  return typeof message.version === "number" && Number.isFinite(message.version) ? message.version : null;
}

function getLegacyBroadcastRoundSnapshot(message: { result?: unknown; roundSnapshot?: unknown }) {
  if (isRoundSnapshot(message.roundSnapshot)) {
    return message.roundSnapshot;
  }

  if (isRecord(message.result) && isRoundSnapshot(message.result.roundSnapshot)) {
    return message.result.roundSnapshot;
  }

  return null;
}

function getLegacyBroadcastGameSession(result: unknown) {
  if (isGameSession(result)) {
    return result;
  }

  if (isRecord(result) && isGameSession(result.gameSession)) {
    return result.gameSession;
  }

  return null;
}

const StandardScoreRow = memo(function StandardScoreRow({
  playerId,
  nickname,
  rank,
  score,
  correctCount,
  alreadyCorrect,
  hasAnsweredCurrentRound,
  hasForfeitedCurrentRound,
  currentQuestionScoreAwarded,
  buzzerStatus,
  isBuzzerMode,
  isLeadingPendingBuzzerAnswer,
  showPlayerAnswer,
  playerAnswerText,
  playerAnswerStatus,
  playerAnswerLabel,
  onRowRef,
}: StandardScoreRowProps) {
  const hasWrongCurrentRound = buzzerStatus === "wrong";

  return (
    <div
      className="rounded-md bg-slate-50 px-3 py-2 text-sm"
      ref={(element) => {
        onRowRef(playerId, element);
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 font-semibold text-slate-950">
          #{rank} {nickname}
        </div>
        <div className="shrink-0 font-semibold text-[var(--primary)]">{score}</div>
      </div>
      {showPlayerAnswer ? (
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-[var(--muted)]">
          <span className="shrink-0">答对 {correctCount} 题</span>
          <span className="flex min-w-0 flex-1 items-center">
            {playerAnswerStatus !== "unanswered" ? (
              <span
                aria-label={playerAnswerLabel}
                className={`inline-flex max-w-full min-w-0 items-center gap-1 rounded px-1.5 py-0.5 font-semibold ${getScoreboardAnswerTone(playerAnswerStatus)}`}
                title={playerAnswerLabel}
              >
                <span className="min-w-0 truncate">{playerAnswerText}</span>
                {playerAnswerStatus === "pending" ? <IconHourglass className="h-3.5 w-3.5 shrink-0" /> : null}
              </span>
            ) : null}
          </span>
          {currentQuestionScoreAwarded > 0 ? (
            <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-700">
              +{currentQuestionScoreAwarded} 分
            </span>
          ) : null}
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
          <span>答对 {correctCount} 题</span>
          {alreadyCorrect ? (
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-700">已答对</span>
          ) : null}
          {currentQuestionScoreAwarded > 0 ? (
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-700">
              +{currentQuestionScoreAwarded} 分
            </span>
          ) : null}
          {!alreadyCorrect && hasForfeitedCurrentRound ? (
            <span className="rounded bg-slate-200 px-1.5 py-0.5 font-semibold text-slate-700">已放弃</span>
          ) : null}
          {!alreadyCorrect && hasAnsweredCurrentRound && !hasForfeitedCurrentRound && !hasWrongCurrentRound ? (
            <span className="rounded bg-sky-50 px-1.5 py-0.5 font-semibold text-sky-700">已回答</span>
          ) : null}
          {isBuzzerMode && buzzerStatus === "pending" ? (
            <span className="rounded bg-sky-50 px-1.5 py-0.5 font-semibold text-sky-700">
              {isLeadingPendingBuzzerAnswer ? "判定中" : "排队中"}
            </span>
          ) : null}
          {!alreadyCorrect && hasWrongCurrentRound ? (
            <span className="rounded bg-slate-200 px-1.5 py-0.5 font-semibold text-slate-700">本轮已答错</span>
          ) : null}
        </div>
      )}
    </div>
  );
});

function getCompactScoreStatus({
  alreadyCorrect,
  hasAnsweredCurrentRound,
  hasForfeitedCurrentRound,
  currentQuestionScoreAwarded,
  buzzerStatus,
  isBuzzerMode,
  isLeadingPendingBuzzerAnswer,
}: Pick<
  StandardScoreRowProps,
  | "alreadyCorrect"
  | "hasAnsweredCurrentRound"
  | "hasForfeitedCurrentRound"
  | "currentQuestionScoreAwarded"
  | "buzzerStatus"
  | "isBuzzerMode"
  | "isLeadingPendingBuzzerAnswer"
>): CompactScoreStatus {
  const hasWrongCurrentRound = buzzerStatus === "wrong";

  if (alreadyCorrect) {
    const isLargeScoreAward = currentQuestionScoreAwarded >= 100;

    return {
      label: currentQuestionScoreAwarded > 0 ? `本题加 ${currentQuestionScoreAwarded} 分` : "已答对",
      className: "bg-emerald-50 text-emerald-700",
      textClassName: currentQuestionScoreAwarded > 0 && !isLargeScoreAward ? "text-xs" : "text-[11px]",
      content:
        currentQuestionScoreAwarded > 0 ? (
          `+${currentQuestionScoreAwarded}`
        ) : (
          <IconCheck className="h-4 w-4" />
        ),
    };
  }

  if (hasWrongCurrentRound) {
    return {
      label: "本轮已答错",
      className: "bg-rose-50 text-rose-700",
      textClassName: "text-[11px]",
      content: <IconXMark className="h-4 w-4" />,
    };
  }

  if (hasForfeitedCurrentRound) {
    return {
      label: "已放弃",
      className: "bg-slate-100 text-slate-600",
      textClassName: "text-[11px]",
      content: <IconFlag className="h-4 w-4" />,
    };
  }

  if ((isBuzzerMode && buzzerStatus === "pending") || hasAnsweredCurrentRound) {
    return {
      label: isLeadingPendingBuzzerAnswer ? "判定中" : "等待判定",
      className: "bg-sky-50 text-sky-700",
      textClassName: "text-[11px]",
      content: <IconHourglass className="h-4 w-4" />,
    };
  }

  return {
    label: "暂无状态",
    className: "bg-transparent text-slate-300",
    textClassName: "text-[11px]",
    content: null,
  };
}

const CompactScoreRow = memo(function CompactScoreRow({
  playerId,
  nickname,
  rank,
  score,
  alreadyCorrect,
  hasAnsweredCurrentRound,
  hasForfeitedCurrentRound,
  currentQuestionScoreAwarded,
  buzzerStatus,
  isBuzzerMode,
  isLeadingPendingBuzzerAnswer,
  onRowRef,
}: StandardScoreRowProps) {
  const status = getCompactScoreStatus({
    alreadyCorrect,
    hasAnsweredCurrentRound,
    hasForfeitedCurrentRound,
    currentQuestionScoreAwarded,
    buzzerStatus,
    isBuzzerMode,
    isLeadingPendingBuzzerAnswer,
  });

  return (
    <div
      className="grid h-8 grid-cols-[1rem_minmax(0,1fr)_max-content_minmax(1.75rem,max-content)] items-center gap-x-0.5 rounded-md bg-slate-50 px-1 text-sm"
      ref={(element) => {
        onRowRef(playerId, element);
      }}
    >
      <span className="text-right text-xs font-semibold tabular-nums text-slate-500">{rank}</span>
      <span className={`min-w-0 truncate font-semibold leading-none text-slate-950 ${getCompactNameClass(nickname)}`} title={nickname}>
        {nickname}
      </span>
      <span
        aria-label={status.label}
        className={`grid h-5 min-w-5 justify-self-end place-items-center rounded px-0.5 font-bold leading-none ${status.textClassName} ${status.className}`}
        title={status.label}
      >
        {status.content}
      </span>
      <span
        className={`min-w-7 shrink-0 text-right font-bold leading-none tabular-nums text-[var(--primary)] ${getCompactScoreClass(score)}`}
        title={`${score} 分`}
      >
        {score}
      </span>
    </div>
  );
});

function getRoundSnapshotFromValue(value: unknown) {
  return isRecord(value) && isRoundSnapshot(value.roundSnapshot) ? value.roundSnapshot : null;
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  return items.some((currentItem) => currentItem.id === item.id)
    ? items.map((currentItem) => (currentItem.id === item.id ? item : currentItem))
    : [...items, item];
}

function upsertBySubmittedAt<T extends { id: string; submittedAt: string }>(items: T[], item: T) {
  return sortBySubmittedAt(upsertById(items, item));
}

function applyCorrectBuzzerAnswerChanges(currentAnswers: Answer[], changes: BuzzerAnswer[]) {
  return sortBySubmittedAt(
    changes.reduce(
      (nextAnswers, answer) =>
        answer.status === "correct"
          ? upsertById(nextAnswers, answer)
          : nextAnswers.filter((currentAnswer) => currentAnswer.id !== answer.id),
      currentAnswers,
    ),
  );
}

type AnswerPanelFilter = "all" | "pending" | "judged" | "unanswered";

type AnswerPanelRow = {
  player: Player;
  answer: BuzzerAnswer | null;
  hasForfeited: boolean;
};

type AnswerJudgementPanelProps = {
  questionNumber: number;
  revealRound: number;
  countdownLabel: string;
  rows: AnswerPanelRow[];
  pendingCount: number;
  correctCount: number;
  wrongCount: number;
  unansweredCount: number;
  canMarkAllPendingWrong: boolean;
  isMarkingAllPendingWrong: boolean;
  canRevealAnswer: (answer: BuzzerAnswer) => boolean;
  canJudgeAnswer: (answer: BuzzerAnswer) => boolean;
  onJudge: (answer: BuzzerAnswer, isCorrect: boolean) => void;
  onMarkAllPendingWrong: () => void;
  onClose: () => void;
};

function AnswerJudgementPanel({
  questionNumber,
  revealRound,
  countdownLabel,
  rows,
  pendingCount,
  correctCount,
  wrongCount,
  unansweredCount,
  canMarkAllPendingWrong,
  isMarkingAllPendingWrong,
  canRevealAnswer,
  canJudgeAnswer,
  onJudge,
  onMarkAllPendingWrong,
  onClose,
}: AnswerJudgementPanelProps) {
  const [filter, setFilter] = useState<AnswerPanelFilter>("all");
  const [filteredPlayerIds, setFilteredPlayerIds] = useState<string[] | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [onClose]);

  const matchesFilter = (row: AnswerPanelRow, nextFilter: AnswerPanelFilter) => {
    if (nextFilter === "pending") return row.answer?.status === "pending";
    if (nextFilter === "judged") return row.answer?.status === "correct" || row.answer?.status === "wrong";
    if (nextFilter === "unanswered") return !row.answer && !row.hasForfeited;
    return true;
  };
  const rowByPlayerId = new Map(rows.map((row) => [row.player.id, row]));
  const filteredRows = filteredPlayerIds
    ? filteredPlayerIds.flatMap((playerId) => {
        const row = rowByPlayerId.get(playerId);
        return row ? [row] : [];
      })
    : rows;
  const answerOrderByPlayerId = new Map(
    rows.filter((row) => row.answer).map((row, index) => [row.player.id, index + 1]),
  );
  const filterOptions: Array<{ value: AnswerPanelFilter; label: string }> = [
    { value: "all", label: "全部" },
    { value: "pending", label: `待判定 ${pendingCount}` },
    { value: "judged", label: `已判定 ${correctCount + wrongCount}` },
    { value: "unanswered", label: `未回答 ${unansweredCount}` },
  ];

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-hidden bg-slate-950/55 px-3 py-3 sm:px-5 sm:py-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-describedby="answer-judgement-panel-description"
        aria-labelledby="answer-judgement-panel-title"
        aria-modal="true"
        className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-2xl"
        ref={dialogRef}
        role="dialog"
      >
        <header className="shrink-0 border-b border-[var(--line)] px-4 py-4 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold text-slate-950" id="answer-judgement-panel-title">
                  回答判定面板
                </h2>
                <span className="rounded bg-slate-100 px-2 py-1 text-xs font-bold text-slate-700">
                  第 {questionNumber} 题 · 第 {revealRound} 轮
                </span>
                <span
                  className={[
                    "rounded px-2 py-1 text-sm font-bold tabular-nums",
                    countdownLabel === "已截止" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800",
                  ].join(" ")}
                >
                  {countdownLabel}
                </span>
              </div>
              <p className="mt-1 text-sm text-[var(--muted)]" id="answer-judgement-panel-description">
                当前轮判定实时生效
              </p>
            </div>
            <button
              className="shrink-0 rounded-md border border-[var(--line)] px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-200"
              ref={closeRef}
              type="button"
              onClick={onClose}
            >
              关闭
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-semibold">
            <span className="text-slate-700">参与 {rows.length}</span>
            <span className="text-amber-700">待判定 {pendingCount}</span>
            <span className="text-emerald-700">答对 {correctCount}</span>
            <span className="text-rose-700">答错 {wrongCount}</span>
            <span className="text-slate-500">未回答 {unansweredCount}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2" aria-label="回答筛选">
            {filterOptions.map((option) => (
              <button
                aria-pressed={filter === option.value}
                className={[
                  "rounded-md border px-3 py-1.5 text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-200",
                  filter === option.value
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-[var(--line)] bg-white text-slate-700 hover:bg-slate-50",
                ].join(" ")}
                key={option.value}
                type="button"
                onClick={() => {
                  setFilter(option.value);
                  setFilteredPlayerIds(
                    option.value === "all"
                      ? null
                      : rows.filter((row) => matchesFilter(row, option.value)).map((row) => row.player.id),
                  );
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5">
          <div className="grid gap-2 md:grid-cols-2">
            {filteredRows.map(({ player, answer, hasForfeited }) => {
              const status = answer?.status ?? null;
              const isAnswerRevealed = Boolean(answer && canRevealAnswer(answer));
              const canJudge = Boolean(answer && isAnswerRevealed && canJudgeAnswer(answer));
              return (
                <div
                  className={[
                    "grid min-h-20 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-3 py-2.5",
                    status === "correct"
                      ? "border-emerald-300 bg-emerald-50"
                      : status === "wrong"
                        ? "border-rose-300 bg-rose-50"
                        : "border-[var(--line)] bg-slate-50",
                  ].join(" ")}
                  key={player.id}
                >
                  <span className="text-center text-xs font-bold tabular-nums text-slate-500">
                    {status === "correct" ? (
                      <IconCheck className="mx-auto h-5 w-5 text-emerald-700" />
                    ) : status === "wrong" ? (
                      <IconXMark className="mx-auto h-5 w-5 text-rose-700" />
                    ) : answer ? (
                      answerOrderByPlayerId.get(player.id)
                    ) : (
                      "…"
                    )}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={[
                        "break-words text-base leading-snug",
                        answer ? "font-semibold text-slate-950" : "font-medium text-slate-500",
                      ].join(" ")}
                    >
                      {answer
                        ? isAnswerRevealed
                          ? answer.answerText
                          : "答案确认中…"
                        : hasForfeited
                          ? "已放弃"
                          : "等待回答"}
                    </p>
                    {answer || hasForfeited ? (
                      <p className="mt-1 truncate text-xs font-medium text-slate-500" title={player.nickname}>
                        {player.nickname}
                      </p>
                    ) : null}
                  </div>
                  {answer && isAnswerRevealed ? (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        aria-label={`将${player.nickname}的回答判为答对`}
                        aria-pressed={status === "correct"}
                        className={[
                          "grid h-10 w-10 place-items-center rounded-md border focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-40",
                          status === "correct"
                            ? "border-emerald-600 bg-emerald-600 text-white"
                            : "border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50",
                        ].join(" ")}
                        disabled={!canJudge}
                        title="判为答对"
                        type="button"
                        onClick={() => onJudge(answer, true)}
                      >
                        <IconCheck className="h-5 w-5" />
                      </button>
                      <button
                        aria-label={`将${player.nickname}的回答判为答错`}
                        aria-pressed={status === "wrong"}
                        className={[
                          "grid h-10 w-10 place-items-center rounded-md border focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:opacity-40",
                          status === "wrong"
                            ? "border-rose-600 bg-rose-600 text-white"
                            : "border-rose-300 bg-white text-rose-700 hover:bg-rose-50",
                        ].join(" ")}
                        disabled={!canJudge}
                        title="判为答错"
                        type="button"
                        onClick={() => onJudge(answer, false)}
                      >
                        <IconXMark className="h-5 w-5" />
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs font-semibold text-slate-400">
                      {answer ? "确认中" : hasForfeited ? "放弃" : "等待"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <footer className="shrink-0 border-t border-[var(--line)] bg-slate-50 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-medium text-[var(--muted)]">
              {canMarkAllPendingWrong ? "仅处理当前轮尚未判定的已提交回答" : "本轮提交结束后可批量判错"}
            </p>
            <Button
              type="button"
              variant="secondary"
              disabled={!canMarkAllPendingWrong || pendingCount === 0 || isMarkingAllPendingWrong}
              onClick={onMarkAllPendingWrong}
            >
              {pendingCount === 0 ? "暂无未判定回答" : "未判定回答全判错"}
              {pendingCount > 0 ? <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-xs tabular-nums text-slate-800">{pendingCount}</span> : null}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function drawRevealedBlocksOnCanvas(canvas: HTMLCanvasElement, image: HTMLImageElement, revealedBlocks: number[]) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const { columns, rows, blockCount } = getRevealGridConfig(height > width);
  const blockWidth = width / columns;
  const blockHeight = height / rows;

  canvas.width = width;
  canvas.height = height;
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);

  for (const blockIndex of revealedBlocks) {
    if (blockIndex >= blockCount) {
      continue;
    }

    const column = blockIndex % columns;
    const row = Math.floor(blockIndex / columns);
    const sourceX = column * blockWidth;
    const sourceY = row * blockHeight;

    context.drawImage(image, sourceX, sourceY, blockWidth, blockHeight, sourceX, sourceY, blockWidth, blockHeight);
  }
}

export function ImageRevealGame({
  room,
  playerId,
  isPresenter,
  isSpectator = false,
  roomChat,
  footerActions,
  onError,
  onRoomUpdated,
}: ImageRevealGameProps) {
  const [gameSession, setGameSession] = useState<GameSession | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedBlocks, setSelectedBlocks] = useState<number[]>([]);
  const [teamSelectedBlocks, setTeamSelectedBlocks] = useState<number[]>([]);
  const [teamDisabledBlockDraft, setTeamDisabledBlockDraft] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [answerBubbles, setAnswerBubbles] = useState<Record<string, AnswerBubble>>({});
  const [buzzerAnswers, setBuzzerAnswers] = useState<BuzzerAnswer[]>([]);
  const [myBuzzerAnswer, setMyBuzzerAnswer] = useState<BuzzerAnswer | null>(null);
  const [labelAnswers, setLabelAnswers] = useState<Answer[]>([]);
  const [myAnswer, setMyAnswer] = useState<Answer | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [teamGuessText, setTeamGuessText] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [selectedLabelAnswerId, setSelectedLabelAnswerId] = useState<string | null>(null);
  const [resultPublishTitle, setResultPublishTitle] = useState("");
  const [resultPublishDescription, setResultPublishDescription] = useState("");
  const [resultPublishCreationMethod, setResultPublishCreationMethod] = useState<QuestionSetCreationMethod>("player_manual");
  const [scores, setScores] = useState<PlayerScore[]>([]);
  const [questionResults, setQuestionResults] = useState<QuestionResult[]>([]);
  const [remainingSeconds, setRemainingSeconds] = useState(DEFAULT_ROUND_SECONDS);
  const [hasRoundDeadlineGraceExpired, setHasRoundDeadlineGraceExpired] = useState(false);
  const [buzzerQueueClockTick, setBuzzerQueueClockTick] = useState(0);
  const [teamBattleClockMs, setTeamBattleClockMs] = useState(() => Date.now());
  const [isLoading, setIsLoading] = useState(true);
  const [isConfirmingReveal, setIsConfirmingReveal] = useState(false);
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false);
  const [isSettlingBuzzerRound, setIsSettlingBuzzerRound] = useState(false);
  const [isSubmittingTeamBattle, setIsSubmittingTeamBattle] = useState(false);
  const [isJudgingTeamBattle, setIsJudgingTeamBattle] = useState(false);
  const [isAdvancingTeamBattleTurn, setIsAdvancingTeamBattleTurn] = useState(false);
  const [isAdvancingQuestion, setIsAdvancingQuestion] = useState(false);
  const [isSkippingQuestion, setIsSkippingQuestion] = useState(false);
  const [isSavingLabel, setIsSavingLabel] = useState(false);
  const [isAnswerPanelOpen, setIsAnswerPanelOpen] = useState(false);
  const [isMarkingPendingWrong, setIsMarkingPendingWrong] = useState(false);
  const [answerPanelCompletionCheckTick, setAnswerPanelCompletionCheckTick] = useState(0);
  const [isPublishingBeforeResult, setIsPublishingBeforeResult] = useState(false);
  const [isLabelModalOpen, setIsLabelModalOpen] = useState(false);
  const [reviewedQuestionIndex, setReviewedQuestionIndex] = useState<number | null>(null);
  const [reviewImageLoadFailed, setReviewImageLoadFailed] = useState(false);
  const [resultPublishQuestionSet, setResultPublishQuestionSet] = useState<QuestionSet | null>(null);
  const [resultPublishNextAction, setResultPublishNextAction] = useState<ResultPublishNextAction | null>(null);
  const [isRevealPreviewOpen, setIsRevealPreviewOpen] = useState(false);
  const [isSpectatorLabelOpen, setIsSpectatorLabelOpen] = useState(false);
  const [isAnswerViewEnabled, setIsAnswerViewEnabled] = useState(false);
  const [isScoreboardCompact, setIsScoreboardCompact] = useState(false);
  const [isLabelPromptDisabledForGame, setIsLabelPromptDisabledForGame] = useState(false);
  const [isRoundPromptSoundEnabled, setIsRoundPromptSoundEnabled] = useState(getInitialRoundPromptSoundEnabled);
  const [isRoundPromptSoundVolumeOpen, setIsRoundPromptSoundVolumeOpen] = useState(false);
  const [roundPromptSoundVolume, setRoundPromptSoundVolume] = useState(getInitialRoundPromptSoundVolume);
  const [imageAspectRatio, setImageAspectRatio] = useState(16 / 9);
  const [isPortraitImage, setIsPortraitImage] = useState(false);
  const [presenterImageReadyQuestionId, setPresenterImageReadyQuestionId] = useState<string | null>(null);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const [playerImageRetryAttempt, setPlayerImageRetryAttempt] = useState(0);
  const [playerImageRetryToken, setPlayerImageRetryToken] = useState(0);
  const [lastAutoLabelKey, setLastAutoLabelKey] = useState("");
  const [canRenderPortal, setCanRenderPortal] = useState(false);
  const [playerImageCanvas, setPlayerImageCanvas] = useState<HTMLCanvasElement | null>(null);
  const [imageDisplayHeight, setImageDisplayHeight] = useState<number | null>(null);
  const imageDisplayRef = useRef<HTMLDivElement | null>(null);
  const playerImageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerLoadedImageRef = useRef<{ questionId: string; imageUrl: string; image: HTMLImageElement } | null>(null);
  const scoreRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const gameSessionRef = useRef<GameSession | null>(null);
  const answerInputRef = useRef<HTMLInputElement | null>(null);
  const teamGuessInputRef = useRef<HTMLInputElement | null>(null);
  const roundPromptSoundControlsRef = useRef<HTMLDivElement | null>(null);
  const previousReviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousReviewCloseRef = useRef<HTMLButtonElement | null>(null);
  const answerPanelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const answerJudgementQueueRef = useRef(new Map<string, boolean>());
  const answerJudgementFlushTimerRef = useRef<number | null>(null);
  const answerJudgementFlushPromiseRef = useRef<Promise<void> | null>(null);
  const answerJudgementContextRef = useRef<{ gameSessionId: string; questionIndex: number; revealRound: number } | null>(null);
  const answerPanelAutoCloseArmedRef = useRef(false);
  const answerPanelPendingJudgementIdsRef = useRef(new Set<string>());
  const serverClockRef = useRef<{ serverNowMs: number; clientNowMs: number } | null>(null);
  const roundSnapshotFetchRef = useRef<{
    gameSessionId: string;
    promise: Promise<GameBootstrapSnapshot>;
    targetVersion: number | null;
    generation: number;
  } | null>(null);
  const isBootstrapLoadingRef = useRef(false);
  const lastGameRealtimeVersionRef = useRef<number | null>(null);
  const missedGameRealtimeVersionRef = useRef(false);
  const gameCatchUpTargetVersionRef = useRef<number | null>(null);
  const gameCatchUpRetryTimerRef = useRef<number | null>(null);
  const gameCatchUpRetryAttemptRef = useRef(0);
  const gameCatchUpGenerationRef = useRef(0);
  const lastRoundPromptPositionRef = useRef<string | null>(null);
  const hasObservedRoundPromptPositionRef = useRef(false);
  const onRoomUpdatedRef = useRef(onRoomUpdated);

  const setPlayerImageCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    playerImageCanvasRef.current = canvas;
    setPlayerImageCanvas(canvas);
  }, []);

  const setImageDisplayRef = useCallback((element: HTMLDivElement | null) => {
    imageDisplayRef.current = element;
  }, []);

  const getPlayerName = useCallback(
    (targetPlayerId: string) =>
      room.players.find((player) => player.id === targetPlayerId)?.nickname ??
      gameSessionRef.current?.teamBattleState?.teamMemberNames?.[targetPlayerId] ??
      "玩家",
    [room.players],
  );

  function syncServerClock(nextGameSession: GameSession) {
    if (!nextGameSession.serverNow) {
      return;
    }

    const serverNowMs = new Date(nextGameSession.serverNow).getTime();
    if (Number.isFinite(serverNowMs)) {
      const currentClock = serverClockRef.current;
      if (currentClock) {
        const currentEstimatedServerNowMs = currentClock.serverNowMs + (performance.now() - currentClock.clientNowMs);
        if (!shouldAcceptServerClock(currentEstimatedServerNowMs, serverNowMs)) {
          return;
        }
      }
      serverClockRef.current = {
        serverNowMs,
        clientNowMs: performance.now(),
      };
    }
  }

  function getEstimatedServerNowMs() {
    const serverClock = serverClockRef.current;
    if (!serverClock) {
      return Date.now();
    }

    return serverClock.serverNowMs + (performance.now() - serverClock.clientNowMs);
  }

  function getClientRoundElapsedMs(targetGameSession: GameSession) {
    if (!targetGameSession.roundStartedAt) {
      return null;
    }

    const roundStartedAtMs = new Date(targetGameSession.roundStartedAt).getTime();
    if (!Number.isFinite(roundStartedAtMs)) {
      return null;
    }

    return Math.max(0, getEstimatedServerNowMs() - roundStartedAtMs);
  }

  function isStaleGameSession(nextGameSession: GameSession, currentGameSession: GameSession | null) {
    return isGameSessionPositionStale(nextGameSession, currentGameSession);
  }

  function applyGameSession(nextGameSession: GameSession, options: { syncClock?: boolean } = {}) {
    if (isStaleGameSession(nextGameSession, gameSessionRef.current)) {
      return false;
    }

    const shouldSyncClock = options.syncClock ?? true;
    if (shouldSyncClock) {
      syncServerClock(nextGameSession);
    }
    gameSessionRef.current = nextGameSession;
    updateGameSessionRealtimeQuestion(nextGameSession.id, nextGameSession.currentQuestionIndex);
    setGameSession(nextGameSession);
    const nowMs =
      shouldSyncClock || serverClockRef.current ? getEstimatedServerNowMs() : new Date(nextGameSession.serverNow ?? "").getTime();
    setRemainingSeconds(
      getRemainingSeconds(
        nextGameSession.roundStartedAt,
        nextGameSession.roundSeconds,
        Number.isFinite(nowMs) ? nowMs : Date.now(),
      ),
    );
    return true;
  }

  function clearRoundAnswerState() {
    setAnswers([]);
    setBuzzerAnswers([]);
    setLabelAnswers([]);
    setMyAnswer(null);
    setMyBuzzerAnswer(null);
  }

  function applyGameSessionDelta(nextGameSession: GameSession) {
    const currentGameSession = gameSessionRef.current;
    const shouldClearRoundAnswers =
      !currentGameSession ||
      currentGameSession.currentQuestionIndex !== nextGameSession.currentQuestionIndex ||
      currentGameSession.currentRevealRound !== nextGameSession.currentRevealRound ||
      (!currentGameSession.roundStartedAt && Boolean(nextGameSession.roundStartedAt));

    const didApply = applyGameSession(nextGameSession, { syncClock: !serverClockRef.current });
    if (!didApply) {
      return false;
    }

    if (shouldClearRoundAnswers) {
      clearRoundAnswerState();
    }
    return true;
  }

  const applyRoundSnapshot = useCallback(
    (snapshot: RoundSnapshot) => {
      const targetGameSession = snapshot.gameSession;
      const didApply = applyGameSession(targetGameSession);
      if (!didApply) {
        return;
      }
      setScores(snapshot.scores);
      setQuestionResults(snapshot.questionResults);
      const canViewSnapshotAnswers = isPresenter || isSpectator || snapshot.questionResults.some((result) => result.playerId === playerId);

      if (targetGameSession.gameMode === "ROUND_REVEAL") {
        setAnswers(sortBySubmittedAt(snapshot.answers));
        setBuzzerAnswers(sortBySubmittedAt(snapshot.buzzerAnswers));

        if (canViewSnapshotAnswers) {
          setLabelAnswers(sortBySubmittedAt(snapshot.labelAnswers.filter((answer) => !isForfeitAnswer(answer))));
        } else {
          setLabelAnswers([]);
        }

        if (isPresenter) {
          setMyBuzzerAnswer(null);
        } else {
          setMyAnswer(snapshot.answers.find((answer) => answer.playerId === playerId) ?? null);
          setMyBuzzerAnswer(snapshot.buzzerAnswers.find((answer) => answer.playerId === playerId) ?? null);
        }
        return;
      }

      if (targetGameSession.gameMode === "TEAM_BATTLE") {
        setAnswers([]);
        setBuzzerAnswers([]);
        setLabelAnswers([]);
        setMyAnswer(null);
        setMyBuzzerAnswer(null);
        return;
      }

      setAnswers(sortBySubmittedAt(snapshot.answers));
      setBuzzerAnswers(sortBySubmittedAt(snapshot.buzzerAnswers));
      setLabelAnswers(
        getCorrectLabelAnswersFromBuzzerAnswers(snapshot.labelBuzzerAnswers),
      );
      setMyAnswer(isPresenter ? null : snapshot.answers.find((answer) => answer.playerId === playerId) ?? null);
      setMyBuzzerAnswer(isPresenter ? null : snapshot.buzzerAnswers.find((answer) => answer.playerId === playerId) ?? null);
    },
    [isPresenter, isSpectator, playerId],
  );

  const catchUpRoundSnapshot = useCallback(() => {
    if (!room.currentGameId) {
      return;
    }
    if (gameCatchUpRetryTimerRef.current != null) {
      return;
    }

    const generation = gameCatchUpGenerationRef.current;
    const currentFetch = roundSnapshotFetchRef.current;
    if (currentFetch?.gameSessionId === room.currentGameId && currentFetch.generation === generation) {
      return;
    }
    const targetVersion = gameCatchUpTargetVersionRef.current;
    const snapshotPromise = getGameBootstrapSnapshot(room.currentGameId).finally(() => {
      if (roundSnapshotFetchRef.current?.promise === snapshotPromise) {
        roundSnapshotFetchRef.current = null;
      }
    });
    const snapshotFetch = { gameSessionId: room.currentGameId, promise: snapshotPromise, targetVersion, generation };
    roundSnapshotFetchRef.current = snapshotFetch;

    snapshotFetch.promise
      .then((snapshot) => {
        if (generation !== gameCatchUpGenerationRef.current || snapshot.gameSession.id !== room.currentGameId) {
          return;
        }

        setQuestions(snapshot.questions);
        applyRoundSnapshot(snapshot.roundSnapshot);
        setImageLoadFailed(false);
        gameCatchUpRetryAttemptRef.current = 0;
        const coveredTargetVersion = snapshotFetch.targetVersion;
        if (coveredTargetVersion != null) {
          lastGameRealtimeVersionRef.current = Math.max(
            lastGameRealtimeVersionRef.current ?? 0,
            coveredTargetVersion,
          );
        }

        const latestTargetVersion = gameCatchUpTargetVersionRef.current;
        if (
          latestTargetVersion != null &&
          (coveredTargetVersion == null || latestTargetVersion > coveredTargetVersion)
        ) {
          missedGameRealtimeVersionRef.current = true;
          catchUpRoundSnapshot();
          return;
        } else {
          gameCatchUpTargetVersionRef.current = null;
          missedGameRealtimeVersionRef.current = false;
        }
      })
      .catch((error) => {
        if (generation !== gameCatchUpGenerationRef.current) {
          return;
        }
        if (!missedGameRealtimeVersionRef.current || gameCatchUpRetryAttemptRef.current === 0) {
          onError(error instanceof Error ? error.message : "同步游戏快照失败");
        }
        if (missedGameRealtimeVersionRef.current && gameCatchUpRetryTimerRef.current == null) {
          const baseRetryDelay = Math.min(15000, 500 * 2 ** Math.min(gameCatchUpRetryAttemptRef.current, 5));
          const retryDelay = Math.round(baseRetryDelay * (0.8 + Math.random() * 0.4));
          gameCatchUpRetryAttemptRef.current += 1;
          gameCatchUpRetryTimerRef.current = window.setTimeout(() => {
            gameCatchUpRetryTimerRef.current = null;
            if (generation === gameCatchUpGenerationRef.current) {
              catchUpRoundSnapshot();
            }
          }, retryDelay);
        }
      });
  }, [applyRoundSnapshot, onError, room.currentGameId]);

  const applyLegacyRealtimeMessage = useCallback(
    (message: { result?: unknown; roundSnapshot?: unknown }) => {
      const pushedRoundSnapshot = getLegacyBroadcastRoundSnapshot(message);
      if (pushedRoundSnapshot && pushedRoundSnapshot.gameSession.id === room.currentGameId) {
        applyRoundSnapshot(pushedRoundSnapshot);
        return "applied";
      }

      const pushedGameSession = getLegacyBroadcastGameSession(message.result);
      if (pushedGameSession && pushedGameSession.id === room.currentGameId) {
        return "catch-up";
      }

      return "ignored";
    },
    [applyRoundSnapshot, room.currentGameId],
  );

  const applyRoundSnapshotFromResult = useCallback(
    (result: unknown) => {
      const snapshot = getRoundSnapshotFromValue(result);
      if (!snapshot) {
        return false;
      }

      applyRoundSnapshot(snapshot);
      return true;
    },
    [applyRoundSnapshot],
  );

  const showAnswerBubble = useCallback((answer: Answer) => {
    const bubbleId = `${answer.id}:${answer.submittedAt}`;
    const anchor = scoreRowRefs.current[answer.playerId];
    const rect = anchor?.getBoundingClientRect();
    const width = 224;
    const left = rect ? Math.min(rect.right + 8, window.innerWidth - width - 12) : 16;
    const top = rect ? Math.max(12, rect.top + rect.height / 2) : 16;

    setAnswerBubbles((currentBubbles) => ({
      ...currentBubbles,
      [answer.playerId]: {
        id: bubbleId,
        text: answer.answerText,
        left,
        top,
        width,
      },
    }));

    window.setTimeout(() => {
      setAnswerBubbles((currentBubbles) => {
        if (currentBubbles[answer.playerId]?.id !== bubbleId) {
          return currentBubbles;
        }

        const nextBubbles = { ...currentBubbles };
        delete nextBubbles[answer.playerId];
        return nextBubbles;
      });
    }, 3200);
  }, []);

  const registerScoreRow = useCallback((targetPlayerId: string, element: HTMLDivElement | null) => {
    scoreRowRefs.current[targetPlayerId] = element;
  }, []);

  useEffect(() => {
    setCanRenderPortal(true);
  }, []);

  useLayoutEffect(() => {
    const element = imageDisplayRef.current;

    if (!element) {
      setImageDisplayHeight(null);
      return;
    }

    const updateImageDisplayHeight = () => {
      const rect = element.getBoundingClientRect();
      const sixteenNineHeight = Math.min(rect.width * (9 / 16), window.innerHeight * 0.78);
      const nextHeight = Math.round(Math.max(rect.height, sixteenNineHeight));
      setImageDisplayHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
    };

    updateImageDisplayHeight();
    window.addEventListener("resize", updateImageDisplayHeight);

    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", updateImageDisplayHeight);
    }

    const resizeObserver = new ResizeObserver(updateImageDisplayHeight);
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateImageDisplayHeight);
    };
  }, [gameSession?.currentQuestionIndex, gameSession?.id, imageAspectRatio, isPortraitImage]);

  useEffect(() => {
    gameSessionRef.current = gameSession;
  }, [gameSession]);

  useEffect(() => {
    const nextContext = gameSession
      ? {
          gameSessionId: gameSession.id,
          questionIndex: gameSession.currentQuestionIndex,
          revealRound: gameSession.currentRevealRound,
        }
      : null;
    const previousContext = answerJudgementContextRef.current;
    const didChangeRound = Boolean(
      previousContext &&
      (!nextContext ||
        previousContext.gameSessionId !== nextContext.gameSessionId ||
        previousContext.questionIndex !== nextContext.questionIndex ||
        previousContext.revealRound !== nextContext.revealRound),
    );
    if (didChangeRound) {
      answerJudgementQueueRef.current.clear();
      answerPanelAutoCloseArmedRef.current = false;
      answerPanelPendingJudgementIdsRef.current.clear();
      if (answerJudgementFlushTimerRef.current !== null) {
        window.clearTimeout(answerJudgementFlushTimerRef.current);
        answerJudgementFlushTimerRef.current = null;
      }
      setIsAnswerPanelOpen(false);
    }
    answerJudgementContextRef.current = nextContext;
  }, [gameSession?.currentQuestionIndex, gameSession?.currentRevealRound, gameSession?.id]);

  useEffect(() => () => {
    if (answerJudgementFlushTimerRef.current !== null) {
      window.clearTimeout(answerJudgementFlushTimerRef.current);
    }
  }, []);

  useEffect(() => {
    onRoomUpdatedRef.current = onRoomUpdated;
  }, [onRoomUpdated]);

  useEffect(() => {
    gameCatchUpGenerationRef.current += 1;
    serverClockRef.current = null;
    roundSnapshotFetchRef.current = null;
    lastGameRealtimeVersionRef.current = null;
    missedGameRealtimeVersionRef.current = false;
    gameCatchUpTargetVersionRef.current = null;
    gameCatchUpRetryAttemptRef.current = 0;
    if (gameCatchUpRetryTimerRef.current != null) {
      window.clearTimeout(gameCatchUpRetryTimerRef.current);
      gameCatchUpRetryTimerRef.current = null;
    }

    return () => {
      gameCatchUpGenerationRef.current += 1;
      roundSnapshotFetchRef.current = null;
      missedGameRealtimeVersionRef.current = false;
      if (gameCatchUpRetryTimerRef.current != null) {
        window.clearTimeout(gameCatchUpRetryTimerRef.current);
        gameCatchUpRetryTimerRef.current = null;
      }
    };
  }, [room.currentGameId, room.id]);

  useEffect(() => {
    let isMounted = true;
    let unbindGameSessionTopic: () => void = () => undefined;

    async function loadGame() {
      if (!room.id || !room.currentGameId) {
        return;
      }

      unbindGameSessionTopic = bindGameSessionRealtimeTopic(room.currentGameId, `room:${room.id}`);
      ensureRealtimeTopic(`room:${room.id}`, playerId);
      isBootstrapLoadingRef.current = true;
      setIsLoading(true);
      try {
        const bootstrapSnapshot = await getGameBootstrapSnapshot(room.currentGameId);

        if (isMounted) {
          applyGameSession(bootstrapSnapshot.gameSession);
          setQuestions(bootstrapSnapshot.questions);
          setImageLoadFailed(false);
          applyRoundSnapshot(bootstrapSnapshot.roundSnapshot);
          if (gameCatchUpTargetVersionRef.current == null) {
            missedGameRealtimeVersionRef.current = false;
          } else {
            missedGameRealtimeVersionRef.current = true;
            catchUpRoundSnapshot();
          }
        }
      } catch (error) {
        if (isMounted) {
          onError(error instanceof Error ? error.message : "加载游戏失败");
        }
      } finally {
        isBootstrapLoadingRef.current = false;
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadGame();

    return () => {
      isMounted = false;
      unbindGameSessionTopic();
    };
  }, [applyRoundSnapshot, catchUpRoundSnapshot, onError, playerId, room.currentGameId, room.id]);

  const applyRealtimeDelta = useCallback(
    (delta: RealtimeDelta) => {
      if (delta.scope === "room" && delta.type === "room_updated" && delta.room.id === room.id) {
        onRoomUpdatedRef.current?.(delta.room);
        return;
      }

      if (delta.scope === "game" && delta.type === "question_label_updated") {
        setQuestions((currentQuestions) =>
          currentQuestions.map((question) => (question.id === delta.question.id ? delta.question : question)),
        );
        return;
      }

      if (delta.scope === "game" && delta.type === "round_snapshot" && delta.snapshot.gameSession.id === room.currentGameId) {
        applyRoundSnapshot(delta.snapshot);
        setImageLoadFailed(false);
        setSelectedBlocks([]);
        return;
      }

      if (delta.scope === "game" && delta.type === "game_session_updated" && delta.gameSession.id === room.currentGameId) {
        applyGameSessionDelta(delta.gameSession);
        setImageLoadFailed(false);
        setSelectedBlocks([]);
        return;
      }

      if (delta.scope === "game" && delta.type === "answer_canceled" && delta.gameSession.id === room.currentGameId) {
        applyGameSessionDelta(delta.gameSession);
        setAnswers((currentAnswers) => currentAnswers.filter((answer) => answer.id !== delta.canceledAnswerId));
        setLabelAnswers((currentAnswers) => currentAnswers.filter((answer) => answer.id !== delta.canceledAnswerId));
        if (delta.canceledPlayerId === playerId) {
          setMyAnswer((currentAnswer) => (currentAnswer?.id === delta.canceledAnswerId ? null : currentAnswer));
          setAnswerText("");
        }
        return;
      }

      if (delta.scope === "game" && delta.type === "answer_progress_changed") {
        const activeSession = gameSessionRef.current;
        if (!activeSession || activeSession.id !== room.currentGameId) return;
        const didApplyGameSession = delta.gameSession ? applyGameSessionDelta(delta.gameSession) : true;
        if (!didApplyGameSession) return;
        const canceledPlayerIds = new Set(delta.canceledPlayerIds ?? []);
        setAnswers((currentAnswers) => {
          let nextAnswers = currentAnswers.filter((answer) => !canceledPlayerIds.has(answer.playerId));
          for (const progress of delta.answers) {
            if (progress.gameSessionId !== activeSession.id || progress.questionIndex !== activeSession.currentQuestionIndex || progress.revealRound !== activeSession.currentRevealRound) continue;
            const existing = nextAnswers.find((answer) => answer.id === progress.id);
            nextAnswers = upsertBySubmittedAt(nextAnswers, {
              ...progress,
              answerText: progress.forfeited ? FORFEIT_ANSWER_TEXT : existing?.answerText ?? "",
            });
          }
          return nextAnswers;
        });
        setBuzzerAnswers((currentAnswers) => {
          let nextAnswers = currentAnswers.filter((answer) => !canceledPlayerIds.has(answer.playerId));
          for (const progress of delta.buzzerAnswers) {
            if (progress.gameSessionId !== activeSession.id || progress.questionIndex !== activeSession.currentQuestionIndex || progress.revealRound !== activeSession.currentRevealRound) continue;
            const existing = nextAnswers.find((answer) => answer.id === progress.id);
            nextAnswers = upsertBySubmittedAt(nextAnswers, { ...progress, answerText: existing?.answerText ?? "" });
          }
          return nextAnswers;
        });
        if (delta.scores.length) {
          setScores((currentScores) => delta.scores.reduce((nextScores, score) => upsertById(nextScores, score), currentScores));
        }
        setQuestionResults((currentResults) => delta.questionResults.reduce(
          (nextResults, result) => upsertById(nextResults, result),
          currentResults.filter((result) => !delta.removedQuestionResultPlayerIds?.includes(result.playerId)),
        ));
        return;
      }

      const currentGameSession = gameSessionRef.current;
      if (delta.scope === "game" && delta.type === "answer_submitted" && currentGameSession?.id === delta.answer.gameSessionId) {
        if (
          delta.answer.questionIndex === currentGameSession.currentQuestionIndex &&
          delta.answer.revealRound === currentGameSession.currentRevealRound
        ) {
          setAnswers((currentAnswers) => upsertBySubmittedAt(currentAnswers, delta.answer));
          const submittedBuzzerAnswer = delta.buzzerAnswer;
          if (submittedBuzzerAnswer) {
            setBuzzerAnswers((currentAnswers) => upsertBySubmittedAt(currentAnswers, submittedBuzzerAnswer));
          }
          if (isPresenter && !isForfeitAnswer(delta.answer)) {
            setLabelAnswers((currentAnswers) => upsertBySubmittedAt(currentAnswers, delta.answer));
            showAnswerBubble(delta.answer);
          }
          if (isForfeitAnswer(delta.answer)) {
            setBuzzerAnswers((currentAnswers) =>
              currentAnswers.filter(
                (answer) =>
                  !(
                    answer.gameSessionId === delta.answer.gameSessionId &&
                    answer.questionIndex === delta.answer.questionIndex &&
                    answer.revealRound === delta.answer.revealRound &&
                    answer.playerId === delta.answer.playerId
                  ),
              ),
            );
          }
          if (delta.answer.playerId === playerId) {
            setMyAnswer(delta.answer);
            if (submittedBuzzerAnswer) {
              setMyBuzzerAnswer(submittedBuzzerAnswer);
            }
            if (isForfeitAnswer(delta.answer)) {
              setMyBuzzerAnswer(null);
            }
          }
        }
        return;
      }

      if (
        delta.scope === "game" &&
        delta.type === "buzzer_answer_submitted" &&
        currentGameSession?.id === delta.buzzerAnswer.gameSessionId
      ) {
        if (
          delta.buzzerAnswer.questionIndex === currentGameSession.currentQuestionIndex &&
          delta.buzzerAnswer.revealRound === currentGameSession.currentRevealRound
        ) {
          setBuzzerAnswers((currentAnswers) => upsertBySubmittedAt(currentAnswers, delta.buzzerAnswer));
          if (delta.buzzerAnswer.playerId === playerId) {
            setMyBuzzerAnswer(delta.buzzerAnswer);
          }
        }
        return;
      }

      if (
        delta.scope === "game" &&
        delta.type === "answer_text_backfill" &&
        currentGameSession?.id === delta.gameSessionId &&
        currentGameSession.currentQuestionIndex === delta.questionIndex
      ) {
        setBuzzerAnswers((currentAnswers) =>
          sortBySubmittedAt(delta.buzzerAnswers.reduce((nextAnswers, answer) => upsertById(nextAnswers, answer), currentAnswers)),
        );
        const updatedOwnAnswer = delta.buzzerAnswers.find((answer) => answer.playerId === playerId);
        if (updatedOwnAnswer) setMyBuzzerAnswer(updatedOwnAnswer);
        return;
      }

      if (delta.scope === "game" && delta.type === "buzzer_answer_judged" && delta.buzzerAnswer.gameSessionId === room.currentGameId && (!delta.gameSession || delta.gameSession.id === room.currentGameId)) {
        const didApplyGameSession = delta.gameSession ? applyGameSessionDelta(delta.gameSession) : true;
        if (!didApplyGameSession) {
          return;
        }
        if (delta.scores) {
          setScores((currentScores) => delta.scores!.reduce((nextScores, score) => upsertById(nextScores, score), currentScores));
        }
        const judgedQuestionResults = delta.questionResults;
        if (judgedQuestionResults) {
          setQuestionResults((currentResults) => judgedQuestionResults.reduce(
            (nextResults, questionResult) => upsertById(nextResults, questionResult),
            currentResults.filter((result) => !delta.removedQuestionResultPlayerIds?.includes(result.playerId)),
          ));
        }
        if (delta.buzzerAnswers) {
          setBuzzerAnswers(sortBySubmittedAt(delta.buzzerAnswers));
          const updatedOwnBuzzerAnswer = delta.buzzerAnswers.find((answer) => answer.playerId === playerId);
          if (updatedOwnBuzzerAnswer) {
            setMyBuzzerAnswer(updatedOwnBuzzerAnswer);
          }
          if (delta.gameSession && delta.gameSession.gameMode !== "ROUND_REVEAL" && !delta.gameSession.roundStartedAt) {
            setLabelAnswers(getCorrectLabelAnswersFromBuzzerAnswers(delta.buzzerAnswers));
          }
        } else {
          setBuzzerAnswers((currentAnswers) => upsertBySubmittedAt(currentAnswers, delta.buzzerAnswer));
          if (delta.buzzerAnswer.playerId === playerId) {
            setMyBuzzerAnswer(delta.buzzerAnswer);
          }
        }
      }

      if (delta.scope === "game" && delta.type === "answer_judgements_changed" && delta.answers[0]?.gameSessionId === room.currentGameId && (!delta.gameSession || delta.gameSession.id === room.currentGameId)) {
        const didApplyGameSession = delta.gameSession ? applyGameSessionDelta(delta.gameSession) : true;
        if (!didApplyGameSession) return;
        setScores((currentScores) => delta.scores.reduce((nextScores, score) => upsertById(nextScores, score), currentScores));
        setQuestionResults((currentResults) => delta.questionResults.reduce(
          (nextResults, result) => upsertById(nextResults, result),
          currentResults.filter((result) => !delta.removedQuestionResultPlayerIds?.includes(result.playerId)),
        ));
        setBuzzerAnswers((currentAnswers) =>
          sortBySubmittedAt(delta.answers.reduce((nextAnswers, answer) => upsertById(nextAnswers, answer), currentAnswers)),
        );
        if (delta.gameSession && delta.gameSession.gameMode !== "ROUND_REVEAL" && !delta.gameSession.roundStartedAt) {
          setLabelAnswers((currentAnswers) => applyCorrectBuzzerAnswerChanges(currentAnswers, delta.answers));
        }
        const ownAnswer = delta.answers.find((answer) => answer.playerId === playerId);
        if (ownAnswer) setMyBuzzerAnswer(ownAnswer);
      }
    },
    [applyRoundSnapshot, isPresenter, playerId, room.currentGameId, room.id, showAnswerBubble],
  );

  useEffect(() => {
    if (!room.id || !room.currentGameId) {
      return;
    }

    let hasOpenedRealtime = false;
    let queuedDeltas: RealtimeDelta[] = [];
    let flushFrame: number | null = null;

    function clearQueuedRealtimeDeltas() {
      queuedDeltas = [];
      if (flushFrame != null) {
        window.cancelAnimationFrame(flushFrame);
        flushFrame = null;
      }
    }

    function flushRealtimeDeltas() {
      const deltas = queuedDeltas;
      queuedDeltas = [];
      flushFrame = null;

      if (deltas.length === 0) {
        return;
      }

      unstable_batchedUpdates(() => {
        for (const delta of deltas) {
          applyRealtimeDelta(delta);
        }
      });
    }

    function enqueueRealtimeDeltas(deltas: RealtimeDelta[]) {
      if (deltas.length === 0) {
        return;
      }

      queuedDeltas.push(...deltas);
      if (flushFrame == null) {
        flushFrame = window.requestAnimationFrame(flushRealtimeDeltas);
      }
    }

    const unsubscribe = subscribeRealtimeTopic(
      `room:${room.id}`,
      (message) => {
        const messageVersion = getRealtimeVersion(message);
        if (message.name === "authorityCutover") {
          lastGameRealtimeVersionRef.current = null;
          missedGameRealtimeVersionRef.current = true;
          gameCatchUpTargetVersionRef.current = null;
          clearQueuedRealtimeDeltas();
          catchUpRoundSnapshot();
          return;
        }
        if (message.name === "authorityRecovered") {
          missedGameRealtimeVersionRef.current = true;
          if (messageVersion != null) {
            gameCatchUpTargetVersionRef.current = Math.max(gameCatchUpTargetVersionRef.current ?? 0, messageVersion);
          }
          clearQueuedRealtimeDeltas();
          catchUpRoundSnapshot();
          return;
        }
        if (messageVersion != null) {
          const lastVersion = lastGameRealtimeVersionRef.current;
          if (lastVersion != null && messageVersion <= lastVersion) {
            return;
          }

          if (missedGameRealtimeVersionRef.current) {
            gameCatchUpTargetVersionRef.current = Math.max(gameCatchUpTargetVersionRef.current ?? 0, messageVersion);
            clearQueuedRealtimeDeltas();
            catchUpRoundSnapshot();
            return;
          }

          if (lastVersion != null && messageVersion > lastVersion + 1) {
            missedGameRealtimeVersionRef.current = true;
            gameCatchUpTargetVersionRef.current = Math.max(gameCatchUpTargetVersionRef.current ?? 0, messageVersion);
            clearQueuedRealtimeDeltas();
            catchUpRoundSnapshot();
            return;
          }

          lastGameRealtimeVersionRef.current = messageVersion;
        }

        if (missedGameRealtimeVersionRef.current) {
          clearQueuedRealtimeDeltas();
          catchUpRoundSnapshot();
          return;
        }

        const deltas = getRealtimeDeltas(message);
        if (deltas.length > 0) {
          enqueueRealtimeDeltas(deltas);
        } else {
          const legacyResult = applyLegacyRealtimeMessage(message);
          if (legacyResult === "catch-up") {
            clearQueuedRealtimeDeltas();
            catchUpRoundSnapshot();
          }
        }
      },
      {
        playerId,
        onOpen: () => {
          if (!hasOpenedRealtime) {
            hasOpenedRealtime = true;
            return;
          }

          if (!isBootstrapLoadingRef.current) {
            missedGameRealtimeVersionRef.current = true;
            clearQueuedRealtimeDeltas();
            catchUpRoundSnapshot();
          }
        },
      },
    );

    return () => {
      unsubscribe();
      clearQueuedRealtimeDeltas();
    };
  }, [
    applyRealtimeDelta,
    applyLegacyRealtimeMessage,
    catchUpRoundSnapshot,
    room.currentGameId,
    room.id,
    playerId,
  ]);

  useEffect(() => {
    setAnswerBubbles({});
    setAnswerText("");
    setTeamGuessText("");
    setTeamSelectedBlocks([]);
    setIsRevealPreviewOpen(false);
    setIsSpectatorLabelOpen(false);
  }, [gameSession?.id, gameSession?.currentQuestionIndex, gameSession?.currentRevealRound]);

  useEffect(() => {
    const updateRoundClock = () => {
      const estimatedServerNowMs = getEstimatedServerNowMs();
      setRemainingSeconds(
        getRemainingSeconds(gameSession?.roundStartedAt, gameSession?.roundSeconds, estimatedServerNowMs),
      );
      const roundStartedAtMs = gameSession?.roundStartedAt ? new Date(gameSession.roundStartedAt).getTime() : Number.NaN;
      setHasRoundDeadlineGraceExpired(
        Number.isFinite(roundStartedAtMs) &&
          estimatedServerNowMs >= roundStartedAtMs + (gameSession?.roundSeconds ?? DEFAULT_ROUND_SECONDS) * 1000 + ROUND_DEADLINE_GRACE_MS,
      );
    };
    updateRoundClock();
    const timer = window.setInterval(updateRoundClock, 500);

    return () => window.clearInterval(timer);
  }, [gameSession?.roundSeconds, gameSession?.roundStartedAt]);

  const currentQuestion = gameSession ? questions[gameSession.currentQuestionIndex] : null;
  const isPresenterImageReady = presenterImageReadyQuestionId === currentQuestion?.id;
  const previousQuestionIndex = gameSession && gameSession.currentQuestionIndex > 0 ? gameSession.currentQuestionIndex - 1 : null;
  const previousQuestion = previousQuestionIndex == null ? null : questions[previousQuestionIndex] ?? null;
  const reviewedQuestion = reviewedQuestionIndex == null ? null : questions[reviewedQuestionIndex] ?? null;
  const currentQuestionLabel = currentQuestion?.labelText?.trim() ?? "";
  const revealedBlocksKey = (gameSession?.revealedBlocks ?? []).join(",");
  const revealGrid = getRevealGridConfig(isPortraitImage);
  const gridColumns = revealGrid.columns;
  const gridRows = revealGrid.rows;
  const visibleBlockCount = revealGrid.blockCount;
  const revealedBlockSet = useMemo(() => new Set(gameSession?.revealedBlocks ?? []), [gameSession?.revealedBlocks]);
  const teamDisabledBlockSet = useMemo(
    () => new Set((gameSession?.teamBattleState?.disabledBlocks ?? []).filter((block) => block >= 0 && block < visibleBlockCount)),
    [gameSession?.teamBattleState?.disabledBlocks, visibleBlockCount],
  );
  const visibleRevealedBlockCount = useMemo(
    () => countVisibleRevealedBlocks(revealedBlockSet, visibleBlockCount),
    [revealedBlockSet, visibleBlockCount],
  );
  const selectedBlockSet = useMemo(() => new Set(selectedBlocks), [selectedBlocks]);
  const teamDisabledBlockDraftSet = useMemo(() => new Set(teamDisabledBlockDraft), [teamDisabledBlockDraft]);
  const previewRevealedBlockSet = useMemo(
    () => new Set([...(gameSession?.revealedBlocks ?? []), ...selectedBlocks]),
    [gameSession?.revealedBlocks, selectedBlocks],
  );

  useEffect(() => {
    setImageLoadFailed(false);
    setPlayerImageRetryAttempt(0);
    setPlayerImageRetryToken(0);
    setTeamDisabledBlockDraft([]);
    playerLoadedImageRef.current = null;
  }, [currentQuestion?.id]);

  useLayoutEffect(() => {
    if (isPresenter || !currentQuestion) {
      return;
    }

    const canvas = playerImageCanvas;
    if (!canvas) {
      return;
    }

    let isCanceled = false;
    let retryTimer: number | undefined;
    const context = canvas.getContext("2d");
    const fallbackWidth = Math.max(1, canvas.width || 1);
    const fallbackHeight = Math.max(1, canvas.height || 1);
    canvas.width = fallbackWidth;
    canvas.height = fallbackHeight;
    if (context) {
      context.fillStyle = "#000";
    }
    context?.fillRect(0, 0, fallbackWidth, fallbackHeight);

    const cachedImage = playerLoadedImageRef.current;
    if (
      cachedImage &&
      cachedImage.questionId === currentQuestion.id &&
      cachedImage.imageUrl === currentQuestion.imageUrl &&
      cachedImage.image.complete
    ) {
      drawRevealedBlocksOnCanvas(canvas, cachedImage.image, gameSession?.revealedBlocks ?? []);
      return;
    }

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (isCanceled) {
        return;
      }

      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        setImageAspectRatio(image.naturalWidth / image.naturalHeight);
        setIsPortraitImage(image.naturalHeight > image.naturalWidth);
      }

      setImageLoadFailed(false);
      playerLoadedImageRef.current = { questionId: currentQuestion.id, imageUrl: currentQuestion.imageUrl, image };
      drawRevealedBlocksOnCanvas(canvas, image, gameSession?.revealedBlocks ?? []);
    };
    image.onerror = () => {
      if (isCanceled) {
        return;
      }

      if (playerImageRetryAttempt < MAX_IMAGE_AUTO_RETRY_COUNT) {
        const retryDelay = IMAGE_RETRY_DELAYS_MS[playerImageRetryAttempt] ?? IMAGE_RETRY_DELAYS_MS.at(-1) ?? 3200;
        retryTimer = window.setTimeout(() => {
          if (!isCanceled) {
            setPlayerImageRetryAttempt((attempt) => Math.min(MAX_IMAGE_AUTO_RETRY_COUNT, attempt + 1));
          }
        }, retryDelay);
        return;
      }

      setImageLoadFailed(true);
    };
    image.src = buildRetryImageUrl(currentQuestion.imageUrl, playerImageRetryAttempt, playerImageRetryToken);

    return () => {
      isCanceled = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
      image.onload = null;
      image.onerror = null;
    };
  }, [
    currentQuestion,
    gameSession?.revealedBlocks,
    isPresenter,
    playerImageCanvas,
    playerImageRetryAttempt,
    playerImageRetryToken,
    revealedBlocksKey,
  ]);

  const correctPlayerSet = useMemo(() => new Set(questionResults.map((result) => result.playerId)), [questionResults]);
  const maxRevealRounds = gameSession?.maxRevealRounds ?? 3;
  const currentRound = gameSession?.currentRevealRound ?? 1;
  const isTeamBattleMode = gameSession?.gameMode === "TEAM_BATTLE";
  const teamBattleState = gameSession?.teamBattleState ?? null;
  const isBuzzerMode = Boolean(gameSession && gameSession.gameMode !== "ROUND_REVEAL" && gameSession.gameMode !== "TEAM_BATTLE");
  const hasRoundStarted = Boolean(gameSession?.roundStartedAt);
  const isRoundActive = hasRoundStarted && remainingSeconds > 0;
  const isRoundEnded = hasRoundStarted && remainingSeconds === 0;
  const displayRound = currentRound;
  const displayScore =
    gameSession?.roundScores[displayRound - 1] ?? Math.max(1, maxRevealRounds - displayRound + 1);
  const isQuestionReviewing = isTeamBattleMode
    ? teamBattleState?.phase === "REVIEW"
    : !hasRoundStarted && visibleRevealedBlockCount === visibleBlockCount;
  const canSpectatorPreviewQuestion = !isSpectator || room.spectatorQuestionPreviewEnabled !== false || isQuestionReviewing;
  const canSpectatorViewPlayerAnswers = !isSpectator || room.spectatorPlayerAnswersEnabled !== false || isQuestionReviewing;
  const shouldShowQuestionLabel = Boolean(currentQuestion) && (isPresenter || isQuestionReviewing);
  const hasNextQuestion = gameSession ? gameSession.currentQuestionIndex + 1 < questions.length : false;
  const isCurrentPlayerCorrect = correctPlayerSet.has(playerId);

  useEffect(() => {
    if (reviewedQuestionIndex == null) {
      return;
    }

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => previousReviewCloseRef.current?.focus());

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setReviewedQuestionIndex(null);
      }

      if (event.key === "Tab") {
        event.preventDefault();
        previousReviewCloseRef.current?.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      previousReviewTriggerRef.current?.focus();
    };
  }, [reviewedQuestionIndex]);

  function handleOpenPreviousQuestionReview(event: React.MouseEvent<HTMLButtonElement>) {
    if (previousQuestionIndex == null || !previousQuestion) {
      return;
    }

    previousReviewTriggerRef.current = event.currentTarget;
    setReviewImageLoadFailed(false);
    setReviewedQuestionIndex(previousQuestionIndex);
  }

  useEffect(() => {
    setSelectedBlocks((currentBlocks) => {
      const nextBlocks = currentBlocks.filter((blockIndex) => blockIndex < visibleBlockCount && !revealedBlockSet.has(blockIndex));

      if (nextBlocks.length === currentBlocks.length && nextBlocks.every((blockIndex, index) => blockIndex === currentBlocks[index])) {
        return currentBlocks;
      }

      return nextBlocks;
    });
  }, [revealedBlockSet, visibleBlockCount]);

  useEffect(() => {
    if (!isTeamBattleMode) {
      return;
    }

    setTeamSelectedBlocks((currentBlocks) => {
      const nextBlocks =
        teamBattleState?.phase === "REVEAL_VOTE"
          ? currentBlocks.filter(
              (blockIndex) => blockIndex < visibleBlockCount && !revealedBlockSet.has(blockIndex) && !teamDisabledBlockSet.has(blockIndex),
            )
          : [];

      if (nextBlocks.length === currentBlocks.length && nextBlocks.every((blockIndex, index) => blockIndex === currentBlocks[index])) {
        return currentBlocks;
      }

      return nextBlocks;
    });
  }, [isTeamBattleMode, revealedBlockSet, teamBattleState?.phase, teamDisabledBlockSet, visibleBlockCount]);

  useEffect(() => {
    setTeamDisabledBlockDraft((currentBlocks) => {
      const nextBlocks = teamBattleState?.phase === "PRESENTER_BLOCK"
        ? currentBlocks.filter((blockIndex) => blockIndex >= 0 && blockIndex < visibleBlockCount)
        : [];
      return nextBlocks.length === currentBlocks.length && nextBlocks.every((blockIndex, index) => blockIndex === currentBlocks[index])
        ? currentBlocks
        : nextBlocks;
    });
  }, [teamBattleState?.phase, visibleBlockCount]);

  const gamePlayers = useMemo(() => room.players.filter((player) => player.role !== "SPECTATOR"), [room.players]);
  const activePlayerById = useMemo(() => new Map(gamePlayers.map((player) => [player.id, player])), [gamePlayers]);
  const fallbackGuesserIds = useMemo(
    () =>
      room.players
        .filter((player) => player.role !== "SPECTATOR" && player.id !== room.currentPresenterPlayerId)
        .map((player) => player.id),
    [room.currentPresenterPlayerId, room.players],
  );
  const scoringEligibleGuesserIds = gameSession?.eligiblePlayerIds ?? fallbackGuesserIds;
  const eligibleGuesserIds = useMemo(
    () => scoringEligibleGuesserIds.filter((guesserId) => activePlayerById.has(guesserId)),
    [activePlayerById, scoringEligibleGuesserIds],
  );
  const eligibleGuesserIdSet = useMemo(() => new Set(eligibleGuesserIds), [eligibleGuesserIds]);
  const isCurrentPlayerEligibleForQuestion =
    isPresenter || (!isSpectator && (isTeamBattleMode || eligibleGuesserIdSet.has(playerId)));
  const guessers = useMemo(() => room.players.filter((player) => eligibleGuesserIdSet.has(player.id)), [eligibleGuesserIdSet, room.players]);
  const teamBattlePlayerTeam: TeamBattleTeam | null = teamBattleState?.teams.red.includes(playerId)
    ? "red"
    : teamBattleState?.teams.blue.includes(playerId)
      ? "blue"
      : null;
  const teamBattleActiveTeam = teamBattleState?.activeTeam ?? "red";
  const teamBattleActiveMembers = useMemo(
    () => (teamBattleState?.teams[teamBattleActiveTeam] ?? []).filter((memberId) => activePlayerById.has(memberId)),
    [activePlayerById, teamBattleActiveTeam, teamBattleState?.teams],
  );
  const teamBattleActiveMemberSet = useMemo(() => new Set(teamBattleActiveMembers), [teamBattleActiveMembers]);
  const teamBattleViewerAccess = getTeamBattleViewerAccess({
    activeTeam: teamBattleActiveTeam,
    isPresenter,
    isSpectator,
    viewerTeam: teamBattlePlayerTeam,
  });
  const teamBattleCanAct = Boolean(teamBattleState && teamBattleViewerAccess.canAct);
  const canSeeTeamBattleVotes = Boolean(teamBattleState && teamBattleViewerAccess.canSeeVotes);
  const canSeeTeamBattleCountdown = Boolean(teamBattleState);
  const teamBattleAvailableBlockCount = useMemo(
    () => Array.from({ length: visibleBlockCount }, (_, block) => block)
      .filter((block) => !revealedBlockSet.has(block) && !teamDisabledBlockSet.has(block)).length,
    [revealedBlockSet, teamDisabledBlockSet, visibleBlockCount],
  );
  const teamBattleRequiredBlockCount = Math.min(teamBattleState?.revealLimit ?? 1, teamBattleAvailableBlockCount);
  const teamBattleVoteSeconds = teamBattleState?.voteDeadlineAt
    ? Math.max(0, Math.ceil((new Date(teamBattleState.voteDeadlineAt).getTime() - teamBattleClockMs) / 1000))
    : null;
  const teamBattleRevealVoteCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const blocks of Object.values(teamBattleState?.revealVotes ?? {})) {
      for (const block of blocks) {
        counts[block] = (counts[block] ?? 0) + 1;
      }
    }
    return counts;
  }, [teamBattleState?.revealVotes]);
  const teamBattleGuessOptions = useMemo(() => {
    const options = new Map<string, { key: string; label: string; vote: TeamBattleGuessVote; count: number; proposerName: string }>();
    const proposalByAnswer = new Map(
      (teamBattleState?.guessProposals ?? []).map((proposal) => [proposal.answerText, proposal]),
    );
    for (const [voterId, vote] of Object.entries(teamBattleState?.guessVotes ?? {})) {
      const answerText = vote.answerText?.trim() ?? "";
      const key = vote.type === "skip" ? "__skip__" : `guess:${answerText}`;
      const label = vote.type === "skip" ? "不猜" : answerText;
      const current = options.get(key);
      const proposal = vote.type === "guess" ? proposalByAnswer.get(answerText) : undefined;
      options.set(key, {
        key,
        label,
        vote,
        count: (current?.count ?? 0) + 1,
        proposerName:
          proposal?.proposerName ??
          current?.proposerName ??
          teamBattleState?.teamMemberNames?.[voterId] ??
          activePlayerById.get(voterId)?.nickname ??
          "队友",
      });
    }
    return Array.from(options.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [activePlayerById, teamBattleState?.guessProposals, teamBattleState?.guessVotes, teamBattleState?.teamMemberNames]);
  const activeGuesserIds = useMemo(
    () => eligibleGuesserIds.filter((guesserId) => !correctPlayerSet.has(guesserId)),
    [correctPlayerSet, eligibleGuesserIds],
  );
  const previousRoundCorrectPlayerSet = useMemo(
    () => new Set(questionResults.filter((result) => result.scoredRound < currentRound).map((result) => result.playerId)),
    [currentRound, questionResults],
  );
  const currentRoundParticipantIds = useMemo(
    () => eligibleGuesserIds.filter((guesserId) => !previousRoundCorrectPlayerSet.has(guesserId)),
    [eligibleGuesserIds, previousRoundCorrectPlayerSet],
  );
  const currentRoundAnswerPlayerSet = useMemo(() => new Set(answers.map((answer) => answer.playerId)), [answers]);
  const currentRoundAnswerByPlayerId = useMemo(
    () => new Map(answers.filter((answer) => !isForfeitAnswer(answer)).map((answer) => [answer.playerId, answer])),
    [answers],
  );
  const currentRoundForfeitPlayerSet = useMemo(
    () => new Set(answers.filter((answer) => isForfeitAnswer(answer)).map((answer) => answer.playerId)),
    [answers],
  );
  const correctAnswerByPlayerId = useMemo(
    () => new Map(labelAnswers.map((answer) => [answer.playerId, answer])),
    [labelAnswers],
  );
  const buzzerAnswerPlayerSet = useMemo(() => new Set(buzzerAnswers.map((answer) => answer.playerId)), [buzzerAnswers]);
  const buzzerAnswerByPlayerId = useMemo(
    () => new Map(buzzerAnswers.map((answer) => [answer.playerId, answer])),
    [buzzerAnswers],
  );
  const buzzerActionPlayerSet = useMemo(
    () => new Set([...Array.from(buzzerAnswerPlayerSet), ...Array.from(currentRoundForfeitPlayerSet)]),
    [buzzerAnswerPlayerSet, currentRoundForfeitPlayerSet],
  );
  const currentQuestionScoreByPlayerId = useMemo(() => {
    const scoreByPlayerId = new Map<string, number>();
    for (const result of questionResults) {
      scoreByPlayerId.set(result.playerId, (scoreByPlayerId.get(result.playerId) ?? 0) + result.scoreAwarded);
    }
    return scoreByPlayerId;
  }, [questionResults]);
  const pendingBuzzerAnswers = useMemo(
    () =>
      sortBySubmittedAt(
        buzzerAnswers.filter((answer) => answer.status === "pending" && eligibleGuesserIdSet.has(answer.playerId)),
      ),
    [buzzerAnswers, eligibleGuesserIdSet],
  );
  const judgedBuzzerAnswerPlayerSet = useMemo(
    () => new Set(buzzerAnswers.filter((answer) => answer.status !== "pending").map((answer) => answer.playerId)),
    [buzzerAnswers],
  );
  const unresolvedSubmittedAnswerCount = isBuzzerMode
    ? 0
    : answers.filter(
        (answer) =>
          !isForfeitAnswer(answer) &&
          eligibleGuesserIdSet.has(answer.playerId) &&
          !correctPlayerSet.has(answer.playerId) &&
          !judgedBuzzerAnswerPlayerSet.has(answer.playerId),
      ).length;
  const pendingJudgementCount = Math.max(pendingBuzzerAnswers.length, unresolvedSubmittedAnswerCount);
  const hasPendingJudgement = pendingJudgementCount > 0;
  const firstPendingBuzzerAnswer = pendingBuzzerAnswers[0] ?? null;
  const currentBuzzerAnswer =
    firstPendingBuzzerAnswer && isBuzzerAnswerReadyForJudging(firstPendingBuzzerAnswer, getEstimatedServerNowMs())
      ? firstPendingBuzzerAnswer
      : null;
  const isWaitingForBuzzerQueueStability = Boolean(firstPendingBuzzerAnswer && !currentBuzzerAnswer);
  const answerPanelRows = useMemo<AnswerPanelRow[]>(
    () =>
      currentRoundParticipantIds.flatMap((participantId) => {
        const player = activePlayerById.get(participantId);
        if (!player) return [];
        return [{
          player,
          answer: buzzerAnswerByPlayerId.get(participantId) ?? null,
          hasForfeited: currentRoundForfeitPlayerSet.has(participantId),
        }];
      }).sort((a, b) => {
        if (a.answer && b.answer) return comparePlayerAnswerOrder(a.answer, b.answer);
        if (a.answer) return -1;
        if (b.answer) return 1;
        if (a.hasForfeited !== b.hasForfeited) return a.hasForfeited ? -1 : 1;
        return currentRoundParticipantIds.indexOf(a.player.id) - currentRoundParticipantIds.indexOf(b.player.id);
      }),
    [activePlayerById, buzzerAnswerByPlayerId, currentRoundForfeitPlayerSet, currentRoundParticipantIds],
  );
  const answerPanelPendingCount = answerPanelRows.filter((row) => row.answer?.status === "pending").length;
  const answerPanelCorrectCount = answerPanelRows.filter((row) => row.answer?.status === "correct").length;
  const answerPanelWrongCount = answerPanelRows.filter((row) => row.answer?.status === "wrong").length;
  const answerPanelUnansweredCount = answerPanelRows.filter((row) => !row.answer && !row.hasForfeited).length;
  const areAllPendingPanelAnswersReady = answerPanelRows.every(
    (row) => !row.answer || row.answer.status !== "pending" || isBuzzerAnswerReadyForJudging(row.answer, getEstimatedServerNowMs()),
  );
  useEffect(() => {
    if (!firstPendingBuzzerAnswer || !isWaitingForBuzzerQueueStability) return;

    const delayMs = getBuzzerAnswerStabilityDelayMs(firstPendingBuzzerAnswer, getEstimatedServerNowMs());
    const timer = window.setTimeout(() => setBuzzerQueueClockTick((tick) => tick + 1), Math.ceil(delayMs) + 1);
    return () => window.clearTimeout(timer);
  }, [firstPendingBuzzerAnswer, isWaitingForBuzzerQueueStability]);

  useEffect(() => {
    if (!isAnswerPanelOpen) return;
    const nowMs = getEstimatedServerNowMs();
    const nextReadyAtMs = buzzerAnswers.reduce<number | null>((nextReadyAt, answer) => {
      const delayMs = getBuzzerAnswerStabilityDelayMs(answer, nowMs);
      if (delayMs <= 0) return nextReadyAt;
      const readyAt = nowMs + delayMs;
      return nextReadyAt == null ? readyAt : Math.min(nextReadyAt, readyAt);
    }, null);
    if (nextReadyAtMs == null) return;
    const timer = window.setTimeout(
      () => setBuzzerQueueClockTick((tick) => tick + 1),
      Math.ceil(Math.max(0, nextReadyAtMs - nowMs)) + 1,
    );
    return () => window.clearTimeout(timer);
  }, [buzzerAnswers, buzzerQueueClockTick, isAnswerPanelOpen]);
  const currentPlayerBuzzerStatus = myBuzzerAnswer?.status ?? null;
  const myHasForfeited = isForfeitAnswer(myAnswer);
  const allActiveGuessersUsedBuzzerChance =
    activeGuesserIds.length > 0 && activeGuesserIds.every((guesserId) => buzzerActionPlayerSet.has(guesserId));
  const allActiveGuessersSubmitted =
    activeGuesserIds.length > 0 && activeGuesserIds.every((guesserId) => currentRoundAnswerPlayerSet.has(guesserId));
  const allActiveGuessersUsedRoundChance = isBuzzerMode ? allActiveGuessersUsedBuzzerChance : allActiveGuessersSubmitted;
  const hasFirstCorrectAnswer = gameSession?.gameMode === "BUZZER_FIRST_CORRECT" && correctPlayerSet.size > 0;
  const isRoundClosedForPlayerActions = isRoundEnded || allActiveGuessersUsedRoundChance || hasFirstCorrectAnswer;
  const scoreByPlayerId = useMemo(() => new Map(scores.map((score) => [score.playerId, score])), [scores]);
  const scoreRows = useMemo(
    () =>
      gamePlayers
        .filter((player) => player.id !== room.currentPresenterPlayerId)
        .map((player) => {
          const playerScore = scoreByPlayerId.get(player.id);
          return {
            player,
            score: playerScore?.score ?? 0,
            correctCount: playerScore?.correctCount ?? 0,
          };
        })
        .sort((a, b) => b.score - a.score)
        .map((row, index, rows) => ({
          ...row,
          rank: getCompetitionRankByScore(rows, index),
        })),
    [gamePlayers, room.currentPresenterPlayerId, scoreByPlayerId],
  );
  const presenterName = useMemo(
    () => room.players.find((player) => player.id === room.currentPresenterPlayerId)?.nickname ?? "未选择",
    [room.currentPresenterPlayerId, room.players],
  );
  const teamBattleScoreRows = useMemo(
    () =>
      teamBattleState
        ? (["red", "blue"] as const)
            .map((team) => ({
              team,
              score: teamBattleState.teamScores[team],
              previousTurnAction:
                (teamBattleState.phase === "REVEAL_VOTE" || teamBattleState.phase === "GUESS_VOTE") &&
                teamBattleState.previousTurnAction?.team === team
                  ? teamBattleState.previousTurnAction
                  : null,
              members: teamBattleState.teams[team].flatMap((memberId) => {
                const player = activePlayerById.get(memberId);
                const hasActed =
                  team === teamBattleState.activeTeam &&
                  (teamBattleState.phase === "REVEAL_VOTE"
                    ? Object.prototype.hasOwnProperty.call(teamBattleState.revealVotes, memberId)
                    : teamBattleState.phase === "GUESS_VOTE"
                      ? Object.prototype.hasOwnProperty.call(teamBattleState.guessVotes, memberId)
                      : false);

                return player ? [{ id: memberId, nickname: player.nickname, hasActed }] : [];
              }),
            }))
            .sort((a, b) => b.score - a.score || (a.team === "red" ? -1 : 1))
            .map((row, index, rows) => ({
              ...row,
              rank: getCompetitionRankByScore(rows, index),
            }))
        : [],
    [activePlayerById, teamBattleState],
  );
  const teamBattleActiveTone = getTeamTone(teamBattleActiveTeam);
  const teamBattlePlayerTone = teamBattlePlayerTeam ? getTeamTone(teamBattlePlayerTeam) : null;
  const teamBattlePhaseLabel = teamBattleState ? getTeamBattlePhaseLabel(teamBattleState.phase) : "";
  const teamBattleRevealSubmittedCount = Object.keys(teamBattleState?.revealVotes ?? {}).filter((submittedPlayerId) =>
    teamBattleActiveMemberSet.has(submittedPlayerId),
  ).length;
  const teamBattleGuessSubmittedCount = Object.keys(teamBattleState?.guessVotes ?? {}).filter((submittedPlayerId) =>
    teamBattleActiveMemberSet.has(submittedPlayerId),
  ).length;
  const teamBattleSubmittedCount =
    teamBattleState?.phase === "REVEAL_VOTE"
      ? teamBattleRevealSubmittedCount
      : teamBattleState?.phase === "GUESS_VOTE"
        ? teamBattleGuessSubmittedCount
        : 0;
  const teamBattleVoteTotal = teamBattleActiveMembers.length;
  const teamBattleVoteProgress = teamBattleVoteTotal > 0 ? (teamBattleSubmittedCount / teamBattleVoteTotal) * 100 : 0;
  const teamBattleHasSubmittedRevealVote = Boolean(teamBattleState?.revealVotes[playerId]);
  const teamBattleHasSubmittedGuessVote = Boolean(teamBattleState?.guessVotes[playerId]);
  const teamBattleHasSubmittedCurrentVote =
    teamBattleState?.phase === "REVEAL_VOTE"
      ? teamBattleHasSubmittedRevealVote
      : teamBattleState?.phase === "GUESS_VOTE"
        ? teamBattleHasSubmittedGuessVote
        : false;
  const teamBattleIsVoteClosed = teamBattleVoteSeconds === 0;
  let teamBattleTaskTitle = "等待本题开始";
  let teamBattleTaskDetail = "观察图片与队伍状态";
  let teamBattleTaskMeta = "";
  let teamBattleTaskTone = "border-slate-200 bg-white";
  let teamBattleTaskBadge = "待机";

  if (teamBattleState) {
    if (isPresenter) {
      teamBattleTaskTone = "border-slate-200 bg-white";
      teamBattleTaskBadge = "裁判";
      if (teamBattleState.phase === "PRESENTER_BLOCK") {
        teamBattleTaskTone = "border-rose-300 bg-rose-50";
        teamBattleTaskBadge = "出题人";
        teamBattleTaskTitle = "禁用格子";
        teamBattleTaskDetail = "可不选";
      } else if (teamBattleState.phase === "JUDGING" && teamBattleState.pendingGuess) {
        teamBattleTaskTitle = "判定猜测";
        teamBattleTaskDetail = "点猜对或猜错";
      } else if (teamBattleState.phase === "TURN_RESULT") {
        teamBattleTaskBadge = "出题人";
        teamBattleTaskTitle = "确认回合结果";
        teamBattleTaskDetail = "进入下一轮";
      } else if (teamBattleState.phase === "REVIEW") {
        teamBattleTaskTitle = "复盘答案";
        teamBattleTaskDetail = hasNextQuestion ? "切到下一张" : "查看排行榜";
      } else {
        teamBattleTaskTitle = `等待${getTeamName(teamBattleActiveTeam)}`;
        teamBattleTaskDetail = `${teamBattlePhaseLabel}中`;
      }
    } else if (teamBattleState.phase === "PRESENTER_BLOCK") {
      teamBattleTaskTitle = "等待出题人禁用格子";
      teamBattleTaskDetail = "";
    } else if (!teamBattlePlayerTeam && !isSpectator) {
      teamBattleTaskTitle = "等待分队";
      teamBattleTaskDetail = "下一题开始参与";
    } else if (teamBattleCanAct && teamBattleState.phase === "REVEAL_VOTE") {
      teamBattleTaskTone = `${teamBattlePlayerTone?.border ?? "border-emerald-200"} bg-white`;
      teamBattleTaskBadge = teamBattleHasSubmittedRevealVote ? "可修改" : "轮到你";
      teamBattleTaskTitle = teamBattleHasSubmittedRevealVote ? "已提交选格" : "点图选格";
      teamBattleTaskDetail = "";
      teamBattleTaskMeta = `${teamSelectedBlocks.length}/${teamBattleRequiredBlockCount} 个`;
    } else if (teamBattleCanAct && teamBattleState.phase === "GUESS_VOTE") {
      teamBattleTaskTone = `${teamBattlePlayerTone?.border ?? "border-emerald-200"} bg-white`;
      teamBattleTaskBadge = teamBattleHasSubmittedGuessVote ? "可修改" : "轮到你";
      teamBattleTaskTitle = teamBattleHasSubmittedGuessVote ? "已提交猜测票" : "投票猜或不猜";
      teamBattleTaskDetail = "";
      teamBattleTaskMeta = teamBattleHasSubmittedGuessVote ? "可改投" : "二选一";
    } else if (teamBattleState.phase === "JUDGING") {
      teamBattleTaskTitle = "等待裁判";
      teamBattleTaskDetail = "正在判定";
    } else if (teamBattleState.phase === "TURN_RESULT" && teamBattleState.previousTurnAction) {
      teamBattleTaskBadge = "回合结果";
      teamBattleTaskTitle = teamBattleState.previousTurnAction.type === "skip"
        ? `${getTeamName(teamBattleState.previousTurnAction.team)}选择不猜`
        : `${getTeamName(teamBattleState.previousTurnAction.team)}猜测错误`;
      teamBattleTaskDetail = "";
    } else if (teamBattleState.phase === "REVIEW") {
      teamBattleTaskTitle = "查看答案";
      teamBattleTaskDetail = "等待下一题";
    } else {
      teamBattleTaskTitle = `等待${getTeamName(teamBattleActiveTeam)}`;
      teamBattleTaskDetail = `${teamBattlePhaseLabel}中`;
    }
  }

  if (isSpectator) {
    teamBattleTaskBadge = "观战";
  }

  const areAllGuessersCorrect = eligibleGuesserIds.length > 0 && eligibleGuesserIds.every((guesserId) => correctPlayerSet.has(guesserId));
  const isRoundCompleteForDisplay =
    hasRoundStarted &&
    (isRoundEnded || allActiveGuessersUsedRoundChance || hasFirstCorrectAnswer || areAllGuessersCorrect);
  const displayedRemainingSeconds = isRoundCompleteForDisplay ? 0 : remainingSeconds;
  const canConfirmReveal =
    isPresenter &&
    !isTeamBattleMode &&
    selectedBlocks.length > 0 &&
    !isConfirmingReveal &&
    !isQuestionReviewing &&
    !areAllGuessersCorrect &&
    Boolean(gameSession) &&
    !gameSession?.roundStartedAt &&
    currentRound <= maxRevealRounds;
  const canSubmitAnswer =
    !isPresenter &&
    !isSpectator &&
    !isBuzzerMode &&
    !isTeamBattleMode &&
    isCurrentPlayerEligibleForQuestion &&
    !isQuestionReviewing &&
    !isCurrentPlayerCorrect &&
    isRoundActive &&
    !isRoundClosedForPlayerActions &&
    answerText.trim().length > 0 &&
    (!myBuzzerAnswer || myBuzzerAnswer.status === "pending");
  const canForfeitAnswer =
    !isPresenter &&
    !isSpectator &&
    !isTeamBattleMode &&
    isCurrentPlayerEligibleForQuestion &&
    !isQuestionReviewing &&
    !isCurrentPlayerCorrect &&
    isRoundActive &&
    !isRoundClosedForPlayerActions &&
    !myHasForfeited &&
    (!myBuzzerAnswer || myBuzzerAnswer.status === "pending");
  const canCancelForfeit =
    !isPresenter &&
    !isSpectator &&
    !isTeamBattleMode &&
    isCurrentPlayerEligibleForQuestion &&
    !isQuestionReviewing &&
    !isCurrentPlayerCorrect &&
    isRoundActive &&
    !isRoundClosedForPlayerActions &&
    myHasForfeited;
  const canSubmitBuzzerAnswer =
    !isPresenter &&
    !isSpectator &&
    isBuzzerMode &&
    isCurrentPlayerEligibleForQuestion &&
    !isQuestionReviewing &&
    !isCurrentPlayerCorrect &&
    !myBuzzerAnswer &&
    !myHasForfeited &&
    isRoundActive &&
    !isRoundClosedForPlayerActions &&
    answerText.trim().length > 0;
  const canTypeAnswer =
    !isPresenter &&
    !isSpectator &&
    !isTeamBattleMode &&
    isCurrentPlayerEligibleForQuestion &&
    !isQuestionReviewing &&
    !isCurrentPlayerCorrect &&
    isRoundActive &&
    !isRoundClosedForPlayerActions &&
    !(isBuzzerMode && Boolean(myBuzzerAnswer)) &&
    !(isBuzzerMode && myHasForfeited) &&
    !(!isBuzzerMode && myBuzzerAnswer?.status === "wrong");
  const canTypeTeamBattleGuess =
    teamBattleCanAct && teamBattleState?.phase === "GUESS_VOTE" && !teamBattleIsVoteClosed;
  const canJudgeBuzzer =
    isPresenter &&
    !isTeamBattleMode &&
    !isQuestionReviewing &&
    Boolean(gameSession) &&
    Boolean(
      currentBuzzerAnswer &&
        isBuzzerAnswerReadyForJudging(currentBuzzerAnswer, getEstimatedServerNowMs()) &&
        canJudgePanelAnswer(currentBuzzerAnswer),
    );
  const canOpenAnswerPanel =
    isPresenter &&
    !isTeamBattleMode &&
    Boolean(gameSession) &&
    (hasRoundStarted || isQuestionReviewing || answerPanelRows.some((row) => row.answer || row.hasForfeited));
  const canMarkAllPendingWrong =
    Boolean(gameSession) &&
    answerPanelPendingCount > 0 &&
    areAllPendingPanelAnswersReady &&
    (hasRoundDeadlineGraceExpired || allActiveGuessersUsedRoundChance || hasFirstCorrectAnswer || isQuestionReviewing);
  const canSettleBuzzerRound =
    isPresenter &&
    !isTeamBattleMode &&
    !isQuestionReviewing &&
    !hasPendingJudgement &&
    hasRoundStarted &&
    (isRoundEnded || allActiveGuessersUsedRoundChance || hasFirstCorrectAnswer || areAllGuessersCorrect) &&
    Boolean(gameSession);
  const canAddQuestionLabel = isPresenter && isQuestionReviewing && Boolean(gameSession) && Boolean(currentQuestion) && !currentQuestionLabel;
  const canPreviewPresenterPlayerView = isPresenter && !isTeamBattleMode && Boolean(currentQuestion) && !imageLoadFailed;
  const canPreviewSelectedBlocks = canPreviewPresenterPlayerView && selectedBlocks.length > 0;
  const canPreviewTeamBattleOriginal =
    isPresenter &&
    isTeamBattleMode &&
    Boolean(teamBattleState) &&
    teamBattleState?.phase !== "PRESENTER_BLOCK" &&
    Boolean(currentQuestion) &&
    !isQuestionReviewing &&
    !imageLoadFailed;
  const canPreviewSpectatorOriginal = isSpectator && canSpectatorPreviewQuestion && Boolean(currentQuestion) && !imageLoadFailed;
  const canHoldRevealPreview = canPreviewPresenterPlayerView || canPreviewTeamBattleOriginal || canPreviewSpectatorOriginal;

  useEffect(() => {
    if (!canSpectatorPreviewQuestion) {
      setIsRevealPreviewOpen(false);
      setIsSpectatorLabelOpen(false);
    }
  }, [canSpectatorPreviewQuestion]);

  useEffect(() => {
    if (!canSpectatorViewPlayerAnswers) setIsAnswerViewEnabled(false);
  }, [canSpectatorViewPlayerAnswers]);

  const canPlayRoundPromptSound =
    !isPresenter &&
    !isSpectator &&
    !isTeamBattleMode &&
    isCurrentPlayerEligibleForQuestion &&
    !isQuestionReviewing &&
    !isCurrentPlayerCorrect;

  const closeAnswerPanel = useCallback(() => {
    answerPanelAutoCloseArmedRef.current = false;
    setIsAnswerPanelOpen(false);
    window.requestAnimationFrame(() => answerPanelTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!isAnswerPanelOpen || !answerPanelAutoCloseArmedRef.current) return;
    answerPanelAutoCloseArmedRef.current = false;
    const hasCompletedCurrentRoundJudgement =
      answerPanelPendingCount === 0 &&
      (answerPanelUnansweredCount === 0 || hasFirstCorrectAnswer || isQuestionReviewing);
    if (hasCompletedCurrentRoundJudgement) {
      closeAnswerPanel();
    }
  }, [answerPanelCompletionCheckTick, answerPanelPendingCount, answerPanelUnansweredCount, closeAnswerPanel, hasFirstCorrectAnswer, isAnswerPanelOpen, isQuestionReviewing]);

  function canJudgePanelAnswer(answer: BuzzerAnswer) {
    if (!gameSession || answer.questionIndex !== gameSession.currentQuestionIndex || answer.revealRound !== gameSession.currentRevealRound) {
      return false;
    }
    if (gameSession.gameMode !== "BUZZER_FIRST_CORRECT") return true;
    if (answer.status !== "pending") {
      if (answer.status === "correct") return true;
      const answerIndex = buzzerAnswers.findIndex((candidate) => candidate.id === answer.id);
      return (
        answerPanelCorrectCount === 0 &&
        answerIndex >= 0 &&
        buzzerAnswers.slice(0, answerIndex).every((candidate) => candidate.status === "wrong")
      );
    }
    return currentBuzzerAnswer?.id === answer.id && answerPanelCorrectCount === 0;
  }

  function canRevealPanelAnswer(answer: BuzzerAnswer) {
    return isBuzzerAnswerReadyForJudging(answer, getEstimatedServerNowMs());
  }

  function handleToggleRoundPromptSound() {
    const nextEnabled = !isRoundPromptSoundEnabled;
    setIsRoundPromptSoundEnabled(nextEnabled);
    saveRoundPromptSoundEnabled(nextEnabled);

    if (!nextEnabled) {
      setIsRoundPromptSoundVolumeOpen(false);
    }

    if (nextEnabled) {
      playRoundPromptSound(roundPromptSoundVolume);
    }
  }

  function handleRoundPromptSoundVolumeChange(volume: number) {
    const nextVolume = Math.max(0, Math.min(100, Math.round(volume)));
    setRoundPromptSoundVolume(nextVolume);
    saveRoundPromptSoundVolume(nextVolume);
  }

  function handleRoundPromptSoundVolumePreview() {
    if (isRoundPromptSoundEnabled) {
      playRoundPromptSound(roundPromptSoundVolume);
    }
  }

  useEffect(() => {
    if (!gameSession) {
      lastRoundPromptPositionRef.current = null;
      hasObservedRoundPromptPositionRef.current = false;
      return;
    }

    const roundPosition = [
      gameSession.id,
      gameSession.currentQuestionIndex,
      gameSession.currentRevealRound,
      gameSession.roundStartedAt ?? "waiting",
    ].join(":");
    const previousRoundPosition = lastRoundPromptPositionRef.current;
    const hasObservedRoundPosition = hasObservedRoundPromptPositionRef.current;

    lastRoundPromptPositionRef.current = roundPosition;
    hasObservedRoundPromptPositionRef.current = true;

    if (
      !hasObservedRoundPosition ||
      previousRoundPosition === roundPosition ||
      !gameSession.roundStartedAt ||
      !isRoundPromptSoundEnabled ||
      !canPlayRoundPromptSound
    ) {
      return;
    }

    playRoundPromptSound(roundPromptSoundVolume);
  }, [
    canPlayRoundPromptSound,
    gameSession,
    isRoundPromptSoundEnabled,
    roundPromptSoundVolume,
  ]);

  useEffect(() => {
    if (!isRoundPromptSoundVolumeOpen) {
      return;
    }

    function handleDocumentPointerDown(event: PointerEvent) {
      const controlsElement = roundPromptSoundControlsRef.current;
      if (controlsElement && event.target instanceof Node && controlsElement.contains(event.target)) {
        return;
      }

      setIsRoundPromptSoundVolumeOpen(false);
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, [isRoundPromptSoundVolumeOpen]);

  useEffect(() => {
    if (!canTypeAnswer || !gameSession?.roundStartedAt) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      answerInputRef.current?.focus();
      answerInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(focusTimer);
  }, [
    canTypeAnswer,
    gameSession?.currentQuestionIndex,
    gameSession?.currentRevealRound,
    gameSession?.roundStartedAt,
  ]);

  useEffect(() => {
    if (!canTypeTeamBattleGuess) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      teamGuessInputRef.current?.focus();
      teamGuessInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(focusTimer);
  }, [
    canTypeTeamBattleGuess,
    gameSession?.currentQuestionIndex,
    teamBattleState?.phase,
    teamBattleState?.activeTeam,
  ]);

  const standardModeLabel =
    gameSession?.gameMode === "BUZZER_FIRST_CORRECT"
      ? "抢答"
      : gameSession?.gameMode === "BUZZER_RANKED"
        ? "顺位"
        : "标准";
  const rankedNextScore = Math.max(1, scoringEligibleGuesserIds.length - questionResults.length);
  const scoreCardLabel =
    gameSession?.gameMode === "BUZZER_FIRST_CORRECT"
      ? "抢答规则"
      : gameSession?.gameMode === "BUZZER_RANKED"
        ? "答对得分"
        : "本轮分数";
  const scoreCardValue =
    gameSession?.gameMode === "BUZZER_FIRST_CORRECT"
      ? "首个答对 +1"
      : gameSession?.gameMode === "BUZZER_RANKED"
        ? `${rankedNextScore} 分`
        : `${displayScore} 分`;
  const standardActionProgress = getRoundActionProgress(
    currentRoundParticipantIds,
    isBuzzerMode ? buzzerActionPlayerSet : currentRoundAnswerPlayerSet,
  );
  const standardSubmittedCount = standardActionProgress.submittedCount;
  const standardTotalCount = standardActionProgress.totalCount;
  const standardProgress = standardActionProgress.progress;
  const isBuzzerSettleToReview =
    isBuzzerMode &&
    (currentRound >= maxRevealRounds ||
      (gameSession?.gameMode === "BUZZER_FIRST_CORRECT" && correctPlayerSet.size > 0) ||
      areAllGuessersCorrect);
  const buzzerSettleActionText = isBuzzerSettleToReview ? "公布答案" : "进入下一轮";
  const standardSettleActionText = isBuzzerMode
    ? buzzerSettleActionText
    : areAllGuessersCorrect || currentRound >= maxRevealRounds
      ? "公布答案"
      : "进入下一轮";
  let standardTaskBadge = isPresenter ? "出题人" : standardModeLabel;
  let standardTaskTitle = "等待开始";
  let standardTaskDetail = "等待出题人打开图片";
  let standardTaskTone = "border-slate-200 bg-white";
  let spectatorTaskTitle = isQuestionReviewing ? "本题复盘" : "玩家视角";
  let spectatorTaskDetail = isQuestionReviewing
    ? "等待切换下一题"
    : room.spectatorQuestionPreviewEnabled === false
      ? "房主已关闭提前看题"
      : "可随时查看完整原图";

  if (!isTeamBattleMode) {
    if (isQuestionReviewing) {
      spectatorTaskTitle = "本题复盘";
      spectatorTaskDetail = "等待切换下一题";
    } else if (!hasRoundStarted) {
      spectatorTaskTitle = "等待揭图";
      spectatorTaskDetail = "出题人正在选格";
    } else if (!isRoundClosedForPlayerActions) {
      spectatorTaskTitle = isBuzzerMode ? "抢答中" : "作答中";
      spectatorTaskDetail = `${standardSubmittedCount}/${standardTotalCount} ${isBuzzerMode ? "已抢答" : "已提交"}`;
    } else if (hasPendingJudgement) {
      spectatorTaskTitle = "判定中";
      spectatorTaskDetail = isWaitingForBuzzerQueueStability
        ? isBuzzerMode
          ? "正在确认抢答顺序"
          : "正在确认提交顺序"
        : `${pendingJudgementCount} 人待判定`;
    } else {
      spectatorTaskTitle = "本轮结束";
      spectatorTaskDetail = `等待出题人${standardSettleActionText}`;
    }
  }

  if (!isTeamBattleMode && !isQuestionReviewing) {
    if (isPresenter) {
      standardTaskBadge = "出题人";
      if (isBuzzerMode) {
        if (currentBuzzerAnswer) {
          standardTaskTitle = "判定抢答";
          standardTaskDetail = getPlayerName(currentBuzzerAnswer.playerId);
        } else if (!hasRoundStarted) {
          standardTaskTitle = "选择要打开的格子";
          standardTaskDetail = selectedBlocks.length > 0 ? `已选 ${selectedBlocks.length} 格` : "先在图片上选格";
        } else if (hasPendingJudgement) {
          standardTaskTitle = "等待判定";
          standardTaskDetail = isWaitingForBuzzerQueueStability ? "正在确认抢答顺序" : `${pendingJudgementCount} 人待判定`;
        } else if (canSettleBuzzerRound) {
          standardTaskTitle = buzzerSettleActionText;
          standardTaskDetail = `${standardSubmittedCount}/${standardTotalCount} 已抢答`;
        } else {
          standardTaskTitle = "等待抢答";
          standardTaskDetail = `${pendingBuzzerAnswers.length} 人排队`;
        }
      } else if (currentBuzzerAnswer) {
        standardTaskTitle = "判定答案";
        standardTaskDetail = getPlayerName(currentBuzzerAnswer.playerId);
      } else if (hasPendingJudgement) {
        standardTaskTitle = "等待判定";
        standardTaskDetail = isWaitingForBuzzerQueueStability ? "正在确认提交顺序" : `${pendingJudgementCount} 人待判定`;
      } else if (canSettleBuzzerRound) {
        standardTaskTitle = standardSettleActionText;
        standardTaskDetail = `${standardSubmittedCount}/${standardTotalCount} 已提交`;
      } else if (!hasRoundStarted) {
        standardTaskTitle = "选择要打开的格子";
        standardTaskDetail = selectedBlocks.length > 0 ? `已选 ${selectedBlocks.length} 格` : "先在图片上选格";
      } else {
        standardTaskTitle = "等待作答";
        standardTaskDetail = `${standardSubmittedCount}/${standardTotalCount} 已提交`;
      }
    } else if (!isCurrentPlayerEligibleForQuestion) {
      standardTaskTitle = "本题观战";
      standardTaskDetail = "下一题可以作答";
    } else if (isCurrentPlayerCorrect) {
      standardTaskBadge = "完成";
      standardTaskTone = "border-emerald-200 bg-emerald-50";
      standardTaskTitle = "已答对";
      standardTaskDetail = "等待下一题";
    } else if (!hasRoundStarted) {
      standardTaskTitle = "等待揭图";
      standardTaskDetail = "出题人正在选格";
    } else if (isBuzzerMode) {
      if (myHasForfeited) {
        standardTaskTone = "border-slate-200 bg-white";
        standardTaskTitle = "已放弃";
        standardTaskDetail = isRoundClosedForPlayerActions ? "等待判定" : "截止前可取消放弃";
      } else if (myBuzzerAnswer?.status === "pending") {
        standardTaskTitle = "等待判定";
        standardTaskDetail = `已抢答：${myBuzzerAnswer.answerText}`;
      } else if (myBuzzerAnswer?.status === "wrong") {
        standardTaskTitle = "本轮已答错";
        standardTaskDetail = "等待下一轮";
      } else if (isRoundEnded) {
        standardTaskTitle = "已自动放弃";
        standardTaskDetail = "等待判定";
      } else {
        standardTaskTone = "border-emerald-200 bg-white";
        standardTaskTitle = "提交抢答";
        standardTaskDetail = "输入答案后提交";
      }
    } else if (!isBuzzerMode && myBuzzerAnswer?.status === "pending") {
      standardTaskTitle = "等待判定";
      standardTaskDetail = `已提交：${myBuzzerAnswer.answerText}`;
    } else if (!isBuzzerMode && myBuzzerAnswer?.status === "wrong") {
      standardTaskTitle = "本轮已答错";
      standardTaskDetail = "等待下一轮";
    } else if (myHasForfeited) {
      standardTaskTone = "border-slate-200 bg-white";
      standardTaskTitle = "已放弃";
      standardTaskDetail = isRoundClosedForPlayerActions ? "等待判定" : "截止前可提交答案或取消放弃";
    } else if (isRoundEnded) {
      standardTaskTitle = "已自动放弃";
      standardTaskDetail = "等待判定";
    } else if (myAnswer) {
      standardTaskTone = "border-emerald-200 bg-white";
      standardTaskTitle = "已提交答案";
      standardTaskDetail = isRoundClosedForPlayerActions ? "等待判定" : "截止前可修改";
    } else {
      standardTaskTone = "border-emerald-200 bg-white";
      standardTaskTitle = "输入答案";
      standardTaskDetail = "提交后可修改";
    }
  }

  useEffect(() => {
    if (!canHoldRevealPreview) {
      setIsRevealPreviewOpen(false);
      return;
    }

    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsRevealPreviewOpen(false);
        return;
      }

      if (event.key.toLowerCase() !== "v" || event.repeat || isTypingTarget(event.target)) {
        return;
      }

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.closest("[data-reveal-grid-button='true']")) {
        activeElement.blur();
      }
      setIsRevealPreviewOpen(true);
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "v") {
        setIsRevealPreviewOpen(false);
      }
    }

    function handleBlur() {
      setIsRevealPreviewOpen(false);
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [canHoldRevealPreview]);

  useEffect(() => {
    setLabelInput("");
    setSelectedLabelAnswerId(null);
    setIsLabelModalOpen(false);
  }, [currentQuestion?.id, currentQuestionLabel]);

  useEffect(() => {
    setIsLabelPromptDisabledForGame(false);
    setLastAutoLabelKey("");
  }, [gameSession?.id]);

  useEffect(() => {
    if (!gameSession || !canAddQuestionLabel || isLabelModalOpen || isLabelPromptDisabledForGame) {
      return;
    }

    const autoLabelKey = `${gameSession.id}:${gameSession.currentQuestionIndex}`;

    if (lastAutoLabelKey !== autoLabelKey) {
      setIsLabelModalOpen(true);
      setLastAutoLabelKey(autoLabelKey);
    }
  }, [canAddQuestionLabel, gameSession, isLabelModalOpen, isLabelPromptDisabledForGame, lastAutoLabelKey]);

  useEffect(() => {
    if (!teamBattleState?.voteDeadlineAt) {
      return;
    }

    setTeamBattleClockMs(getEstimatedServerNowMs());
    const timer = window.setInterval(() => {
      setTeamBattleClockMs(getEstimatedServerNowMs());
    }, 250);

    return () => window.clearInterval(timer);
  }, [teamBattleState?.voteDeadlineAt]);

  useEffect(() => {
    const voteDeadlineAt = teamBattleState?.voteDeadlineAt;
    const phase = teamBattleState?.phase;
    if (
      !isPresenter ||
      !gameSession ||
      !voteDeadlineAt ||
      (phase !== "REVEAL_VOTE" && phase !== "GUESS_VOTE")
    ) {
      return;
    }

    const deadlineMs = new Date(voteDeadlineAt).getTime();
    if (!Number.isFinite(deadlineMs)) {
      return;
    }

    let canceled = false;
    const gameSessionId = gameSession.id;
    const questionIndex = gameSession.currentQuestionIndex;
    const turnNumber = teamBattleState.turnNumber;
    const delayMs = Math.max(
      0,
      deadlineMs + TEAM_BATTLE_SETTLEMENT_FALLBACK_DELAY_MS - getEstimatedServerNowMs(),
    );
    const timer = window.setTimeout(() => {
      const currentSession = gameSessionRef.current;
      const currentState = currentSession?.teamBattleState;
      if (
        canceled ||
        currentSession?.id !== gameSessionId ||
        currentSession.currentQuestionIndex !== questionIndex ||
        currentState?.phase !== phase ||
        currentState.turnNumber !== turnNumber ||
        currentState.voteDeadlineAt !== voteDeadlineAt
      ) {
        return;
      }

      void finalizeTeamBattleVote({
        gameSessionId,
        presenterPlayerId: playerId,
        expectedPhase: phase,
        expectedTurnNumber: turnNumber,
        expectedVoteDeadlineAt: voteDeadlineAt,
      })
        .then((finalized) => {
          if (!canceled) {
            applyRoundSnapshotFromResult(finalized) || applyGameSession(finalized.gameSession);
          }
        })
        .catch((error) => {
          console.warn("Team battle deadline fallback failed; waiting for the Room alarm.", error);
        });
    }, delayMs);

    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [
    gameSession?.currentQuestionIndex,
    gameSession?.id,
    isPresenter,
    playerId,
    teamBattleState?.phase,
    teamBattleState?.turnNumber,
    teamBattleState?.voteDeadlineAt,
  ]);

  async function saveQuestionLabel(params: { labelText: string; source: "manual" | "answer"; answerId?: string | null }) {
    if (!gameSession || !currentQuestion || !canAddQuestionLabel) {
      return;
    }

    setIsSavingLabel(true);
    try {
      const updatedQuestion = await updateQuestionLabel({
        gameSessionId: gameSession.id,
        presenterPlayerId: playerId,
        questionId: currentQuestion.id,
        labelText: params.labelText,
        source: params.source,
        answerId: params.answerId,
      });

      setQuestions((currentQuestions) =>
        currentQuestions.map((question) => (question.id === updatedQuestion.id ? updatedQuestion : question)),
      );
      setLabelInput("");
      setSelectedLabelAnswerId(null);
      setIsLabelModalOpen(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : "保存正确答案失败");
    } finally {
      setIsSavingLabel(false);
    }
  }

  function handleSaveQuestionLabel() {
    const selectedAnswer = selectedLabelAnswerId
      ? labelAnswers.find((answer) => answer.id === selectedLabelAnswerId)
      : null;
    const nextLabel = labelInput.trim();

    if (selectedAnswer) {
      void saveQuestionLabel({
        labelText: selectedAnswer.answerText,
        source: "answer",
        answerId: selectedAnswer.id,
      });
      return;
    }

    if (!nextLabel) {
      onError("请先选择或输入要展示的答案");
      return;
    }

    void saveQuestionLabel({ labelText: nextLabel, source: "manual" });
  }

  function handleSelectLabelAnswer(answerId: string) {
    setSelectedLabelAnswerId(answerId);
    setLabelInput("");
  }

  function handleLabelInputChange(value: string) {
    setLabelInput(value);
    setSelectedLabelAnswerId(null);
  }

  function handleDisableLabelPromptForGame() {
    setIsLabelPromptDisabledForGame(true);
    setIsLabelModalOpen(false);
  }

  function toggleBlock(blockIndex: number) {
    if (
      !isPresenter ||
      revealedBlockSet.has(blockIndex) ||
      blockIndex >= visibleBlockCount ||
      Boolean(gameSession?.roundStartedAt)
    ) {
      return;
    }

    setSelectedBlocks((currentBlocks) =>
      currentBlocks.includes(blockIndex)
        ? currentBlocks.filter((block) => block !== blockIndex)
        : [...currentBlocks, blockIndex].sort((a, b) => a - b),
    );
  }

  function toggleTeamBattleBlock(blockIndex: number) {
    if (
      !teamBattleCanAct ||
      teamBattleState?.phase !== "REVEAL_VOTE" ||
      revealedBlockSet.has(blockIndex) ||
      teamDisabledBlockSet.has(blockIndex) ||
      blockIndex >= visibleBlockCount ||
      teamBattleVoteSeconds === 0
    ) {
      return;
    }

    setTeamSelectedBlocks((currentBlocks) => {
      if (currentBlocks.includes(blockIndex)) {
        return currentBlocks.filter((block) => block !== blockIndex);
      }

      if (currentBlocks.length >= teamBattleRequiredBlockCount) {
        return currentBlocks;
      }

      const nextBlocks = [...currentBlocks, blockIndex].sort((a, b) => a - b);
      return nextBlocks;
    });
  }

  function toggleTeamBattleDisabledBlock(blockIndex: number) {
    if (
      !isPresenter ||
      teamBattleState?.phase !== "PRESENTER_BLOCK" ||
      !isPresenterImageReady ||
      blockIndex < 0 ||
      blockIndex >= visibleBlockCount
    ) {
      return;
    }

    setTeamDisabledBlockDraft((currentBlocks) =>
      currentBlocks.includes(blockIndex)
        ? currentBlocks.filter((block) => block !== blockIndex)
        : [...currentBlocks, blockIndex].sort((a, b) => a - b),
    );
  }

  async function handleConfirmReveal() {
    if (!gameSession || selectedBlocks.length === 0) {
      return;
    }

    setIsConfirmingReveal(true);
    try {
      const nextVisibleRevealedBlockCount = countVisibleRevealedBlocks(
        new Set([...gameSession.revealedBlocks, ...selectedBlocks]),
        visibleBlockCount,
      );
      const selectedBlocksForReveal =
        nextVisibleRevealedBlockCount >= visibleBlockCount
          ? Array.from(new Set([...selectedBlocks, ...getHiddenRevealBlocks(visibleBlockCount)])).sort((a, b) => a - b)
          : selectedBlocks;
      const updatedGameSession = await confirmRevealBlocks({
        gameSessionId: gameSession.id,
        presenterPlayerId: playerId,
        selectedBlocks: selectedBlocksForReveal,
        revealBlockCount: visibleBlockCount,
      });
      applyRoundSnapshotFromResult(updatedGameSession) || applyGameSessionDelta(updatedGameSession);
      setSelectedBlocks([]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "打开格子失败");
    } finally {
      setIsConfirmingReveal(false);
    }
  }

  async function handleSubmitTeamBattleRevealVote() {
    if (!gameSession || !teamBattleState) {
      return;
    }

    setIsSubmittingTeamBattle(true);
    try {
      const updatedGameSession = await submitTeamBattleRevealVote({
        gameSessionId: gameSession.id,
        playerId,
        selectedBlocks: teamSelectedBlocks,
        revealBlockCount: visibleBlockCount,
      });
      applyGameSession(updatedGameSession);
    } catch (error) {
      onError(error instanceof Error ? error.message : "提交选格失败");
    } finally {
      setIsSubmittingTeamBattle(false);
    }
  }

  async function handleCompleteTeamBattleBlockSelection() {
    if (!gameSession || teamBattleState?.phase !== "PRESENTER_BLOCK" || !isPresenter) {
      return;
    }

    setIsSubmittingTeamBattle(true);
    try {
      const completed = await completeTeamBattleBlockSelection({
        gameSessionId: gameSession.id,
        presenterPlayerId: playerId,
        disabledBlocks: teamDisabledBlockDraft,
        revealBlockCount: visibleBlockCount,
      });
      applyRoundSnapshotFromResult(completed) || applyGameSession(completed.gameSession);
      setTeamDisabledBlockDraft([]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "确认禁用失败");
    } finally {
      setIsSubmittingTeamBattle(false);
    }
  }

  async function handleSubmitTeamBattleGuessVote(vote: TeamBattleGuessVote) {
    if (!gameSession || !teamBattleState) {
      return;
    }

    setIsSubmittingTeamBattle(true);
    try {
      const updatedGameSession = await submitTeamBattleGuessVote({
        gameSessionId: gameSession.id,
        playerId,
        vote,
      });
      applyGameSession(updatedGameSession);
    } catch (error) {
      onError(error instanceof Error ? error.message : "提交猜测投票失败");
    } finally {
      setIsSubmittingTeamBattle(false);
    }
  }

  async function handleJudgeTeamBattleGuess(isCorrect: boolean) {
    if (!gameSession || !teamBattleState?.pendingGuess) {
      return;
    }

    setIsJudgingTeamBattle(true);
    try {
      const judged = await judgeTeamBattleGuess({
        gameSessionId: gameSession.id,
        presenterPlayerId: playerId,
        isCorrect,
      });
      applyRoundSnapshotFromResult(judged) || applyGameSession(judged.gameSession);
      setTeamSelectedBlocks([]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "判定团队猜测失败");
    } finally {
      setIsJudgingTeamBattle(false);
    }
  }

  async function handleAdvanceTeamBattleTurn() {
    if (!gameSession || teamBattleState?.phase !== "TURN_RESULT") {
      return;
    }

    setIsAdvancingTeamBattleTurn(true);
    try {
      const advanced = await advanceTeamBattleTurn({
        gameSessionId: gameSession.id,
        presenterPlayerId: playerId,
        expectedTurnNumber: teamBattleState.turnNumber,
      });
      applyRoundSnapshotFromResult(advanced) || applyGameSession(advanced.gameSession);
      setTeamSelectedBlocks([]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "进入团队下一轮失败");
    } finally {
      setIsAdvancingTeamBattleTurn(false);
    }
  }

  async function handleRevealTeamBattleAnswer() {
    if (!gameSession) {
      return;
    }

    const confirmed = window.confirm("确认直接公布答案吗？本题红蓝两队都不会加分");
    if (!confirmed) {
      return;
    }

    setIsSkippingQuestion(true);
    try {
      const revealed = await revealTeamBattleAnswer({
        gameSessionId: gameSession.id,
        presenterPlayerId: playerId,
      });
      applyRoundSnapshotFromResult(revealed) || applyGameSession(revealed.gameSession);
      setImageLoadFailed(false);
      setTeamSelectedBlocks([]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "公布答案失败");
    } finally {
      setIsSkippingQuestion(false);
    }
  }

  function handleReloadPlayerImage() {
    setImageLoadFailed(false);
    setPlayerImageRetryAttempt(0);
    playerLoadedImageRef.current = null;
    setPlayerImageRetryToken((token) => token + 1);
  }

  async function handleSubmitAnswer() {
    if (!gameSession) {
      return;
    }

    setIsSubmittingAnswer(true);
    try {
      const submitted = await submitAnswer({
        gameSessionId: gameSession.id,
        playerId,
        answerText,
      });
      if (applyRoundSnapshotFromResult(submitted)) {
        setAnswerText(submitted.answerText);
        return;
      }
      setMyAnswer(submitted);
      const submittedBuzzerAnswer = submitted.buzzerAnswer;
      if (submittedBuzzerAnswer) {
        setMyBuzzerAnswer(submittedBuzzerAnswer);
        setBuzzerAnswers((currentAnswers) => upsertBySubmittedAt(currentAnswers, submittedBuzzerAnswer));
      }
      setAnswerText(submitted.answerText);
      setAnswers((currentAnswers) => upsertBySubmittedAt(currentAnswers, submitted));
    } catch (error) {
      onError(error instanceof Error ? error.message : "提交答案失败");
    } finally {
      setIsSubmittingAnswer(false);
    }
  }

  async function handleSubmitForfeitAnswer() {
    if (!gameSession) {
      return;
    }

    setIsSubmittingAnswer(true);
    try {
      const submitted = await submitForfeitAnswer({
        gameSessionId: gameSession.id,
        playerId,
      });
      if (applyRoundSnapshotFromResult(submitted)) {
        setAnswerText("");
        return;
      }
      setMyAnswer(submitted);
      setMyBuzzerAnswer(null);
      setAnswerText("");
      setAnswers((currentAnswers) => upsertBySubmittedAt(currentAnswers, submitted));
      setBuzzerAnswers((currentAnswers) =>
        currentAnswers.filter(
          (answer) =>
            !(
              answer.gameSessionId === submitted.gameSessionId &&
              answer.questionIndex === submitted.questionIndex &&
              answer.revealRound === submitted.revealRound &&
              answer.playerId === submitted.playerId
            ),
        ),
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "放弃本轮失败");
    } finally {
      setIsSubmittingAnswer(false);
    }
  }

  async function handleCancelForfeitAnswer() {
    if (!gameSession) {
      return;
    }

    setIsSubmittingAnswer(true);
    try {
      const canceled = await cancelForfeitAnswer({
        gameSessionId: gameSession.id,
        playerId,
      });
      applyGameSession(canceled.gameSession);
      setMyAnswer(null);
      setAnswerText("");
      setAnswers((currentAnswers) => currentAnswers.filter((answer) => answer.id !== canceled.canceledAnswerId));
      setLabelAnswers((currentAnswers) => currentAnswers.filter((answer) => answer.id !== canceled.canceledAnswerId));
    } catch (error) {
      onError(error instanceof Error ? error.message : "取消放弃失败");
    } finally {
      setIsSubmittingAnswer(false);
    }
  }

  async function handleSubmitBuzzerAnswer() {
    if (!gameSession) {
      return;
    }

    setIsSubmittingAnswer(true);
    try {
      const submitted = await submitBuzzerAnswer({
        gameSessionId: gameSession.id,
        playerId,
        answerText,
        clientRoundElapsedMs: getClientRoundElapsedMs(gameSession),
      });
      setMyBuzzerAnswer(submitted);
      setAnswerText(submitted.answerText);
      setBuzzerAnswers((currentAnswers) => upsertBySubmittedAt(currentAnswers, submitted));
    } catch (error) {
      onError(error instanceof Error ? error.message : "提交抢答失败");
    } finally {
      setIsSubmittingAnswer(false);
    }
  }

  function handleAnswerInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) {
      return;
    }

    const canSubmitCurrentAnswer = isBuzzerMode ? canSubmitBuzzerAnswer : canSubmitAnswer;
    if (!canSubmitCurrentAnswer || isSubmittingAnswer) {
      return;
    }

    event.preventDefault();
    void (isBuzzerMode ? handleSubmitBuzzerAnswer() : handleSubmitAnswer());
  }

  function applyAnswerJudgementResult(result: Awaited<ReturnType<typeof setAnswerJudgements>>) {
    if (!applyGameSessionDelta(result.gameSession)) return;
    setScores(result.scores);
    setQuestionResults(result.questionResults);
    setBuzzerAnswers((currentAnswers) =>
      sortBySubmittedAt(result.judgedAnswers.reduce((nextAnswers, answer) => upsertById(nextAnswers, answer), currentAnswers)),
    );
    if (result.gameSession.gameMode !== "ROUND_REVEAL" && !result.gameSession.roundStartedAt) {
      setLabelAnswers((currentAnswers) => applyCorrectBuzzerAnswerChanges(currentAnswers, result.judgedAnswers));
    }
    const ownAnswer = result.judgedAnswers.find((answer) => answer.playerId === playerId);
    if (ownAnswer) setMyBuzzerAnswer(ownAnswer);
  }

  async function flushAnswerJudgementBatch(): Promise<void> {
    if (answerJudgementFlushPromiseRef.current) {
      await answerJudgementFlushPromiseRef.current;
      return;
    }
    const context = answerJudgementContextRef.current;
    const queued = [...answerJudgementQueueRef.current.entries()].slice(0, 12);
    if (!context || queued.length === 0) return;
    for (const [answerId] of queued) answerJudgementQueueRef.current.delete(answerId);

    const flushPromise = setAnswerJudgements({
      gameSessionId: context.gameSessionId,
      presenterPlayerId: playerId,
      expectedQuestionIndex: context.questionIndex,
      expectedRevealRound: context.revealRound,
      judgements: queued.map(([buzzerAnswerId, isCorrect]) => ({ buzzerAnswerId, isCorrect })),
    })
      .then(applyAnswerJudgementResult)
      .catch((error) => {
        for (const [answerId] of queued) {
          if (!answerJudgementQueueRef.current.has(answerId)) {
            answerPanelPendingJudgementIdsRef.current.delete(answerId);
          }
        }
        catchUpRoundSnapshot();
        throw error;
      })
      .finally(() => {
        answerJudgementFlushPromiseRef.current = null;
        if (answerJudgementQueueRef.current.size > 0 && answerJudgementFlushTimerRef.current === null) {
          answerJudgementFlushTimerRef.current = window.setTimeout(() => {
            answerJudgementFlushTimerRef.current = null;
            void drainAnswerJudgementQueue().catch((error) => {
              onError(error instanceof Error ? error.message : "判定答案失败");
            });
          }, ANSWER_JUDGEMENT_BATCH_WINDOW_MS);
        }
      });
    answerJudgementFlushPromiseRef.current = flushPromise;
    await flushPromise;
  }

  async function drainAnswerJudgementQueue() {
    if (answerJudgementFlushTimerRef.current !== null) {
      window.clearTimeout(answerJudgementFlushTimerRef.current);
      answerJudgementFlushTimerRef.current = null;
    }
    let didFlushJudgements = false;
    while (answerJudgementFlushPromiseRef.current || answerJudgementQueueRef.current.size > 0) {
      await flushAnswerJudgementBatch();
      didFlushJudgements = true;
    }
    const didCompletePendingJudgements = answerPanelPendingJudgementIdsRef.current.size > 0;
    answerPanelPendingJudgementIdsRef.current.clear();
    if (didFlushJudgements && didCompletePendingJudgements && isAnswerPanelOpen) {
      answerPanelAutoCloseArmedRef.current = true;
      setAnswerPanelCompletionCheckTick((tick) => tick + 1);
    }
  }

  function queueAnswerJudgement(answer: BuzzerAnswer, isCorrect: boolean) {
    if (answer.status === (isCorrect ? "correct" : "wrong") && !answerJudgementQueueRef.current.has(answer.id)) return;
    if (answer.status === "pending") {
      answerPanelPendingJudgementIdsRef.current.add(answer.id);
    }
    answerJudgementQueueRef.current.set(answer.id, isCorrect);
    setBuzzerAnswers((currentAnswers) =>
      currentAnswers.map((currentAnswer) =>
        currentAnswer.id === answer.id
          ? { ...currentAnswer, status: isCorrect ? "correct" : "wrong", scoreAwarded: isCorrect ? currentAnswer.scoreAwarded : 0 }
          : currentAnswer,
      ),
    );
    if (answerJudgementFlushTimerRef.current !== null) return;
    answerJudgementFlushTimerRef.current = window.setTimeout(() => {
      answerJudgementFlushTimerRef.current = null;
      void drainAnswerJudgementQueue().catch((error) => {
        onError(error instanceof Error ? error.message : "判定答案失败");
      });
    }, ANSWER_JUDGEMENT_BATCH_WINDOW_MS);
  }

  async function handleJudgeBuzzerAnswer(isCorrect: boolean) {
    if (!gameSession || !currentBuzzerAnswer) {
      return;
    }
    queueAnswerJudgement(currentBuzzerAnswer, isCorrect);
  }

  async function handleMarkPendingRoundAnswersWrong() {
    const context = answerJudgementContextRef.current;
    if (!context) return;
    setIsMarkingPendingWrong(true);
    try {
      await drainAnswerJudgementQueue();
      const result = await markPendingRoundAnswersWrong({
        gameSessionId: context.gameSessionId,
        presenterPlayerId: playerId,
        expectedQuestionIndex: context.questionIndex,
        expectedRevealRound: context.revealRound,
      });
      applyAnswerJudgementResult(result);
      if (isAnswerPanelOpen) {
        answerPanelAutoCloseArmedRef.current = true;
        setAnswerPanelCompletionCheckTick((tick) => tick + 1);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "批量判错失败");
    } finally {
      setIsMarkingPendingWrong(false);
    }
  }

  async function handleSettleBuzzerRound() {
    if (!gameSession) {
      return;
    }

    setIsSettlingBuzzerRound(true);
    try {
      await drainAnswerJudgementQueue();
      const settled = await settleBuzzerRound({
        gameSessionId: gameSession.id,
        presenterPlayerId: playerId,
      });
      applyRoundSnapshotFromResult(settled) || applyGameSession(settled.gameSession);
    } catch (error) {
      onError(error instanceof Error ? error.message : "结算本轮失败");
    } finally {
      setIsSettlingBuzzerRound(false);
    }
  }

  async function performSkipQuestion() {
    if (!gameSession) {
      return;
    }

    await drainAnswerJudgementQueue();
    const skipped = await skipCurrentQuestion({
      gameSessionId: gameSession.id,
      presenterPlayerId: playerId,
      expectedQuestionIndex: gameSession.currentQuestionIndex,
    });
    applyRoundSnapshotFromResult(skipped) || applyGameSession(skipped.gameSession);
    setImageLoadFailed(false);
    setSelectedBlocks([]);

    if (skipped.room) {
      onRoomUpdatedRef.current?.(skipped.room);
    }

  }

  async function maybeOpenResultPublishPrompt(nextAction: ResultPublishNextAction) {
    if (!gameSession) {
      return false;
    }

    const questionSet = await getQuestionSetById(gameSession.questionSetId);

    if (!questionSet || questionSet.isPublic || questionSet.createdByPlayerId !== playerId) {
      return false;
    }

    setResultPublishQuestionSet(questionSet);
    setResultPublishNextAction(nextAction);
    setResultPublishTitle("");
    setResultPublishDescription("");
    setResultPublishCreationMethod(questionSet.creationMethod ?? "player_manual");
    return true;
  }

  async function handleSkipQuestion() {
    if (!gameSession) {
      return;
    }

    const confirmed = window.confirm("确定跳过当前图片吗？");

    if (!confirmed) {
      return;
    }

    setIsSkippingQuestion(true);
    try {
      if (!hasNextQuestion) {
        const isWaitingForPublishDecision = await maybeOpenResultPublishPrompt("skipQuestion");

        if (isWaitingForPublishDecision) {
          return;
        }
      }

      await performSkipQuestion();
    } catch (error) {
      onError(error instanceof Error ? error.message : "跳过本题失败");
    } finally {
      setIsSkippingQuestion(false);
    }
  }

  async function finishReviewedQuestion() {
    if (!gameSession || !isPresenter || !isQuestionReviewing) {
      return;
    }

    await drainAnswerJudgementQueue();
    const advanced = await advanceReviewedQuestion({
      gameSessionId: gameSession.id,
      presenterPlayerId: playerId,
      expectedQuestionIndex: gameSession.currentQuestionIndex,
    });
    applyRoundSnapshotFromResult(advanced) || applyGameSession(advanced.gameSession);
    setImageLoadFailed(false);
    setSelectedBlocks([]);

    if (advanced.room) {
      onRoomUpdatedRef.current?.(advanced.room);
    }

  }

  async function handleAdvanceReviewedQuestion() {
    if (!gameSession || !isPresenter || !isQuestionReviewing) {
      return;
    }

    setIsAdvancingQuestion(true);
    try {
      if (!hasNextQuestion) {
        const isWaitingForPublishDecision = await maybeOpenResultPublishPrompt("advanceReviewedQuestion");

        if (isWaitingForPublishDecision) {
          return;
        }
      }

      await finishReviewedQuestion();
    } catch (error) {
      onError(error instanceof Error ? error.message : "切换图片失败");
    } finally {
      setIsAdvancingQuestion(false);
    }
  }

  async function continueAfterResultPublishPrompt(nextAction: ResultPublishNextAction) {
    if (nextAction === "skipQuestion") {
      setIsSkippingQuestion(true);
      try {
        await performSkipQuestion();
      } finally {
        setIsSkippingQuestion(false);
      }
      return;
    }

    setIsAdvancingQuestion(true);
    try {
      await finishReviewedQuestion();
    } finally {
      setIsAdvancingQuestion(false);
    }
  }

  function closeResultPublishPrompt() {
    setResultPublishQuestionSet(null);
    setResultPublishNextAction(null);
  }

  async function handleSkipResultPublish() {
    if (!resultPublishNextAction) {
      closeResultPublishPrompt();
      return;
    }

    const nextAction = resultPublishNextAction;
    closeResultPublishPrompt();
    try {
      await continueAfterResultPublishPrompt(nextAction);
    } catch (error) {
      onError(error instanceof Error ? error.message : "进入排行榜失败");
    }
  }

  async function handleConfirmResultPublish() {
    if (!resultPublishQuestionSet || !resultPublishNextAction || !gameSession) {
      return;
    }

    if (!resultPublishTitle.trim()) {
      onError("请先填写题库标题");
      return;
    }

    const questionSet = resultPublishQuestionSet;
    const nextAction = resultPublishNextAction;
    setIsPublishingBeforeResult(true);
    try {
      await publishQuestionSetToCommunity({
        questionSetId: questionSet.id,
        playerId,
        title: resultPublishTitle.trim(),
        description: resultPublishDescription.trim(),
        creationMethod: resultPublishCreationMethod,
        roomId: room.id,
      });
      closeResultPublishPrompt();
      await continueAfterResultPublishPrompt(nextAction);
    } catch (error) {
      onError(error instanceof Error ? error.message : "发布到社区失败");
    } finally {
      setIsPublishingBeforeResult(false);
    }
  }

  const fallbackFooterActions = footerActions ? (
    <div className="flex flex-wrap items-center justify-end gap-3">{footerActions}</div>
  ) : null;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-[var(--muted)]">正在加载当前题目…</p>
        {fallbackFooterActions}
      </div>
    );
  }

  if (!gameSession || !currentQuestion) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-red-700">没有找到当前游戏题目</p>
        {fallbackFooterActions}
      </div>
    );
  }

  const currentPlayerName = room.players.find((player) => player.id === playerId)?.nickname ?? "未设置昵称";
  const playingGridClass = "grid gap-4 lg:grid-cols-6";
  const gameModeCardValue = GAME_MODE_LABELS[gameSession.gameMode];
  const revealedBlocksCardValue = `${visibleRevealedBlockCount} / ${visibleBlockCount} 格`;
  const correctPlayersCardValue = `${correctPlayerSet.size} / ${scoringEligibleGuesserIds.length} 人`;
  const teamBattleScoreCardValue = teamBattleState
    ? `红队 ${teamBattleState.teamScores.red} : ${teamBattleState.teamScores.blue} 蓝队`
    : "";
  const teamBattleActionCardValue = teamBattleState
    ? teamBattleState.phase === "PRESENTER_BLOCK"
      ? "禁用格子"
      : teamBattleState.phase === "JUDGING"
      ? "裁判判定"
      : teamBattleState.phase === "TURN_RESULT"
        ? "回合结算"
      : teamBattleState.phase === "REVIEW"
        ? "复盘"
        : `${getTeamName(teamBattleActiveTeam)} · ${teamBattlePhaseLabel}`
    : "";
  const sidePanelHeightStyle = {
    "--image-display-height": imageDisplayHeight ? `${imageDisplayHeight}px` : "78vh",
  } as CSSProperties;
  const canViewPlayerAnswers =
    !isTeamBattleMode && ((isSpectator && canSpectatorViewPlayerAnswers) || (!isPresenter && isCurrentPlayerCorrect));
  const showPlayerAnswersInScoreboard =
    canViewPlayerAnswers && isAnswerViewEnabled && !isScoreboardCompact;

  const scorePanel = (
    <div
      className="flex flex-col rounded-md border border-[var(--line)] bg-white p-3 lg:sticky lg:top-4 lg:h-[var(--image-display-height)] lg:max-h-[var(--image-display-height)]"
      style={sidePanelHeightStyle}
    >
      <div className="mb-3 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <p className="text-sm font-semibold text-slate-900">积分榜</p>
        <span className="min-w-0 max-w-full justify-self-end truncate rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600" title={`出题人：${presenterName}`}>
          出题人：{presenterName}
        </span>
        {!isTeamBattleMode ? (
          <button
            aria-label={isScoreboardCompact ? "切换为详细积分榜" : "切换为紧凑积分榜"}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-[var(--line)] bg-white text-slate-600 transition hover:bg-slate-50 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-200"
            title={isScoreboardCompact ? "详细积分榜" : "紧凑积分榜"}
            type="button"
            onClick={() => setIsScoreboardCompact((isCompact) => !isCompact)}
          >
            {isScoreboardCompact ? <IconListDetail className="h-4 w-4" /> : <IconListDense className="h-4 w-4" />}
          </button>
        ) : null}
      </div>
      {isTeamBattleMode && teamBattleState ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-[var(--line)] bg-slate-50 px-3 py-2 text-sm">
            <span className="font-semibold text-slate-950">我的身份</span>
            <span
              className={[
                "shrink-0 rounded px-3 py-1 text-sm font-bold",
                isPresenter
                  ? "bg-slate-900 text-white"
                  : teamBattlePlayerTone?.solid ?? "bg-slate-200 text-slate-700",
              ].join(" ")}
            >
              {isPresenter ? "裁判" : teamBattlePlayerTeam ? getTeamName(teamBattlePlayerTeam) : isSpectator ? "观战" : "待分队"}
            </span>
          </div>
          <p className="mb-2 text-xs font-semibold text-[var(--muted)]">队伍</p>
          <div className="grid gap-2 lg:min-h-0 lg:flex-1 lg:grid-rows-2">
            {teamBattleScoreRows.map((row) => {
              const isActiveTeam =
                (teamBattleState.phase === "REVEAL_VOTE" ||
                  teamBattleState.phase === "GUESS_VOTE" ||
                  teamBattleState.phase === "JUDGING") &&
                teamBattleState.activeTeam === row.team;
              const tone = getTeamTone(row.team);

              return (
                <div
                  className={[
                    "flex min-h-0 flex-col overflow-hidden rounded-md border px-3 py-3 text-sm",
                    tone.panel,
                    isActiveTeam ? `ring-2 ${tone.ring}` : "",
                  ].join(" ")}
                  key={row.team}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className={["min-w-0 font-bold", tone.text].join(" ")}>
                      {getTeamName(row.team)}
                      {isActiveTeam ? " · 行动中" : ""}
                    </p>
                    <span className="text-xl font-bold text-[var(--primary)]">{row.score}</span>
                  </div>
                  {row.previousTurnAction ? (
                    <p className="mt-2 shrink-0 break-words text-xs font-semibold leading-5 text-slate-700">
                      {row.previousTurnAction.type === "skip" ? (
                        "上轮：选择不猜"
                      ) : (
                        <>
                          上轮：猜「<span className="font-bold text-slate-950">{row.previousTurnAction.answerText}</span>」 · 猜错
                        </>
                      )}
                    </p>
                  ) : null}
                  <div className="my-3 h-px shrink-0 bg-slate-900/10" />
                  <div className="grid min-h-0 gap-2 lg:flex-1 lg:auto-rows-max lg:overflow-y-auto lg:pr-1">
                    {row.members.map((member) => (
                      <div
                        className={[
                          "rounded-md bg-white/80 px-3 py-2",
                          member.id === playerId ? "ring-2 ring-slate-900/10" : "",
                        ].join(" ")}
                        key={member.id}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-semibold text-slate-950">{member.nickname}</span>
                          {member.hasActed ? (
                            <span
                              aria-label={`${member.nickname}已行动`}
                              className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700"
                              title="已行动"
                            >
                              <IconCheck className="h-3.5 w-3.5" />
                            </span>
                          ) : null}
                        </div>
                        {member.id === playerId ? <span className="text-xs font-semibold text-[var(--muted)]">你</span> : null}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="min-h-0 overflow-y-auto pr-1">
          <div className={isScoreboardCompact ? "grid gap-1" : "grid gap-2 sm:grid-cols-2 lg:grid-cols-1"}>
            {scoreRows.map(({ player, rank, score, correctCount }) => {
              const alreadyCorrect = correctPlayerSet.has(player.id);
              const hasAnsweredCurrentRound = currentRoundAnswerPlayerSet.has(player.id);
              const hasForfeitedCurrentRound = currentRoundForfeitPlayerSet.has(player.id);
              const buzzerAnswer = buzzerAnswerByPlayerId.get(player.id);
              const currentQuestionScoreAwarded = currentQuestionScoreByPlayerId.get(player.id) ?? 0;
              const isLeadingPendingBuzzerAnswer = pendingBuzzerAnswers[0]?.id === buzzerAnswer?.id;
              const playerAnswer = showPlayerAnswersInScoreboard
                ? getScoreboardAnswerDisplay({
                    nickname: player.nickname,
                    alreadyCorrect,
                    currentAnswer: currentRoundAnswerByPlayerId.get(player.id),
                    correctAnswer: correctAnswerByPlayerId.get(player.id),
                    buzzerAnswer,
                    hasForfeitedCurrentRound,
                    isBuzzerMode,
                    isLeadingPendingBuzzerAnswer,
                  })
                : null;
              const ScoreRow = isScoreboardCompact ? CompactScoreRow : StandardScoreRow;

              return (
                <ScoreRow
                  alreadyCorrect={alreadyCorrect}
                  buzzerStatus={buzzerAnswer?.status}
                  correctCount={correctCount}
                  currentQuestionScoreAwarded={currentQuestionScoreAwarded}
                  hasAnsweredCurrentRound={hasAnsweredCurrentRound}
                  hasForfeitedCurrentRound={hasForfeitedCurrentRound}
                  isBuzzerMode={isBuzzerMode}
                  isLeadingPendingBuzzerAnswer={isLeadingPendingBuzzerAnswer}
                  key={player.id}
                  nickname={player.nickname}
                  onRowRef={registerScoreRow}
                  playerId={player.id}
                  rank={rank}
                  score={score}
                  showPlayerAnswer={showPlayerAnswersInScoreboard}
                  playerAnswerLabel={playerAnswer?.label ?? ""}
                  playerAnswerStatus={playerAnswer?.status ?? "unanswered"}
                  playerAnswerText={playerAnswer?.text ?? ""}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  const imagePanel = (
    <div className="bg-white">
      <div
        className="relative mx-auto max-h-[78vh] w-full max-w-[1280px] overflow-hidden rounded-md bg-black"
        ref={setImageDisplayRef}
        style={{
          aspectRatio: imageAspectRatio,
          maxWidth: isPortraitImage ? `min(1280px, calc(78vh * ${imageAspectRatio}))` : "1280px",
        }}
      >
        {currentQuestion?.isR18 ? (
          <span className="absolute left-3 top-3 z-20 rounded bg-rose-600 px-2 py-1 text-xs font-black tracking-widest text-white shadow-lg">R18</span>
        ) : null}
        {isPresenter ? (
          <img
            alt=""
            className="h-full w-full object-cover"
            key={currentQuestion.id}
            src={currentQuestion.imageUrl}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                setImageAspectRatio(image.naturalWidth / image.naturalHeight);
                setIsPortraitImage(image.naturalHeight > image.naturalWidth);
                setPresenterImageReadyQuestionId(currentQuestion.id);
              }
            }}
            onError={() => {
              setPresenterImageReadyQuestionId((readyQuestionId) =>
                readyQuestionId === currentQuestion.id ? null : readyQuestionId,
              );
              setImageLoadFailed(true);
            }}
          />
        ) : (
          <canvas
            aria-label="已打开的图片区域"
            className="block h-full w-full bg-black"
            key={currentQuestion.id}
            ref={setPlayerImageCanvasRef}
          />
        )}

        {imageLoadFailed ? (
          <div className="absolute inset-0 z-10 grid place-items-center bg-slate-950 px-4 text-center text-white">
            <div>
              <p className="text-lg font-semibold">图片加载失败</p>
              <p className="mt-2 text-sm text-slate-300">
                {isPresenter ? "图片加载失败，可能是链接失效或网络问题" : "已自动重试 3 次，可能是链接失效或网络问题"}
              </p>
              {isPresenter ? (
                <Button className="mt-4" type="button" variant="secondary" onClick={handleSkipQuestion} disabled={isSkippingQuestion}>
                  {isSkippingQuestion ? "跳过中…" : "跳过本题"}
                </Button>
              ) : (
                <Button className="mt-4" type="button" variant="secondary" onClick={handleReloadPlayerImage}>
                  重新加载图片
                </Button>
              )}
            </div>
          </div>
        ) : null}

        {isTeamBattleMode && !imageLoadFailed ? (
          <div
            className="absolute inset-0 grid"
            style={{
              gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: visibleBlockCount }, (_, blockIndex) => {
              const isRevealed = revealedBlockSet.has(blockIndex);
              const isDisabled = teamDisabledBlockSet.has(blockIndex);
              const isPresenterBlockStage = teamBattleState?.phase === "PRESENTER_BLOCK";
              const isBlockDraftSelected = isPresenterBlockStage && isPresenter && teamDisabledBlockDraftSet.has(blockIndex);
              const showDisabledFrame = teamBattleState?.phase === "REVEAL_VOTE" && isDisabled && !isRevealed;
              const isSelected =
                teamBattleState?.phase === "REVEAL_VOTE" && !isRevealed && !isDisabled && teamSelectedBlocks.includes(blockIndex);
              const voteCount = canSeeTeamBattleVotes && !isDisabled ? teamBattleRevealVoteCounts[blockIndex] ?? 0 : 0;
              const canPickBlock =
                teamBattleCanAct &&
                teamBattleState?.phase === "REVEAL_VOTE" &&
                !isRevealed &&
                !isDisabled &&
                teamBattleVoteSeconds !== 0;
              const canSelectMoreBlocks = teamSelectedBlocks.length < teamBattleRequiredBlockCount;
              const canPreviewBlock = canPickBlock && !isSelected && canSelectMoreBlocks;
              const canToggleRevealBlock = canPickBlock && (isSelected || canSelectMoreBlocks);
              const canToggleDisabledBlock = isPresenterBlockStage && isPresenter && isPresenterImageReady;

              return (
                <button
                  aria-label={`方块 ${blockIndex + 1}${showDisabledFrame ? "，已禁用" : ""}`}
                  className={[
                    "relative border border-white/45 text-xs font-bold transition disabled:cursor-default",
                    isRevealed || (isPresenterBlockStage && isPresenter) ? "bg-transparent" : "bg-black",
                    isBlockDraftSelected
                      ? "ring-2 ring-inset ring-rose-500 shadow-[inset_0_0_0_9999px_rgba(225,29,72,0.26)]"
                      : "",
                    showDisabledFrame
                      ? "z-[1] ring-2 ring-inset ring-rose-500 shadow-[inset_0_0_0_9999px_rgba(225,29,72,0.26)]"
                      : "",
                    isSelected ? "ring-2 ring-inset ring-emerald-300 shadow-[inset_0_0_0_9999px_rgba(5,150,105,0.42)]" : "",
                    canToggleDisabledBlock && !isBlockDraftSelected
                      ? "hover:ring-2 hover:ring-inset hover:ring-rose-300 hover:shadow-[inset_0_0_0_9999px_rgba(244,63,94,0.12)]"
                      : "",
                    canPreviewBlock
                      ? "hover:ring-2 hover:ring-inset hover:ring-emerald-200 hover:shadow-[inset_0_0_0_9999px_rgba(16,185,129,0.24)]"
                      : "",
                  ].join(" ")}
                  disabled={!canToggleRevealBlock && !canToggleDisabledBlock}
                  key={blockIndex}
                  type="button"
                  onClick={() => {
                    if (canToggleDisabledBlock) toggleTeamBattleDisabledBlock(blockIndex);
                    else toggleTeamBattleBlock(blockIndex);
                  }}
                >
                  {!isRevealed && voteCount > 0 ? (
                    <span className="absolute left-1 top-1 grid h-5 min-w-5 place-items-center rounded bg-emerald-400 px-1 text-[11px] text-slate-950">
                      {voteCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {!isPresenter && !isTeamBattleMode && !imageLoadFailed ? (
          <div
            className="absolute inset-0 grid"
            style={{
              gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: visibleBlockCount }, (_, blockIndex) => (
              <div className={revealedBlockSet.has(blockIndex) ? "bg-transparent" : "bg-black"} key={blockIndex} />
            ))}
          </div>
        ) : null}

        {isPresenter && !isTeamBattleMode && !imageLoadFailed ? (
          <div
            className="absolute inset-0 grid"
            style={{
              gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: visibleBlockCount }, (_, blockIndex) => {
              const isRevealed = revealedBlockSet.has(blockIndex);
              const isSelected = selectedBlockSet.has(blockIndex);

              return (
                <button
                  aria-label={`块 ${blockIndex + 1}`}
                  className={[
                    "border border-white/60 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rose-200",
                    isRevealed ? "bg-emerald-400/30" : "",
                    isSelected ? "bg-rose-500/45" : "",
                    !isRevealed && !isSelected ? "hover:bg-rose-300/25" : "",
                  ].join(" ")}
                  data-reveal-grid-button="true"
                  disabled={isRevealed || Boolean(gameSession.roundStartedAt)}
                  key={blockIndex}
                  type="button"
                  onClick={() => toggleBlock(blockIndex)}
                />
              );
            })}
          </div>
        ) : null}
      </div>
      {shouldShowQuestionLabel ? (
        <div className="mx-auto mt-3 max-w-[1280px] rounded-md border border-[var(--line)] bg-slate-50 px-4 py-3 text-sm">
          <span className="font-semibold text-slate-950">正确答案：</span>
          <span className={currentQuestionLabel ? "text-slate-900" : "text-[var(--muted)]"}>
            {currentQuestionLabel || "未填写"}
          </span>
        </div>
      ) : null}
    </div>
  );

  const mobileSpectatorOriginalButton =
    isSpectator && canPreviewSpectatorOriginal && !isQuestionReviewing ? (
      <Button
        className="w-full lg:hidden"
        type="button"
        variant="secondary"
        onClick={() => setIsRevealPreviewOpen(true)}
      >
        查看原图
      </Button>
    ) : null;

  const actionPanel = (
    <div
      className="rounded-md border border-[var(--line)] bg-slate-50 p-4 lg:sticky lg:top-4 lg:h-[var(--image-display-height)] lg:max-h-[var(--image-display-height)] lg:overflow-y-auto"
      style={sidePanelHeightStyle}
    >
      {isSpectator && !isTeamBattleMode ? (
        <div className="space-y-4">
          <section className="rounded-md border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="rounded bg-slate-900 px-2 py-1 text-xs font-bold text-white">观战</span>
              {hasRoundStarted && !isQuestionReviewing ? (
                <span className="rounded bg-amber-100 px-2 py-1 text-xs font-bold text-amber-800">
                  {displayedRemainingSeconds}s
                </span>
              ) : null}
            </div>
            <p className="mt-3 text-2xl font-bold leading-tight text-slate-950">{spectatorTaskTitle}</p>
            <p className="mt-1 text-sm font-medium text-[var(--muted)]">{spectatorTaskDetail}</p>
            {!isTeamBattleMode && !isQuestionReviewing && canSpectatorPreviewQuestion ? (
              <p className="mt-3 hidden text-xs font-medium text-[var(--muted)] lg:block">按住 V 可临时查看原图</p>
            ) : null}
          </section>

          {mobileSpectatorOriginalButton}

          {!isQuestionReviewing || !isTeamBattleMode ? (
            <section className="rounded-md border border-[var(--line)] bg-white p-3 text-sm">
              {!isTeamBattleMode ? (
                canSpectatorViewPlayerAnswers ? (
                  <>
                    <PlayerAnswerViewSwitch
                      enabled={isAnswerViewEnabled}
                      onToggle={() => setIsAnswerViewEnabled((isEnabled) => !isEnabled)}
                    />
                    <div className="my-3 h-px bg-[var(--line)]" />
                  </>
                ) : (
                  <>
                    <p className="font-medium text-[var(--muted)]">房主已关闭查看回答</p>
                    <div className="my-3 h-px bg-[var(--line)]" />
                  </>
                )
              ) : null}

              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold text-slate-950">正确答案</p>
                {!isQuestionReviewing && canSpectatorPreviewQuestion ? (
                  <Button
                    className="h-9 min-w-16 px-3"
                    type="button"
                    variant="secondary"
                    onClick={() => setIsSpectatorLabelOpen((isOpen) => !isOpen)}
                  >
                    {isSpectatorLabelOpen ? "隐藏" : "展开"}
                  </Button>
                ) : null}
              </div>
              {isQuestionReviewing || (canSpectatorPreviewQuestion && isSpectatorLabelOpen) ? (
                <p className="mt-3 min-h-6 break-words rounded-md bg-slate-50 px-3 py-2 font-semibold text-slate-950">
                  {currentQuestionLabel || "暂无"}
                </p>
              ) : (
                <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-[var(--muted)]">
                  {canSpectatorPreviewQuestion ? "已隐藏" : "复盘后显示"}
                </p>
              )}
            </section>
          ) : null}
        </div>
      ) : isQuestionReviewing ? (
        <>
              {isSpectator ? <span className="mb-3 inline-flex rounded bg-slate-900 px-2 py-1 text-xs font-bold text-white">观战</span> : null}
              <p className="text-sm font-semibold text-slate-950">本题已结束，当前展示完整图片</p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {isPresenter ? "确认后进入下一步" : "等待出题人进入下一步"}
              </p>
          <div className="mt-3 rounded-md border border-[var(--line)] bg-white p-3 text-sm">
            <p className="font-semibold text-slate-950">正确答案</p>
            <p className="mt-1 text-[var(--muted)]">{currentQuestionLabel || "未填写"}</p>
          </div>
          {isTeamBattleMode && teamBattleState?.correctGuess ? (
            <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm">
              <p className="font-semibold text-emerald-800">
                {getTeamName(teamBattleState.correctGuess.team)}猜测回答正确
              </p>
              <p className="mt-2 break-words text-lg font-bold text-slate-950">
                「{teamBattleState.correctGuess.answerText}」
              </p>
              {teamBattleState.correctGuess.proposerName ? (
                <p className="mt-1 text-[var(--muted)]">提出者：{teamBattleState.correctGuess.proposerName}</p>
              ) : null}
            </div>
          ) : null}
          {!isPresenter && isCurrentPlayerCorrect ? (
            <div className="mt-3 rounded-md border border-[var(--line)] bg-white p-3 text-sm">
              <PlayerAnswerViewSwitch
                enabled={isAnswerViewEnabled}
                onToggle={() => setIsAnswerViewEnabled((isEnabled) => !isEnabled)}
              />
            </div>
          ) : null}
          {canAddQuestionLabel ? (
            <Button className="mt-3 w-full" type="button" variant="secondary" onClick={() => setIsLabelModalOpen(true)}>
              向玩家展示答案
            </Button>
          ) : null}
          {isPresenter && canOpenAnswerPanel ? (
            <Button
              className="mt-3 w-full"
              type="button"
              variant="secondary"
              onClick={(event) => {
                answerPanelTriggerRef.current = event.currentTarget;
                answerPanelAutoCloseArmedRef.current = false;
                setIsAnswerPanelOpen(true);
              }}
            >
              回答判定面板{answerPanelPendingCount > 0 ? `（${answerPanelPendingCount}）` : ""}
            </Button>
          ) : null}
          {isPresenter ? (
            <Button className="mt-3 w-full" type="button" onClick={handleAdvanceReviewedQuestion} disabled={isAdvancingQuestion}>
              {isAdvancingQuestion ? "切换中…" : hasNextQuestion ? "下一张图片" : "查看排行榜"}
            </Button>
          ) : null}
        </>
      ) : isTeamBattleMode && teamBattleState ? (
        <div className="space-y-4">
          <section className={["rounded-md border p-4", teamBattleTaskTone].join(" ")}>
            <div className="flex items-center justify-between gap-3">
              <span className="rounded bg-slate-900 px-2 py-1 text-xs font-bold text-white">{teamBattleTaskBadge}</span>
              {teamBattleVoteSeconds !== null && canSeeTeamBattleCountdown ? (
                <span className="rounded bg-amber-100 px-2 py-1 text-xs font-bold text-amber-800">
                  {teamBattleVoteSeconds}s
                </span>
              ) : null}
            </div>
            <p className="mt-3 text-2xl font-bold leading-tight text-slate-950">
              {teamBattleTaskTitle}
              {teamBattleTaskDetail || teamBattleTaskMeta ? (
                <span className="ml-2 align-baseline text-sm font-medium text-[var(--muted)]">
                  {teamBattleTaskDetail || teamBattleTaskMeta}
                </span>
              ) : null}
            </p>
          </section>

          {mobileSpectatorOriginalButton}

          {teamBattleState.phase === "REVEAL_VOTE" || teamBattleState.phase === "GUESS_VOTE" ? (
            <section className="rounded-md border border-[var(--line)] bg-white p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-950">{isSpectator ? "投票进度" : "队内进度"}</span>
                <span className="font-bold text-slate-950">
                  {teamBattleSubmittedCount}/{teamBattleVoteTotal}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={["h-full rounded-full", teamBattleActiveTone.solid].join(" ")}
                  style={{ width: `${Math.min(100, teamBattleVoteProgress)}%` }}
                />
              </div>
              {teamBattleHasSubmittedCurrentVote ? (
                <p className="mt-2 text-xs font-semibold text-emerald-700">你已提交，截止前可改</p>
              ) : null}
            </section>
          ) : null}

          {teamBattleState.phase !== "PRESENTER_BLOCK" || isPresenter ? (
            <section className="border-t border-[var(--line)] pt-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-950">{isSpectator ? "当前状态" : "操作"}</p>
                {teamBattleIsVoteClosed ? <span className="text-xs font-semibold text-amber-700">结算中</span> : null}
              </div>

            {teamBattleState.phase === "PRESENTER_BLOCK" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-[var(--muted)]">已选</span>
                  <span className="font-bold text-rose-700">{teamDisabledBlockDraft.length} 格</span>
                </div>
                <Button
                  className="w-full"
                  type="button"
                  onClick={handleCompleteTeamBattleBlockSelection}
                  disabled={isSubmittingTeamBattle || !isPresenterImageReady}
                >
                  {isSubmittingTeamBattle ? "提交中…" : isPresenterImageReady ? "确认禁用" : "图片加载中…"}
                </Button>
                <p className="text-center text-xs text-[var(--muted)]">
                  确认后本题不可修改
                </p>
              </div>
            ) : null}

            {teamBattleState.phase === "REVEAL_VOTE" ? (
              <div className="space-y-3">
                {!isSpectator ? (
                  <div className="rounded-md bg-white px-3 py-2 text-sm">
                    <span className="font-semibold text-slate-950">选格：</span>
                    <span className="text-[var(--muted)]">
                      {teamSelectedBlocks.length}/{teamBattleRequiredBlockCount}
                    </span>
                  </div>
                ) : null}
                {teamBattleCanAct ? (
                  <Button
                    className="w-full"
                    type="button"
                    onClick={handleSubmitTeamBattleRevealVote}
                    disabled={
                      isSubmittingTeamBattle ||
                      teamSelectedBlocks.length !== teamBattleRequiredBlockCount ||
                      teamBattleIsVoteClosed
                    }
                  >
                    {isSubmittingTeamBattle ? "提交中…" : teamBattleHasSubmittedRevealVote ? "更新选格" : "提交选格"}
                  </Button>
                ) : (
                  <p className="rounded-md bg-white px-3 py-2 text-sm text-[var(--muted)]">
                    {isPresenter ? "等待队员选格" : "等待当前队伍完成选格"}
                  </p>
                )}
              </div>
            ) : null}

            {teamBattleState.phase === "GUESS_VOTE" ? (
              <div className="space-y-3">
                {canSeeTeamBattleVotes ? (
                  <div className="rounded-md bg-white p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-slate-950">{isSpectator ? "实时投票" : "队内已投"}</p>
                      {teamBattleCanAct && !teamBattleIsVoteClosed ? (
                        <span className="text-xs font-semibold text-[var(--muted)]">点一下跟投</span>
                      ) : null}
                    </div>
                    {teamBattleGuessOptions.length > 0 ? (
                      <div className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1">
                        {teamBattleGuessOptions.map((option) => (
                          <button
                            className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--line)] bg-slate-50 px-3 py-2 text-left text-sm transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-default disabled:hover:border-[var(--line)] disabled:hover:bg-slate-50"
                            disabled={!teamBattleCanAct || teamBattleIsVoteClosed || isSubmittingTeamBattle}
                            key={option.key}
                            type="button"
                            onClick={() => {
                              if (option.vote.type === "skip") {
                                void handleSubmitTeamBattleGuessVote({ type: "skip" });
                                return;
                              }

                              const nextAnswer = option.vote.answerText ?? "";
                              setTeamGuessText(nextAnswer);
                              void handleSubmitTeamBattleGuessVote({ type: "guess", answerText: nextAnswer });
                            }}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-semibold text-slate-950">{option.label}</span>
                              {option.vote.type === "guess" ? (
                                <span className="mt-0.5 block text-xs text-[var(--muted)]">
                                  提出者：{option.proposerName}
                                </span>
                              ) : teamBattleCanAct && !teamBattleIsVoteClosed ? (
                                <span className="mt-0.5 block text-xs text-[var(--muted)]">跟投不猜</span>
                              ) : null}
                            </span>
                            <span className="shrink-0 rounded bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">
                              {option.count}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-[var(--muted)]">
                        {isSpectator ? "暂时没有人投票" : "暂无队内投票"}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="rounded-md bg-white px-3 py-2 text-sm text-[var(--muted)]">等待当前队伍决定</p>
                )}

                {teamBattleCanAct ? (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <p className="text-sm font-semibold text-slate-950">我的答案</p>
                      <input
                        ref={teamGuessInputRef}
                        className="h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none transition placeholder:text-slate-400 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                        maxLength={80}
                        placeholder="输入答案"
                        value={teamGuessText}
                        onChange={(event) => setTeamGuessText(event.target.value)}
                      />
                      <Button
                        className="w-full"
                        type="button"
                        onClick={() => handleSubmitTeamBattleGuessVote({ type: "guess", answerText: teamGuessText })}
                        disabled={isSubmittingTeamBattle || teamGuessText.trim().length === 0 || teamBattleIsVoteClosed}
                      >
                        {isSubmittingTeamBattle ? "提交中…" : teamBattleHasSubmittedGuessVote ? "更新猜测" : "提交猜测"}
                      </Button>
                    </div>
                    <div className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
                      <span className="h-px flex-1 bg-[var(--line)]" />
                      <span>或者</span>
                      <span className="h-px flex-1 bg-[var(--line)]" />
                    </div>
                    <button
                      className="h-11 w-full rounded-md border border-[var(--line)] bg-white px-4 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                      type="button"
                      onClick={() => handleSubmitTeamBattleGuessVote({ type: "skip" })}
                      disabled={isSubmittingTeamBattle || teamBattleIsVoteClosed}
                    >
                      本轮不猜
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {teamBattleState.phase === "JUDGING" && teamBattleState.pendingGuess ? (
              <div className="rounded-md bg-white p-3 text-sm">
                <p className="font-semibold text-slate-950">{getTeamName(teamBattleState.pendingGuess.team)}猜测</p>
                <p className="mt-2 break-words text-lg font-bold text-slate-950">{teamBattleState.pendingGuess.answerText}</p>
                {teamBattleState.pendingGuess.proposerName ? (
                  <p className="mt-1 text-[var(--muted)]">提出者：{teamBattleState.pendingGuess.proposerName}</p>
                ) : null}
                {isPresenter ? (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button type="button" onClick={() => handleJudgeTeamBattleGuess(true)} disabled={isJudgingTeamBattle}>
                      猜对
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => handleJudgeTeamBattleGuess(false)}
                      disabled={isJudgingTeamBattle}
                    >
                      猜错
                    </Button>
                  </div>
                ) : (
                  <p className="mt-2 text-[var(--muted)]">等待裁判</p>
                )}
              </div>
            ) : null}

            {teamBattleState.phase === "TURN_RESULT" && teamBattleState.previousTurnAction ? (
              <div className="rounded-md border border-slate-200 bg-white p-4 text-sm">
                <p className="font-semibold text-[var(--muted)]">
                  {getTeamName(teamBattleState.previousTurnAction.team)}本轮结果
                </p>
                {teamBattleState.previousTurnAction.type === "skip" ? (
                  <p className="mt-2 text-xl font-bold text-slate-950">选择不猜</p>
                ) : (
                  <div className="mt-2 space-y-2">
                    <p className="break-words text-lg font-bold text-slate-950">
                      猜测「{teamBattleState.previousTurnAction.answerText}」
                    </p>
                    <p className="font-bold text-rose-700">猜测错误</p>
                  </div>
                )}
                {isPresenter ? (
                  <Button
                    className="mt-4 w-full"
                    type="button"
                    onClick={handleAdvanceTeamBattleTurn}
                    disabled={isAdvancingTeamBattleTurn}
                  >
                    {isAdvancingTeamBattleTurn ? "切换中…" : "进入下一轮"}
                  </Button>
                ) : (
                  <p className="mt-3 text-[var(--muted)]">等待出题人进入下一轮</p>
                )}
              </div>
            ) : null}

            {teamBattleState.phase === "REVIEW" ? (
              <p className="rounded-md bg-white px-3 py-2 text-sm text-[var(--muted)]">
                本题已公布，等待切换
              </p>
            ) : null}
            </section>
          ) : null}

          {isPresenter ? (
            <div className="grid gap-2 border-t border-[var(--line)] pt-4">
              {canPreviewTeamBattleOriginal ? (
                <p className="rounded-md bg-white px-3 py-2 text-xs font-semibold text-[var(--muted)]">
                  按住 <kbd className="rounded border border-[var(--line)] bg-slate-50 px-1.5 py-0.5 text-slate-900">V</kbd> 预览原图
                </p>
              ) : null}
              <Button type="button" variant="secondary" onClick={handleRevealTeamBattleAnswer} disabled={isSkippingQuestion}>
                {isSkippingQuestion ? "公布中…" : "公布答案"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : isPresenter ? (
        <div className="space-y-4">
          <section className={["rounded-md border p-4", standardTaskTone].join(" ")}>
            <div className="flex items-center justify-between gap-3">
              <span className="rounded bg-slate-900 px-2 py-1 text-xs font-bold text-white">{standardTaskBadge}</span>
              <span
                className={[
                  "rounded px-2 py-1 text-xs font-bold",
                  hasRoundStarted ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700",
                ].join(" ")}
              >
                {hasRoundStarted ? `${displayedRemainingSeconds}s` : "未开始"}
              </span>
            </div>
            <p className="mt-3 text-2xl font-bold leading-tight text-slate-950">{standardTaskTitle}</p>
            <p className="mt-1 text-sm font-medium text-[var(--muted)]">{standardTaskDetail}</p>
          </section>

          {hasRoundStarted ? (
            <section className="rounded-md border border-[var(--line)] bg-white p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-950">{isBuzzerMode ? "抢答进度" : "提交进度"}</span>
                <span className="font-bold text-slate-950">
                  {standardSubmittedCount}/{standardTotalCount}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-slate-900"
                  style={{ width: `${Math.min(100, standardProgress)}%` }}
                />
              </div>
            </section>
          ) : null}

          <section className="border-t border-[var(--line)] pt-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-950">操作</p>
              <span className="text-xs font-semibold text-[var(--muted)]">
                已打开 {visibleRevealedBlockCount}/{visibleBlockCount}
              </span>
            </div>

            {hasRoundStarted ? (
              <div className="mb-3 rounded-md bg-white p-3 text-sm">
                <p className="font-semibold text-slate-950">{isBuzzerMode ? "抢答队列" : "待判定答案"}</p>
                {currentBuzzerAnswer ? (
                  <div className="mt-2 rounded-md bg-slate-50 p-3">
                    <p className="font-semibold text-slate-950">{getPlayerName(currentBuzzerAnswer.playerId)}</p>
                    <p className="mt-1 break-words text-[var(--muted)]">{currentBuzzerAnswer.answerText}</p>
                    {isWaitingForBuzzerQueueStability ? (
                      <p className="mt-2 text-xs font-semibold text-amber-700">答案已收到，顺序稳定后即可判定</p>
                    ) : null}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button type="button" onClick={() => handleJudgeBuzzerAnswer(true)} disabled={!canJudgeBuzzer}>
                        答对
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => handleJudgeBuzzerAnswer(false)}
                        disabled={!canJudgeBuzzer}
                      >
                        答错
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-[var(--muted)]">
                    {isWaitingForBuzzerQueueStability
                      ? "正在等待抢答顺序稳定"
                      : hasPendingJudgement
                        ? "正在同步待判定答案"
                      : isBuzzerMode
                        ? "当前没有待判定抢答"
                        : "当前没有待判定答案"}
                  </p>
                )}
              </div>
            ) : null}

            <div className="grid gap-2">
              {hasRoundStarted ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!canOpenAnswerPanel}
                  onClick={(event) => {
                    answerPanelTriggerRef.current = event.currentTarget;
                    answerPanelAutoCloseArmedRef.current = false;
                    setIsAnswerPanelOpen(true);
                  }}
                >
                  打开回答判定面板
                </Button>
              ) : (
                <Button type="button" onClick={handleConfirmReveal} disabled={!canConfirmReveal}>
                  {isConfirmingReveal ? "打开中…" : selectedBlocks.length > 0 ? `打开 ${selectedBlocks.length} 格` : "打开所选格子"}
                </Button>
              )}
              {canPreviewSelectedBlocks ? (
                <p className="rounded-md bg-white px-3 py-2 text-xs font-semibold text-[var(--muted)]">
                  按住 <kbd className="rounded border border-[var(--line)] bg-slate-50 px-1.5 py-0.5 text-slate-900">V</kbd> 预览玩家视角
                </p>
              ) : canPreviewPresenterPlayerView ? (
                <p className="rounded-md bg-white px-3 py-2 text-xs font-semibold text-[var(--muted)]">
                  按住 <kbd className="rounded border border-[var(--line)] bg-slate-50 px-1.5 py-0.5 text-slate-900">V</kbd> 查看玩家视角
                </p>
              ) : null}
              <Button type="button" onClick={handleSettleBuzzerRound} disabled={!canSettleBuzzerRound || isSettlingBuzzerRound}>
                {isSettlingBuzzerRound ? "处理中…" : standardSettleActionText}
              </Button>
              <Button type="button" variant="secondary" onClick={handleSkipQuestion} disabled={isSkippingQuestion}>
                {isSkippingQuestion ? "跳过中…" : "跳过本题"}
              </Button>
            </div>
          </section>
        </div>
      ) : (
        <div className="flex min-h-full flex-col">
          <div className="space-y-4">
            <section className={["rounded-md border p-4", standardTaskTone].join(" ")}>
              <div className="flex items-center justify-between gap-3">
                <span className="rounded bg-slate-900 px-2 py-1 text-xs font-bold text-white">{standardTaskBadge}</span>
                <span
                  className={[
                    "rounded px-2 py-1 text-xs font-bold",
                    hasRoundStarted ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700",
                  ].join(" ")}
                >
                  {hasRoundStarted ? `${displayedRemainingSeconds}s` : "未开始"}
                </span>
              </div>
              <p className="mt-3 text-2xl font-bold leading-tight text-slate-950">{standardTaskTitle}</p>
              <p className="mt-1 text-sm font-medium text-[var(--muted)]">{standardTaskDetail}</p>
            </section>

            {hasRoundStarted ? (
              <section className="rounded-md border border-[var(--line)] bg-white p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-950">{isBuzzerMode ? "抢答进度" : "提交进度"}</span>
                  <span className="font-bold text-slate-950">
                    {standardSubmittedCount}/{standardTotalCount}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-slate-900"
                    style={{ width: `${Math.min(100, standardProgress)}%` }}
                  />
                </div>
              </section>
            ) : null}

            <section className="border-t border-[var(--line)] pt-4">
              <p className="mb-3 text-sm font-semibold text-slate-950">操作</p>
              {isCurrentPlayerCorrect ? (
                <div className="space-y-3">
                  <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
                    你已答对本题
                  </p>
                  <div className="rounded-md border border-[var(--line)] bg-white p-3 text-sm">
                    <PlayerAnswerViewSwitch
                      enabled={isAnswerViewEnabled}
                      onToggle={() => setIsAnswerViewEnabled((isEnabled) => !isEnabled)}
                    />
                  </div>
                </div>
              ) : !hasRoundStarted ? (
                <p className="rounded-md bg-white px-3 py-2 text-sm text-[var(--muted)]">等待出题人打开图片</p>
              ) : (
                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-slate-900">你的答案</span>
                    <input
                      ref={answerInputRef}
                      className="h-12 w-full rounded-md border border-[var(--line)] bg-white px-3 text-base outline-none transition placeholder:text-slate-400 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                      disabled={
                        !isRoundActive ||
                        isRoundClosedForPlayerActions ||
                        (isBuzzerMode && Boolean(myBuzzerAnswer)) ||
                        (isBuzzerMode && myHasForfeited) ||
                        (!isBuzzerMode && myBuzzerAnswer?.status === "wrong")
                      }
                      maxLength={80}
                      placeholder="输入动画名称"
                      value={answerText}
                      onChange={(event) => setAnswerText(event.target.value)}
                      onKeyDown={handleAnswerInputKeyDown}
                    />
                  </label>
                  <Button
                    className="w-full"
                    type="button"
                    onClick={isBuzzerMode ? handleSubmitBuzzerAnswer : handleSubmitAnswer}
                    disabled={(isBuzzerMode ? !canSubmitBuzzerAnswer : !canSubmitAnswer) || isSubmittingAnswer}
                  >
                    {isSubmittingAnswer
                      ? "提交中…"
                      : isBuzzerMode
                        ? "提交抢答（回车）"
                        : myHasForfeited
                          ? "提交答案（回车）"
                          : myAnswer
                            ? "修改答案（回车）"
                            : "提交答案（回车）"}
                  </Button>
                  {!isTeamBattleMode ? (
                    <Button
                      className="w-full"
                      type="button"
                      variant="secondary"
                      onClick={myHasForfeited ? handleCancelForfeitAnswer : handleSubmitForfeitAnswer}
                      disabled={(myHasForfeited ? !canCancelForfeit : !canForfeitAnswer) || isSubmittingAnswer}
                    >
                      {isSubmittingAnswer ? "处理中…" : myHasForfeited ? "取消放弃" : "放弃本轮"}
                    </Button>
                  ) : null}
                  <p className="rounded-md bg-white px-3 py-2 text-sm text-[var(--muted)]">
                    {isBuzzerMode
                      ? myHasForfeited
                        ? "本轮已放弃"
                        : myBuzzerAnswer
                        ? `本轮已抢答：${myBuzzerAnswer.answerText}`
                        : isRoundEnded
                        ? "本轮已自动放弃"
                        : "本轮尚未抢答"
                      : myBuzzerAnswer?.status === "wrong"
                        ? `本轮已答错：${myBuzzerAnswer.answerText}`
                      : isRoundEnded && !myAnswer
                        ? "本轮已自动放弃"
                      : myAnswer
                        ? getAnswerDisplayText(myAnswer)
                        : "本轮尚未提交答案"}
                    {isRoundEnded ? "，本轮已结束" : ""}
                  </p>
                </div>
              )}
            </section>
          </div>

          {/*
            Round-start sound controls are intentionally hidden for now.
            Browser audio is unreliable when the tab is backgrounded or the window is minimized,
            which makes this reminder feel inconsistent during real play.
          */}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className={`${playingGridClass} text-sm`}>
        {isTeamBattleMode && teamBattleState ? (
          <>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <p className="min-w-0 truncate text-[var(--muted)]">房间 / 当前玩家</p>
                {playerId === room.hostPlayerId ? <span className="shrink-0 rounded bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">房主</span> : null}
              </div>
              <p className="mt-1 flex min-w-0 items-baseline text-lg font-semibold text-slate-950">
                <span className="shrink-0">{room.code}</span>
                <span className="mx-1.5 shrink-0 text-[var(--muted)]">·</span>
                <span className="min-w-0 truncate">{currentPlayerName}</span>
              </p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <p className="text-[var(--muted)]">游戏模式</p>
              <p className="mt-1 truncate text-lg font-semibold text-slate-950">{gameModeCardValue}</p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <p className="text-[var(--muted)]">当前题号</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                {gameSession.currentQuestionIndex + 1} / {questions.length}
              </p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <p className="text-[var(--muted)]">比分</p>
              <p className="mt-1 truncate text-lg font-semibold text-slate-950">{teamBattleScoreCardValue}</p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <p className="text-[var(--muted)]">当前行动</p>
              <p className="mt-1 truncate text-lg font-semibold text-slate-950">{teamBattleActionCardValue}</p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <p className="text-[var(--muted)]">已打开</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">{revealedBlocksCardValue}</p>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <p className="min-w-0 truncate text-[var(--muted)]">房间 / 当前玩家</p>
                {playerId === room.hostPlayerId ? <span className="shrink-0 rounded bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">房主</span> : null}
              </div>
              <p className="mt-1 flex min-w-0 items-baseline text-lg font-semibold text-slate-950">
                <span className="shrink-0">{room.code}</span>
                <span className="mx-1.5 shrink-0 text-[var(--muted)]">·</span>
                <span className="min-w-0 truncate">{currentPlayerName}</span>
              </p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <p className="text-[var(--muted)]">游戏模式</p>
              <p className="mt-1 truncate text-lg font-semibold text-slate-950">{gameModeCardValue}</p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <p className="text-[var(--muted)]">当前题号</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                {gameSession.currentQuestionIndex + 1} / {questions.length}
              </p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <p className="text-[var(--muted)]">当前轮次</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                第 {displayRound} / {maxRevealRounds} 轮
              </p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <p className="text-[var(--muted)]">{scoreCardLabel}</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">{scoreCardValue}</p>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-slate-50 p-3">
              <p className="text-[var(--muted)]">本题答对</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">{correctPlayersCardValue}</p>
            </div>
          </>
        )}
      </div>

      <div className={playingGridClass}>
        {scorePanel}
        <div className="min-w-0 lg:col-span-4">{imagePanel}</div>
        {actionPanel}
      </div>

      <div className="grid items-center gap-3 lg:grid-cols-6">
        <div className="lg:col-span-1">
          <Button
            type="button"
            variant="secondary"
            disabled={!previousQuestion}
            title={previousQuestion ? `回顾第 ${previousQuestionIndex! + 1} 题` : "暂无上题"}
            onClick={handleOpenPreviousQuestionReview}
          >
            回顾上题
          </Button>
        </div>
        {roomChat ? <div className="min-w-0 lg:col-span-4 lg:col-start-2">{roomChat}</div> : null}
        {footerActions ? <div className="flex flex-wrap items-center justify-end gap-3 lg:col-span-1 lg:col-start-6">{footerActions}</div> : null}
      </div>

      {isAnswerPanelOpen && canRenderPortal && gameSession && isPresenter && !isTeamBattleMode
        ? createPortal(
            <AnswerJudgementPanel
              canRevealAnswer={canRevealPanelAnswer}
              canJudgeAnswer={canJudgePanelAnswer}
              canMarkAllPendingWrong={canMarkAllPendingWrong}
              correctCount={answerPanelCorrectCount}
              countdownLabel={isQuestionReviewing || displayedRemainingSeconds === 0 ? "已截止" : `${displayedRemainingSeconds}s`}
              isMarkingAllPendingWrong={isMarkingPendingWrong}
              pendingCount={answerPanelPendingCount}
              questionNumber={gameSession.currentQuestionIndex + 1}
              revealRound={gameSession.currentRevealRound}
              rows={answerPanelRows}
              unansweredCount={answerPanelUnansweredCount}
              wrongCount={answerPanelWrongCount}
              onClose={closeAnswerPanel}
              onJudge={queueAnswerJudgement}
              onMarkAllPendingWrong={() => void handleMarkPendingRoundAnswersWrong()}
            />,
            document.body,
          )
        : null}

      {reviewedQuestion && reviewedQuestionIndex != null && canRenderPortal
        ? createPortal(
            <div
              className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/55 px-4 py-6"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  setReviewedQuestionIndex(null);
                }
              }}
            >
              <div
                aria-describedby="previous-question-review-description"
                aria-labelledby="previous-question-review-title"
                aria-modal="true"
                className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-2xl"
                role="dialog"
              >
                <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
                  <div>
                    <p className="text-lg font-semibold text-slate-950" id="previous-question-review-title">
                      上一题回顾 · 第 {reviewedQuestionIndex + 1} 题
                    </p>
                    <p className="mt-1 text-sm text-[var(--muted)]" id="previous-question-review-description">
                      当前题仍在进行，倒计时不会暂停
                    </p>
                  </div>
                  <button
                    className="shrink-0 rounded-md border border-[var(--line)] px-3 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-200"
                    ref={previousReviewCloseRef}
                    type="button"
                    onClick={() => setReviewedQuestionIndex(null)}
                  >
                    关闭
                  </button>
                </div>

                <div className="min-h-0 overflow-y-auto px-5 py-5">
                  <div className="relative grid min-h-48 place-items-center overflow-hidden rounded-md bg-slate-950">
                    {reviewedQuestion.isR18 ? (
                      <span className="absolute left-3 top-3 z-10 rounded bg-rose-600 px-2 py-1 text-xs font-black tracking-widest text-white shadow-lg">R18</span>
                    ) : null}
                    {reviewImageLoadFailed ? (
                      <div className="px-4 py-16 text-center text-white">
                        <p className="font-semibold">图片加载失败</p>
                        <p className="mt-2 text-sm text-slate-300">可能是图片链接失效或当前网络异常</p>
                      </div>
                    ) : (
                      <img
                        alt={`第 ${reviewedQuestionIndex + 1} 题原图`}
                        className="max-h-[60vh] w-full object-contain"
                        src={reviewedQuestion.imageUrl}
                        onError={() => setReviewImageLoadFailed(true)}
                      />
                    )}
                  </div>

                  <div className="mt-4 rounded-md border border-[var(--line)] bg-slate-50 px-4 py-3">
                    <p className="text-xs font-semibold text-[var(--muted)]">正确答案</p>
                    <p className="mt-1 break-words text-lg font-semibold text-slate-950">
                      {reviewedQuestion.labelText?.trim() || "本题未填写答案"}
                    </p>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {(isPresenter || isSpectator) && canHoldRevealPreview && currentQuestion && isRevealPreviewOpen && canRenderPortal
        ? createPortal(
            <div
              aria-label="原图预览"
              aria-modal="true"
              className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-6"
              role="dialog"
              onClick={() => setIsRevealPreviewOpen(false)}
            >
              <div
                className="relative w-full max-w-5xl overflow-hidden rounded-md bg-black shadow-2xl"
                style={{
                  aspectRatio: imageAspectRatio,
                  maxHeight: "86vh",
                  maxWidth: isPortraitImage ? `min(80vw, calc(86vh * ${imageAspectRatio}))` : "min(92vw, 1280px)",
                }}
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  aria-label="关闭原图预览"
                  className="absolute right-3 top-3 z-10 min-h-11 rounded-md bg-slate-950/80 px-4 text-sm font-semibold text-white shadow-lg transition hover:bg-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  type="button"
                  onClick={() => setIsRevealPreviewOpen(false)}
                >
                  关闭
                </button>
                <img alt="" className="h-full w-full object-cover" src={currentQuestion.imageUrl} />
                {canPreviewPresenterPlayerView ? (
                  <div
                    className="absolute inset-0 grid"
                    style={{
                      gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
                      gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
                    }}
                  >
                    {Array.from({ length: visibleBlockCount }, (_, blockIndex) => (
                      <div className={previewRevealedBlockSet.has(blockIndex) ? "bg-transparent" : "bg-black"} key={blockIndex} />
                    ))}
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}

      {isPresenter && canRenderPortal
        ? createPortal(
            Object.values(answerBubbles).map((answerBubble) => (
            <div
              className="pointer-events-none fixed z-40 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-950 shadow-lg"
              key={answerBubble.id}
              style={{
                left: answerBubble.left,
                top: answerBubble.top,
                width: answerBubble.width,
                transform: "translateY(-50%)",
              }}
            >
              <span className="block truncate">{answerBubble.text}</span>
            </div>
            )),
            document.body,
          )
        : null}

      {isLabelModalOpen && canAddQuestionLabel ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 px-4 py-6">
          <div className="w-full max-w-3xl overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-2xl">
            <div className="flex flex-col justify-between gap-3 border-b border-[var(--line)] px-5 py-4 sm:flex-row sm:items-start">
              <div>
                <p className="text-lg font-semibold text-slate-950">向玩家展示答案</p>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  保存后建议等待几秒，等玩家看清答案后再进入下一题。
                </p>
              </div>
              <button
                className="self-start rounded-md border border-[var(--line)] px-3 py-2 text-sm font-semibold hover:bg-slate-50"
                type="button"
                onClick={() => setIsLabelModalOpen(false)}
              >
                关闭
              </button>
            </div>

            <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
              <div>
                <p className="text-sm font-semibold text-slate-950">选择玩家答案</p>
                <div className="mt-2 space-y-2">
                  {labelAnswers.length > 0 ? (
                    labelAnswers.map((answer) => {
                      const isSelected = selectedLabelAnswerId === answer.id;

                      return (
                        <button
                          aria-pressed={isSelected}
                          className={[
                            "w-full rounded-md border px-3 py-2 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60",
                            isSelected
                              ? "border-[var(--primary)] bg-rose-50 ring-2 ring-rose-100"
                              : "border-[var(--line)] bg-slate-50 hover:border-rose-300 hover:bg-rose-50",
                          ].join(" ")}
                          disabled={isSavingLabel}
                          key={answer.id}
                          type="button"
                          onClick={() => handleSelectLabelAnswer(answer.id)}
                        >
                          <span className="flex items-center justify-between gap-3">
                            <span className="block font-semibold text-slate-950">{getPlayerName(answer.playerId)}</span>
                            {isSelected ? (
                              <span className="shrink-0 rounded bg-[var(--primary)] px-2 py-0.5 text-xs font-semibold text-white">
                                已选择
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-1 block text-[var(--muted)]">{answer.answerText}</span>
                        </button>
                      );
                    })
                  ) : (
                    <p className="rounded-md border border-[var(--line)] bg-slate-50 px-3 py-2 text-sm text-[var(--muted)]">
                      本题还没有可选择的玩家回答
                    </p>
                  )}
                </div>
              </div>

              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-950">手动输入答案</span>
                <input
                  className="h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                  maxLength={80}
                  placeholder="例如：动画名称"
                  value={labelInput}
                  onChange={(event) => handleLabelInputChange(event.target.value)}
                />
              </label>
              <p className="text-sm text-[var(--muted)]">答案保存后不能修改。</p>
            </div>

            <div className="flex flex-col justify-between gap-3 border-t border-[var(--line)] bg-slate-50 px-5 py-4 sm:flex-row sm:items-center">
              <Button type="button" variant="secondary" onClick={handleDisableLabelPromptForGame}>
                本局不再提示
              </Button>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  onClick={handleSaveQuestionLabel}
                  disabled={isSavingLabel || (!selectedLabelAnswerId && !labelInput.trim())}
                >
                  {isSavingLabel ? "保存中…" : "保存答案"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {resultPublishQuestionSet ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 px-4 py-6">
          <div className="w-full max-w-xl overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-2xl">
            <div className="border-b border-[var(--line)] px-5 py-4">
              <p className="text-lg font-semibold text-slate-950">发布到社区？</p>
              <p className="mt-1 text-sm leading-6 text-[var(--muted)]">觉得这套题好玩？出题不易，发布到社区让更多人直接开玩</p>
            </div>

            <div className="space-y-4 px-5 py-4">
              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-950">题库标题</span>
                <input
                  className="h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                  maxLength={80}
                  placeholder="必填"
                  value={resultPublishTitle}
                  onChange={(event) => setResultPublishTitle(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-950">简介</span>
                <input
                  className="h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                  maxLength={160}
                  placeholder="可留空"
                  value={resultPublishDescription}
                  onChange={(event) => setResultPublishDescription(event.target.value)}
                />
              </label>
              <fieldset>
                <legend className="mb-2 text-sm font-semibold text-slate-950">出题方式（自动识别）</legend>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ["player_manual", "玩家手动出题"],
                    ["creation_tool_assisted", "出题工具辅助"],
                  ] as const).map(([value, label]) => {
                    const isSelected = resultPublishCreationMethod === value;
                    return (
                      <label
                        className={`flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-3 py-2 text-center text-sm font-medium transition focus-within:ring-2 focus-within:ring-rose-200 ${
                          isSelected
                            ? "border-[var(--primary)] bg-rose-50 text-rose-800 ring-2 ring-rose-100"
                            : "border-[var(--line)] bg-white text-slate-700 hover:border-rose-300"
                        }`}
                        key={value}
                      >
                        <input
                          className="sr-only"
                          type="radio"
                          name="result-publish-creation-method"
                          value={value}
                          checked={isSelected}
                          onChange={() => setResultPublishCreationMethod(value)}
                        />
                        {label}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            </div>

            <div className="flex flex-col justify-end gap-2 border-t border-[var(--line)] bg-slate-50 px-5 py-4 sm:flex-row">
              <Button
                type="button"
                variant="secondary"
                onClick={handleSkipResultPublish}
                disabled={isPublishingBeforeResult || isAdvancingQuestion || isSkippingQuestion}
              >
                不发布，查看排行榜
              </Button>
              <Button
                type="button"
                onClick={handleConfirmResultPublish}
                disabled={isPublishingBeforeResult || isAdvancingQuestion || isSkippingQuestion || !resultPublishTitle.trim()}
              >
                {isPublishingBeforeResult ? "发布中…" : "发布并查看排行榜"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
