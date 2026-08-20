import type { AdminQuestionSetSummary } from "./questionSetAdmin";

/**
 * 社区截图投稿“追加到现有题库”的目标选项。
 *
 * 服务端追加语义见 worker/gameService.ts：
 * - 只有“规范集合”（community_collection_title 非空，即由社区截图投稿建立或认领、
 *   且未被管理员解除绑定）才会接收同标题追加；
 * - 追加要求题库公开、未被管理员人工改动结构（community_structure_edited = 0）、
 *   manifest 版本为当前版本；
 * - 整套题库不再受累计 30 题限制（可跨多次投稿继续增长），只有单次投稿最多
 *   30 张，因此已有 30 题或更多题目的题库仍可继续选择追加。
 *
 * 这里只使用管理列表接口的公开摘要字段，不读取任何题目/答案数据。
 */
export const COMMUNITY_APPEND_MANIFEST_VERSION = 1;

export type AppendableQuestionSetOption = {
  id: string;
  title: string;
  imageCount: number;
  updatedAt: string;
};

export function isAppendableCommunityQuestionSet(
  item: AdminQuestionSetSummary,
): boolean {
  return Boolean(
    item.isCanonicalCollection
    && item.isPublic
    && !item.isStructureEdited
    && item.manifestVersion === COMMUNITY_APPEND_MANIFEST_VERSION
    && Number.isInteger(item.imageCount)
    && item.imageCount >= 0,
  );
}

/**
 * 从管理列表摘要中筛选适合社区投稿继续追加的题库，按精确标题去重并保持服务端顺序
 * （最近更新优先）。规范集合标题在 D1 上有唯一约束，这里按标题去重只是防御性处理，
 * 避免历史数据异常时下拉出现重复标题。
 */
export function toAppendableQuestionSetOptions(
  items: readonly AdminQuestionSetSummary[],
): AppendableQuestionSetOption[] {
  const seenTitles = new Set<string>();
  const options: AppendableQuestionSetOption[] = [];
  for (const item of items) {
    const title = item.title.trim();
    if (!title || seenTitles.has(title)) continue;
    if (!isAppendableCommunityQuestionSet(item)) continue;
    seenTitles.add(title);
    options.push({
      id: item.id,
      title,
      imageCount: item.imageCount,
      updatedAt: item.updatedAt,
    });
  }
  return options;
}

/**
 * 按精确标题查找可追加的现有题库。服务端按字符串完全相等匹配
 * community_collection_title，因此这里不做大小写或空白折叠。
 */
export function findAppendableQuestionSetByTitle(
  options: readonly AppendableQuestionSetOption[],
  title: string,
): AppendableQuestionSetOption | null {
  const exactTitle = title.trim();
  if (!exactTitle) return null;
  return options.find((option) => option.title === exactTitle) ?? null;
}

/** Prefer the requested exact title, then the first available collection. */
export function getDefaultAppendableQuestionSetId(
  options: readonly AppendableQuestionSetOption[],
  preferredTitle: string,
): string {
  return findAppendableQuestionSetByTitle(options, preferredTitle)?.id ?? options[0]?.id ?? "";
}
