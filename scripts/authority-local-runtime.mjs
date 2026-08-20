import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = resolve(import.meta.dirname, "..");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const ROOM_COUNT = 10;
const QUESTION_COUNT = 30;
const REGULAR_PLAYERS = 17;
const EXTREME_PLAYERS = 49;
const EXTREME_SPECTATORS = 50;
const REGULAR_SPECTATORS = 2;
const REQUEST_TIMEOUT_MS = 20_000;

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function runWrangler(args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [WRANGLER, ...args], {
      cwd: ROOT,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun(output) : reject(new Error(`wrangler ${args[0]} exited ${code}\n${output.slice(-8000)}`)));
  });
}

class LocalWorker {
  constructor(port, persistTo) {
    this.port = port;
    this.persistTo = persistTo;
    this.process = null;
    this.processGroupPid = null;
    this.logs = "";
  }

  get baseUrl() { return `http://127.0.0.1:${this.port}`; }
  get wsBaseUrl() { return `ws://127.0.0.1:${this.port}`; }

  async start() {
    assert.equal(this.process, null);
    assert.equal(this.processGroupPid, null);
    const child = spawn(process.execPath, [WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", String(this.port), "--inspector-port", String(this.port + 1), "--persist-to", this.persistTo, "--show-interactive-dev-session=false", "--log-level=error"], {
      cwd: ROOT,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.process = child;
    this.processGroupPid = process.platform !== "win32" ? child.pid ?? null : null;
    child.stdout.on("data", (chunk) => { this.logs += chunk; });
    child.stderr.on("data", (chunk) => { this.logs += chunk; });
    child.once("exit", () => { if (this.process === child) this.process = null; });

    const deadline = Date.now() + 30_000;
    let lastError;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`wrangler dev stopped during startup\n${this.logs.slice(-8000)}`);
      try {
        const response = await fetch(`${this.baseUrl}/api/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "getRoomByCode", args: ["runtime-health"] }),
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return;
        lastError = new Error(`health status ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`wrangler dev did not become ready: ${String(lastError)}\n${this.logs.slice(-8000)}`);
  }

  async stop() {
    const child = this.process;
    const processGroupPid = this.processGroupPid;
    if (!child && !processGroupPid) return;
    const exited = child && child.exitCode == null
      ? new Promise((resolveExit) => child.once("exit", resolveExit))
      : Promise.resolve();
    if (child?.exitCode == null) child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
    ]);

    if (processGroupPid && this.isProcessGroupAlive(processGroupPid)) {
      this.signalProcessGroup(processGroupPid, "SIGTERM");
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && this.isProcessGroupAlive(processGroupPid)) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    }
    if (processGroupPid && this.isProcessGroupAlive(processGroupPid)) {
      this.signalProcessGroup(processGroupPid, "SIGKILL");
    } else if (child?.exitCode == null) {
      child.kill("SIGKILL");
    }
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
    if (this.process === child) this.process = null;
    this.processGroupPid = null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }

  isProcessGroupAlive(pid) {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }

  signalProcessGroup(pid, signal) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function removeTempPersistence(path) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw lastError;
}

class RuntimeMetrics {
  httpRequests = 0;
  httpErrors = 0;
  wsActions = 0;
  wsErrors = 0;
  wsInboundBytes = 0;
  wsMessages = 0;
  reconnects = 0;
  duplicateReplays = 0;
  snapshotLatencies = [];
  coldRestoreLatencies = [];
  judgementVisibleLatencies = [];
  expectedWsErrors = 0;
  hotD1RowsDuringGame = null;
  finalD1Rows = null;
  maxArchiveBytes = 0;
}

class RuntimeClient {
  constructor(worker, topic, playerId, metrics) {
    this.worker = worker;
    this.topic = topic;
    this.playerId = playerId;
    this.metrics = metrics;
    this.socket = null;
    this.pending = new Map();
    this.waiters = new Set();
    this.connectedPayload = null;
  }

