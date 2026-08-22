import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const DELETE_SECRET = "test-question-set-delete-key-32-characters";
const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));
const ONE_PIXEL_WEBP = Uint8Array.from(Buffer.from(
  "UklGRiYAAABXRUJQVlA4IBoAAAAwAQCdASoBAAEAAQAaJaQAA3AA/v5HgAAAAA==",
  "base64",
));

function imageVariant(bytes: Uint8Array, marker: number) {
  const variant = bytes.slice();
  variant[variant.length - 1] ^= marker & 0xff;
  return variant;
}

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
    let types: number[] = [2];
    try {
      const raw = init?.body ? await new Response(init.body).text() : "";
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.filter?.type)) types = parsed.filter.type.map(Number);
    } catch {
      // 读取失败时按动画范围处理，不影响断言。
    }
    const data = [{
      id: 2,
      type: 2,
      name: "AIR",
      name_cn: "青空",
      images: null,
      rating: { score: 7.4 },
    }];
    if (types.includes(4)) {
      data.push({
        id: 104999,
        type: 4,
        name: "AIR 游戏",
        name_cn: "青空（游戏）",
        images: null,
        rating: { score: 8.2 },
      });
    }
    return new Response(JSON.stringify({ data }));
  }
  if (url === "https://api.bgm.tv/v0/subjects/2") {
    return new Response(JSON.stringify({
      id: 2,
      type: 2,
      name: "AIR",
      name_cn: "青空",
      date: "2005-01-06",
      tags: [
        { name: "催泪", count: 10 },
        { name: "治愈", count: 5 },
        { name: "催泪", count: 9 },
        { name: "", count: 1 },
      ],
    }));
  }
  if (url === "https://api.bgm.tv/v0/subjects/104999") {
    return new Response(JSON.stringify({
      id: 104999,
      type: 4,
      name: "AIR 游戏",
      name_cn: "青空（游戏）",
      date: "2001-06-20",
      tags: [{ name: "游戏改", count: 3 }],
    }));
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
  if (url === "https://api.bgm.tv/v0/subjects/104999/characters") {
    return new Response(JSON.stringify([{
      id: 5001,
      type: 1,
      name: "游戏角色",
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
      const etag = createHash("md5").update(new Uint8Array(value)).digest("hex");
      const object = {
        key,
        version: "test-version",
        size: value.byteLength,
        etag,
        httpEtag: `"${etag}"`,
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
    QUESTION_SET_DELETE_SECRET: DELETE_SECRET,
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
  options: { method?: string; body?: unknown; key?: string | null; deleteKey?: string | null } = {},
) {
  const method = options.method ?? "GET";
  return new Request(`https://caicai.lpp.moe${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.key === null ? {} : { "x-community-upload-key": options.key ?? UPLOAD_SECRET }),
      ...(options.deleteKey === null ? {} : { "x-question-set-delete-key": options.deleteKey ?? DELETE_SECRET }),
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
    results: [{ id: 2, name: "AIR", nameCn: "青空", subjectType: 2, imageUrl: null, date: null, score: 7.4 }],
  });
  assert.equal(bangumiUpstreamRequestCount, before + 1);

  // 同一关键词的 game 范围走独立的缓存键，需要重新访问上游。
  const gameResponse = await worker.fetch(new Request("https://caicai.lpp.moe/api/bangumi/subjects?query=AIR&scope=game", {
    headers: { "x-community-upload-key": UPLOAD_SECRET },
  }), env);
  assert.equal(gameResponse.status, 200);
  assert.deepEqual(await gameResponse.json(), {
    results: [{ id: 104999, name: "AIR 游戏", nameCn: "青空（游戏）", subjectType: 4, imageUrl: null, date: null, score: 8.2 }],
  });

  const allResponse = await worker.fetch(new Request("https://caicai.lpp.moe/api/bangumi/subjects?query=AIR&scope=all", {
    headers: { "x-community-upload-key": UPLOAD_SECRET },
  }), env);
  assert.equal(allResponse.status, 200);
  assert.deepEqual(await allResponse.json(), {
    results: [
      { id: 2, name: "AIR", nameCn: "青空", subjectType: 2, imageUrl: null, date: null, score: 7.4 },
      { id: 104999, name: "AIR 游戏", nameCn: "青空（游戏）", subjectType: 4, imageUrl: null, date: null, score: 8.2 },
    ],
  });
  assert.equal(bangumiUpstreamRequestCount, before + 3);

  // 三个范围各自的缓存已生效，重复请求不再访问上游。
  for (const scope of ["anime", "game", "all"]) {
    const cached = await worker.fetch(new Request(
      `https://caicai.lpp.moe/api/bangumi/subjects?query=AIR&scope=${scope}`,
      { headers: { "x-community-upload-key": UPLOAD_SECRET } },
    ), env);
    assert.equal(cached.status, 200);
  }
  assert.equal(bangumiUpstreamRequestCount, before + 3);

  const invalidScope = await worker.fetch(new Request("https://caicai.lpp.moe/api/bangumi/subjects?query=AIR&scope=book", {
    headers: { "x-community-upload-key": UPLOAD_SECRET },
  }), env);
  assert.equal(invalidScope.status, 400);
  assert.match(JSON.stringify(await invalidScope.json()), /搜索范围仅支持/);
  assert.equal(bangumiUpstreamRequestCount, before + 3);

  const charactersResponse = await worker.fetch(new Request("https://caicai.lpp.moe/api/bangumi/subjects/2/characters", {
    headers: { "x-community-upload-key": UPLOAD_SECRET },
  }), env);
  assert.equal(charactersResponse.status, 200);
  assert.deepEqual(await charactersResponse.json(), {
    characters: [{ id: 3, name: "神尾観鈴", relation: "主角", imageUrl: null }],
  });
});

test("Bangumi game subjects are canonicalized with subjectType 4 and their own official casts", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  assert.equal(uploadResponse.status, 200);
  const uploaded = await uploadResponse.json() as { key: string };

  const response = await worker.fetch(finalizeRequest({
    title: "游戏题库",
    playerId: "game-player",
    nickname: "游戏测试者",
    questions: [{
      r2Key: uploaded.key,
      labelText: "AIR 游戏",
      animeTags: [{ id: 104999, name: "伪造游戏名", nameCn: null, subjectType: 4 }],
      characterTags: [{ id: 5001, subjectId: 104999, name: "伪造角色名", nameCn: null, relation: "客串" }],
    }],
  }), env);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as { id: string };

  const indexed = db.sqlite.prepare("SELECT * FROM question_image_index WHERE question_set_id=?").get(result.id) as Record<string, unknown>;
  assert.equal(indexed.anime_subject_id, 104999);
  assert.deepEqual(JSON.parse(indexed.anime_tags_json as string), [
    { id: 104999, name: "AIR 游戏", nameCn: "青空（游戏）", subjectType: 4 },
  ]);
  assert.deepEqual(JSON.parse(indexed.character_tags_json as string), [
    { id: 5001, subjectId: 104999, name: "游戏角色", nameCn: null, relation: "主角" },
  ]);
  // 官方 subject 详情中的属性标签（去重、有界）与首播年份一并持久化。
  assert.deepEqual(JSON.parse(indexed.anime_genre_tags_json as string), [
    { name: "游戏改", count: 3 },
  ]);
  assert.equal(indexed.anime_release_year, 2001);

  // 游戏条目不接受来自其他 subject 的角色。使用另一张图片，避免先被全局 MD5 去重拦截。
  const wrongCastUploadResponse = await worker.fetch(
    uploadRequest(imageVariant(ONE_PIXEL_PNG, 2), UPLOAD_SECRET, "image/png"),
    env,
  );
  assert.equal(wrongCastUploadResponse.status, 200);
  const wrongCastUpload = await wrongCastUploadResponse.json() as { key: string };
  const wrongCast = await worker.fetch(finalizeRequest({
    title: "游戏题库错误角色",
    playerId: "game-player",
    nickname: "游戏测试者",
    questions: [{
      r2Key: wrongCastUpload.key,
      labelText: "AIR 游戏",
      animeTags: [{ id: 104999, name: "AIR 游戏", nameCn: null, subjectType: 4 }],
      characterTags: [{ id: 3, subjectId: 104999, name: "神尾観鈴", nameCn: null, relation: "主角" }],
    }],
  }), env);
  assert.equal(wrongCast.status, 400);
  assert.match(JSON.stringify(await wrongCast.json()), /不属于所选 Bangumi 作品/);
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
  assert.deepEqual(JSON.parse(indexed.anime_tags_json as string), [{ id: 2, name: "AIR", nameCn: "青空", subjectType: 2 }]);
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

test("community upload reports an exact MD5 already present in the question bank and removes the rejected object", async () => {
  const { db, env, objects, deletedKeys, getPutCount } = createTestEnv();
  const firstUploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  assert.equal(firstUploadResponse.status, 200);
  const firstUpload = await firstUploadResponse.json() as { key: string; imageMd5: string };
  assert.match(firstUpload.imageMd5, /^[0-9a-f]{32}$/);
  const finalized = await worker.fetch(finalizeRequest({
    submissionId: "md5-existing-first-submission",
    title: "MD5 已有题库",
    playerId: "md5-player",
    nickname: "MD5 上传者",
    questions: [{ r2Key: firstUpload.key, labelText: "已有题" }],
  }), env);
  assert.equal(finalized.status, 200, await finalized.clone().text());
  assert.equal(
    (db.sqlite.prepare("SELECT image_md5 FROM question_image_index").get() as { image_md5: string }).image_md5,
    firstUpload.imageMd5,
  );

  const duplicateResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  assert.equal(duplicateResponse.status, 409);
  const duplicate = await duplicateResponse.json() as {
    error: string;
    code: string;
    existing: { questionSetTitle: string; orderIndex: number };
  };
  assert.equal(duplicate.code, "COMMUNITY_IMAGE_DUPLICATE");
  assert.match(duplicate.error, /题库已有.*MD5 已有题库.*第 1 题/);
  assert.deepEqual(duplicate.existing, {
    questionId: (db.sqlite.prepare("SELECT question_id FROM question_image_index").get() as { question_id: string }).question_id,
    questionSetId: (db.sqlite.prepare("SELECT question_set_id FROM question_image_index").get() as { question_set_id: string }).question_set_id,
    questionSetTitle: "MD5 已有题库",
    orderIndex: 0,
  });
  assert.equal(getPutCount(), 2);
  assert.equal(objects.size, 1);
  assert.equal(deletedKeys.length, 1);
});

test("community finalize rejects duplicate MD5s in one submission and an atomic concurrent duplicate", async () => {
  const sameBatch = createTestEnv();
  const firstResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), sameBatch.env);
  const secondResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), sameBatch.env);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  const first = await firstResponse.json() as { key: string };
  const second = await secondResponse.json() as { key: string };
  const duplicateBatchResponse = await worker.fetch(finalizeRequest({
    submissionId: "md5-same-batch-submission",
    title: "同批 MD5 重复",
    playerId: "md5-player",
    nickname: "MD5 上传者",
    questions: [
      { r2Key: first.key, labelText: "第一题" },
      { r2Key: second.key, labelText: "第二题" },
    ],
  }), sameBatch.env);
  assert.equal(duplicateBatchResponse.status, 409);
  assert.match(JSON.stringify(await duplicateBatchResponse.json()), /第 2 张图片题库已有.*第 1 张完全相同/);
  assert.equal(sameBatch.db.sqlite.prepare("SELECT COUNT(*) count FROM question_sets").get().count, 0);
  assert.equal(sameBatch.db.sqlite.prepare("SELECT COUNT(*) count FROM question_image_index").get().count, 0);

  const concurrent = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_WEBP, UPLOAD_SECRET, "image/webp"), concurrent.env);
  const uploaded = await uploadResponse.json() as { key: string; imageMd5: string };
  concurrent.db.beforeNextBatch = () => {
    concurrent.db.sqlite.prepare(`INSERT INTO question_sets
      (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      "concurrent-md5-existing-set",
      "并发先写题库",
      "concurrent-owner",
      1,
      1,
      "2026-08-20T00:00:00.000Z",
      "2026-08-20T00:00:00.000Z",
    );
    concurrent.db.sqlite.prepare(`INSERT INTO question_image_index
      (question_id,question_set_id,image_url,answer_text,order_index,image_md5,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      "concurrent-md5-existing-question",
      "concurrent-md5-existing-set",
      "https://example.com/concurrent.webp",
      "并发已有",
      0,
      uploaded.imageMd5,
      "2026-08-20T00:00:00.000Z",
    );
  };
  const concurrentResponse = await worker.fetch(finalizeRequest({
    submissionId: "md5-concurrent-submission",
    title: "并发冲突投稿",
    playerId: "md5-player",
    nickname: "MD5 上传者",
    questions: [{ r2Key: uploaded.key, labelText: "并发重复" }],
  }), concurrent.env);
  assert.equal(concurrentResponse.status, 409, await concurrentResponse.clone().text());
  assert.match(JSON.stringify(await concurrentResponse.json()), /题库已有/);
  assert.equal(concurrent.db.sqlite.prepare("SELECT COUNT(*) count FROM question_sets").get().count, 1);
  assert.equal(concurrent.db.sqlite.prepare("SELECT COUNT(*) count FROM question_image_index").get().count, 1);
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
    SELECT submission_id,start_order_index,added_image_count,submitted_by_player_id,submitted_by_nickname
    FROM community_question_set_submissions
    WHERE question_set_id=?
    ORDER BY start_order_index
  `).all(created.id) as Array<Record<string, unknown>>).map((row) => ({ ...row }));
  assert.deepEqual(submissions, [
    {
      submission_id: firstPayload.submissionId,
      start_order_index: 0,
      added_image_count: 1,
      submitted_by_player_id: "first-player",
      submitted_by_nickname: "首位上传者",
    },
    {
      submission_id: secondPayload.submissionId,
      start_order_index: 1,
      added_image_count: 1,
      submitted_by_player_id: "second-player",
      submitted_by_nickname: "第二位上传者",
    },
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

test("an explicitly selected structurally edited community set can continue appending by ID", async () => {
  const { db, env } = createTestEnv();
  const uploadBodies = [
    [ONE_PIXEL_PNG, "image/png"],
    [ONE_PIXEL_WEBP, "image/webp"],
    [imageVariant(ONE_PIXEL_PNG, 7), "image/png"],
  ] as const;
  const uploaded: Array<{ key: string }> = [];
  for (const [bytes, contentType] of uploadBodies) {
    const response = await worker.fetch(uploadRequest(bytes, UPLOAD_SECRET, contentType), env);
    assert.equal(response.status, 200, await response.clone().text());
    uploaded.push(await response.json() as { key: string });
  }

  const firstResponse = await worker.fetch(finalizeRequest({
    submissionId: "edited-append-first-submission",
    title: "人工编辑后继续追加",
    playerId: "edited-append-player",
    nickname: "编辑后上传者",
    questions: [{ r2Key: uploaded[0].key, labelText: "第一题" }],
  }), env);
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  const created = await firstResponse.json() as { id: string };
  const secondResponse = await worker.fetch(finalizeRequest({
    submissionId: "edited-append-second-submission",
    title: "人工编辑后继续追加",
    playerId: "edited-append-player",
    nickname: "编辑后上传者",
    questions: [{ r2Key: uploaded[1].key, labelText: "第二题" }],
  }), env);
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
  assert.equal((await secondResponse.json() as { id: string }).id, created.id);

  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as {
    updatedAt: string;
    questions: Array<{ id: string; answerText: string }>;
  };
  const secondQuestion = detail.questions.find((question) => question.answerText === "第二题")!;
  const deleteResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${secondQuestion.id}`,
    {
      method: "DELETE",
      body: { confirmQuestionId: secondQuestion.id, expectedUpdatedAt: detail.updatedAt },
    },
  ), env);
  assert.equal(deleteResponse.status, 200, await deleteResponse.clone().text());
  const detached = db.sqlite.prepare(`SELECT image_count,community_collection_title,community_structure_edited
    FROM question_sets WHERE id=?`).get(created.id) as Record<string, unknown>;
  assert.deepEqual({ ...detached }, {
    image_count: 1,
    community_collection_title: null,
    community_structure_edited: 1,
  });

  // 当前题数回到 1，而历史第二次投稿的 start_order_index 也是 1。0035 移除
  // 过时的范围唯一限制后，新投稿可按明确题库 ID 正常追加到当前末尾。
  const thirdPayload = {
    submissionId: "edited-append-third-submission",
    title: "人工编辑后继续追加",
    targetQuestionSetId: created.id,
    playerId: "edited-append-player",
    nickname: "编辑后上传者",
    questions: [{ r2Key: uploaded[2].key, labelText: "第三题" }],
  };
  const appendedResponse = await worker.fetch(finalizeRequest(thirdPayload), env);
  assert.equal(appendedResponse.status, 200, await appendedResponse.clone().text());
  const appended = await appendedResponse.json() as { id: string; imageCount: number; appended: boolean };
  assert.deepEqual(appended, {
    id: created.id,
    title: "人工编辑后继续追加",
    imageCount: 2,
    appended: true,
    addedImageCount: 1,
  });
  const retryResponse = await worker.fetch(finalizeRequest(thirdPayload), env);
  assert.equal(retryResponse.status, 200);
  assert.deepEqual(await retryResponse.json(), appended);

  const stored = db.sqlite.prepare("SELECT * FROM question_sets WHERE id=?").get(created.id) as Record<string, unknown>;
  assert.equal(stored.community_structure_edited, 1);
  assert.equal(stored.community_collection_title, null);
  assert.deepEqual(decodeQuestionSetManifest(stored)?.map((question) => [question.order_index, question.label_text]), [
    [0, "第一题"],
    [1, "第三题"],
  ]);
  const ranges = db.sqlite.prepare(`SELECT start_order_index,added_image_count
    FROM community_question_set_submissions WHERE question_set_id=? ORDER BY created_at,submission_id`)
    .all(created.id) as Array<{ start_order_index: number; added_image_count: number }>;
  assert.deepEqual(ranges.map((row) => ({ ...row })), [
    { start_order_index: 0, added_image_count: 1 },
    { start_order_index: 1, added_image_count: 1 },
    { start_order_index: 1, added_image_count: 1 },
  ]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM question_sets WHERE title='人工编辑后继续追加'").get().count, 1);
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

test("same-title append accumulates beyond 30 while a single submission stays capped at 30", async () => {
  const { db, env, objects } = createTestEnv();
  const makeStoredKey = (index: number) => {
    const key = `question-images/community/2026/08/20/00000000-0000-4000-8000-${String(index).padStart(12, "0")}-screenshot.png`;
    const etag = String(index + 1).padStart(32, "0");
    objects.set(key, {
      key,
      etag,
      httpEtag: `"${etag}"`,
      customMetadata: { uploadSource: "homepage-community" },
    } as R2Object);
    return key;
  };
  const initialKeys = Array.from({ length: 29 }, (_, index) => makeStoredKey(index));
  const createdResponse = await worker.fetch(finalizeRequest({
    submissionId: "capacity-initial-submission",
    title: "无上限累计题库",
    playerId: "test-player",
    nickname: "测试者",
    questions: initialKeys.map((r2Key, index) => ({ r2Key, labelText: `答案 ${index + 1}` })),
  }), env);
  assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
  const created = await createdResponse.json() as { id: string };

  // 已满 30 题的题库仍可继续追加：29 + 2 = 31 > 30
  const appendedResponse = await worker.fetch(finalizeRequest({
    submissionId: "capacity-append-submission",
    title: "无上限累计题库",
    playerId: "test-player",
    nickname: "测试者",
    questions: [makeStoredKey(29), makeStoredKey(30)].map((r2Key, index) => ({ r2Key, labelText: `追加 ${index + 1}` })),
  }), env);
  assert.equal(appendedResponse.status, 200, await appendedResponse.clone().text());
  const appended = await appendedResponse.json() as { id: string; imageCount: number; appended: boolean; addedImageCount: number };
  assert.equal(appended.id, created.id);
  assert.equal(appended.imageCount, 31);
  assert.equal(appended.appended, true);
  assert.equal(appended.addedImageCount, 2);

  const row = db.sqlite.prepare("SELECT id,image_count,manifest_revision,manifest_version,manifest_json FROM question_sets WHERE id=?")
    .get(created.id) as { id: string; image_count: number; manifest_revision: number; manifest_version: number; manifest_json: string };
  assert.equal(row.image_count, 31);
  assert.equal(row.manifest_revision, 1);
  assert.equal(decodeQuestionSetManifest(row)?.length, 31);
  const counts = db.sqlite.prepare(`SELECT
    (SELECT COUNT(*) FROM question_image_index WHERE question_set_id=?) AS images,
    (SELECT COUNT(*) FROM community_question_set_submissions WHERE question_set_id=?) AS submissions
  `).get(created.id, created.id) as { images: number; submissions: number };
  assert.equal(counts.images, 31);
  assert.equal(counts.submissions, 2);
  const ranges = db.sqlite.prepare(`SELECT start_order_index,added_image_count FROM community_question_set_submissions
    WHERE question_set_id=? ORDER BY start_order_index`).all(created.id) as Array<{ start_order_index: number; added_image_count: number }>;
  assert.deepEqual(ranges.map((range) => ({ ...range })), [
    { start_order_index: 0, added_image_count: 29 },
    { start_order_index: 29, added_image_count: 2 },
  ]);

  // 单次投稿仍最多 30 张：31 题之上一次投 31 张被拒绝（30 张以内仍可继续追加）
  const overflowKeys = Array.from({ length: 31 }, (_, index) => makeStoredKey(31 + index));
  const overflowResponse = await worker.fetch(finalizeRequest({
    submissionId: "capacity-overflow-submission",
    title: "无上限累计题库",
    playerId: "test-player",
    nickname: "测试者",
    questions: overflowKeys.map((r2Key, index) => ({ r2Key, labelText: `溢出 ${index + 1}` })),
  }), env);
  assert.equal(overflowResponse.status, 400);
  assert.match(JSON.stringify(await overflowResponse.json()), /1 到 30 张截图/);
  const afterOverflow = db.sqlite.prepare("SELECT image_count FROM question_sets WHERE id=?")
    .get(created.id) as { image_count: number };
  assert.equal(afterOverflow.image_count, 31);

  // 31 题之上再追加 5 张 → 36 题
  const fiveMoreResponse = await worker.fetch(finalizeRequest({
    submissionId: "capacity-five-more-submission",
    title: "无上限累计题库",
    playerId: "test-player",
    nickname: "测试者",
    questions: Array.from({ length: 5 }, (_, index) => ({ r2Key: makeStoredKey(61 + index), labelText: `继续 ${index + 1}` })),
  }), env);
  assert.equal(fiveMoreResponse.status, 200, await fiveMoreResponse.clone().text());
  const fiveMore = await fiveMoreResponse.json() as { imageCount: number; appended: boolean };
  assert.equal(fiveMore.imageCount, 36);
  assert.equal(fiveMore.appended, true);
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

  const invalidTarget = await worker.fetch(finalizeRequest({
    ...base,
    targetQuestionSetId: null,
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  assert.equal(invalidTarget.status, 400);
  assert.match(JSON.stringify(await invalidTarget.json()), /题库标识无效/);

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
  assert.match(JSON.stringify(await unrelatedCharacter.json()), /属于.*作品/);

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
  assert.match(JSON.stringify(await forgedMembership.json()), /不属于.*Bangumi 作品/);

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
  assert.deepEqual(detail.questions[0].animeTags, [{ id: 2, name: "AIR", nameCn: "青空", subjectType: 2 }]);
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
  assert.match(methodResponse.headers.get("access-control-allow-headers") ?? "", /x-question-set-delete-key/);

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

test("question-set admin supports manifest question image CRUD, replacement, and ordering", async () => {
  const { db, env, objects } = createTestEnv();
  const uploaded = [] as Array<{ key: string; url: string; imageMd5: string }>;
  for (const [bytes, contentType] of [
    [ONE_PIXEL_PNG, "image/png"],
    [ONE_PIXEL_WEBP, "image/webp"],
    [imageVariant(ONE_PIXEL_PNG, 1), "image/png"],
    [imageVariant(ONE_PIXEL_WEBP, 1), "image/webp"],
  ] as const) {
    const response = await worker.fetch(uploadRequest(bytes, UPLOAD_SECRET, contentType), env);
    assert.equal(response.status, 200, await response.clone().text());
    uploaded.push(await response.json() as { key: string; url: string; imageMd5: string });
  }
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-question-crud-submission",
    title: "单题 CRUD 题库",
    playerId: "admin-question-player",
    nickname: "单题管理员",
    questions: [
      { r2Key: uploaded[0].key, labelText: "第一题" },
      { r2Key: uploaded[1].key, labelText: "第二题" },
    ],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };
  let detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  let detail = await detailResponse.json() as {
    updatedAt: string;
    questions: Array<{ id: string; answerText: string; orderIndex: number; animeTags: unknown[]; characterTags: unknown[] }>;
    isCanonicalCollection: boolean;
    isStructureEdited: boolean;
    imageCount: number;
  };
  const firstQuestionId = detail.questions[0].id;
  const secondQuestionId = detail.questions[1].id;

  const unauthorizedQuestion = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${firstQuestionId}`,
    { key: null },
  ), env);
  assert.equal(unauthorizedQuestion.status, 401);
  const questionRead = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${firstQuestionId}`,
  ), env);
  assert.equal(questionRead.status, 200, await questionRead.clone().text());
  assert.equal((await questionRead.json() as { question: { answerText: string } }).question.answerText, "第一题");

  const addResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions`,
    {
      method: "POST",
      body: {
        r2Key: uploaded[2].key,
        answerText: "新增第三题",
        animeTags: [{ id: 2, name: "AIR", nameCn: "青空" }],
        characterTags: [{ id: 3, subjectId: 2, name: "神尾観鈴", nameCn: null, relation: "主角" }],
        expectedUpdatedAt: detail.updatedAt,
      },
    },
  ), env);
  assert.equal(addResponse.status, 200, await addResponse.clone().text());
  let mutation = await addResponse.json() as {
    questionSet: typeof detail;
    imageCleanup: Record<string, number>;
  };
  detail = mutation.questionSet;
  assert.equal(detail.imageCount, 3);
  assert.equal(detail.questions.length, 3);
  assert.equal(detail.isCanonicalCollection, false);
  assert.equal(detail.isStructureEdited, true);
  assert.deepEqual(mutation.imageCleanup, {
    candidateCount: 0,
    deletedCount: 0,
    preservedSharedCount: 0,
    pendingCount: 0,
  });
  const addedQuestion = detail.questions.find((question) => question.answerText === "新增第三题")!;
  assert.deepEqual(addedQuestion.animeTags, [{ id: 2, name: "AIR", nameCn: "青空", subjectType: 2 }]);
  assert.deepEqual(addedQuestion.characterTags, [{ id: 3, subjectId: 2, name: "神尾観鈴", nameCn: null, relation: "主角" }]);
  // 规范化时同步写入官方 subject 详情的属性标签与首播年份。
  const addedIndexed = db.sqlite.prepare("SELECT anime_genre_tags_json,anime_release_year FROM question_image_index WHERE question_id=?")
    .get(addedQuestion.id) as { anime_genre_tags_json: string; anime_release_year: number | null };
  assert.deepEqual(JSON.parse(addedIndexed.anime_genre_tags_json), [
    { name: "催泪", count: 10 },
    { name: "治愈", count: 5 },
  ]);
  assert.equal(addedIndexed.anime_release_year, 2005);

  const staleUpdate = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${firstQuestionId}`,
    {
      method: "PATCH",
      body: {
        answerText: "不应写入",
        animeTags: [],
        characterTags: [],
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  ), env);
  assert.equal(staleUpdate.status, 409);

  const updateResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${addedQuestion.id}`,
    {
      method: "PATCH",
      body: {
        r2Key: uploaded[3].key,
        answerText: "替换后的第三题",
        animeTags: [],
        characterTags: [],
        expectedUpdatedAt: detail.updatedAt,
      },
    },
  ), env);
  assert.equal(updateResponse.status, 200, await updateResponse.clone().text());
  mutation = await updateResponse.json() as typeof mutation;
  detail = mutation.questionSet;
  assert.deepEqual(mutation.imageCleanup, {
    candidateCount: 1,
    deletedCount: 1,
    preservedSharedCount: 0,
    pendingCount: 0,
  });
  assert.equal(objects.has(uploaded[2].key), false);
  assert.equal(objects.has(uploaded[3].key), true);
  const replacedQuestion = detail.questions.find((question) => question.id === addedQuestion.id)!;
  assert.equal(replacedQuestion.answerText, "替换后的第三题");

  // 换图成功响应丢失后的同 key 重试应排除当前题自身的 MD5：返回幂等成功，
  // 而不是误报“题库已有”。
  const replacementRetry = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${addedQuestion.id}`,
    {
      method: "PATCH",
      body: {
        r2Key: uploaded[3].key,
        answerText: "替换后的第三题",
        animeTags: [],
        characterTags: [],
        expectedUpdatedAt: detail.updatedAt,
      },
    },
  ), env);
  assert.equal(replacementRetry.status, 200, await replacementRetry.clone().text());
  assert.equal((await replacementRetry.clone().text()).includes("题库已有"), false);

  const moveResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${replacedQuestion.id}`,
    {
      method: "PATCH",
      body: {
        answerText: replacedQuestion.answerText,
        animeTags: replacedQuestion.animeTags,
        characterTags: replacedQuestion.characterTags,
        orderIndex: 0,
        expectedUpdatedAt: detail.updatedAt,
      },
    },
  ), env);
  assert.equal(moveResponse.status, 200, await moveResponse.clone().text());
  mutation = await moveResponse.json() as typeof mutation;
  detail = mutation.questionSet;
  assert.deepEqual(detail.questions.map((question) => question.id), [replacedQuestion.id, firstQuestionId, secondQuestionId]);
  // 纯调序复用现有属性标签与年份（此前换图 PATCH 已显式清空标签，因此保持为空）。
  const reorderedIndexed = db.sqlite.prepare("SELECT anime_genre_tags_json,anime_release_year FROM question_image_index WHERE question_id=?")
    .get(replacedQuestion.id) as { anime_genre_tags_json: string; anime_release_year: number | null };
  assert.deepEqual(JSON.parse(reorderedIndexed.anime_genre_tags_json), []);
  assert.equal(reorderedIndexed.anime_release_year, null);

  const deleteResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${secondQuestionId}`,
    {
      method: "DELETE",
      // 单题删除不要求独立删除密钥（只有整库 DELETE 才需要）。
      deleteKey: null,
      body: { confirmQuestionId: secondQuestionId, expectedUpdatedAt: detail.updatedAt },
    },
  ), env);
  assert.equal(deleteResponse.status, 200, await deleteResponse.clone().text());
  mutation = await deleteResponse.json() as typeof mutation;
  detail = mutation.questionSet;
  assert.equal(detail.questions.length, 2);
  assert.deepEqual(detail.questions.map((question, index) => [question.id, (question as { orderIndex?: number }).orderIndex ?? index]), [
    [replacedQuestion.id, 0],
    [firstQuestionId, 1],
  ]);
  assert.equal(objects.has(uploaded[1].key), false);

  const stored = db.sqlite.prepare(`SELECT image_count,manifest_revision,community_collection_title,community_structure_edited
    FROM question_sets WHERE id=?`).get(created.id) as Record<string, unknown>;
  assert.equal(stored.image_count, 2);
  assert.equal(stored.community_collection_title, null);
  assert.equal(stored.community_structure_edited, 1);
  assert.equal(Number(stored.manifest_revision) >= 4, true);
  const manifest = decodeQuestionSetManifest(db.sqlite.prepare("SELECT * FROM question_sets WHERE id=?").get(created.id) as Record<string, unknown>);
  assert.deepEqual(manifest?.map((question) => [question.id, question.order_index, question.label_text]), [
    [replacedQuestion.id, 0, "替换后的第三题"],
    [firstQuestionId, 1, "第一题"],
  ]);
  const indexed = db.sqlite.prepare(`SELECT question_id,order_index,answer_text,image_md5 FROM question_image_index
    WHERE question_set_id=? ORDER BY order_index`).all(created.id) as Array<Record<string, unknown>>;
  assert.deepEqual(indexed.map((row) => ({ ...row })), [
    {
      question_id: replacedQuestion.id,
      order_index: 0,
      answer_text: "替换后的第三题",
      image_md5: uploaded[3].imageMd5,
    },
    {
      question_id: firstQuestionId,
      order_index: 1,
      answer_text: "第一题",
      image_md5: uploaded[0].imageMd5,
    },
  ]);
});

