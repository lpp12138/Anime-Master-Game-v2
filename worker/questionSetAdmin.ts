import { normalizeBangumiQuestionTags } from "../src/lib/bangumiTags";
import type {
  BangumiAnimeTag,
  BangumiCharacterTag,
  DbQuestion,
  DbQuestionSet,
  QuestionSetCreationMethod,
  QuestionSetSource,
} from "../src/types/game";
import { decodeQuestionSetManifest } from "./questionSetManifest";

const ADMIN_QUESTION_SET_PAGE_SIZE = 20;
const ADMIN_QUESTION_SET_MAX_PAGE_SIZE = 50;
const ADMIN_QUESTION_SET_MAX_OFFSET = 10_000;
const ADMIN_QUESTION_SET_MAX_SEARCH_LENGTH = 100;
const ADMIN_QUESTION_SET_MAX_TITLE_LENGTH = 80;
const ADMIN_QUESTION_SET_MAX_DESCRIPTION_LENGTH = 300;

export class QuestionSetAdminError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "QuestionSetAdminError";
  }
}

type AdminQuestionSetDbRow = DbQuestionSet & {
  game_session_count: number;
  archived_game_count: number;
  prepared_room_count: number;
  submission_count: number;
  indexed_image_count: number;
};

type AdminQuestionIndexDbRow = {
  question_id: string;
  question_set_id: string;
  image_url: string;
  answer_text: string;
  order_index: number;
  anime_subject_id: number | null;
  anime_tags_json: string;
  character_tags_json: string;
  created_at: string;
};

export type AdminQuestionSetSummary = {
  id: string;
  title: string;
  description: string | null;
  createdByPlayerId: string;
  createdByNickname: string | null;
  source: QuestionSetSource;
  creationMethod: QuestionSetCreationMethod | null;
  isPublic: boolean;
  imageCount: number;
  ratingAvg: number;
  ratingCount: number;
  playCount: number;
  manifestVersion: number | null;
  manifestRevision: number;
  isCanonicalCollection: boolean;
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
};

export type AdminQuestionSetDeleteData = {
  id: string;
  title: string;
  imageUrls: string[];
};

function asCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function isDbTruthy(value: unknown) {
  return value === true || value === 1;
}

function assertQuestionSetId(questionSetId: string) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(questionSetId)) {
    throw new QuestionSetAdminError("题库标识无效。", 400);
  }
}

function normalizeExpectedUpdatedAt(value: unknown) {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new QuestionSetAdminError("题库版本无效，请刷新后重试。", 400);
  }
  return value;
}

function normalizeVisibility(value: string | null) {
  if (value == null || value === "" || value === "all") return "all" as const;
  if (value === "public" || value === "private") return value;
  throw new QuestionSetAdminError("公开状态筛选无效。", 400);
}

function normalizeSource(value: string | null) {
  if (value == null || value === "" || value === "all") return "all" as const;
  if (value === "uploaded" || value === "community") return value;
  throw new QuestionSetAdminError("题库来源筛选无效。", 400);
}

function normalizeListNumber(value: string | null, fallback: number, minimum: number, maximum: number, field: string) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new QuestionSetAdminError(`${field}参数无效。`, 400);
  }
  return number;
}

function toSummary(row: AdminQuestionSetDbRow): AdminQuestionSetSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    createdByPlayerId: row.created_by_player_id,
    createdByNickname: row.created_by_nickname ?? null,
    source: row.source,
    creationMethod: row.creation_method ?? null,
    isPublic: isDbTruthy(row.is_public),
    imageCount: asCount(row.image_count),
    ratingAvg: Number.isFinite(Number(row.rating_avg)) ? Number(row.rating_avg) : 0,
    ratingCount: asCount(row.rating_count),
    playCount: asCount(row.play_count),
    manifestVersion: typeof row.manifest_version === "number" ? row.manifest_version : null,
    manifestRevision: asCount(row.manifest_revision),
    isCanonicalCollection: typeof row.community_collection_title === "string",
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    gameSessionCount: asCount(row.game_session_count),
    archivedGameCount: asCount(row.archived_game_count),
    preparedRoomCount: asCount(row.prepared_room_count),
    submissionCount: asCount(row.submission_count),
    indexedImageCount: asCount(row.indexed_image_count),
  };
}

