"use client";

import type { BangumiAnimeTag, BangumiCharacterTag } from "../types/game";

export type AdminQuestionSetSummary = {
  id: string;
  title: string;
  description: string | null;
  createdByPlayerId: string;
  createdByNickname: string | null;
  source: "uploaded" | "community";
  creationMethod: "player_manual" | "creation_tool_assisted" | null;
  isPublic: boolean;
  imageCount: number;
  ratingAvg: number;
  ratingCount: number;
  playCount: number;
  manifestVersion: number | null;
  manifestRevision: number;
  isCanonicalCollection: boolean;
  isStructureEdited: boolean;
  createdAt: string;
  updatedAt: string;
  gameSessionCount: number;
  archivedGameCount: number;
  preparedRoomCount: number;
  submissionCount: number;
  indexedImageCount: number;
};

export type AdminQuestionSetQuestion = {
  id: string;
  imageUrl: string;
  orderIndex: number;
  answerText: string | null;
  animeSubjectId: number | null;
  animeTags: BangumiAnimeTag[];
  characterTags: BangumiCharacterTag[];
  createdAt: string;
  answerMismatch: boolean;
};

export type AdminQuestionSetDetail = AdminQuestionSetSummary & {
  storageKind: "manifest" | "rows" | "corrupt";
  questions: AdminQuestionSetQuestion[];
  integrityIssues: string[];
  canDelete: boolean;
  canEditQuestions: boolean;
};

export type AdminQuestionSetPage = {
  items: AdminQuestionSetSummary[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number;
};

export type AdminQuestionSetFilters = {
  search: string;
  visibility: "all" | "public" | "private";
  source: "all" | "uploaded" | "community";
  limit?: number;
  offset?: number;
};

export type AdminQuestionImageCleanup = {
  candidateCount: number;
  deletedCount: number;
  preservedSharedCount: number;
  pendingCount: number;
};

export type AdminQuestionMutationResult = {
  questionSet: AdminQuestionSetDetail;
  imageCleanup: AdminQuestionImageCleanup;
};

export type AdminQuestionSetDeleteResult = {
  deleted: true;
  questionSetId: string;
  title: string;
  imageCleanup: AdminQuestionImageCleanup;
};

export class QuestionSetAdminApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "QuestionSetAdminApiError";
  }
}

const clientEnv = (import.meta as ImportMeta & { env?: ImportMetaEnv }).env ?? {} as ImportMetaEnv;

function apiUrl(path: string) {
  const base = (clientEnv.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
  return `${base}${path}`;
}

async function adminFetch<T>(
  path: string,
  uploadKey: string,
  init: RequestInit = {},
  externalSignal?: AbortSignal,
): Promise<T> {
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
    const headers = new Headers(init.headers);
    headers.set("x-community-upload-key", uploadKey.trim());
    headers.set("accept", "application/json");
    const response = await fetch(apiUrl(path), {
      ...init,
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) {
      throw new QuestionSetAdminApiError(payload.error || `题库管理请求失败（HTTP ${response.status}）。`, response.status);
    }
    return payload;
  } catch (error) {
    if (error instanceof QuestionSetAdminApiError) throw error;
    if (externalSignal?.aborted) throw new Error("操作已取消。");
    if (timedOut) throw new Error("题库管理请求超时，请检查网络后重试。");
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export function listAdminQuestionSets(
  filters: AdminQuestionSetFilters,
  uploadKey: string,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    search: filters.search.trim(),
    visibility: filters.visibility,
    source: filters.source,
    limit: String(filters.limit ?? 20),
    offset: String(filters.offset ?? 0),
  });
  return adminFetch<AdminQuestionSetPage>(`/api/admin/question-sets?${params}`, uploadKey, {}, signal);
}

export function getAdminQuestionSet(questionSetId: string, uploadKey: string, signal?: AbortSignal) {
  return adminFetch<AdminQuestionSetDetail>(
    `/api/admin/question-sets/${encodeURIComponent(questionSetId)}`,
    uploadKey,
    {},
    signal,
  );
}

export function updateAdminQuestionSet(
  questionSetId: string,
  input: { title: string; description: string | null; isPublic: boolean; expectedUpdatedAt: string },
  uploadKey: string,
  signal?: AbortSignal,
) {
  return adminFetch<AdminQuestionSetDetail>(
    `/api/admin/question-sets/${encodeURIComponent(questionSetId)}`,
    uploadKey,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
}

export function getAdminQuestionSetQuestion(
  questionSetId: string,
  questionId: string,
  uploadKey: string,
  signal?: AbortSignal,
) {
  return adminFetch<{
    questionSetId: string;
    updatedAt: string;
    canEdit: boolean;
    question: AdminQuestionSetQuestion;
  }>(
    `/api/admin/question-sets/${encodeURIComponent(questionSetId)}/questions/${encodeURIComponent(questionId)}`,
    uploadKey,
    {},
    signal,
  );
}

export type AdminQuestionWriteInput = {
  /** 仅 PATCH 可省略；省略时服务端复用现有答案（legacy 空答案题目纯调序无需补答）。 */
  answerText?: string;
  /** 仅 PATCH 可省略；省略时服务端复用已规范化的现有标签。 */
  animeTags?: BangumiAnimeTag[];
  characterTags?: BangumiCharacterTag[];
  expectedUpdatedAt: string;
  r2Key?: string;
  orderIndex?: number;
};

export function createAdminQuestionSetQuestion(
  questionSetId: string,
  input: AdminQuestionWriteInput & { r2Key: string },
  uploadKey: string,
  signal?: AbortSignal,
) {
  return adminFetch<AdminQuestionMutationResult>(
    `/api/admin/question-sets/${encodeURIComponent(questionSetId)}/questions`,
    uploadKey,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
}

export function updateAdminQuestionSetQuestion(
  questionSetId: string,
  questionId: string,
  input: AdminQuestionWriteInput,
  uploadKey: string,
  signal?: AbortSignal,
) {
  return adminFetch<AdminQuestionMutationResult>(
    `/api/admin/question-sets/${encodeURIComponent(questionSetId)}/questions/${encodeURIComponent(questionId)}`,
    uploadKey,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
}

export function deleteAdminQuestionSetQuestion(
  questionSetId: string,
  questionId: string,
  expectedUpdatedAt: string,
  uploadKey: string,
  signal?: AbortSignal,
) {
  return adminFetch<AdminQuestionMutationResult>(
    `/api/admin/question-sets/${encodeURIComponent(questionSetId)}/questions/${encodeURIComponent(questionId)}`,
    uploadKey,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmQuestionId: questionId, expectedUpdatedAt }),
    },
    signal,
  );
}

export function deleteAdminQuestionSet(
  questionSetId: string,
  expectedUpdatedAt: string,
  uploadKey: string,
  signal?: AbortSignal,
) {
  return adminFetch<AdminQuestionSetDeleteResult>(
    `/api/admin/question-sets/${encodeURIComponent(questionSetId)}`,
    uploadKey,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmQuestionSetId: questionSetId, expectedUpdatedAt }),
    },
    signal,
  );
}
