import { normalizeBangumiQuestionTags } from "../src/lib/bangumiTags";
import type {
  BangumiAnimeTag,
  BangumiCharacterTag,
  DbQuestion,
  DbQuestionSet,
  QuestionSetCreationMethod,
  QuestionSetSource,
} from "../src/types/game";
import { decodeQuestionSetManifest, encodeDbQuestionSetManifest, QUESTION_SET_MANIFEST_MAX_QUESTIONS } from "./questionSetManifest";

const ADMIN_QUESTION_SET_PAGE_SIZE = 20;
const ADMIN_QUESTION_SET_MAX_PAGE_SIZE = 50;
const ADMIN_QUESTION_SET_MAX_OFFSET = 10_000;
const ADMIN_QUESTION_SET_MAX_SEARCH_LENGTH = 100;
const ADMIN_QUESTION_SET_MAX_TITLE_LENGTH = 80;
const ADMIN_QUESTION_SET_MAX_DESCRIPTION_LENGTH = 300;

// Must stay aligned with the question_image_index.image_url CHECK constraint
// (length BETWEEN 1 AND 2048). JavaScript string length never underestimates
// SQLite length() for surrogate pairs, so this check is fail-closed against the
// D1 CHECK when re-writing the whole index during any single-question mutation.
const ADMIN_QUESTION_IMAGE_URL_MAX_LENGTH = 2048;

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
  is_r18: number | boolean | null;
  image_md5: string | null;
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
  isR18: boolean;
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

