import type { AdminQuestionSetSummary } from "./questionSetAdmin";

/**
 * 社区截图投稿“追加到现有题库”的目标选项。
 *
 * 追加目标按题库 ID 明确提交，因此管理员新增、删除或调序后的公开社区题库
 * 仍可继续追加；同标题历史题库也不会被前端合并。服务端仍会校验题库存在、
 * 公开、属于社区投稿且 manifest 可读，并通过 manifest revision 原子追加。
 *
 * 这里只使用管理列表接口的摘要字段，不读取任何题目/答案数据。
 */
export const COMMUNITY_APPEND_MANIFEST_VERSION = 1;

export type AppendableQuestionSetOption = {
  id: string;
  title: string;
  imageCount: number;
  updatedAt: string;
  isCanonicalCollection: boolean;
  isStructureEdited: boolean;
};

export function isAppendableCommunityQuestionSet(
  item: AdminQuestionSetSummary,
): boolean {
  return Boolean(
    item.isPublic
    && item.manifestVersion === COMMUNITY_APPEND_MANIFEST_VERSION
    && Number.isInteger(item.submissionCount)
    && item.submissionCount > 0
    && Number.isInteger(item.imageCount)
    && item.imageCount >= 0,
  );
}

/**
 * 按题库 ID 保留所有可追加目标及服务端顺序（最近更新优先）。同标题题库不再
 * 去重，因为客户端会把选中的精确 ID 提交给服务端。
 */
export function toAppendableQuestionSetOptions(
  items: readonly AdminQuestionSetSummary[],
): AppendableQuestionSetOption[] {
  const options: AppendableQuestionSetOption[] = [];
  for (const item of items) {
    const title = item.title.trim();
    if (!title || !isAppendableCommunityQuestionSet(item)) continue;
    options.push({
      id: item.id,
      title,
      imageCount: item.imageCount,
      updatedAt: item.updatedAt,
      isCanonicalCollection: item.isCanonicalCollection,
      isStructureEdited: item.isStructureEdited,
    });
  }
  return options;
}

/**
 * 按精确标题查找现有题库。若历史上存在同标题题库，优先规范集合，再使用
 * 服务端顺序中的第一项；大小写与内部空白保持精确。
 */
export function findAppendableQuestionSetByTitle(
  options: readonly AppendableQuestionSetOption[],
  title: string,
): AppendableQuestionSetOption | null {
  const exactTitle = title.trim();
  if (!exactTitle) return null;
  const matches = options.filter((option) => option.title === exactTitle);
  return matches.find((option) => option.isCanonicalCollection) ?? matches[0] ?? null;
}