  async connect(reconnect = false) {
    if (reconnect) this.metrics.reconnects += 1;
    const url = `${this.worker.wsBaseUrl}/api/realtime/${encodeURIComponent(this.topic)}/ws?playerId=${encodeURIComponent(this.playerId)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket open timeout for ${this.playerId}`)), REQUEST_TIMEOUT_MS);
      socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`WebSocket open failed for ${this.playerId}`)); }, { once: true });
    });
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) entry.reject(new Error(`WebSocket closed for ${this.playerId}`));
      this.pending.clear();
    });
    this.connectedPayload = await this.waitFor((message) => message.type === "connected");
    return this.connectedPayload;
  }

  onMessage(raw) {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    this.metrics.wsInboundBytes += Buffer.byteLength(text);
    this.metrics.wsMessages += 1;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.type === "action_result" && message.clientActionId) {
      const pending = this.pending.get(message.clientActionId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.clientActionId);
        if (message.error) {
          this.metrics.wsErrors += 1;
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.data);
        }
      }
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  waitFor(predicate, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolveWait, reject) => {
      const waiter = { predicate, resolve: resolveWait, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`WebSocket message timeout for ${this.playerId}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  action(name, args, mutation) {
    assert.equal(this.socket?.readyState, WebSocket.OPEN, `WebSocket is not open for ${this.playerId}`);
    const clientActionId = crypto.randomUUID();
    this.metrics.wsActions += 1;
    const promise = new Promise((resolveAction, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientActionId);
        reject(new Error(`Action ${name} timed out for ${this.playerId}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(clientActionId, { resolve: resolveAction, reject, timer });
    });
    this.socket.send(JSON.stringify({ type: "action", name, args, clientActionId, ...(mutation ? { mutation } : {}) }));
    return promise;
  }

  async snapshot(name, gameId) {
    const startedAt = performance.now();
    const data = await this.action(name, [gameId]);
    this.metrics.snapshotLatencies.push(performance.now() - startedAt);
    return data;
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, "local test reconnect");
    this.socket = null;
  }
}

async function rpc(worker, metrics, name, args) {
  metrics.httpRequests += 1;
  const response = await fetch(`${worker.baseUrl}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    metrics.httpErrors += 1;
    throw new Error(`${name}: non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok || payload.error) {
    metrics.httpErrors += 1;
    throw new Error(`${name}: ${payload.error ?? `HTTP ${response.status}`}`);
  }
  return payload.data;
}

