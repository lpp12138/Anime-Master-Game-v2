import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker, {
  cleanupExpiredRooms,
  cleanupUnreferencedR2Objects,
  expandCleanupQuestionSetImageRows,
  type Env,
} from "../worker/index";
import { encodeQuestionSetManifest } from "../worker/questionSetManifest";
import {
  isR2ImageUploadTooLarge,
  R2_IMAGE_UPLOAD_MAX_BYTES,
  R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE,
} from "../src/lib/r2UploadPolicy";

type R2CallCounters = {
  list: number;
  put: number;
};

type CleanupTestEnvOptions = {
  enforceD1LikePatternLimit?: boolean;
  publicBaseUrl?: string;
};

function createRemoteSourceEnv(roomAllowed = true) {
  return {
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() {
            return { results: roomAllowed ? [{ id: "room" }] : [] };
          },
          async first() {
            return roomAllowed ? { id: "room" } : null;
          },
        };
      },
    },
  } as unknown as Env;
}

const D1_LIKE_PATTERN_MAX_BYTES = 50;

function createR2TestEnv() {
  const calls: R2CallCounters = { list: 0, put: 0 };
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string | null) {
      calls.put += 1;
      const size = value instanceof ArrayBuffer
        ? value.byteLength
        : ArrayBuffer.isView(value)
          ? value.byteLength
          : typeof value === "string"
            ? new TextEncoder().encode(value).byteLength
            : 0;
      return {
        key,
        version: "test-version",
        size,
        etag: "test-etag",
        httpEtag: '"test-etag"',
        uploaded: new Date(0),
        checksums: {},
        writeHttpMetadata() {},
      } as R2Object;
    },
    async list() {
      calls.list += 1;
      return {
        objects: [],
        truncated: false,
        delimitedPrefixes: [],
      } as R2Objects;
    },
  } as R2Bucket;
  const env = {
    IMAGE_BUCKET: bucket,
    R2_IMAGE_PREFIX: "question-images",
    R2_PUBLIC_BASE_URL: "https://assets.example.com",
  } as Env;
  return { calls, env };
}

function createCleanupTestEnv(options: CleanupTestEnvOptions = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const migrationsDirectory = resolve(import.meta.dirname, "..", "d1", "migrations");
  for (const name of readdirSync(migrationsDirectory).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    sqlite.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
  }
  const deletedKeys: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        let bindings: unknown[] = [];
        return {
          bind(...values: unknown[]) { bindings = values; return this; },
          async all<T>() {
            if (options.enforceD1LikePatternLimit && /\blike\s+\?/i.test(sql)) {
              const oversizedPattern = bindings.find((value) => (
                typeof value === "string"
                && new TextEncoder().encode(value).byteLength > D1_LIKE_PATTERN_MAX_BYTES
              ));
              if (oversizedPattern) {
                throw new Error("LIKE or GLOB pattern too complex");
              }
            }
            return { results: sqlite.prepare(sql).all(...bindings) as T[] };
          },
        };
      },
    },
    IMAGE_BUCKET: {
      async delete(keys: string | string[]) { deletedKeys.push(...(Array.isArray(keys) ? keys : [keys])); },
      async list() { return { objects: [], truncated: false, delimitedPrefixes: [] }; },
    },
    R2_IMAGE_PREFIX: "question-images",
    R2_PUBLIC_BASE_URL: options.publicBaseUrl ?? "https://assets.example.com",
  } as unknown as Env;
  return { deletedKeys, env, sqlite };
}

function createListedR2Object(key: string, uploaded: Date) {
  return {
    key,
    version: "test-version",
    size: 1,
    etag: "test-etag",
    httpEtag: '"test-etag"',
    uploaded,
    checksums: {},
    storageClass: "Standard",
    writeHttpMetadata() {},
  } as R2Object;
}

