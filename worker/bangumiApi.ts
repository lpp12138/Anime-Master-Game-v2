import type {
  BangumiAnimeTag,
  BangumiGenreTag,
  BangumiSubjectScope,
  BangumiSubjectType,
} from "../src/types/game";
import { normalizeBangumiSearchText } from "../src/lib/bangumiTags";

const BANGUMI_API_BASE_URL = "https://api.bgm.tv";
const BANGUMI_USER_AGENT =
  "lpp12138/Anime-Master-Game-v2 (https://github.com/lpp12138/Anime-Master-Game-v2)";
const BANGUMI_REQUEST_TIMEOUT_MS = 8_000;
const BANGUMI_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const BANGUMI_SEARCH_CACHE_SECONDS = 12 * 60 * 60;
const BANGUMI_SUBJECT_CACHE_SECONDS = 30 * 24 * 60 * 60;
const BANGUMI_CHARACTER_LIST_CACHE_SECONDS = 7 * 24 * 60 * 60;
const BANGUMI_SEARCH_LIMIT = 12;
const BANGUMI_CHARACTER_LIST_LIMIT = 1_200;
// v3 separates animation/game search payloads and adds subjectType to cached
// search/detail records plus genre tags and release date to subject details.
// Do not reuse entries whose shape lacks those fields.
const BANGUMI_CACHE_VERSION = "v3";
const CACHE_ORIGIN = "https://bangumi-cache.anime-master-game.invalid";

export const BANGUMI_SEARCH_QUERY_MIN_LENGTH = 2;
export const BANGUMI_SEARCH_QUERY_MAX_LENGTH = 80;

const BANGUMI_SCOPE_TYPE_FILTER: Record<BangumiSubjectScope, BangumiSubjectType[]> = {
  anime: [2],
  game: [4],
  all: [2, 4],
};

export function isBangumiSubjectScope(value: unknown): value is BangumiSubjectScope {
  return value === "anime" || value === "game" || value === "all";
}

export type BangumiAnimeSearchResult = BangumiAnimeTag & {
  imageUrl: string | null;
  date: string | null;
  score: number | null;
};

export type BangumiAnimeSubject = BangumiAnimeTag & {
  subjectType: BangumiSubjectType;
  /** 官方 subject 详情的用户属性标签（异世界、恋爱等），去重且有界。 */
  genreTags: BangumiGenreTag[];
  /** 官方首播/发行日期（YYYY-MM-DD），缺失时为 null。 */
  date: string | null;
};

/** 单条用户属性标签的数量上限（名称去重后保留前 N 条）。 */
export const BANGUMI_GENRE_TAG_MAX_COUNT = 20;

export function releaseYearFromBangumiDate(value: string | null): number | null {
  if (!value) return null;
  const year = Number(value.slice(0, 4));
  return Number.isInteger(year) && year >= 1950 && year <= 2100 ? year : null;
}

export type BangumiSubjectCharacter = {
  id: number;
  name: string;
  relation: string | null;
  imageUrl: string | null;
};

export class BangumiApiError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = "BangumiApiError";
  }
}

type Fetcher = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647
    ? Number(value)
    : null;
}

function safeImageUrl(value: unknown): string | null {
  const raw = cleanString(value, 1_000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function imageFromRecord(value: unknown): string | null {
  const images = asRecord(value);
  if (!images) return null;
  return safeImageUrl(images.grid ?? images.medium ?? images.large ?? images.small ?? images.common);
}

async function readJsonWithLimit(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > BANGUMI_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new BangumiApiError("Bangumi 返回的数据过大，请稍后重试。");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new BangumiApiError("Bangumi 返回了无法识别的数据。");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > BANGUMI_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BangumiApiError("Bangumi 返回的数据过大，请稍后重试。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BangumiApiError("Bangumi 返回了无法识别的数据。");
  }
}

async function fetchBangumiJson(
  path: string,
  init: RequestInit,
  fetcher: Fetcher,
  timeoutMs = BANGUMI_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${BANGUMI_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "user-agent": BANGUMI_USER_AGENT,
        ...init.headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404) throw new BangumiApiError("Bangumi 中没有找到对应条目。", 404);
      if (response.status === 429) throw new BangumiApiError("Bangumi 请求过于频繁，请稍后重试。", 503);
      throw new BangumiApiError("Bangumi 暂时不可用，请稍后重试。");
    }
    return await readJsonWithLimit(response);
  } catch (error) {
    if (error instanceof BangumiApiError) throw error;
    if (controller.signal.aborted) throw new BangumiApiError("Bangumi 请求超时，请稍后重试。", 504);
    throw new BangumiApiError("无法连接 Bangumi，请稍后重试。");
  } finally {
    clearTimeout(timeout);
  }
}