const ADMIN_QUESTION_SET_SELECT = `
  qs.id, qs.title, qs.description, qs.created_by_player_id, qs.created_by_nickname,
  qs.source, qs.creation_method, qs.is_public, qs.image_count,
  qs.rating_avg, qs.rating_count, qs.play_count,
  qs.manifest_version, qs.manifest_revision, qs.manifest_json,
  qs.community_submission_id, qs.community_collection_title, qs.created_at, qs.updated_at,
  (SELECT COUNT(*) FROM game_sessions gs WHERE gs.question_set_id = qs.id) AS game_session_count,
  (SELECT COUNT(*) FROM game_result_archives ga WHERE ga.question_set_id = qs.id) AS archived_game_count,
  (SELECT COUNT(*) FROM rooms r WHERE r.prepared_question_set_id = qs.id) AS prepared_room_count,
  (SELECT COUNT(*) FROM community_question_set_submissions cs WHERE cs.question_set_id = qs.id) AS submission_count,
  (SELECT COUNT(*) FROM question_image_index qi WHERE qi.question_set_id = qs.id) AS indexed_image_count`;

async function getQuestionSetRow(db: D1Database, questionSetId: string) {
  assertQuestionSetId(questionSetId);
  return db.prepare(`SELECT ${ADMIN_QUESTION_SET_SELECT} FROM question_sets qs WHERE qs.id = ?`)
    .bind(questionSetId)
    .first<AdminQuestionSetDbRow>();
}

