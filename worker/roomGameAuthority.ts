import { DurableSqlDatabase } from "./durableSqlDatabase";

type Row = Record<string, unknown>;

const AUTHORITY_SCHEMA_VERSION = 14;
const AUTHORITY_VNEXT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS authority_vnext_active_game (
    id INTEGER PRIMARY KEY CHECK(id=1), room_id TEXT NOT NULL, game_id TEXT NOT NULL,
    authority_version INTEGER NOT NULL, schema_version INTEGER NOT NULL, cutover_state TEXT NOT NULL,
    state_version INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS authority_vnext_question_archive (
    game_id TEXT NOT NULL, question_index INTEGER NOT NULL, checkpoint_version INTEGER NOT NULL,
    state_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(game_id,question_index)
  )`,
  `CREATE TABLE IF NOT EXISTS authority_vnext_projection_outbox (
    id INTEGER PRIMARY KEY CHECK(id=1), payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
] as const;
const MUTATION_JOURNAL_VALIDATION_SCHEMA = `CREATE TABLE IF NOT EXISTS mutation_journal_validation (id INTEGER PRIMARY KEY CHECK(id=1), validated_at INTEGER NOT NULL)`;

const FORFEIT_ANSWER_TEXT = "__FORFEIT__";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS authority_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS authority_meta (room_id TEXT PRIMARY KEY, hydrated_at TEXT NOT NULL, active_game_id TEXT, epoch TEXT NOT NULL, state_version INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS processed_actions (action_key TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS projection_outbox (projection_id TEXT PRIMARY KEY, game_session_id TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS authority_cleanup (room_id TEXT PRIMARY KEY, run_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS projected_question_labels (question_id TEXT PRIMARY KEY, label_updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS projected_question_archives (game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, projection_version INTEGER NOT NULL, PRIMARY KEY(game_session_id,question_index))`,
  `CREATE TABLE IF NOT EXISTS mutation_journal (id INTEGER PRIMARY KEY CHECK(id=1), room_id TEXT NOT NULL, name TEXT NOT NULL, action_key TEXT, started_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mutation_journal_payload (id INTEGER PRIMARY KEY CHECK(id=1), payload_json TEXT NOT NULL)`,
  MUTATION_JOURNAL_VALIDATION_SCHEMA,
  `CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, room_code TEXT NOT NULL UNIQUE, host_player_id TEXT NOT NULL, game_status TEXT NOT NULL, current_presenter_player_id TEXT, current_game_id TEXT, prepared_question_set_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lobby_game_mode TEXT NOT NULL DEFAULT 'ROUND_REVEAL', lobby_max_reveal_rounds INTEGER NOT NULL DEFAULT 3, lobby_round_seconds INTEGER NOT NULL DEFAULT 45, lobby_round_scores TEXT NOT NULL DEFAULT '[5,3,1]', lobby_team_reveal_vote_seconds INTEGER NOT NULL DEFAULT 15 CHECK (lobby_team_reveal_vote_seconds BETWEEN 1 AND 600), lobby_team_guess_vote_seconds INTEGER NOT NULL DEFAULT 50 CHECK (lobby_team_guess_vote_seconds BETWEEN 1 AND 600), lobby_team_assignment_mode TEXT NOT NULL DEFAULT 'AUTO' CHECK (lobby_team_assignment_mode IN ('AUTO','MANUAL')), lobby_team_assignments TEXT NOT NULL DEFAULT '{}', lobby_team_presenter_block_enabled INTEGER NOT NULL DEFAULT 0 CHECK (lobby_team_presenter_block_enabled IN (0,1)), lobby_spectator_question_preview_enabled INTEGER NOT NULL DEFAULT 1 CHECK (lobby_spectator_question_preview_enabled IN (0,1)), lobby_spectator_player_answers_enabled INTEGER NOT NULL DEFAULT 1 CHECK (lobby_spectator_player_answers_enabled IN (0,1)), lobby_player_capacity INTEGER NOT NULL DEFAULT 50 CHECK (lobby_player_capacity BETWEEN 1 AND 50), lobby_spectator_capacity INTEGER NOT NULL DEFAULT 50 CHECK (lobby_spectator_capacity BETWEEN 0 AND 50), lobby_question_count INTEGER CHECK (lobby_question_count IS NULL OR lobby_question_count BETWEEN 1 AND 30), prepared_question_count INTEGER CHECK (prepared_question_count IS NULL OR prepared_question_count BETWEEN 1 AND 30))`,
  `CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, nickname TEXT NOT NULL, is_host INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), role TEXT NOT NULL DEFAULT 'PLAYER')`,
  `CREATE TABLE IF NOT EXISTS question_sets (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, created_by_player_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'uploaded', creation_method TEXT CHECK (creation_method IS NULL OR creation_method IN ('player_manual','creation_tool_assisted')), is_public INTEGER NOT NULL DEFAULT 0, image_urls_text TEXT, image_count INTEGER NOT NULL DEFAULT 0, rating_avg REAL NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_nickname TEXT, play_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, question_set_id TEXT NOT NULL, image_url TEXT NOT NULL, order_index INTEGER NOT NULL, label_text TEXT, label_source TEXT, label_source_answer_id TEXT, label_updated_by_player_id TEXT, label_updated_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS game_sessions (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, question_set_id TEXT NOT NULL, presenter_player_id TEXT NOT NULL, status TEXT NOT NULL, game_mode TEXT NOT NULL, current_question_index INTEGER NOT NULL DEFAULT 0, current_reveal_round INTEGER NOT NULL DEFAULT 1, revealed_blocks TEXT NOT NULL DEFAULT '[]', max_reveal_rounds INTEGER NOT NULL DEFAULT 3, round_seconds INTEGER NOT NULL DEFAULT 45, round_scores TEXT NOT NULL DEFAULT '[5,3,1]', selected_question_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(selected_question_ids) AND json_type(selected_question_ids)='array' AND json_array_length(selected_question_ids) BETWEEN 0 AND 30 AND length(selected_question_ids)<=4096), team_battle_state TEXT, round_started_at TEXT, created_at TEXT NOT NULL, ended_at TEXT, completed_normally_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, reveal_round INTEGER NOT NULL, player_id TEXT NOT NULL, answer_text TEXT NOT NULL, submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(game_session_id, question_index, reveal_round, player_id))`,
  `CREATE TABLE IF NOT EXISTS buzzer_answers (id TEXT PRIMARY KEY, game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, reveal_round INTEGER NOT NULL, player_id TEXT NOT NULL, answer_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', score_awarded INTEGER NOT NULL DEFAULT 0, submitted_at TEXT NOT NULL, server_received_at TEXT, judged_at TEXT, judged_by_player_id TEXT, UNIQUE(game_session_id, question_index, reveal_round, player_id))`,
  `CREATE TABLE IF NOT EXISTS player_scores (id TEXT PRIMARY KEY, game_session_id TEXT NOT NULL, player_id TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, correct_count INTEGER NOT NULL DEFAULT 0, UNIQUE(game_session_id, player_id))`,
  `CREATE TABLE IF NOT EXISTS question_results (id TEXT PRIMARY KEY, game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, player_id TEXT NOT NULL, scored_round INTEGER NOT NULL, score_awarded INTEGER NOT NULL, judged_by_player_id TEXT NOT NULL, judged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(game_session_id, question_index, player_id))`,
  `CREATE TABLE IF NOT EXISTS question_snapshots (game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, eligible_player_count INTEGER NOT NULL, eligible_player_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(game_session_id, question_index))`,
  `CREATE TABLE IF NOT EXISTS question_eligible_players (game_session_id TEXT NOT NULL, question_index INTEGER NOT NULL, player_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(game_session_id, question_index, player_id))`,
  `CREATE TABLE IF NOT EXISTS game_participants (game_session_id TEXT NOT NULL, player_id TEXT NOT NULL, nickname TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'PLAYER', joined_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(game_session_id, player_id))`,
  `CREATE TABLE IF NOT EXISTS completed_question_set_plays (game_session_id TEXT PRIMARY KEY, question_set_id TEXT NOT NULL, completed_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS question_set_ratings (id TEXT PRIMARY KEY, question_set_id TEXT NOT NULL, player_id TEXT NOT NULL, rating INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(question_set_id, player_id))`,
  `DROP TRIGGER IF EXISTS increment_local_question_set_play_count`,
] as const;

const LOCAL_TABLES = [
  "completed_question_set_plays", "question_eligible_players", "question_snapshots", "question_results",
  "player_scores", "buzzer_answers", "answers", "game_participants", "game_sessions", "questions",
  "question_sets", "players", "rooms",
] as const;

const GAME_TABLES = [
  "answers", "buzzer_answers", "player_scores", "question_results", "question_snapshots",
  "question_eligible_players", "game_participants",
] as const;

const PROJECT_TABLES = [
  "rooms", "players", "question_sets", "questions", "game_sessions", ...GAME_TABLES, "completed_question_set_plays",
] as const;

const CONFLICT_COLUMNS: Record<string, string[]> = {
  rooms: ["id"], players: ["id"], question_sets: ["id"], questions: ["id"], game_sessions: ["id"],
  answers: ["id"], buzzer_answers: ["id"], player_scores: ["id"], question_results: ["id"],
  question_snapshots: ["game_session_id", "question_index"],
  question_eligible_players: ["game_session_id", "question_index", "player_id"],
  game_participants: ["game_session_id", "player_id"], completed_question_set_plays: ["game_session_id"],
};

function quote(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

function normalizeBinding(value: unknown): SqlStorageValue {
  if (value == null || typeof value === "string" || typeof value === "number" || value instanceof ArrayBuffer) return value as SqlStorageValue;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

async function d1Rows(db: D1Database, sql: string, ...bindings: unknown[]) {
  const result = await db.prepare(sql).bind(...bindings).all<Row>();
  return result.results ?? [];
}

export type AuthorityVersion = { epoch: string; stateVersion: number };

export class RoomGameAuthority {
  readonly database: DurableSqlDatabase;
  private processedActionWrites = 0;

  constructor(private readonly storage: DurableObjectStorage, private readonly d1: D1Database) {
    this.database = new DurableSqlDatabase(storage);
  }

  initializeSchema() {
    this.storage.sql.exec(SCHEMA[0]);
    const current = this.storage.sql.exec<Row>("SELECT version FROM authority_schema WHERE id = 1").toArray()[0];
    let currentVersion = Number(current?.version ?? 0);
    if (currentVersion >= AUTHORITY_SCHEMA_VERSION) return;
    if (currentVersion < 5) {
      for (const statement of SCHEMA.slice(1)) this.storage.sql.exec(statement);
      const buzzerColumns = new Set(
        this.storage.sql.exec<{ name: string }>("PRAGMA table_info(buzzer_answers)").toArray().map((column) => column.name),
      );
      if (!buzzerColumns.has("server_received_at")) {
        this.storage.sql.exec("ALTER TABLE buzzer_answers ADD COLUMN server_received_at TEXT");
      }
      this.storage.sql.exec("UPDATE buzzer_answers SET server_received_at=submitted_at WHERE server_received_at IS NULL");
      this.storage.sql.exec("CREATE INDEX IF NOT EXISTS buzzer_answers_fair_order_idx ON buzzer_answers(game_session_id,question_index,reveal_round,submitted_at,server_received_at,id)");
    } else if (currentVersion < 6) {
      this.storage.sql.exec(MUTATION_JOURNAL_VALIDATION_SCHEMA);
    }
    if (currentVersion < 6) {
      this.storage.sql.exec(
        "INSERT INTO authority_schema(id,version) VALUES(1,6) ON CONFLICT(id) DO UPDATE SET version=excluded.version",
      );
      currentVersion = 6;
    }
    if (currentVersion < 7) {
      this.storage.transactionSync(() => {
        for (const statement of AUTHORITY_VNEXT_SCHEMA) this.storage.sql.exec(statement);
        const required = new Map<string, string[]>([
          ["authority_vnext_active_game", ["authority_version", "cutover_state", "state_json"]],
          ["authority_vnext_question_archive", ["game_id", "question_index", "state_json"]],
          ["authority_vnext_projection_outbox", ["payload_json", "attempts"]],
        ]);
        for (const [table, columns] of required) {
          const existing = new Set(this.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((row) => row.name));
          if (columns.some((column) => !existing.has(column))) throw new Error(`authority vNext schema validation failed: ${table}`);
        }
        this.storage.sql.exec("UPDATE authority_schema SET version=7 WHERE id=1 AND version=6");
        const advanced = this.storage.sql.exec<{ version: number }>("SELECT version FROM authority_schema WHERE id=1").one();
        if (advanced.version !== 7) throw new Error("authority vNext schema version did not advance");
      });
      currentVersion = 7;
    }
    if (currentVersion < 8) {
      this.storage.transactionSync(() => {
        const existing = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(question_sets)").toArray().map((row) => row.name),
        );
        if (!existing.has("creation_method")) {
          this.storage.sql.exec(
            "ALTER TABLE question_sets ADD COLUMN creation_method TEXT CHECK (creation_method IS NULL OR creation_method IN ('player_manual','creation_tool_assisted'))",
          );
        }
        const migratedColumns = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(question_sets)").toArray().map((row) => row.name),
        );
        if (!migratedColumns.has("creation_method")) throw new Error("authority schema v8 validation failed: question_sets.creation_method");
        this.storage.sql.exec("UPDATE authority_schema SET version=8 WHERE id=1 AND version=7");
        const advanced = this.storage.sql.exec<{ version: number }>("SELECT version FROM authority_schema WHERE id=1").one();
        if (advanced.version !== 8) throw new Error("authority schema v8 version did not advance");
      });
      currentVersion = 8;
    }
    if (currentVersion < 9) {
      this.storage.transactionSync(() => {
        const existing = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (!existing.has("lobby_team_reveal_vote_seconds")) {
          this.storage.sql.exec(
            "ALTER TABLE rooms ADD COLUMN lobby_team_reveal_vote_seconds INTEGER NOT NULL DEFAULT 15 CHECK (lobby_team_reveal_vote_seconds BETWEEN 1 AND 600)",
          );
        }
        if (!existing.has("lobby_team_guess_vote_seconds")) {
          this.storage.sql.exec(
            "ALTER TABLE rooms ADD COLUMN lobby_team_guess_vote_seconds INTEGER NOT NULL DEFAULT 50 CHECK (lobby_team_guess_vote_seconds BETWEEN 1 AND 600)",
          );
        }
        const migratedColumns = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (
          !migratedColumns.has("lobby_team_reveal_vote_seconds") ||
          !migratedColumns.has("lobby_team_guess_vote_seconds")
        ) {
          throw new Error("authority schema v9 validation failed: rooms.team vote durations");
        }
        this.storage.sql.exec("UPDATE authority_schema SET version=9 WHERE id=1 AND version=8");
        const advanced = this.storage.sql.exec<{ version: number }>("SELECT version FROM authority_schema WHERE id=1").one();
        if (advanced.version !== 9) throw new Error("authority schema v9 version did not advance");
      });
      currentVersion = 9;
    }
    if (currentVersion < 10) {
      this.storage.transactionSync(() => {
        const existing = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (!existing.has("lobby_team_assignment_mode")) {
          this.storage.sql.exec(
            "ALTER TABLE rooms ADD COLUMN lobby_team_assignment_mode TEXT NOT NULL DEFAULT 'AUTO' CHECK (lobby_team_assignment_mode IN ('AUTO','MANUAL'))",
          );
        }
        if (!existing.has("lobby_team_assignments")) {
          this.storage.sql.exec("ALTER TABLE rooms ADD COLUMN lobby_team_assignments TEXT NOT NULL DEFAULT '{}'");
        }
        const migratedColumns = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (!migratedColumns.has("lobby_team_assignment_mode") || !migratedColumns.has("lobby_team_assignments")) {
          throw new Error("authority schema v10 validation failed: rooms.team assignments");
        }
        this.storage.sql.exec("UPDATE authority_schema SET version=10 WHERE id=1 AND version=9");
        const advanced = this.storage.sql.exec<{ version: number }>("SELECT version FROM authority_schema WHERE id=1").one();
        if (advanced.version !== 10) throw new Error("authority schema v10 version did not advance");
      });
      currentVersion = 10;
    }
    if (currentVersion < 11) {
      this.storage.transactionSync(() => {
        const existing = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (!existing.has("lobby_team_presenter_block_enabled")) {
          this.storage.sql.exec(
            "ALTER TABLE rooms ADD COLUMN lobby_team_presenter_block_enabled INTEGER NOT NULL DEFAULT 0 CHECK (lobby_team_presenter_block_enabled IN (0,1))",
          );
        }
        const migratedColumns = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (!migratedColumns.has("lobby_team_presenter_block_enabled")) {
          throw new Error("authority schema v11 validation failed: rooms.presenter block setting");
        }
        this.storage.sql.exec("UPDATE authority_schema SET version=11 WHERE id=1 AND version=10");
        const advanced = this.storage.sql.exec<{ version: number }>("SELECT version FROM authority_schema WHERE id=1").one();
        if (advanced.version !== 11) throw new Error("authority schema v11 version did not advance");
      });
      currentVersion = 11;
    }
    if (currentVersion < 12) {
      this.storage.transactionSync(() => {
        const existing = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (!existing.has("lobby_spectator_question_preview_enabled")) {
          this.storage.sql.exec(
            "ALTER TABLE rooms ADD COLUMN lobby_spectator_question_preview_enabled INTEGER NOT NULL DEFAULT 1 CHECK (lobby_spectator_question_preview_enabled IN (0,1))",
          );
        }
        if (!existing.has("lobby_spectator_player_answers_enabled")) {
          this.storage.sql.exec(
            "ALTER TABLE rooms ADD COLUMN lobby_spectator_player_answers_enabled INTEGER NOT NULL DEFAULT 1 CHECK (lobby_spectator_player_answers_enabled IN (0,1))",
          );
        }
        const migratedColumns = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (
          !migratedColumns.has("lobby_spectator_question_preview_enabled") ||
          !migratedColumns.has("lobby_spectator_player_answers_enabled")
        ) {
          throw new Error("authority schema v12 validation failed: rooms.spectator visibility settings");
        }
        this.storage.sql.exec("UPDATE authority_schema SET version=12 WHERE id=1 AND version=11");
        const advanced = this.storage.sql.exec<{ version: number }>("SELECT version FROM authority_schema WHERE id=1").one();
        if (advanced.version !== 12) throw new Error("authority schema v12 version did not advance");
      });
      currentVersion = 12;
    }

    if (currentVersion < 13) {
      this.storage.transactionSync(() => {
        const existing = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (!existing.has("lobby_player_capacity")) {
          this.storage.sql.exec(
            "ALTER TABLE rooms ADD COLUMN lobby_player_capacity INTEGER NOT NULL DEFAULT 50 CHECK (lobby_player_capacity BETWEEN 1 AND 50)",
          );
        }
        if (!existing.has("lobby_spectator_capacity")) {
          this.storage.sql.exec(
            "ALTER TABLE rooms ADD COLUMN lobby_spectator_capacity INTEGER NOT NULL DEFAULT 50 CHECK (lobby_spectator_capacity BETWEEN 0 AND 50)",
          );
        }
        const migratedColumns = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (!migratedColumns.has("lobby_player_capacity") || !migratedColumns.has("lobby_spectator_capacity")) {
          throw new Error("authority schema v13 validation failed: rooms.role capacities");
        }
        this.storage.sql.exec("UPDATE authority_schema SET version=13 WHERE id=1 AND version=12");
        const advanced = this.storage.sql.exec<{ version: number }>("SELECT version FROM authority_schema WHERE id=1").one();
        if (advanced.version !== 13) throw new Error("authority schema v13 version did not advance");
      });
      currentVersion = 13;
    }

    if (currentVersion < 14) {
      this.storage.transactionSync(() => {
        const roomColumns = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        if (!roomColumns.has("lobby_question_count")) {
          this.storage.sql.exec(
            "ALTER TABLE rooms ADD COLUMN lobby_question_count INTEGER CHECK (lobby_question_count IS NULL OR lobby_question_count BETWEEN 1 AND 30)",
          );
        }
        if (!roomColumns.has("prepared_question_count")) {
          this.storage.sql.exec(
            "ALTER TABLE rooms ADD COLUMN prepared_question_count INTEGER CHECK (prepared_question_count IS NULL OR prepared_question_count BETWEEN 1 AND 30)",
          );
        }
        const gameSessionColumns = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(game_sessions)").toArray().map((row) => row.name),
        );
        if (!gameSessionColumns.has("selected_question_ids")) {
          this.storage.sql.exec(
            "ALTER TABLE game_sessions ADD COLUMN selected_question_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(selected_question_ids) AND json_type(selected_question_ids)='array' AND json_array_length(selected_question_ids) BETWEEN 0 AND 30 AND length(selected_question_ids)<=4096)",
          );
        }
        const migratedRoomColumns = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((row) => row.name),
        );
        const migratedGameSessionColumns = new Set(
          this.storage.sql.exec<{ name: string }>("PRAGMA table_info(game_sessions)").toArray().map((row) => row.name),
        );
        if (
          !migratedRoomColumns.has("lobby_question_count") ||
          !migratedRoomColumns.has("prepared_question_count") ||
          !migratedGameSessionColumns.has("selected_question_ids")
        ) {
          throw new Error("authority schema v14 validation failed: game question sampling");
        }
        this.storage.sql.exec("UPDATE authority_schema SET version=14 WHERE id=1 AND version=13");
        const advanced = this.storage.sql.exec<{ version: number }>("SELECT version FROM authority_schema WHERE id=1").one();
        if (advanced.version !== 14) throw new Error("authority schema v14 version did not advance");
      });
      currentVersion = 14;
    }
  }

  getMeta(roomId: string) {
    return this.storage.sql.exec<Row>("SELECT * FROM authority_meta WHERE room_id = ?", roomId).toArray()[0] ?? null;
  }

  isAuthoritative(roomId: string) {
    return Boolean(this.getMeta(roomId)?.active_game_id);
  }

  async hydrate(roomId: string, force = false) {
    const current = this.getMeta(roomId);
    if (current && !force) return;
    const rooms = await d1Rows(this.d1, "SELECT * FROM rooms WHERE id = ?", roomId);
    const room = rooms[0];
    if (!room) throw new Error("房间不存在或已经解散。");
    const gameId = typeof room.current_game_id === "string" ? room.current_game_id : null;
    const playersPromise = d1Rows(this.d1, "SELECT * FROM players WHERE room_id = ?", roomId);
    const gamesPromise = gameId ? d1Rows(this.d1, "SELECT * FROM game_sessions WHERE id = ?", gameId) : Promise.resolve([]);
    const projectionPromise = gameId ? d1Rows(this.d1, "SELECT payload_json FROM game_runtime_projections WHERE game_session_id = ?", gameId).catch(() => []) : Promise.resolve([]);
    const archivesPromise = gameId ? d1Rows(this.d1, "SELECT payload_json FROM game_question_projections WHERE game_session_id = ? ORDER BY question_index", gameId).catch(() => []) : Promise.resolve([]);
    const [players, games, projections, archives] = await Promise.all([playersPromise, gamesPromise, projectionPromise, archivesPromise]);
    const projectedTables = typeof projections[0]?.payload_json === "string"
      ? (JSON.parse(projections[0].payload_json) as Record<string, Row[]>)
      : null;
    if (projectedTables) {
      for (const archive of archives) {
        if (typeof archive.payload_json !== "string") continue;
        const archiveTables = JSON.parse(archive.payload_json) as Record<string, Row[]>;
        for (const [table, rows] of Object.entries(archiveTables)) projectedTables[table] = [...(projectedTables[table] ?? []), ...rows];
      }
    }
    const game = games[0];
    const setIds = new Set<string>();
    if (typeof room.prepared_question_set_id === "string") setIds.add(room.prepared_question_set_id);
    if (typeof game?.question_set_id === "string") setIds.add(game.question_set_id);
    const questionSets = (await Promise.all([...setIds].map((id) => d1Rows(this.d1, "SELECT * FROM question_sets WHERE id = ?", id)))).flat();
    const questions = (await Promise.all([...setIds].map((id) => d1Rows(this.d1, "SELECT * FROM questions WHERE question_set_id = ? ORDER BY order_index", id)))).flat();
    const perGame = gameId && !projectedTables
      ? await Promise.all([
          d1Rows(this.d1, "SELECT * FROM answers WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM buzzer_answers WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM player_scores WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM question_results WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM question_snapshots WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM question_eligible_players WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM game_participants WHERE game_session_id = ?", gameId),
          d1Rows(this.d1, "SELECT * FROM completed_question_set_plays WHERE game_session_id = ?", gameId),
        ])
      : [[], [], [], [], [], [], [], []];
    if (projectedTables) {
      projectedTables.rooms = rooms;
      if (!gameId) projectedTables.players = players;
      projectedTables.question_sets = questionSets;
      projectedTables.questions = questions;
      projectedTables.game_sessions = games;
    }
    const rowsByTable: Record<string, Row[]> = projectedTables ?? {
      rooms, players, question_sets: questionSets, questions, game_sessions: games,
      answers: perGame[0], buzzer_answers: perGame[1], player_scores: perGame[2], question_results: perGame[3],
      question_snapshots: perGame[4], question_eligible_players: perGame[5], game_participants: perGame[6], completed_question_set_plays: perGame[7],
    };
    return this.storage.transactionSync(() => {
      for (const table of LOCAL_TABLES) this.storage.sql.exec(`DELETE FROM ${quote(table)}`);
      for (const [table, rows] of Object.entries(rowsByTable)) for (const row of rows) this.insertLocal(table, row);
      const epoch = !current ? crypto.randomUUID() : String(current.epoch);
      const stateVersion = Math.max(Number(current?.state_version ?? 0), Date.now() * 1000);
      this.storage.sql.exec(
        "INSERT INTO authority_meta(room_id, hydrated_at, active_game_id, epoch, state_version) VALUES(?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET hydrated_at=excluded.hydrated_at, active_game_id=excluded.active_game_id, epoch=excluded.epoch",
        roomId, new Date().toISOString(), gameId, epoch, stateVersion,
      );
      if (gameId) this.storage.sql.exec("DELETE FROM authority_cleanup WHERE room_id = ?", roomId);
    });
  }

  bumpVersion(roomId: string): AuthorityVersion {
    this.storage.sql.exec("UPDATE authority_meta SET state_version = state_version + 1 WHERE room_id = ?", roomId);
    const meta = this.getMeta(roomId);
    return { epoch: String(meta?.epoch ?? ""), stateVersion: Number(meta?.state_version ?? 0) };
  }

  commitMutation(roomId: string, actionKey: string | null, result: unknown, projectionReason: string | null) {
    return this.storage.transactionSync(() => {
      const version = this.bumpVersion(roomId);
      if (actionKey) this.rememberAction(actionKey, result);
      if (projectionReason) this.enqueueProjection(roomId, projectionReason);
      this.storage.sql.exec("DELETE FROM mutation_journal WHERE id = 1");
      this.storage.sql.exec("DELETE FROM mutation_journal_payload WHERE id = 1");
      this.storage.sql.exec("DELETE FROM mutation_journal_validation WHERE id = 1");
      return version;
    });
  }

  beginMutation(roomId: string, name: string, actionKey: string | null, payload: unknown) {
    this.storage.transactionSync(() => {
      let journalPayload = payload;
      if ((name === "submitAnswer" || name === "submitForfeitAnswer" || name === "cancelForfeitAnswer") && Array.isArray(payload)) {
        const params = payload[0];
        if (params && typeof params === "object" && typeof (params as { gameSessionId?: unknown }).gameSessionId === "string") {
          const session = this.storage.sql.exec<Row>(
            "SELECT current_question_index,current_reveal_round FROM game_sessions WHERE id = ? AND room_id = ?",
            (params as { gameSessionId: string }).gameSessionId,
            roomId,
          ).toArray()[0];
          if (session) {
            const playerId = typeof (params as { playerId?: unknown }).playerId === "string"
              ? (params as { playerId: string }).playerId
              : null;
            const pendingBuzzer = name === "submitForfeitAnswer" && playerId
              ? this.storage.sql.exec<Row>(
                  `SELECT id FROM buzzer_answers
                   WHERE game_session_id = ? AND question_index = ? AND reveal_round = ? AND player_id = ? AND status = 'pending'`,
                  (params as { gameSessionId: string }).gameSessionId,
                  session.current_question_index,
                  session.current_reveal_round,
                  playerId,
                ).toArray()[0]
              : null;
            const forfeitAnswer = name === "cancelForfeitAnswer" && playerId
              ? this.storage.sql.exec<Row>(
                  `SELECT id FROM answers
                   WHERE game_session_id = ? AND question_index = ? AND reveal_round = ? AND player_id = ? AND answer_text = ?`,
                  (params as { gameSessionId: string }).gameSessionId,
                  session.current_question_index,
                  session.current_reveal_round,
                  playerId,
                  FORFEIT_ANSWER_TEXT,
                ).toArray()[0]
              : null;
            journalPayload = [{
              ...params,
              __journalQuestionIndex: Number(session.current_question_index),
              __journalRevealRound: Number(session.current_reveal_round),
              __journalPendingBuzzerId: typeof pendingBuzzer?.id === "string" ? pendingBuzzer.id : null,
              __journalForfeitAnswerId: typeof forfeitAnswer?.id === "string" ? forfeitAnswer.id : null,
            }, ...payload.slice(1)];
          }
        }
      }
      this.storage.sql.exec(
        "INSERT INTO mutation_journal(id,room_id,name,action_key,started_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,name=excluded.name,action_key=excluded.action_key,started_at=excluded.started_at",
        roomId, name, actionKey, Date.now(),
      );
      this.storage.sql.exec("INSERT INTO mutation_journal_payload(id,payload_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json", JSON.stringify(journalPayload ?? null));
      this.storage.sql.exec("DELETE FROM mutation_journal_validation WHERE id = 1");
    });
  }

  markMutationValidated(roomId: string) {
    const journal = this.storage.sql.exec<Row>("SELECT id FROM mutation_journal WHERE id=1 AND room_id=?", roomId).toArray()[0];
    if (!journal) return;
    this.storage.sql.exec(
      "INSERT INTO mutation_journal_validation(id,validated_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET validated_at=excluded.validated_at",
      Date.now(),
    );
  }

  abortMutation(roomId: string) {
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM mutation_journal WHERE id = 1 AND room_id = ?", roomId);
      this.storage.sql.exec("DELETE FROM mutation_journal_payload WHERE id = 1");
      this.storage.sql.exec("DELETE FROM mutation_journal_validation WHERE id = 1");
    });
  }

  recoverIncompleteMutation(roomId: string) {
    const journal = this.storage.sql.exec<Row>("SELECT * FROM mutation_journal WHERE id = 1 AND room_id = ?", roomId).toArray()[0];
    if (!journal) return;
    const payloadRow = this.storage.sql.exec<Row>("SELECT payload_json FROM mutation_journal_payload WHERE id = 1").toArray()[0];
    const actionArgs = typeof payloadRow?.payload_json === "string" ? JSON.parse(payloadRow.payload_json) as unknown[] : [];
    return this.storage.transactionSync(() => {
      // A correct result is the durable scoring fact. Repair denormalized score
      // and buzzer rows if an isolate stopped between gameService statements.
      const name = String(journal.name);
      let questionTransitionRecovered = false;
      let submitAnswerRecovered = false;
      let forfeitAnswerRecovered = false;
      let cancelForfeitRecovered = false;
      let judgeBuzzerAnswerRecovered = false;
      let answerJudgementsRecovered = false;
      const judgeBuzzerParams = (name === "judgeBuzzerAnswer" && Array.isArray(actionArgs) ? actionArgs[0] : null) as {
        gameSessionId?: unknown;
        buzzerAnswerId?: unknown;
        isCorrect?: unknown;
      } | null;
      const teamJudgeParams = (name === "judgeTeamBattleGuess" && Array.isArray(actionArgs) ? actionArgs[0] : null) as {
        gameSessionId?: unknown;
        presenterPlayerId?: unknown;
        isCorrect?: unknown;
      } | null;
      const journalGameSessionId = Array.isArray(actionArgs) && actionArgs[0] && typeof actionArgs[0] === "object" &&
        typeof (actionArgs[0] as { gameSessionId?: unknown }).gameSessionId === "string"
        ? (actionArgs[0] as { gameSessionId: string }).gameSessionId
        : null;
      const answerJudgementWasValidated = Boolean(
        this.storage.sql.exec<Row>("SELECT id FROM mutation_journal_validation WHERE id=1").toArray()[0],
      );
      if ((name === "setAnswerJudgements" || name === "markPendingRoundAnswersWrong") && answerJudgementWasValidated) {
        const params = (Array.isArray(actionArgs) ? actionArgs[0] : null) as {
          gameSessionId?: unknown;
          presenterPlayerId?: unknown;
          expectedQuestionIndex?: unknown;
          expectedRevealRound?: unknown;
          judgements?: Array<{ buzzerAnswerId?: unknown; isCorrect?: unknown }>;
        } | null;
        const gameSessionId = typeof params?.gameSessionId === "string" ? params.gameSessionId : null;
        const presenterPlayerId = typeof params?.presenterPlayerId === "string" ? params.presenterPlayerId : null;
        const questionIndex = typeof params?.expectedQuestionIndex === "number" && Number.isInteger(params.expectedQuestionIndex)
          ? params.expectedQuestionIndex
          : null;
        const revealRound = typeof params?.expectedRevealRound === "number" && Number.isInteger(params.expectedRevealRound)
          ? params.expectedRevealRound
          : null;
        const session = gameSessionId && presenterPlayerId && questionIndex != null && revealRound != null
          ? this.storage.sql.exec<Row>(
              `SELECT * FROM game_sessions WHERE id=? AND room_id=? AND presenter_player_id=? AND status='PLAYING'
               AND current_question_index=? AND current_reveal_round=? AND game_mode!='TEAM_BATTLE'`,
              gameSessionId,
              roomId,
              presenterPlayerId,
              questionIndex,
              revealRound,
            ).toArray()[0]
          : null;
        if (session && gameSessionId && presenterPlayerId && questionIndex != null && revealRound != null) {
          const rawRequested = name === "markPendingRoundAnswersWrong"
            ? this.storage.sql.exec<Row>(
                `SELECT id FROM buzzer_answers WHERE game_session_id=? AND question_index=? AND reveal_round=? AND status='pending'`,
                gameSessionId,
                questionIndex,
                revealRound,
              ).toArray().map((answer) => ({ buzzerAnswerId: answer.id, isCorrect: false }))
            : Array.isArray(params?.judgements) ? params.judgements : [];
          const requestedByAnswerId = new Map<string, { buzzerAnswerId: string; isCorrect: boolean }>();
          for (const judgement of rawRequested.slice(0, 50)) {
            if (typeof judgement?.buzzerAnswerId === "string" && typeof judgement.isCorrect === "boolean") {
              requestedByAnswerId.set(judgement.buzzerAnswerId, {
                buzzerAnswerId: judgement.buzzerAnswerId,
                isCorrect: judgement.isCorrect,
              });
            }
          }
          const requested = [...requestedByAnswerId.values()];
          const roundScores = typeof session.round_scores === "string" ? JSON.parse(session.round_scores) as number[] : [];
          const defaultScore = session.game_mode === "BUZZER_FIRST_CORRECT"
            ? 1
            : Number(roundScores[revealRound - 1] ?? Math.max(1, Number(session.max_reveal_rounds) - revealRound + 1));
          const judgedAt = new Date().toISOString();
          for (const judgement of requested) {
            const answer = this.storage.sql.exec<Row>(
              `SELECT * FROM buzzer_answers WHERE id=? AND game_session_id=? AND question_index=? AND reveal_round=?`,
              judgement.buzzerAnswerId,
              gameSessionId,
              questionIndex,
              revealRound,
            ).toArray()[0];
            if (!answer || typeof answer.player_id !== "string") continue;
            if (judgement.isCorrect) {
              this.storage.sql.exec(
                `INSERT INTO question_results(id,game_session_id,question_index,player_id,scored_round,score_awarded,judged_by_player_id,judged_at)
                 VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(game_session_id,question_index,player_id) DO UPDATE SET
                 scored_round=excluded.scored_round,score_awarded=excluded.score_awarded,
                 judged_by_player_id=excluded.judged_by_player_id,judged_at=excluded.judged_at`,
                `${gameSessionId}:${questionIndex}:${answer.player_id}:recovered`,
                gameSessionId,
                questionIndex,
                answer.player_id,
                revealRound,
                defaultScore,
                presenterPlayerId,
                judgedAt,
              );
              this.storage.sql.exec(
                "UPDATE buzzer_answers SET status='correct',score_awarded=?,judged_at=?,judged_by_player_id=? WHERE id=?",
                defaultScore,
                judgedAt,
                presenterPlayerId,
                answer.id,
              );
            } else {
              this.storage.sql.exec(
                "DELETE FROM question_results WHERE game_session_id=? AND question_index=? AND player_id=? AND scored_round=?",
                gameSessionId,
                questionIndex,
                answer.player_id,
                revealRound,
              );
              this.storage.sql.exec(
                "UPDATE buzzer_answers SET status='wrong',score_awarded=0,judged_at=?,judged_by_player_id=? WHERE id=?",
                judgedAt,
                presenterPlayerId,
                answer.id,
              );
            }
          }
          if (session.game_mode === "BUZZER_RANKED") this.repairRankedBuzzerScores(gameSessionId, questionIndex);
          this.repairPlayerScores(gameSessionId);
          if (session.game_mode === "BUZZER_FIRST_CORRECT" && requested.some((item) => item.isCorrect === true)) {
            this.storage.sql.exec(
              "UPDATE game_sessions SET revealed_blocks=?,round_started_at=NULL WHERE id=?",
              JSON.stringify(Array.from({ length: 45 }, (_, index) => index)),
              gameSessionId,
            );
          }
          answerJudgementsRecovered = true;
        }
      }
      if (name === "joinRoom") {
        const playerId = Array.isArray(actionArgs) && typeof actionArgs[1] === "string" ? actionArgs[1] : null;
        const room = this.storage.sql.exec<Row>("SELECT current_game_id,game_status FROM rooms WHERE id = ?", roomId).toArray()[0];
        const player = playerId
          ? this.storage.sql.exec<Row>("SELECT * FROM players WHERE id = ? AND room_id = ?", playerId, roomId).toArray()[0]
          : null;
        if (room?.game_status === "PLAYING" && typeof room.current_game_id === "string" && player?.role === "PLAYER") {
          const now = new Date().toISOString();
          this.storage.sql.exec(
            `INSERT INTO game_participants(game_session_id,player_id,nickname,role,joined_at,created_at)
             VALUES(?,?,?,?,?,?) ON CONFLICT(game_session_id,player_id) DO UPDATE SET
             nickname=excluded.nickname,role=excluded.role`,
            room.current_game_id,
            player.id,
            player.nickname,
            player.role,
            player.joined_at ?? now,
            now,
          );
        }
      }
      if (name === "advanceReviewedQuestion" || name === "skipCurrentQuestion") {
        const params = (Array.isArray(actionArgs) ? actionArgs[0] : null) as { gameSessionId?: unknown; expectedQuestionIndex?: unknown } | null;
        const gameSessionId = typeof params?.gameSessionId === "string" ? params.gameSessionId : null;
        const expectedQuestionIndex = typeof params?.expectedQuestionIndex === "number" && Number.isInteger(params.expectedQuestionIndex)
          ? params.expectedQuestionIndex
          : null;
        const session = gameSessionId
          ? this.storage.sql.exec<Row>("SELECT * FROM game_sessions WHERE id = ? AND room_id = ?", gameSessionId, roomId).toArray()[0]
          : null;
        if (session && expectedQuestionIndex != null) {
          const currentQuestionIndex = Number(session.current_question_index);
          const nextQuestionIndex = expectedQuestionIndex + 1;
          if (session.status === "PLAYING" && currentQuestionIndex === expectedQuestionIndex) {
            // The eligibility snapshot is written before the session advances. If
            // that sequence stopped halfway, remove the orphan so a retry can
            // recreate one coherent snapshot from the then-current roster.
            this.storage.sql.exec(
              "DELETE FROM question_eligible_players WHERE game_session_id = ? AND question_index = ?",
              gameSessionId,
              nextQuestionIndex,
            );
            this.storage.sql.exec(
              "DELETE FROM question_snapshots WHERE game_session_id = ? AND question_index = ?",
              gameSessionId,
              nextQuestionIndex,
            );
          } else if (session.status === "PLAYING" && currentQuestionIndex === nextQuestionIndex) {
            const existingSnapshot = this.storage.sql.exec<Row>(
              "SELECT eligible_player_ids FROM question_snapshots WHERE game_session_id = ? AND question_index = ?",
              gameSessionId,
              nextQuestionIndex,
            ).toArray()[0];
            let eligiblePlayerIds: string[] = [];
            if (typeof existingSnapshot?.eligible_player_ids === "string") {
              try {
                const parsed = JSON.parse(existingSnapshot.eligible_player_ids);
                if (Array.isArray(parsed)) eligiblePlayerIds = parsed.filter((id): id is string => typeof id === "string");
              } catch {
                eligiblePlayerIds = [];
              }
            }
            if (!existingSnapshot) {
              eligiblePlayerIds = this.storage.sql.exec<Row>(
                "SELECT id FROM players WHERE room_id = ? AND role = 'PLAYER' AND id != ? ORDER BY joined_at,id",
                roomId,
                session.presenter_player_id,
              ).toArray().map((row) => String(row.id));
            }
            const now = new Date().toISOString();
            this.storage.sql.exec(
              `INSERT INTO question_snapshots(game_session_id,question_index,eligible_player_count,eligible_player_ids,created_at)
               VALUES(?,?,?,?,?) ON CONFLICT(game_session_id,question_index) DO UPDATE SET
               eligible_player_count=excluded.eligible_player_count,eligible_player_ids=excluded.eligible_player_ids`,
              gameSessionId,
              nextQuestionIndex,
              eligiblePlayerIds.length,
              JSON.stringify(eligiblePlayerIds),
              now,
            );
            for (const playerId of eligiblePlayerIds) {
              this.storage.sql.exec(
                `INSERT OR IGNORE INTO question_eligible_players(game_session_id,question_index,player_id,created_at)
                 VALUES(?,?,?,?)`,
                gameSessionId,
                nextQuestionIndex,
                playerId,
                now,
              );
            }
            questionTransitionRecovered = true;
          } else if (session.status === "GAME_RESULT" && currentQuestionIndex === expectedQuestionIndex) {
            questionTransitionRecovered = true;
          }
        }
      }
      if (name === "submitForfeitAnswer") {
        const params = (Array.isArray(actionArgs) ? actionArgs[0] : null) as {
          gameSessionId?: unknown;
          playerId?: unknown;
          __journalQuestionIndex?: unknown;
          __journalRevealRound?: unknown;
          __journalPendingBuzzerId?: unknown;
        } | null;
        const gameSessionId = typeof params?.gameSessionId === "string" ? params.gameSessionId : null;
        const playerId = typeof params?.playerId === "string" ? params.playerId : null;
        const expectedQuestionIndex = typeof params?.__journalQuestionIndex === "number" && Number.isInteger(params.__journalQuestionIndex)
          ? params.__journalQuestionIndex
          : null;
        const expectedRevealRound = typeof params?.__journalRevealRound === "number" && Number.isInteger(params.__journalRevealRound)
          ? params.__journalRevealRound
          : null;
        const expectedPendingBuzzerId = typeof params?.__journalPendingBuzzerId === "string"
          ? params.__journalPendingBuzzerId
          : null;
        const session = gameSessionId && playerId && expectedQuestionIndex != null && expectedRevealRound != null
          ? this.storage.sql.exec<Row>(
              `SELECT * FROM game_sessions
               WHERE id = ? AND room_id = ? AND status = 'PLAYING' AND game_mode != 'TEAM_BATTLE'
                 AND current_question_index = ? AND current_reveal_round = ? AND round_started_at IS NOT NULL
                 AND presenter_player_id != ?`,
              gameSessionId,
              roomId,
              expectedQuestionIndex,
              expectedRevealRound,
              playerId,
            ).toArray()[0]
          : null;
        const eligiblePlayer = session
          ? this.storage.sql.exec<Row>(
              `SELECT 1 AS found FROM players
               JOIN question_eligible_players
                 ON question_eligible_players.player_id = players.id
                AND question_eligible_players.game_session_id = ?
                AND question_eligible_players.question_index = ?
               WHERE players.id = ? AND players.room_id = ? AND players.role = 'PLAYER'`,
              gameSessionId,
              expectedQuestionIndex,
              playerId,
              roomId,
            ).toArray()[0]
          : null;
        const judgedResult = eligiblePlayer
          ? this.storage.sql.exec<Row>(
              "SELECT 1 AS found FROM question_results WHERE game_session_id = ? AND question_index = ? AND player_id = ?",
              gameSessionId,
              expectedQuestionIndex,
              playerId,
            ).toArray()[0]
          : null;
        const buzzerAnswer = eligiblePlayer
          ? this.storage.sql.exec<Row>(
              "SELECT status FROM buzzer_answers WHERE game_session_id = ? AND question_index = ? AND reveal_round = ? AND player_id = ?",
              gameSessionId,
              expectedQuestionIndex,
              expectedRevealRound,
              playerId,
            ).toArray()[0]
          : null;
        if (eligiblePlayer && !judgedResult && !buzzerAnswer) {
          const existingAnswer = this.storage.sql.exec<Row>(
            "SELECT id,answer_text FROM answers WHERE game_session_id = ? AND question_index = ? AND reveal_round = ? AND player_id = ?",
            gameSessionId,
            expectedQuestionIndex,
            expectedRevealRound,
            playerId,
          ).toArray()[0];
          const alreadyForfeited = existingAnswer?.answer_text === FORFEIT_ANSWER_TEXT;
          const pendingBuzzerDeleteCommitted = expectedPendingBuzzerId != null;
          if (!alreadyForfeited && pendingBuzzerDeleteCommitted) {
            const submittedAt = new Date().toISOString();
            if (existingAnswer) {
              this.storage.sql.exec(
                "UPDATE answers SET answer_text = ?, submitted_at = ? WHERE id = ?",
                FORFEIT_ANSWER_TEXT,
                submittedAt,
                existingAnswer.id,
              );
            } else {
              this.storage.sql.exec(
                `INSERT INTO answers(id,game_session_id,question_index,reveal_round,player_id,answer_text,submitted_at)
                 VALUES(?,?,?,?,?,?,?)`,
                crypto.randomUUID(),
                gameSessionId,
                expectedQuestionIndex,
                expectedRevealRound,
                playerId,
                FORFEIT_ANSWER_TEXT,
                submittedAt,
              );
            }
          }
          forfeitAnswerRecovered = alreadyForfeited || pendingBuzzerDeleteCommitted;
        }
      }
      if (name === "submitAnswer") {
        const params = (Array.isArray(actionArgs) ? actionArgs[0] : null) as {
          gameSessionId?: unknown;
          playerId?: unknown;
          answerText?: unknown;
          __journalQuestionIndex?: unknown;
          __journalRevealRound?: unknown;
        } | null;
        const gameSessionId = typeof params?.gameSessionId === "string" ? params.gameSessionId : null;
        const playerId = typeof params?.playerId === "string" ? params.playerId : null;
        const answerText = typeof params?.answerText === "string" ? params.answerText.trim() : "";
        const expectedQuestionIndex = typeof params?.__journalQuestionIndex === "number" && Number.isInteger(params.__journalQuestionIndex)
          ? params.__journalQuestionIndex
          : null;
        const expectedRevealRound = typeof params?.__journalRevealRound === "number" && Number.isInteger(params.__journalRevealRound)
          ? params.__journalRevealRound
          : null;
        const session = gameSessionId && playerId && answerText && expectedQuestionIndex != null && expectedRevealRound != null
          ? this.storage.sql.exec<Row>(
              `SELECT 1 AS found FROM game_sessions
               WHERE id = ? AND room_id = ? AND status = 'PLAYING' AND game_mode = 'ROUND_REVEAL'
                 AND current_question_index = ? AND current_reveal_round = ? AND round_started_at IS NOT NULL
                 AND presenter_player_id != ?`,
              gameSessionId,
              roomId,
              expectedQuestionIndex,
              expectedRevealRound,
              playerId,
            ).toArray()[0]
          : null;
        const eligiblePlayer = session
          ? this.storage.sql.exec<Row>(
              `SELECT 1 AS found FROM players
               JOIN question_eligible_players
                 ON question_eligible_players.player_id = players.id
                AND question_eligible_players.game_session_id = ?
                AND question_eligible_players.question_index = ?
               WHERE players.id = ? AND players.room_id = ? AND players.role = 'PLAYER'`,
              gameSessionId,
              expectedQuestionIndex,
              playerId,
              roomId,
            ).toArray()[0]
          : null;
        const judgedResult = eligiblePlayer
          ? this.storage.sql.exec<Row>(
              "SELECT 1 AS found FROM question_results WHERE game_session_id = ? AND question_index = ? AND player_id = ?",
              gameSessionId,
              expectedQuestionIndex,
              playerId,
            ).toArray()[0]
          : null;
        const matchingBuzzer = eligiblePlayer && !judgedResult
          ? this.storage.sql.exec<Row>(
              `SELECT id,submitted_at FROM buzzer_answers
               WHERE game_session_id = ? AND question_index = ? AND reveal_round = ? AND player_id = ?
                 AND status = 'pending' AND answer_text = ?`,
              gameSessionId,
              expectedQuestionIndex,
              expectedRevealRound,
              playerId,
              answerText,
            ).toArray()[0]
          : null;
        if (matchingBuzzer && typeof matchingBuzzer.id === "string" && typeof matchingBuzzer.submitted_at === "string") {
          this.storage.sql.exec(
            `INSERT INTO answers(id,game_session_id,question_index,reveal_round,player_id,answer_text,submitted_at)
             VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(game_session_id,question_index,reveal_round,player_id) DO UPDATE SET
               answer_text=excluded.answer_text,submitted_at=excluded.submitted_at`,
            `${matchingBuzzer.id}:recovered`,
            gameSessionId,
            expectedQuestionIndex,
            expectedRevealRound,
            playerId,
            answerText,
            matchingBuzzer.submitted_at,
          );
          submitAnswerRecovered = true;
        }
      }
      if (name === "cancelForfeitAnswer") {
        const params = (Array.isArray(actionArgs) ? actionArgs[0] : null) as {
          gameSessionId?: unknown;
          playerId?: unknown;
          __journalQuestionIndex?: unknown;
          __journalRevealRound?: unknown;
          __journalForfeitAnswerId?: unknown;
        } | null;
        const gameSessionId = typeof params?.gameSessionId === "string" ? params.gameSessionId : null;
        const playerId = typeof params?.playerId === "string" ? params.playerId : null;
        const expectedQuestionIndex = typeof params?.__journalQuestionIndex === "number" && Number.isInteger(params.__journalQuestionIndex)
          ? params.__journalQuestionIndex
          : null;
        const expectedRevealRound = typeof params?.__journalRevealRound === "number" && Number.isInteger(params.__journalRevealRound)
          ? params.__journalRevealRound
          : null;
        const expectedForfeitAnswerId = typeof params?.__journalForfeitAnswerId === "string"
          ? params.__journalForfeitAnswerId
          : null;
        const session = gameSessionId && playerId && expectedForfeitAnswerId && expectedQuestionIndex != null && expectedRevealRound != null
          ? this.storage.sql.exec<Row>(
              `SELECT 1 AS found FROM game_sessions
               WHERE id = ? AND room_id = ? AND status = 'PLAYING' AND game_mode != 'TEAM_BATTLE'
                 AND current_question_index = ? AND current_reveal_round = ? AND round_started_at IS NOT NULL
                 AND presenter_player_id != ?`,
              gameSessionId,
              roomId,
              expectedQuestionIndex,
              expectedRevealRound,
              playerId,
            ).toArray()[0]
          : null;
        const eligiblePlayer = session
          ? this.storage.sql.exec<Row>(
              `SELECT 1 AS found FROM players
               JOIN question_eligible_players
                 ON question_eligible_players.player_id = players.id
                AND question_eligible_players.game_session_id = ?
                AND question_eligible_players.question_index = ?
               WHERE players.id = ? AND players.room_id = ? AND players.role = 'PLAYER'`,
              gameSessionId,
              expectedQuestionIndex,
              playerId,
              roomId,
            ).toArray()[0]
          : null;
        const currentAnswer = eligiblePlayer
          ? this.storage.sql.exec<Row>(
              "SELECT id FROM answers WHERE game_session_id = ? AND question_index = ? AND reveal_round = ? AND player_id = ?",
              gameSessionId,
              expectedQuestionIndex,
              expectedRevealRound,
              playerId,
            ).toArray()[0]
          : null;
        cancelForfeitRecovered = Boolean(eligiblePlayer && !currentAnswer);
      }
      const correctJudgeTarget =
        judgeBuzzerParams?.isCorrect === true &&
        typeof judgeBuzzerParams.gameSessionId === "string" &&
        typeof judgeBuzzerParams.buzzerAnswerId === "string"
          ? this.storage.sql.exec<Row>(
              `SELECT ba.game_session_id,ba.question_index,ba.player_id,ba.reveal_round,gs.game_mode
               FROM buzzer_answers ba
               JOIN game_sessions gs ON gs.id=ba.game_session_id AND gs.room_id=?
               JOIN question_results qr
                 ON qr.game_session_id=ba.game_session_id AND qr.question_index=ba.question_index
                AND qr.player_id=ba.player_id AND qr.scored_round=ba.reveal_round
               WHERE ba.id = ? AND ba.game_session_id = ?`,
              roomId,
              judgeBuzzerParams.buzzerAnswerId,
              judgeBuzzerParams.gameSessionId,
            ).toArray()[0]
          : null;
      if (correctJudgeTarget?.game_mode === "BUZZER_RANKED") {
        const completeSnapshot = this.storage.sql.exec<Row>(
          `SELECT eligible_player_count FROM question_snapshots
           WHERE game_session_id=? AND question_index=? AND eligible_player_count > 0`,
          correctJudgeTarget.game_session_id,
          correctJudgeTarget.question_index,
        ).toArray()[0];
        if (completeSnapshot) {
          this.repairRankedBuzzerScores(
            String(correctJudgeTarget.game_session_id),
            Number(correctJudgeTarget.question_index),
          );
        }
      }
      if (correctJudgeTarget && typeof judgeBuzzerParams?.buzzerAnswerId === "string") {
        this.storage.sql.exec(`UPDATE buzzer_answers SET
          status='correct',
          score_awarded=(SELECT qr.score_awarded FROM question_results qr
            WHERE qr.game_session_id=buzzer_answers.game_session_id AND qr.question_index=buzzer_answers.question_index
              AND qr.player_id=buzzer_answers.player_id AND qr.scored_round=buzzer_answers.reveal_round),
          judged_at=COALESCE(judged_at,(SELECT qr.judged_at FROM question_results qr
            WHERE qr.game_session_id=buzzer_answers.game_session_id AND qr.question_index=buzzer_answers.question_index
              AND qr.player_id=buzzer_answers.player_id AND qr.scored_round=buzzer_answers.reveal_round)),
          judged_by_player_id=COALESCE(judged_by_player_id,(SELECT qr.judged_by_player_id FROM question_results qr
            WHERE qr.game_session_id=buzzer_answers.game_session_id AND qr.question_index=buzzer_answers.question_index
              AND qr.player_id=buzzer_answers.player_id AND qr.scored_round=buzzer_answers.reveal_round))
          WHERE id=?`, judgeBuzzerParams.buzzerAnswerId);
      }
      const shouldRepairPlayerScores =
        name === "gradeAnswersAndAdvance" ||
        (name === "judgeTeamBattleGuess" && teamJudgeParams?.isCorrect === true) ||
        (name === "judgeBuzzerAnswer" && correctJudgeTarget != null);
      if (journalGameSessionId && shouldRepairPlayerScores) {
        const belongsToRoom = this.storage.sql.exec<Row>(
          "SELECT 1 AS found FROM game_sessions WHERE id=? AND room_id=?",
          journalGameSessionId,
          roomId,
        ).toArray()[0];
        if (belongsToRoom) this.repairPlayerScores(journalGameSessionId);
      }
      if (name === "judgeBuzzerAnswer") {
        const gameSessionId = typeof judgeBuzzerParams?.gameSessionId === "string" ? judgeBuzzerParams.gameSessionId : null;
        const buzzerAnswerId = typeof judgeBuzzerParams?.buzzerAnswerId === "string" ? judgeBuzzerParams.buzzerAnswerId : null;
        const isCorrect = typeof judgeBuzzerParams?.isCorrect === "boolean" ? judgeBuzzerParams.isCorrect : null;
        const buzzer = gameSessionId && buzzerAnswerId && isCorrect != null
          ? this.storage.sql.exec<Row>(
              "SELECT game_session_id,question_index,player_id,status FROM buzzer_answers WHERE id = ? AND game_session_id = ?",
              buzzerAnswerId,
              gameSessionId,
            ).toArray()[0]
          : null;
        if (buzzer?.status === (isCorrect ? "correct" : "wrong")) {
          const result = isCorrect
            ? this.storage.sql.exec<Row>(
                "SELECT 1 AS found FROM question_results WHERE game_session_id = ? AND question_index = ? AND player_id = ?",
                buzzer.game_session_id,
                buzzer.question_index,
                buzzer.player_id,
              ).toArray()[0]
            : { found: 1 };
          judgeBuzzerAnswerRecovered = Boolean(result);
        }
      }
      this.storage.sql.exec(`UPDATE rooms SET game_status='GAME_RESULT', updated_at=? WHERE current_game_id IN (SELECT id FROM game_sessions WHERE status='GAME_RESULT') AND game_status='PLAYING'`, new Date().toISOString());
      this.storage.sql.exec(`INSERT OR IGNORE INTO completed_question_set_plays(game_session_id,question_set_id,completed_at)
        SELECT id,question_set_id,completed_normally_at FROM game_sessions
        WHERE room_id=? AND status='GAME_RESULT' AND completed_normally_at IS NOT NULL`, roomId);
      if (correctJudgeTarget?.game_mode === "BUZZER_FIRST_CORRECT") {
        this.storage.sql.exec(
          "UPDATE game_sessions SET revealed_blocks=?,round_started_at=NULL WHERE id=? AND status='PLAYING'",
          JSON.stringify(Array.from({ length: 45 }, (_, index) => index)),
          correctJudgeTarget.game_session_id,
        );
      }
      const validPlayerIds = new Set(this.storage.sql.exec<Row>("SELECT id FROM players WHERE room_id = ? AND role = 'PLAYER'", roomId).toArray().map((row) => String(row.id)));
      for (const session of this.storage.sql.exec<Row>("SELECT id,team_battle_state FROM game_sessions WHERE room_id = ? AND game_mode = 'TEAM_BATTLE' AND status = 'PLAYING'", roomId).toArray()) {
        if (typeof session.team_battle_state !== "string") continue;
        const state = JSON.parse(session.team_battle_state) as { teams?: { red?: string[]; blue?: string[] }; revealVotes?: Record<string, unknown>; guessVotes?: Record<string, { type?: unknown; answerText?: unknown }>; guessProposals?: Array<{ answerText?: unknown }>; teamMemberNames?: Record<string, string>; activeTeam?: "red" | "blue"; phase?: string; voteDeadlineAt?: string | null; pendingGuess?: unknown };
        if (!state.teams) continue;
        state.teams.red = (state.teams.red ?? []).filter((id) => validPlayerIds.has(id));
        state.teams.blue = (state.teams.blue ?? []).filter((id) => validPlayerIds.has(id));
        for (const votes of [state.revealVotes, state.guessVotes, state.teamMemberNames]) if (votes) for (const id of Object.keys(votes)) if (!validPlayerIds.has(id)) delete votes[id];
        if (state.guessProposals) {
          const activeAnswers = new Set(
            Object.values(state.guessVotes ?? {})
              .filter((vote) => vote.type === "guess" && typeof vote.answerText === "string")
              .map((vote) => (vote.answerText as string).trim()),
          );
          state.guessProposals = state.guessProposals.filter(
            (proposal) => typeof proposal.answerText === "string" && activeAnswers.has(proposal.answerText.trim()),
          );
        }
        if (state.phase !== "TURN_RESULT" && state.activeTeam && (state.teams[state.activeTeam] ?? []).length === 0) {
          state.activeTeam = state.activeTeam === "red" ? "blue" : "red";
          state.voteDeadlineAt = null;
          state.revealVotes = {};
          state.guessVotes = {};
          state.guessProposals = [];
          state.pendingGuess = null;
        }
        if (
          name === "judgeTeamBattleGuess" &&
          teamJudgeParams?.gameSessionId === session.id &&
          teamJudgeParams.isCorrect === true &&
          typeof teamJudgeParams.presenterPlayerId === "string" &&
          (state as { phase?: string }).phase === "JUDGING" &&
          state.pendingGuess &&
          typeof state.pendingGuess === "object"
        ) {
          const pending = state.pendingGuess as { team?: "red" | "blue"; answerText?: string; proposerPlayerId?: string; proposerName?: string };
          const winningTeam = pending.team;
          const winningMembers = winningTeam ? (state.teams[winningTeam] ?? []) : [];
          const resultCount = winningMembers.length > 0
            ? Number(this.storage.sql.exec<Row>(
                `SELECT COUNT(*) AS count FROM question_results
                 WHERE game_session_id = ?
                   AND question_index = (SELECT current_question_index FROM game_sessions WHERE id = ?)
                   AND scored_round = (SELECT current_reveal_round FROM game_sessions WHERE id = ?)
                   AND judged_by_player_id = ?
                   AND player_id IN (${winningMembers.map(() => "?").join(",")})`,
                session.id,
                session.id,
                session.id,
                teamJudgeParams.presenterPlayerId,
                ...winningMembers,
              ).toArray()[0]?.count ?? 0)
            : 0;
          if (winningTeam && resultCount === winningMembers.length) {
            const mutable = state as typeof state & { phase?: string; teamScores?: Record<"red" | "blue", number>; message?: string; revealVotes?: Record<string, unknown>; guessVotes?: Record<string, unknown>; correctGuess?: typeof pending };
            mutable.phase = "REVIEW";
            mutable.correctGuess = { ...pending };
            mutable.teamScores = { red: mutable.teamScores?.red ?? 0, blue: mutable.teamScores?.blue ?? 0 };
            mutable.teamScores[winningTeam] += 1;
            mutable.voteDeadlineAt = null;
            mutable.revealVotes = {};
            mutable.guessVotes = {};
            mutable.pendingGuess = null;
            this.storage.sql.exec("UPDATE game_sessions SET revealed_blocks = ?, round_started_at = NULL WHERE id = ?", JSON.stringify(Array.from({ length: 45 }, (_, index) => index)), session.id);
          }
        }
        this.storage.sql.exec("UPDATE game_sessions SET team_battle_state = ? WHERE id = ?", JSON.stringify(state), session.id);
      }
      const roomState = this.storage.sql.exec<Row>("SELECT * FROM rooms WHERE id = ?", roomId).toArray()[0];
      const remainingPlayers = this.storage.sql.exec<Row>("SELECT * FROM players WHERE room_id = ? ORDER BY joined_at,id", roomId).toArray();
      if (roomState && !remainingPlayers.some((player) => player.id === roomState.host_player_id)) {
        const nextHost = remainingPlayers[0];
        if (!nextHost) this.storage.sql.exec("DELETE FROM rooms WHERE id = ?", roomId);
        else {
          this.storage.sql.exec("UPDATE players SET is_host = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE room_id = ?", nextHost.id, roomId);
          this.storage.sql.exec("UPDATE rooms SET host_player_id = ? WHERE id = ?", nextHost.id, roomId);
        }
      }
      if (roomState?.game_status === "QUESTION_SETUP" && !remainingPlayers.some((player) => player.id === roomState.current_presenter_player_id)) {
        this.storage.sql.exec("UPDATE rooms SET game_status='LOBBY',current_presenter_player_id=NULL,current_game_id=NULL,prepared_question_set_id=NULL,prepared_question_count=NULL,lobby_question_count=NULL WHERE id = ?", roomId);
      }
      const room = this.storage.sql.exec<Row>("SELECT game_status FROM rooms WHERE id = ?", roomId).toArray()[0];
      const handoffApplied = name === "dissolveRoom" ? !room : ["returnRoomToLobby", "cancelCurrentRound"].includes(name) && room?.game_status === "LOBBY";
      const version = this.bumpVersion(roomId);
      const canReturnRecoveredReceipt = handoffApplied || questionTransitionRecovered || submitAnswerRecovered || forfeitAnswerRecovered ||
        cancelForfeitRecovered || judgeBuzzerAnswerRecovered || answerJudgementsRecovered;
      if (canReturnRecoveredReceipt && typeof journal.action_key === "string" && journal.action_key) {
        this.rememberAction(journal.action_key, { __authorityRecovered: true });
      }
      const shouldProjectRecoveredState = [
        "revealTeamBattleAnswer", "gradeAnswersAndAdvance", "advanceReviewedQuestion", "updateQuestionLabel",
        "skipCurrentQuestion", "endCurrentGameEarly", "joinRoom", "leaveRoom", "kickPlayerFromRoom", "updatePlayerRole",
      ].includes(name) || handoffApplied;
      if (shouldProjectRecoveredState) {
        this.enqueueProjection(roomId, name);
      }
      this.storage.sql.exec("DELETE FROM mutation_journal WHERE id = 1");
      this.storage.sql.exec("DELETE FROM mutation_journal_payload WHERE id = 1");
      this.storage.sql.exec("DELETE FROM mutation_journal_validation WHERE id = 1");
      return version;
    });
  }

  releaseGame(roomId: string) {
    this.storage.sql.exec("UPDATE authority_meta SET active_game_id = NULL WHERE room_id = ?", roomId);
    this.storage.sql.exec("INSERT INTO authority_cleanup(room_id,run_at) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET run_at=excluded.run_at", roomId, Date.now() + 60 * 60 * 1000);
  }

  purgeRoom(roomId: string) {
    this.storage.transactionSync(() => {
      for (const table of LOCAL_TABLES) this.storage.sql.exec(`DELETE FROM ${quote(table)}`);
      this.storage.sql.exec("DELETE FROM processed_actions");
      this.storage.sql.exec("DELETE FROM projection_outbox");
      this.storage.sql.exec("DELETE FROM authority_meta WHERE room_id = ?", roomId);
      this.storage.sql.exec("DELETE FROM authority_cleanup WHERE room_id = ?", roomId);
      this.storage.sql.exec("DELETE FROM projected_question_labels");
      this.storage.sql.exec("DELETE FROM projected_question_archives");
      this.storage.sql.exec("DELETE FROM mutation_journal");
      this.storage.sql.exec("DELETE FROM mutation_journal_payload");
      this.storage.sql.exec("DELETE FROM mutation_journal_validation");
    });
  }

  getProcessedAction(actionKey: string) {
    const row = this.storage.sql.exec<Row>("SELECT result_json FROM processed_actions WHERE action_key = ?", actionKey).toArray()[0];
    return typeof row?.result_json === "string" ? JSON.parse(row.result_json) : null;
  }

  rememberAction(actionKey: string, result: unknown) {
    this.storage.sql.exec(
      "INSERT INTO processed_actions(action_key,result_json,created_at) VALUES(?,?,?) ON CONFLICT(action_key) DO UPDATE SET result_json=excluded.result_json, created_at=excluded.created_at",
      actionKey, JSON.stringify(result), Date.now(),
    );
    this.processedActionWrites += 1;
    if (this.processedActionWrites % 32 === 0) {
      this.storage.sql.exec("DELETE FROM processed_actions WHERE action_key IN (SELECT action_key FROM processed_actions ORDER BY created_at DESC LIMIT -1 OFFSET 256)");
    }
  }

  enqueueProjection(roomId: string, reason: string) {
    const meta = this.getMeta(roomId);
    const gameId = String(meta?.active_game_id ?? "");
    if (!gameId) return;
    const existing = this.storage.sql.exec<Row>("SELECT payload_json FROM projection_outbox LIMIT 1").toArray()[0];
    let syncPlayers = ["joinRoom", "leaveRoom", "kickPlayerFromRoom", "updatePlayerRole"].includes(reason);
    let existingArchives: Record<string, Record<string, Row[]>> = {};
    if (typeof existing?.payload_json === "string") {
      const existingPayload = JSON.parse(existing.payload_json) as {
        reason?: string;
        syncPlayers?: boolean;
        archives?: Record<string, Record<string, Row[]>>;
      };
      if (["returnRoomToLobby", "cancelCurrentRound", "dissolveRoom"].includes(existingPayload.reason ?? "")) return;
      syncPlayers ||= existingPayload.syncPlayers === true;
      existingArchives = existingPayload.archives ?? {};
    }
    const questionScopedTables = ["answers", "buzzer_answers", "question_results", "question_snapshots", "question_eligible_players"];
    const payload: Record<string, Row[]> = {};
    for (const table of PROJECT_TABLES) {
      if (!questionScopedTables.includes(table)) payload[table] = this.storage.sql.exec<Row>(`SELECT * FROM ${quote(table)}`).toArray();
    }
    const currentQuestionIndex = Number(payload.game_sessions?.[0]?.current_question_index ?? 0);
    const capturedArchiveIndexes = new Set([
      ...this.storage.sql.exec<Row>(
        "SELECT question_index FROM projected_question_archives WHERE game_session_id = ?",
        gameId,
      ).toArray().map((row) => Number(row.question_index)),
      ...Object.keys(existingArchives).map(Number),
    ]);
    const archiveIndexes = Array.from({ length: currentQuestionIndex }, (_, index) => index)
      .filter((questionIndex) => !capturedArchiveIndexes.has(questionIndex));
    const archives: Record<string, Record<string, Row[]>> = { ...existingArchives };
    for (const questionIndex of archiveIndexes) {
      archives[String(questionIndex)] = Object.fromEntries(questionScopedTables.map((table) => [table, []]));
    }
    for (const table of questionScopedTables) {
      payload[table] = this.storage.sql.exec<Row>(
        `SELECT * FROM ${quote(table)} WHERE game_session_id = ? AND question_index = ?`,
        gameId,
        currentQuestionIndex,
      ).toArray();
      for (let start = 0; start < archiveIndexes.length; start += 80) {
        const chunk = archiveIndexes.slice(start, start + 80);
        const rows = this.storage.sql.exec<Row>(
          `SELECT * FROM ${quote(table)} WHERE game_session_id = ? AND question_index IN (${chunk.map(() => "?").join(",")})`,
          gameId,
          ...chunk,
        ).toArray();
        for (const row of rows) {
          const archive = archives[String(Number(row.question_index))];
          if (archive) archive[table].push(row);
        }
      }
    }
    const projectedLabels = new Map(
      this.storage.sql.exec<Row>("SELECT question_id,label_updated_at FROM projected_question_labels").toArray()
        .map((row) => [String(row.question_id), row.label_updated_at]),
    );
    const dirtyQuestionIds = (payload.questions ?? []).filter((question) => {
      if (typeof question.label_updated_at !== "string") return false;
      return projectedLabels.get(String(question.id)) !== question.label_updated_at;
    }).map((question) => String(question.id));
    const version = Number(meta?.state_version ?? 0);
    const projectionId = `${gameId}:${version}`;
    // Every projection is a complete recovery image; a newer pending image
    // supersedes older pending work and keeps the outbox bounded to one row.
    this.storage.sql.exec("DELETE FROM projection_outbox");
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO projection_outbox(projection_id,game_session_id,version,payload_json,attempts,next_attempt_at) VALUES(?,?,?,?,0,?)",
      projectionId, gameId, version, JSON.stringify({ roomId, gameId, reason, version, syncPlayers, dirtyQuestionIds, archives, tables: payload }), Date.now(),
    );
  }

  hasPendingProjection() {
    return this.storage.sql.exec<Row>("SELECT projection_id FROM projection_outbox LIMIT 1").toArray().length > 0;
  }

  hasPendingHandoff() {
    const row = this.storage.sql.exec<Row>("SELECT payload_json FROM projection_outbox LIMIT 1").toArray()[0];
    if (typeof row?.payload_json !== "string") return false;
    const reason = (JSON.parse(row.payload_json) as { reason?: string }).reason ?? "";
    return ["returnRoomToLobby", "cancelCurrentRound", "dissolveRoom"].includes(reason);
  }

  async flushProjections(limit = 4) {
    const head = this.storage.sql.exec<Row>("SELECT * FROM projection_outbox ORDER BY version ASC LIMIT 1").toArray()[0];
    const pending = head && Number(head.next_attempt_at) <= Date.now() ? [head] : [];
    for (const item of pending) {
      try {
        const payload = JSON.parse(String(item.payload_json)) as { roomId: string; gameId: string; reason: string; version: number; syncPlayers: boolean; dirtyQuestionIds: string[]; archives: Record<string, Record<string, Row[]>>; tables: Record<string, Row[]> };
        await this.projectPayload(payload);
        if (payload.reason === "dissolveRoom" || !payload.tables.rooms?.[0]) {
          this.purgeRoom(payload.roomId);
        } else {
          this.storage.transactionSync(() => {
            this.storage.sql.exec("DELETE FROM projection_outbox WHERE projection_id = ?", item.projection_id);
            if (["returnRoomToLobby", "cancelCurrentRound"].includes(payload.reason)) this.releaseGame(payload.roomId);
            for (const questionId of payload.dirtyQuestionIds ?? []) {
              const question = payload.tables.questions?.find((row) => row.id === questionId);
              this.storage.sql.exec("INSERT INTO projected_question_labels(question_id,label_updated_at) VALUES(?,?) ON CONFLICT(question_id) DO UPDATE SET label_updated_at=excluded.label_updated_at", questionId, question?.label_updated_at ?? null);
            }
            for (const questionIndex of Object.keys(payload.archives ?? {})) {
              this.storage.sql.exec("INSERT INTO projected_question_archives(game_session_id,question_index,projection_version) VALUES(?,?,?) ON CONFLICT(game_session_id,question_index) DO UPDATE SET projection_version=excluded.projection_version", payload.gameId, Number(questionIndex), payload.version);
            }
          });
        }
      } catch (error) {
        const attempts = Number(item.attempts ?? 0) + 1;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
        this.storage.sql.exec(
          "UPDATE projection_outbox SET attempts = ?, next_attempt_at = ? WHERE projection_id = ?",
          attempts, Date.now() + delay, item.projection_id,
        );
        throw error;
      }
    }
  }

  getNextProjectionAt() {
    const row = this.storage.sql.exec<Row>("SELECT MIN(next_attempt_at) AS next_at FROM projection_outbox").toArray()[0];
    return typeof row?.next_at === "number" ? row.next_at : null;
  }

  getNextCleanupAt() {
    const row = this.storage.sql.exec<Row>("SELECT MIN(run_at) AS run_at FROM authority_cleanup").toArray()[0];
    return typeof row?.run_at === "number" ? row.run_at : null;
  }

  cleanupIfDue(now = Date.now()) {
    const row = this.storage.sql.exec<Row>("SELECT room_id,run_at FROM authority_cleanup ORDER BY run_at LIMIT 1").toArray()[0];
    if (!row || Number(row.run_at) > now || this.hasPendingProjection()) return;
    const roomId = String(row.room_id);
    if (this.isAuthoritative(roomId)) {
      this.storage.sql.exec("DELETE FROM authority_cleanup WHERE room_id = ?", roomId);
      return;
    }
    this.purgeRoom(roomId);
  }

  async loadGameProjection(gameSessionId: string) {
    if (this.storage.sql.exec<Row>("SELECT id FROM game_sessions WHERE id = ?", gameSessionId).toArray()[0]) return;
    const activeGameId = this.storage.sql.exec<Row>("SELECT active_game_id FROM authority_meta LIMIT 1").toArray()[0]?.active_game_id;
    if (typeof activeGameId === "string" && activeGameId && activeGameId !== gameSessionId) {
      throw new Error("当前房间正在进行新游戏，旧局详情请在本局结束后查看。");
    }
    const [rows, archives] = await Promise.all([
      d1Rows(this.d1, "SELECT payload_json FROM game_runtime_projections WHERE game_session_id = ?", gameSessionId),
      d1Rows(this.d1, "SELECT payload_json FROM game_question_projections WHERE game_session_id = ? ORDER BY question_index", gameSessionId),
    ]);
    let tables: Record<string, Row[]>;
    if (typeof rows[0]?.payload_json === "string") {
      tables = JSON.parse(rows[0].payload_json) as Record<string, Row[]>;
      for (const archive of archives) {
        if (typeof archive.payload_json !== "string") continue;
        const archiveTables = JSON.parse(archive.payload_json) as Record<string, Row[]>;
        for (const [table, tableRows] of Object.entries(archiveTables)) tables[table] = [...(tables[table] ?? []), ...tableRows];
      }
    } else {
      const games = await d1Rows(this.d1, "SELECT * FROM game_sessions WHERE id = ?", gameSessionId);
      const game = games[0];
      if (!game || typeof game.room_id !== "string" || typeof game.question_set_id !== "string") return;
      const [rooms, players, questionSets, questions, perGame] = await Promise.all([
        d1Rows(this.d1, "SELECT * FROM rooms WHERE id = ?", game.room_id),
        d1Rows(this.d1, "SELECT * FROM players WHERE room_id = ?", game.room_id),
        d1Rows(this.d1, "SELECT * FROM question_sets WHERE id = ?", game.question_set_id),
        d1Rows(this.d1, "SELECT * FROM questions WHERE question_set_id = ? ORDER BY order_index", game.question_set_id),
        Promise.all([
          d1Rows(this.d1, "SELECT * FROM answers WHERE game_session_id = ?", gameSessionId),
          d1Rows(this.d1, "SELECT * FROM buzzer_answers WHERE game_session_id = ?", gameSessionId),
          d1Rows(this.d1, "SELECT * FROM player_scores WHERE game_session_id = ?", gameSessionId),
          d1Rows(this.d1, "SELECT * FROM question_results WHERE game_session_id = ?", gameSessionId),
          d1Rows(this.d1, "SELECT * FROM question_snapshots WHERE game_session_id = ?", gameSessionId),
          d1Rows(this.d1, "SELECT * FROM question_eligible_players WHERE game_session_id = ?", gameSessionId),
          d1Rows(this.d1, "SELECT * FROM game_participants WHERE game_session_id = ?", gameSessionId),
          d1Rows(this.d1, "SELECT * FROM completed_question_set_plays WHERE game_session_id = ?", gameSessionId),
        ]),
      ]);
      tables = {
        rooms,
        players,
        question_sets: questionSets,
        questions,
        game_sessions: games,
        answers: perGame[0],
        buzzer_answers: perGame[1],
        player_scores: perGame[2],
        question_results: perGame[3],
        question_snapshots: perGame[4],
        question_eligible_players: perGame[5],
        game_participants: perGame[6],
        completed_question_set_plays: perGame[7],
      };
    }
    this.storage.transactionSync(() => {
      for (const table of LOCAL_TABLES) this.storage.sql.exec(`DELETE FROM ${quote(table)}`);
      for (const [table, tableRows] of Object.entries(tables)) {
        if (!(LOCAL_TABLES as readonly string[]).includes(table)) continue;
        for (const row of tableRows) this.insertLocal(table, row);
      }
    });
  }

  private async projectPayload(payload: { roomId: string; gameId: string; reason: string; version: number; syncPlayers: boolean; dirtyQuestionIds: string[]; archives: Record<string, Record<string, Row[]>>; tables: Record<string, Row[]> }) {
    const statements: D1PreparedStatement[] = [];
    const appendUpserts = (statements: D1PreparedStatement[], table: string, rows: Row[], conflicts: string[]) => {
      if (!rows.length) return;
      const groups = new Map<string, Row[]>();
      for (const row of rows) {
        const key = Object.keys(row).join("\u0000");
        const group = groups.get(key);
        if (group) group.push(row);
        else groups.set(key, [row]);
      }
      for (const group of groups.values()) {
        const columns = Object.keys(group[0]);
        const updates = columns.filter((column) => !conflicts.includes(column));
        const conflictSql = updates.length ? `DO UPDATE SET ${updates.map((column) => `${quote(column)}=excluded.${quote(column)}`).join(",")}` : "DO NOTHING";
        const rowsPerStatement = Math.max(1, Math.floor(90 / columns.length));
        for (let start = 0; start < group.length; start += rowsPerStatement) {
          const chunk = group.slice(start, start + rowsPerStatement);
          const placeholders = chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
          statements.push(this.d1.prepare(
            `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES ${placeholders} ON CONFLICT (${conflicts.map(quote).join(",")}) ${conflictSql}`,
          ).bind(...chunk.flatMap((row) => columns.map((column) => row[column] as D1_TYPE))));
        }
      }
    };
    if (!payload.tables.rooms?.[0]) {
      await this.d1.batch([
        this.d1.prepare("DELETE FROM rooms WHERE id = ?").bind(payload.roomId),
        this.d1.prepare("DELETE FROM game_runtime_projections WHERE game_session_id = ?").bind(payload.gameId),
        this.d1.prepare("DELETE FROM game_question_projections WHERE game_session_id = ?").bind(payload.gameId),
      ]);
      return;
    }
    const compactPayload = JSON.stringify(payload.tables);
    statements.push(this.d1.prepare(
      `INSERT INTO game_runtime_projections(game_session_id,room_id,projection_version,payload_json,updated_at)
       VALUES(?,?,?,?,?) ON CONFLICT(game_session_id) DO UPDATE SET
       room_id=excluded.room_id, projection_version=excluded.projection_version,
       payload_json=excluded.payload_json, updated_at=excluded.updated_at
       WHERE excluded.projection_version >= game_runtime_projections.projection_version`,
    ).bind(payload.gameId, payload.roomId, payload.version, compactPayload, new Date().toISOString()));
    appendUpserts(statements, "game_question_projections", Object.entries(payload.archives ?? {}).map(([questionIndex, archive]) => ({
      game_session_id: payload.gameId,
      question_index: Number(questionIndex),
      projection_version: payload.version,
      payload_json: JSON.stringify(archive),
      updated_at: new Date().toISOString(),
    })), ["game_session_id", "question_index"]);

    const room = payload.tables.rooms?.[0];
    const game = payload.tables.game_sessions?.find((row) => row.id === payload.gameId);
    const completed = payload.tables.completed_question_set_plays ?? [];
    const coreTables: Array<[string, Row[]]> = [["rooms", room ? [room] : []], ["game_sessions", game ? [game] : []], ["completed_question_set_plays", completed]];
    if (room?.game_status !== "PLAYING" || payload.syncPlayers) {
      statements.push(this.d1.prepare("DELETE FROM players WHERE room_id = ?").bind(payload.roomId));
      coreTables.push(["players", payload.tables.players ?? []]);
    }
    if ((payload.dirtyQuestionIds ?? []).length > 0) {
      const dirtyIds = new Set(payload.dirtyQuestionIds);
      const changed = (payload.tables.questions ?? []).filter((row) => dirtyIds.has(String(row.id)));
      coreTables.push(["questions", changed]);
    }
    for (const [table, rows] of coreTables) {
      const conflicts = CONFLICT_COLUMNS[table];
      if (conflicts) appendUpserts(statements, table, rows, conflicts);
    }
    // Keep the runtime image and its per-question archives atomic. Supported
    // question sets are capped at 30, which keeps this below D1's 50-query
    // Free-plan invocation limit even after rows are chunked for bind limits.
    if (statements.length) await this.d1.batch(statements);
  }

  private repairRankedBuzzerScores(gameSessionId: string, questionIndex: number) {
    const rows = this.storage.sql.exec<Row>(`
      SELECT
        qr.id AS result_id,
        qr.game_session_id,
        qr.question_index,
        qr.scored_round,
        qr.judged_at,
        ba.id AS buzzer_id,
        ba.submitted_at,
        COALESCE(ba.server_received_at, ba.submitted_at) AS server_received_at,
        qs.eligible_player_count AS eligible_count
      FROM question_results qr
      JOIN game_sessions gs ON gs.id=qr.game_session_id AND gs.game_mode='BUZZER_RANKED'
      JOIN question_snapshots qs ON qs.game_session_id=qr.game_session_id AND qs.question_index=qr.question_index
      JOIN buzzer_answers ba
        ON ba.game_session_id=qr.game_session_id
       AND ba.question_index=qr.question_index
       AND ba.player_id=qr.player_id
       AND ba.reveal_round=qr.scored_round
      WHERE qr.game_session_id = ? AND qr.question_index = ?
    `, gameSessionId, questionIndex).toArray();
    const compareTextTime = (left: unknown, right: unknown) => {
      const leftText = String(left ?? "");
      const rightText = String(right ?? "");
      const timestampDiff = new Date(leftText).getTime() - new Date(rightText).getTime();
      return Number.isFinite(timestampDiff) && timestampDiff !== 0 ? timestampDiff : leftText.localeCompare(rightText);
    };
    rows.sort((left, right) =>
      compareTextTime(left.server_received_at, right.server_received_at) ||
      compareTextTime(left.submitted_at, right.submitted_at) ||
      Number(left.scored_round) - Number(right.scored_round) ||
      String(left.buzzer_id).localeCompare(String(right.buzzer_id)) ||
      compareTextTime(left.judged_at, right.judged_at) ||
      String(left.result_id).localeCompare(String(right.result_id)),
    );
    const eligibleCount = Number(rows[0]?.eligible_count ?? 0);
    for (const [index, row] of rows.entries()) {
      const scoreAwarded = Math.max(1, eligibleCount - index);
      this.storage.sql.exec(
        "UPDATE question_results SET score_awarded = ? WHERE id = ? AND score_awarded != ?",
        scoreAwarded,
        row.result_id,
        scoreAwarded,
      );
      this.storage.sql.exec(
        "UPDATE buzzer_answers SET status = 'correct', score_awarded = ? WHERE id = ? AND (status != 'correct' OR score_awarded != ?)",
        scoreAwarded,
        row.buzzer_id,
        scoreAwarded,
      );
    }
  }

  private repairPlayerScores(gameSessionId: string) {
    this.storage.sql.exec(
      "UPDATE player_scores SET score=0,correct_count=0 WHERE game_session_id=?",
      gameSessionId,
    );
    this.storage.sql.exec(`INSERT INTO player_scores(id,game_session_id,player_id,score,correct_count)
      SELECT question_results.game_session_id || ':' || question_results.player_id || ':recovered', question_results.game_session_id,
             question_results.player_id, SUM(question_results.score_awarded), COUNT(*)
      FROM question_results WHERE question_results.game_session_id=?
      GROUP BY question_results.game_session_id,question_results.player_id
      ON CONFLICT(game_session_id,player_id) DO UPDATE SET score=excluded.score,correct_count=excluded.correct_count`, gameSessionId);
  }

  private insertLocal(table: string, row: Row) {
    const normalizedRow =
      table === "buzzer_answers" && typeof row.server_received_at !== "string"
        ? { ...row, server_received_at: row.submitted_at }
        : row;
    const columns = Object.keys(normalizedRow);
    if (!columns.length) return;
    this.storage.sql.exec(
      `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      ...columns.map((column) => normalizeBinding(normalizedRow[column])),
    );
  }
}
