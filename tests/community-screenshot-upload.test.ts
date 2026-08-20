import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  constrainCommunityScreenshotDimensions,
  isCommunityScreenshotWithin1080p,
} from "../src/lib/communityScreenshotPolicy";
import type { GameDatabase, GamePreparedStatement } from "../worker/d1QueryCompat";
import worker, { type Env } from "../worker/index";
import { decodeQuestionSetManifest, encodeQuestionSetManifest } from "../worker/questionSetManifest";

const UPLOAD_SECRET = "test-community-upload-key-32-characters";
const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));
const ONE_PIXEL_WEBP = Uint8Array.from(Buffer.from(
  "UklGRiYAAABXRUJQVlA4IBoAAAAwAQCdASoBAAEAAQAaJaQAA3AA/v5HgAAAAA==",
  "base64",
));

class TestCache {
  private readonly responses = new Map<string, Response>();

  async match(request: RequestInfo | URL) {
    const key = request instanceof Request ? request.url : String(request);
    return this.responses.get(key)?.clone();
  }

  async put(request: RequestInfo | URL, response: Response) {
    const key = request instanceof Request ? request.url : String(request);
    this.responses.set(key, response.clone());
  }
}

Object.defineProperty(globalThis, "caches", {
  configurable: true,
  value: { default: new TestCache() },
});
const nativeFetch = globalThis.fetch;
let bangumiUpstreamRequestCount = 0;
let communityRemoteImageRequestCount = 0;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://api.bgm.tv/")) bangumiUpstreamRequestCount += 1;
  if (url === "https://cdni.fancaps.net/file/test-community-import.png") {
    communityRemoteImageRequestCount += 1;
    return new Response(ONE_PIXEL_PNG, {
      headers: {
        "content-type": "image/png",
        "content-length": String(ONE_PIXEL_PNG.byteLength),
      },
    });
  }
  if (url === "https://cdni.fancaps.net/file/test-community-redirect.png") {
    communityRemoteImageRequestCount += 1;
    return new Response(null, { status: 302, headers: { location: "https://example.com/private.png" } });
  }
  if (url.startsWith("https://api.bgm.tv/v0/search/subjects")) {
    return new Response(JSON.stringify({ data: [{
      id: 2,
      type: 2,
      name: "AIR",
      name_cn: "青空",
      images: null,
      rating: { score: 7.4 },
    }] }));
  }
  if (url === "https://api.bgm.tv/v0/subjects/2") {
    return new Response(JSON.stringify({ id: 2, type: 2, name: "AIR", name_cn: "青空" }));
  }
  if (url === "https://api.bgm.tv/v0/subjects/2/characters") {
    return new Response(JSON.stringify([{
      id: 3,
      type: 1,
      name: "神尾観鈴",
      relation: "主角",
      images: null,
    }]));
  }
  return nativeFetch(input, init);
};

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
  beforeNextBatch: (() => void) | null = null;

  prepare(query: string) {
    return new PreparedStatementAdapter(this.sqlite.prepare(query));
  }

  async batch<T>(statements: GamePreparedStatement[]) {
    const results: Array<{ results?: T[] }> = [];
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    beforeBatch?.();
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

function applyMigrations(sqlite: DatabaseSync, through = "9999") {
  const directory = resolve(import.meta.dirname, "..", "d1", "migrations");
  for (const name of readdirSync(directory).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    if (name.slice(0, 4) > through) break;
    sqlite.exec(readFileSync(join(directory, name), "utf8"));
  }
}

function createTestEnv() {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  const objects = new Map<string, R2Object>();
  const deletedKeys: string[] = [];
  let putCount = 0;
  const bucket = {
    async put(key: string, value: ArrayBuffer, options?: R2PutOptions) {
      putCount += 1;
      const object = {
        key,
        version: "test-version",
        size: value.byteLength,
        etag: "test-etag",
        httpEtag: '"test-etag"',
        uploaded: new Date(),
        checksums: {},
        customMetadata: options?.customMetadata,
        httpMetadata: options?.httpMetadata,
        writeHttpMetadata(headers: Headers) {
          if (options?.httpMetadata?.contentType) headers.set("content-type", options.httpMetadata.contentType);
        },
      } as R2Object;
      objects.set(key, object);
      return object;
    },
    async head(key: string) {
      return objects.get(key) ?? null;
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        deletedKeys.push(key);
        objects.delete(key);
      }
    },
  } as R2Bucket;
  const env = {
    DB: db,
    IMAGE_BUCKET: bucket,
    R2_IMAGE_PREFIX: "question-images",
    R2_PUBLIC_BASE_URL: "https://caicai.lpp.moe/api/r2-images",
    COMMUNITY_UPLOAD_SECRET: UPLOAD_SECRET,
    ALLOWED_ORIGIN: "https://caicai.lpp.moe",
  } as unknown as Env;
  return { db, env, objects, deletedKeys, getPutCount: () => putCount };
}

function uploadRequest(body: Uint8Array, key = UPLOAD_SECRET, contentType = "image/png") {
  return new Request("https://caicai.lpp.moe/api/community-screenshot-upload?filename=test.png", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-community-upload-key": key,
    },
    body,
  });
}

let submissionSequence = 0;
function finalizeRequest(payload: unknown, key = UPLOAD_SECRET) {
  const body = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { submissionId: `test-submission-${++submissionSequence}`, ...(payload as Record<string, unknown>) }
    : payload;
  return new Request("https://caicai.lpp.moe/api/community-question-set", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-community-upload-key": key,
    },
    body: JSON.stringify(body),
  });
}

