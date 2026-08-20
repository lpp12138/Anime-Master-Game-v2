import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATION_TOOL_QUESTION_LIST_MAX_ITEMS,
  parseCreationToolQuestionList,
} from "../src/lib/creationToolQuestionList";

test("creation-tool question lists accept JSONL copied from the screenshot picker", () => {
  const items = parseCreationToolQuestionList(`\uFEFF
{"image_url":"https://cdni.fancaps.net/file/fancaps-animeimages/1.jpg","label_text":"动画一"}
{"image_url":"https://lain.bgm.tv/pic/cover/l/00/00/2.jpg","label_text":" 动画二 "}
`);
  assert.deepEqual(items, [
    { imageUrl: "https://cdni.fancaps.net/file/fancaps-animeimages/1.jpg", labelText: "动画一" },
    { imageUrl: "https://lain.bgm.tv/pic/cover/l/00/00/2.jpg", labelText: "动画二" },
  ]);
});

test("creation-tool question lists also accept JSON arrays and questions wrappers", () => {
  assert.deepEqual(parseCreationToolQuestionList(JSON.stringify([
    { image_url: "https://cdni.fancaps.net/file/1.jpg", label_text: "答案" },
  ])), [{ imageUrl: "https://cdni.fancaps.net/file/1.jpg", labelText: "答案" }]);
  assert.deepEqual(parseCreationToolQuestionList(JSON.stringify({ questions: [
    { imageUrl: "https://lain.bgm.tv/pic/cover/2.jpg", labelText: "" },
  ] })), [{ imageUrl: "https://lain.bgm.tv/pic/cover/2.jpg", labelText: "" }]);
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
