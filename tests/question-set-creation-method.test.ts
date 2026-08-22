import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GameDatabase, GamePreparedStatement } from "../worker/d1QueryCompat";
import { CURRENT_ROOM_RUNTIME_GENERATION } from "../src/lib/roomRuntime";
import type { DbPlayer } from "../src/types/game";
import { decodeQuestionSetManifest, encodeQuestionSetManifest } from "../worker/questionSetManifest";
import { decodeRoomState, encodeRoomState } from "../worker/roomStateManifest";
import {
  createRoom,
  cancelPresenterSetup,
  createUploadedQuestionSet,
  createQuestionSetFromUrlText,
  getCommunityQuestionSetDetail,
  getCommunityQuestionSets,
  getGameBootstrapSnapshot,
  getGameResultSnapshot,
  getRoomWithPlayers,
  getQuestionSetById,
  joinRoom,
  publishQuestionSetToCommunity,
  prepareQuestionSetForStart,
  returnRoomToLobby,
  runWithGameDatabase,
  selectPresenterForRound,
  selectQuestionsForGame,
  StartGameRejectedError,
  startGameWithQuestionSet,
  selectTeamForPlayer,
  updatePlayerRole,
  updateRoomGameSettings,
  updateRoomNotice,
} from "../worker/gameService";
import type { QuestionImportItem } from "../worker/gameService";
import { getRoomNoticeUpdatedDelta } from "../worker/roomNotice";

const root = resolve(import.meta.dirname, "..");
const migrationsDirectory = join(root, "d1", "migrations");

class PreparedStatementAdapter implements GamePreparedStatement {
  private bindings: unknown[] = [];

  constructor(private readonly statement: ReturnType<DatabaseSync["prepare"]>) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async all<T>() {
    return { results: this.statement.all(...this.bindings) as T[] };
  }

  async first<T>() {
    return (this.statement.get(...this.bindings) as T | undefined) ?? null;
  }
}

class DatabaseAdapter implements GameDatabase {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(query: string) {
    return new PreparedStatementAdapter(this.sqlite.prepare(query));
  }

  async batch<T>(statements: GamePreparedStatement[]) {
    const results: Array<{ results?: T[] }> = [];
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) results.push(await statement.all<T>());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function migrationFiles() {
  return readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

function applyMigrations(db: DatabaseSync, through = "9999") {
  for (const name of migrationFiles()) {
    if (name.slice(0, 4) > through) break;
    db.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
}

function upgradeRoomFixtureToAggregate(db: DatabaseSync, roomId: string) {
  const room = db.prepare("SELECT id,host_player_id FROM rooms WHERE id=?").get(roomId) as {
    id: string;
    host_player_id: string;
  };
  const players = db.prepare("SELECT * FROM players WHERE room_id=? ORDER BY joined_at,id").all(roomId) as DbPlayer[];
  const stateJson = encodeRoomState(room.id, room.host_player_id, players);
  db.prepare(`UPDATE rooms
    SET runtime_generation=?,room_state_version=1,room_state_revision=0,room_state_json=?
    WHERE id=?`).run(CURRENT_ROOM_RUNTIME_GENERATION, stateJson, roomId);
  db.prepare("DELETE FROM players WHERE room_id=?").run(roomId);
}

test("question-set manifest codec rejects corruption instead of silently falling back", () => {
  const encoded = encodeQuestionSetManifest([{
    id: "manifest-q1",
    questionSetId: "manifest-set",
    imageUrl: "https://example.com/manifest.webp",
    orderIndex: 0,
    labelText: null,
    createdAt: "2026-07-31T00:00:00.000Z",
  }]);
  assert.deepEqual(
    decodeQuestionSetManifest({ id: "manifest-set", manifest_version: 1, manifest_json: encoded })?.map((question) => question.question_set_id),
    ["manifest-set"],
  );
  assert.equal(decodeQuestionSetManifest({ id: "legacy-set", manifest_version: null, manifest_json: null }), null);
  assert.throws(
    () => decodeQuestionSetManifest({ id: "broken-set", manifest_version: 1, manifest_json: "{" }),
    /manifest JSON 已损坏/,
  );
  assert.throws(
    () => decodeQuestionSetManifest({ id: "future-set", manifest_version: 2, manifest_json: encoded }),
    /不支持的 manifest 版本/,
  );
  const duplicateManifest = JSON.parse(encoded) as { schema: 1; questions: Array<Record<string, unknown>> };
  duplicateManifest.questions.push({ ...duplicateManifest.questions[0], order_index: 1 });
  assert.throws(
    () => decodeQuestionSetManifest({
      id: "duplicate-set",
      manifest_version: 1,
      manifest_json: JSON.stringify(duplicateManifest),
    }),
    /重复题目 ID/,
  );
});

test("D1 0017 adds manifest storage and targeted partial indexes without rewriting legacy sets", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0016");
  db.prepare("INSERT INTO question_sets(id,title,created_by_player_id,is_public,image_count,updated_at) VALUES(?,?,?,?,?,?)")
    .run("legacy-private", "Legacy", "host", 0, 1, "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO questions(id,question_set_id,image_url,order_index) VALUES(?,?,?,?)")
    .run("legacy-q", "legacy-private", "https://example.com/legacy.webp", 0);
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,prepared_question_set_id) VALUES(?,?,?,?)")
    .run("legacy-room", "LEG017", "host", "legacy-private");

  const migration = readFileSync(join(migrationsDirectory, "0017_question_set_manifest.sql"), "utf8");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration.split(";").slice(0, 2).join(";") + ";");
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('question_sets') WHERE name='manifest_version'").get().count, 0);

  db.exec(migration);
  const legacy = db.prepare("SELECT manifest_version,manifest_revision,manifest_json FROM question_sets WHERE id='legacy-private'").get();
  assert.equal(legacy.manifest_version, null);
  assert.equal(legacy.manifest_revision, 0);
  assert.equal(legacy.manifest_json, null);

  const publicIndexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='question_sets_public_created_idx'").get().sql;
  assert.match(String(publicIndexSql), /WHERE is_public = 1/i);
  const cleanupPlan = db.prepare(`EXPLAIN QUERY PLAN
    select qs.id from question_sets qs
    where qs.is_public=0 and qs.updated_at<?
      and not exists(select 1 from game_sessions gs where gs.question_set_id=qs.id)
      and not exists(select 1 from rooms r where r.prepared_question_set_id=qs.id)
    order by qs.updated_at,qs.id limit ?`).all("2027-01-01T00:00:00.000Z", 100)
    .map((row) => String(row.detail)).join("\n");
  assert.match(cleanupPlan, /question_sets_private_cleanup_idx/);
  assert.match(cleanupPlan, /game_sessions_question_set_id_idx/);
  assert.match(cleanupPlan, /rooms_prepared_question_set_id_idx/);
});

test("D1 0018 adds aggregate room state transactionally without rewriting old rooms", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0017");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,runtime_generation) VALUES(?,?,?,?)")
    .run("legacy-room-state", "STATE1", "host", 3);

  const migration = readFileSync(join(migrationsDirectory, "0018_room_state_manifest.sql"), "utf8");
  const firstStatement = migration.split(";").map((statement) => statement.trim()).filter(Boolean)[0];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`${firstStatement};`);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='room_state_version'").get().count, 0);

  db.exec(migration);
  const legacy = db.prepare(`SELECT runtime_generation,room_state_version,room_state_revision,room_state_json
    FROM rooms WHERE id='legacy-room-state'`).get();
  assert.equal(legacy.runtime_generation, 3);
  assert.equal(legacy.room_state_version, null);
  assert.equal(legacy.room_state_revision, 0);
  assert.equal(legacy.room_state_json, null);
  assert.throws(() => db.prepare("UPDATE rooms SET room_state_version=2 WHERE id='legacy-room-state'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE rooms SET room_state_revision=-1 WHERE id='legacy-room-state'").run(), /CHECK constraint failed/);
});

test("room-state manifest is room-scoped and rejects corruption", () => {
  const joined = "2026-08-01T00:00:00.000Z";
  const json = encodeRoomState("room-a", "shared", [{
    id: "shared", room_id: "room-a", nickname: "Host A", is_host: true,
    role: "PLAYER", joined_at: joined, last_seen_at: joined,
  }]);
  assert.deepEqual(decodeRoomState({
    id: "room-a", host_player_id: "shared", room_state_version: 1, room_state_json: json,
  }).map((player) => player.id), ["shared"]);
  assert.doesNotThrow(() => encodeRoomState("room-b", "shared", [{
    id: "shared", room_id: "room-b", nickname: "Host B", is_host: true,
    role: "PLAYER", joined_at: joined, last_seen_at: joined,
  }]));
  assert.throws(() => decodeRoomState({
    id: "room-a", host_player_id: "shared", room_state_version: 1, room_state_json: "{",
  }), /JSON 已损坏/);
  assert.throws(() => encodeRoomState("room-a", "missing", [{
    id: "shared", room_id: "room-a", nickname: "Host", is_host: true,
    role: "PLAYER", joined_at: joined, last_seen_at: joined,
  }]), /房主不在玩家列表/);
  const fiftyOne = Array.from({ length: 51 }, (_, index) => ({
    id: `p${index}`, room_id: "room-a", nickname: `P${index}`, is_host: index === 0,
    role: "PLAYER" as const, joined_at: joined, last_seen_at: joined,
  }));
  assert.throws(() => encodeRoomState("room-a", "p0", fiftyOne), /玩家数量无效/);
  const fiftyPlayersAndFiftySpectators = Array.from({ length: 100 }, (_, index) => ({
    id: `m${index}`, room_id: "room-a", nickname: `M${index}`, is_host: index === 0,
    role: (index < 50 ? "PLAYER" : "SPECTATOR") as "PLAYER" | "SPECTATOR",
    joined_at: joined, last_seen_at: joined,
  }));
  assert.doesNotThrow(() => encodeRoomState("room-a", "m0", fiftyPlayersAndFiftySpectators));
  assert.equal(decodeRoomState({
    id: "room-a", host_player_id: "m0", room_state_version: 1,
    room_state_json: encodeRoomState("room-a", "m0", fiftyPlayersAndFiftySpectators),
  }).length, 100);
  assert.throws(() => encodeRoomState("room-a", "m0", [
    ...fiftyPlayersAndFiftySpectators,
    { ...fiftyPlayersAndFiftySpectators[99], id: "s51", nickname: "S51" },
  ]), /观战人数无效/);
  assert.throws(() => encodeRoomState("room-a", "p0", [fiftyOne[0], { ...fiftyOne[1], nickname: " p0 " }]), /重复玩家昵称/);
});