function questionSetAdminRequest(
  path: string,
  options: { method?: string; body?: unknown; key?: string | null } = {},
) {
  const method = options.method ?? "GET";
  return new Request(`https://caicai.lpp.moe${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.key === null ? {} : { "x-community-upload-key": options.key ?? UPLOAD_SECRET }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

test("D1 0027 claims one canonical same-title set and backfills submission history", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, "0026");
  const insertHistoricalSet = (id: string, submissionId: string, createdAt: string) => {
    const manifest = encodeQuestionSetManifest([{
      id: `${id}-question`,
      questionSetId: id,
      imageUrl: `https://example.com/${id}.webp`,
      orderIndex: 0,
      labelText: "答案",
      labelSource: "manual",
      createdAt,
    }]);
    sqlite.prepare(`INSERT INTO question_sets (
      id,title,created_by_player_id,is_public,image_count,
      manifest_version,manifest_revision,manifest_json,
      community_submission_id,community_submission_fingerprint,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      "迁移同名题库",
      "test-player",
      1,
      1,
      1,
      0,
      manifest,
      submissionId,
      "a".repeat(64),
      createdAt,
      createdAt,
    );
  };
  insertHistoricalSet("older-set", "migration-older-submission", "2026-08-18T00:00:00.000Z");
  insertHistoricalSet("newer-set", "migration-newer-submission", "2026-08-19T00:00:00.000Z");

  sqlite.exec(readFileSync(resolve(import.meta.dirname, "..", "d1", "migrations", "0027_homepage_question_set_appends.sql"), "utf8"));
  const sets = (sqlite.prepare(`SELECT id,community_collection_title FROM question_sets ORDER BY created_at`).all() as Array<Record<string, unknown>>)
    .map((row) => ({ ...row }));
  assert.deepEqual(sets, [
    { id: "older-set", community_collection_title: null },
    { id: "newer-set", community_collection_title: "迁移同名题库" },
  ]);
  const submissions = (sqlite.prepare(`
    SELECT submission_id,question_set_id,start_order_index,added_image_count
    FROM community_question_set_submissions
    ORDER BY submission_id
  `).all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
  assert.deepEqual(submissions, [
    {
      submission_id: "migration-newer-submission",
      question_set_id: "newer-set",
      start_order_index: 0,
      added_image_count: 1,
    },
    {
      submission_id: "migration-older-submission",
      question_set_id: "older-set",
      start_order_index: 0,
      added_image_count: 1,
    },
  ]);
  assert.throws(
    () => sqlite.prepare("UPDATE question_sets SET community_collection_title=title WHERE id='older-set'").run(),
    /UNIQUE constraint failed/,
  );
});

test("1080p policy constrains landscape, portrait, and square images without enlarging", () => {
  assert.deepEqual(constrainCommunityScreenshotDimensions(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(constrainCommunityScreenshotDimensions(2160, 3840), { width: 1080, height: 1920 });
  assert.deepEqual(constrainCommunityScreenshotDimensions(2000, 2000), { width: 1080, height: 1080 });
  assert.deepEqual(constrainCommunityScreenshotDimensions(1280, 720), { width: 1280, height: 720 });
  assert.equal(isCommunityScreenshotWithin1080p(1920, 1080), true);
  assert.equal(isCommunityScreenshotWithin1080p(1080, 1920), true);
  assert.equal(isCommunityScreenshotWithin1080p(1921, 1080), false);
});

test("homepage screenshot upload requires the secret before reading or storing an image", async () => {
  const { env, getPutCount } = createTestEnv();
  const response = await worker.fetch(uploadRequest(ONE_PIXEL_PNG, "wrong-key"), env);
  assert.equal(response.status, 401);
  assert.equal(getPutCount(), 0);
  assert.deepEqual(await response.json(), { error: "上传密钥无效。" });
});

test("homepage screenshot upload reports missing configuration and rejects non-image content types", async () => {
  const { env, getPutCount } = createTestEnv();
  delete env.COMMUNITY_UPLOAD_SECRET;
  const unavailable = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  assert.equal(unavailable.status, 503);
  env.COMMUNITY_UPLOAD_SECRET = UPLOAD_SECRET;
  const wrongContentType = await worker.fetch(uploadRequest(ONE_PIXEL_PNG, UPLOAD_SECRET, "application/octet-stream"), env);
  assert.equal(wrongContentType.status, 415);
  assert.equal(getPutCount(), 0);
});

test("community question-list image proxy is keyed, allowlisted, and redirect-safe", async () => {
  const { env } = createTestEnv();
  const endpoint = "https://caicai.lpp.moe/api/community-remote-image-source";
  const makeRequest = (imageUrl: string, key?: string) => new Request(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-community-upload-key": key } : {}),
    },
    body: JSON.stringify({ imageUrl }),
  });
  const before = communityRemoteImageRequestCount;
  const unauthorized = await worker.fetch(makeRequest("https://cdni.fancaps.net/file/test-community-import.png"), env);
  assert.equal(unauthorized.status, 401);
  assert.equal(communityRemoteImageRequestCount, before);

  const unsupported = await worker.fetch(makeRequest("https://example.com/image.png", UPLOAD_SECRET), env);
  assert.equal(unsupported.status, 400);
  assert.match(JSON.stringify(await unsupported.json()), /FanCaps.*Bangumi/);
  assert.equal(communityRemoteImageRequestCount, before);

  const imported = await worker.fetch(makeRequest("https://cdni.fancaps.net/file/test-community-import.png", UPLOAD_SECRET), env);
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.equal(imported.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await imported.arrayBuffer()), ONE_PIXEL_PNG);
  assert.equal(communityRemoteImageRequestCount, before + 1);

  const redirected = await worker.fetch(makeRequest("https://cdni.fancaps.net/file/test-community-redirect.png", UPLOAD_SECRET), env);
  assert.equal(redirected.status, 400);
  assert.match(JSON.stringify(await redirected.json()), /重定向.*不允许/);
  assert.equal(communityRemoteImageRequestCount, before + 2);
});

test("Bangumi helper routes require the upload key and proxy normalized official data", async () => {
  const { env } = createTestEnv();
  const before = bangumiUpstreamRequestCount;
  const unauthorized = await worker.fetch(new Request("https://caicai.lpp.moe/api/bangumi/subjects?query=AIR"), env);
  assert.equal(unauthorized.status, 401);
  assert.equal(bangumiUpstreamRequestCount, before);

  const searchResponse = await worker.fetch(new Request("https://caicai.lpp.moe/api/bangumi/subjects?query=AIR", {
    headers: { "x-community-upload-key": UPLOAD_SECRET },
  }), env);
  assert.equal(searchResponse.status, 200);
  assert.deepEqual(await searchResponse.json(), {
    results: [{ id: 2, name: "AIR", nameCn: "青空", imageUrl: null, date: null, score: 7.4 }],
  });

  const charactersResponse = await worker.fetch(new Request("https://caicai.lpp.moe/api/bangumi/subjects/2/characters", {
    headers: { "x-community-upload-key": UPLOAD_SECRET },
  }), env);
  assert.equal(charactersResponse.status, 200);
  assert.deepEqual(await charactersResponse.json(), {
    characters: [{ id: 3, name: "神尾観鈴", relation: "主角", imageUrl: null }],
  });
});

test("homepage screenshot upload rejects forged and oversized image dimensions", async () => {
  const { env, getPutCount } = createTestEnv();
  const forged = await worker.fetch(uploadRequest(new Uint8Array([1, 2, 3, 4])), env);
  assert.equal(forged.status, 415);

  const oversized = ONE_PIXEL_PNG.slice();
  new DataView(oversized.buffer).setUint32(16, 3000, false);
  new DataView(oversized.buffer).setUint32(20, 1000, false);
  const tooWide = await worker.fetch(uploadRequest(oversized), env);
  assert.equal(tooWide.status, 422);
  assert.equal(getPutCount(), 0);
});

test("browser-style WebP uploads can be finalized as a public manifest question set", async () => {
  const { db, env, getPutCount } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_WEBP, UPLOAD_SECRET, "image/webp"), env);
  assert.equal(uploadResponse.status, 200);
  const uploaded = await uploadResponse.json() as { key: string; url: string; width: number; height: number };
  assert.match(uploaded.key, /^question-images\/community\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]+-screenshot\.webp$/);
  assert.equal(uploaded.url, `https://caicai.lpp.moe/api/r2-images/${uploaded.key}`);
  assert.deepEqual([uploaded.width, uploaded.height], [1, 1]);
  assert.equal(getPutCount(), 1);

  const response = await worker.fetch(finalizeRequest({
    title: "首页测试题库",
    description: "测试说明",
    playerId: "test-player",
    nickname: "测试上传者",
    questions: [{
      r2Key: uploaded.key,
      labelText: "测试答案",
      animeTags: [{ id: 2, name: "伪造番剧名", nameCn: "伪造中文名" }],
      characterTags: [{ id: 3, subjectId: 2, name: "伪造角色名", nameCn: "伪造角色中文名", relation: "客串" }],
    }],
  }), env);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as { id: string; title: string; imageCount: number };
  assert.equal(result.title, "首页测试题库");
  assert.equal(result.imageCount, 1);

  const row = db.sqlite.prepare("SELECT * FROM question_sets WHERE id=?").get(result.id) as Record<string, unknown>;
  assert.equal(row.is_public, 1);
  assert.equal(row.created_by_nickname, "测试上传者");
  assert.equal(row.creation_method, "player_manual");
  const questions = decodeQuestionSetManifest(row);
  assert.equal(questions?.[0].image_url, uploaded.url);
  assert.equal(questions?.[0].label_text, "测试答案");

  const indexed = db.sqlite.prepare("SELECT * FROM question_image_index WHERE question_set_id=?").get(result.id) as Record<string, unknown>;
  assert.equal(indexed.image_url, uploaded.url);
  assert.equal(indexed.answer_text, "测试答案");
  assert.equal(indexed.anime_subject_id, 2);
  assert.deepEqual(JSON.parse(indexed.anime_tags_json as string), [{ id: 2, name: "AIR", nameCn: "青空" }]);
  assert.deepEqual(JSON.parse(indexed.character_tags_json as string), [{ id: 3, subjectId: 2, name: "神尾観鈴", nameCn: null, relation: "主角" }]);
  const characterIndexed = db.sqlite.prepare(`
    SELECT question_id
    FROM question_image_index, json_each(question_image_index.character_tags_json)
    WHERE json_extract(json_each.value, '$.id')=?
  `).get(3) as { question_id: string } | undefined;
  assert.equal(characterIndexed?.question_id, indexed.question_id);

  const unauthorizedIndex = await worker.fetch(new Request("https://caicai.lpp.moe/api/community-image-index?animeSubjectId=2"), env);
  assert.equal(unauthorizedIndex.status, 401);
  const indexResponse = await worker.fetch(new Request("https://caicai.lpp.moe/api/community-image-index?animeSubjectId=2&characterId=3", {
    headers: { "x-community-upload-key": UPLOAD_SECRET },
  }), env);
  assert.equal(indexResponse.status, 200);
  const indexPayload = await indexResponse.json() as { images: Array<Record<string, unknown>> };
  assert.equal(indexPayload.images.length, 1);
  assert.equal(indexPayload.images[0].questionId, indexed.question_id);
  assert.equal("answerText" in indexPayload.images[0], false);
  assert.equal("answer_text" in indexPayload.images[0], false);
});