test("question-set admin refuses to delete the last individual question", async () => {
  const { env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-last-question-submission",
    title: "最后一题保护",
    playerId: "last-question-player",
    nickname: "单题管理员",
    questions: [{ r2Key: uploaded.key, labelText: "唯一题" }],
  }), env);
  const created = await finalizeResponse.json() as { id: string };
  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string; questions: Array<{ id: string }> };
  const questionId = detail.questions[0].id;
  const deleteResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${questionId}`,
    {
      method: "DELETE",
      body: { confirmQuestionId: questionId, expectedUpdatedAt: detail.updatedAt },
    },
  ), env);
  assert.equal(deleteResponse.status, 409);
  assert.match(JSON.stringify(await deleteResponse.json()), /至少需要保留 1 道题/);
});

test("question-set admin reorders legacy null-answer questions order-only and preserves label metadata", async () => {
  const { db, env } = createTestEnv();
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run("admin-legacy-null-answer", "旧版空答案题库", "legacy-owner", 0, 2, "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  db.sqlite.prepare(`INSERT INTO questions
    (id,question_set_id,image_url,order_index,label_text,label_source,label_source_answer_id,label_updated_by_player_id,label_updated_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(
      "legacy-null-question",
      "admin-legacy-null-answer",
      "https://example.com/null.webp",
      0,
      null,
      "answer",
      "legacy-source-answer",
      "legacy-player",
      "2026-02-01T01:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    );
  db.sqlite.prepare(`INSERT INTO questions
    (id,question_set_id,image_url,order_index,label_text,label_source,created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(
      "legacy-answered-question",
      "admin-legacy-null-answer",
      "https://example.com/answered.webp",
      1,
      "旧版已答题目",
      "manual",
      "2026-02-01T00:00:00.000Z",
    );

  const before = bangumiUpstreamRequestCount;
  const detailResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-legacy-null-answer"), env);
  assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
  const detail = await detailResponse.json() as {
    updatedAt: string;
    storageKind: string;
    questions: Array<{ id: string; answerText: string | null; orderIndex: number }>;
  };
  assert.equal(detail.storageKind, "rows");
  assert.equal(detail.questions[0].answerText, null);
  assert.equal(detail.questions[0].id, "legacy-null-question");

  // 纯调序：只提交顺序，不提交答案/标签，也不访问 Bangumi 上游。
  const moveResponse = await worker.fetch(questionSetAdminRequest(
    "/api/admin/question-sets/admin-legacy-null-answer/questions/legacy-null-question",
    {
      method: "PATCH",
      body: { orderIndex: 1, expectedUpdatedAt: detail.updatedAt },
    },
  ), env);
  assert.equal(moveResponse.status, 200, await moveResponse.clone().text());
  const moved = await moveResponse.json() as {
    questionSet: { updatedAt: string; questions: Array<{ id: string; orderIndex: number }> };
  };
  assert.deepEqual(moved.questionSet.questions.map((question) => [question.id, question.orderIndex]), [
    ["legacy-answered-question", 0],
    ["legacy-null-question", 1],
  ]);
  assert.equal(bangumiUpstreamRequestCount, before);

  const stored = db.sqlite.prepare(`SELECT order_index,label_text,label_source,label_source_answer_id,label_updated_by_player_id,label_updated_at
    FROM questions WHERE id='legacy-null-question'`).get() as Record<string, unknown>;
  assert.deepEqual({ ...stored }, {
    order_index: 1,
    label_text: null,
    label_source: "answer",
    label_source_answer_id: "legacy-source-answer",
    label_updated_by_player_id: "legacy-player",
    label_updated_at: "2026-02-01T01:00:00.000Z",
  });

  // legacy 单题答案编辑仍可用：明确提交答案时才会改写 label 元数据。
  const editResponse = await worker.fetch(questionSetAdminRequest(
    "/api/admin/question-sets/admin-legacy-null-answer/questions/legacy-null-question",
    {
      method: "PATCH",
      body: {
        answerText: "补充答案",
        animeTags: [],
        characterTags: [],
        expectedUpdatedAt: moved.questionSet.updatedAt,
      },
    },
  ), env);
  assert.equal(editResponse.status, 200, await editResponse.clone().text());
  const edited = await editResponse.json() as { questionSet: { updatedAt: string } };
  const editedStored = db.sqlite.prepare(`SELECT label_text,label_source,label_source_answer_id,label_updated_by_player_id
    FROM questions WHERE id='legacy-null-question'`).get() as Record<string, unknown>;
  assert.deepEqual({ ...editedStored }, {
    label_text: "补充答案",
    label_source: "manual",
    label_source_answer_id: null,
    label_updated_by_player_id: null,
  });

  // legacy 单题删除仍可用，且保留最后一题保护。
  const deleteResponse = await worker.fetch(questionSetAdminRequest(
    "/api/admin/question-sets/admin-legacy-null-answer/questions/legacy-answered-question",
    {
      method: "DELETE",
      body: { confirmQuestionId: "legacy-answered-question", expectedUpdatedAt: edited.questionSet.updatedAt },
    },
  ), env);
  assert.equal(deleteResponse.status, 200, await deleteResponse.clone().text());
  const deleted = await deleteResponse.json() as { questionSet: { updatedAt: string; questions: Array<{ id: string }> } };
  assert.deepEqual(deleted.questionSet.questions.map((question) => question.id), ["legacy-null-question"]);
  const lastDelete = await worker.fetch(questionSetAdminRequest(
    "/api/admin/question-sets/admin-legacy-null-answer/questions/legacy-null-question",
    {
      method: "DELETE",
      body: { confirmQuestionId: "legacy-null-question", expectedUpdatedAt: deleted.questionSet.updatedAt },
    },
  ), env);
  assert.equal(lastDelete.status, 409);
  assert.match(JSON.stringify(await lastDelete.json()), /至少需要保留 1 道题/);
  assert.equal(bangumiUpstreamRequestCount, before);
});

test("question-set admin fails closed on overlong stored image URLs instead of a D1 500", async () => {
  const { db, env } = createTestEnv();
  const overlongUrl = `https://example.com/${"x".repeat(2500)}.webp`;
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run("admin-overlong-url-set", "超长图片地址题库", "legacy-owner", 0, 2, "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  db.sqlite.prepare(`INSERT INTO questions (id,question_set_id,image_url,order_index,label_text,created_at)
    VALUES (?,?,?,?,?,?)`)
    .run("overlong-question", "admin-overlong-url-set", overlongUrl, 0, "第一题", "2026-02-01T00:00:00.000Z");
  db.sqlite.prepare(`INSERT INTO questions (id,question_set_id,image_url,order_index,label_text,created_at)
    VALUES (?,?,?,?,?,?)`)
    .run("normal-question", "admin-overlong-url-set", "https://example.com/normal.webp", 1, "第二题", "2026-02-01T00:00:00.000Z");
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };

  const detailResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-overlong-url-set"), env);
  assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
  const detail = await detailResponse.json() as { updatedAt: string; integrityIssues: string[] };
  assert.match(detail.integrityIssues.join(" "), /第 1 题的图片地址超过 2048 字符上限/);

  // 调序与新增都在单题 mutation 前以明确 409 拒绝，而不是落到 D1 CHECK 的 500。
  for (const mutation of [
    { method: "PATCH", path: "/api/admin/question-sets/admin-overlong-url-set/questions/normal-question", body: { orderIndex: 0, expectedUpdatedAt: detail.updatedAt } },
    {
      method: "POST",
      path: "/api/admin/question-sets/admin-overlong-url-set/questions",
      body: { r2Key: uploaded.key, answerText: "新增题", animeTags: [], characterTags: [], expectedUpdatedAt: detail.updatedAt },
    },
  ]) {
    const response = await worker.fetch(questionSetAdminRequest(mutation.path, {
      method: mutation.method as "PATCH" | "POST",
      body: mutation.body,
    }), env);
    assert.equal(response.status, 409, mutation.path);
    assert.match(JSON.stringify(await response.json()), /图片地址.*2048 字符上限/);
  }
  const unchanged = db.sqlite.prepare(`SELECT order_index FROM questions WHERE question_set_id=? ORDER BY order_index`)
    .all("admin-overlong-url-set") as Array<{ order_index: number }>;
  assert.deepEqual(unchanged.map((row) => row.order_index), [0, 1]);

  // manifest 存储同样在重写索引前 fail-closed。
  const manifest = encodeQuestionSetManifest([
    {
      id: "manifest-overlong",
      questionSetId: "admin-overlong-manifest",
      imageUrl: overlongUrl,
      orderIndex: 0,
      labelText: "超长题",
      labelSource: "manual",
      createdAt: "2026-02-01T00:00:00.000Z",
    },
    {
      id: "manifest-normal",
      questionSetId: "admin-overlong-manifest",
      imageUrl: "https://example.com/normal.webp",
      orderIndex: 1,
      labelText: "正常题",
      labelSource: "manual",
      createdAt: "2026-02-01T00:00:00.000Z",
    },
  ]);
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,manifest_version,manifest_revision,manifest_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(
      "admin-overlong-manifest",
      "超长 manifest 题库",
      "manifest-owner",
      0,
      2,
      1,
      0,
      manifest,
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    );
  const manifestDetailResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-overlong-manifest"), env);
  const manifestDetail = await manifestDetailResponse.json() as { updatedAt: string; integrityIssues: string[] };
  assert.match(manifestDetail.integrityIssues.join(" "), /第 1 题的图片地址超过 2048 字符上限/);
  const manifestMoveResponse = await worker.fetch(questionSetAdminRequest(
    "/api/admin/question-sets/admin-overlong-manifest/questions/manifest-normal",
    { method: "PATCH", body: { orderIndex: 0, expectedUpdatedAt: manifestDetail.updatedAt } },
  ), env);
  assert.equal(manifestMoveResponse.status, 409);
  assert.match(JSON.stringify(await manifestMoveResponse.json()), /图片地址.*2048 字符上限/);
});

test("question-set admin order-only PATCH reuses stored answer and tags without Bangumi upstream", async () => {
  const { env } = createTestEnv();
  const uploaded = [];
  for (const [bytes, contentType] of [
    [ONE_PIXEL_PNG, "image/png"],
    [ONE_PIXEL_WEBP, "image/webp"],
  ] as const) {
    const response = await worker.fetch(uploadRequest(bytes, UPLOAD_SECRET, contentType), env);
    assert.equal(response.status, 200, await response.clone().text());
    uploaded.push(await response.json() as { key: string });
  }
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-order-only-submission",
    title: "纯调序题库",
    playerId: "admin-order-player",
    nickname: "纯调序管理员",
    questions: [
      {
        r2Key: uploaded[0].key,
        labelText: "第一题",
        animeTags: [{ id: 2, name: "AIR", nameCn: "青空" }],
        characterTags: [{ id: 3, subjectId: 2, name: "神尾観鈴", nameCn: null, relation: "主角" }],
      },
      { r2Key: uploaded[1].key, labelText: "第二题" },
    ],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };

  const before = bangumiUpstreamRequestCount;
  let detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  let detail = await detailResponse.json() as {
    updatedAt: string;
    questions: Array<{ id: string; answerText: string; animeTags: unknown[]; characterTags: unknown[] }>;
  };
  const firstQuestionId = detail.questions[0].id;
  const secondQuestionId = detail.questions[1].id;
  const firstTags = JSON.stringify({
    a: detail.questions[0].animeTags,
    c: detail.questions[0].characterTags,
  });

  // 纯调序：不提交答案与标签，服务端复用现有内容，不访问 Bangumi 上游。
  const moveResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${secondQuestionId}`,
    { method: "PATCH", body: { orderIndex: 0, expectedUpdatedAt: detail.updatedAt } },
  ), env);
  assert.equal(moveResponse.status, 200, await moveResponse.clone().text());
  const moved = await moveResponse.json() as { questionSet: typeof detail };
  detail = moved.questionSet;
  assert.deepEqual(detail.questions.map((question) => question.id), [secondQuestionId, firstQuestionId]);
  assert.equal(detail.questions[1].answerText, "第一题");
  assert.equal(JSON.stringify({ a: detail.questions[1].animeTags, c: detail.questions[1].characterTags }), firstTags);
  assert.equal(bangumiUpstreamRequestCount, before);

  // 提交与现有标签完全相同的完整载荷也不会触发上游规范化。
  const noopResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${firstQuestionId}`,
    {
      method: "PATCH",
      body: {
        answerText: "第一题",
        animeTags: detail.questions[1].animeTags,
        characterTags: detail.questions[1].characterTags,
        expectedUpdatedAt: detail.updatedAt,
      },
    },
  ), env);
  assert.equal(noopResponse.status, 200, await noopResponse.clone().text());
  assert.equal(bangumiUpstreamRequestCount, before);

  // 标签一旦变化，仍必须经上游规范化，伪造名称会被覆盖。清空共享测试缓存，确保真正访问上游。
  (globalThis.caches as unknown as { default: TestCache }).default.responses.clear();
  const forgedResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${firstQuestionId}`,
    {
      method: "PATCH",
      body: {
        answerText: "第一题",
        animeTags: [{ id: 2, name: "伪造作品名", nameCn: "伪造中文名" }],
        characterTags: [],
        expectedUpdatedAt: detail.updatedAt,
      },
    },
  ), env);
  assert.equal(forgedResponse.status, 200, await forgedResponse.clone().text());
  const forged = await forgedResponse.json() as {
    questionSet: { questions: Array<{ id: string; animeTags: Array<{ id: number; name: string; nameCn: string }> }> };
  };
  const forgedQuestion = forged.questionSet.questions.find((question) => question.id === firstQuestionId)!;
  assert.deepEqual(forgedQuestion.animeTags, [{ id: 2, name: "AIR", nameCn: "青空", subjectType: 2 }]);
  assert.equal(bangumiUpstreamRequestCount, before + 1);
});