export async function listAdminQuestionSets(db: D1Database, url: URL) {
  const search = (url.searchParams.get("search") ?? "").trim();
  if (search.length > ADMIN_QUESTION_SET_MAX_SEARCH_LENGTH) {
    throw new QuestionSetAdminError(`搜索内容最多 ${ADMIN_QUESTION_SET_MAX_SEARCH_LENGTH} 个字符。`, 400);
  }
  const visibility = normalizeVisibility(url.searchParams.get("visibility"));
  const source = normalizeSource(url.searchParams.get("source"));
  const limit = normalizeListNumber(
    url.searchParams.get("limit"),
    ADMIN_QUESTION_SET_PAGE_SIZE,
    1,
    ADMIN_QUESTION_SET_MAX_PAGE_SIZE,
    "每页数量",
  );
  const offset = normalizeListNumber(url.searchParams.get("offset"), 0, 0, ADMIN_QUESTION_SET_MAX_OFFSET, "分页偏移");

  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (search) {
    clauses.push(`(
      instr(lower(qs.title), lower(?)) > 0 OR
      instr(lower(qs.id), lower(?)) > 0 OR
      instr(lower(COALESCE(qs.created_by_nickname, '')), lower(?)) > 0
    )`);
    bindings.push(search, search, search);
  }
  if (visibility !== "all") {
    clauses.push("qs.is_public = ?");
    bindings.push(visibility === "public" ? 1 : 0);
  }
  if (source !== "all") {
    clauses.push("qs.source = ?");
    bindings.push(source);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const [pageResult, countRow] = await Promise.all([
    db.prepare(`
      SELECT ${ADMIN_QUESTION_SET_SELECT}
      FROM question_sets qs
      ${where}
      ORDER BY COALESCE(qs.updated_at, qs.created_at) DESC, qs.created_at DESC, qs.id DESC
      LIMIT ? OFFSET ?
    `).bind(...bindings, limit, offset).all<AdminQuestionSetDbRow>(),
    db.prepare(`SELECT COUNT(*) AS count FROM question_sets qs ${where}`)
      .bind(...bindings)
      .first<{ count: number }>(),
  ]);
  const items = (pageResult.results ?? []).map(toSummary);
  const total = asCount(countRow?.count);
  return {
    items,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
    nextOffset: Math.min(total, offset + items.length),
  };
}

async function getLegacyQuestions(db: D1Database, questionSetId: string) {
  const result = await db.prepare(`
    SELECT id, question_set_id, image_url, order_index, label_text, label_source,
           label_source_answer_id, label_updated_by_player_id, label_updated_at, created_at
    FROM questions
    WHERE question_set_id = ?
    ORDER BY order_index ASC, id ASC
    LIMIT 31
  `).bind(questionSetId).all<DbQuestion>();
  return result.results ?? [];
}

async function getIndexedQuestions(db: D1Database, questionSetId: string) {
  const result = await db.prepare(`
    SELECT question_id, question_set_id, image_url, answer_text, order_index,
           anime_subject_id, anime_tags_json, character_tags_json, created_at
    FROM question_image_index
    WHERE question_set_id = ?
    ORDER BY order_index ASC, question_id ASC
    LIMIT 31
  `).bind(questionSetId).all<AdminQuestionIndexDbRow>();
  return result.results ?? [];
}

function parseQuestionTags(row: AdminQuestionIndexDbRow, integrityIssues: string[]) {
  try {
    const normalized = normalizeBangumiQuestionTags(
      JSON.parse(row.anime_tags_json),
      JSON.parse(row.character_tags_json),
    );
    if ((normalized.animeTags[0]?.id ?? null) !== row.anime_subject_id) {
      throw new Error("番剧索引不一致");
    }
    return normalized;
  } catch {
    integrityIssues.push(`第 ${row.order_index + 1} 题的 Bangumi 标签索引无效。`);
    return { animeTags: [], characterTags: [] };
  }
}

export async function getAdminQuestionSetDetail(db: D1Database, questionSetId: string): Promise<AdminQuestionSetDetail> {
  const row = await getQuestionSetRow(db, questionSetId);
  if (!row) throw new QuestionSetAdminError("题库不存在。", 404);

  const integrityIssues: string[] = [];
  let storageKind: AdminQuestionSetDetail["storageKind"] = row.manifest_version == null ? "rows" : "manifest";
  let storedQuestions: DbQuestion[] = [];
  if (row.manifest_version == null) {
    storedQuestions = await getLegacyQuestions(db, questionSetId);
  } else {
    try {
      storedQuestions = decodeQuestionSetManifest(row) ?? [];
    } catch {
      storageKind = "corrupt";
      integrityIssues.push("题库 manifest 无法解析；为避免丢失图片，修复前禁止删除。");
    }
  }

  const indexedQuestions = await getIndexedQuestions(db, questionSetId);
  const indexedById = new Map(indexedQuestions.map((question) => [question.question_id, question]));
  const sourceQuestions = storedQuestions.length > 0
    ? storedQuestions
    : indexedQuestions.map((question): DbQuestion => ({
        id: question.question_id,
        question_set_id: question.question_set_id,
        image_url: question.image_url,
        order_index: question.order_index,
        label_text: question.answer_text,
        label_source: "manual",
        created_at: question.created_at,
      }));

  const questions = sourceQuestions.map((question): AdminQuestionSetQuestion => {
    const indexed = indexedById.get(question.id);
    const tags = indexed ? parseQuestionTags(indexed, integrityIssues) : { animeTags: [], characterTags: [] };
    const storedAnswer = question.label_text?.trim() || null;
    const indexedAnswer = indexed?.answer_text.trim() || null;
    const answerMismatch = Boolean(indexed && storedAnswer !== indexedAnswer);
    if (answerMismatch) integrityIssues.push(`第 ${question.order_index + 1} 题的 manifest 与图片索引答案不一致。`);
    if (indexed && (indexed.image_url !== question.image_url || indexed.order_index !== question.order_index)) {
      integrityIssues.push(`第 ${question.order_index + 1} 题的图片索引与题库顺序不一致。`);
    }
    return {
      id: question.id,
      imageUrl: question.image_url,
      orderIndex: question.order_index,
      answerText: indexedAnswer ?? storedAnswer,
      animeSubjectId: indexed?.anime_subject_id ?? null,
      animeTags: tags.animeTags,
      characterTags: tags.characterTags,
      createdAt: question.created_at,
      answerMismatch,
    };
  });

  const unrepresentedIndexRows = indexedQuestions.filter((question) => !sourceQuestions.some((stored) => stored.id === question.question_id));
  if (unrepresentedIndexRows.length > 0 && storedQuestions.length > 0) {
    integrityIssues.push(`图片索引中存在 ${unrepresentedIndexRows.length} 道未写入题库存储的题目。`);
  }
  if (sourceQuestions.length !== asCount(row.image_count)) {
    integrityIssues.push(`题目存储数量 ${sourceQuestions.length} 与题库计数 ${asCount(row.image_count)} 不一致。`);
  }
  if (sourceQuestions.some((question, index) => question.order_index !== index)) {
    integrityIssues.push("题目顺序不是从 0 开始的连续序列。");
  }

  const summary = toSummary(row);
  return {
    ...summary,
    storageKind,
    questions,
    integrityIssues: [...new Set(integrityIssues)],
    canDelete: summary.gameSessionCount === 0
      && summary.preparedRoomCount === 0
      && storageKind !== "corrupt",
  };
}

function isUniqueConstraintError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|SQLITE_CONSTRAINT_UNIQUE|D1_ERROR.*UNIQUE/i.test(message);
}