test("same-title homepage submissions append atomically to one ordered question set", async () => {
  const { db, env } = createTestEnv();
  const firstUpload = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const secondUpload = await worker.fetch(uploadRequest(ONE_PIXEL_WEBP, UPLOAD_SECRET, "image/webp"), env);
  const firstImage = await firstUpload.json() as { key: string };
  const secondImage = await secondUpload.json() as { key: string };
  const firstPayload = {
    submissionId: "same-title-first-submission",
    title: "同名追加题库",
    description: "首次创建时的说明",
    playerId: "first-player",
    nickname: "首位上传者",
    questions: [{ r2Key: firstImage.key, labelText: "第一题" }],
  };
  const secondPayload = {
    submissionId: "same-title-second-submission",
    title: "同名追加题库",
    description: "追加时不覆盖原说明",
    playerId: "second-player",
    nickname: "第二位上传者",
    questions: [{ r2Key: secondImage.key, labelText: "第二题" }],
  };

  const createdResponse = await worker.fetch(finalizeRequest(firstPayload), env);
  const appendedResponse = await worker.fetch(finalizeRequest(secondPayload), env);
  assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
  assert.equal(appendedResponse.status, 200, await appendedResponse.clone().text());
  const created = await createdResponse.json() as Record<string, unknown>;
  const appended = await appendedResponse.json() as Record<string, unknown>;
  assert.equal(created.appended, false);
  assert.equal(created.addedImageCount, 1);
  assert.equal(appended.id, created.id);
  assert.equal(appended.appended, true);
  assert.equal(appended.addedImageCount, 1);
  assert.equal(appended.imageCount, 2);

  const questionSet = db.sqlite.prepare("SELECT * FROM question_sets WHERE id=?").get(created.id) as Record<string, unknown>;
  assert.equal(questionSet.community_collection_title, "同名追加题库");
  assert.equal(questionSet.description, "首次创建时的说明");
  assert.equal(questionSet.created_by_nickname, "首位上传者");
  assert.equal(questionSet.image_count, 2);
  assert.equal(questionSet.manifest_revision, 1);
  assert.deepEqual(
    decodeQuestionSetManifest(questionSet)?.map((question) => [question.order_index, question.label_text]),
    [[0, "第一题"], [1, "第二题"]],
  );

  const indexed = (db.sqlite.prepare(`
    SELECT order_index,answer_text
    FROM question_image_index
    WHERE question_set_id=?
    ORDER BY order_index
  `).all(created.id) as Array<{ order_index: number; answer_text: string }>).map((row) => ({ ...row }));
  assert.deepEqual(indexed, [
    { order_index: 0, answer_text: "第一题" },
    { order_index: 1, answer_text: "第二题" },
  ]);
  const submissions = (db.sqlite.prepare(`
    SELECT submission_id,start_order_index,added_image_count
    FROM community_question_set_submissions
    WHERE question_set_id=?
    ORDER BY start_order_index
  `).all(created.id) as Array<Record<string, unknown>>).map((row) => ({ ...row }));
  assert.deepEqual(submissions, [
    { submission_id: firstPayload.submissionId, start_order_index: 0, added_image_count: 1 },
    { submission_id: secondPayload.submissionId, start_order_index: 1, added_image_count: 1 },
  ]);

  const retryResponse = await worker.fetch(finalizeRequest(secondPayload), env);
  assert.equal(retryResponse.status, 200);
  assert.deepEqual(await retryResponse.json(), appended);
  const setCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM question_sets WHERE title=?")
    .get(firstPayload.title) as { count: number };
  const submissionCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM community_question_set_submissions WHERE question_set_id=?")
    .get(created.id) as { count: number };
  assert.equal(setCount.count, 1);
  assert.equal(submissionCount.count, 2);
});