function insertLegacyOrphanQuestionSets(
  sqlite: DatabaseSync,
  totalImageCount: number,
  publicBaseUrl: string,
  updatedAt: string,
) {
  const insertQuestionSet = sqlite.prepare(`INSERT INTO question_sets(
    id,title,created_by_player_id,is_public,image_count,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?)`);
  const insertQuestion = sqlite.prepare(
    "INSERT INTO questions(id,question_set_id,image_url,order_index) VALUES(?,?,?,?)",
  );
  const setIds: string[] = [];
  const keyToQuestionSetId = new Map<string, string>();

  for (let imageIndex = 0; imageIndex < totalImageCount;) {
    const setIndex = setIds.length;
    const questionSetId = `bulk-set-${setIndex.toString().padStart(4, "0")}`;
    const imageCount = Math.min(30, totalImageCount - imageIndex);
    setIds.push(questionSetId);
    insertQuestionSet.run(
      questionSetId,
      `Bulk ${setIndex}`,
      "host",
      0,
      imageCount,
      updatedAt,
      updatedAt,
    );

    for (let orderIndex = 0; orderIndex < imageCount; orderIndex += 1, imageIndex += 1) {
      const key = `question-images/bulk-${imageIndex.toString().padStart(5, "0")}.webp`;
      keyToQuestionSetId.set(key, questionSetId);
      insertQuestion.run(
        `bulk-question-${imageIndex.toString().padStart(5, "0")}`,
        questionSetId,
        `${publicBaseUrl}/${key}`,
        orderIndex,
      );
    }
  }

  return { keyToQuestionSetId, setIds };
}

test("10 MB final-image policy accepts the boundary and rejects one extra byte", () => {
  assert.equal(isR2ImageUploadTooLarge(R2_IMAGE_UPLOAD_MAX_BYTES), false);
  assert.equal(isR2ImageUploadTooLarge(R2_IMAGE_UPLOAD_MAX_BYTES + 1), true);
});

test("normal uploads perform one R2 put without listing the bucket or returning capacity fields", async () => {
  const { calls, env } = createR2TestEnv();
  const response = await worker.fetch(new Request("https://api.example.com/api/r2-upload?filename=test.webp", {
    method: "POST",
    headers: { "content-type": "image/webp" },
    body: new Uint8Array([1, 2, 3]),
  }), env);

  assert.equal(response.status, 200);
  assert.equal(calls.put, 1);
  assert.equal(calls.list, 0);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(typeof payload.key, "string");
  assert.equal("storageBytes" in payload, false);
  assert.equal("storageLimitBytes" in payload, false);
});

test("a body over 10 MB is stopped by the server even when content-length is forged", async () => {
  const { calls, env } = createR2TestEnv();
  const response = await worker.fetch(new Request("https://api.example.com/api/r2-upload?filename=oversized.webp", {
    method: "POST",
    headers: {
      "content-type": "image/webp",
      "content-length": "1",
    },
    body: new Uint8Array(R2_IMAGE_UPLOAD_MAX_BYTES + 1),
  }), env);

  assert.equal(response.status, 413);
  assert.equal(calls.put, 0);
  assert.equal(calls.list, 0);
  const payload = await response.json() as { error?: string };
  assert.equal(payload.error, R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE);
});

test("the image picker lists only its requested page and does not scan for total storage", async () => {
  const { calls, env } = createR2TestEnv();
  const response = await worker.fetch(new Request("https://api.example.com/api/r2-images"), env);

  assert.equal(response.status, 200);
  assert.equal(calls.list, 1);
  assert.equal(calls.put, 0);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal("storageBytes" in payload, false);
  assert.equal("storageLimitBytes" in payload, false);
});

test("cleanup expands both legacy and manifest image references and fails safely on corruption", () => {
  const manifestJson = encodeQuestionSetManifest([{
    id: "manifest-q1",
    questionSetId: "manifest-set",
    imageUrl: "https://assets.example.com/question-images/manifest.webp",
    orderIndex: 0,
    labelText: null,
    createdAt: "2026-07-31T00:00:00.000Z",
  }]);
  const expanded = expandCleanupQuestionSetImageRows([
    { question_set_id: "legacy-set", image_url: "https://assets.example.com/question-images/legacy.webp" },
    { question_set_id: "manifest-set", image_url: null, manifest_version: 1, manifest_json: manifestJson },
    { question_set_id: "manifest-set", image_url: null, manifest_version: 1, manifest_json: manifestJson },
  ]);
  assert.deepEqual(expanded.map((row) => [row.question_set_id, row.image_url]), [
    ["legacy-set", "https://assets.example.com/question-images/legacy.webp"],
    ["manifest-set", "https://assets.example.com/question-images/manifest.webp"],
  ]);
  assert.throws(
    () => expandCleanupQuestionSetImageRows([{
      question_set_id: "broken-set",
      image_url: null,
      manifest_version: 1,
      manifest_json: "{",
    }]),
    /manifest JSON 已损坏/,
  );
});

