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
import { decodeQuestionSetManifest } from "../worker/questionSetManifest";

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
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://api.bgm.tv/")) bangumiUpstreamRequestCount += 1;
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

function applyMigrations(sqlite: DatabaseSync) {
  const directory = resolve(import.meta.dirname, "..", "d1", "migrations");
  for (const name of readdirSync(directory).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    sqlite.exec(readFileSync(join(directory, name), "utf8"));
  }
}

function createTestEnv() {
  const db = new DatabaseAdapter();
  applyMigrations(db.sqlite);
  const objects = new Map<string, R2Object>();
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
  } as R2Bucket;
  const env = {
    DB: db,
    IMAGE_BUCKET: bucket,
    R2_IMAGE_PREFIX: "question-images",
    R2_PUBLIC_BASE_URL: "https://caicai.lpp.moe/api/r2-images",
    COMMUNITY_UPLOAD_SECRET: UPLOAD_SECRET,
    ALLOWED_ORIGIN: "https://caicai.lpp.moe",
  } as unknown as Env;
  return { db, env, objects, getPutCount: () => putCount };
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