test("same-title append retries a lost manifest revision CAS without duplicating rows", async () => {
  const { db, env } = createTestEnv();
  const firstUpload = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const secondUpload = await worker.fetch(uploadRequest(ONE_PIXEL_WEBP, UPLOAD_SECRET, "image/webp"), env);
  const firstImage = await firstUpload.json() as { key: string };
  const secondImage = await secondUpload.json() as { key: string };
  const createdResponse = await worker.fetch(finalizeRequest({
    submissionId: "cas-retry-initial-submission",
    title: "CAS 重试题库",
    playerId: "test-player",
    nickname: "测试者",
    questions: [{ r2Key: firstImage.key, labelText: "原题" }],
  }), env);
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as { id: string };

  db.beforeNextBatch = () => {
    db.sqlite.prepare("UPDATE question_sets SET manifest_revision=manifest_revision+1 WHERE id=?").run(created.id);
  };
  const appendedResponse = await worker.fetch(finalizeRequest({
    submissionId: "cas-retry-appended-submission",
    title: "CAS 重试题库",
    playerId: "test-player",
    nickname: "测试者",
    questions: [{ r2Key: secondImage.key, labelText: "追加题" }],
  }), env);
  assert.equal(appendedResponse.status, 200, await appendedResponse.clone().text());
  const appended = await appendedResponse.json() as { id: string; imageCount: number; appended: boolean };
  assert.equal(appended.id, created.id);
  assert.equal(appended.imageCount, 2);
  assert.equal(appended.appended, true);
  const row = db.sqlite.prepare("SELECT * FROM question_sets WHERE id=?").get(created.id) as Record<string, unknown>;
  assert.equal(row.manifest_revision, 2);
  assert.deepEqual(decodeQuestionSetManifest(row)?.map((question) => question.label_text), ["原题", "追加题"]);
  const counts = db.sqlite.prepare(`SELECT
    (SELECT COUNT(*) FROM question_image_index WHERE question_set_id=?) AS images,
    (SELECT COUNT(*) FROM community_question_set_submissions WHERE question_set_id=?) AS submissions
  `).get(created.id, created.id) as { images: number; submissions: number };
  assert.equal(counts.images, 2);
  assert.equal(counts.submissions, 2);
});

test("same-title append rejects a submission that would exceed the 30-question set limit", async () => {
  const { db, env, objects } = createTestEnv();
  const makeStoredKey = (index: number) => {
    const key = `question-images/community/2026/08/20/00000000-0000-4000-8000-${String(index).padStart(12, "0")}-screenshot.png`;
    objects.set(key, {
      key,
      customMetadata: { uploadSource: "homepage-community" },
    } as R2Object);
    return key;
  };
  const initialKeys = Array.from({ length: 29 }, (_, index) => makeStoredKey(index));
  const overflowKeys = [makeStoredKey(29), makeStoredKey(30)];
  const createdResponse = await worker.fetch(finalizeRequest({
    submissionId: "capacity-initial-submission",
    title: "容量边界题库",
    playerId: "test-player",
    nickname: "测试者",
    questions: initialKeys.map((r2Key, index) => ({ r2Key, labelText: `答案 ${index + 1}` })),
  }), env);
  assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
  const created = await createdResponse.json() as { id: string };

  const overflowResponse = await worker.fetch(finalizeRequest({
    submissionId: "capacity-overflow-submission",
    title: "容量边界题库",
    playerId: "test-player",
    nickname: "测试者",
    questions: overflowKeys.map((r2Key, index) => ({ r2Key, labelText: `溢出 ${index + 1}` })),
  }), env);
  assert.equal(overflowResponse.status, 409);
  assert.match(JSON.stringify(await overflowResponse.json()), /已有 29 道题.*超过 30 道上限/);
  const questionSet = db.sqlite.prepare("SELECT image_count,manifest_revision FROM question_sets WHERE id=?")
    .get(created.id) as { image_count: number; manifest_revision: number };
  assert.deepEqual({ ...questionSet }, { image_count: 29, manifest_revision: 0 });
  const overflowSubmission = db.sqlite.prepare("SELECT submission_id FROM community_question_set_submissions WHERE submission_id=?")
    .get("capacity-overflow-submission");
  assert.equal(overflowSubmission, undefined);
});

