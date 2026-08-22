export type Player = {
  id: string;
  roomId?: string;
  nickname: string;
  isHost: boolean;
  role: PlayerRole;
  joinedAt: number | string;
  lastSeenAt?: string;
};

export type PlayerRole = "PLAYER" | "SPECTATOR";
export type RoomStatus = "LOBBY" | "QUESTION_SETUP" | "PLAYING" | "GAME_RESULT";
export type RoomVisibility = "PRIVATE" | "PUBLIC";
export type RoomQuestionSource = "COMMUNITY" | "CREATION_TOOL" | "MANUAL";
export type GameMode = "ROUND_REVEAL" | "BUZZER_FIRST_CORRECT" | "BUZZER_RANKED" | "TEAM_BATTLE";
export type BuzzerAnswerStatus = "pending" | "correct" | "wrong";
export type TeamBattleTeam = "red" | "blue";
export type TeamAssignmentMode = "AUTO" | "MANUAL";
export const MAX_ROOM_NOTICE_LENGTH = 80;
export type TeamBattlePhase = "PRESENTER_BLOCK" | "REVEAL_VOTE" | "GUESS_VOTE" | "JUDGING" | "TURN_RESULT" | "REVIEW";
export const DEFAULT_TEAM_BATTLE_REVEAL_VOTE_SECONDS = 25;
export const DEFAULT_TEAM_BATTLE_GUESS_VOTE_SECONDS = 50;
export const TEAM_BATTLE_ALL_SUBMITTED_GRACE_SECONDS = 5;
export const MAX_TEAM_BATTLE_GUESS_LENGTH = 80;
export const MAX_GAME_QUESTION_COUNT = 30;

export type TeamBattleGuessVote = {
  type: "skip" | "guess";
  answerText?: string;
};

export type TeamBattleGuessProposal = {
  answerText: string;
  proposerPlayerId: string;
  proposerName: string;
};

export type TeamBattleResolvedGuess = {
  team: TeamBattleTeam;
  answerText: string;
  proposerPlayerId?: string;
  proposerName?: string;
};

export type TeamBattlePreviousTurnAction =
  | {
      team: TeamBattleTeam;
      type: "skip";
    }
  | {
      team: TeamBattleTeam;
      type: "guess";
      answerText: string;
    };

export type TeamBattleState = {
  teams: Record<TeamBattleTeam, string[]>;
  initialTeams?: Record<TeamBattleTeam, string[]>;
  teamMemberNames?: Record<string, string>;
  activeTeam: TeamBattleTeam;
  phase: TeamBattlePhase;
  presenterBlockEnabled?: boolean;
  revealBlockCount?: number;
  disabledBlocks?: number[];
  revealLimit: number;
  turnNumber: number;
  revealVoteSeconds?: number;
  guessVoteSeconds?: number;
  voteDeadlineAt?: string | null;
  revealVotes: Record<string, number[]>;
  guessVotes: Record<string, TeamBattleGuessVote>;
  guessProposals?: TeamBattleGuessProposal[];
  previousTurnAction?: TeamBattlePreviousTurnAction | null;
  pendingGuess?: TeamBattleResolvedGuess | null;
  correctGuess?: TeamBattleResolvedGuess | null;
  teamScores: Record<TeamBattleTeam, number>;
  message?: string | null;
};

export type Room = {
  id?: string;
  code: string;
  hostPlayerId: string;
  players: Player[];
  status: RoomStatus;
  currentPresenterPlayerId?: string | null;
  currentGameId?: string | null;
  preparedQuestionSetId?: string | null;
  preparedQuestionCount?: number | null;
  questionCount?: number | null;
  visibility?: RoomVisibility;
  name?: string | null;
  notice?: string | null;
  playerCount?: number;
  playerCapacity?: number;
  spectatorCapacity?: number;
  preparedQuestionSource?: RoomQuestionSource | null;
  gameMode?: GameMode;
  maxRevealRounds?: number;
  roundSeconds?: number;
  roundScores?: number[];
  teamRevealVoteSeconds?: number;
  teamGuessVoteSeconds?: number;
  teamPresenterBlockEnabled?: boolean;
  spectatorQuestionPreviewEnabled?: boolean;
  spectatorPlayerAnswersEnabled?: boolean;
  teamAssignmentMode?: TeamAssignmentMode;
  teamAssignments?: Partial<Record<string, TeamBattleTeam>>;
  /** 房间级“包含 R18 题目”开关；默认 false，关闭时服务端抽题必须排除 R18 题目。 */
  includeR18?: boolean;
  createdAt: number | string;
  updatedAt?: string;
};