test("question-set admin can add questions beyond 30 one at a time", async () => {
  const { db, env } = createTestEnv();
  const manifest = encodeQuestionSetManifest(Array.from({ length: 30 }, (_, index) => ({
    id: `admin-30-question-${index}`,
    questionSetId: "admin-30-set",
    imageUrl: `https://example.com/${index}.webp`,
    orderIndex: index,
    labelText: `第 ${index + 1} 题`,
    labelSource: "manual" as const,
    createdAt: "2026-02-01T00:00:00.000Z",
  })));
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,manifest_version,manifest_revision,manifest_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run("admin-30-set", "30 题后仍可新增题库", "thirty-owner", 0, 30, 1, 0, manifest, "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const detailResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-30-set"), env);
  const detail = await detailResponse.json() as { updatedAt: string; canEditQuestions: boolean; questions: Array<{ id: string }> };
  assert.equal(detail.canEditQuestions, true);
  assert.equal(detail.questions.length, 30);

  const addResponse = await worker.fetch(questionSetAdminRequest(
    "/api/admin/question-sets/admin-30-set/questions",
    {
      method: "POST",
      body: { r2Key: uploaded.key, answerText: "第 31 题", animeTags: [], characterTags: [], expectedUpdatedAt: detail.updatedAt },
    },
  ), env);
  assert.equal(addResponse.status, 200, await addResponse.clone().text());
  const added = await addResponse.json() as { questionSet: { imageCount: number; questions: Array<{ id: string }>; updatedAt: string } };
  assert.equal(added.questionSet.imageCount, 31);
  assert.equal(added.questionSet.questions.length, 31);
  const count = db.sqlite.prepare("SELECT image_count,manifest_revision FROM question_sets WHERE id='admin-30-set'").get() as { image_count: number; manifest_revision: number };
  assert.deepEqual({ ...count }, { image_count: 31, manifest_revision: 1 });
  const indexCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM question_image_index WHERE question_set_id='admin-30-set'").get() as { count: number };
  assert.equal(indexCount.count, 31);

  // 再新增第 32 题仍然允许（每次只新增 1 题）
  const secondUploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_WEBP), env);
  const secondUploaded = await secondUploadResponse.json() as { key: string };
  const secondAddResponse = await worker.fetch(questionSetAdminRequest(
    "/api/admin/question-sets/admin-30-set/questions",
    {
      method: "POST",
      body: { r2Key: secondUploaded.key, answerText: "第 32 题", animeTags: [], characterTags: [], expectedUpdatedAt: added.questionSet.updatedAt },
    },
  ), env);
  assert.equal(secondAddResponse.status, 200, await secondAddResponse.clone().text());
  const secondAdded = await secondAddResponse.json() as { questionSet: { imageCount: number } };
  assert.equal(secondAdded.questionSet.imageCount, 32);
});