test("question-set finalization rejects key tampering, duplicate objects, and unvalidated metadata", async () => {
  const { env, objects } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const base = {
    title: "边界测试",
    playerId: "test-player",
    nickname: "测试者",
  };

  const wrongPrefix = await worker.fetch(finalizeRequest({
    ...base,
    questions: [{ r2Key: uploaded.key.replace("/community/", "/other/"), labelText: "答案" }],
  }), env);
  assert.equal(wrongPrefix.status, 400);

  const duplicate = await worker.fetch(finalizeRequest({
    ...base,
    questions: [{ r2Key: uploaded.key, labelText: "答案一" }, { r2Key: uploaded.key, labelText: "答案二" }],
  }), env);
  assert.equal(duplicate.status, 400);

  const stored = objects.get(uploaded.key) as R2Object & { customMetadata?: Record<string, string> };
  stored.customMetadata = {};
  const unvalidated = await worker.fetch(finalizeRequest({
    ...base,
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  assert.equal(unvalidated.status, 400);
});

test("question-set finalize is idempotent and binds a stable submission ID to its content", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const payload = {
    submissionId: "stable-submission-123456",
    title: "幂等投稿",
    playerId: "test-player",
    nickname: "测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  };

  const first = await worker.fetch(finalizeRequest(payload), env);
  const second = await worker.fetch(finalizeRequest(payload), env);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstResult = await first.json() as { id: string };
  const secondResult = await second.json() as { id: string };
  assert.equal(secondResult.id, firstResult.id);

  const changed = await worker.fetch(finalizeRequest({
    ...payload,
    questions: [{ r2Key: uploaded.key, labelText: "被修改的答案" }],
  }), env);
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "投稿内容已发生变化，请作为一次新投稿重试。" });

  const stored = db.sqlite.prepare(`
    SELECT qs.community_submission_fingerprint AS fingerprint,
           qi.answer_text AS answer
    FROM question_sets qs
    JOIN question_image_index qi ON qi.question_set_id = qs.id
    WHERE qs.community_submission_id=?
  `).get(payload.submissionId) as { fingerprint: string; answer: string };
  assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(stored.answer, "答案");
  const count = db.sqlite.prepare("SELECT COUNT(*) AS count FROM question_sets WHERE community_submission_id=?")
    .get(payload.submissionId) as { count: number };
  assert.equal(count.count, 1);
});

test("question-set creation is atomic when image indexing fails", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  db.sqlite.exec("DROP TABLE question_image_index");

  const response = await worker.fetch(finalizeRequest({
    title: "索引回滚测试",
    playerId: "test-player",
    nickname: "测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  assert.equal(response.status, 500);
  const remaining = db.sqlite.prepare("SELECT COUNT(*) AS count FROM question_sets WHERE title=?").get("索引回滚测试") as { count: number };
  assert.equal(remaining.count, 0);
});

test("same-title append rolls back its manifest, index, and submission when indexing fails", async () => {
  const { db, env } = createTestEnv();
  const firstUpload = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const secondUpload = await worker.fetch(uploadRequest(ONE_PIXEL_WEBP, UPLOAD_SECRET, "image/webp"), env);
  const firstImage = await firstUpload.json() as { key: string };
  const secondImage = await secondUpload.json() as { key: string };
  const firstResponse = await worker.fetch(finalizeRequest({
    submissionId: "append-rollback-initial",
    title: "追加回滚题库",
    playerId: "test-player",
    nickname: "测试者",
    questions: [{ r2Key: firstImage.key, labelText: "原题" }],
  }), env);
  assert.equal(firstResponse.status, 200);
  const created = await firstResponse.json() as { id: string };
  db.sqlite.exec(`
    CREATE TRIGGER reject_appended_image_index
    BEFORE INSERT ON question_image_index
    WHEN NEW.order_index > 0
    BEGIN
      SELECT RAISE(ABORT, 'forced append index failure');
    END;
  `);

  const appendPayload = {
    submissionId: "append-rollback-second",
    title: "追加回滚题库",
    playerId: "test-player",
    nickname: "测试者",
    questions: [{ r2Key: secondImage.key, labelText: "追加题" }],
  };
  const failedResponse = await worker.fetch(finalizeRequest(appendPayload), env);
  assert.equal(failedResponse.status, 500);
  const unchanged = db.sqlite.prepare("SELECT * FROM question_sets WHERE id=?").get(created.id) as Record<string, unknown>;
  assert.equal(unchanged.image_count, 1);
  assert.equal(unchanged.manifest_revision, 0);
  assert.deepEqual(decodeQuestionSetManifest(unchanged)?.map((question) => question.label_text), ["原题"]);
  const indexCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM question_image_index WHERE question_set_id=?")
    .get(created.id) as { count: number };
  const submissionCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM community_question_set_submissions WHERE question_set_id=?")
    .get(created.id) as { count: number };
  assert.equal(indexCount.count, 1);
  assert.equal(submissionCount.count, 1);

  db.sqlite.exec("DROP TRIGGER reject_appended_image_index");
  const retryResponse = await worker.fetch(finalizeRequest(appendPayload), env);
  assert.equal(retryResponse.status, 200, await retryResponse.clone().text());
  const retried = await retryResponse.json() as { id: string; imageCount: number; appended: boolean };
  assert.deepEqual(retried, { id: created.id, title: "追加回滚题库", imageCount: 2, appended: true, addedImageCount: 1 });
});

test("question-set finalization enforces count, label, and request-body limits", async () => {
  const { env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const base = {
    title: "边界测试",
    playerId: "test-player",
    nickname: "测试者",
  };

  const tooMany = await worker.fetch(finalizeRequest({
    ...base,
    questions: Array.from({ length: 31 }, (_, index) => ({ r2Key: `${uploaded.key}-${index}` })),
  }), env);
  assert.equal(tooMany.status, 400);

  const missingLabel = await worker.fetch(finalizeRequest({
    ...base,
    questions: [{ r2Key: uploaded.key }],
  }), env);
  assert.equal(missingLabel.status, 400);
  assert.match(JSON.stringify(await missingLabel.json()), /必须填写正确答案/);

  const blankLabel = await worker.fetch(finalizeRequest({
    ...base,
    questions: [{ r2Key: uploaded.key, labelText: "   " }],
  }), env);
  assert.equal(blankLabel.status, 400);

  const unrelatedCharacter = await worker.fetch(finalizeRequest({
    ...base,
    questions: [{
      r2Key: uploaded.key,
      labelText: "答案",
      animeTags: [{ id: 2, name: "AIR", nameCn: "青空" }],
      characterTags: [{ id: 3, subjectId: 999, name: "神尾観鈴", nameCn: null, relation: "主角" }],
    }],
  }), env);
  assert.equal(unrelatedCharacter.status, 400);
  assert.match(JSON.stringify(await unrelatedCharacter.json()), /属于.*番剧/);

  const forgedMembership = await worker.fetch(finalizeRequest({
    ...base,
    questions: [{
      r2Key: uploaded.key,
      labelText: "答案",
      animeTags: [{ id: 2, name: "AIR", nameCn: "青空" }],
      characterTags: [{ id: 999, subjectId: 2, name: "伪造角色", nameCn: null, relation: "主角" }],
    }],
  }), env);
  assert.equal(forgedMembership.status, 400);
  assert.match(JSON.stringify(await forgedMembership.json()), /不属于.*Bangumi 番剧/);

  const longLabel = await worker.fetch(finalizeRequest({
    ...base,
    questions: [{ r2Key: uploaded.key, labelText: "答".repeat(101) }],
  }), env);
  assert.equal(longLabel.status, 400);
  assert.match(JSON.stringify(await longLabel.json()), /100/);

  const oversizedBody = await worker.fetch(finalizeRequest({
    ...base,
    description: "x".repeat(600 * 1024),
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  assert.equal(oversizedBody.status, 413);
});

test("question-set admin APIs require the management key and keep answers out of list responses", async () => {
  const { env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-list-detail-submission",
    title: "管理员检索题库",
    description: "仅管理接口可见答案",
    playerId: "admin-fixture-player",
    nickname: "管理测试者",
    questions: [{
      r2Key: uploaded.key,
      labelText: "管理接口秘密答案",
      animeTags: [{ id: 2, name: "AIR", nameCn: "青空" }],
      characterTags: [{ id: 3, subjectId: 2, name: "神尾観鈴", nameCn: null, relation: "主角" }],
    }],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };

  const missingKey = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets", { key: null }), env);
  const wrongKey = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets", { key: "wrong-key" }), env);
  assert.equal(missingKey.status, 401);
  assert.equal(wrongKey.status, 401);

  const listResponse = await worker.fetch(questionSetAdminRequest(
    "/api/admin/question-sets?search=%E7%AE%A1%E7%90%86%E5%91%98&visibility=public&source=uploaded&limit=20&offset=0",
  ), env);
  assert.equal(listResponse.status, 200, await listResponse.clone().text());
  const listText = await listResponse.clone().text();
  const list = JSON.parse(listText) as { items: Array<Record<string, unknown>>; total: number };
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, created.id);
  assert.equal(list.items[0].imageCount, 1);
  assert.equal(list.items[0].indexedImageCount, 1);
  assert.equal(list.items[0].isCanonicalCollection, true);
  assert.equal(listText.includes("管理接口秘密答案"), false);
  assert.equal(listText.includes("manifestJson"), false);
  assert.equal(listText.includes("fingerprint"), false);

  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
  const detail = await detailResponse.json() as {
    storageKind: string;
    questions: Array<Record<string, unknown>>;
    integrityIssues: string[];
    canDelete: boolean;
  };
  assert.equal(detail.storageKind, "manifest");
  assert.equal(detail.canDelete, true);
  assert.deepEqual(detail.integrityIssues, []);
  assert.equal(detail.questions[0].answerText, "管理接口秘密答案");
  assert.deepEqual(detail.questions[0].animeTags, [{ id: 2, name: "AIR", nameCn: "青空" }]);
  assert.deepEqual(detail.questions[0].characterTags, [{ id: 3, subjectId: 2, name: "神尾観鈴", nameCn: null, relation: "主角" }]);
});

test("question-set admin validates list bounds, methods, and mutation body limits", async () => {
  const { env } = createTestEnv();
  for (const path of [
    "/api/admin/question-sets?limit=51",
    "/api/admin/question-sets?offset=10001",
    `/api/admin/question-sets?search=${"x".repeat(101)}`,
    "/api/admin/question-sets?visibility=secret",
    "/api/admin/question-sets?source=legacy",
  ]) {
    const response = await worker.fetch(questionSetAdminRequest(path), env);
    assert.equal(response.status, 400, path);
  }

  const methodResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets", {
    method: "POST",
    body: {},
  }), env);
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "GET");
  assert.match(methodResponse.headers.get("access-control-allow-methods") ?? "", /PATCH/);
  assert.match(methodResponse.headers.get("access-control-allow-methods") ?? "", /DELETE/);

  const oversizedResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/oversized-set", {
    method: "PATCH",
    body: { title: "x".repeat(17 * 1024), expectedUpdatedAt: "2026-01-01T00:00:00.000Z" },
  }), env);
  assert.equal(oversizedResponse.status, 413);
});