export type DbRoom = {
  id: string;
  room_code: string;
  host_player_id: string;
  game_status: RoomStatus;
  current_presenter_player_id: string | null;
  current_game_id: string | null;
  prepared_question_set_id?: string | null;
  prepared_question_count?: number | null;
  lobby_question_count?: number | null;
  room_visibility?: RoomVisibility | null;
  room_name?: string | null;
  room_notice?: string | null;
  member_count?: number | null;
  spectator_count?: number | null;
  lobby_player_capacity?: number | null;
  lobby_spectator_capacity?: number | null;
  prepared_question_source?: RoomQuestionSource | null;
  public_activity_at?: string | null;
  lobby_game_mode?: GameMode | null;
  lobby_max_reveal_rounds?: number | null;
  lobby_round_seconds?: number | null;
  lobby_round_scores?: unknown;
  lobby_team_reveal_vote_seconds?: number | null;
  lobby_team_guess_vote_seconds?: number | null;
  lobby_team_presenter_block_enabled?: number | boolean | null;
  lobby_spectator_question_preview_enabled?: number | boolean | null;
  lobby_spectator_player_answers_enabled?: number | boolean | null;
  lobby_team_assignment_mode?: TeamAssignmentMode | null;
  lobby_team_assignments?: unknown;
  /** 房间级“包含 R18 题目”开关的持久列；0/1 或布尔，旧房间默认 false。 */
  lobby_include_r18?: number | boolean | null;
  runtime_generation?: number | null;
  room_state_version?: number | null;
  room_state_revision?: number | null;
  room_state_json?: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicRoomSummary = {
  id: string;
  code: string;
  name: string;
  status: RoomStatus;
  gameMode: GameMode;
  playerCount: number;
  spectatorCount: number;
  playerCapacity: number;
  spectatorCapacity: number;
  isCountApproximate: boolean;
  questionSource: RoomQuestionSource | null;
  currentQuestionIndex?: number | null;
  questionCount?: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DbPlayer = {
  id: string;
  room_id: string;
  nickname: string;
  is_host: boolean;
  role?: PlayerRole | null;
  joined_at: string;
  last_seen_at: string;
};

export type QuestionSetSource = "uploaded" | "community";

export type QuestionSetCreationMethod = "player_manual" | "creation_tool_assisted";

export type CommunityQuestionSetSort = "latest" | "rating" | "plays";

export type CommunityQuestionSetSummary = {
  id: string;
  title: string;
  description?: string | null;
  createdByPlayerId: string;
  createdByNickname?: string | null;
  source: QuestionSetSource;
  creationMethod?: QuestionSetCreationMethod | null;
  isPublic: boolean;
  imageCount: number;
  ratingAvg: number;
  ratingCount: number;
  playCount: number;
  createdAt: string;
  updatedAt?: string | null;
};

export type CommunityQuestionSetPage = {
  items: CommunityQuestionSetSummary[];
  total: number | null;
  hasMore: boolean;
  nextOffset: number;
};

export type QuestionSet = {
  id: string;
  title: string;
  description?: string | null;
  createdByPlayerId: string;
  createdByNickname?: string | null;
  source: QuestionSetSource;
  creationMethod?: QuestionSetCreationMethod | null;
  isPublic: boolean;
  imageUrlsText?: string | null;
  imageCount: number;
  ratingAvg: number;
  ratingCount: number;
  playCount: number;
  createdAt: string;
  updatedAt?: string | null;
  questions?: Question[];
};

export type BangumiSubjectType = 2 | 4;

export type BangumiSubjectScope = "anime" | "game" | "all";

export type BangumiAnimeTag = {
  id: number;
  name: string;
  nameCn: string | null;
  /** Bangumi subject type (2=动画, 4=游戏)。旧数据可能缺失，搜索与规范化后应尽量携带。 */
  subjectType?: BangumiSubjectType | null;
};

export type BangumiCharacterTag = {
  id: number;
  subjectId: number;
  name: string;
  nameCn: string | null;
  relation: string | null;
};

/** Bangumi 用户属性标签（异世界、恋爱等），仅服务端从官方 subject 详情获取。 */
export type BangumiGenreTag = {
  name: string;
  count: number;
};

export type Question = {
  id: string;
  questionSetId: string;
  imageUrl: string;
  orderIndex: number;
  /** 本题是否为成人内容（R18）。默认 false；游戏运行时可见，便于未来遮罩，不自动隐藏/删除。 */
  isR18: boolean;
  labelText?: string | null;
  labelSource?: "manual" | "answer" | null;
  labelSourceAnswerId?: string | null;
  labelUpdatedByPlayerId?: string | null;
  labelUpdatedAt?: string | null;
  createdAt: string;
  /** 社区图库中本题图片的上传者昵称（出题人）；非社区题库或未知历史投稿为 null。 */
  uploaderNickname?: string | null;
};

export type QuestionUrlImportInput = {
  imageUrl: string;
  labelText?: string | null;
  isR18?: boolean;
  orderIndex: number;
};

export type PreparedQuestionUrlImport = QuestionUrlImportInput & {
  originalImageUrl: string;
  r2Key?: string | null;
  rawBytes?: number | null;
  uploadBytes?: number | null;
  usedOriginal?: boolean;
};

export type FailedQuestionUrlImport = QuestionUrlImportInput & {
  error: string;
};

export type GameSession = {
  id: string;
  roomId: string;
  questionSetId: string;
  presenterPlayerId: string;
  status: RoomStatus;
  gameMode: GameMode;
  currentQuestionIndex: number;
  currentRevealRound: number;
  revealedBlocks: number[];
  maxRevealRounds: number;
  roundSeconds: number;
  roundScores: number[];
  questionCount?: number;
  eligiblePlayerIds?: string[];
  roundStartedAt?: string | null;
  serverNow?: string;
  teamBattleState?: TeamBattleState | null;
  createdAt: string;
  endedAt?: string | null;
  completedNormallyAt?: string | null;
};

export type Answer = {
  id: string;
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
  playerId: string;
  answerText: string;
  submittedAt: string;
};

export type PlayerScore = {
  id: string;
  gameSessionId: string;
  playerId: string;
  score: number;
  correctCount: number;
};

export type LeaderboardEntry = {
  playerId: string;
  nickname: string;
  rank: number;
  score: number;
  correctCount: number;
};

export type GameResultQuestionScore = {
  playerId: string;
  questionIndex: number;
  scoreAwarded: number;
};

export type QuestionResult = {
  id: string;
  gameSessionId: string;
  questionIndex: number;
  playerId: string;
  scoredRound: number;
  scoreAwarded: number;
  judgedByPlayerId: string;
  judgedAt: string;
};

export type RoundSnapshot = {
  gameSession: GameSession;
  scores: PlayerScore[];
  questionResults: QuestionResult[];
  answers: Answer[];
  labelAnswers: Answer[];
  buzzerAnswers: BuzzerAnswer[];
  labelBuzzerAnswers: BuzzerAnswer[];
};

export type GameBootstrapSnapshot = {
  gameSession: GameSession;
  questions: Question[];
  roundSnapshot: RoundSnapshot;
};

export type GameResultSnapshot = {
  gameSession: GameSession;
  leaderboard: LeaderboardEntry[];
  questionSet: QuestionSet | null;
  questionScores: GameResultQuestionScore[];
};

export type PublicAnswerProgress = Omit<Answer, "answerText"> & {
  forfeited: boolean;
};

export type PublicBuzzerAnswerProgress = Omit<BuzzerAnswer, "answerText">;

export type RealtimeDelta =
  | {
      scope: "room";
      type: "room_updated";
      room: Room;
    }
  | {
      scope: "room";
      type: "room_notice_updated";
      roomId: string;
      notice: string | null;
      updatedAt: string;
    }
  | {
      scope: "room";
      type: "room_dissolved";
      roomId: string;
    }
  | {
      scope: "game";
      type: "game_session_updated";
      gameSession: GameSession;
    }
  | {
      scope: "game";
      type: "round_snapshot";
      snapshot: RoundSnapshot;
    }
  | {
      scope: "game";
      type: "game_result_snapshot";
      snapshot: GameResultSnapshot;
    }
  | {
      scope: "game";
      type: "answer_submitted";
      answer: Answer;
      buzzerAnswer?: BuzzerAnswer;
    }
  | {
      scope: "game";
      type: "answer_canceled";
      gameSession: GameSession;
      canceledAnswerId: string;
      canceledPlayerId?: string;
    }
  | {
      scope: "game";
      type: "buzzer_answer_submitted";
      buzzerAnswer: BuzzerAnswer;
    }
  | {
      scope: "game";
      type: "buzzer_answer_judged";
      gameSession?: GameSession;
      buzzerAnswer: BuzzerAnswer;
      scores?: PlayerScore[];
      questionResults?: QuestionResult[];
      removedQuestionResultPlayerIds?: string[];
      buzzerAnswers?: BuzzerAnswer[];
    }
  | {
      scope: "game";
      type: "answer_judgements_changed";
      gameSession?: GameSession;
      answers: BuzzerAnswer[];
      scores: PlayerScore[];
      questionResults: QuestionResult[];
      removedQuestionResultPlayerIds?: string[];
    }
  | {
      scope: "game";
      type: "answer_text_backfill";
      gameSessionId: string;
      questionIndex: number;
      buzzerAnswers: BuzzerAnswer[];
    }
  | {
      scope: "game";
      type: "answer_progress_changed";
      gameSession?: GameSession;
      answers: PublicAnswerProgress[];
      buzzerAnswers: PublicBuzzerAnswerProgress[];
      canceledPlayerIds?: string[];
      scores: PlayerScore[];
      questionResults: QuestionResult[];
      removedQuestionResultPlayerIds?: string[];
    }
  | {
      scope: "game";
      type: "question_label_updated";
      question: Question;
    }
  | {
      scope: "question-set";
      type: "question_set_updated";
      questionSet: QuestionSet;
      ratedPlayerId?: string;
      rating?: number;
    };

export type DbQuestionSet = {
  id: string;
  title: string;
  description: string | null;
  created_by_player_id: string;
  created_by_nickname?: string | null;
  source: QuestionSetSource;
  creation_method?: QuestionSetCreationMethod | null;
  is_public: boolean;
  image_urls_text?: string | null;
  image_count: number;
  rating_avg: number;
  rating_count: number;
  play_count: number;
  manifest_version?: number | null;
  manifest_revision?: number;
  manifest_json?: string | null;
  community_submission_id?: string | null;
  community_submission_fingerprint?: string | null;
  community_collection_title?: string | null;
  community_structure_edited?: number | boolean;
  created_at: string;
  updated_at?: string | null;
};

export type DbQuestion = {
  id: string;
  question_set_id: string;
  image_url: string;
  order_index: number;
  is_r18?: number | boolean | null;
  label_text?: string | null;
  label_source?: "manual" | "answer" | null;
  label_source_answer_id?: string | null;
  label_updated_by_player_id?: string | null;
  label_updated_at?: string | null;
  created_at: string;
};

export type DbGameSession = {
  id: string;
  room_id: string;
  question_set_id: string;
  presenter_player_id: string;
  status: RoomStatus;
  game_mode?: GameMode | null;
  current_question_index: number;
  current_reveal_round: number;
  revealed_blocks: unknown;
  max_reveal_rounds?: number;
  round_seconds?: number;
  round_scores?: unknown;
  selected_question_ids?: unknown;
  team_battle_state?: unknown;
  round_started_at: string | null;
  created_at: string;
  ended_at: string | null;
  completed_normally_at?: string | null;
};

export type DbAnswer = {
  id: string;
  game_session_id: string;
  question_index: number;
  reveal_round: number;
  player_id: string;
  answer_text: string;
  submitted_at: string;
};

export type DbPlayerScore = {
  id: string;
  game_session_id: string;
  player_id: string;
  score: number;
  correct_count: number;
};

export type DbQuestionResult = {
  id: string;
  game_session_id: string;
  question_index: number;
  player_id: string;
  scored_round: number;
  score_awarded: number;
  judged_by_player_id: string;
  judged_at: string;
};

export type BuzzerAnswer = {
  id: string;
  gameSessionId: string;
  questionIndex: number;
  revealRound: number;
  playerId: string;
  answerText: string;
  status: BuzzerAnswerStatus;
  scoreAwarded: number;
  submittedAt: string;
  serverReceivedAt: string;
  judgedAt?: string | null;
  judgedByPlayerId?: string | null;
};

export type DbBuzzerAnswer = {
  id: string;
  game_session_id: string;
  question_index: number;
  reveal_round: number;
  player_id: string;
  answer_text: string;
  status: BuzzerAnswerStatus;
  score_awarded: number;
  submitted_at: string;
  server_received_at: string | null;
  judged_at: string | null;
  judged_by_player_id: string | null;
};

export type LocalSession = {
  playerId: string;
  nickname: string;
  roomCode?: string;
  isHost?: boolean;
};