test("D1 0013 upgrades rooms to TEAM_BATTLE vote durations transactionally", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0013");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status) VALUES(?,?,?,?)")
    .run("legacy-room", "LEGACY", "host", "LOBBY");
  const migration = readFileSync(join(migrationsDirectory, "0014_team_battle_vote_durations.sql"), "utf8");
  const firstStatement = migration.split(";").map((statement) => statement.trim()).filter(Boolean)[0];

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`${firstStatement};`);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_team_reveal_vote_seconds'").get().count, 0);

  db.exec(migration);
  const room = db.prepare("SELECT * FROM rooms WHERE id='legacy-room'").get();
  assert.equal(room.room_code, "LEGACY");
  assert.equal(room.lobby_team_reveal_vote_seconds, 15);
  assert.equal(room.lobby_team_guess_vote_seconds, 50);
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_team_reveal_vote_seconds=0 WHERE id='legacy-room'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_team_guess_vote_seconds=601 WHERE id='legacy-room'").run(), /CHECK constraint failed/);
});

test("D1 0015 adds manual team state transactionally with safe defaults", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0014");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status) VALUES(?,?,?,?)").run("legacy-team", "TEAM15", "host", "LOBBY");
  const migration = readFileSync(join(migrationsDirectory, "0015_manual_team_assignment.sql"), "utf8");
  const firstStatement = migration.split(";").map((statement) => statement.trim()).filter(Boolean)[0];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`${firstStatement};`);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_team_assignment_mode'").get().count, 0);
  db.exec(migration);
  const room = db.prepare("SELECT * FROM rooms WHERE id='legacy-team'").get();
  assert.equal(room.lobby_team_assignment_mode, "AUTO");
  assert.equal(room.lobby_team_assignments, "{}");
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_team_assignment_mode='INVALID' WHERE id='legacy-team'").run(), /CHECK constraint failed/);
});

test("D1 0019 adds the presenter block option disabled by default", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0018");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status) VALUES(?,?,?,?)")
    .run("legacy-block", "BLOCK19", "host", "LOBBY");
  const migration = readFileSync(join(migrationsDirectory, "0019_team_presenter_block_setting.sql"), "utf8");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_team_presenter_block_enabled'").get().count, 0);

  db.exec(migration);
  const room = db.prepare("SELECT * FROM rooms WHERE id='legacy-block'").get();
  assert.equal(room.lobby_team_presenter_block_enabled, 0);
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_team_presenter_block_enabled=2 WHERE id='legacy-block'").run(), /CHECK constraint failed/);
});

test("D1 0012 upgrades to nullable creation methods without rewriting historical rows", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0012");
  db.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
    .run("legacy", "Legacy", "host", 1);

  db.exec(readFileSync(join(migrationsDirectory, "0013_question_set_creation_method.sql"), "utf8"));

  assert.equal(db.prepare("SELECT creation_method FROM question_sets WHERE id='legacy'").get().creation_method, null);
  assert.throws(
    () => db.prepare("UPDATE question_sets SET creation_method='invalid' WHERE id='legacy'").run(),
    /CHECK constraint failed/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='index' AND name LIKE 'question_sets_public_creation_%'").get().count,
    3,
  );
});

test("new rooms explicitly use the current TEAM_BATTLE defaults", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);

  await runWithGameDatabase(db, async () => {
    const room = await createRoom("host-defaults", "Host");
    assert.equal(room.teamRevealVoteSeconds, 25);
    assert.equal(room.teamGuessVoteSeconds, 50);
    assert.equal(room.teamPresenterBlockEnabled, false);
    assert.equal(room.spectatorQuestionPreviewEnabled, true);
    assert.equal(room.spectatorPlayerAnswersEnabled, true);
    assert.equal(room.playerCapacity, 50);
    assert.equal(room.spectatorCapacity, 50);
    assert.equal(room.teamAssignmentMode, "MANUAL");

    const stored = db.sqlite.prepare("SELECT lobby_team_reveal_vote_seconds, lobby_team_guess_vote_seconds, lobby_team_presenter_block_enabled, lobby_spectator_question_preview_enabled, lobby_spectator_player_answers_enabled, lobby_player_capacity, lobby_spectator_capacity, lobby_team_assignment_mode, runtime_generation FROM rooms WHERE id=?")
      .get(room.id);
    assert.equal(stored.lobby_team_reveal_vote_seconds, 25);
    assert.equal(stored.lobby_team_guess_vote_seconds, 50);
    assert.equal(stored.lobby_team_presenter_block_enabled, 0);
    assert.equal(stored.lobby_spectator_question_preview_enabled, 1);
    assert.equal(stored.lobby_spectator_player_answers_enabled, 1);
    assert.equal(stored.lobby_player_capacity, 50);
    assert.equal(stored.lobby_spectator_capacity, 50);
    assert.equal(stored.lobby_team_assignment_mode, "MANUAL");
    assert.equal(stored.runtime_generation, CURRENT_ROOM_RUNTIME_GENERATION);
    const aggregate = db.sqlite.prepare("SELECT * FROM rooms WHERE id=?").get(room.id);
    assert.equal(aggregate.room_state_version, 1);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM players WHERE room_id=?").get(room.id).count, 0);

    const changesBeforeNoOps = Number(db.sqlite.prepare("SELECT total_changes() changes").get().changes);
    const rejoined = await joinRoom(room.code, "host-defaults", "Host");
    assert.equal(rejoined.error, null);
    await updateRoomGameSettings({
      roomId: room.id,
      hostPlayerId: "host-defaults",
      gameMode: "ROUND_REVEAL",
      maxRevealRounds: 3,
      roundSeconds: 45,
      roundScores: [5, 3, 1],
      teamRevealVoteSeconds: 25,
      teamGuessVoteSeconds: 50,
      teamAssignmentMode: "MANUAL",
    });
    assert.equal(Number(db.sqlite.prepare("SELECT total_changes() changes").get().changes), changesBeforeNoOps);
    assert.equal(db.sqlite.prepare("SELECT room_state_revision FROM rooms WHERE id=?").get(room.id).room_state_revision, 0);

    const restricted = await updateRoomGameSettings({
      roomId: room.id,
      hostPlayerId: "host-defaults",
      gameMode: "ROUND_REVEAL",
      spectatorQuestionPreviewEnabled: false,
      spectatorPlayerAnswersEnabled: false,
    });
    assert.equal(restricted.spectatorQuestionPreviewEnabled, false);
    assert.equal(restricted.spectatorPlayerAnswersEnabled, false);
    assert.deepEqual({ ...db.sqlite.prepare("SELECT lobby_spectator_question_preview_enabled,lobby_spectator_player_answers_enabled FROM rooms WHERE id=?").get(room.id) }, {
      lobby_spectator_question_preview_enabled: 0,
      lobby_spectator_player_answers_enabled: 0,
    });
  });
});

test("public room migration preserves old rooms as private and validates catalog metadata", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0019");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id) VALUES(?,?,?)").run("old-room", "OLD020", "host");
  db.exec(readFileSync(join(migrationsDirectory, "0020_public_rooms.sql"), "utf8"));
  const stored = db.prepare("SELECT room_visibility,room_name,member_count,prepared_question_source FROM rooms WHERE id='old-room'").get();
  assert.deepEqual({ ...stored }, { room_visibility: "PRIVATE", room_name: null, member_count: 0, prepared_question_source: null });
  assert.throws(() => db.prepare("UPDATE rooms SET room_visibility='UNKNOWN' WHERE id='old-room'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE rooms SET member_count=51 WHERE id='old-room'").run(), /CHECK constraint failed/);
});

test("public activity migration upgrades existing public rooms transactionally without an activity index", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0020");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,room_visibility,updated_at) VALUES(?,?,?,?,?)")
    .run("public-old", "PUB021", "host", "PUBLIC", "2026-08-10T01:00:00.000Z");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,room_visibility,updated_at) VALUES(?,?,?,?,?)")
    .run("private-old", "PRI021", "host", "PRIVATE", "2026-08-10T02:00:00.000Z");
  const migration = readFileSync(join(migrationsDirectory, "0021_public_room_activity.sql"), "utf8");

  db.exec("BEGIN");
  try {
    db.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='public_activity_at'").get().count, 0);

  db.exec(migration);
  assert.deepEqual(
    db.prepare("SELECT id,public_activity_at FROM rooms ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: "private-old", public_activity_at: null },
      { id: "public-old", public_activity_at: "2026-08-10T01:00:00.000Z" },
    ],
  );
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='index' AND sql LIKE '%public_activity_at%'").get().count, 0);
});

test("spectator count migration backfills public room manifests transactionally without an index", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0021");
  const publicState = JSON.stringify({
    schema: 1,
    players: [
      { id: "host", nickname: "Host", role: "PLAYER", joined_at: "2026-08-10T01:00:00.000Z" },
      { id: "viewer-1", nickname: "Viewer 1", role: "SPECTATOR", joined_at: "2026-08-10T01:01:00.000Z" },
      { id: "viewer-2", nickname: "Viewer 2", role: "SPECTATOR", joined_at: "2026-08-10T01:02:00.000Z" },
    ],
  });
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,room_visibility,room_state_version,room_state_json) VALUES(?,?,?,?,?,?)")
    .run("public-spectators", "PUB022", "host", "PUBLIC", 1, publicState);
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,room_visibility,room_state_version,room_state_json) VALUES(?,?,?,?,?,?)")
    .run("private-spectators", "PRI022", "host", "PRIVATE", 1, publicState);
  const migration = readFileSync(join(migrationsDirectory, "0022_public_room_spectator_count.sql"), "utf8");

  db.exec("BEGIN");
  try {
    db.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='spectator_count'").get().count, 0);

  db.exec(migration);
  assert.deepEqual(
    db.prepare("SELECT id,spectator_count FROM rooms ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: "private-spectators", spectator_count: 0 },
      { id: "public-spectators", spectator_count: 2 },
    ],
  );
  assert.throws(() => db.prepare("UPDATE rooms SET spectator_count=51 WHERE id='public-spectators'").run(), /CHECK constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='index' AND sql LIKE '%spectator_count%' ").get().count, 0);
});