test("question-set admin refuses unsafe deletion of a legacy question shape with inconsistent order", async () => {
  const { db, env } = createTestEnv();
  const updatedAt = "2026-02-01T00:00:00.000Z";
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run("admin-legacy-31-set", "顺序异常的 31 题 legacy", "legacy-owner", 0, 31, updatedAt, updatedAt);
  const insertQuestion = db.sqlite.prepare(`INSERT INTO questions
    (id,question_set_id,image_url,order_index,label_text,created_at) VALUES (?,?,?,?,?,?)`);
  for (let index = 0; index < 31; index += 1) {
    insertQuestion.run(
      `legacy-31-question-${index}`,
      "admin-legacy-31-set",
      `https://example.com/legacy-${index}.webp`,
      index,
      `答案 ${index}`,
      updatedAt,
    );
  }
  // 超过 30 题的题库本身是合法形状（社区集合可累计超过 30 题），但顺序不连续
  // （0..30 之后直接跳到 32）仍然属于无法安全管理的异常形状。
  db.sqlite.prepare("UPDATE questions SET order_index=32 WHERE id='legacy-31-question-30'").run();

  const detailResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-legacy-31-set"), env);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as { canDelete: boolean; canEditQuestions: boolean; updatedAt: string };
  assert.equal(detail.canDelete, false);
  assert.equal(detail.canEditQuestions, false);
  const deleteResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/admin-legacy-31-set", {
    method: "DELETE",
    body: { confirmQuestionSetId: "admin-legacy-31-set", expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(deleteResponse.status, 409);
  assert.match(JSON.stringify(await deleteResponse.json()), /存储数量或顺序不一致/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM question_sets WHERE id='admin-legacy-31-set'").get().count, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM questions WHERE question_set_id='admin-legacy-31-set'").get().count, 31);
});

