export const CREATION_TOOL_QUESTION_LIST_MAX_ITEMS = 30;
export const CREATION_TOOL_QUESTION_LIST_MAX_BYTES = 256 * 1024;

const CREATION_TOOL_IMAGE_HOSTS = new Set([
  "cdni.fancaps.net",
  "ant.fancaps.net",
  "fancaps.net",
  "www.fancaps.net",
  "lain.bgm.tv",
]);

export type CreationToolQuestionListItem = {
  imageUrl: string;
  labelText: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function parseScreenshotLinkList(rawText: string): string[] {
  const links = rawText
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith("#"));
  if (links.length === 0) throw new Error("请粘贴至少一个截图链接，每行一个。");
  if (links.length > CREATION_TOOL_QUESTION_LIST_MAX_ITEMS) {
    throw new Error(`一次最多导入 ${CREATION_TOOL_QUESTION_LIST_MAX_ITEMS} 个截图链接。`);
  }
  const invalidIndex = links.findIndex((link) => link.length > 2048 || !isSupportedCreationToolImageUrl(link));
  if (invalidIndex >= 0) {
    throw new Error(`第 ${invalidIndex + 1} 个链接不受支持；仅允许 FanCaps 或 Bangumi 的 HTTPS 图片直链。`);
  }
  const duplicateIndex = links.findIndex((link, index) => links.indexOf(link) !== index);
  if (duplicateIndex >= 0) throw new Error(`第 ${duplicateIndex + 1} 个截图链接重复。`);
  return links;
}

export function isSupportedCreationToolImageUrl(value: string | URL) {
  const url = value instanceof URL ? value : parseUrl(value);
  return Boolean(
    url
    && url.protocol === "https:"
    && (!url.port || url.port === "443")
    && !url.username
    && !url.password
    && CREATION_TOOL_IMAGE_HOSTS.has(url.hostname.toLowerCase()),
  );
}

function parseRecord(value: unknown, location: string): CreationToolQuestionListItem {
  if (!isRecord(value)) throw new Error(`${location}必须是 JSON 对象。`);
  const rawImageUrl = value.image_url ?? value.imageUrl;
  const rawLabelText = value.label_text ?? value.labelText ?? "";
  if (typeof rawImageUrl !== "string" || !parseUrl(rawImageUrl.trim())) {
    throw new Error(`${location}缺少有效的 image_url。`);
  }
  if (rawImageUrl.trim().length > 2048) throw new Error(`${location}的 image_url 过长。`);
  if (!isSupportedCreationToolImageUrl(rawImageUrl.trim())) {
    throw new Error(`${location}只支持动画截图工具导出的 FanCaps 或 Bangumi 图片地址。`);
  }
  if (typeof rawLabelText !== "string") throw new Error(`${location}的 label_text 必须是字符串。`);
  const labelText = rawLabelText.replace(/[\r\n]+/g, " ").trim();
  if (labelText.length > 100) throw new Error(`${location}的 label_text 不能超过 100 个字符。`);
  return { imageUrl: rawImageUrl.trim(), labelText };
}

function parseJsonValue(value: unknown) {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.questions)) return value.questions;
  if (isRecord(value)) return [value];
  throw new Error("题单 JSON 顶层必须是题目对象、题目数组或包含 questions 数组的对象。");
}

function parseJsonLines(text: string) {
  const values: unknown[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      throw new Error(`第 ${index + 1} 行不是有效 JSON。`);
    }
  }
  return values;
}

export function parseCreationToolQuestionList(rawText: string): CreationToolQuestionListItem[] {
  const text = rawText.replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("请上传或粘贴出题工具题单。");
  if (new TextEncoder().encode(text).byteLength > CREATION_TOOL_QUESTION_LIST_MAX_BYTES) {
    throw new Error("题单文件不能超过 256 KiB。");
  }

  let parsedWhole: unknown;
  let parsedAsWholeDocument = false;
  try {
    parsedWhole = JSON.parse(text);
    parsedAsWholeDocument = true;
  } catch {
    // The screenshot picker exports JSONL, which is not one JSON document.
  }
  let values: unknown[];
  if (parsedAsWholeDocument) {
    values = parseJsonValue(parsedWhole);
  } else if (text.includes("\n") || text.includes("\r")) {
    values = parseJsonLines(text);
  } else {
    throw new Error("题单不是有效的 JSON 或 JSONL。");
  }
  if (values.length === 0) throw new Error("题单中没有题目。");
  if (values.length > CREATION_TOOL_QUESTION_LIST_MAX_ITEMS) {
    throw new Error(`一次最多导入 ${CREATION_TOOL_QUESTION_LIST_MAX_ITEMS} 道题。`);
  }

  const items = values.map((value, index) => parseRecord(value, `第 ${index + 1} 题`));
  const seenUrls = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seenUrls.has(item.imageUrl)) throw new Error(`第 ${index + 1} 题使用了重复的 image_url。`);
    seenUrls.add(item.imageUrl);
  }
  return items;
}