function cacheRequest(key: string): Request {
  return new Request(`${CACHE_ORIGIN}/${BANGUMI_CACHE_VERSION}/${key}`, { method: "GET" });
}

async function readCached<T>(cache: Cache, request: Request): Promise<T | null> {
  try {
    const response = await cache.match(request);
    if (!response?.ok) return null;
    return await response.json<T>();
  } catch {
    return null;
  }
}

async function writeCached(cache: Cache, request: Request, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await cache.put(request, new Response(JSON.stringify(value), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${ttlSeconds}`,
      },
    }));
  } catch (error) {
    console.warn("Bangumi server cache write failed", error);
  }
}

async function cachedLoad<T>(
  cache: Cache,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const request = cacheRequest(key);
  const cached = await readCached<T>(cache, request);
  if (cached != null) return cached;

  // Do not retain request-scoped I/O promises in module globals: Cloudflare may
  // execute concurrent requests in different I/O contexts. A simultaneous cold
  // miss can fetch twice, while subsequent requests reuse Cache API safely.
  const value = await load();
  await writeCached(cache, request, value, ttlSeconds);
  return value;
}

function normalizeSearchResult(value: unknown): BangumiAnimeSearchResult | null {
  const record = asRecord(value);
  const id = positiveInteger(record?.id);
  const name = cleanString(record?.name, 120);
  const type = Number(record?.type);
  if (!record || id == null || !name || (type !== 2 && type !== 4)) return null;
  const nameCn = cleanString(record.name_cn, 120);
  const rating = asRecord(record.rating);
  const scoreValue = Number(rating?.score);
  return {
    id,
    name,
    nameCn,
    subjectType: type as BangumiSubjectType,
    imageUrl: imageFromRecord(record.images),
    date: cleanString(record.date, 20),
    score: Number.isFinite(scoreValue) && scoreValue > 0 ? scoreValue : null,
  };
}

export async function searchBangumiAnime(
  cache: Cache,
  queryValue: string,
  scope: BangumiSubjectScope = "anime",
  fetcher: Fetcher = fetch,
  timeoutMs = BANGUMI_REQUEST_TIMEOUT_MS,
): Promise<BangumiAnimeSearchResult[]> {
  if (!isBangumiSubjectScope(scope)) throw new BangumiApiError("搜索范围无效。", 400);
  const query = queryValue.trim();
  if (query.length < BANGUMI_SEARCH_QUERY_MIN_LENGTH || query.length > BANGUMI_SEARCH_QUERY_MAX_LENGTH) {
    throw new BangumiApiError(
      `作品搜索词长度必须为 ${BANGUMI_SEARCH_QUERY_MIN_LENGTH}-${BANGUMI_SEARCH_QUERY_MAX_LENGTH} 个字符。`,
      400,
    );
  }
  const normalizedQuery = normalizeBangumiSearchText(query);
  if (!normalizedQuery) throw new BangumiApiError("作品搜索词必须包含文字或数字。", 400);
  return cachedLoad(
    cache,
    `search/${scope}/${encodeURIComponent(normalizedQuery)}`,
    BANGUMI_SEARCH_CACHE_SECONDS,
    async () => {
      const payload = await fetchBangumiJson(
        `/v0/search/subjects?limit=${BANGUMI_SEARCH_LIMIT}&offset=0`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            keyword: query,
            sort: "match",
            filter: { type: BANGUMI_SCOPE_TYPE_FILTER[scope] },
          }),
        },
        fetcher,
        timeoutMs,
      );
      const record = asRecord(payload);
      const data = Array.isArray(record?.data) ? record.data : [];
      const expectedTypes = BANGUMI_SCOPE_TYPE_FILTER[scope];
      const results = data
        .map(normalizeSearchResult)
        .filter((item): item is BangumiAnimeSearchResult => (
          item != null && expectedTypes.includes(item.subjectType)
        ));
      return results.slice(0, BANGUMI_SEARCH_LIMIT);
    },
  );
}

function normalizeSubjectCharacter(value: unknown): BangumiSubjectCharacter | null {
  const record = asRecord(value);
  const id = positiveInteger(record?.id);
  const name = cleanString(record?.name, 120);
  if (!record || id == null || !name || Number(record.type) !== 1) return null;
  return {
    id,
    name,
    relation: cleanString(record.relation, 40),
    imageUrl: imageFromRecord(record.images),
  };
}

function normalizeGenreTags(value: unknown): BangumiGenreTag[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: BangumiGenreTag[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const name = cleanString(record?.name, 40);
    if (!record || !name || seen.has(name)) continue;
    seen.add(name);
    const count = positiveInteger(record.count);
    tags.push({ name, count: count ?? 0 });
    if (tags.length >= BANGUMI_GENRE_TAG_MAX_COUNT) break;
  }
  return tags;
}

export async function getBangumiAnimeSubject(
  cache: Cache,
  subjectIdValue: number,
  fetcher: Fetcher = fetch,
  timeoutMs = BANGUMI_REQUEST_TIMEOUT_MS,
): Promise<BangumiAnimeSubject> {
  const subjectId = positiveInteger(subjectIdValue);
  if (subjectId == null) throw new BangumiApiError("Bangumi 条目 ID 无效。", 400);
  return cachedLoad(
    cache,
    `subject/${subjectId}`,
    BANGUMI_SUBJECT_CACHE_SECONDS,
    async () => {
      const payload = await fetchBangumiJson(`/v0/subjects/${subjectId}`, { method: "GET" }, fetcher, timeoutMs);
      const record = asRecord(payload);
      const id = positiveInteger(record?.id);
      const name = cleanString(record?.name, 120);
      const type = Number(record?.type);
      if (!record || id !== subjectId || !name) {
        throw new BangumiApiError("Bangumi 返回了无法识别的作品条目。");
      }
      if (type !== 2 && type !== 4) {
        throw new BangumiApiError("所选 Bangumi 条目不是动画或游戏。", 400);
      }
      return {
        id,
        name,
        nameCn: cleanString(record.name_cn, 120),
        subjectType: type as BangumiSubjectType,
        genreTags: normalizeGenreTags(record.tags),
        date: cleanString(record.date, 20),
      };
    },
  );
}

export async function getBangumiSubjectCharacters(
  cache: Cache,
  subjectIdValue: number,
  fetcher: Fetcher = fetch,
  timeoutMs = BANGUMI_REQUEST_TIMEOUT_MS,
): Promise<BangumiSubjectCharacter[]> {
  const subjectId = positiveInteger(subjectIdValue);
  if (subjectId == null) throw new BangumiApiError("Bangumi 条目 ID 无效。", 400);
  return cachedLoad(
    cache,
    `subject/${subjectId}/characters`,
    BANGUMI_CHARACTER_LIST_CACHE_SECONDS,
    async () => {
      const payload = await fetchBangumiJson(`/v0/subjects/${subjectId}/characters`, { method: "GET" }, fetcher, timeoutMs);
      if (!Array.isArray(payload)) throw new BangumiApiError("Bangumi 返回了无法识别的角色列表。");
      const seen = new Set<number>();
      const relationPriority = new Map([["主角", 0], ["配角", 1], ["客串", 2], ["闲角", 3]]);
      return payload
        .map(normalizeSubjectCharacter)
        .filter((item): item is BangumiSubjectCharacter => {
          if (!item || seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        })
        .sort((left, right) => (relationPriority.get(left.relation ?? "") ?? 9) - (relationPriority.get(right.relation ?? "") ?? 9))
        .slice(0, BANGUMI_CHARACTER_LIST_LIMIT);
    },
  );
}