test("room notice migration preserves existing rooms and enforces the storage bound", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0022");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id) VALUES(?,?,?)").run("notice-old", "NOT023", "host");
  const migration = readFileSync(join(migrationsDirectory, "0023_room_notice.sql"), "utf8");

  db.exec("BEGIN");
  try {
    db.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='room_notice'").get().count, 0);

  db.exec(migration);
  assert.equal(db.prepare("SELECT room_notice FROM rooms WHERE id='notice-old'").get().room_notice, null);
  assert.throws(() => db.prepare("UPDATE rooms SET room_notice=? WHERE id='notice-old'").run("信".repeat(81)), /CHECK constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='index' AND sql LIKE '%room_notice%'").get().count, 0);
});

test("spectator visibility migration preserves existing rooms with compatible defaults", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0023");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id) VALUES(?,?,?)").run("spectator-old", "SPC024", "host");
  const migration = readFileSync(join(migrationsDirectory, "0024_spectator_visibility_settings.sql"), "utf8");

  db.exec("BEGIN");
  try {
    db.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_spectator_question_preview_enabled'").get().count, 0);

  db.exec(migration);
  const room = db.prepare("SELECT * FROM rooms WHERE id='spectator-old'").get();
  assert.equal(room.lobby_spectator_question_preview_enabled, 1);
  assert.equal(room.lobby_spectator_player_answers_enabled, 1);
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_spectator_question_preview_enabled=2 WHERE id='spectator-old'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_spectator_player_answers_enabled=-1 WHERE id='spectator-old'").run(), /CHECK constraint failed/);
});

test("room role-capacity migration backfills player counts and enforces independent bounds", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0024");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,member_count,spectator_count) VALUES(?,?,?,?,?)")
    .run("capacity-old", "CAP025", "host", 5, 2);
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,member_count,spectator_count,room_state_json) VALUES(?,?,?,?,?,?)")
    .run("capacity-private", "CAPPRV", "private-host", 3, 0, JSON.stringify({
      schema: 1,
      players: [
        { id: "private-host", nickname: "Private Host", role: "PLAYER", joined_at: "2026-08-01T00:00:00.000Z" },
        { id: "private-player", nickname: "Private Player", role: "PLAYER", joined_at: "2026-08-01T00:00:01.000Z" },
        { id: "private-spectator", nickname: "Private Spectator", role: "SPECTATOR", joined_at: "2026-08-01T00:00:02.000Z" },
      ],
    }));
  const migration = readFileSync(join(migrationsDirectory, "0025_room_role_capacities.sql"), "utf8");

  db.exec("BEGIN");
  try {
    db.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_player_capacity'").get().count, 0);

  db.exec(migration);
  assert.deepEqual({ ...db.prepare("SELECT member_count,spectator_count,lobby_player_capacity,lobby_spectator_capacity FROM rooms WHERE id='capacity-old'").get() }, {
    member_count: 3,
    spectator_count: 2,
    lobby_player_capacity: 50,
    lobby_spectator_capacity: 50,
  });
  assert.deepEqual({ ...db.prepare("SELECT member_count,spectator_count FROM rooms WHERE id='capacity-private'").get() }, {
    member_count: 2,
    spectator_count: 1,
  });
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_player_capacity=0 WHERE id='capacity-old'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_spectator_capacity=51 WHERE id='capacity-old'").run(), /CHECK constraint failed/);
});

test("game question sampling migration is transactional and bounds room/session snapshots", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0027");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id) VALUES(?,?,?)").run("sample-old", "SMP028", "host");
  db.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
    .run("sample-set", "Sample", "host", 1);
  db.prepare("INSERT INTO game_sessions(id,room_id,question_set_id,presenter_player_id) VALUES(?,?,?,?)")
    .run("sample-game", "sample-old", "sample-set", "host");
  const migration = readFileSync(join(migrationsDirectory, "0028_game_question_sampling.sql"), "utf8");

  db.exec("BEGIN");
  try {
    const firstStatement = migration.split(";").map((statement) => statement.trim()).filter(Boolean)[0];
    db.exec(`${firstStatement};`);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_question_count'").get().count, 0);

  db.exec(migration);
  assert.deepEqual({ ...db.prepare("SELECT lobby_question_count,prepared_question_count FROM rooms WHERE id='sample-old'").get() }, {
    lobby_question_count: null,
    prepared_question_count: null,
  });
  assert.equal(db.prepare("SELECT selected_question_ids FROM game_sessions WHERE id='sample-game'").get().selected_question_ids, "[]");
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_question_count=0 WHERE id='sample-old'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE rooms SET prepared_question_count=31 WHERE id='sample-old'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE game_sessions SET selected_question_ids='not-json' WHERE id='sample-game'").run(), /CHECK constraint failed/);
  assert.throws(
    () => db.prepare("UPDATE game_sessions SET selected_question_ids=? WHERE id='sample-game'").run(JSON.stringify(Array.from({ length: 31 }, (_, index) => `q${index}`))),
    /CHECK constraint failed/,
  );
});

test("room notices are host-authoritative, recoverable, bounded, and emit only changed deltas", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);

  await runWithGameDatabase(db, async () => {
    const room = await createRoom("notice-host", "Notice Host");
    const saved = await updateRoomNotice({
      roomId: room.id!,
      hostPlayerId: "notice-host",
      notice: "  满 8 人\n开始  ",
    });
    assert.deepEqual(saved, {
      roomId: room.id,
      notice: "满 8 人 开始",
      updatedAt: saved.updatedAt,
      changed: true,
    });
    assert.deepEqual(getRoomNoticeUpdatedDelta("updateRoomNotice", saved), {
      scope: "room",
      type: "room_notice_updated",
      roomId: room.id,
      notice: "满 8 人 开始",
      updatedAt: saved.updatedAt,
    });
    assert.equal((await getRoomWithPlayers(room.code))?.notice, "满 8 人 开始");

    const changesBeforeNoOp = Number(db.sqlite.prepare("SELECT total_changes() changes").get().changes);
    const noOp = await updateRoomNotice({ roomId: room.id!, hostPlayerId: "notice-host", notice: "满 8 人 开始" });
    assert.equal(noOp.changed, false);
    assert.equal(Number(db.sqlite.prepare("SELECT total_changes() changes").get().changes), changesBeforeNoOp);
    assert.equal(getRoomNoticeUpdatedDelta("updateRoomNotice", noOp), null);

    await assert.rejects(
      () => updateRoomNotice({ roomId: room.id!, hostPlayerId: "not-host", notice: "不应保存" }),
      /只有房主/,
    );
    await assert.rejects(
      () => updateRoomNotice({ roomId: room.id!, hostPlayerId: "notice-host", notice: "信".repeat(81) }),
      /最多 80 个字符/,
    );

    const cleared = await updateRoomNotice({ roomId: room.id!, hostPlayerId: "notice-host", notice: "   " });
    assert.equal(cleared.notice, null);
    assert.equal((await getRoomWithPlayers(room.code))?.notice, null);

    db.sqlite.prepare("UPDATE rooms SET game_status='QUESTION_SETUP' WHERE id=?").run(room.id);
    const setupNotice = await updateRoomNotice({ roomId: room.id!, hostPlayerId: "notice-host", notice: "题库准备中" });
    assert.equal(setupNotice.notice, "题库准备中");

    db.sqlite.prepare("UPDATE rooms SET game_status='PLAYING' WHERE id=?").run(room.id);
    await assert.rejects(
      () => updateRoomNotice({ roomId: room.id!, hostPlayerId: "notice-host", notice: "游戏中修改" }),
      /大厅或题库准备阶段/,
    );
  });
});

test("public room creation uses an optional trimmed name and piggybacks member counts", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const legacyCompatible = await createRoom("private-host", "Private Host");
    assert.equal(legacyCompatible.visibility, "PRIVATE");
    assert.equal(legacyCompatible.name, null);

    const fallback = await createRoom("public-host", "  Alice  ", { visibility: "PUBLIC", name: "   " });
    assert.equal(fallback.visibility, "PUBLIC");
    assert.equal(fallback.name, "Alice的房间");
    assert.equal(fallback.playerCount, 1);
    assert.equal(fallback.playerCapacity, 50);
    assert.equal(fallback.spectatorCapacity, 50);
    const custom = await createRoom("custom-host", "Bob", { visibility: "PUBLIC", name: "  周末动画局  " });
    assert.equal(custom.name, "周末动画局");
    const fixedActivity = "2026-08-10T00:00:00.000Z";
    db.sqlite.prepare("UPDATE rooms SET public_activity_at=? WHERE id=?").run(fixedActivity, custom.id);
    const joined = await joinRoom(custom.code, "guest", "Guest");
    assert.equal(joined.error, null);
    assert.equal(joined.room?.playerCount, 2);
    assert.equal(db.sqlite.prepare("SELECT member_count FROM rooms WHERE id=?").get(custom.id).member_count, 2);
    assert.equal(db.sqlite.prepare("SELECT public_activity_at FROM rooms WHERE id=?").get(custom.id).public_activity_at, fixedActivity);
    await selectPresenterForRound(custom.id!, "custom-host", "custom-host");
    assert.notEqual(db.sqlite.prepare("SELECT public_activity_at FROM rooms WHERE id=?").get(custom.id).public_activity_at, fixedActivity);
    await assert.rejects(() => createRoom("long-name-host", "Host", { visibility: "PUBLIC", name: "x".repeat(41) }), /40/);
  });
});

