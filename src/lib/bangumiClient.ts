"use client";

import type { BangumiAnimeTag } from "../types/game";

export type BangumiAnimeSearchResult = BangumiAnimeTag & {
  imageUrl: string | null;
  date: string | null;
  score: number | null;
};

export type BangumiSubjectCharacter = {
  id: number;
  name: string;
  relation: string | null;
  imageUrl: string | null;
};

const clientEnv = (import.meta as ImportMeta & { env?: ImportMetaEnv }).env ?? {} as ImportMetaEnv;
const subjectSearchCache = new Map<string, Promise<BangumiAnimeSearchResult[]>>();
const characterListCache = new Map<string, Promise<BangumiSubjectCharacter[]>>();
const SUBJECT_SEARCH_CACHE_MAX_ENTRIES = 100;
const CHARACTER_LIST_CACHE_MAX_ENTRIES = 64;

function apiUrl(path: string) {
  const base = (clientEnv.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
  return `${base}${path}`;
}

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || fallback);
  return payload;
}

function requestHeaders(uploadKey: string) {
  return { "x-community-upload-key": uploadKey.trim() };
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, externalSignal?: AbortSignal) {
  if (externalSignal?.aborted) throw new Error("操作已取消。");
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (externalSignal?.aborted) throw new Error("操作已取消。");
    if (timedOut) throw new Error("Bangumi 请求超时，请检查网络后重试。");
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function cachePromise<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  maxEntries: number,
  load: () => Promise<V>,
): Promise<V> {
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  while (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  const promise = load();
  cache.set(key, promise);
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}

export function searchBangumiAnime(
  queryValue: string,
  uploadKey: string,
  signal?: AbortSignal,
): Promise<BangumiAnimeSearchResult[]> {
  const query = queryValue.trim();
  const normalizedUploadKey = uploadKey.trim();
  const cacheKey = `${normalizedUploadKey}\u0000${query.normalize("NFKC").toLocaleLowerCase()}`;
  return cachePromise(subjectSearchCache, cacheKey, SUBJECT_SEARCH_CACHE_MAX_ENTRIES, async () => {
    const response = await fetchWithTimeout(apiUrl(`/api/bangumi/subjects?query=${encodeURIComponent(query)}`), {
      headers: requestHeaders(normalizedUploadKey),
    }, signal);
    const payload = await readJsonResponse<{ results?: BangumiAnimeSearchResult[] }>(
      response,
      "番剧搜索失败，请稍后重试。",
    );
    return Array.isArray(payload.results) ? payload.results : [];
  });
}

export function getBangumiSubjectCharacters(
  subjectId: number,
  uploadKey: string,
  signal?: AbortSignal,
): Promise<BangumiSubjectCharacter[]> {
  const normalizedUploadKey = uploadKey.trim();
  const cacheKey = `${normalizedUploadKey}\u0000${subjectId}`;
  return cachePromise(characterListCache, cacheKey, CHARACTER_LIST_CACHE_MAX_ENTRIES, async () => {
    const response = await fetchWithTimeout(apiUrl(`/api/bangumi/subjects/${subjectId}/characters`), {
      headers: requestHeaders(normalizedUploadKey),
    }, signal);
    const payload = await readJsonResponse<{ characters?: BangumiSubjectCharacter[] }>(
      response,
      "角色列表加载失败，请稍后重试。",
    );
    return Array.isArray(payload.characters) ? payload.characters : [];
  });
}
