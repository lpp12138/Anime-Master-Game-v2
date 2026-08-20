import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATION_TOOL_QUESTION_LIST_MAX_ITEMS,
  parseCreationToolQuestionList,
  parseScreenshotLinkList,
} from "../src/lib/creationToolQuestionList";

test("creation-tool question lists accept JSONL copied from the screenshot picker", () => {
  const items = parseCreationToolQuestionList(`\uFEFF
{"image_url":"https://cdni.fancaps.net/file/fancaps-animeimages/1.jpg","label_text":"动画一"}
{"image_url":"https://lain.bgm.tv/pic/cover/l/00/00/2.jpg","label_text":" 动画二 "}
`);
  assert.deepEqual(items, [
    { imageUrl: "https://cdni.fancaps.net/file/fancaps-animeimages/1.jpg", labelText: "动画一", isR18: false },
    { imageUrl: "https://lain.bgm.tv/pic/cover/l/00/00/2.jpg", labelText: "动画二", isR18: false },
  ]);
});

test("creation-tool question lists accept optional is_r18 / isR18 booleans and reject wrong types", () => {
  assert.deepEqual(parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/r18.jpg", label_text: "答案", is_r18: true },
  ])), [{ imageUrl: "https://cdni.fancaps.net/file/r18.jpg", labelText: "答案", isR18: true }]);
  assert.deepEqual(parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/1.jpg", label_text: "答案", isR18: false },
  ])), [{ imageUrl: "https://cdni.fancaps.net/file/1.jpg", labelText: "答案", isR18: false }]);
  // 两个字段同时存在且值一致时接受，缺省视为 false。
  assert.deepEqual(parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/2.jpg", label_text: "答案", is_r18: false, isR18: false },
  ])), [{ imageUrl: "https://cdni.fancaps.net/file/2.jpg", labelText: "答案", isR18: false }]);
  assert.throws(() => parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/1.jpg", label_text: "答案", is_r18: "true" },
  ])), /is_r18 必须是布尔值/);
  assert.throws(() => parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/1.jpg", label_text: "答案", isR18: 1 },
  ])), /is_r18 必须是布尔值/);
  // null 必须拒绝，不能静默当成缺省 false。
  assert.throws(() => parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/1.jpg", label_text: "答案", is_r18: null },
  ])), /is_r18 必须是布尔值/);
  assert.throws(() => parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/1.jpg", label_text: "答案", isR18: null },
  ])), /is_r18 必须是布尔值/);
  // 两个字段同时存在且值冲突必须拒绝。
  assert.throws(() => parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/1.jpg", label_text: "答案", is_r18: true, isR18: false },
  ])), /is_r18 与 isR18 不一致/);
  assert.throws(() => parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/1.jpg", label_text: "答案", is_r18: null, isR18: true },
  ])), /is_r18 与 isR18 不一致/);
});

test("creation-tool question lists also accept JSON arrays and questions wrappers", () => {
  assert.deepEqual(parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/1.jpg", label_text: "答案" },
  ])), [{ imageUrl: "https://cdni.fancaps.net/file/1.jpg", labelText: "答案", isR18: false }]);
  assert.deepEqual(parseCreationToolQuestionList(JSON.stringify({ questions: [
    { imageUrl: "https://lain.bgm.tv/pic/cover/2.jpg", labelText: "" },
  ] })), [{ imageUrl: "https://lain.bgm.tv/pic/cover/2.jpg", labelText: "", isR18: false }]);
});

test("creation-tool question lists reject malformed, duplicate, and oversized input", () => {
  assert.throws(() => parseCreationToolQuestionList("not-json"));
  assert.throws(() => parseCreationToolQuestionList('{"label_text":"缺图"}'), /image_url/);
  assert.throws(() => parseCreationToolQuestionList(`
{"image_url":"https://cdni.fancaps.net/file/same.jpg","label_text":"一"}
{"image_url":"https://cdni.fancaps.net/file/same.jpg","label_text":"二"}
`), /重复/);
  assert.throws(() => parseCreationToolQuestionList(JSON.stringify(Array.from(
    { length: CREATION_TOOL_QUESTION_LIST_MAX_ITEMS + 1 },
    (_, index) => ({ image_url: `https://cdni.fancaps.net/file/${index}.jpg`, label_text: "答案" }),
  ))), /最多导入 30/);
  assert.throws(() => parseCreationToolQuestionList(JSON.stringify({
    image_url: "https://lain.bgm.tv/pic/cover/image.jpg",
    label_text: "答".repeat(101),
  })), /100/);
  assert.throws(() => parseCreationToolQuestionList(JSON.stringify({
    image_url: "https://example.com/image.jpg",
    label_text: "答案",
  })), /FanCaps.*Bangumi/);
});

test("screenshot link lists accept one URL per line with comments and whitespace", () => {
  const links = parseScreenshotLinkList(`
    # 截图直链
    https://cdni.fancaps.net/file/fancaps-animeimages/1.jpg
    https://lain.bgm.tv/pic/cover/l/00/00/2.jpg
  `);
  assert.deepEqual(links, [
    "https://cdni.fancaps.net/file/fancaps-animeimages/1.jpg",
    "https://lain.bgm.tv/pic/cover/l/00/00/2.jpg",
  ]);
});

test("screenshot link lists reject empty, unsupported, duplicate, and oversized input", () => {
  assert.throws(() => parseScreenshotLinkList("  \n# only comments\n"), /至少一个/);
  assert.throws(() => parseScreenshotLinkList("https://example.com/a.jpg"), /FanCaps.*Bangumi/);
  assert.throws(() => parseScreenshotLinkList("http://cdni.fancaps.net/a.jpg"), /FanCaps.*Bangumi/);
  assert.throws(() => parseScreenshotLinkList("https://cdni.fancaps.net:8443/a.jpg"), /FanCaps.*Bangumi/);
  assert.throws(() => parseScreenshotLinkList("https://user:password@lain.bgm.tv/a.jpg"), /FanCaps.*Bangumi/);
  assert.throws(() => parseScreenshotLinkList(
    "https://cdni.fancaps.net/a.jpg\nhttps://cdni.fancaps.net/a.jpg",
  ), /重复/);
  const tooMany = Array.from(
    { length: CREATION_TOOL_QUESTION_LIST_MAX_ITEMS + 1 },
    (_, index) => `https://cdni.fancaps.net/file/${index}.jpg`,
  ).join("\n");
  assert.throws(() => parseScreenshotLinkList(tooMany), /最多导入 30/);
  assert.throws(() => parseScreenshotLinkList(
    `https://cdni.fancaps.net/${"a".repeat(2048)}.jpg`,
  ), /第 1 个链接/);
});