test("room capacities independently gate joins, reconnects, role switches, and reductions", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    let room = await createRoom("capacity-host", "Capacity Host");
    room = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "capacity-host",
      gameMode: "ROUND_REVEAL",
      playerCapacity: 2,
      spectatorCapacity: 1,
    });
    assert.equal(room.playerCapacity, 2);
    assert.equal(room.spectatorCapacity, 1);

    const player = await joinRoom(room.code, "player-2", "Player 2", "PLAYER");
    assert.equal(player.error, null);
    const playerOverflow = await joinRoom(room.code, "player-3", "Player 3", "PLAYER");
    assert.equal(playerOverflow.errorCode, "PLAYER_CAPACITY_FULL");

    const spectator = await joinRoom(room.code, "spectator-1", "Spectator 1", "SPECTATOR");
    assert.equal(spectator.error, null);
    const spectatorOverflow = await joinRoom(room.code, "spectator-2", "Spectator 2", "SPECTATOR");
    assert.equal(spectatorOverflow.errorCode, "SPECTATOR_CAPACITY_FULL");

    const reconnected = await joinRoom(room.code, "player-2", "Player 2", "PLAYER");
    assert.equal(reconnected.error, null);
    await assert.rejects(
      () => updatePlayerRole(room.id!, "player-2", "player-2", "SPECTATOR"),
      /观战人数已满/,
    );
    await assert.rejects(
      () => updateRoomGameSettings({ roomId: room.id!, hostPlayerId: "capacity-host", gameMode: "ROUND_REVEAL", playerCapacity: 1 }),
      /玩家人数上限不能低于 2/,
    );
    await assert.rejects(
      () => updateRoomGameSettings({ roomId: room.id!, hostPlayerId: "capacity-host", gameMode: "ROUND_REVEAL", spectatorCapacity: 0 }),
      /观战人数上限不能低于 1/,
    );

    const stored = db.sqlite.prepare("SELECT member_count,spectator_count,lobby_player_capacity,lobby_spectator_capacity FROM rooms WHERE id=?").get(room.id);
    assert.deepEqual({ ...stored }, { member_count: 2, spectator_count: 1, lobby_player_capacity: 2, lobby_spectator_capacity: 1 });

    const zeroRoom = await createRoom("zero-host", "Zero Host");
    await updateRoomGameSettings({
      roomId: zeroRoom.id!,
      hostPlayerId: "zero-host",
      gameMode: "ROUND_REVEAL",
      spectatorCapacity: 0,
    });
    const disabledSpectator = await joinRoom(zeroRoom.code, "zero-spectator", "Zero Spectator", "SPECTATOR");
    assert.equal(disabledSpectator.errorCode, "SPECTATOR_CAPACITY_FULL");
  });
});

test("public room question source freezes when prepared and clears on cancellation", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const room = await createRoom("source-host", "Source Host", { visibility: "PUBLIC" });
    await selectPresenterForRound(room.id, "source-host", "source-host");
    const assisted = await createUploadedQuestionSet({
      roomId: room.id,
      presenterPlayerId: "source-host",
      title: "Assisted",
      imageUrls: ["https://example.com/source.webp"],
      creationMethod: "creation_tool_assisted",
    });
    const prepared = await prepareQuestionSetForStart({ roomId: room.id, presenterPlayerId: "source-host", questionSetId: assisted.id });
    assert.equal(prepared.preparedQuestionSource, "CREATION_TOOL");
    await publishQuestionSetToCommunity({ questionSetId: assisted.id, playerId: "source-host", title: "Assisted", creationMethod: "creation_tool_assisted" });
    assert.equal(db.sqlite.prepare("SELECT prepared_question_source FROM rooms WHERE id=?").get(room.id).prepared_question_source, "CREATION_TOOL");
    const cancelled = await cancelPresenterSetup(room.id, "source-host");
    assert.equal(cancelled.preparedQuestionSource, null);

    await selectPresenterForRound(room.id, "source-host", "source-host");
    const community = await prepareQuestionSetForStart({ roomId: room.id, presenterPlayerId: "source-host", questionSetId: assisted.id });
    assert.equal(community.preparedQuestionSource, "COMMUNITY");
    await cancelPresenterSetup(room.id, "source-host");

    await selectPresenterForRound(room.id, "source-host", "source-host");
    const manualSet = await createUploadedQuestionSet({
      roomId: room.id,
      presenterPlayerId: "source-host",
      title: "Manual",
      imageUrls: ["https://example.com/manual-source.webp"],
    });
    const manual = await prepareQuestionSetForStart({ roomId: room.id, presenterPlayerId: "source-host", questionSetId: manualSet.id });
    assert.equal(manual.preparedQuestionSource, "MANUAL");
  });
});

test("room question-count settings sample once, persist order, and replay the same start snapshot", async () => {
  assert.deepEqual(selectQuestionsForGame([0, 1, 2, 3, 4], 2, () => 0), [1, 2]);
  assert.deepEqual(selectQuestionsForGame([0, 1, 2], 3, () => { throw new Error("must not shuffle all questions"); }), [0, 1, 2]);

  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const room = await createRoom("sample-host", "Sample Host");
    await selectPresenterForRound(room.id!, "sample-host", "sample-host");
    const questionSet = await createUploadedQuestionSet({
      roomId: room.id!,
      presenterPlayerId: "sample-host",
      title: "Sampling Set",
      questions: Array.from({ length: 6 }, (_, index) => ({
        imageUrl: `https://example.com/sample-${index + 1}.webp`,
        labelText: `Answer ${index + 1}`,
      })),
    });
    let prepared = await prepareQuestionSetForStart({
      roomId: room.id!,
      presenterPlayerId: "sample-host",
      questionSetId: questionSet.id,
    });
    assert.equal(prepared.preparedQuestionCount, 6);
    assert.equal(prepared.questionCount, null);

    prepared = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "sample-host",
      gameMode: "ROUND_REVEAL",
      questionCount: 6,
    });
    assert.equal(prepared.questionCount, null, "choosing the full set must preserve its original order");
    await assert.rejects(
      updateRoomGameSettings({
        roomId: room.id!,
        hostPlayerId: "sample-host",
        gameMode: "ROUND_REVEAL",
        questionCount: 7,
      }),
      /不能超过当前题库的 6 道题/,
    );

    prepared = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "sample-host",
      gameMode: "ROUND_REVEAL",
      questionCount: 3,
    });
    assert.equal(prepared.questionCount, 3);

    const startParams = {
      startRequestId: "sample-start-request-01",
      roomId: room.id!,
      hostPlayerId: "sample-host",
      presenterPlayerId: "sample-host",
      questionSetId: questionSet.id,
      questionCount: 3,
      authorityVersion: 2 as const,
    };
    const started = await startGameWithQuestionSet(startParams);
    const firstQuestions = started.__authorityVNextBootstrap.questions;
    assert.equal(started.gameSession.questionCount, 3);
    assert.equal(started.room.preparedQuestionCount, null);
    assert.equal(started.room.questionCount, 3);
    assert.equal(firstQuestions.length, 3);
    assert.equal(new Set(firstQuestions.map((question) => question.id)).size, 3);
    assert.deepEqual(firstQuestions.map((question) => question.orderIndex), [0, 1, 2]);

    const storedIds = JSON.parse(String(
      db.sqlite.prepare("SELECT selected_question_ids FROM game_sessions WHERE id=?").get(startParams.startRequestId).selected_question_ids,
    )) as string[];
    assert.deepEqual(storedIds, firstQuestions.map((question) => question.id));
    const fallbackBootstrap = await getGameBootstrapSnapshot(startParams.startRequestId);
    assert.equal(fallbackBootstrap.gameSession.questionCount, 3);
    assert.deepEqual(fallbackBootstrap.questions.map((question) => question.id), storedIds);
    const fallbackResult = await getGameResultSnapshot(startParams.startRequestId);
    assert.equal(fallbackResult.gameSession.questionCount, 3);
    assert.deepEqual(fallbackResult.questionSet?.questions?.map((question) => question.id), storedIds);

    const retried = await startGameWithQuestionSet(startParams);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM game_sessions WHERE id=?").get(startParams.startRequestId).count, 1);
    assert.deepEqual(
      retried.__authorityVNextBootstrap.questions.map((question) => question.id),
      firstQuestions.map((question) => question.id),
    );
  });
});

test("community sets beyond 30 questions prepare and start with the per-game 30 cap", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const room = await createRoom("large-set-host", "Large Set Host");
    await selectPresenterForRound(room.id!, "large-set-host", "large-set-host");
    const questions = Array.from({ length: 40 }, (_, index) => ({
      id: `large-set-question-${index}`,
      questionSetId: "large-community-set",
      imageUrl: `https://example.com/large-${index}.webp`,
      orderIndex: index,
      labelText: `Answer ${index + 1}`,
      labelSource: "manual" as const,
      createdAt: "2026-02-01T00:00:00.000Z",
    }));
    db.sqlite.prepare(`INSERT INTO question_sets
      (id,title,created_by_player_id,is_public,image_count,manifest_version,manifest_revision,manifest_json,
       community_submission_id,community_collection_title,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        "large-community-set",
        "大型社区题库",
        "large-set-host",
        1,
        40,
        1,
        0,
        encodeQuestionSetManifest(questions),
        "large-set-submission-0000000000",
        "大型社区题库",
        "2026-02-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
      );
    // 两段投稿：前 30 题由“首位上传者”上传，后 10 题由“第二位上传者”上传。
    const insertSubmission = db.sqlite.prepare(`INSERT INTO community_question_set_submissions
      (submission_id,submission_fingerprint,question_set_id,start_order_index,added_image_count,created_at,submitted_by_player_id,submitted_by_nickname)
      VALUES (?,?,?,?,?,?,?,?)`);
    insertSubmission.run(
      "large-set-submission-0000000000", "a".repeat(64), "large-community-set", 0, 30,
      "2026-02-01T00:00:00.000Z", "large-set-host", "首位上传者",
    );
    insertSubmission.run(
      "large-set-submission-0000000001", "b".repeat(64), "large-community-set", 30, 10,
      "2026-02-01T00:01:00.000Z", "second-uploader", "第二位上传者",
    );
    // 每题的属性 Tag 来自 question_image_index；补齐 40 行，验证游戏载荷携带。
    const insertIndex = db.sqlite.prepare(`INSERT INTO question_image_index
      (question_id,question_set_id,image_url,answer_text,order_index,created_at,anime_genre_tags_json)
      VALUES (?,?,?,?,?,?,?)`);
    for (let index = 0; index < questions.length; index += 1) {
      insertIndex.run(
        `large-set-question-${index}`,
        "large-community-set",
        `https://example.com/large-${index}.webp`,
        `Answer ${index + 1}`,
        index,
        "2026-02-01T00:00:00.000Z",
        JSON.stringify([{ name: `属性标签${index}`, count: 10 }]),
      );
    }

    const prepared = await prepareQuestionSetForStart({
      roomId: room.id!,
      presenterPlayerId: "large-set-host",
      questionSetId: "large-community-set",
    });
    // 已准备题数按每局上限记录为 30，而不是整套 40 题。
    assert.equal(prepared.preparedQuestionCount, 30);

    // 默认“全部题目”在超过 30 题的题库上按每局上限 30 题随机抽取。
    const started = await startGameWithQuestionSet({
      startRequestId: "large-set-start-request",
      roomId: room.id!,
      hostPlayerId: "large-set-host",
      presenterPlayerId: "large-set-host",
      questionSetId: "large-community-set",
      authorityVersion: 2 as const,
    });
    assert.equal(started.gameSession.questionCount, 30);
    const firstQuestions = started.__authorityVNextBootstrap.questions;
    assert.equal(firstQuestions.length, 30);
    assert.equal(new Set(firstQuestions.map((question) => question.id)).size, 30);
    // 每题按题目 ID 携带属性 Tag 名称（与随机抽题顺序无关）。
    for (const question of firstQuestions) {
      const expectedTag = `属性标签${question.id.replace("large-set-question-", "")}`;
      assert.deepEqual(question.genreTags, [expectedTag]);
    }
    // 每道题都按题目 ID 携带图库上传者昵称（与随机抽题后的顺序无关）。
    assert.ok(firstQuestions.every((question) => question.uploaderNickname));
    const expectedUploader = new Map(
      questions.map((question, index) => [question.id, index < 30 ? "首位上传者" : "第二位上传者"]),
    );
    for (const question of firstQuestions) {
      assert.equal(question.uploaderNickname, expectedUploader.get(question.id));
    }
    const storedIds = JSON.parse(String(
      db.sqlite.prepare("SELECT selected_question_ids FROM game_sessions WHERE id='large-set-start-request'").get().selected_question_ids,
    )) as string[];
    assert.equal(storedIds.length, 30);
    assert.deepEqual(storedIds, firstQuestions.map((question) => question.id));
  });
});