test("question-set admin inspects legacy rows and fails closed for corrupt manifests", async () => {
  const { db, env } = createTestEnv();
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run("admin-legacy-set", "旧版逐题题库", "legacy-owner", 0, 1, "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  db.sqlite.prepare(`INSERT INTO questions
    (id,question_set_id,image_url,order_index,label_text,label_source,created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(
      "admin-legacy-question",
      "admin-legacy-set",
      "https://example.com/legacy.webp",
      0,
      "旧版秘密答案",
      "manual",
      "2026-02-01T00:00:00.000Z",
    );
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,manifest_version,manifest_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      "admin-corrupt-set",
      "损坏 manifest 题库",
      "corrupt-owner",
      0,
      1,
      1,
      "{not-json",
      "2026-02-02T00:00:00.000Z",
      "2026-02-02T00:00:00.000Z",
    );

  const legacyResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-legacy-set"), env);
  assert.equal(legacyResponse.status, 200, await legacyResponse.clone().text());
  const legacy = await legacyResponse.json() as { storageKind: string; questions: Array<{ answerText: string }>; canDelete: boolean };
  assert.equal(legacy.storageKind, "rows");
  assert.equal(legacy.questions[0].answerText, "旧版秘密答案");
  assert.equal(legacy.canDelete, true);

  const corruptResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-corrupt-set"), env);
  assert.equal(corruptResponse.status, 200, await corruptResponse.clone().text());
  const corrupt = await corruptResponse.json() as { storageKind: string; integrityIssues: string[]; canDelete: boolean; updatedAt: string };
  assert.equal(corrupt.storageKind, "corrupt");
  assert.equal(corrupt.canDelete, false);
  assert.match(corrupt.integrityIssues.join(" "), /manifest 无法解析/);
  const deleteResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-corrupt-set", {
    method: "DELETE",
    body: { confirmQuestionSetId: "admin-corrupt-set", expectedUpdatedAt: corrupt.updatedAt },
  }), env);
  assert.equal(deleteResponse.status, 409);
  assert.match(JSON.stringify(await deleteResponse.json()), /manifest 已损坏/);
  assert.ok(db.sqlite.prepare("SELECT id FROM question_sets WHERE id='admin-corrupt-set'").get());
});

test("question-set admin metadata updates use CAS and keep canonical collection titles consistent", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-update-submission",
    title: "管理改名前",
    playerId: "admin-update-player",
    nickname: "管理测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  const created = await finalizeResponse.json() as { id: string };
  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string };

  const staleResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "PATCH",
    body: {
      title: "不应保存",
      description: null,
      isPublic: true,
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
  }), env);
  assert.equal(staleResponse.status, 409);

  const renameResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "PATCH",
    body: {
      title: "管理改名后",
      description: "新的说明",
      isPublic: true,
      expectedUpdatedAt: detail.updatedAt,
    },
  }), env);
  assert.equal(renameResponse.status, 200, await renameResponse.clone().text());
  const renamed = await renameResponse.json() as { title: string; description: string; isPublic: boolean; isCanonicalCollection: boolean; updatedAt: string };
  assert.deepEqual({
    title: renamed.title,
    description: renamed.description,
    isPublic: renamed.isPublic,
    isCanonicalCollection: renamed.isCanonicalCollection,
  }, {
    title: "管理改名后",
    description: "新的说明",
    isPublic: true,
    isCanonicalCollection: true,
  });
  assert.notEqual(renamed.updatedAt, detail.updatedAt);
  const canonical = db.sqlite.prepare("SELECT title,community_collection_title FROM question_sets WHERE id=?")
    .get(created.id) as { title: string; community_collection_title: string };
  assert.deepEqual({ ...canonical }, { title: "管理改名后", community_collection_title: "管理改名后" });

  const unpublishResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "PATCH",
    body: {
      title: "管理改名后",
      description: "新的说明",
      isPublic: false,
      expectedUpdatedAt: renamed.updatedAt,
    },
  }), env);
  assert.equal(unpublishResponse.status, 200, await unpublishResponse.clone().text());
  const unpublished = await unpublishResponse.json() as { isPublic: boolean; isCanonicalCollection: boolean; updatedAt: string };
  assert.equal(unpublished.isPublic, false);
  assert.equal(unpublished.isCanonicalCollection, false);
  let stored = db.sqlite.prepare("SELECT is_public,community_collection_title FROM question_sets WHERE id=?")
    .get(created.id) as { is_public: number; community_collection_title: string | null };
  assert.deepEqual({ ...stored }, { is_public: 0, community_collection_title: null });

  const republishResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "PATCH",
    body: {
      title: "管理改名后",
      description: "新的说明",
      isPublic: true,
      expectedUpdatedAt: unpublished.updatedAt,
    },
  }), env);
  assert.equal(republishResponse.status, 200, await republishResponse.clone().text());
  const republished = await republishResponse.json() as { isPublic: boolean; isCanonicalCollection: boolean; updatedAt: string };
  assert.equal(republished.isPublic, true);
  assert.equal(republished.isCanonicalCollection, true);
  stored = db.sqlite.prepare("SELECT is_public,community_collection_title FROM question_sets WHERE id=?")
    .get(created.id) as { is_public: number; community_collection_title: string | null };
  assert.deepEqual({ ...stored }, { is_public: 1, community_collection_title: "管理改名后" });

  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,community_collection_title,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run("admin-title-conflict", "规范冲突标题", "conflict-owner", 1, 0, "规范冲突标题", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const collisionResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "PATCH",
    body: {
      title: "规范冲突标题",
      description: "新的说明",
      isPublic: true,
      expectedUpdatedAt: republished.updatedAt,
    },
  }), env);
  assert.equal(collisionResponse.status, 409);
  assert.match(JSON.stringify(await collisionResponse.json()), /同名规范社区题库/);
  stored = db.sqlite.prepare("SELECT is_public,community_collection_title FROM question_sets WHERE id=?")
    .get(created.id) as { is_public: number; community_collection_title: string | null };
  assert.deepEqual({ ...stored }, { is_public: 1, community_collection_title: "管理改名后" });

  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,community_submission_id,community_submission_fingerprint,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      "admin-historical-noncanonical",
      "管理改名后",
      "historical-owner",
      1,
      0,
      "admin-historical-submission",
      "b".repeat(64),
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
  const historicalUpdate = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-historical-noncanonical", {
    method: "PATCH",
    body: {
      title: "管理改名后",
      description: "只更新历史非规范题库说明",
      isPublic: true,
      expectedUpdatedAt: "2026-01-02T00:00:00.000Z",
    },
  }), env);
  assert.equal(historicalUpdate.status, 200, await historicalUpdate.clone().text());
  const historical = await historicalUpdate.json() as { isCanonicalCollection: boolean };
  assert.equal(historical.isCanonicalCollection, false);
});