async function queryLocalD1(persistTo, sql) {
  const output = await runWrangler(["d1", "execute", "DB", "--local", "--persist-to", persistTo, "--command", sql, "--json"]);
  const normalized = output.replace(/\u001b\[[0-9;]*m/g, "");
  const match = normalized.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
  if (!match) throw new Error(`Unable to parse local D1 JSON output:\n${normalized.slice(-4000)}`);
  const result = JSON.parse(match[1]);
  return result[0]?.results ?? [];
}

async function assertLegacyRoomExpired(worker) {
  for (const [name, args] of [
    ["getRoomByCode", ["OLD001"]],
    ["joinRoom", ["OLD001", "legacy-joiner", "Legacy Joiner"]],
  ]) {
    const response = await fetch(`${worker.baseUrl}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, args }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json();
    assert.equal(response.status, 410);
    assert.equal(payload.code, "ROOM_VERSION_EXPIRED");
  }

  const socket = new WebSocket(`${worker.wsBaseUrl}/api/realtime/${encodeURIComponent("room:legacy-room")}/ws?playerId=legacy-host`);
  const expired = await new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error("legacy room expiration message timeout")), REQUEST_TIMEOUT_MS);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      if (message.type !== "room_expired") return;
      clearTimeout(timer);
      resolveMessage(message);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("legacy room expiration WebSocket failed"));
    }, { once: true });
  });
  assert.equal(expired.code, "ROOM_VERSION_EXPIRED");
  socket.close();
}

function envelope(actorId, clientSeq, gameId, questionIndex, name, payload, actionId = `${gameId}:${actorId}:${clientSeq}:${name}`) {
  return { actionId, actorId, clientSeq, gameId, questionIndex, name, payload };
}

async function setupRoom(worker, metrics, roomIndex) {
  const hostId = `runtime-host-${roomIndex}`;
  const room = await rpc(worker, metrics, "createRoom", [hostId, `Host ${roomIndex}`]);
  const playerCount = roomIndex === 0 ? EXTREME_PLAYERS : REGULAR_PLAYERS;
  const spectatorCount = roomIndex === 0 ? EXTREME_SPECTATORS : REGULAR_SPECTATORS;
  const players = Array.from({ length: playerCount }, (_, index) => `runtime-r${roomIndex}-p${index}`);
  const spectators = Array.from({ length: spectatorCount }, (_, index) => `runtime-r${roomIndex}-s${index}`);
  await Promise.all([
    ...players.map((playerId, index) => rpc(worker, metrics, "joinRoom", [room.code, playerId, `R${roomIndex}P${index}`, "PLAYER"])),
    ...spectators.map((playerId, index) => rpc(worker, metrics, "joinRoom", [room.code, playerId, `R${roomIndex}S${index}`, "SPECTATOR"])),
  ]);
  await rpc(worker, metrics, "selectPresenterForRound", [room.id, hostId, hostId]);
  const questionSet = await rpc(worker, metrics, "createUploadedQuestionSet", [{
    roomId: room.id,
    presenterPlayerId: hostId,
    title: `Runtime load ${roomIndex}`,
    imageUrls: Array.from({ length: QUESTION_COUNT }, (_, index) => `https://example.com/runtime-${roomIndex}-${index}.webp`),
  }]);
  await rpc(worker, metrics, "prepareQuestionSetForStart", [{ roomId: room.id, presenterPlayerId: hostId, questionSetId: questionSet.id }]);
  const gameId = `runtime-game-${roomIndex.toString().padStart(2, "0")}-00000000`;
  const started = await rpc(worker, metrics, "startGameWithQuestionSet", [{
    startRequestId: gameId,
    roomId: room.id,
    hostPlayerId: hostId,
    presenterPlayerId: hostId,
    questionSetId: questionSet.id,
    gameMode: "ROUND_REVEAL",
    maxRevealRounds: 3,
    roundSeconds: 45,
    roundScores: [5, 3, 1],
  }]);
  return { room, hostId, players, spectators, questionSet, gameId, gameSession: started.gameSession, clients: new Map(), answerMutations: new Map(), answerIds: new Map(), hostSeq: 0 };
}

async function connectRoom(worker, metrics, context, reconnect = false) {
  const topic = `room:${context.room.id}`;
  const ids = [context.hostId, ...context.players, ...context.spectators];
  await Promise.all(ids.map(async (playerId) => {
    let client = context.clients.get(playerId);
    if (!client) {
      client = new RuntimeClient(worker, topic, playerId, metrics);
      context.clients.set(playerId, client);
    }
    client.worker = worker;
    await client.connect(reconnect);
    assert.equal(client.connectedPayload.authorityVersion, 2);
    assert.equal(client.connectedPayload.gameId, context.gameId);
  }));
}

async function openAndAnswer(context) {
  const host = context.clients.get(context.hostId);
  const confirmPayload = { gameSessionId: context.gameId, presenterPlayerId: context.hostId, selectedBlocks: [0], revealBlockCount: 45 };
  context.hostSeq += 1;
  await host.action("confirmRevealBlocks", [confirmPayload], envelope(context.hostId, context.hostSeq, context.gameId, 0, "confirmRevealBlocks", confirmPayload));
  await Promise.all(context.players.map(async (playerId) => {
    const client = context.clients.get(playerId);
    const payload = { gameSessionId: context.gameId, playerId, answerText: `runtime-answer-${context.room.id}-${playerId}` };
    const mutation = envelope(playerId, 1, context.gameId, 0, "submitAnswer", payload);
    context.answerMutations.set(playerId, mutation);
    const data = await client.action("submitAnswer", [payload], mutation);
    context.answerIds.set(playerId, data.buzzerAnswer.id);
  }));
}