export type AdminQuestionSetDeleteData = {
  id: string;
  title: string;
  imageUrls: string[];
  /** 删除时在同一 D1 batch 中被原子取消准备（退回 LOBBY）的房间数。 */
  releasedPreparedRoomCount: number;
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

function assertQuestionId(questionId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(questionId)) {
    throw new QuestionSetAdminError("题目标识无效。", 400);
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
    isStructureEdited: isDbTruthy(row.community_structure_edited),
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
  qs.community_submission_id, qs.community_collection_title, qs.community_structure_edited,
  qs.created_at, qs.updated_at,
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
    SELECT id, question_set_id, image_url, order_index, is_r18, label_text, label_source,
           label_source_answer_id, label_updated_by_player_id, label_updated_at, created_at
    FROM questions
    WHERE question_set_id = ?
    ORDER BY order_index ASC, id ASC
    LIMIT ${QUESTION_SET_MANIFEST_MAX_QUESTIONS + 1}
  `).bind(questionSetId).all<DbQuestion>();
  return result.results ?? [];
}

async function getIndexedQuestions(db: D1Database, questionSetId: string) {
  const result = await db.prepare(`
    SELECT question_id, question_set_id, image_url, answer_text, order_index, is_r18, image_md5,
           anime_subject_id, anime_tags_json, character_tags_json, created_at
    FROM question_image_index
    WHERE question_set_id = ?
    ORDER BY order_index ASC, question_id ASC
    LIMIT ${QUESTION_SET_MANIFEST_MAX_QUESTIONS + 1}
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
      throw new Error("作品索引不一致");
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
        is_r18: question.is_r18 ?? 0,
        label_text: question.answer_text,
        label_source: "manual",
        created_at: question.created_at,
      }));

  const questions = sourceQuestions.map((question): AdminQuestionSetQuestion => {
    if (!question.image_url || question.image_url.length > ADMIN_QUESTION_IMAGE_URL_MAX_LENGTH) {
      integrityIssues.push(
        `第 ${question.order_index + 1} 题的图片地址${question.image_url ? "超过 2048 字符上限" : "为空"}，无法写入图片索引；单题修改会被拒绝，请先在存储层修复。`,
      );
    }
    const indexed = indexedById.get(question.id);
    const tags = indexed ? parseQuestionTags(indexed, integrityIssues) : { animeTags: [], characterTags: [] };
    const storedAnswer = question.label_text?.trim() || null;
    const indexedAnswer = indexed?.answer_text.trim() || null;
    const answerMismatch = Boolean(indexed && storedAnswer !== indexedAnswer);
    if (answerMismatch) integrityIssues.push(`第 ${question.order_index + 1} 题的 manifest 与图片索引答案不一致。`);
    if (indexed && (indexed.image_url !== question.image_url || indexed.order_index !== question.order_index)) {
      integrityIssues.push(`第 ${question.order_index + 1} 题的图片索引与题库顺序不一致。`);
    }
    // R18 mismatch 独立于答案检查：即使存储侧没有答案，只要 manifest/legacy 行与
    // 图片索引的成人内容标记不一致，就必须报告，避免完整性报告漏报。
    if (indexed && isDbTruthy(indexed.is_r18) !== isDbTruthy(question.is_r18)) {
      integrityIssues.push(`第 ${question.order_index + 1} 题的成人内容标记与图片索引不一致。`);
    }
    return {
      id: question.id,
      imageUrl: question.image_url,
      orderIndex: question.order_index,
      isR18: isDbTruthy(question.is_r18 ?? indexed?.is_r18),
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
  // 社区题库可累计超过 30 题，因此这里的“形状异常”只以存储安全上限为界。
  const hasQuestionShapeIssue = sourceQuestions.length > QUESTION_SET_MANIFEST_MAX_QUESTIONS
    || sourceQuestions.length !== asCount(row.image_count)
    || sourceQuestions.some((question, index) => question.order_index !== index);
  const hasUnwritableImageUrl = sourceQuestions.some(
    (question) => !question.image_url || question.image_url.length > ADMIN_QUESTION_IMAGE_URL_MAX_LENGTH,
  );
  return {
    ...summary,
    storageKind,
    questions,
    integrityIssues: [...new Set(integrityIssues)],
    // 已准备房间不阻止删除：整库 DELETE 会在同一 D1 batch 中先原子取消引用
    // 房间的准备（退回 LOBBY），只有活动游戏、损坏存储和形状异常才禁止删除。
    canDelete: summary.gameSessionCount === 0
      && storageKind !== "corrupt"
      && !hasQuestionShapeIssue,
    canEditQuestions: summary.gameSessionCount === 0
      && summary.preparedRoomCount === 0
      && storageKind !== "corrupt"
      && !hasQuestionShapeIssue
      && !hasUnwritableImageUrl,
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
      : !wasPublic
          && current.community_submission_id != null
          && !isDbTruthy(current.community_structure_edited)
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

type AdminQuestionTags = {
  animeTags: BangumiAnimeTag[];
  characterTags: BangumiCharacterTag[];
};

// answerText/animeTags/characterTags/imageUrl are optional for PATCH: an
// order-only request omits them and the server reuses the stored answer, image
// and the already-canonical index tags (legacy null-answer questions can be
// reordered without being forced to fill an answer).
type AdminQuestionWriteInput = {
  answerText?: string;
  animeTags?: BangumiAnimeTag[];
  characterTags?: BangumiCharacterTag[];
  imageUrl?: string;
  /** 服务端从对应 R2 对象 ETag 验证得到，不接受浏览器直接指定。 */
  imageMd5?: string;
  /** 省略时服务端复用现有值（创建默认 false）。 */
  isR18?: boolean;
  expectedUpdatedAt: string;
  orderIndex?: number;
};

type AdminQuestionMutationState = {
  row: AdminQuestionSetDbRow;
  questions: DbQuestion[];
  indexedById: Map<string, AdminQuestionIndexDbRow>;
};

export type AdminQuestionMutationData = {
  questionSet: AdminQuestionSetDetail;
  removedImageUrls: string[];
};

function normalizeAdminAnswer(value: string) {
  const answer = value.trim();
  if (!answer) throw new QuestionSetAdminError("正确答案不能为空。", 400);
  if (answer.length > 100) throw new QuestionSetAdminError("正确答案最多 100 个字符。", 400);
  return answer;
}

function normalizeAdminImageUrl(value: string) {
  const imageUrl = value.trim();
  if (!imageUrl || imageUrl.length > 2048) throw new QuestionSetAdminError("题目图片地址无效。", 400);
  try {
    const url = new URL(imageUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
  } catch {
    throw new QuestionSetAdminError("题目图片地址无效。", 400);
  }
  return imageUrl;
}

function normalizeAdminQuestionTags(input: Pick<AdminQuestionWriteInput, "animeTags" | "characterTags">) {
  try {
    return normalizeBangumiQuestionTags(input.animeTags ?? [], input.characterTags ?? []);
  } catch (error) {
    throw new QuestionSetAdminError(error instanceof Error ? error.message : "Bangumi 标签无效。", 400);
  }
}

async function loadAdminQuestionMutationState(
  db: D1Database,
  questionSetId: string,
  expectedUpdatedAt: string,
): Promise<AdminQuestionMutationState> {
  const row = await getQuestionSetRow(db, questionSetId);
  if (!row) throw new QuestionSetAdminError("题库不存在。", 404);
  const currentUpdatedAt = row.updated_at ?? row.created_at;
  if (currentUpdatedAt !== expectedUpdatedAt) {
    throw new QuestionSetAdminError("题库已被其他操作修改，请刷新后重试。", 409);
  }
  if (asCount(row.game_session_count) > 0 || asCount(row.prepared_room_count) > 0) {
    throw new QuestionSetAdminError(
      `题库仍被 ${asCount(row.game_session_count)} 局活动游戏或 ${asCount(row.prepared_room_count)} 个房间引用；请先结束游戏或取消房间准备。`,
      409,
    );
  }

  let questions: DbQuestion[];
  if (row.manifest_version == null) {
    questions = await getLegacyQuestions(db, questionSetId);
  } else {
    try {
      questions = decodeQuestionSetManifest(row) ?? [];
    } catch {
      throw new QuestionSetAdminError("题库 manifest 已损坏；修复前不能修改单题。", 409);
    }
  }
  if (
    questions.length > QUESTION_SET_MANIFEST_MAX_QUESTIONS
    || questions.length !== asCount(row.image_count)
    || questions.some((question, index) => question.order_index !== index)
  ) {
    throw new QuestionSetAdminError("题库存储数量或顺序不一致；修复前不能修改单题。", 409);
  }
  const unwritableImageUrl = questions.find(
    (question) => !question.image_url || question.image_url.length > ADMIN_QUESTION_IMAGE_URL_MAX_LENGTH,
  );
  if (unwritableImageUrl) {
    // Every single-question mutation re-writes the full question_image_index.
    // Fail closed with an explicit conflict instead of surfacing the D1 CHECK
    // constraint as an opaque 500 after the batch is attempted.
    throw new QuestionSetAdminError(
      `题库第 ${unwritableImageUrl.order_index + 1} 题的图片地址${unwritableImageUrl.image_url ? "超过 2048 字符上限" : "为空"}，无法安全重写图片索引；修复前不能修改单题。`,
      409,
    );
  }
  const indexedQuestions = await getIndexedQuestions(db, questionSetId);
  return {
    row,
    questions,
    indexedById: new Map(indexedQuestions.map((question) => [question.question_id, question])),
  };
}

function tagsEqual(indexed: AdminQuestionIndexDbRow | undefined, tags: AdminQuestionTags) {
  if (!indexed) return tags.animeTags.length === 0 && tags.characterTags.length === 0;
  try {
    const current = normalizeBangumiQuestionTags(
      JSON.parse(indexed.anime_tags_json),
      JSON.parse(indexed.character_tags_json),
    );
    return JSON.stringify(current.animeTags) === JSON.stringify(tags.animeTags)
      && JSON.stringify(current.characterTags) === JSON.stringify(tags.characterTags);
  } catch {
    return false;
  }
}

function buildAdminQuestionIndexStatements(
  db: D1Database,
  questionSetId: string,
  updatedAt: string,
  questions: DbQuestion[],
  indexedById: Map<string, AdminQuestionIndexDbRow>,
  tagOverrides: Map<string, AdminQuestionTags>,
  imageMd5Overrides: Map<string, string | null>,
) {
  const guard = "SELECT 1 FROM question_sets WHERE id=? AND COALESCE(updated_at,created_at)=?";
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM question_image_index
      WHERE question_set_id=? AND EXISTS (${guard})`)
      .bind(questionSetId, questionSetId, updatedAt),
  ];
  for (const question of questions) {
    const indexed = indexedById.get(question.id);
    const storedAnswer = question.label_text?.trim() ?? "";
    const indexedAnswer = indexed?.answer_text.trim() ?? "";
    // A legacy mismatch may contain an empty/oversized stored label while its
    // index still has a valid answer. Preserve that valid index row during an
    // unrelated reorder instead of deleting it in the full index rebuild.
    const answerText = storedAnswer && storedAnswer.length <= 100 ? storedAnswer : indexedAnswer;
    if (!answerText || answerText.length > 100) continue;
    const override = tagOverrides.get(question.id);
    const animeSubjectId = override
      ? override.animeTags[0]?.id ?? null
      : indexed?.anime_subject_id ?? null;
    const animeTagsJson = override ? JSON.stringify(override.animeTags) : indexed?.anime_tags_json ?? "[]";
    const characterTagsJson = override ? JSON.stringify(override.characterTags) : indexed?.character_tags_json ?? "[]";
    const imageMd5 = imageMd5Overrides.has(question.id)
      ? imageMd5Overrides.get(question.id) ?? null
      : indexed?.image_md5 ?? null;
    statements.push(db.prepare(`INSERT INTO question_image_index (
        question_id,question_set_id,image_url,answer_text,order_index,
        anime_subject_id,anime_tags_json,character_tags_json,created_at,is_r18,image_md5
      )
      SELECT ?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (${guard})`)
      .bind(
        question.id,
        questionSetId,
        question.image_url,
        answerText,
        question.order_index,
        animeSubjectId,
        animeTagsJson,
        characterTagsJson,
        indexed?.created_at ?? question.created_at,
        isDbTruthy(question.is_r18) ? 1 : 0,
        imageMd5,
        questionSetId,
        updatedAt,
      ));
  }
  return statements;
}

async function executeAdminQuestionMutation(
  db: D1Database,
  state: AdminQuestionMutationState,
  questions: DbQuestion[],
  tagOverrides: Map<string, AdminQuestionTags>,
  imageMd5Overrides: Map<string, string | null>,
  structuralChange: boolean,
): Promise<AdminQuestionSetDetail> {
  const currentUpdatedAt = state.row.updated_at ?? state.row.created_at;
  const updatedAt = nextUpdatedAt(currentUpdatedAt);
  const currentStructureEdited = isDbTruthy(state.row.community_structure_edited);
  const nextStructureEdited = currentStructureEdited
    || Boolean(structuralChange && state.row.community_submission_id);
  const nextCollectionTitle = nextStructureEdited || structuralChange
    ? null
    : state.row.community_collection_title ?? null;
  const statements: D1PreparedStatement[] = [];

  if (state.row.manifest_version == null) {
    statements.push(db.prepare(`UPDATE question_sets
      SET image_count=?,image_urls_text=NULL,community_collection_title=?,
          community_structure_edited=?,updated_at=?
      WHERE id=? AND COALESCE(updated_at,created_at)=? AND manifest_version IS NULL
        AND NOT EXISTS (SELECT 1 FROM game_sessions gs WHERE gs.question_set_id=question_sets.id)
        AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.prepared_question_set_id=question_sets.id)
      RETURNING id`)
      .bind(
        questions.length,
        nextCollectionTitle,
        nextStructureEdited ? 1 : 0,
        updatedAt,
        state.row.id,
        currentUpdatedAt,
      ));
  } else {
    const currentRevision = asCount(state.row.manifest_revision);
    statements.push(db.prepare(`UPDATE question_sets
      SET image_count=?,image_urls_text=NULL,manifest_revision=?,manifest_json=?,
          community_collection_title=?,community_structure_edited=?,updated_at=?
      WHERE id=? AND COALESCE(updated_at,created_at)=? AND manifest_version=1
        AND manifest_revision=? AND manifest_json=?
        AND NOT EXISTS (SELECT 1 FROM game_sessions gs WHERE gs.question_set_id=question_sets.id)
        AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.prepared_question_set_id=question_sets.id)
      RETURNING id`)
      .bind(
        questions.length,
        currentRevision + 1,
        encodeDbQuestionSetManifest(questions),
        nextCollectionTitle,
        nextStructureEdited ? 1 : 0,
        updatedAt,
        state.row.id,
        currentUpdatedAt,
        currentRevision,
        state.row.manifest_json,
      ));
  }

  const guard = "SELECT 1 FROM question_sets WHERE id=? AND COALESCE(updated_at,created_at)=?";
  if (state.row.manifest_version == null) {
    statements.push(db.prepare(`DELETE FROM questions
      WHERE question_set_id=? AND EXISTS (${guard})`)
      .bind(state.row.id, state.row.id, updatedAt));
    for (const question of questions) {
      statements.push(db.prepare(`INSERT INTO questions (
          id,question_set_id,image_url,order_index,is_r18,label_text,label_source,
          label_source_answer_id,label_updated_by_player_id,label_updated_at,created_at
        )
        SELECT ?,?,?,?,?,?,?,?,?,?,?
        WHERE EXISTS (${guard})`)
        .bind(
          question.id,
          state.row.id,
          question.image_url,
          question.order_index,
          isDbTruthy(question.is_r18) ? 1 : 0,
          question.label_text ?? null,
          question.label_source ?? null,
          question.label_source_answer_id ?? null,
          question.label_updated_by_player_id ?? null,
          question.label_updated_at ?? null,
          question.created_at,
          state.row.id,
          updatedAt,
        ));
    }
  }
  statements.push(...buildAdminQuestionIndexStatements(
    db,
    state.row.id,
    updatedAt,
    questions,
    state.indexedById,
    tagOverrides,
    imageMd5Overrides,
  ));

  const results = await (async () => {
    try {
      return await db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/(?:question_image_index_md5_unique|question_image_index\.image_md5)/i.test(message)) {
        throw new QuestionSetAdminError("该图片题库已有，请勿重复上传。", 409);
      }
      throw error;
    }
  })();
  const updatedRows = (results[0]?.results ?? []) as Array<{ id: string }>;
  if (updatedRows.length === 0) {
    const current = await getQuestionSetRow(db, state.row.id);
    if (!current) throw new QuestionSetAdminError("题库不存在。", 404);
    throw new QuestionSetAdminError("题库引用或版本刚刚发生变化，请刷新后重试。", 409);
  }
  return getAdminQuestionSetDetail(db, state.row.id);
}

export async function getAdminQuestionSetQuestion(
  db: D1Database,
  questionSetId: string,
  questionId: string,
) {
  assertQuestionSetId(questionSetId);
  assertQuestionId(questionId);
  const detail = await getAdminQuestionSetDetail(db, questionSetId);
  const question = detail.questions.find((item) => item.id === questionId);
  if (!question) throw new QuestionSetAdminError("题目不存在。", 404);
  return {
    questionSetId,
    updatedAt: detail.updatedAt,
    canEdit: detail.canEditQuestions,
    question,
  };
}

export async function createAdminQuestionSetQuestion(
  db: D1Database,
  questionSetId: string,
  input: AdminQuestionWriteInput,
): Promise<AdminQuestionMutationData> {
  assertQuestionSetId(questionSetId);
  const expectedUpdatedAt = normalizeExpectedUpdatedAt(input.expectedUpdatedAt);
  const state = await loadAdminQuestionMutationState(db, questionSetId, expectedUpdatedAt);
  // 逐题新增不受 30 题限制（社区题库可累计超过 30 题），但仍受 manifest 存储
  // 安全上限约束；每次新增只允许 1 题。
  if (state.questions.length >= QUESTION_SET_MANIFEST_MAX_QUESTIONS) {
    throw new QuestionSetAdminError(`题库已达到 ${QUESTION_SET_MANIFEST_MAX_QUESTIONS} 题存储上限。`, 409);
  }
  const answerText = normalizeAdminAnswer(input.answerText ?? "");
  const imageUrl = normalizeAdminImageUrl(input.imageUrl ?? "");
  if (state.questions.some((question) => question.image_url === imageUrl)) {
    throw new QuestionSetAdminError("该图片已存在于当前题库。", 409);
  }
  const tags = normalizeAdminQuestionTags(input);
  const createdAt = new Date().toISOString();
  const question: DbQuestion = {
    id: crypto.randomUUID(),
    question_set_id: questionSetId,
    image_url: imageUrl,
    order_index: state.questions.length,
    is_r18: input.isR18 === true,
    label_text: answerText,
    label_source: "manual",
    label_source_answer_id: null,
    label_updated_by_player_id: null,
    label_updated_at: createdAt,
    created_at: createdAt,
  };
  const tagOverrides = new Map<string, AdminQuestionTags>([[question.id, tags]]);
  const questionSet = await executeAdminQuestionMutation(
    db,
    state,
    [...state.questions, question],
    tagOverrides,
    new Map([[question.id, input.imageMd5 ?? null]]),
    true,
  );
  return { questionSet, removedImageUrls: [] };
}

export async function updateAdminQuestionSetQuestion(
  db: D1Database,
  questionSetId: string,
  questionId: string,
  input: AdminQuestionWriteInput,
): Promise<AdminQuestionMutationData> {
  assertQuestionSetId(questionSetId);
  assertQuestionId(questionId);
  const expectedUpdatedAt = normalizeExpectedUpdatedAt(input.expectedUpdatedAt);
  const state = await loadAdminQuestionMutationState(db, questionSetId, expectedUpdatedAt);
  const currentIndex = state.questions.findIndex((question) => question.id === questionId);
  if (currentIndex < 0) throw new QuestionSetAdminError("题目不存在。", 404);
  const current = state.questions[currentIndex];
  const indexed = state.indexedById.get(questionId);

  const imageUrl = input.imageUrl ? normalizeAdminImageUrl(input.imageUrl) : current.image_url;
  const orderIndex = input.orderIndex ?? currentIndex;
  if (!Number.isInteger(orderIndex) || orderIndex < 0 || orderIndex >= state.questions.length) {
    throw new QuestionSetAdminError("题目顺序无效。", 400);
  }
  if (state.questions.some((question) => question.id !== questionId && question.image_url === imageUrl)) {
    throw new QuestionSetAdminError("该图片已存在于当前题库。", 409);
  }

  const answerProvided = input.answerText !== undefined;
  const answerText = answerProvided
    ? normalizeAdminAnswer(input.answerText)
    : current.label_text?.trim() || indexed?.answer_text.trim() || null;
  const tagsProvided = input.animeTags !== undefined || input.characterTags !== undefined;
  const tags = tagsProvided ? normalizeAdminQuestionTags(input) : null;
  const tagsChanged = tagsProvided && !tagsEqual(indexed, tags);
  const r18Changed = input.isR18 !== undefined && isDbTruthy(current.is_r18) !== input.isR18;
  const contentChanged = current.image_url !== imageUrl
    || (answerProvided && (current.label_text?.trim() ?? null) !== answerText);
  const orderChanged = currentIndex !== orderIndex;
  if (!contentChanged && !orderChanged && !tagsChanged && !r18Changed) {
    return { questionSet: await getAdminQuestionSetDetail(db, questionSetId), removedImageUrls: [] };
  }

  const updatedAt = new Date().toISOString();
  const updatedQuestion: DbQuestion = {
    ...current,
    image_url: imageUrl,
    order_index: orderIndex,
    ...(input.isR18 !== undefined ? { is_r18: input.isR18 === true } : {}),
    ...(contentChanged || tagsChanged
      ? {
          label_text: answerText,
          label_source: "manual" as const,
          label_source_answer_id: null,
          label_updated_by_player_id: null,
          label_updated_at: updatedAt,
        }
      : {}),
  };
  const reordered = state.questions.filter((question) => question.id !== questionId);
  reordered.splice(orderIndex, 0, updatedQuestion);
  const questions = reordered.map((question, index) => ({ ...question, order_index: index }));
  const tagOverrides = tagsChanged ? new Map<string, AdminQuestionTags>([[questionId, tags]]) : new Map();
  const imageMd5Overrides = current.image_url === imageUrl
    ? new Map<string, string | null>()
    : new Map<string, string | null>([[questionId, input.imageMd5 ?? null]]);
  const questionSet = await executeAdminQuestionMutation(
    db,
    state,
    questions,
    tagOverrides,
    imageMd5Overrides,
    orderChanged,
  );
  return {
    questionSet,
    removedImageUrls: current.image_url === imageUrl ? [] : [current.image_url],
  };
}

export async function deleteAdminQuestionSetQuestion(
  db: D1Database,
  questionSetId: string,
  questionId: string,
  payload: unknown,
): Promise<AdminQuestionMutationData> {
  assertQuestionSetId(questionSetId);
  assertQuestionId(questionId);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new QuestionSetAdminError("题目删除请求无效。", 400);
  }
  const input = payload as Record<string, unknown>;
  if (input.confirmQuestionId !== questionId) {
    throw new QuestionSetAdminError("题目删除确认标识不匹配。", 400);
  }
  const expectedUpdatedAt = normalizeExpectedUpdatedAt(input.expectedUpdatedAt);
  const state = await loadAdminQuestionMutationState(db, questionSetId, expectedUpdatedAt);
  if (state.questions.length <= 1) {
    throw new QuestionSetAdminError("题库至少需要保留 1 道题；如需清空，请删除整个题库。", 409);
  }
  const current = state.questions.find((question) => question.id === questionId);
  if (!current) throw new QuestionSetAdminError("题目不存在。", 404);
  const questions = state.questions
    .filter((question) => question.id !== questionId)
    .map((question, index) => ({ ...question, order_index: index }));
  const questionSet = await executeAdminQuestionMutation(db, state, questions, new Map(), new Map(), true);
  return { questionSet, removedImageUrls: [current.image_url] };
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
  const hasUnsafeShape = detail.questions.length > QUESTION_SET_MANIFEST_MAX_QUESTIONS
    || detail.questions.length !== detail.imageCount
    || detail.questions.some((question, index) => question.orderIndex !== index);
  if (hasUnsafeShape) {
    throw new QuestionSetAdminError("题库存储数量或顺序不一致；为避免遗漏图片引用，修复前不能删除。", 409);
  }
  // 活动游戏仍禁止删除（game_sessions 外键 RESTRICT 兜底）；已准备房间不阻止
  // 删除，而是与题库删除放在同一个 D1 batch 中原子取消准备。
  if (detail.gameSessionCount > 0) {
    throw new QuestionSetAdminError(
      `题库仍被 ${detail.gameSessionCount} 局活动游戏引用；请先结束游戏，不能直接删除。`,
      409,
    );
  }

  const releasedAt = new Date().toISOString();
  let results: Array<{ results?: Array<{ id: string }> }>;
  try {
    // 先取消引用房间的准备（回到 LOBBY 并清空出题人/题库引用等列），再删除题库。
    // 两条语句共享同一个题库修订号守卫：若版本已过期，房间不会被清空，删除也
    // 会失败，整体回滚；并发准备要么被本条 UPDATE 原子清掉，要么在题库删除后
    // 被 rooms_prepared_question_set_*_guard trigger 拒绝。
    results = await db.batch([
      db.prepare(`
        UPDATE rooms
        SET game_status='LOBBY', current_presenter_player_id=NULL, current_game_id=NULL,
            prepared_question_set_id=NULL, prepared_question_count=NULL, lobby_question_count=NULL,
            prepared_question_source=NULL, room_state_revision=room_state_revision+1,
            public_activity_at=CASE WHEN room_visibility='PUBLIC' THEN ? ELSE public_activity_at END,
            updated_at=?
        WHERE prepared_question_set_id=?
          AND EXISTS (
            SELECT 1 FROM question_sets qs
            WHERE qs.id=? AND COALESCE(qs.updated_at,qs.created_at)=?
              AND NOT EXISTS (
                SELECT 1 FROM game_sessions gs WHERE gs.question_set_id=qs.id
              )
          )
        RETURNING id
      `).bind(releasedAt, releasedAt, questionSetId, questionSetId, expectedUpdatedAt),
      db.prepare(`
        DELETE FROM question_sets
        WHERE id = ?
          AND COALESCE(updated_at, created_at) = ?
          AND NOT EXISTS (SELECT 1 FROM game_sessions gs WHERE gs.question_set_id = question_sets.id)
          AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.prepared_question_set_id = question_sets.id)
        RETURNING id
      `).bind(questionSetId, expectedUpdatedAt),
    ]);
  } catch (error) {
    if (isQuestionSetReferenceConstraintError(error)) {
      throw new QuestionSetAdminError("题库引用或版本刚刚发生变化，请刷新后重试。", 409);
    }
    throw error;
  }
  const releasedRoomRows = results[0]?.results ?? [];
  const deletedRows = results[1]?.results ?? [];
  if (deletedRows.length === 0) {
    const exists = await db.prepare("SELECT id FROM question_sets WHERE id = ?").bind(questionSetId).first<{ id: string }>();
    if (!exists) throw new QuestionSetAdminError("题库不存在。", 404);
    throw new QuestionSetAdminError("题库引用或版本刚刚发生变化，请刷新后重试。", 409);
  }

  return {
    id: detail.id,
    title: detail.title,
    imageUrls: [...new Set(detail.questions.map((question) => question.imageUrl).filter(Boolean))],
    releasedPreparedRoomCount: releasedRoomRows.length,
  };
}