function isQuestionSetReferenceConstraintError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /question set is prepared by a room|foreign key constraint|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(message);
}

function nextUpdatedAt(previous: string) {
  const previousMs = Date.parse(previous);
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
}

export async function updateAdminQuestionSet(db: D1Database, questionSetId: string, payload: unknown) {
  assertQuestionSetId(questionSetId);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new QuestionSetAdminError("题库更新请求无效。", 400);
  }
  const input = payload as Record<string, unknown>;
  if (!("title" in input) && !("description" in input) && !("isPublic" in input)) {
    throw new QuestionSetAdminError("没有需要保存的题库修改。", 400);
  }
  const expectedUpdatedAt = normalizeExpectedUpdatedAt(input.expectedUpdatedAt);
  const current = await getQuestionSetRow(db, questionSetId);
  if (!current) throw new QuestionSetAdminError("题库不存在。", 404);
  const currentUpdatedAt = current.updated_at ?? current.created_at;
  if (currentUpdatedAt !== expectedUpdatedAt) {
    throw new QuestionSetAdminError("题库已被其他操作修改，请刷新后重试。", 409);
  }

  let title = current.title;
  if ("title" in input) {
    if (typeof input.title !== "string") throw new QuestionSetAdminError("题库标题无效。", 400);
    title = input.title.replace(/[\r\n]+/g, " ").trim();
    if (!title) throw new QuestionSetAdminError("题库标题不能为空。", 400);
    if (title.length > ADMIN_QUESTION_SET_MAX_TITLE_LENGTH) {
      throw new QuestionSetAdminError(`题库标题最多 ${ADMIN_QUESTION_SET_MAX_TITLE_LENGTH} 个字符。`, 400);
    }
  }

  let description = current.description ?? null;
  if ("description" in input) {
    if (input.description !== null && typeof input.description !== "string") {
      throw new QuestionSetAdminError("题库说明无效。", 400);
    }
    description = typeof input.description === "string" ? input.description.trim() || null : null;
    if (description && description.length > ADMIN_QUESTION_SET_MAX_DESCRIPTION_LENGTH) {
      throw new QuestionSetAdminError(`题库说明最多 ${ADMIN_QUESTION_SET_MAX_DESCRIPTION_LENGTH} 个字符。`, 400);
    }
  }

  const wasPublic = isDbTruthy(current.is_public);
  let isPublic = wasPublic;
  if ("isPublic" in input) {
    if (typeof input.isPublic !== "boolean") throw new QuestionSetAdminError("题库公开状态无效。", 400);
    isPublic = input.isPublic;
  }
  const canonicalTitle = !isPublic
    ? null
    : current.community_collection_title != null
      ? title
      : !wasPublic && current.community_submission_id != null
        ? title
        : null;
  const updatedAt = nextUpdatedAt(currentUpdatedAt);

  let updated: { id: string } | null;
  try {
    updated = await db.prepare(`
      UPDATE question_sets
      SET title = ?, description = ?, is_public = ?, community_collection_title = ?, updated_at = ?
      WHERE id = ? AND COALESCE(updated_at, created_at) = ?
      RETURNING id
    `).bind(
      title,
      description,
      isPublic ? 1 : 0,
      canonicalTitle,
      updatedAt,
      questionSetId,
      expectedUpdatedAt,
    ).first<{ id: string }>();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new QuestionSetAdminError(`同名规范社区题库“${title}”已存在，请更换标题后重试。`, 409);
    }
    throw error;
  }
  if (!updated) {
    const exists = await db.prepare("SELECT id FROM question_sets WHERE id = ?").bind(questionSetId).first<{ id: string }>();
    if (!exists) throw new QuestionSetAdminError("题库不存在。", 404);
    throw new QuestionSetAdminError("题库已被其他操作修改，请刷新后重试。", 409);
  }
  return getAdminQuestionSetDetail(db, questionSetId);
}