async function replayAnswers(metrics, context) {
  await Promise.all(context.players.map(async (playerId) => {
    metrics.duplicateReplays += 1;
    const mutation = context.answerMutations.get(playerId);
    const payload = mutation.payload;
    await context.clients.get(playerId).action("submitAnswer", [payload], mutation);
  }));
}

async function snapshotStorm(contexts) {
  const requests = [];
  for (const context of contexts) {
    for (const client of context.clients.values()) {
      requests.push(client.snapshot("getGameBootstrapSnapshot", context.gameId));
      requests.push(client.snapshot("getRoundSnapshot", context.gameId));
    }
  }
  await Promise.all(requests);
}

async function exerciseSecondGameLifecycle(metrics, context) {
  const step = async (label, callback) => {
    try { return await callback(); } catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  };
  const host = context.clients.get(context.hostId);
  const returningPlayerId = context.players[0];
  const returningPlayer = context.clients.get(returningPlayerId);
  await returningPlayer.connect(true);

  await step("return to lobby", () => host.action("returnRoomToLobby", [context.room.id, context.hostId]));
  await step("existing player to spectator", () => returningPlayer.action("updatePlayerRole", [context.room.id, returningPlayerId, returningPlayerId, "SPECTATOR"]));
  await step("existing spectator to player", () => returningPlayer.action("updatePlayerRole", [context.room.id, returningPlayerId, returningPlayerId, "PLAYER"]));

  const latePlayerId = `${context.room.id}-second-game-late`;
  const latePlayer = new RuntimeClient(context.clients.get(context.hostId).worker, `room:${context.room.id}`, latePlayerId, metrics);
  context.clients.set(latePlayerId, latePlayer);
  await latePlayer.connect();
  const joined = await step("late spectator join", () => latePlayer.action("joinRoom", [context.room.code, latePlayerId, "Second Game Late", "SPECTATOR"]));
  assert.equal(joined.error, null);
  assert.equal(joined.room?.players.some((player) => player.id === latePlayerId), true);
  await step("late spectator to player", () => latePlayer.action("updatePlayerRole", [context.room.id, latePlayerId, latePlayerId, "PLAYER"]));

  await host.action("selectPresenterForRound", [context.room.id, context.hostId, context.hostId]);
  await host.action("prepareQuestionSetForStart", [{
    roomId: context.room.id,
    presenterPlayerId: context.hostId,
    questionSetId: context.questionSet.id,
  }]);
  const secondGameId = `${context.room.id}-second-game`;
  const started = await host.action("startGameWithQuestionSet", [{
    startRequestId: secondGameId,
    roomId: context.room.id,
    hostPlayerId: context.hostId,
    presenterPlayerId: context.hostId,
    questionSetId: context.questionSet.id,
    gameMode: "ROUND_REVEAL",
    maxRevealRounds: 3,
    roundSeconds: 45,
    roundScores: [5, 3, 1],
  }]);
  assert.equal(started.gameSession.id, secondGameId);
  assert.equal((await latePlayer.snapshot("getGameBootstrapSnapshot", secondGameId)).gameSession.status, "PLAYING");

  await host.action("cancelCurrentRound", [context.room.id, context.hostId]);
  await host.action("updateRoomGameSettings", [{
    roomId: context.room.id,
    hostPlayerId: context.hostId,
    gameMode: "ROUND_REVEAL",
    maxRevealRounds: 3,
    roundSeconds: 45,
    roundScores: [5, 3, 1],
  }]);
  const lobby = await latePlayer.action("getRoomWithPlayers", [context.room.code]);
  assert.equal(lobby.status, "LOBBY");
  assert.equal(lobby.currentGameId, null);
  assert.equal(lobby.currentPresenterPlayerId, null);
  assert.equal(lobby.preparedQuestionSetId, null);
  assert.equal(lobby.players.find((player) => player.id === returningPlayerId)?.role, "PLAYER");
  assert.equal(lobby.players.find((player) => player.id === latePlayerId)?.role, "PLAYER");
  return latePlayerId;
}