test("cleanup avoids D1 LIKE limits and preserves an image referenced by another active manifest set", async () => {
  const publicBaseUrl = "https://assets.animaster.dpdns.org";
  const { deletedKeys, env, sqlite } = createCleanupTestEnv({
    enforceD1LikePatternLimit: true,
    publicBaseUrl,
  });
  const sharedImageUrl = `${publicBaseUrl}/question-images/shared.webp`;
  const expiredManifestJson = encodeQuestionSetManifest([{
    id: "expired-q1",
    questionSetId: "expired-set",
    imageUrl: sharedImageUrl,
    orderIndex: 0,
    labelText: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  }]);
  const activeManifestJson = encodeQuestionSetManifest([{
    id: "active-q1",
    questionSetId: "active-set",
    imageUrl: sharedImageUrl,
    orderIndex: 0,
    labelText: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  }]);
  const insertQuestionSet = sqlite.prepare(`INSERT INTO question_sets(
    id,title,created_by_player_id,is_public,image_count,manifest_version,manifest_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`);
  insertQuestionSet.run(
    "expired-set", "Expired", "host", 0, 1, 1, expiredManifestJson,
    "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z",
  );
  insertQuestionSet.run(
    "active-set", "Active", "host", 0, 1, 1, activeManifestJson,
    "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z",
  );
  const now = Date.now();
  const expiredAt = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
  const activeAt = new Date(now).toISOString();
  sqlite.prepare("INSERT INTO rooms(id,room_code,host_player_id,prepared_question_set_id,updated_at) VALUES(?,?,?,?,?)")
    .run("expired-room", "EXP001", "host", "expired-set", expiredAt);
  sqlite.prepare("INSERT INTO rooms(id,room_code,host_player_id,prepared_question_set_id,updated_at) VALUES(?,?,?,?,?)")
    .run("active-room", "ACT001", "host", "active-set", activeAt);

  await worker.scheduled({} as ScheduledController, env);

  assert.deepEqual(deletedKeys, []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM rooms WHERE id='expired-room'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM rooms WHERE id='active-room'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM question_sets WHERE id='expired-set'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM question_sets WHERE id='active-set'").get().count, 1);
});

test("authorized remote source fetch returns original bytes without Images or R2", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "image/jpeg", "content-length": "3" },
  });
  try {
    const response = await worker.fetch(new Request("https://api.example.com/api/remote-image-source", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room", presenterPlayerId: "host", imageUrl: "https://source.example.com/a.jpg" }),
    }), createRemoteSourceEnv());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote source fetch rejects unauthorized presenters before contacting the source", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return new Response(); };
  try {
    const response = await worker.fetch(new Request("https://api.example.com/api/remote-image-source", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room", presenterPlayerId: "wrong", imageUrl: "https://source.example.com/a.jpg" }),
    }), createRemoteSourceEnv(false));
    assert.equal(response.status, 400);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote source fetch blocks private hosts and SVG responses", async () => {
  const originalFetch = globalThis.fetch;
  let blockedFetchCalls = 0;
  globalThis.fetch = async () => {
    blockedFetchCalls += 1;
    return new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });
  };
  try {
    for (const imageUrl of [
      "http://127.0.0.1/a.jpg",
      "http://localhost./a.jpg",
      "http://[::1]/a.jpg",
      "http://[fd00::1]/a.jpg",
      "http://[::ffff:127.0.0.1]/a.jpg",
    ]) {
      const privateResponse = await worker.fetch(new Request("https://api.example.com/api/remote-image-source", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "room", presenterPlayerId: "host", imageUrl }),
      }), createRemoteSourceEnv());
      assert.equal(privateResponse.status, 400, imageUrl);
    }
    assert.equal(blockedFetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
  try {
    const svgResponse = await worker.fetch(new Request("https://api.example.com/api/remote-image-source", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room", presenterPlayerId: "host", imageUrl: "https://source.example.com/a.svg" }),
    }), createRemoteSourceEnv());
    assert.equal(svgResponse.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("R2 image responses prevent content sniffing and sandbox direct navigation", async () => {
  const body = new Uint8Array([1, 2, 3]);
  const env = {
    IMAGE_BUCKET: {
      async get() {
        return {
          body,
          size: body.byteLength,
          httpEtag: '"etag"',
          writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/svg+xml"); },
        };
      },
    },
  } as unknown as Env;
  const response = await worker.fetch(new Request("https://api.example.com/api/r2-images/question-images/test.svg"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
});

test("remote source fetch rejects redirects to private hosts", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.jpg" } });
  };
  try {
    const response = await worker.fetch(new Request("https://api.example.com/api/remote-image-source", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room", presenterPlayerId: "host", imageUrl: "https://source.example.com/a.jpg" }),
    }), createRemoteSourceEnv());
    assert.equal(response.status, 400);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired-room cleanup deletes more than 1000 associated images in bounded R2 batches", async () => {
  const publicBaseUrl = "https://assets.example.com";
  const { env, sqlite } = createCleanupTestEnv({ publicBaseUrl });
  const now = Date.UTC(2026, 7, 10, 0, 0, 0);
  const expiredAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();
  const { setIds } = insertLegacyOrphanQuestionSets(sqlite, 2001, publicBaseUrl, expiredAt);
  const deletedBatches: string[][] = [];
  env.IMAGE_BUCKET = {
    async list() { return { objects: [], truncated: false, delimitedPrefixes: [] }; },
    async delete(keys: string | string[]) {
      deletedBatches.push(Array.isArray(keys) ? keys : [keys]);
    },
  } as R2Bucket;

  const summary = await cleanupExpiredRooms(env, now);

  assert.deepEqual(deletedBatches.map((batch) => batch.length), [1000, 1000, 1]);
  assert.equal(summary.deletedR2KeyCount, 2001);
  assert.equal(summary.deleteBatchCount, 3);
  assert.equal(summary.failedR2KeyCount, 0);
  assert.equal(summary.deferredR2KeyCount, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM question_sets").get().count, 0);
  assert.equal(setIds.length, 67);
});

test("expired-room cleanup preserves every question set touched by a failed R2 batch", async () => {
  const publicBaseUrl = "https://assets.example.com";
  const { env, sqlite } = createCleanupTestEnv({ publicBaseUrl });
  const now = Date.UTC(2026, 7, 10, 0, 0, 0);
  const expiredAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();
  const seeded = insertLegacyOrphanQuestionSets(sqlite, 3000, publicBaseUrl, expiredAt);
  const failedKeys = new Set<string>();
  let deleteAttempt = 0;
  env.IMAGE_BUCKET = {
    async list() { return { objects: [], truncated: false, delimitedPrefixes: [] }; },
    async delete(keys: string | string[]) {
      deleteAttempt += 1;
      const keyBatch = Array.isArray(keys) ? keys : [keys];
      if (deleteAttempt === 2) {
        for (const key of keyBatch) failedKeys.add(key);
        throw new Error("temporary batch failure");
      }
    },
  } as R2Bucket;

  const errors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  let summary: Awaited<ReturnType<typeof cleanupExpiredRooms>>;
  try {
    summary = await cleanupExpiredRooms(env, now);
  } finally {
    console.error = originalConsoleError;
  }

  const affectedSetIds = new Set(
    Array.from(failedKeys, (key) => seeded.keyToQuestionSetId.get(key)).filter((id): id is string => Boolean(id)),
  );
  const remainingSetIds = new Set(
    (sqlite.prepare("SELECT id FROM question_sets").all() as Array<{ id: string }>).map((row) => row.id),
  );
  assert.equal(deleteAttempt, 3);
  assert.equal(summary.deletedR2KeyCount, 2000);
  assert.equal(summary.failedR2KeyCount, 1000);
  assert.equal(summary.deferredR2KeyCount, 0);
  assert.deepEqual(remainingSetIds, affectedSetIds);
  assert.equal(errors.filter((entry) => entry.includes('"event":"expired_room_r2_delete_failed"')).length, 1);
  assert.equal(errors[0]?.includes('"batchR2KeyCount":1000'), true);
});

test("R2 reconciliation paginates, protects referenced and recent images, and deletes all current old orphans", async () => {
  const publicBaseUrl = "https://assets.example.com";
  const { env, sqlite } = createCleanupTestEnv({ publicBaseUrl });
  const now = Date.UTC(2026, 7, 4, 0, 0, 0);
  const oldUploaded = new Date(now - 4 * 24 * 60 * 60 * 1000);
  const recentUploaded = new Date(now - 24 * 60 * 60 * 1000);
  const legacyKey = "question-images/referenced-legacy.webp";
  const manifestKey = "question-images/referenced-manifest.webp";
  const recentKey = "question-images/recent-orphan.webp";
  const oldOrphanKeys = Array.from(
    { length: 2501 },
    (_, index) => `question-images/old-orphan-${index.toString().padStart(4, "0")}.webp`,
  );
  const manifestJson = encodeQuestionSetManifest([{
    id: "manifest-q1",
    questionSetId: "manifest-set",
    imageUrl: `${publicBaseUrl}/${manifestKey}`,
    orderIndex: 0,
    labelText: null,
    createdAt: oldUploaded.toISOString(),
  }]);
  const insertQuestionSet = sqlite.prepare(`INSERT INTO question_sets(
    id,title,created_by_player_id,is_public,image_count,manifest_version,manifest_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`);
  insertQuestionSet.run(
    "legacy-set", "Legacy", "host", 1, 1, null, null, oldUploaded.toISOString(), oldUploaded.toISOString(),
  );
  insertQuestionSet.run(
    "manifest-set", "Manifest", "host", 0, 1, 1, manifestJson, oldUploaded.toISOString(), oldUploaded.toISOString(),
  );
  sqlite.prepare("INSERT INTO questions(id,question_set_id,image_url,order_index) VALUES(?,?,?,?)")
    .run("legacy-q1", "legacy-set", `${publicBaseUrl}/${legacyKey}`, 0);

  const listedObjects = [
    createListedR2Object(legacyKey, oldUploaded),
    createListedR2Object(manifestKey, oldUploaded),
    createListedR2Object(recentKey, recentUploaded),
    ...oldOrphanKeys.map((key) => createListedR2Object(key, oldUploaded)),
  ];
  const deletedBatches: string[][] = [];
  let listCalls = 0;
  env.IMAGE_BUCKET = {
    async list(options = {}) {
      listCalls += 1;
      const start = options.cursor ? Number(options.cursor) : 0;
      const end = Math.min(start + 400, listedObjects.length);
      const objects = listedObjects.slice(start, end);
      return end < listedObjects.length
        ? { objects, truncated: true, cursor: String(end), delimitedPrefixes: [] }
        : { objects, truncated: false, delimitedPrefixes: [] };
    },
    async delete(keys: string | string[]) {
      deletedBatches.push(Array.isArray(keys) ? keys : [keys]);
    },
  } as R2Bucket;

  const summary = await cleanupUnreferencedR2Objects(env, now);

  const deletedKeys = deletedBatches.flat();
  assert.equal(listCalls, 7);
  assert.equal(summary.deletedR2KeyCount, 2501);
  assert.equal(summary.deleteBatchCount, 3);
  assert.deepEqual(deletedBatches.map((batch) => batch.length), [1000, 1000, 501]);
  assert.equal(deletedKeys.includes(legacyKey), false);
  assert.equal(deletedKeys.includes(manifestKey), false);
  assert.equal(deletedKeys.includes(recentKey), false);
  assert.equal(oldOrphanKeys.filter((key) => deletedKeys.includes(key)).length, 2501);
});

test("R2 reconciliation caps one run at 10000 keys and keeps every delete call at 1000", async () => {
  const { env } = createCleanupTestEnv();
  const now = Date.UTC(2026, 7, 10, 0, 0, 0);
  const oldUploaded = new Date(now - 4 * 24 * 60 * 60 * 1000);
  const listedObjects = Array.from(
    { length: 10001 },
    (_, index) => createListedR2Object(
      `question-images/capped-orphan-${index.toString().padStart(5, "0")}.webp`,
      oldUploaded,
    ),
  );
  const deletedBatches: string[][] = [];
  let listCalls = 0;
  env.IMAGE_BUCKET = {
    async list(options = {}) {
      listCalls += 1;
      const start = options.cursor ? Number(options.cursor) : 0;
      const end = Math.min(start + 1000, listedObjects.length);
      return end < listedObjects.length
        ? { objects: listedObjects.slice(start, end), truncated: true, cursor: String(end), delimitedPrefixes: [] }
        : { objects: listedObjects.slice(start, end), truncated: false, delimitedPrefixes: [] };
    },
    async delete(keys: string | string[]) {
      deletedBatches.push(Array.isArray(keys) ? keys : [keys]);
    },
  } as R2Bucket;

  const summary = await cleanupUnreferencedR2Objects(env, now);

  assert.equal(listCalls, 10);
  assert.equal(summary.deletedR2KeyCount, 10000);
  assert.equal(summary.deleteBatchCount, 10);
  assert.equal(summary.listingStoppedAtDeleteLimit, true);
  assert.equal(deletedBatches.length, 10);
  assert.equal(deletedBatches.every((batch) => batch.length === 1000), true);
  assert.equal(deletedBatches.flat().includes(listedObjects[10000].key), false);
});

test("scheduled cleanup runs R2 reconciliation after expired-room cleanup fails", async () => {
  const { env } = createCleanupTestEnv();
  const originalDb = env.DB;
  let failNextPrepare = true;
  env.DB = new Proxy(originalDb, {
    get(target, property, receiver) {
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (sql: string) => {
        if (failNextPrepare) {
          failNextPrepare = false;
          throw new Error("temporary expired-room query failure");
        }
        return target.prepare(sql);
      };
    },
  });
  let listCalls = 0;
  env.IMAGE_BUCKET = {
    async list() {
      listCalls += 1;
      return { objects: [], truncated: false, delimitedPrefixes: [] };
    },
    async delete() {},
  } as R2Bucket;
  const errors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    await worker.scheduled({} as ScheduledController, env);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(listCalls, 1);
  assert.equal(errors.filter((entry) => entry.includes('"event":"expired_room_cleanup_failed"')).length, 1);
});

test("scheduled cleanup isolates R2 reconciliation failures and retries on the next run", async () => {
  const { env, sqlite } = createCleanupTestEnv();
  const now = Date.now();
  const expiredAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();
  sqlite.prepare(`INSERT INTO question_sets(
    id,title,created_by_player_id,is_public,image_count,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?)`).run("expired-set", "Expired", "host", 0, 1, expiredAt, expiredAt);
  sqlite.prepare("INSERT INTO questions(id,question_set_id,image_url,order_index) VALUES(?,?,?,?)")
    .run("expired-q1", "expired-set", "https://example.com/not-r2.webp", 0);
  sqlite.prepare("INSERT INTO rooms(id,room_code,host_player_id,prepared_question_set_id,updated_at) VALUES(?,?,?,?,?)")
    .run("expired-room", "EXP002", "host", "expired-set", expiredAt);

  const orphanKey = "question-images/retry-orphan.webp";
  const orphanObject = createListedR2Object(orphanKey, new Date(now - 4 * 24 * 60 * 60 * 1000));
  let listAttempts = 0;
  let deleteAttempts = 0;
  const deletedKeys: string[] = [];
  env.IMAGE_BUCKET = {
    async list() {
      listAttempts += 1;
      if (listAttempts === 1) throw new Error("temporary list failure");
      return { objects: [orphanObject], truncated: false, delimitedPrefixes: [] };
    },
    async delete(keys: string | string[]) {
      deleteAttempts += 1;
      if (deleteAttempts === 1) throw new Error("temporary delete failure");
      deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  } as R2Bucket;

  const errors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    await worker.scheduled({} as ScheduledController, env);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM rooms WHERE id='expired-room'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM question_sets WHERE id='expired-set'").get().count, 0);

    await worker.scheduled({} as ScheduledController, env);
    await worker.scheduled({} as ScheduledController, env);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(listAttempts, 3);
  assert.equal(deleteAttempts, 2);
  assert.deepEqual(deletedKeys, [orphanKey]);
  assert.equal(errors.filter((entry) => entry.includes('"event":"unreferenced_r2_cleanup_failed"')).length, 2);
});