test("D1 0029 admin integrity migration is transactional and idempotent", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, "0028");
  const migration = readFileSync(resolve(
    import.meta.dirname,
    "..",
    "d1",
    "migrations",
    "0029_question_set_admin_integrity.sql",
  ), "utf8");

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    sqlite.exec("ROLLBACK");
  }
  const rolledBackObjects = sqlite.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE name IN (
      'game_result_archives_question_set_id_idx',
      'rooms_prepared_question_set_insert_guard',
      'rooms_prepared_question_set_update_guard',
      'question_sets_prepared_room_delete_guard'
    )`).get() as { count: number };
  assert.equal(rolledBackObjects.count, 0);

  sqlite.exec(migration);
  sqlite.exec(migration);
  const installedObjects = sqlite.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE name IN (
      'game_result_archives_question_set_id_idx',
      'rooms_prepared_question_set_insert_guard',
      'rooms_prepared_question_set_update_guard',
      'question_sets_prepared_room_delete_guard'
    )`).get() as { count: number };
  assert.equal(installedObjects.count, 4);
  const archivePlan = sqlite.prepare(`EXPLAIN QUERY PLAN
    SELECT COUNT(*) FROM game_result_archives WHERE question_set_id=?`).all("set-id")
    .map((row) => String(row.detail)).join("\n");
  assert.match(archivePlan, /game_result_archives_question_set_id_idx/);
});