test("room question-count start validation rejects stale settings without creating a game", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const room = await createRoom("stale-count-host", "Stale Count Host");
    await selectPresenterForRound(room.id!, "stale-count-host", "stale-count-host");
    const questionSet = await createUploadedQuestionSet({
      roomId: room.id!,
      presenterPlayerId: "stale-count-host",
      title: "Small Set",
      imageUrls: ["https://example.com/one.webp", "https://example.com/two.webp"],
    });
    await prepareQuestionSetForStart({ roomId: room.id!, presenterPlayerId: "stale-count-host", questionSetId: questionSet.id });
    await assert.rejects(
      startGameWithQuestionSet({
        startRequestId: "invalid-count-start-01",
        roomId: room.id!,
        hostPlayerId: "stale-count-host",
        presenterPlayerId: "stale-count-host",
        questionSetId: questionSet.id,
        questionCount: 0,
        authorityVersion: 2,
      }),
      (error: unknown) => error instanceof StartGameRejectedError && /本局题数必须是 1 到 30/.test(error.message),
    );
    await assert.rejects(
      startGameWithQuestionSet({
        startRequestId: "stale-count-start-01",
        roomId: room.id!,
        hostPlayerId: "stale-count-host",
        presenterPlayerId: "stale-count-host",
        questionSetId: questionSet.id,
        questionCount: 3,
        authorityVersion: 2,
      }),
      (error: unknown) => error instanceof StartGameRejectedError && /只有 2 道题/.test(error.message),
    );
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM game_sessions").get().count, 0);
    assert.deepEqual({ ...db.sqlite.prepare("SELECT game_status,prepared_question_set_id FROM rooms WHERE id=?").get(room.id) }, {
      game_status: "QUESTION_SETUP",
      prepared_question_set_id: questionSet.id,
    });
  });
});

test("manual team joins enter the lobby unassigned before play and require an atomic team choice only while playing", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare(`INSERT INTO rooms(
    id,room_code,host_player_id,game_status,lobby_game_mode,lobby_team_assignment_mode
  ) VALUES(?,?,?,?,?,?)`).run("room-join-stage", "JOIN01", "host", "LOBBY", "TEAM_BATTLE", "MANUAL");
  db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
    .run("host", "room-join-stage", "Host", 1, "PLAYER");
  upgradeRoomFixtureToAggregate(db.sqlite, "room-join-stage");

  await runWithGameDatabase(db, async () => {
    let joined = await joinRoom("JOIN01", "p1", "P1");
    assert.equal(joined.error, null);
    assert.equal(joined.room?.status, "LOBBY");
    assert.equal(joined.room?.players.some((player) => player.id === "p1"), true);
    assert.deepEqual(joined.room?.teamAssignments, {});

    db.sqlite.prepare("UPDATE rooms SET game_status='QUESTION_SETUP',current_presenter_player_id='host' WHERE id='room-join-stage'").run();
    joined = await joinRoom("JOIN01", "p2", "P2");
    assert.equal(joined.error, null);
    assert.equal(joined.room?.status, "QUESTION_SETUP");
    assert.equal(joined.room?.players.some((player) => player.id === "p2"), true);
    assert.deepEqual(joined.room?.teamAssignments, {});

    db.sqlite.prepare("UPDATE rooms SET game_status='PLAYING' WHERE id='room-join-stage'").run();
    joined = await joinRoom("JOIN01", "p3", "P3");
    assert.equal(joined.room, null);
    assert.equal(joined.errorCode, "TEAM_SELECTION_REQUIRED");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM players WHERE id='p3'").get().count, 0);
    const stored = db.sqlite.prepare("SELECT * FROM rooms WHERE id='room-join-stage'").get() as never;
    assert.equal(decodeRoomState(stored).some((player) => player.id === "p3"), false);
  });
});

test("new question sets default by creation path, publishing can confirm the method, and community filtering stays consistent", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status,current_presenter_player_id) VALUES(?,?,?,?,?)")
    .run("room-1", "ROOM01", "host", "QUESTION_SETUP", "host");
  db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
    .run("host", "room-1", "Host", 1, "PLAYER");
  upgradeRoomFixtureToAggregate(db.sqlite, "room-1");

  await runWithGameDatabase(db, async () => {
    const manual = await createUploadedQuestionSet({
      roomId: "room-1",
      presenterPlayerId: "host",
      title: "Manual",
      imageUrls: ["https://example.com/manual.webp"],
    });
    const assisted = await createQuestionSetFromUrlText({
      roomId: "room-1",
      presenterPlayerId: "host",
      title: "Assisted",
      imageUrlsText: "{\"image_url\":\"https://example.com/assisted.webp\",\"label_text\":\"Example\"}",
    });
    const localFilenameAssisted = await createUploadedQuestionSet({
      roomId: "room-1",
      presenterPlayerId: "host",
      title: "Local filename assisted",
      questions: [
        { imageUrl: "https://example.com/hard.webp", labelText: "困难题" },
        { imageUrl: "https://example.com/easy.webp", labelText: "简单题" },
        { imageUrl: "https://example.com/medium.webp", labelText: "中等题" },
      ],
      creationMethod: "creation_tool_assisted",
    });

    assert.equal(manual.creationMethod, "player_manual");
    assert.equal(assisted.creationMethod, "creation_tool_assisted");
    assert.equal(localFilenameAssisted.creationMethod, "creation_tool_assisted");
    assert.deepEqual(localFilenameAssisted.questions?.map((question) => question.imageUrl), [
      "https://example.com/hard.webp",
      "https://example.com/easy.webp",
      "https://example.com/medium.webp",
    ]);
    assert.deepEqual(localFilenameAssisted.questions?.map((question) => question.orderIndex), [0, 1, 2]);
    assert.equal(
      db.sqlite.prepare("SELECT COUNT(*) count FROM questions WHERE question_set_id IN (?,?,?)")
        .get(manual.id, assisted.id, localFilenameAssisted.id).count,
      0,
    );
    const storedManual = db.sqlite.prepare("SELECT manifest_version,manifest_revision,manifest_json,image_urls_text FROM question_sets WHERE id=?").get(manual.id);
    assert.equal(storedManual.manifest_version, 1);
    assert.equal(storedManual.manifest_revision, 0);
    assert.equal(storedManual.image_urls_text, null);
    assert.match(String(storedManual.manifest_json), /manual\.webp/);
    assert.deepEqual((await getQuestionSetById(manual.id))?.questions?.map((question) => question.imageUrl), ["https://example.com/manual.webp"]);

    await publishQuestionSetToCommunity({
      questionSetId: manual.id,
      playerId: "host",
      title: "Manual",
      creationMethod: "creation_tool_assisted",
    });
    await publishQuestionSetToCommunity({
      questionSetId: assisted.id,
      playerId: "host",
      title: "Assisted",
      creationMethod: "player_manual",
    });

    const manualPage = await getCommunityQuestionSets({ creationMethod: "player_manual" });
    const assistedPage = await getCommunityQuestionSets({ creationMethod: "creation_tool_assisted" });
    const communityDetail = await getCommunityQuestionSetDetail(manual.id);
    assert.deepEqual(manualPage.items.map((item) => item.id), [assisted.id]);
    assert.deepEqual(assistedPage.items.map((item) => item.id), [manual.id]);
    assert.deepEqual(communityDetail?.questions?.map((question) => question.imageUrl), ["https://example.com/manual.webp"]);
    assert.equal(manualPage.total, 1);
    assert.equal(assistedPage.total, 1);
  });
});

