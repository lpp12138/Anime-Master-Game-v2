import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMUNITY_APPEND_MANIFEST_VERSION,
  findAppendableQuestionSetByTitle,
  isAppendableCommunityQuestionSet,
  toAppendableQuestionSetOptions,
} from "../src/lib/communityUploadTitleOptions";
import * as titleOptionsModule from "../src/lib/communityUploadTitleOptions";
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

test("public manifest community sets remain appendable after structural edits or canonical detachment", () => {
  assert.equal(isAppendableCommunityQuestionSet(summary({})), true);
  assert.equal(isAppendableCommunityQuestionSet(summary({ isStructureEdited: true, isCanonicalCollection: false })), true);
  // 整套题库不受累计 30 题限制。
  assert.equal(isAppendableCommunityQuestionSet(summary({ imageCount: 30 })), true);
  assert.equal(isAppendableCommunityQuestionSet(summary({ imageCount: 47 })), true);
});

test("only missing community history, private sets, incompatible manifests, and invalid counts are rejected", () => {
  const rejections: Array<Partial<AdminQuestionSetSummary>> = [
    { submissionCount: 0 },
    { isPublic: false },
    { manifestVersion: null },
    { manifestVersion: 0 },
    { manifestVersion: 2 },
    { imageCount: -1 },
    { imageCount: Number.NaN },
  ];
  for (const overrides of rejections) {
    assert.equal(isAppendableCommunityQuestionSet(summary(overrides)), false, JSON.stringify(overrides));
  }
});

test("options keep server order and same-title IDs instead of hiding edited collections", () => {
  const items = [
    summary({ id: "newest", title: " 较新题库 ", imageCount: 3, updatedAt: "2026-03-01T00:00:00.000Z" }),
    summary({ id: "duplicate-1", title: "重复标题", imageCount: 8, updatedAt: "2026-02-01T00:00:00.000Z" }),
    summary({ id: "duplicate-2", title: "重复标题", imageCount: 12, isCanonicalCollection: false, updatedAt: "2026-01-01T00:00:00.000Z" }),
    summary({ id: "full", title: "已满题库", imageCount: 30 }),
    summary({ id: "edited", title: "已编辑题库", imageCount: 5, isCanonicalCollection: false, isStructureEdited: true }),
    summary({ id: "blank", title: "   " }),
    summary({ id: "room-made", title: "房间题库", isCanonicalCollection: false, submissionCount: 0 }),
  ];
  const options = toAppendableQuestionSetOptions(items);
  assert.deepEqual(options.map((option) => option.id), ["newest", "duplicate-1", "duplicate-2", "full", "edited"]);
  assert.equal(options[0].title, "较新题库");
  assert.equal(options[2].isCanonicalCollection, false);
  assert.equal(options[4].isStructureEdited, true);
});

test("exact-title lookup prefers the canonical ID and otherwise keeps exact matching", () => {
  const options = toAppendableQuestionSetOptions([
    summary({ id: "detached", title: "AIR", isCanonicalCollection: false, isStructureEdited: true }),
    summary({ id: "canonical", title: "AIR" }),
    summary({ id: "movie", title: "AIR 剧场版" }),
  ]);
  assert.equal(findAppendableQuestionSetByTitle(options, "AIR")?.id, "canonical");
  assert.equal(findAppendableQuestionSetByTitle(options, "  AIR  ")?.id, "canonical");
  assert.equal(findAppendableQuestionSetByTitle(options, "air"), null);
  assert.equal(findAppendableQuestionSetByTitle(options, "AIR 剧场版")?.id, "movie");
  assert.equal(findAppendableQuestionSetByTitle(options, ""), null);
  assert.equal(findAppendableQuestionSetByTitle([], "AIR"), null);
});

// 上传页不再提供任何默认选中：既不默认选中现有题库，也不默认进入新建模式，
// 新建标题也没有默认名称。选项库只负责“可追加目标”的过滤与按 ID 查找，
// 不得重新导出默认选择辅助函数。
test("option helpers never compute a default selection", () => {
  assert.deepEqual(
    Object.keys(titleOptionsModule).sort(),
    [
      "COMMUNITY_APPEND_MANIFEST_VERSION",
      "findAppendableQuestionSetByTitle",
      "isAppendableCommunityQuestionSet",
      "toAppendableQuestionSetOptions",
    ],
  );
});
