import type { BangumiAnimeTag, BangumiCharacterTag } from "../types/game";

export const MAX_BANGUMI_ANIME_TAGS_PER_QUESTION = 1;
export const MAX_BANGUMI_CHARACTER_TAGS_PER_QUESTION = 8;
export const MAX_BANGUMI_TAG_NAME_LENGTH = 120;
export const MAX_BANGUMI_TAG_RELATION_LENGTH = 40;
const MAX_BANGUMI_ID = 2_147_483_647;

type NormalizedQuestionTags = {
  animeTags: BangumiAnimeTag[];
  characterTags: BangumiCharacterTag[];
};

function readPositiveBangumiId(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_BANGUMI_ID) {
    throw new Error(`${fieldName} 不是有效的 Bangumi ID。`);
  }
  return Number(value);
}

function readRequiredName(value: unknown, fieldName: string): string {
  if (typeof value !== "string") throw new Error(`${fieldName} 缺失。`);
  const name = value.trim();
  if (!name || name.length > MAX_BANGUMI_TAG_NAME_LENGTH) {
    throw new Error(`${fieldName} 长度必须为 1-${MAX_BANGUMI_TAG_NAME_LENGTH} 个字符。`);
  }
  return name;
}

function readOptionalName(value: unknown, fieldName: string): string | null {
  if (value == null || value === "") return null;
  return readRequiredName(value, fieldName);
}

function readOptionalRelation(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("角色关系格式无效。");
  const relation = value.trim();
  if (!relation || relation.length > MAX_BANGUMI_TAG_RELATION_LENGTH) {
    throw new Error(`角色关系长度必须为 1-${MAX_BANGUMI_TAG_RELATION_LENGTH} 个字符。`);
  }
  return relation;
}

function normalizeAnimeTag(value: unknown): BangumiAnimeTag {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("番剧标签格式无效。");
  }
  const record = value as Record<string, unknown>;
  return {
    id: readPositiveBangumiId(record.id, "番剧"),
    name: readRequiredName(record.name, "番剧名称"),
    nameCn: readOptionalName(record.nameCn, "番剧中文名"),
  };
}

function normalizeCharacterTag(value: unknown): BangumiCharacterTag {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("角色标签格式无效。");
  }
  const record = value as Record<string, unknown>;
  return {
    id: readPositiveBangumiId(record.id, "角色"),
    subjectId: readPositiveBangumiId(record.subjectId, "角色所属番剧"),
    name: readRequiredName(record.name, "角色名称"),
    nameCn: readOptionalName(record.nameCn, "角色中文名"),
    relation: readOptionalRelation(record.relation),
  };
}

export function normalizeBangumiQuestionTags(
  animeTagsValue: unknown,
  characterTagsValue: unknown,
): NormalizedQuestionTags {
  const animeValues = animeTagsValue == null ? [] : animeTagsValue;
  const characterValues = characterTagsValue == null ? [] : characterTagsValue;
  if (!Array.isArray(animeValues) || !Array.isArray(characterValues)) {
    throw new Error("Bangumi 标签必须为数组。");
  }
  if (animeValues.length > MAX_BANGUMI_ANIME_TAGS_PER_QUESTION) {
    throw new Error(`每张图片最多可关联 ${MAX_BANGUMI_ANIME_TAGS_PER_QUESTION} 部番剧。`);
  }
  if (characterValues.length > MAX_BANGUMI_CHARACTER_TAGS_PER_QUESTION) {
    throw new Error(`每张图片最多可关联 ${MAX_BANGUMI_CHARACTER_TAGS_PER_QUESTION} 个角色。`);
  }

  const animeTags = animeValues.map(normalizeAnimeTag);
  const characterTags = characterValues.map(normalizeCharacterTag);
  if (new Set(animeTags.map((tag) => tag.id)).size !== animeTags.length) {
    throw new Error("番剧标签不能重复。");
  }
  if (new Set(characterTags.map((tag) => tag.id)).size !== characterTags.length) {
    throw new Error("角色标签不能重复。");
  }

  const subjectIds = new Set(animeTags.map((tag) => tag.id));
  if (characterTags.some((tag) => !subjectIds.has(tag.subjectId))) {
    throw new Error("角色标签必须属于该图片已选择的番剧。");
  }
  return { animeTags, characterTags };
}

export function normalizeBangumiSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\s]+/gu, "");
}

export function bangumiTagDisplayName(tag: { name: string; nameCn: string | null }): string {
  return tag.nameCn?.trim() || tag.name;
}
