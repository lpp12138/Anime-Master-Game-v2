import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMUNITY_APPEND_MANIFEST_VERSION,
  findAppendableQuestionSetByTitle,
  isAppendableCommunityQuestionSet,
  toAppendableQuestionSetOptions,
} from "../src/lib/communityUploadTitleOptions";
import type { AdminQuestionSetSummary } from "../src/lib/questionSetAdmin";

function summary(overrides: Partial<AdminQuestionSetSummary>): AdminQuestionSetSummary {
  return {
    id: "set-1",
    title: "测试题库",
    description: null,
    createdByPlayerId: "player-1",
    createdByNickname: "测试昵称",
    source: "uploaded",
    creationMethod: "player_manual",
    isPublic: true,
    imageCount: 10,
    ratingAvg: 0,
    ratingCount: 0,
    playCount: 0,
    manifestVersion: COMMUNITY_APPEND_MANIFEST_VERSION,
    manifestRevision: 0,
    isCanonicalCollection: true,
    isStructureEdited: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    gameSessionCount: 0,
    archivedGameCount: 0,
    preparedRoomCount: 0,
    submissionCount: 1,
    indexedImageCount: 10,
    ...overrides,
  };
}

test("only canonical public unedited v1 collections with capacity are appendable", () => {
  assert.equal(isAppendableCommunityQuestionSet(summary({})), true);
  // 接近上限但仍可继续追加
  assert.equal(isAppendableCommunityQuestionSet(summary({ imageCount: 29 })), true);
});

test("non-appendable sets are rejected", () => {
  const rejections: Array<Partial<AdminQuestionSetSummary>> = [
    { isCanonicalCollection: false }, // 非社区规范集合（房间新建/未认领/已解绑）
    { isPublic: false }, // 未公开
    { isStructureEdited: true }, // 已被管理员人工改动
    { manifestVersion: null }, // legacy 无 manifest
    { manifestVersion: 0 },
    { manifestVersion: 2 },
    { imageCount: 30 }, // 已满
    { imageCount: 31 },
    { imageCount: -1 }, // 计数异常
    { imageCount: Number.NaN },
  ];
  for (const overrides of rejections) {
    assert.equal(isAppendableCommunityQuestionSet(summary(overrides)), false, JSON.stringify(overrides));
  }
  // 自定义上限
  assert.equal(isAppendableCommunityQuestionSet(summary({ imageCount: 5 }), 6), true);
  assert.equal(isAppendableCommunityQuestionSet(summary({ imageCount: 6 }), 6), false);
});

test("options keep server order, trim titles, and dedupe exact duplicate titles", () => {
  const items = [
    summary({ id: "newest", title: " 较新题库 ", imageCount: 3, updatedAt: "2026-03-01T00:00:00.000Z" }),
    summary({ id: "duplicate-1", title: "重复标题", imageCount: 8, updatedAt: "2026-02-01T00:00:00.000Z" }),
    summary({ id: "duplicate-2", title: "重复标题", imageCount: 12, updatedAt: "2026-01-01T00:00:00.000Z" }),
    summary({ id: "full", title: "已满题库", imageCount: 30 }),
    summary({ id: "edited", title: "已编辑题库", imageCount: 5, isStructureEdited: true }),
    summary({ id: "blank", title: "   " }),
    summary({ id: "room-made", title: "房间题库", isCanonicalCollection: false }),
  ];
  const options = toAppendableQuestionSetOptions(items);
  assert.deepEqual(options.map((option) => option.id), ["newest", "duplicate-1"]);
  assert.equal(options[0].title, "较新题库");
  assert.equal(options[0].imageCount, 3);
  assert.equal(options[0].updatedAt, "2026-03-01T00:00:00.000Z");
  // 重复标题只保留服务端顺序中的第一个
  assert.equal(options[1].title, "重复标题");
  assert.equal(options[1].imageCount, 8);
});

test("exact-title lookup is whitespace-exact and returns null when absent", () => {
  const options = toAppendableQuestionSetOptions([
    summary({ id: "a", title: "AIR", imageCount: 4 }),
    summary({ id: "b", title: "AIR 剧场版", imageCount: 7 }),
  ]);
  assert.equal(findAppendableQuestionSetByTitle(options, "AIR")?.id, "a");
  assert.equal(findAppendableQuestionSetByTitle(options, "  AIR  ")?.id, "a");
  // 服务端提交标题同样会 trim，因此查询两侧空白不参与匹配；大小写与内部空白保持精确
  assert.equal(findAppendableQuestionSetByTitle(options, "AIR ")?.id, "a");
  assert.equal(findAppendableQuestionSetByTitle(options, "air"), null);
  assert.equal(findAppendableQuestionSetByTitle(options, " AIR ")?.id, "a");
  assert.equal(findAppendableQuestionSetByTitle(options, "AIR 剧场版")?.id, "b");
  assert.equal(findAppendableQuestionSetByTitle(options, "AIR 剧场版 ")?.id, "b");
  assert.equal(findAppendableQuestionSetByTitle(options, ""), null);
  assert.equal(findAppendableQuestionSetByTitle(options, "   "), null);
  assert.equal(findAppendableQuestionSetByTitle([], "AIR"), null);
});