test("question-set admin rejects missing, tampered, and non-homepage r2 keys", async () => {
  const { db, env, objects } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-r2-key-submission",
    title: "r2 键校验题库",
    playerId: "admin-r2-player",
    nickname: "r2 管理员",
    questions: [{ r2Key: uploaded.key, labelText: "唯一题" }],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };
  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string; questions: Array<{ id: string }> };
  const questionId = detail.questions[0].id;

  // 对象不存在。
  const missingResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions`,
    {
      method: "POST",
      body: {
        r2Key: "question-images/community/2026/01/01/missing.png",
        answerText: "新题",
        animeTags: [],
        characterTags: [],
        expectedUpdatedAt: detail.updatedAt,
      },
    },
  ), env);
  assert.equal(missingResponse.status, 400);
  assert.match(JSON.stringify(await missingResponse.json()), /不存在或未通过校验/);

  // 路径穿越或错误前缀。
  const tamperedResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions`,
    {
      method: "POST",
      body: {
        r2Key: "question-images/community/../other.png",
        answerText: "新题",
        animeTags: [],
        characterTags: [],
        expectedUpdatedAt: detail.updatedAt,
      },
    },
  ), env);
  assert.equal(tamperedResponse.status, 400);
  assert.match(JSON.stringify(await tamperedResponse.json()), /图片标识无效/);

  // 对象存在但 uploadSource 不是 homepage-community，替换图片同样被拒绝且不落库。
  const foreignKey = "question-images/community/2026/01/01/foreign.png";
  objects.set(foreignKey, {
    key: foreignKey,
    version: "test-version",
    size: ONE_PIXEL_PNG.byteLength,
    etag: "test-etag",
    httpEtag: '"test-etag"',
    uploaded: new Date(),
    checksums: {},
    customMetadata: { uploadSource: "legacy-manual" },
    httpMetadata: {},
  } as R2Object);
  const foreignResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${questionId}`,
    {
      method: "PATCH",
      body: {
        r2Key: foreignKey,
        answerText: "替换图答案",
        animeTags: [],
        characterTags: [],
        expectedUpdatedAt: detail.updatedAt,
      },
    },
  ), env);
  assert.equal(foreignResponse.status, 400);
  assert.match(JSON.stringify(await foreignResponse.json()), /不存在或未通过校验/);
  const stored = db.sqlite.prepare(`SELECT image_url,answer_text FROM question_image_index WHERE question_id=?`)
    .get(questionId) as Record<string, unknown>;
  assert.equal(stored.image_url, `https://caicai.lpp.moe/api/r2-images/${uploaded.key}`);
  assert.equal(stored.answer_text, "唯一题");
});

test("D1 0030 structure-edit migration upgrades the production schema transactionally", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, "0029");
  sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,community_submission_id,community_collection_title,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      "migration-0030-set",
      "迁移前社区题库",
      "migration-owner",
      1,
      1,
      "migration-0030-submission",
      "迁移前社区题库",
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    );
  const migration = readFileSync(resolve(
    import.meta.dirname,
    "..",
    "d1",
    "migrations",
    "0030_question_set_item_admin.sql",
  ), "utf8");

  // 失败回滚后列不存在，schema 版本不推进。
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    sqlite.exec("ROLLBACK");
  }
  const afterRollback = sqlite.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('question_sets')
    WHERE name='community_structure_edited'`).get() as { count: number };
  assert.equal(afterRollback.count, 0);

  // 正式应用后列存在、默认 0，且不触碰既有规范集合标题。
  sqlite.exec(migration);
  const column = sqlite.prepare(`SELECT name,type,"notnull" FROM pragma_table_info('question_sets')
    WHERE name='community_structure_edited'`).get() as Record<string, unknown>;
  assert.deepEqual({ ...column }, { name: "community_structure_edited", type: "INTEGER", notnull: 1 });
  const existing = sqlite.prepare(`SELECT community_structure_edited,community_collection_title FROM question_sets
    WHERE id='migration-0030-set'`).get() as Record<string, unknown>;
  assert.deepEqual({ ...existing }, { community_structure_edited: 0, community_collection_title: "迁移前社区题库" });
  sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run("migration-0030-fresh", "迁移后新题库", "migration-owner", 0, 0, "2026-02-02T00:00:00.000Z", "2026-02-02T00:00:00.000Z");
  const fresh = sqlite.prepare("SELECT community_structure_edited FROM question_sets WHERE id='migration-0030-fresh'")
    .get() as { community_structure_edited: number };
  assert.equal(fresh.community_structure_edited, 0);
  assert.throws(
    () => sqlite.prepare("UPDATE question_sets SET community_structure_edited=2 WHERE id='migration-0030-set'").run(),
    /CHECK constraint failed/,
  );
  sqlite.prepare("UPDATE question_sets SET community_structure_edited=1 WHERE id='migration-0030-set'").run();
});

test("D1 0031 relaxes community collection storage caps transactionally", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, "0030");
  const migration = readFileSync(resolve(
    import.meta.dirname,
    "..",
    "d1",
    "migrations",
    "0031_relax_community_set_storage_cap.sql",
  ), "utf8");
  sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,community_submission_id,community_collection_title,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      "migration-0031-set",
      "迁移前 31 题社区题库",
      "migration-owner",
      1,
      3,
      "migration-0031-submission-000000",
      "迁移前 31 题社区题库",
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    );
  const insertIndex = sqlite.prepare(`INSERT INTO question_image_index
    (question_id,question_set_id,image_url,answer_text,order_index,created_at) VALUES (?,?,?,?,?,?)`);
  for (let index = 0; index < 3; index += 1) {
    insertIndex.run(`migration-0031-image-${index}`, "migration-0031-set", `https://example.com/${index}.webp`, `答案 ${index + 1}`, index, "2026-02-01T00:00:00.000Z");
  }
  sqlite.prepare(`INSERT INTO community_question_set_submissions
    (submission_id,submission_fingerprint,question_set_id,start_order_index,added_image_count,created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(
      "migration-0031-submission-000000",
      "0000000000000000000000000000000000000000000000000000000000000000",
      "migration-0031-set",
      0,
      3,
      "2026-02-01T00:00:00.000Z",
    );

  // 旧 schema 的累计 30 上限仍生效：order_index >= 30 与 start_order_index >= 30 被 CHECK 拒绝。
  assert.throws(
    () => insertIndex.run("migration-0031-old-order-30", "migration-0031-set", "https://example.com/30.webp", "越界题", 30, "2026-02-01T00:00:00.000Z"),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => sqlite.prepare(`INSERT INTO community_question_set_submissions
      (submission_id,submission_fingerprint,question_set_id,start_order_index,added_image_count,created_at)
      VALUES (?,?,?,?,?,?)`)
      .run(
        "migration-0031-old-overflow-submission",
        "1111111111111111111111111111111111111111111111111111111111111111",
        "migration-0031-set",
        30,
        1,
        "2026-02-01T00:00:00.000Z",
      ),
    /CHECK constraint failed/,
  );

  // 失败回滚后旧表原样保留，越界写入仍被拒绝。
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    sqlite.exec("ROLLBACK");
  }
  const tempTableCount = sqlite.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type='table' AND name LIKE 'question_image_index_v2%' OR type='table' AND name LIKE 'community_question_set_submissions_v2%'`)
    .get() as { count: number };
  assert.equal(tempTableCount.count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM question_image_index").get().count, 3);
  assert.throws(() => insertIndex.run("migration-0031-still-blocked", "migration-0031-set", "https://example.com/31.webp", "仍越界", 31, "2026-02-01T00:00:00.000Z"), /CHECK constraint failed/);

  // 正式应用：数据原样保留，约束被放宽。
  sqlite.exec(migration);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM question_image_index").get().count, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM community_question_set_submissions").get().count, 1);
  const preserved = sqlite.prepare(`SELECT image_url,answer_text,order_index FROM question_image_index
    WHERE question_id='migration-0031-image-0'`).get() as { image_url: string; answer_text: string; order_index: number };
  assert.deepEqual({ ...preserved }, { image_url: "https://example.com/0.webp", answer_text: "答案 1", order_index: 0 });

  // 越界顺序现在可写：累计 31 题（order_index 30）、追加范围超过 30。
  insertIndex.run("migration-0031-order-30", "migration-0031-set", "https://example.com/30.webp", "第 31 题", 30, "2026-02-01T00:00:00.000Z");
  const insertSubmission = sqlite.prepare(`INSERT INTO community_question_set_submissions
    (submission_id,submission_fingerprint,question_set_id,start_order_index,added_image_count,created_at)
    VALUES (?,?,?,?,?,?)`);
  insertSubmission.run(
    "migration-0031-overflow-submission",
    "2222222222222222222222222222222222222222222222222222222222222222",
    "migration-0031-set",
    30,
    1,
    "2026-02-01T00:00:00.000Z",
  );
  insertSubmission.run(
    "migration-0031-later-submission",
    "3333333333333333333333333333333333333333333333333333333333333333",
    "migration-0031-set",
    31,
    2,
    "2026-02-01T00:00:00.000Z",
  );
  insertSubmission.run(
    "migration-0031-full-batch-submission",
    "4444444444444444444444444444444444444444444444444444444444444444",
    "migration-0031-set",
    33,
    30,
    "2026-02-01T00:00:00.000Z",
  );

  // 单次投稿上限与格式约束仍然保留。
  assert.throws(() => insertSubmission.run(
    "migration-0031-too-many-added",
    "5555555555555555555555555555555555555555555555555555555555555555",
    "migration-0031-set",
    63,
    31,
    "2026-02-01T00:00:00.000Z",
  ), /CHECK constraint failed/);
  assert.throws(() => insertSubmission.run(
    "migration-0031-zero-added",
    "6666666666666666666666666666666666666666666666666666666666666666",
    "migration-0031-set",
    63,
    0,
    "2026-02-01T00:00:00.000Z",
  ), /CHECK constraint failed/);
  assert.throws(() => insertSubmission.run(
    "migration-0031-negative-start",
    "7777777777777777777777777777777777777777777777777777777777777777",
    "migration-0031-set",
    -1,
    1,
    "2026-02-01T00:00:00.000Z",
  ), /CHECK constraint failed/);
  // 同题库同起始顺序仍然唯一，图片索引的 (question_set_id, order_index) 也仍唯一。
  assert.throws(() => insertSubmission.run(
    "migration-0031-duplicate-range",
    "8888888888888888888888888888888888888888888888888888888888888888",
    "migration-0031-set",
    30,
    1,
    "2026-02-01T00:00:00.000Z",
  ), /UNIQUE constraint failed/);
  assert.throws(() => insertIndex.run("migration-0031-duplicate-order", "migration-0031-set", "https://example.com/32.webp", "重复顺序", 30, "2026-02-01T00:00:00.000Z"), /UNIQUE constraint failed/);

  // 重建后的索引与主键仍然存在。
  const indexes = sqlite.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND name IN ('community_question_set_submissions_set_idx','question_image_index_anime_idx')`)
    .all() as Array<{ name: string }>;
  assert.deepEqual(indexes.map((item) => item.name).sort(), ["community_question_set_submissions_set_idx", "question_image_index_anime_idx"]);

  // 重复执行迁移保持幂等（数据不丢失、不重复）。
  sqlite.exec(migration);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM question_image_index").get().count, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM community_question_set_submissions").get().count, 4);
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
  const deletedResult = await deleted.clone().json() as { releasedPreparedRoomCount: number };
  assert.equal(deletedResult.releasedPreparedRoomCount, 0);
  assert.ok(db.sqlite.prepare("SELECT game_session_id FROM game_result_archives WHERE game_session_id='admin-archived-game'").get());
  assert.equal(objects.has(uploaded.key), false);
});

test("question-set admin whole-set deletion releases prepared rooms and deletes the set atomically", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-delete-releases-submission",
    title: "被房间引用的题库",
    playerId: "admin-delete-player",
    nickname: "管理测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };
  db.sqlite.prepare(`INSERT INTO rooms
    (id,room_code,host_player_id,game_status,current_presenter_player_id,current_game_id,
     prepared_question_set_id,prepared_question_count,lobby_question_count,prepared_question_source,room_visibility)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      "admin-reference-room",
      "ADMREF",
      "admin-reference-host",
      "QUESTION_SETUP",
      "admin-reference-host",
      "admin-ref-game",
      created.id,
      5,
      5,
      "COMMUNITY",
      "PUBLIC",
    );

  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string; preparedRoomCount: number; canDelete: boolean };
  assert.equal(detail.preparedRoomCount, 1);
  // 已准备房间不再阻止删除：canDelete 只看活动游戏、存储损坏与形状异常。
  assert.equal(detail.canDelete, true);

  const deleteResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(deleteResponse.status, 200, await deleteResponse.clone().text());
  const result = await deleteResponse.json() as { deleted: boolean; releasedPreparedRoomCount: number };
  assert.equal(result.deleted, true);
  assert.equal(result.releasedPreparedRoomCount, 1);

  // 题库被删除；房间保留、退回 LOBBY 并清空准备相关列，公开房间活动时间被刷新。
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM question_sets WHERE id=?").get(created.id).count, 0);
  const room = db.sqlite.prepare("SELECT * FROM rooms WHERE id='admin-reference-room'").get() as Record<string, unknown>;
  assert.equal(room.game_status, "LOBBY");
  assert.equal(room.current_presenter_player_id, null);
  assert.equal(room.current_game_id, null);
  assert.equal(room.prepared_question_set_id, null);
  assert.equal(room.prepared_question_count, null);
  assert.equal(room.lobby_question_count, null);
  assert.equal(room.prepared_question_source, null);
  assert.equal(room.room_state_revision, 1);
  assert.ok(String(room.public_activity_at) >= detail.updatedAt);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM rooms WHERE id='admin-reference-room'").get().count, 1);
});

