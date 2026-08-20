import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { CURRENT_ROOM_RUNTIME_GENERATION } from "../src/lib/roomRuntime";
import type { GameDatabase, GamePreparedStatement } from "../worker/d1QueryCompat";
import { RoomDurableObject, RoomDurableObjectV3, type Env } from "../worker/index";
import { RoomAuthorityVNext } from "../worker/roomAuthorityVNext";
import { RoomRuntimeV3Storage } from "../worker/roomRuntimeV3";
import { decodeRoomState, encodeRoomState } from "../worker/roomStateManifest";
import type { Player } from "../src/types/game";

const root = resolve(import.meta.dirname, "..");
const migrationsDirectory = join(root, "d1", "migrations");

class Cursor<T extends Record<string, unknown>> {
  constructor(private readonly rows: T[]) {}
  toArray() { return this.rows; }
  one() {
    if (this.rows.length !== 1) throw new Error(`Expected one row, received ${this.rows.length}`);
    return this.rows[0];
  }
  get rowsRead() { return this.rows.length; }
  get rowsWritten() { return 0; }
  get columnNames() { return Object.keys(this.rows[0] ?? {}); }
  [Symbol.iterator]() { return this.rows[Symbol.iterator](); }
}

class StorageAdapter {
  readonly db = new DatabaseSync(":memory:");
  failOn = "";
  deletedAlarmCount = 0;
  private alarmAt: number | null = null;
  readonly sql = {
    exec: <T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) => {
      if (this.failOn && query.includes(this.failOn)) throw new Error("injected migration failure");
      const statement = this.db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return new Cursor(statement.all(...bindings) as T[]);
      }
      statement.run(...bindings);
      return new Cursor<T>([]);
    },
    get databaseSize() { return 0; },
  };
  transactionSync<T>(callback: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(value: number | Date) { this.alarmAt = typeof value === "number" ? value : value.getTime(); }
  async deleteAlarm() {
    this.alarmAt = null;
    this.deletedAlarmCount += 1;
  }
}

class PreparedStatementAdapter implements GamePreparedStatement {
  private bindings: unknown[] = [];
  constructor(private readonly statement: ReturnType<DatabaseSync["prepare"]>) {}
  bind(...values: unknown[]) { this.bindings = values; return this; }
  async all<T>() { return { results: this.statement.all(...this.bindings) as T[] }; }
  async first<T>() { return (this.statement.get(...this.bindings) as T | undefined) ?? null; }
}