async function judgeAndCompleteFirstQuestion(metrics, context) {
  const host = context.clients.get(context.hostId);
  const visibilityStarted = performance.now();
  const visibility = context.clients.get(context.players[0]).waitFor((message) =>
    message.type === "change" && Array.isArray(message.deltas) && message.deltas.some((delta) =>
      delta.type === "answer_progress_changed" && delta.buzzerAnswers?.some((answer) => answer.status === "correct"),
    ),
  );
  const judgementPayload = {
    gameSessionId: context.gameId,
    presenterPlayerId: context.hostId,
    judgements: [...context.answerIds.values()].map((buzzerAnswerId) => ({ buzzerAnswerId, isCorrect: true })),
  };
  context.hostSeq += 1;
  await host.action("setAnswerJudgements", [judgementPayload], envelope(context.hostId, context.hostSeq, context.gameId, 0, "setAnswerJudgements", judgementPayload));
  await visibility;
  metrics.judgementVisibleLatencies.push(performance.now() - visibilityStarted);

  const settlePayload = { gameSessionId: context.gameId, presenterPlayerId: context.hostId };
  context.hostSeq += 1;
  await host.action("settleBuzzerRound", [settlePayload], envelope(context.hostId, context.hostSeq, context.gameId, 0, "settleBuzzerRound", settlePayload));
  const labelPayload = { gameSessionId: context.gameId, presenterPlayerId: context.hostId, questionId: context.questionSet.questions[0].id, labelText: "runtime correct answer", source: "manual" };
  context.hostSeq += 1;
  await host.action("updateQuestionLabel", [labelPayload], envelope(context.hostId, context.hostSeq, context.gameId, 0, "updateQuestionLabel", labelPayload));
  const advancePayload = { gameSessionId: context.gameId, presenterPlayerId: context.hostId, expectedQuestionIndex: 0 };
  context.hostSeq += 1;
  await host.action("advanceReviewedQuestion", [advancePayload], envelope(context.hostId, context.hostSeq, context.gameId, 0, "advanceReviewedQuestion", advancePayload));
}

async function finishRemainingQuestions(context) {
  const host = context.clients.get(context.hostId);
  for (let questionIndex = 1; questionIndex < QUESTION_COUNT; questionIndex += 1) {
    const payload = { gameSessionId: context.gameId, presenterPlayerId: context.hostId, expectedQuestionIndex: questionIndex };
    context.hostSeq += 1;
    await host.action("skipCurrentQuestion", [payload], envelope(context.hostId, context.hostSeq, context.gameId, questionIndex, "skipCurrentQuestion", payload));
  }
}