test("custom room TEAM_BATTLE vote durations flow into the initial game state", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  // 0029 起 rooms.prepared_question_set_id 有引用完整性 trigger，先建题库。
  db.sqlite.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
    .run("set-team", "Team Set", "host", 1);
  db.sqlite.prepare("INSERT INTO questions(id,question_set_id,image_url,order_index) VALUES(?,?,?,?)")
    .run("question-team", "set-team", "https://example.com/team.webp", 0);
  db.sqlite.prepare(`INSERT INTO rooms(id,room_code,host_player_id,game_status,current_presenter_player_id,prepared_question_set_id)
    VALUES(?,?,?,?,?,?)`).run("room-team", "TEAM01", "host", "QUESTION_SETUP", "host", "set-team");
  for (const [id, nickname, isHost] of [["host", "Host", 1], ["p1", "P1", 0], ["p2", "P2", 0]] as const) {
    db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
      .run(id, "room-team", nickname, isHost, "PLAYER");
  }
  upgradeRoomFixtureToAggregate(db.sqlite, "room-team");

  await runWithGameDatabase(db, async () => {
    const room = await updateRoomGameSettings({
      roomId: "room-team",
      hostPlayerId: "host",
      gameMode: "TEAM_BATTLE",
      teamRevealVoteSeconds: 23,
      teamGuessVoteSeconds: 61,
      teamPresenterBlockEnabled: true,
    });
    assert.equal(room.teamRevealVoteSeconds, 23);
    assert.equal(room.teamGuessVoteSeconds, 61);
    assert.equal(room.teamPresenterBlockEnabled, true);

    const disabledRoom = await updateRoomGameSettings({
      roomId: "room-team",
      hostPlayerId: "host",
      gameMode: "TEAM_BATTLE",
      teamRevealVoteSeconds: 23,
      teamGuessVoteSeconds: 61,
      teamPresenterBlockEnabled: false,
    });
    assert.equal(disabledRoom.teamPresenterBlockEnabled, false);

    const started = await startGameWithQuestionSet({
      startRequestId: "team-countdown-01",
      roomId: "room-team",
      hostPlayerId: "host",
      presenterPlayerId: "host",
      questionSetId: "set-team",
      gameMode: "TEAM_BATTLE",
    });
    assert.equal(started.gameSession.teamBattleState?.revealVoteSeconds, 23);
    assert.equal(started.gameSession.teamBattleState?.guessVoteSeconds, 61);
    assert.equal(started.gameSession.teamBattleState?.presenterBlockEnabled, false);
    assert.equal(started.gameSession.teamBattleState?.phase, "REVEAL_VOTE");
    assert.equal(started.gameSession.teamBattleState?.voteDeadlineAt, null);
  });
});

test("TEAM_BATTLE roster rejection is typed and performs no D1 start writes", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
    .run("set-team-small", "Small Team Set", "host", 1);
  db.sqlite.prepare(`INSERT INTO rooms(id,room_code,host_player_id,game_status,current_presenter_player_id,prepared_question_set_id)
    VALUES(?,?,?,?,?,?)`).run("room-team-small", "TEAM02", "host", "QUESTION_SETUP", "host", "set-team-small");
  for (const [id, nickname, isHost] of [["host", "Host", 1], ["p1", "P1", 0]] as const) {
    db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
      .run(id, "room-team-small", nickname, isHost, "PLAYER");
  }
  upgradeRoomFixtureToAggregate(db.sqlite, "room-team-small");

  await runWithGameDatabase(db, async () => {
    await assert.rejects(
      startGameWithQuestionSet({
        startRequestId: "team-small-start-01",
        roomId: "room-team-small",
        hostPlayerId: "host",
        presenterPlayerId: "host",
        questionSetId: "set-team-small",
        gameMode: "TEAM_BATTLE",
        authorityVersion: 2,
      }),
      (error: unknown) => error instanceof StartGameRejectedError && /至少需要 2 名答题者/.test(error.message),
    );
  });

  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM game_sessions").get().count, 0);
  assert.deepEqual(
    { ...db.sqlite.prepare("SELECT game_status,current_game_id,prepared_question_set_id FROM rooms WHERE id=?").get("room-team-small") },
    { game_status: "QUESTION_SETUP", current_game_id: null, prepared_question_set_id: "set-team-small" },
  );
});

test("manual team setup blocks incomplete rosters, allows uneven teams, and switching to AUTO clears assignments", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
    .run("set-manual-team", "Manual Team Set", "host", 1);
  db.sqlite.prepare("INSERT INTO questions(id,question_set_id,image_url,order_index) VALUES(?,?,?,?)")
    .run("question-manual-team", "set-manual-team", "https://example.com/manual-team.webp", 0);
  db.sqlite.prepare(`INSERT INTO rooms(id,room_code,host_player_id,game_status,current_presenter_player_id,prepared_question_set_id)
    VALUES(?,?,?,?,?,?)`).run("room-manual-team", "MTEAM1", "host", "QUESTION_SETUP", "host", "set-manual-team");
  for (const [id, nickname, isHost] of [["host", "Host", 1], ["p1", "P1", 0], ["p2", "P2", 0], ["p3", "P3", 0], ["watch", "Watch", 0]] as const) {
    db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
      .run(id, "room-manual-team", nickname, isHost, id === "watch" ? "SPECTATOR" : "PLAYER");
  }
  upgradeRoomFixtureToAggregate(db.sqlite, "room-manual-team");

  await runWithGameDatabase(db, async () => {
    let room = await updateRoomGameSettings({
      roomId: "room-manual-team",
      hostPlayerId: "host",
      gameMode: "TEAM_BATTLE",
      teamAssignmentMode: "MANUAL",
    });
    assert.equal(room.teamAssignmentMode, "MANUAL");
    await assert.rejects(startGameWithQuestionSet({
      startRequestId: "manual-team-start-01",
      roomId: "room-manual-team",
      hostPlayerId: "host",
      presenterPlayerId: "host",
      questionSetId: "set-manual-team",
      gameMode: "TEAM_BATTLE",
    }), /尚未选择队伍/);

    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p1", team: "red" });
    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p2", team: "blue" });
    room = await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p3", team: "blue" });
    assert.deepEqual(room.teamAssignments, { p1: "red", p2: "blue", p3: "blue" });

    room = await updateRoomGameSettings({
      roomId: "room-manual-team",
      hostPlayerId: "host",
      gameMode: "ROUND_REVEAL",
      teamAssignmentMode: "MANUAL",
    });
    assert.deepEqual(room.teamAssignments, {}, "leaving TEAM_BATTLE must discard manual assignments");
    room = await updateRoomGameSettings({
      roomId: "room-manual-team",
      hostPlayerId: "host",
      gameMode: "TEAM_BATTLE",
      teamAssignmentMode: "MANUAL",
    });
    assert.deepEqual(room.teamAssignments, {}, "returning to TEAM_BATTLE must not restore stale assignments");

    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p1", team: "red" });
    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p2", team: "blue" });
    room = await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p3", team: "blue" });
    assert.deepEqual(room.teamAssignments, { p1: "red", p2: "blue", p3: "blue" });

    room = await updateRoomGameSettings({ roomId: "room-manual-team", hostPlayerId: "host", gameMode: "TEAM_BATTLE", teamAssignmentMode: "AUTO" });
    assert.deepEqual(room.teamAssignments, {});
    room = await updateRoomGameSettings({ roomId: "room-manual-team", hostPlayerId: "host", gameMode: "TEAM_BATTLE", teamAssignmentMode: "MANUAL" });
    assert.deepEqual(room.teamAssignments, {});

    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p1", team: "red" });
    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p2", team: "blue" });
    await selectTeamForPlayer({ roomId: "room-manual-team", playerId: "p3", team: "blue" });
    const started = await startGameWithQuestionSet({
      startRequestId: "manual-team-start-02",
      roomId: "room-manual-team",
      hostPlayerId: "host",
      presenterPlayerId: "host",
      questionSetId: "set-manual-team",
      gameMode: "TEAM_BATTLE",
    });
    assert.deepEqual(started.gameSession.teamBattleState?.teams, { red: ["p1"], blue: ["p2", "p3"] });
    assert.equal(started.gameSession.teamBattleState?.initialTeams?.red.includes("host"), false);
    assert.equal(started.gameSession.teamBattleState?.initialTeams?.blue.includes("watch"), false);
  });
});

test("manual team setup removes presenter and spectator assignments and remains editable after question-set preparation", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status) VALUES(?,?,?,?)")
    .run("room-manual-lifecycle", "MTEAM2", "host", "LOBBY");
  for (const [id, nickname, isHost] of [["host", "Host", 1], ["p1", "P1", 0], ["p2", "P2", 0]] as const) {
    db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
      .run(id, "room-manual-lifecycle", nickname, isHost, "PLAYER");
  }
  upgradeRoomFixtureToAggregate(db.sqlite, "room-manual-lifecycle");

  await runWithGameDatabase(db, async () => {
    await updateRoomGameSettings({
      roomId: "room-manual-lifecycle",
      hostPlayerId: "host",
      gameMode: "TEAM_BATTLE",
      teamAssignmentMode: "MANUAL",
    });
    await selectTeamForPlayer({ roomId: "room-manual-lifecycle", playerId: "host", team: "red" });
    await selectTeamForPlayer({ roomId: "room-manual-lifecycle", playerId: "p1", team: "blue" });
    await selectTeamForPlayer({ roomId: "room-manual-lifecycle", playerId: "p2", team: "red" });

    let room = await selectPresenterForRound("room-manual-lifecycle", "host", "p1");
    assert.equal(room.status, "QUESTION_SETUP");
    assert.deepEqual(room.teamAssignments, { host: "red", p2: "red" });

    db.sqlite.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
      .run("prepared-set", "Prepared Set", "host", 1);
    db.sqlite.prepare("UPDATE rooms SET prepared_question_set_id=? WHERE id=?")
      .run("prepared-set", "room-manual-lifecycle");
    room = await selectTeamForPlayer({ roomId: "room-manual-lifecycle", playerId: "p2", team: "blue" });
    assert.equal(room.preparedQuestionSetId, "prepared-set");
    assert.deepEqual(room.teamAssignments, { host: "red", p2: "blue" });

    room = await updatePlayerRole("room-manual-lifecycle", "p2", "p2", "SPECTATOR");
    assert.deepEqual(room.teamAssignments, { host: "red" });
    await assert.rejects(
      updatePlayerRole("room-manual-lifecycle", "p2", "p2", "PLAYER"),
      /请先选择加入红队或蓝队/,
    );
    room = await updatePlayerRole("room-manual-lifecycle", "p2", "p2", "PLAYER", "blue");
    assert.deepEqual(room.teamAssignments, { host: "red", p2: "blue" });
  });
});

