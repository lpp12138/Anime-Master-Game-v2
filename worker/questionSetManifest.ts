import type { DbQuestion, DbQuestionSet, Question } from "../src/types/game";

export const QUESTION_SET_MANIFEST_VERSION = 1 as const;

// 单套题库 manifest 的存储安全上限（fail-closed 边界），不是玩法上限：社区截图
// 同标题集合可跨多次投稿累计超过 30 题，但每单次投稿仍最多 30 张、每局游戏仍
// 最多抽 30 题（见 MAX_GAME_QUESTION_COUNT）。manifest 以单行 JSON 存在 D1，
// 2000 题约数百 KiB，仍远低于 D1 行大小上限。
export const QUESTION_SET_MANIFEST_MAX_QUESTIONS = 2000;

type StoredManifestQuestion = {
  id: string;
  image_url: string;
  order_index: number;
  label_text: string | null;
  label_source: "manual" | "answer" | null;
  label_source_answer_id: string | null;
  label_updated_by_player_id: string | null;
  label_updated_at: string | null;
  created_at: string;
};

type StoredQuestionSetManifest = {
  schema: typeof QUESTION_SET_MANIFEST_VERSION;
  questions: StoredManifestQuestion[];
};

type ManifestQuestionSetRow = Pick<DbQuestionSet, "id" | "manifest_version" | "manifest_json">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string) {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`题集 manifest 字段 ${field} 无效。`);
  return value;
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value) throw new Error(`题集 manifest 字段 ${field} 无效。`);
  return value;
}

function parseStoredQuestion(value: unknown, expectedOrder: number): StoredManifestQuestion {
  if (!isRecord(value)) throw new Error("题集 manifest 中存在无效题目。");
  const orderIndex = value.order_index;
  if (typeof orderIndex !== "number" || !Number.isInteger(orderIndex) || orderIndex !== expectedOrder) {
    throw new Error("题集 manifest 题目顺序无效。");
  }
  const labelSource = value.label_source;
  if (labelSource !== null && labelSource !== undefined && labelSource !== "manual" && labelSource !== "answer") {
    throw new Error("题集 manifest 正确答案来源无效。");
  }
  return {
    id: requiredString(value.id, "id"),
    image_url: requiredString(value.image_url, "image_url"),
    order_index: orderIndex,
    label_text: optionalString(value.label_text, "label_text"),
    label_source: labelSource ?? null,
    label_source_answer_id: optionalString(value.label_source_answer_id, "label_source_answer_id"),
    label_updated_by_player_id: optionalString(value.label_updated_by_player_id, "label_updated_by_player_id"),
    label_updated_at: optionalString(value.label_updated_at, "label_updated_at"),
    created_at: requiredString(value.created_at, "created_at"),
  };
}

export function decodeQuestionSetManifest(row: ManifestQuestionSetRow): DbQuestion[] | null {
  if (row.manifest_version == null && row.manifest_json == null) return null;
  if (row.manifest_version !== QUESTION_SET_MANIFEST_VERSION || typeof row.manifest_json !== "string") {
    throw new Error(`题集 ${row.id} 使用了不支持的 manifest 版本。`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.manifest_json);
  } catch {
    throw new Error(`题集 ${row.id} 的 manifest JSON 已损坏。`);
  }
  if (!isRecord(parsed) || parsed.schema !== QUESTION_SET_MANIFEST_VERSION || !Array.isArray(parsed.questions)) {
    throw new Error(`题集 ${row.id} 的 manifest 结构无效。`);
  }
  if (parsed.questions.length < 1 || parsed.questions.length > QUESTION_SET_MANIFEST_MAX_QUESTIONS) {
    throw new Error(`题集 ${row.id} 的 manifest 题目数量无效。`);
  }

  const questions = parsed.questions.map((question, index) => parseStoredQuestion(question, index));
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new Error(`题集 ${row.id} 的 manifest 包含重复题目 ID。`);
  }
  return questions.map((question) => ({ ...question, question_set_id: row.id }));
}

function toStoredQuestion(question: Question): StoredManifestQuestion {
  return {
    id: question.id,
    image_url: question.imageUrl,
    order_index: question.orderIndex,
    label_text: question.labelText?.trim() || null,
    label_source: question.labelSource ?? null,
    label_source_answer_id: question.labelSourceAnswerId ?? null,
    label_updated_by_player_id: question.labelUpdatedByPlayerId ?? null,
    label_updated_at: question.labelUpdatedAt ?? null,
    created_at: question.createdAt,
  };
}

export function encodeQuestionSetManifest(questions: readonly Question[]) {
  const sorted = questions.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  if (sorted.length < 1 || sorted.length > QUESTION_SET_MANIFEST_MAX_QUESTIONS) {
    throw new Error(`题集 manifest 必须包含 1-${QUESTION_SET_MANIFEST_MAX_QUESTIONS} 道题。`);
  }
  if (new Set(sorted.map((question) => question.id)).size !== sorted.length) {
    throw new Error("题集 manifest 包含重复题目 ID。");
  }
  sorted.forEach((question, index) => {
    if (question.orderIndex !== index || !question.imageUrl || !question.createdAt) {
      throw new Error("题集 manifest 题目结构无效。");
    }
  });
  return JSON.stringify({
    schema: QUESTION_SET_MANIFEST_VERSION,
    questions: sorted.map(toStoredQuestion),
  } satisfies StoredQuestionSetManifest);
}

export function encodeDbQuestionSetManifest(questions: readonly DbQuestion[]) {
  return encodeQuestionSetManifest(questions.map((question) => ({
    id: question.id,
    questionSetId: question.question_set_id,
    imageUrl: question.image_url,
    orderIndex: question.order_index,
    labelText: question.label_text ?? null,
    labelSource: question.label_source ?? null,
    labelSourceAnswerId: question.label_source_answer_id ?? null,
    labelUpdatedByPlayerId: question.label_updated_by_player_id ?? null,
    labelUpdatedAt: question.label_updated_at ?? null,
    createdAt: question.created_at,
  })));
}

export function getManifestImageUrls(row: ManifestQuestionSetRow) {
  return decodeQuestionSetManifest(row)?.map((question) => question.image_url) ?? null;
}