class DatabaseAdapter implements GameDatabase {
  readonly sqlite = new DatabaseSync(":memory:");
  failNextMatching = "";
  prepare(query: string) {
    if (this.failNextMatching && query.toLowerCase().includes(this.failNextMatching.toLowerCase())) {
      this.failNextMatching = "";
      return {
        bind() { return this; },
        async all() { throw new Error("injected transient D1 failure"); },
        async first() { throw new Error("injected transient D1 failure"); },
      } as GamePreparedStatement;
    }
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

function applyMigrations(db: DatabaseSync) {
  for (const name of readdirSync(migrationsDirectory).filter((entry) => /^\d{4}_.+\.sql$/.test(entry)).sort()) {
    db.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
}

function seedRejectedTeamStart(db: DatabaseSync) {
  const players: Player[] = [
    { id: "host", roomId: "room-rejected", nickname: "Host", isHost: true, joinedAt: "2026-08-08T00:00:00.000Z", lastSeenAt: "2026-08-08T00:00:00.000Z", role: "PLAYER" },
    { id: "p1", roomId: "room-rejected", nickname: "P1", isHost: false, joinedAt: "2026-08-08T00:00:01.000Z", lastSeenAt: "2026-08-08T00:00:01.000Z", role: "PLAYER" },
  ];
  db.prepare("INSERT INTO question_sets(id,title,created_by_player_id,image_count) VALUES(?,?,?,?)")
    .run("set-rejected", "Rejected Set", "host", 1);
  db.prepare(`INSERT INTO rooms(
    id,room_code,host_player_id,game_status,current_presenter_player_id,prepared_question_set_id,
    lobby_game_mode,runtime_generation,room_state_version,room_state_revision,room_state_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    "room-rejected", "REJECT", "host", "QUESTION_SETUP", "host", "set-rejected",
    "TEAM_BATTLE", CURRENT_ROOM_RUNTIME_GENERATION, 1, 0, encodeRoomState("room-rejected", "host", players),
  );
}

function createV3State(storage: StorageAdapter, id = "room-rejected", sockets: WebSocket[] = []) {
  return {
    storage,
    id: { toString: () => id },
    blockConcurrencyWhile(callback: () => Promise<void>) { void callback(); },
    getWebSockets: () => sockets,
    waitUntil() {},
  } as unknown as DurableObjectState;
}

class TestSocket {
  sent: string[] = [];
  constructor(private attachment: unknown) {}
  deserializeAttachment() { return structuredClone(this.attachment); }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  send(value: string) { this.sent.push(value); }
  close() {}
}

function localRpc(name: string, args: unknown[]) {
  return new Request("https://room-object/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-room-object-topic": "room:room-rejected" },
    body: JSON.stringify({ name, args, clientActionId: crypto.randomUUID() }),
  });
}

test("D1 migration leaves old rooms unmarked and supports explicit current-generation rooms", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../d1/migrations/0001_initial.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id) VALUES(?,?,?)").run("old", "OLD001", "host-old");
  db.exec(readFileSync(new URL("../d1/migrations/0016_room_runtime_generation.sql", import.meta.url), "utf8"));
  assert.equal(db.prepare("SELECT runtime_generation FROM rooms WHERE id='old'").get().runtime_generation, null);
  db.prepare("INSERT INTO rooms(id,room_code,host_player_id,runtime_generation) VALUES(?,?,?,?)")
    .run("new", "NEW001", "host-new", CURRENT_ROOM_RUNTIME_GENERATION);
  assert.equal(
    db.prepare("SELECT runtime_generation FROM rooms WHERE id='new'").get().runtime_generation,
    CURRENT_ROOM_RUNTIME_GENERATION,
  );
});

test("room authority schema is minimal, idempotent, and never creates legacy projection tables", () => {
  const storage = new StorageAdapter();
  const runtime = new RoomRuntimeV3Storage(storage as unknown as DurableObjectStorage);
  runtime.initializeSchema();
  runtime.initializeSchema();
  runtime.ensureRoom("room-1");
  runtime.ensureRoom("room-1");
  const tables = storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((row) => String(row.name));
  assert.deepEqual(tables, [
    "authority_vnext_active_game",
    "authority_vnext_projection_outbox",
    "authority_vnext_question_archive",
    "room_runtime_meta",
    "room_runtime_schema",
  ]);
  for (const legacy of ["rooms", "players", "answers", "mutation_journal", "projection_outbox"]) {
    assert.equal(tables.includes(legacy), false, `legacy table should not exist: ${legacy}`);
  }
  assert.equal(storage.db.prepare("SELECT runtime_generation FROM room_runtime_meta").get().runtime_generation, CURRENT_ROOM_RUNTIME_GENERATION);
  assert.equal(runtime.bumpVersion("room-1").stateVersion, 1);
  assert.throws(() => runtime.ensureRoom("room-2"), /identity mismatch/);
});

test("rejected HTTP start removes the initializing journal without changing D1 room state", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  seedRejectedTeamStart(db.sqlite);
  const storage = new StorageAdapter();
  const state = createV3State(storage);
  const object = new RoomDurableObjectV3(state, { DB: db as unknown as D1Database } as Env);

  const response = await object.fetch(localRpc("startGameWithQuestionSet", [{
    startRequestId: "rejected-start-01",
    roomId: "room-rejected",
    hostPlayerId: "host",
    presenterPlayerId: "host",
    questionSetId: "set-rejected",
    gameMode: "TEAM_BATTLE",
  }]));
  const body = await response.json() as { error?: string };

  assert.equal(response.ok, false);
  assert.match(body.error ?? "", /至少需要 2 名答题者/);
  assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM authority_vnext_active_game").get().count, 0);
  assert.deepEqual(
    { ...db.sqlite.prepare("SELECT game_status,current_game_id,prepared_question_set_id FROM rooms WHERE id=?").get("room-rejected") },
    { game_status: "QUESTION_SETUP", current_game_id: null, prepared_question_set_id: "set-rejected" },
  );
});

test("rejected WebSocket start removes the initializing journal and returns the rule error", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  seedRejectedTeamStart(db.sqlite);
  const storage = new StorageAdapter();
  const socket = new TestSocket({
    attachmentVersion: 1,
    topic: "room:room-rejected",
    playerId: "host",
    pending: [],
    serializedBytes: 0,
  });
  const state = createV3State(storage, "room-rejected", [socket as unknown as WebSocket]);
  const object = new RoomDurableObjectV3(state, { DB: db as unknown as D1Database } as Env);

  await object.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
    type: "action",
    name: "startGameWithQuestionSet",
    clientActionId: "ws-rejected-action",
    args: [{
      startRequestId: "rejected-start-ws",
      roomId: "room-rejected",
      hostPlayerId: "host",
      presenterPlayerId: "host",
      questionSetId: "set-rejected",
      gameMode: "TEAM_BATTLE",
    }],
  }));

  const result = socket.sent.map((value) => JSON.parse(value) as { type?: string; error?: string })
    .find((message) => message.type === "action_result");
  assert.match(result?.error ?? "", /至少需要 2 名答题者/);
  assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM authority_vnext_active_game").get().count, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM game_sessions").get().count, 0);
});

test("room notice WebSocket mutation broadcasts one small delta and skips no-op versions", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  seedRejectedTeamStart(db.sqlite);
  const storage = new StorageAdapter();
  const socket = new TestSocket({
    attachmentVersion: 1,
    topic: "room:room-rejected",
    playerId: "host",
    pending: [],
    serializedBytes: 0,
  });
  const state = createV3State(storage, "room-rejected", [socket as unknown as WebSocket]);
  const object = new RoomDurableObjectV3(state, { DB: db as unknown as D1Database } as Env);
  const action = (clientActionId: string) => JSON.stringify({
    type: "action",
    name: "updateRoomNotice",
    clientActionId,
    args: [{ roomId: "room-rejected", hostPlayerId: "host", notice: "满 8 人开始" }],
  });

  await object.webSocketMessage(socket as unknown as WebSocket, action("notice-save-1"));

  const messages = socket.sent.map((value) => JSON.parse(value) as {
    type?: string;
    data?: { changed?: boolean };
    deltas?: Array<{ type?: string; roomId?: string; notice?: string }>;
  });
  const changed = messages.find((message) => message.type === "change");
  assert.deepEqual(changed?.deltas?.map((delta) => ({ type: delta.type, roomId: delta.roomId, notice: delta.notice })), [{
    type: "room_notice_updated",
    roomId: "room-rejected",
    notice: "满 8 人开始",
  }]);
  assert.equal(messages.find((message) => message.type === "action_result")?.data?.changed, true);
  assert.equal(db.sqlite.prepare("SELECT room_notice FROM rooms WHERE id='room-rejected'").get().room_notice, "满 8 人开始");
  assert.equal(storage.db.prepare("SELECT state_version FROM room_runtime_meta WHERE id=1").get().state_version, 1);

  socket.sent.length = 0;
  await object.webSocketMessage(socket as unknown as WebSocket, action("notice-save-2"));
  const noOpMessages = socket.sent.map((value) => JSON.parse(value) as { type?: string; data?: { changed?: boolean } });
  assert.equal(noOpMessages.some((message) => message.type === "change"), false);
  assert.equal(noOpMessages.find((message) => message.type === "action_result")?.data?.changed, false);
  assert.equal(storage.db.prepare("SELECT state_version FROM room_runtime_meta WHERE id=1").get().state_version, 1);
});

test("persisted rejected start self-heals before join while transient D1 failure keeps its journal", async () => {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  seedRejectedTeamStart(db.sqlite);
  const storage = new StorageAdapter();
  const state = createV3State(storage);
  const object = new RoomDurableObjectV3(state, { DB: db as unknown as D1Database } as Env);
  new RoomAuthorityVNext(state, db as unknown as D1Database).beginStart("room-rejected", "rejected-start-02", {
    startRequestId: "rejected-start-02",
    roomId: "room-rejected",
    hostPlayerId: "host",
    presenterPlayerId: "host",
    questionSetId: "set-rejected",
    gameMode: "TEAM_BATTLE",
    authorityVersion: 2,
  });

  db.failNextMatching = "rooms";
  const transientResponse = await object.fetch(localRpc("joinRoom", ["REJECT", "p2", "P2", "PLAYER"]));
  assert.equal(transientResponse.ok, false);
  assert.equal((await transientResponse.json() as { error?: string }).error, "服务发生内部错误，请查看日志。");
  assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM authority_vnext_active_game WHERE cutover_state='initializing'").get().count, 1);

  const recoveredResponse = await object.fetch(localRpc("joinRoom", ["REJECT", "p2", "P2", "PLAYER"]));
  assert.equal(recoveredResponse.ok, true);
  assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM authority_vnext_active_game").get().count, 0);
  const stored = db.sqlite.prepare("SELECT id,host_player_id,room_state_version,room_state_json FROM rooms WHERE id=?").get("room-rejected") as Parameters<typeof decodeRoomState>[0];
  assert.deepEqual(decodeRoomState(stored).map((player) => player.id), ["host", "p1", "p2"]);
});

test("V3 migration failure does not advance the schema version", () => {
  const storage = new StorageAdapter();
  storage.failOn = "authority_vnext_question_archive";
  const runtime = new RoomRuntimeV3Storage(storage as unknown as DurableObjectStorage);
  assert.throws(() => runtime.initializeSchema(), /injected migration failure/);
  assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM room_runtime_schema").get().count, 0);
  storage.failOn = "";
  runtime.initializeSchema();
  assert.equal(storage.db.prepare("SELECT version FROM room_runtime_schema WHERE id=1").get().version, 1);
});

test("retired Room DO cancels its Alarm without creating SQLite tables", async () => {
  const storage = new StorageAdapter();
  const state = {
    storage,
    getWebSockets: () => [],
  } as unknown as DurableObjectState;
  await new RoomDurableObject(state).alarm();
  assert.equal(storage.deletedAlarmCount, 1);
  assert.equal(storage.db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table'").get().count, 0);
});

test("generation 3 V3 object rejects HTTP and expires stale sockets before business restore", async () => {
  const storage = new StorageAdapter();
  const runtime = new RoomRuntimeV3Storage(storage as unknown as DurableObjectStorage);
  runtime.initializeSchema();
  runtime.ensureRoom("room-old");
  storage.db.prepare("UPDATE room_runtime_meta SET runtime_generation=3 WHERE id=1").run();
  const sent: string[] = [];
  let closeCode = 0;
  const socket = {
    send(value: string) { sent.push(value); },
    close(code: number) { closeCode = code; },
  } as unknown as WebSocket;
  const state = {
    storage,
    id: { toString: () => "room-old" },
    blockConcurrencyWhile(callback: () => Promise<void>) { void callback(); },
    getWebSockets: () => [socket],
  } as unknown as DurableObjectState;
  const env = { DB: { prepare() { throw new Error("retired object must not read D1 business state"); } } } as unknown as Env;
  const object = new RoomDurableObjectV3(state, env);

  const response = await object.fetch(new Request("https://room-object/api/rpc", { method: "POST" }));
  assert.equal(response.status, 410);
  assert.equal((await response.json() as { code: string }).code, "ROOM_VERSION_EXPIRED");
  assert.equal(storage.deletedAlarmCount, 1);
  assert.equal(closeCode, 4001);
  assert.match(sent[0] ?? "", /room_expired/);

  await object.webSocketMessage(socket, "{}");
  assert.equal(closeCode, 4001);
});

test("ended TEAM_BATTLE state cannot recreate an expired vote Alarm on a V3 wake", async () => {
  const storage = new StorageAdapter();
  const runtime = new RoomRuntimeV3Storage(storage as unknown as DurableObjectStorage);
  runtime.initializeSchema();
  runtime.ensureRoom("room-ended");
  const expiredAt = Date.now() - 60_000;
  const aggregate = {
    authorityVersion: 2,
    schemaVersion: 1,
    cutoverState: "ended",
    roomId: "room-ended",
    gameId: "game-ended",
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
    deadline: {
      kind: "team-vote",
      gameId: "game-ended",
      questionIndex: 0,
      phaseKey: "GUESS_VOTE:1",
      runAtMs: expiredAt,
    },
    gameSession: {
      id: "game-ended",
      gameMode: "TEAM_BATTLE",
      currentQuestionIndex: 0,
      teamBattleState: {
        teams: { red: ["player-red"], blue: ["player-blue"] },
        phase: "GUESS_VOTE",
        turnNumber: 1,
        voteDeadlineAt: new Date(expiredAt).toISOString(),
      },
    },
    stateVersion: 1,
    publicStateVersion: 1,
    checkpointGeneration: 1,
    lastCheckpointAtMs: Date.now(),
  };
  storage.db.prepare(`INSERT INTO authority_vnext_active_game(
    id,room_id,game_id,authority_version,schema_version,cutover_state,state_version,state_json,updated_at
  ) VALUES(1,?,?,?,?,?,?,?,?)`).run(
    "room-ended",
    "game-ended",
    2,
    1,
    "ended",
    1,
    JSON.stringify(aggregate),
    Date.now(),
  );
  await storage.setAlarm(expiredAt);
  const state = {
    storage,
    id: { toString: () => "room-ended" },
    blockConcurrencyWhile(callback: () => Promise<void>) { void callback(); },
    getWebSockets: () => [],
  } as unknown as DurableObjectState;
  const env = { DB: {} } as unknown as Env;

  await new RoomDurableObjectV3(state, env).alarm();

  assert.equal(await storage.getAlarm(), null);
  assert.equal(storage.deletedAlarmCount, 1);
  const stored = JSON.parse(String(storage.db.prepare(
    "SELECT state_json FROM authority_vnext_active_game WHERE id=1",
  ).get().state_json)) as { cutoverState: string; deadline: unknown };
  assert.equal(stored.cutoverState, "ended");
  assert.equal(stored.deadline, null);
});