test("question-set admin stale whole-set delete never clears prepared rooms", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-delete-stale-submission",
    title: "过期删除题库",
    playerId: "admin-delete-player",
    nickname: "管理测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };
  db.sqlite.prepare("INSERT INTO rooms (id,room_code,host_player_id,prepared_question_set_id) VALUES (?,?,?,?)")
    .run("admin-stale-room", "ADMSTL", "admin-stale-host", created.id);

  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string };
  // 先通过元数据 PATCH 推进题库版本，再用旧版本发起整库删除。
  const patchResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "PATCH",
    body: { title: "过期删除题库（已修改）", description: null, isPublic: false, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(patchResponse.status, 200, await patchResponse.clone().text());

  const staleDelete = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(staleDelete.status, 409);
  assert.match(JSON.stringify(await staleDelete.json()), /已被其他操作修改/);
  // 过期请求既不能清空房间准备，也不能删除题库。
  const room = db.sqlite.prepare("SELECT prepared_question_set_id FROM rooms WHERE id='admin-stale-room'")
    .get() as { prepared_question_set_id: string | null };
  assert.equal(room.prepared_question_set_id, created.id);
  assert.ok(db.sqlite.prepare("SELECT id FROM question_sets WHERE id=?").get(created.id));
});

test("question-set admin delete race with a newly active game does not clear prepared rooms", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-delete-game-race-submission",
    title: "并发开局删除题库",
    playerId: "admin-delete-player",
    nickname: "管理测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };
  db.sqlite.prepare(`INSERT INTO rooms
    (id,room_code,host_player_id,game_status,current_presenter_player_id,prepared_question_set_id,prepared_question_count)
    VALUES (?,?,?,?,?,?,?)`)
    .run("admin-delete-race-room", "ADMRCE", "admin-race-host", "QUESTION_SETUP", "admin-race-host", created.id, 1);

  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string; canDelete: boolean };
  assert.equal(detail.canDelete, true);
  // 模拟详情读取后、删除 batch 开始前已有游戏落库。房间释放语句和题库删除语句
  // 都必须看到该活动游戏并保持无副作用地返回 409。
  db.beforeNextBatch = () => {
    db.sqlite.prepare(`INSERT INTO game_sessions (id,room_id,question_set_id,presenter_player_id)
      VALUES (?,?,?,?)`)
      .run("admin-delete-race-game", "admin-delete-race-room", created.id, "admin-race-host");
  };
  const deleteResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt },
  }), env);
  assert.equal(deleteResponse.status, 409);
  const room = db.sqlite.prepare("SELECT game_status,prepared_question_set_id FROM rooms WHERE id='admin-delete-race-room'")
    .get() as { game_status: string; prepared_question_set_id: string | null };
  assert.deepEqual({ ...room }, { game_status: "QUESTION_SETUP", prepared_question_set_id: created.id });
  assert.ok(db.sqlite.prepare("SELECT id FROM question_sets WHERE id=?").get(created.id));
});