export async function deleteAdminQuestionSet(
  db: D1Database,
  questionSetId: string,
  payload: unknown,
): Promise<AdminQuestionSetDeleteData> {
  assertQuestionSetId(questionSetId);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new QuestionSetAdminError("题库删除请求无效。", 400);
  }
  const input = payload as Record<string, unknown>;
  if (input.confirmQuestionSetId !== questionSetId) {
    throw new QuestionSetAdminError("删除确认标识不匹配。", 400);
  }
  const expectedUpdatedAt = normalizeExpectedUpdatedAt(input.expectedUpdatedAt);
  const detail = await getAdminQuestionSetDetail(db, questionSetId);
  if (detail.updatedAt !== expectedUpdatedAt) {
    throw new QuestionSetAdminError("题库已被其他操作修改，请刷新后重试。", 409);
  }
  if (detail.storageKind === "corrupt") {
    throw new QuestionSetAdminError("题库 manifest 已损坏；为避免遗留无法追踪的图片，修复前不能删除。", 409);
  }
  if (!detail.canDelete) {
    throw new QuestionSetAdminError(
      `题库仍被 ${detail.gameSessionCount} 局活动游戏或 ${detail.preparedRoomCount} 个房间引用；请先结束游戏或取消房间准备，不能直接删除。`,
      409,
    );
  }

  let deleted: { id: string } | null;
  try {
    deleted = await db.prepare(`
      DELETE FROM question_sets
      WHERE id = ?
        AND COALESCE(updated_at, created_at) = ?
        AND NOT EXISTS (SELECT 1 FROM game_sessions gs WHERE gs.question_set_id = question_sets.id)
        AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.prepared_question_set_id = question_sets.id)
      RETURNING id
    `).bind(questionSetId, expectedUpdatedAt).first<{ id: string }>();
  } catch (error) {
    if (isQuestionSetReferenceConstraintError(error)) {
      throw new QuestionSetAdminError("题库引用或版本刚刚发生变化，请刷新后重试。", 409);
    }
    throw error;
  }
  if (!deleted) {
    const exists = await db.prepare("SELECT id FROM question_sets WHERE id = ?").bind(questionSetId).first<{ id: string }>();
    if (!exists) throw new QuestionSetAdminError("题库不存在。", 404);
    throw new QuestionSetAdminError("题库引用或版本刚刚发生变化，请刷新后重试。", 409);
  }

  return {
    id: detail.id,
    title: detail.title,
    imageUrls: [...new Set(detail.questions.map((question) => question.imageUrl).filter(Boolean))],
  };
}