async function main() {
  const persistTo = await mkdtemp(join(tmpdir(), "anime-authority-runtime-"));
  assert.ok(resolve(persistTo).startsWith(resolve(tmpdir())), "temporary persistence escaped the OS temp directory");
  const port = await freePort();
  const worker = new LocalWorker(port, persistTo);
  const metrics = new RuntimeMetrics();
  const startedAt = performance.now();
  let contexts = [];
  try {
    await runWrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", persistTo]);
    await runWrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", persistTo]);
    await queryLocalD1(persistTo, `
      INSERT INTO rooms(id,room_code,host_player_id,created_at,updated_at)
      VALUES('legacy-room','OLD001','legacy-host','2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z');
      INSERT INTO players(id,room_id,nickname,is_host,role)
      VALUES('legacy-host','legacy-room','Legacy Host',1,'PLAYER');
    `);
    await worker.start();
    await assertLegacyRoomExpired(worker);
    for (let roomIndex = 0; roomIndex < ROOM_COUNT; roomIndex += 1) {
      contexts.push(await setupRoom(worker, metrics, roomIndex));
    }
    await Promise.all(contexts.map((context) => connectRoom(worker, metrics, context)));

    await snapshotStorm(contexts);
    const failureProbe = contexts[0].clients.get(contexts[0].hostId);
    await assert.rejects(() => failureProbe.snapshot("getRoundSnapshot", "missing-runtime-game"));
    metrics.expectedWsErrors += 1;
    const recoveredSnapshot = await failureProbe.snapshot("getRoundSnapshot", contexts[0].gameId);
    assert.equal(recoveredSnapshot.gameSession.id, contexts[0].gameId, "snapshot inflight did not recover after a failed read");

    await Promise.all(contexts.map(openAndAnswer));
    await worker.stop();
    const [hotRows] = await queryLocalD1(persistTo, `SELECT
      (SELECT COUNT(*) FROM answers) AS answer_rows,
      (SELECT COUNT(*) FROM buzzer_answers) AS buzzer_answer_rows,
      (SELECT COUNT(*) FROM player_scores) AS score_rows,
      (SELECT COUNT(*) FROM question_results) AS result_rows`);
    metrics.hotD1RowsDuringGame = hotRows;
    assert.deepEqual(hotRows, { answer_rows: 0, buzzer_answer_rows: 0, score_rows: 0, result_rows: 0 }, "vNext wrote D1 hot-path rows during play");
    await queryLocalD1(persistTo, `
      CREATE TABLE runtime_player_write_audit(kind TEXT NOT NULL,player_id TEXT NOT NULL);
      CREATE TRIGGER runtime_audit_player_insert AFTER INSERT ON players BEGIN INSERT INTO runtime_player_write_audit VALUES('insert',new.id); END;
      CREATE TRIGGER runtime_audit_player_update AFTER UPDATE ON players BEGIN INSERT INTO runtime_player_write_audit VALUES('update',new.id); END;
      CREATE TRIGGER runtime_audit_player_delete AFTER DELETE ON players BEGIN INSERT INTO runtime_player_write_audit VALUES('delete',old.id); END;
    `);
    for (const context of contexts) for (const client of context.clients.values()) client.close();
    await worker.start();
    await Promise.all(contexts.map((context) => connectRoom(worker, metrics, context, true)));
    await Promise.all(contexts.map((context) => replayAnswers(metrics, context)));

    const extreme = contexts[0];
    await Promise.all(extreme.players.map(async (playerId) => {
      extreme.clients.get(playerId).close();
    }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    await Promise.all(extreme.players.map((playerId) => extreme.clients.get(playerId).connect(true)));

    await snapshotStorm(contexts);
    for (const context of contexts) {
      const snapshot = await context.clients.get(context.hostId).snapshot("getRoundSnapshot", context.gameId);
      assert.equal(snapshot.answers.length, context.players.length, `lost answers in room ${context.room.id}`);
      assert.equal(new Set(snapshot.answers.map((answer) => answer.playerId)).size, context.players.length, `duplicate answers in room ${context.room.id}`);
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 3_200));
    await Promise.all(contexts.map((context) => judgeAndCompleteFirstQuestion(metrics, context)));
    await Promise.all(contexts.map(finishRemainingQuestions));

    await worker.stop();
    for (const context of contexts) for (const client of context.clients.values()) client.close();
    await worker.start();
    for (const context of contexts) {
      const host = context.clients.get(context.hostId);
      await host.connect(true);
      const coldRestoreStarted = performance.now();
      const result = await host.snapshot("getGameResultSnapshot", context.gameId);
      metrics.coldRestoreLatencies.push(performance.now() - coldRestoreStarted);
      assert.equal(result.gameSession.status, "GAME_RESULT");
      assert.equal(result.leaderboard.length, context.players.length);
      assert.equal(result.leaderboard.some((entry) => entry.playerId === context.hostId || context.spectators.includes(entry.playerId)), false);
    }

    const secondGameContext = contexts[1];
    const secondGameLatePlayerId = await exerciseSecondGameLifecycle(metrics, secondGameContext);

    for (const context of contexts) for (const client of context.clients.values()) client.close();
    await worker.stop();
    const [finalRows] = await queryLocalD1(persistTo, `SELECT
      (SELECT COUNT(*) FROM game_result_archives) AS archive_rows,
      (SELECT COUNT(*) FROM game_participants) AS participant_rows,
      (SELECT COUNT(*) FROM player_scores) AS score_rows,
      (SELECT COUNT(*) FROM question_results) AS result_rows,
      (SELECT COUNT(*) FROM runtime_player_write_audit WHERE kind='insert') AS roster_inserts,
      (SELECT COUNT(*) FROM runtime_player_write_audit WHERE kind='update') AS roster_updates,
      (SELECT COUNT(*) FROM runtime_player_write_audit WHERE kind='delete') AS roster_deletes`);
    metrics.finalD1Rows = finalRows;
    assert.deepEqual(finalRows, {
      archive_rows: ROOM_COUNT,
      participant_rows: 0,
      score_rows: 0,
      result_rows: 0,
      roster_inserts: 0,
      roster_updates: 0,
      roster_deletes: 0,
    }, "vNext final projection wrote unchanged roster or normalized result rows");
    const [aggregateRoomRows] = await queryLocalD1(persistTo, `SELECT
      COUNT(*) AS room_rows,
      SUM(CASE WHEN runtime_generation=4 AND room_state_version=1 AND json_valid(room_state_json) AND game_status IN ('GAME_RESULT','LOBBY') THEN 1 ELSE 0 END) AS valid_aggregate_rows,
      MIN(room_state_revision) AS min_revision,
      MIN(json_array_length(json_extract(room_state_json,'$.players'))) AS min_roster_size,
      MAX(json_array_length(json_extract(room_state_json,'$.players'))) AS max_roster_size
      FROM rooms WHERE runtime_generation=4`);
    assert.equal(aggregateRoomRows.room_rows, ROOM_COUNT);
    assert.equal(aggregateRoomRows.valid_aggregate_rows, ROOM_COUNT);
    assert.ok(aggregateRoomRows.min_revision >= 1, "final projection did not update aggregate room state");
    assert.equal(aggregateRoomRows.min_roster_size, 1 + REGULAR_PLAYERS + REGULAR_SPECTATORS);
    assert.equal(aggregateRoomRows.max_roster_size, 1 + EXTREME_PLAYERS + EXTREME_SPECTATORS);
    const [secondGameLobby] = await queryLocalD1(persistTo, `SELECT game_status,current_presenter_player_id,current_game_id,prepared_question_set_id,room_state_json
      FROM rooms WHERE id='${secondGameContext.room.id}'`);
    assert.equal(secondGameLobby.game_status, "LOBBY");
    assert.equal(secondGameLobby.current_presenter_player_id, null);
    assert.equal(secondGameLobby.current_game_id, null);
    assert.equal(secondGameLobby.prepared_question_set_id, null);
    assert.equal(JSON.parse(secondGameLobby.room_state_json).players.some((player) => player.id === secondGameLatePlayerId && player.role === "PLAYER"), true);
    const archiveRows = await queryLocalD1(persistTo, "SELECT game_session_id,result_json FROM game_result_archives ORDER BY game_session_id");
    assert.equal(archiveRows.length, ROOM_COUNT);
    for (const row of archiveRows) {
      const context = contexts.find((item) => item.gameId === row.game_session_id);
      assert.ok(context, `unknown archive ${row.game_session_id}`);
      const archive = JSON.parse(row.result_json);
      assert.equal(archive.version, 1);
      assert.equal(archive.questionCount, QUESTION_COUNT);
      assert.equal(archive.leaderboard.length, context.players.length);
      assert.equal(archive.questionScores.length, context.players.length, "skipped questions must not create zero-score rows");
      assert.equal(archive.leaderboard.some((entry) => entry.playerId === context.hostId || context.spectators.includes(entry.playerId)), false);
      assert.equal(archive.questionScores.some((entry) => entry.playerId === context.hostId || context.spectators.includes(entry.playerId)), false);
      assert.equal(/runtime-answer-/.test(row.result_json), false, "archive leaked answer text");
      metrics.maxArchiveBytes = Math.max(metrics.maxArchiveBytes, Buffer.byteLength(row.result_json));
    }

    const totalPeople = contexts.reduce((sum, context) => sum + 1 + context.players.length + context.spectators.length, 0) + 1;
    const result = {
      event: "authority_local_runtime_result",
      runtime: "wrangler-dev-workerd",
      rooms: contexts.length,
      totalPeople,
      extremeRoomPeople: 1 + EXTREME_PLAYERS + EXTREME_SPECTATORS,
      questionsPerRoom: QUESTION_COUNT,
      httpRequests: metrics.httpRequests,
      httpErrors: metrics.httpErrors,
      wsActions: metrics.wsActions,
      wsErrors: metrics.wsErrors,
      expectedWsErrors: metrics.expectedWsErrors,
      unexpectedWsErrors: metrics.wsErrors - metrics.expectedWsErrors,
      duplicateReplays: metrics.duplicateReplays,
      reconnects: metrics.reconnects,
      wsMessages: metrics.wsMessages,
      wsInboundBytes: metrics.wsInboundBytes,
      snapshotLatencyMs: {
        p50: Number(percentile(metrics.snapshotLatencies, 0.5).toFixed(2)),
        p95: Number(percentile(metrics.snapshotLatencies, 0.95).toFixed(2)),
        p99: Number(percentile(metrics.snapshotLatencies, 0.99).toFixed(2)),
        max: Number(Math.max(...metrics.snapshotLatencies).toFixed(2)),
      },
      coldRestoreLatencyMs: {
        p50: Number(percentile(metrics.coldRestoreLatencies, 0.5).toFixed(2)),
        p95: Number(percentile(metrics.coldRestoreLatencies, 0.95).toFixed(2)),
        max: Number(Math.max(...metrics.coldRestoreLatencies).toFixed(2)),
      },
      judgementVisibleLatencyMs: {
        p50: Number(percentile(metrics.judgementVisibleLatencies, 0.5).toFixed(2)),
        p95: Number(percentile(metrics.judgementVisibleLatencies, 0.95).toFixed(2)),
        max: Number(Math.max(...metrics.judgementVisibleLatencies).toFixed(2)),
      },
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      hotD1RowsDuringGame: metrics.hotD1RowsDuringGame,
      finalD1Rows: metrics.finalD1Rows,
      aggregateRoomRows,
      maxArchiveBytes: metrics.maxArchiveBytes,
      internalErrorLogMatches: (worker.logs.match(/服务发生内部错误|internal error/gi) ?? []).length,
    };
    assert.equal(result.httpErrors, 0);
    assert.equal(result.unexpectedWsErrors, 0);
    assert.equal(result.internalErrorLogMatches, 0);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const recentWorkerLogs = worker.logs.slice(-16_000);
    throw new Error(
      `authority local runtime failed: ${error instanceof Error ? error.message : String(error)}${recentWorkerLogs ? `\nRecent workerd logs:\n${recentWorkerLogs}` : ""}`,
      { cause: error },
    );
  } finally {
    for (const context of contexts) for (const client of context.clients.values()) client.close();
    await worker.stop();
    await removeTempPersistence(persistTo);
  }
}

await main();