test("whole-set question-set deletion requires the separate delete key", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "admin-delete-key-submission",
    title: "删除密钥题库",
    playerId: "admin-delete-key-player",
    nickname: "删除密钥测试者",
    questions: [{ r2Key: uploaded.key, labelText: "答案" }],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };
  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as { updatedAt: string };
  const deleteBody = { confirmQuestionSetId: created.id, expectedUpdatedAt: detail.updatedAt };

  // 管理密钥仍然必须有效：缺少管理密钥时优先返回 401，即使删除密钥正确。
  const missingManagement = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: deleteBody,
    key: null,
  }), env);
  assert.equal(missingManagement.status, 401);

  // 缺少或错误的删除密钥返回 403，题库保持不变。
  const missingDeleteKey = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: deleteBody,
    deleteKey: null,
  }), env);
  assert.equal(missingDeleteKey.status, 403);
  assert.match(JSON.stringify(await missingDeleteKey.json()), /删除密钥无效/);
  const wrongDeleteKey = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: deleteBody,
    deleteKey: "wrong-delete-key",
  }), env);
  assert.equal(wrongDeleteKey.status, 403);
  assert.ok(db.sqlite.prepare("SELECT id FROM question_sets WHERE id=?").get(created.id));

  // 超长删除密钥同样被拒绝。
  const oversizedDeleteKey = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: deleteBody,
    deleteKey: "x".repeat(4096),
  }), env);
  assert.equal(oversizedDeleteKey.status, 403);

  // 服务器未配置删除密钥时返回 503，且不执行删除。
  delete env.QUESTION_SET_DELETE_SECRET;
  const unconfigured = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: deleteBody,
  }), env);
  assert.equal(unconfigured.status, 503);
  assert.match(JSON.stringify(await unconfigured.json()), /尚未配置/);
  assert.ok(db.sqlite.prepare("SELECT id FROM question_sets WHERE id=?").get(created.id));
  env.QUESTION_SET_DELETE_SECRET = DELETE_SECRET;

  // 正确的删除密钥可以完成删除，并返回本次释放的房间数。
  const deleted = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`, {
    method: "DELETE",
    body: deleteBody,
  }), env);
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const result = await deleted.json() as { releasedPreparedRoomCount: number };
  assert.equal(result.releasedPreparedRoomCount, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM question_sets WHERE id=?").get(created.id).count, 0);
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

test("D1 0032 adds per-question is_r18 to legacy rows and the image index with default false", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, "0031");
  sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run("r18-migration-set", "迁移前题库", "legacy-owner", 1, 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  sqlite.prepare(`INSERT INTO questions
    (id,question_set_id,image_url,order_index,label_text,label_source,created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run("r18-migration-question", "r18-migration-set", "https://example.com/old.webp", 0, "旧答案", "manual", "2026-01-01T00:00:00.000Z");
  sqlite.prepare(`INSERT INTO question_image_index
    (question_id,question_set_id,image_url,answer_text,order_index,anime_tags_json,character_tags_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run("r18-migration-question", "r18-migration-set", "https://example.com/old.webp", "旧答案", 0, "[]", "[]", "2026-01-01T00:00:00.000Z");

  const migration = readFileSync(resolve(import.meta.dirname, "..", "d1", "migrations", "0032_question_is_r18.sql"), "utf8");
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    sqlite.exec("ROLLBACK");
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM pragma_table_info('questions') WHERE name='is_r18'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM pragma_table_info('question_image_index') WHERE name='is_r18'").get().count, 0);

  sqlite.exec(migration);
  const legacy = sqlite.prepare("SELECT is_r18 FROM questions WHERE id=?").get("r18-migration-question") as { is_r18: number };
  const indexed = sqlite.prepare("SELECT is_r18 FROM question_image_index WHERE question_id=?").get("r18-migration-question") as { is_r18: number };
  assert.deepEqual([legacy.is_r18, indexed.is_r18], [0, 0]);
  sqlite.prepare("UPDATE questions SET is_r18=1 WHERE id=?").run("r18-migration-question");
  sqlite.prepare("UPDATE question_image_index SET is_r18=1 WHERE question_id=?").run("r18-migration-question");
  assert.throws(() => sqlite.prepare("UPDATE questions SET is_r18=2 WHERE id=?").run("r18-migration-question"), /CHECK/);
  assert.throws(() => sqlite.prepare("UPDATE question_image_index SET is_r18=2 WHERE question_id=?").run("r18-migration-question"), /CHECK/);
});

test("D1 0034 adds a nullable, validated, globally unique image MD5 index", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, "0033");
  sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    "md5-migration-set",
    "MD5 迁移题库",
    "migration-owner",
    1,
    2,
    "2026-08-20T00:00:00.000Z",
    "2026-08-20T00:00:00.000Z",
  );
  const insert = sqlite.prepare(`INSERT INTO question_image_index
    (question_id,question_set_id,image_url,answer_text,order_index,created_at)
    VALUES (?,?,?,?,?,?)`);
  insert.run("md5-migration-one", "md5-migration-set", "https://example.com/one.webp", "第一题", 0, "2026-08-20T00:00:00.000Z");
  insert.run("md5-migration-two", "md5-migration-set", "https://example.com/two.webp", "第二题", 1, "2026-08-20T00:00:00.000Z");
  const migration = readFileSync(resolve(import.meta.dirname, "..", "d1", "migrations", "0034_question_image_md5.sql"), "utf8");

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    sqlite.exec("ROLLBACK");
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM pragma_table_info('question_image_index') WHERE name='image_md5'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='index' AND name='question_image_index_md5_unique'").get().count, 0);

  sqlite.exec(migration);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM question_image_index WHERE image_md5 IS NULL").get().count, 2);
  const md5 = "0123456789abcdef0123456789abcdef";
  sqlite.prepare("UPDATE question_image_index SET image_md5=? WHERE question_id='md5-migration-one'").run(md5);
  assert.throws(
    () => sqlite.prepare("UPDATE question_image_index SET image_md5=? WHERE question_id='md5-migration-two'").run(md5),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => sqlite.prepare("UPDATE question_image_index SET image_md5='ABC' WHERE question_id='md5-migration-two'").run(),
    /CHECK constraint failed/,
  );
});

test("D1 0037 adds bounded Bangumi genre tags and release year to the image index", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, "0036");
  sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    "genre-tag-set",
    "属性标签题库",
    "genre-owner",
    1,
    1,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  sqlite.prepare(`INSERT INTO question_image_index
    (question_id,question_set_id,image_url,answer_text,order_index,created_at)
    VALUES (?,?,?,?,?,?)`).run(
    "genre-tag-question",
    "genre-tag-set",
    "https://example.com/a.webp",
    "答案",
    0,
    "2026-01-01T00:00:00.000Z",
  );

  sqlite.exec(readFileSync(resolve(
    import.meta.dirname, "..", "d1", "migrations", "0037_question_genre_tags.sql",
  ), "utf8"));
  const columns = new Set((sqlite.prepare("PRAGMA table_info(question_image_index)").all() as Array<{ name: string }>).map((column) => column.name));
  assert.ok(columns.has("anime_genre_tags_json"));
  assert.ok(columns.has("anime_release_year"));
  const row = sqlite.prepare("SELECT anime_genre_tags_json,anime_release_year FROM question_image_index WHERE question_id='genre-tag-question'").get() as Record<string, unknown>;
  assert.equal(row.anime_genre_tags_json, "[]");
  assert.equal(row.anime_release_year, null);

  // 超过 20 条的属性标签数组被 CHECK 拒绝；年份限制在 1950-2100。
  const tooManyTags = Array.from({ length: 21 }, (_, index) => ({ name: `标签${index}`, count: 1 }));
  assert.throws(
    () => sqlite.prepare("UPDATE question_image_index SET anime_genre_tags_json=? WHERE question_id='genre-tag-question'")
      .run(JSON.stringify(tooManyTags)),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => sqlite.prepare("UPDATE question_image_index SET anime_release_year=? WHERE question_id='genre-tag-question'")
      .run(1949),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => sqlite.prepare("UPDATE question_image_index SET anime_release_year=? WHERE question_id='genre-tag-question'")
      .run(2101),
    /CHECK constraint failed/,
  );
  sqlite.prepare(`UPDATE question_image_index
    SET anime_genre_tags_json=?,anime_release_year=? WHERE question_id='genre-tag-question'`)
    .run(JSON.stringify([{ name: "异世界", count: 8 }, { name: "恋爱", count: 3 }]), 2005);
  const updated = sqlite.prepare("SELECT anime_genre_tags_json,anime_release_year FROM question_image_index WHERE question_id='genre-tag-question'").get() as Record<string, unknown>;
  assert.deepEqual(JSON.parse(updated.anime_genre_tags_json as string), [
    { name: "异世界", count: 8 },
    { name: "恋爱", count: 3 },
  ]);
  assert.equal(updated.anime_release_year, 2005);
});

test("D1 0036 records community uploader identity and backfills first submissions", () => {
  const sqlite = new DatabaseSync(":memory:", {});
  applyMigrations(sqlite, "0035");
  sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,created_by_nickname,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    "uploader-identity-set",
    "上传者题库",
    "creator-player-id",
    "创建者昵称",
    1,
    3,
    "2026-08-21T00:00:00.000Z",
    "2026-08-21T00:00:00.000Z",
  );
  const insert = sqlite.prepare(`INSERT INTO community_question_set_submissions
    (submission_id,submission_fingerprint,question_set_id,start_order_index,added_image_count,created_at)
    VALUES (?,?,?,?,?,?)`);
  insert.run("uploader-identity-first", "a".repeat(64), "uploader-identity-set", 0, 1, "2026-08-21T00:00:00.000Z");
  insert.run("uploader-identity-second", "b".repeat(64), "uploader-identity-set", 1, 2, "2026-08-21T00:01:00.000Z");

  sqlite.exec(readFileSync(resolve(
    import.meta.dirname, "..", "d1", "migrations", "0036_question_uploader_identity.sql",
  ), "utf8"));
  const columns = new Set((sqlite.prepare("PRAGMA table_info(community_question_set_submissions)").all() as Array<{ name: string }>).map((column) => column.name));
  assert.ok(columns.has("submitted_by_player_id"));
  assert.ok(columns.has("submitted_by_nickname"));
  const rows = sqlite.prepare(`
    SELECT submission_id,submitted_by_player_id,submitted_by_nickname
    FROM community_question_set_submissions ORDER BY start_order_index
  `).all() as Array<Record<string, string | null>>;
  // 第一份投稿回填题库创建者身份；后续历史投稿保持 NULL。
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { submission_id: "uploader-identity-first", submitted_by_player_id: "creator-player-id", submitted_by_nickname: "创建者昵称" },
    { submission_id: "uploader-identity-second", submitted_by_player_id: null, submitted_by_nickname: null },
  ]);
  // 新投稿必须写入合法身份：空昵称、超长昵称、超长 player id 均被 CHECK 拒绝。
  const insertWithIdentity = sqlite.prepare(`INSERT INTO community_question_set_submissions
    (submission_id,submission_fingerprint,question_set_id,start_order_index,added_image_count,created_at,submitted_by_player_id,submitted_by_nickname)
    VALUES (?,?,?,?,?,?,?,?)`);
  assert.throws(
    () => insertWithIdentity.run("uploader-identity-empty-nick", "c".repeat(64), "uploader-identity-set", 3, 1, "2026-08-21T00:02:00.000Z", "player", "  "),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertWithIdentity.run("uploader-identity-long-nick", "d".repeat(64), "uploader-identity-set", 3, 1, "2026-08-21T00:02:00.000Z", "player", "x".repeat(21)),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertWithIdentity.run("uploader-identity-long-player", "e".repeat(64), "uploader-identity-set", 3, 1, "2026-08-21T00:02:00.000Z", "p".repeat(129), "合法昵称"),
    /CHECK constraint failed/,
  );
  // 合法身份可以写入。
  insertWithIdentity.run("uploader-identity-new", "f".repeat(64), "uploader-identity-set", 3, 1, "2026-08-21T00:02:00.000Z", "new-player-id", "新投稿者");
  assert.equal(sqlite.prepare("SELECT submitted_by_nickname FROM community_question_set_submissions WHERE submission_id='uploader-identity-new'").get().submitted_by_nickname, "新投稿者");
});

test("D1 0035 allows historical submission start ranges to repeat after structural edits", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, "0034");
  sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    "edited-range-set",
    "编辑后范围题库",
    "range-owner",
    1,
    1,
    "2026-08-21T00:00:00.000Z",
    "2026-08-21T00:00:00.000Z",
  );
  const insert = sqlite.prepare(`INSERT INTO community_question_set_submissions
    (submission_id,submission_fingerprint,question_set_id,start_order_index,added_image_count,created_at)
    VALUES (?,?,?,?,?,?)`);
  insert.run("edited-range-first-submission", "1".repeat(64), "edited-range-set", 0, 1, "2026-08-21T00:00:00.000Z");
  insert.run("edited-range-old-second", "2".repeat(64), "edited-range-set", 1, 1, "2026-08-21T00:01:00.000Z");
  assert.throws(
    () => insert.run("edited-range-before-migration", "3".repeat(64), "edited-range-set", 1, 1, "2026-08-21T00:02:00.000Z"),
    /UNIQUE constraint failed/,
  );

  const migration = readFileSync(resolve(
    import.meta.dirname,
    "..",
    "d1",
    "migrations",
    "0035_allow_structurally_edited_appends.sql",
  ), "utf8");
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(migration);
    throw new Error("injected migration failure");
  } catch {
    sqlite.exec("ROLLBACK");
  }
  assert.throws(
    () => insert.run("edited-range-after-rollback", "4".repeat(64), "edited-range-set", 1, 1, "2026-08-21T00:03:00.000Z"),
    /UNIQUE constraint failed/,
  );

  sqlite.exec(migration);
  sqlite.prepare(`INSERT INTO community_question_set_submissions
    (submission_id,submission_fingerprint,question_set_id,start_order_index,added_image_count,created_at)
    VALUES (?,?,?,?,?,?)`).run(
    "edited-range-new-append",
    "5".repeat(64),
    "edited-range-set",
    1,
    1,
    "2026-08-21T00:04:00.000Z",
  );
  const starts = sqlite.prepare(`SELECT start_order_index FROM community_question_set_submissions
    WHERE question_set_id='edited-range-set' ORDER BY created_at`).all() as Array<{ start_order_index: number }>;
  assert.deepEqual(starts.map((row) => row.start_order_index), [0, 1, 1]);
  assert.throws(
    () => sqlite.prepare(`INSERT INTO community_question_set_submissions
      (submission_id,submission_fingerprint,question_set_id,start_order_index,added_image_count,created_at)
      VALUES (?,?,?,?,?,?)`).run(
      "edited-range-new-append",
      "6".repeat(64),
      "edited-range-set",
      2,
      1,
      "2026-08-21T00:05:00.000Z",
    ),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => sqlite.prepare(`INSERT INTO community_question_set_submissions
      (submission_id,submission_fingerprint,question_set_id,start_order_index,added_image_count,created_at)
      VALUES (?,?,?,?,?,?)`).run(
      "edited-range-too-many",
      "7".repeat(64),
      "edited-range-set",
      2,
      31,
      "2026-08-21T00:06:00.000Z",
    ),
    /CHECK constraint failed/,
  );
  const rangeIndex = sqlite.prepare(`SELECT "unique" AS is_unique FROM pragma_index_list('community_question_set_submissions')
    WHERE name='community_question_set_submissions_set_idx'`).get() as { is_unique: number };
  assert.equal(rangeIndex.is_unique, 0);

  // Rebuild migration remains repeatable in isolated rollback/recovery tooling.
  sqlite.exec(migration);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM community_question_set_submissions").get().count, 3);
});

test("old manifests without is_r18 decode as false and invalid markers fail closed", () => {
  const oldManifest = JSON.stringify({
    schema: 1,
    questions: [{
      id: "legacy-manifest-question",
      image_url: "https://example.com/old.webp",
      order_index: 0,
      label_text: "旧答案",
      label_source: "manual",
      created_at: "2026-01-01T00:00:00.000Z",
    }],
  });
  const decoded = decodeQuestionSetManifest({
    id: "old-manifest-set",
    manifest_version: 1,
    manifest_json: oldManifest,
  });
  assert.equal(decoded?.[0].is_r18, false);

  const badManifest = JSON.stringify({
    schema: 1,
    questions: [{
      id: "bad-marker-question",
      image_url: "https://example.com/old.webp",
      order_index: 0,
      is_r18: "yes",
      label_text: "旧答案",
      created_at: "2026-01-01T00:00:00.000Z",
    }],
  });
  assert.throws(
    () => decodeQuestionSetManifest({ id: "bad-marker-set", manifest_version: 1, manifest_json: badManifest }),
    /成人内容标记无效/,
  );
});

test("question-set finalize persists per-question isR18 to manifest and index and rejects wrong types", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  assert.equal(uploadResponse.status, 200);
  const uploaded = await uploadResponse.json() as { key: string };

  const rejectedResponse = await worker.fetch(finalizeRequest({
    title: "R18 类型错误题库",
    playerId: "r18-player",
    nickname: "R18 上传者",
    questions: [{ r2Key: uploaded.key, labelText: "答案", isR18: "yes" }],
  }), env);
  assert.equal(rejectedResponse.status, 400);
  assert.match(JSON.stringify(await rejectedResponse.json()), /成人内容标记必须是布尔值/);

  const response = await worker.fetch(finalizeRequest({
    title: "R18 标记题库",
    playerId: "r18-player",
    nickname: "R18 上传者",
    questions: [{
      r2Key: uploaded.key,
      labelText: "答案",
      isR18: true,
      animeTags: [{ id: 2, name: "伪造番剧名", nameCn: "伪造中文名" }],
    }],
  }), env);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as { id: string };

  const row = db.sqlite.prepare("SELECT * FROM question_sets WHERE id=?").get(result.id) as Record<string, unknown>;
  assert.equal(decodeQuestionSetManifest(row)?.[0].is_r18, true);
  const indexed = db.sqlite.prepare("SELECT is_r18 FROM question_image_index WHERE question_set_id=?").get(result.id) as { is_r18: number };
  assert.equal(indexed.is_r18, 1);

  const indexResponse = await worker.fetch(new Request("https://caicai.lpp.moe/api/community-image-index?animeSubjectId=2", {
    headers: { "x-community-upload-key": UPLOAD_SECRET },
  }), env);
  assert.equal(indexResponse.status, 200);
  const indexPayload = await indexResponse.json() as { images: Array<Record<string, unknown>> };
  assert.equal(indexPayload.images[0].isR18, true);
  assert.equal("answerText" in indexPayload.images[0], false);

  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${result.id}`), env);
  const detail = await detailResponse.json() as { questions: Array<{ isR18: boolean }> };
  assert.equal(detail.questions[0].isR18, true);
});