test("returning a completed room to the lobby clears all per-game identities", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  db.sqlite.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
    .run("stale-set", "Stale Set", "host", 1);
  db.sqlite.prepare(`INSERT INTO rooms(
    id,room_code,host_player_id,game_status,current_presenter_player_id,current_game_id,prepared_question_set_id,lobby_team_assignments
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    "room-reset-after-game", "RESET1", "host", "GAME_RESULT", "presenter", "game-1", "stale-set", '{"host":"red","player":"blue"}',
  );
  for (const [id, nickname, isHost] of [["host", "Host", 1], ["presenter", "Presenter", 0], ["player", "Player", 0]] as const) {
    db.sqlite.prepare("INSERT INTO players(id,room_id,nickname,is_host,role) VALUES(?,?,?,?,?)")
      .run(id, "room-reset-after-game", nickname, isHost, "PLAYER");
  }
  upgradeRoomFixtureToAggregate(db.sqlite, "room-reset-after-game");

  await runWithGameDatabase(db, async () => {
    const room = await returnRoomToLobby("room-reset-after-game", "host");
    assert.equal(room.status, "LOBBY");
    assert.equal(room.currentPresenterPlayerId, null);
    assert.equal(room.currentGameId, null);
    assert.equal(room.preparedQuestionSetId, null);
    assert.deepEqual(room.teamAssignments, {});
  });
});

test("direct questions payload rejects non-boolean or null isR18 and conflicting is_r18 / isR18", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const room = await createRoom("r18-import-host", "R18 Import Host");
    await selectPresenterForRound(room.id, "r18-import-host", "r18-import-host");

    // 直接 questions payload（RPC 路径）只接受 boolean。
    await assert.rejects(
      createUploadedQuestionSet({
        roomId: room.id,
        presenterPlayerId: "r18-import-host",
        title: "R18 字符串题库",
        questions: [{ imageUrl: "https://example.com/1.webp", labelText: "答案", isR18: "yes" }],
      }),
      /is_r18 必须是布尔值/,
    );
    await assert.rejects(
      createUploadedQuestionSet({
        roomId: room.id,
        presenterPlayerId: "r18-import-host",
        title: "R18 null 题库",
        questions: [{ imageUrl: "https://example.com/1.webp", labelText: "答案", isR18: null }],
      }),
      /is_r18 必须是布尔值/,
    );
    // 两个字段同时存在且值冲突必须拒绝（untyped 载荷可能带 snake_case 键）。
    await assert.rejects(
      createUploadedQuestionSet({
        roomId: room.id,
        presenterPlayerId: "r18-import-host",
        title: "R18 冲突题库",
        questions: [{
          imageUrl: "https://example.com/1.webp",
          labelText: "答案",
          isR18: true,
          is_r18: false,
        } as QuestionImportItem],
      }),
      /is_r18 与 isR18 不一致/,
    );
    // JSON/JSONL 文本导入路径同样拒绝冲突。
    await assert.rejects(
      createQuestionSetFromUrlText({
        roomId: room.id,
        presenterPlayerId: "r18-import-host",
        title: "R18 文本冲突题库",
        imageUrlsText: JSON.stringify({
          image_url: "https://example.com/1.webp",
          label_text: "答案",
          is_r18: true,
          isR18: false,
        }),
      }),
      /is_r18 与 isR18 不一致/,
    );
    // 冲突被拒绝后题库不应被创建。
    const remaining = db.sqlite.prepare("SELECT COUNT(*) AS count FROM question_sets WHERE title LIKE 'R18 %题库'").get() as { count: number };
    assert.equal(remaining.count, 0);
  });
});

test("D1 0033 adds rooms lobby_include_r18 transactionally and defaults historical rooms to 0", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, "0032");
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,game_status) VALUES(?,?,?,?)")
    .run("legacy-room", "R18033", "host", "LOBBY");

  const migration = readFileSync(join(migrationsDirectory, "0033_room_lobby_include_r18.sql"), "utf8");
  // 事务回滚：迁移中途失败后列不得残留，也不能推进到半新状态。
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('rooms') WHERE name='lobby_include_r18'").get().count, 0);

  db.exec(migration);
  const legacy = db.prepare("SELECT lobby_include_r18 FROM rooms WHERE id='legacy-room'").get() as { lobby_include_r18: number };
  assert.equal(legacy.lobby_include_r18, 0, "历史房间默认不包含 R18 题目");
  // CHECK 只接受 0/1：2 与非整数值都被拒绝。
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_include_r18=2 WHERE id='legacy-room'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE rooms SET lobby_include_r18=0.5 WHERE id='legacy-room'").run(), /CHECK constraint failed/);
  db.prepare("UPDATE rooms SET lobby_include_r18=1 WHERE id='legacy-room'").run();
  assert.equal(db.prepare("SELECT lobby_include_r18 FROM rooms WHERE id='legacy-room'").get().lobby_include_r18, 1);
  assert.equal(db.prepare("SELECT room_code FROM rooms WHERE id='legacy-room'").get().room_code, "R18033");
});

test("updateRoomGameSettings rejects non-boolean includeR18 without partial writes", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const room = await createRoom("r18-bool-host", "R18 Bool Host");
    // includeR18 是不可信 RPC 输入：提供了但非 boolean（含 null/数字/字符串）必须明确拒绝，
    // 不能静默当成 false。
    for (const bad of [null, 1, 0, "true", "yes", {}, []]) {
      await assert.rejects(
        updateRoomGameSettings({
          roomId: room.id!,
          hostPlayerId: "r18-bool-host",
          gameMode: "ROUND_REVEAL",
          includeR18: bad as unknown as boolean,
        }),
        /必须是布尔值/,
      );
    }
    // 拒绝发生在任何写入之前：列保持默认 0，房间仍在。
    const row = db.sqlite.prepare("SELECT lobby_include_r18 FROM rooms WHERE id=?").get(room.id!) as { lobby_include_r18: number };
    assert.equal(row.lobby_include_r18, 0, "非法开关值被拒绝后保持默认 0");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM rooms WHERE id=?").get(room.id!).count, 1);
    // 合法布尔值仍然可用。
    const toggled = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "r18-bool-host",
      gameMode: "ROUND_REVEAL",
      includeR18: true,
    });
    assert.equal(toggled.includeR18, true);
  });
});

test("updateRoomGameSettings validates tag hint settings without partial writes", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const room = await createRoom("tag-hint-host", "Tag Hint Host");
    // tagHintsEnabled 是不可信 RPC 输入：非 boolean 必须明确拒绝。
    for (const bad of [null, 1, 0, "true", "yes", {}, []]) {
      await assert.rejects(
        updateRoomGameSettings({
          roomId: room.id!,
          hostPlayerId: "tag-hint-host",
          gameMode: "ROUND_REVEAL",
          tagHintsEnabled: bad as unknown as boolean,
        }),
        /必须是布尔值/,
      );
    }
    // 步长必须是 1-15 的整数。
    for (const bad of [0, 16, 2.5, -1, "5", null]) {
      await assert.rejects(
        updateRoomGameSettings({
          roomId: room.id!,
          hostPlayerId: "tag-hint-host",
          gameMode: "ROUND_REVEAL",
          tagHintBlockStep: bad as unknown as number,
        }),
        /1-15 的整数/,
      );
    }
    // 拒绝发生在任何写入之前：列保持默认值。
    const row = db.sqlite.prepare("SELECT lobby_tag_hints_enabled,lobby_tag_hint_block_step FROM rooms WHERE id=?")
      .get(room.id!) as { lobby_tag_hints_enabled: number; lobby_tag_hint_block_step: number };
    assert.deepEqual({ ...row }, { lobby_tag_hints_enabled: 0, lobby_tag_hint_block_step: 5 });
    // 合法设置可以持久化并读回。
    const toggled = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "tag-hint-host",
      gameMode: "ROUND_REVEAL",
      tagHintsEnabled: true,
      tagHintBlockStep: 3,
    });
    assert.equal(toggled.tagHintsEnabled, true);
    assert.equal(toggled.tagHintBlockStep, 3);
  });
});

test("room includeR18 defaults off, filters prepared counts, and freezes start sampling", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const room = await createRoom("r18-room-host", "R18 Room Host");
    await selectPresenterForRound(room.id!, "r18-room-host", "r18-room-host");
    // 旧题缺 isR18 默认 false；混入 2 道 R18。
    const questionSet = await createUploadedQuestionSet({
      roomId: room.id!,
      presenterPlayerId: "r18-room-host",
      title: "Mixed R18 Set",
      questions: [
        { imageUrl: "https://example.com/1.webp", labelText: "A1", isR18: false },
        { imageUrl: "https://example.com/2.webp", labelText: "A2", isR18: true },
        { imageUrl: "https://example.com/3.webp", labelText: "A3", isR18: false },
        { imageUrl: "https://example.com/4.webp", labelText: "A4", isR18: true },
        { imageUrl: "https://example.com/5.webp", labelText: "A5" },
      ],
    });
    // D1 migration 0033 默认 0；Room 映射为 includeR18=false。
    const row = db.sqlite.prepare("SELECT lobby_include_r18 FROM rooms WHERE id=?").get(room.id!) as { lobby_include_r18: number };
    assert.equal(row.lobby_include_r18, 0);

    // 默认关闭：准备题库时服务端已按开关排除 R18，可用题数 = 3（5 题中 2 题 R18）。
    let prepared = await prepareQuestionSetForStart({
      roomId: room.id!,
      presenterPlayerId: "r18-room-host",
      questionSetId: questionSet.id,
    });
    assert.equal(prepared.includeR18, false);
    assert.equal(prepared.preparedQuestionCount, 3);

    // 开启后可用题数恢复为全部 5 题；不传 includeR18 时保持当前值。
    prepared = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "r18-room-host",
      gameMode: "ROUND_REVEAL",
      includeR18: true,
    });
    assert.equal(prepared.includeR18, true);
    assert.equal(prepared.preparedQuestionCount, 5);
    const preserved = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "r18-room-host",
      gameMode: "ROUND_REVEAL",
      questionCount: 2,
    });
    assert.equal(preserved.includeR18, true);

    // 再次关闭：重新计算可用题数并收紧当前随机题数（5 → 3，等于上限时映射为 null）。
    prepared = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "r18-room-host",
      gameMode: "ROUND_REVEAL",
      questionCount: 5,
      includeR18: false,
    });
    assert.equal(prepared.includeR18, false);
    assert.equal(prepared.preparedQuestionCount, 3);
    assert.equal(prepared.questionCount, null);

    // 关闭状态下开局只从非 R18 候选题无放回抽取，抽中顺序写入快照。
    const startParams = {
      startRequestId: "r18-off-start-request",
      roomId: room.id!,
      hostPlayerId: "r18-room-host",
      presenterPlayerId: "r18-room-host",
      questionSetId: questionSet.id,
      questionCount: 2,
      authorityVersion: 2 as const,
    };
    const started = await startGameWithQuestionSet(startParams);
    const firstQuestions = started.__authorityVNextBootstrap.questions;
    assert.equal(started.gameSession.questionCount, 2);
    assert.equal(firstQuestions.length, 2);
    assert.equal(new Set(firstQuestions.map((question) => question.id)).size, 2, "抽样无重复");
    assert.equal(firstQuestions.every((question) => question.isR18 === false), true, "关闭 R18 时不得抽中 R18 题目");
    const storedIds = JSON.parse(String(
      db.sqlite.prepare("SELECT selected_question_ids FROM game_sessions WHERE id=?").get(startParams.startRequestId).selected_question_ids,
    )) as string[];
    assert.deepEqual(storedIds, firstQuestions.map((question) => question.id));

    // 重复 startRequestId 保持同一冻结顺序，不重新抽取。
    const retried = await startGameWithQuestionSet(startParams);
    assert.deepEqual(
      retried.__authorityVNextBootstrap.questions.map((question) => question.id),
      firstQuestions.map((question) => question.id),
    );
    assert.equal(
      db.sqlite.prepare("SELECT COUNT(*) count FROM game_sessions WHERE id=?").get(startParams.startRequestId).count,
      1,
    );
  });
});

test("all-R18 prepared set stays selectable with zero eligible questions until R18 is enabled", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const room = await createRoom("r18-all-host", "R18 All Host");
    await selectPresenterForRound(room.id!, "r18-all-host", "r18-all-host");
    const questionSet = await createUploadedQuestionSet({
      roomId: room.id!,
      presenterPlayerId: "r18-all-host",
      title: "All R18 Set",
      questions: [
        { imageUrl: "https://example.com/1.webp", labelText: "A1", isR18: true },
        { imageUrl: "https://example.com/2.webp", labelText: "A2", isR18: true },
      ],
    });

    // 默认关闭时选择全 R18 题库：不拒绝选择，仍记录题库，但可用题数为 0
    // （prepared_question_count 置 NULL），开局由服务端 0 候选权威拒绝。
    let prepared = await prepareQuestionSetForStart({
      roomId: room.id!,
      presenterPlayerId: "r18-all-host",
      questionSetId: questionSet.id,
    });
    assert.equal(prepared.includeR18, false);
    assert.equal(prepared.preparedQuestionSetId, questionSet.id);
    assert.equal(prepared.preparedQuestionCount, null, "筛选后 0 可用：prepared_question_count 置 NULL");
    assert.equal(prepared.questionCount, null);
    await assert.rejects(
      startGameWithQuestionSet({
        startRequestId: "r18-all-start-request-0",
        roomId: room.id!,
        hostPlayerId: "r18-all-host",
        presenterPlayerId: "r18-all-host",
        questionSetId: questionSet.id,
        authorityVersion: 2 as const,
      }),
      /没有可用/,
    );

    // 开启 R18：开关切换后重算，可用题数恢复为全部 2 题。
    prepared = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "r18-all-host",
      gameMode: "ROUND_REVEAL",
      includeR18: true,
    });
    assert.equal(prepared.includeR18, true);
    assert.equal(prepared.preparedQuestionCount, 2);

    // 已准备全 R18 题库时再关闭开关：切换成功（不拒绝），持久化 false、
    // 可用题数 NULL、随机题数清空；开局由服务端 0 候选权威拒绝。
    prepared = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "r18-all-host",
      gameMode: "ROUND_REVEAL",
      includeR18: false,
    });
    assert.equal(prepared.includeR18, false);
    assert.equal(prepared.preparedQuestionCount, null);
    assert.equal(prepared.questionCount, null);
    const roomRow = db.sqlite
      .prepare("SELECT lobby_include_r18, prepared_question_count, lobby_question_count FROM rooms WHERE id=?")
      .get(room.id!) as { lobby_include_r18: number; prepared_question_count: number | null; lobby_question_count: number | null };
    assert.equal(roomRow.lobby_include_r18, 0, "关闭开关持久化为 false");
    assert.equal(roomRow.prepared_question_count, null, "0 可用时 prepared_question_count 持久化为 NULL");
    assert.equal(roomRow.lobby_question_count, null, "0 可用时随机题数清空");
    await assert.rejects(
      startGameWithQuestionSet({
        startRequestId: "r18-all-start-request-1",
        roomId: room.id!,
        hostPlayerId: "r18-all-host",
        presenterPlayerId: "r18-all-host",
        questionSetId: questionSet.id,
        authorityVersion: 2 as const,
      }),
      /没有可用/,
    );

    // 再次开启后重算可用并开局正常，抽中全部为 R18 题目。
    prepared = await updateRoomGameSettings({
      roomId: room.id!,
      hostPlayerId: "r18-all-host",
      gameMode: "ROUND_REVEAL",
      includeR18: true,
    });
    assert.equal(prepared.preparedQuestionCount, 2);
    const started = await startGameWithQuestionSet({
      startRequestId: "r18-all-start-request",
      roomId: room.id!,
      hostPlayerId: "r18-all-host",
      presenterPlayerId: "r18-all-host",
      questionSetId: questionSet.id,
      authorityVersion: 2 as const,
    });
    assert.equal(started.gameSession.questionCount, 2);
    assert.equal(started.__authorityVNextBootstrap.questions.every((question) => question.isR18 === true), true);
  });
});

test("includeR18 caps a mixed over-30 community set to the per-game 30 limit", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  await runWithGameDatabase(db, async () => {
    const room = await createRoom("r18-large-host", "R18 Large Host");
    await selectPresenterForRound(room.id!, "r18-large-host", "r18-large-host");
    const questions = Array.from({ length: 40 }, (_, index) => ({
      id: `large-r18-question-${index}`,
      questionSetId: "large-r18-set",
      imageUrl: `https://example.com/large-r18-${index}.webp`,
      orderIndex: index,
      labelText: `Answer ${index + 1}`,
      labelSource: "manual" as const,
      isR18: index < 10,
      createdAt: "2026-02-01T00:00:00.000Z",
    }));
    db.sqlite.prepare(`INSERT INTO question_sets
      (id,title,created_by_player_id,is_public,image_count,manifest_version,manifest_revision,manifest_json,
       community_submission_id,community_collection_title,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        "large-r18-set",
        "大型混合题库",
        "r18-large-host",
        1,
        40,
        1,
        0,
        encodeQuestionSetManifest(questions),
        "large-r18-submission-0000000000",
        "大型混合题库",
        "2026-02-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
      );

    // 关闭 R18：30 道非 R18 恰好等于每局上限，prepared 按 30 记录。
    const prepared = await prepareQuestionSetForStart({
      roomId: room.id!,
      presenterPlayerId: "r18-large-host",
      questionSetId: "large-r18-set",
    });
    assert.equal(prepared.preparedQuestionCount, 30);

    // 滑到最大（null = 全部可用）时仍每局最多随机抽 30 道，且不含 R18。
    const started = await startGameWithQuestionSet({
      startRequestId: "large-r18-start-request",
      roomId: room.id!,
      hostPlayerId: "r18-large-host",
      presenterPlayerId: "r18-large-host",
      questionSetId: "large-r18-set",
      authorityVersion: 2 as const,
    });
    assert.equal(started.gameSession.questionCount, 30);
    const firstQuestions = started.__authorityVNextBootstrap.questions;
    assert.equal(firstQuestions.length, 30);
    assert.equal(new Set(firstQuestions.map((question) => question.id)).size, 30);
    assert.equal(firstQuestions.every((question) => question.isR18 === false), true);

    // 开启后 40 题全部可抽，仍按每局上限 30 随机抽取（可能包含 R18）。
    // 先开局（关闭态）会进入 PLAYING，因此换一个房间验证开启态。
    const roomOn = await createRoom("r18-large-host-on", "R18 Large Host On");
    await selectPresenterForRound(roomOn.id!, "r18-large-host-on", "r18-large-host-on");
    const withR18 = await updateRoomGameSettings({
      roomId: roomOn.id!,
      hostPlayerId: "r18-large-host-on",
      gameMode: "ROUND_REVEAL",
      includeR18: true,
    });
    assert.equal(withR18.includeR18, true);
    await prepareQuestionSetForStart({
      roomId: roomOn.id!,
      presenterPlayerId: "r18-large-host-on",
      questionSetId: "large-r18-set",
    });
    const preparedOn = await updateRoomGameSettings({
      roomId: roomOn.id!,
      hostPlayerId: "r18-large-host-on",
      gameMode: "ROUND_REVEAL",
    });
    assert.equal(preparedOn.preparedQuestionCount, 30);
    const startedWithR18 = await startGameWithQuestionSet({
      startRequestId: "large-r18-start-request-2",
      roomId: roomOn.id!,
      hostPlayerId: "r18-large-host-on",
      presenterPlayerId: "r18-large-host-on",
      questionSetId: "large-r18-set",
      authorityVersion: 2 as const,
    });
    assert.equal(startedWithR18.gameSession.questionCount, 30);
    const withR18Questions = startedWithR18.__authorityVNextBootstrap.questions;
    assert.equal(withR18Questions.length, 30);
    assert.equal(new Set(withR18Questions.map((question) => question.id)).size, 30);
    // 开启后“会包含 R18”由上面的全 R18 题库测试确定性证明；40 题随机抽 30 道
    // 理论上可能恰好不含 R18 题，这里不做概率性断言。
  });
});