test("D1 prepared-question-set guards reject dangling room references and deletion races", () => {
  const { db } = createTestEnv();
  db.sqlite.prepare("INSERT INTO rooms (id,room_code,host_player_id) VALUES (?,?,?)")
    .run("guard-room", "GUARD1", "guard-host");
  assert.throws(
    () => db.sqlite.prepare("UPDATE rooms SET prepared_question_set_id=? WHERE id=?").run("missing-set", "guard-room"),
    /prepared question set does not exist/,
  );
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run("guard-set", "受保护题库", "guard-host", 0, 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.sqlite.prepare("UPDATE rooms SET prepared_question_set_id=? WHERE id=?").run("guard-set", "guard-room");
  assert.throws(
    () => db.sqlite.prepare("DELETE FROM question_sets WHERE id=?").run("guard-set"),
    /question set is prepared by a room/,
  );
  db.sqlite.prepare("UPDATE rooms SET prepared_question_set_id=NULL WHERE id=?").run("guard-room");
  db.sqlite.prepare("DELETE FROM question_sets WHERE id=?").run("guard-set");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM question_sets WHERE id='guard-set'").get().count, 0);
});

test("question-set admin deletion rejects active games but preserves self-contained archives", async () => {
  const { db, env, objects } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-active-game-submission",
    title: "活动游戏引用题库",
    playerId: "admin-game-player",
    nickname: "管理测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  const created = await finalizeResponse.json() as { id: string };
  db.sqlite.prepare("INSERT INTO rooms (id,room_code,host_player_id) VALUES (?,?,?)")
    .run("admin-game-room", "ADMGME", "admin-game-host");
  db.sqlite.prepare(`INSERT INTO game_sessions (id,room_id,question_set_id,presenter_player_id)
    VALUES (?,?,?,?)`)
    .run("admin-active-game", "admin-game-room", created.id, "admin-game-host");

  let detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  let detail = await detailResponse.json() as { updatedAt: string; gameSessionCount: number; archivedGameCount: number; canDelete: boolean };
  assert.equal(detail.gameSessionCount, 1);
  assert.equal(detail.canDelete, false);
  const blocked = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(blocked.status, 409);

  db.sqlite.prepare("DELETE FROM game_sessions WHERE id='admin-active-game'").run();
  db.sqlite.prepare(`INSERT INTO game_result_archives
    (game_session_id,room_id,question_set_id,archive_version,completed_at,result_json,created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(
      "admin-archived-game",
      "admin-game-room",
      created.id,
      1,
      "2026-03-01T00:00:00.000Z",
      JSON.stringify({ version: 1, questionCount: 1, leaderboard: [], questionScores: [] }),
      "2026-03-01T00:00:00.000Z",
    );
  detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  detail = await detailResponse.json() as typeof detail;
  assert.equal(detail.gameSessionCount, 0);
  assert.equal(detail.archivedGameCount, 1);
  assert.equal(detail.canDelete, true);
  const deleted = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.ok(db.sqlite.prepare("SELECT game_session_id FROM game_result_archives WHERE game_session_id='admin-archived-game'").get());
  assert.equal(objects.has(uploaded.key), false);
});

test("question-set admin deletion rejects prepared-room references", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-delete-blocked-submission",
    title: "被房间引用的题库",
    playerId: "admin-delete-player",
    nickname: "管理测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  const created = await finalizeResponse.json() as { id: string };
  db.sqlite.prepare(`INSERT INTO rooms (id,room_code,host_player_id,prepared_question_set_id) VALUES (?,?,?,?)`)
    .run("admin-reference-room", "ADMREF", "admin-reference-host", created.id);

  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string; preparedRoomCount: number; canDelete: boolean };
  assert.equal(detail.preparedRoomCount, 1);
  assert.equal(detail.canDelete, false);
  const deleteResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(deleteResponse.status, 409);
  assert.match(JSON.stringify(await deleteResponse.json()), /1 个房间引用/);
  assert.ok(db.sqlite.prepare("SELECT id FROM question_sets WHERE id=?").get(created.id));
});

test("question-set admin deletion preserves R2 images still shared by another question set", async () => {
  const { db, env, objects, deletedKeys } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string; url: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-shared-image-submission",
    title: "共享图片原题库",
    playerId: "admin-shared-player",
    nickname: "管理测试者",
    questions: [{ r2Key: uploaded.key, labelText: "共享答案" }],
  }), env);
  const created = await finalizeResponse.json() as { id: string };
  const stored = db.sqlite.prepare("SELECT manifest_json FROM question_sets WHERE id=?").get(created.id) as { manifest_json: string };
  const secondManifest = JSON.parse(stored.manifest_json) as { questions: Array<Record<string, unknown>> };
  secondManifest.questions[0].id = "admin-shared-index-question";
  secondManifest.questions[0].image_url = "https://example.com/manifest-does-not-share.webp";
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,manifest_version,manifest_revision,manifest_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(
      "admin-shared-image-set",
      "共享图片第二题库",
      "shared-owner",
      0,
      1,
      1,
      0,
      JSON.stringify(secondManifest),
      "2026-03-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    );
  db.sqlite.prepare(`INSERT INTO question_image_index
    (question_id,question_set_id,image_url,answer_text,order_index,anime_subject_id,anime_tags_json,character_tags_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      "admin-shared-index-question",
      "admin-shared-image-set",
      uploaded.url,
      "索引仍引用共享图片",
      0,
      null,
      "[]",
      "[]",
      "2026-03-01T00:00:00.000Z",
    );

  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string };
  const deleteResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(deleteResponse.status, 200, await deleteResponse.clone().text());
  const result = await deleteResponse.json() as { imageCleanup: Record<string, number> };
  assert.deepEqual(result.imageCleanup, {
    candidateCount: 1,
    deletedCount: 0,
    preservedSharedCount: 1,
    pendingCount: 0,
  });
  assert.equal(objects.has(uploaded.key), true);
  assert.deepEqual(deletedKeys, []);
});

test("question-set admin never maps an untrusted image origin to a local R2 deletion", async () => {
  const { db, env, objects, deletedKeys } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(
      "admin-untrusted-origin-set",
      "外部同路径题库",
      "external-owner",
      0,
      1,
      "2026-03-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    );
  db.sqlite.prepare(`INSERT INTO questions
    (id,question_set_id,image_url,order_index,label_text,label_source,created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(
      "admin-untrusted-origin-question",
      "admin-untrusted-origin-set",
      `https://untrusted.example/api/r2-images/${uploaded.key}`,
      0,
      "外部图片",
      "manual",
      "2026-03-01T00:00:00.000Z",
    );
  const detailResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-untrusted-origin-set"), env);
  const detail = await detailResponse.json() as { updatedAt: string };
  const deleteResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-untrusted-origin-set", {
    method: "DELETE",
    body: { confirmQuestionSetId: "admin-untrusted-origin-set", expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(deleteResponse.status, 200, await deleteResponse.clone().text());
  const result = await deleteResponse.json() as { imageCleanup: Record<string, number> };
  assert.deepEqual(result.imageCleanup, {
    candidateCount: 0,
    deletedCount: 0,
    preservedSharedCount: 0,
    pendingCount: 0,
  });
  assert.equal(objects.has(uploaded.key), true);
  assert.deepEqual(deletedKeys, []);
});

test("question-set admin R2 cleanup fails closed when another manifest is corrupt", async () => {
  const { db, env, objects, deletedKeys } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-corrupt-reference-submission",
    title: "损坏引用清理目标",
    playerId: "admin-corrupt-reference-player",
    nickname: "管理测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  const created = await finalizeResponse.json() as { id: string };
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,manifest_version,manifest_revision,manifest_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(
      "admin-corrupt-reference-set",
      "损坏引用题库",
      "corrupt-reference-owner",
      0,
      1,
      1,
      0,
      "{not-json-and-no-local-path",
      "2026-03-02T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
    );

  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string };
  const deleteResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(deleteResponse.status, 200, await deleteResponse.clone().text());
  const result = await deleteResponse.json() as { imageCleanup: Record<string, number> };
  assert.deepEqual(result.imageCleanup, {
    candidateCount: 1,
    deletedCount: 0,
    preservedSharedCount: 0,
    pendingCount: 1,
  });
  assert.equal(objects.has(uploaded.key), true);
  assert.deepEqual(deletedKeys, []);
});

test("question-set admin reports R2 deletion failures after committing the D1 deletion", async () => {
  const { db, env, objects } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-r2-failure-submission",
    title: "R2 删除失败题库",
    playerId: "admin-r2-failure-player",
    nickname: "管理测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  const created = await finalizeResponse.json() as { id: string };
  (env.IMAGE_BUCKET as R2Bucket).delete = async () => {
    throw new Error("forced R2 delete failure");
  };
  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string };
  const deleteResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(deleteResponse.status, 200, await deleteResponse.clone().text());
  const result = await deleteResponse.json() as { imageCleanup: Record<string, number> };
  assert.deepEqual(result.imageCleanup, {
    candidateCount: 1,
    deletedCount: 0,
    preservedSharedCount: 0,
    pendingCount: 1,
  });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM question_sets WHERE id=?").get(created.id).count, 0);
  assert.equal(objects.has(uploaded.key), true);
});

test("question-set admin deletion atomically removes D1 dependents and unreferenced R2 objects", async () => {
  const { db, env, objects, deletedKeys } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-delete-clean-submission",
    title: "可安全删除题库",
    playerId: "admin-delete-player",
    nickname: "管理测试者",
    questions: [{ r2Key: uploaded.key, labelText: "待删除答案" }],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };
  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string; canDelete: boolean };
  assert.equal(detail.canDelete, true);

  const wrongConfirmation = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: "another-set", expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(wrongConfirmation.status, 400);

  const deleteResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(deleteResponse.status, 200, await deleteResponse.clone().text());
  const deleted = await deleteResponse.json() as {
    deleted: boolean;
    imageCleanup: { candidateCount: number; deletedCount: number; preservedSharedCount: number; pendingCount: number };
  };
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.imageCleanup, {
    candidateCount: 1,
    deletedCount: 1,
    preservedSharedCount: 0,
    pendingCount: 0,
  });
  assert.equal(objects.has(uploaded.key), false);
  assert.deepEqual(deletedKeys, [uploaded.key]);
  const counts = db.sqlite.prepare(`SELECT
    (SELECT COUNT(*) FROM question_sets WHERE id=?) AS sets,
    (SELECT COUNT(*) FROM question_image_index WHERE question_set_id=?) AS image_indexes,
    (SELECT COUNT(*) FROM community_question_set_submissions WHERE question_set_id=?) AS submissions
  `).get(created.id, created.id, created.id) as { sets: number; image_indexes: number; submissions: number };
  assert.deepEqual({ ...counts }, { sets: 0, image_indexes: 0, submissions: 0 });
});