test("same-title append keeps per-question R18 flags independent", async () => {
  const { db, env } = createTestEnv();
  const firstUpload = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const secondUpload = await worker.fetch(uploadRequest(ONE_PIXEL_WEBP, UPLOAD_SECRET, "image/webp"), env);
  const firstImage = await firstUpload.json() as { key: string };
  const secondImage = await secondUpload.json() as { key: string };
  const createdResponse = await worker.fetch(finalizeRequest({
    submissionId: "r18-append-first-submission",
    title: "R18 追加题库",
    playerId: "r18-player",
    nickname: "R18 上传者",
    questions: [{ r2Key: firstImage.key, labelText: "第一题" }],
  }), env);
  assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
  const created = await createdResponse.json() as { id: string };
  const appendedResponse = await worker.fetch(finalizeRequest({
    submissionId: "r18-append-second-submission",
    title: "R18 追加题库",
    playerId: "r18-player",
    nickname: "R18 上传者",
    questions: [{ r2Key: secondImage.key, labelText: "第二题", isR18: true }],
  }), env);
  assert.equal(appendedResponse.status, 200, await appendedResponse.clone().text());
  assert.equal((await appendedResponse.json() as { id: string }).id, created.id);

  const questionSet = db.sqlite.prepare("SELECT * FROM question_sets WHERE id=?").get(created.id) as Record<string, unknown>;
  assert.deepEqual(
    decodeQuestionSetManifest(questionSet)?.map((question) => question.is_r18),
    [false, true],
  );
  const indexed = (db.sqlite.prepare(`
    SELECT order_index,is_r18
    FROM question_image_index
    WHERE question_set_id=?
    ORDER BY order_index
  `).all(created.id) as Array<{ order_index: number; is_r18: number }>).map((row) => ({ ...row }));
  assert.deepEqual(indexed, [
    { order_index: 0, is_r18: 0 },
    { order_index: 1, is_r18: 1 },
  ]);
});

test("question-set admin shows, creates, and toggles per-question isR18 with CAS", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "r18-admin-submission",
    title: "R18 管理题库",
    playerId: "r18-player",
    nickname: "R18 上传者",
    questions: [{ r2Key: uploaded.key, labelText: "第一题" }],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };
  let detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  let detail = await detailResponse.json() as {
    updatedAt: string;
    questions: Array<{ id: string; isR18: boolean }>;
  };
  const questionId = detail.questions[0].id;
  assert.equal(detail.questions[0].isR18, false);
  const originalUpdatedAt = detail.updatedAt;

  const wrongTypeResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${questionId}`,
    { method: "PATCH", body: { isR18: 1, expectedUpdatedAt: detail.updatedAt } },
  ), env);
  assert.equal(wrongTypeResponse.status, 400);
  assert.match(JSON.stringify(await wrongTypeResponse.json()), /成人内容标记必须是布尔值/);

  const patchResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${questionId}`,
    { method: "PATCH", body: { isR18: true, expectedUpdatedAt: detail.updatedAt } },
  ), env);
  assert.equal(patchResponse.status, 200, await patchResponse.clone().text());
  detail = (await patchResponse.json() as { questionSet: typeof detail }).questionSet;
  assert.equal(detail.questions[0].isR18, true);

  const row = db.sqlite.prepare("SELECT id,manifest_version,manifest_json FROM question_sets WHERE id=?").get(created.id) as Record<string, unknown>;
  assert.equal(decodeQuestionSetManifest(row)?.[0].is_r18, true);
  const indexed = db.sqlite.prepare("SELECT is_r18 FROM question_image_index WHERE question_id=?").get(questionId) as { is_r18: number };
  assert.equal(indexed.is_r18, 1);

  const staleResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${questionId}`,
    { method: "PATCH", body: { isR18: false, expectedUpdatedAt: originalUpdatedAt } },
  ), env);
  assert.equal(staleResponse.status, 409);
});

test("question-set admin persists isR18 on legacy rows and new questions", async () => {
  const { db, env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_WEBP, UPLOAD_SECRET, "image/webp"), env);
  assert.equal(uploadResponse.status, 200);
  const uploaded = await uploadResponse.json() as { key: string };
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run("r18-legacy-set", "旧版 R18 题库", "legacy-owner", 0, 1, "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  db.sqlite.prepare(`INSERT INTO questions
    (id,question_set_id,image_url,order_index,is_r18,label_text,label_source,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      "r18-legacy-question",
      "r18-legacy-set",
      "https://example.com/legacy-r18.webp",
      0,
      1,
      "旧版答案",
      "manual",
      "2026-02-01T00:00:00.000Z",
    );

  let detailResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/r18-legacy-set"), env);
  assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
  let detail = await detailResponse.json() as {
    updatedAt: string;
    storageKind: string;
    questions: Array<{ id: string; isR18: boolean }>;
  };
  assert.equal(detail.storageKind, "rows");
  assert.equal(detail.questions[0].isR18, true);

  const patchResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/r18-legacy-set/questions/r18-legacy-question`,
    { method: "PATCH", body: { isR18: false, expectedUpdatedAt: detail.updatedAt } },
  ), env);
  assert.equal(patchResponse.status, 200, await patchResponse.clone().text());
  detail = (await patchResponse.json() as { questionSet: typeof detail }).questionSet;
  assert.equal(detail.questions[0].isR18, false);
  const legacyRow = db.sqlite.prepare("SELECT is_r18 FROM questions WHERE id='r18-legacy-question'").get() as { is_r18: number };
  assert.equal(legacyRow.is_r18, 0);

  const addResponse = await worker.fetch(questionSetAdminRequest(
    "/api/admin/question-sets/r18-legacy-set/questions",
    {
      method: "POST",
      body: {
        r2Key: uploaded.key,
        answerText: "新答案",
        isR18: true,
        expectedUpdatedAt: detail.updatedAt,
      },
    },
  ), env);
  assert.equal(addResponse.status, 200, await addResponse.clone().text());
  const added = (await addResponse.json() as { questionSet: typeof detail }).questionSet;
  assert.equal(added.questions[1].isR18, true);
  const newRow = db.sqlite.prepare("SELECT is_r18 FROM questions WHERE question_set_id='r18-legacy-set' AND order_index=1").get() as { is_r18: number };
  assert.equal(newRow.is_r18, 1);
});

test("public community question-set detail carries isR18 without changing answer exposure", async () => {
  const { env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "r18-public-detail-submission",
    title: "公开 R18 详情题库",
    playerId: "r18-player",
    nickname: "R18 上传者",
    questions: [{ r2Key: uploaded.key, labelText: "公开答案", isR18: true }],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };

  const rpcResponse = await worker.fetch(new Request("https://caicai.lpp.moe/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "getCommunityQuestionSetDetail", args: [created.id] }),
  }), env);
  assert.equal(rpcResponse.status, 200, await rpcResponse.clone().text());
  const payload = await rpcResponse.json() as { data: { questions: Array<{ isR18: boolean; imageUrl: string }> } };
  assert.equal(payload.data.questions[0].isR18, true);
  assert.equal(payload.data.questions[0].imageUrl, uploaded.url);
});

test("community finalize and admin write reject null or conflicting is_r18 / isR18", async () => {
  const { env } = createTestEnv();
  const uploadResponse = await worker.fetch(uploadRequest(ONE_PIXEL_PNG), env);
  const uploaded = await uploadResponse.json() as { key: string };

  // null 必须拒绝，不能静默当成 false。
  const nullResponse = await worker.fetch(finalizeRequest({
    title: "R18 null 题库",
    playerId: "r18-player",
    nickname: "R18 上传者",
    questions: [{ r2Key: uploaded.key, labelText: "答案", isR18: null }],
  }), env);
  assert.equal(nullResponse.status, 400);
  assert.match(JSON.stringify(await nullResponse.json()), /成人内容标记必须是布尔值/);

  // 两个字段同时存在且值冲突必须拒绝。
  const conflictResponse = await worker.fetch(finalizeRequest({
    title: "R18 冲突题库",
    playerId: "r18-player",
    nickname: "R18 上传者",
    questions: [{ r2Key: uploaded.key, labelText: "答案", is_r18: true, isR18: false }],
  }), env);
  assert.equal(conflictResponse.status, 400);
  assert.match(JSON.stringify(await conflictResponse.json()), /不一致的 is_r18 与 isR18/);

  // 管理单题写入同样拒绝 null 与冲突。
  const finalizeResponse = await worker.fetch(finalizeRequest({
    submissionId: "r18-admin-conflict-submission",
    title: "R18 管理冲突题库",
    playerId: "r18-player",
    nickname: "R18 上传者",
    questions: [{ r2Key: uploaded.key, labelText: "第一题" }],
  }), env);
  assert.equal(finalizeResponse.status, 200, await finalizeResponse.clone().text());
  const created = await finalizeResponse.json() as { id: string };
  const detailResponse = await worker.fetch(questionSetAdminRequest(`/api/admin/question-sets/${created.id}`), env);
  const detail = await detailResponse.json() as {
    updatedAt: string;
    questions: Array<{ id: string }>;
  };
  const questionId = detail.questions[0].id;

  const adminConflictResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${questionId}`,
    { method: "PATCH", body: { is_r18: false, isR18: true, expectedUpdatedAt: detail.updatedAt } },
  ), env);
  assert.equal(adminConflictResponse.status, 400);
  assert.match(JSON.stringify(await adminConflictResponse.json()), /不一致的 is_r18 与 isR18/);

  const adminNullResponse = await worker.fetch(questionSetAdminRequest(
    `/api/admin/question-sets/${created.id}/questions/${questionId}`,
    { method: "PATCH", body: { is_r18: null, expectedUpdatedAt: detail.updatedAt } },
  ), env);
  assert.equal(adminNullResponse.status, 400);
  assert.match(JSON.stringify(await adminNullResponse.json()), /成人内容标记必须是布尔值/);
});

test("admin integrity report flags is_r18 index mismatch even without a stored answer", async () => {
  const { db, env } = createTestEnv();
  db.sqlite.prepare(`INSERT INTO question_sets
    (id,title,created_by_player_id,is_public,image_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run("r18-no-answer-set", "无答案 R18 题库", "legacy-owner", 0, 1, "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  // legacy 行没有答案，但 is_r18=1；图片索引有答案且 is_r18=0。
  db.sqlite.prepare(`INSERT INTO questions
    (id,question_set_id,image_url,order_index,is_r18,label_text,label_source,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      "r18-no-answer-question",
      "r18-no-answer-set",
      "https://example.com/no-answer.webp",
      0,
      1,
      null,
      null,
      "2026-02-01T00:00:00.000Z",
    );
  db.sqlite.prepare(`INSERT INTO question_image_index
    (question_id,question_set_id,image_url,answer_text,order_index,is_r18,anime_tags_json,character_tags_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      "r18-no-answer-question",
      "r18-no-answer-set",
      "https://example.com/no-answer.webp",
      "索引答案",
      0,
      0,
      "[]",
      "[]",
      "2026-02-01T00:00:00.000Z",
    );

  const detailResponse = await worker.fetch(questionSetAdminRequest("/api/admin/question-sets/r18-no-answer-set"), env);
  assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
  const detail = await detailResponse.json() as { integrityIssues: string[]; questions: Array<{ answerText: string | null; isR18: boolean }> };
  // 存储侧答案缺失（legacy 行 label_text 为 NULL）时，答案仍取索引值，R18 mismatch 独立报告。
  assert.equal(detail.questions[0].answerText, "索引答案");
  assert.match(detail.integrityIssues.join("\n"), /成人内容标记与图片索引不一致/);
});
