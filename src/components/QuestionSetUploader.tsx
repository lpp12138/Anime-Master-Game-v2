"use client";

import { DragEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import {
  buildLocalUploadQuestionImport,
  buildPreparedUrlImportDraft,
  extractCreationToolLabelFromFilename,
  findNearestLocalUploadDropTarget,
  filesToUploadableImages,
  getR2UploadConfigStatus,
  moveLocalUploadDraftQuestionToIndex,
  readDroppedUploadFiles,
  removeLocalUploadDraftQuestion,
  toUploadSourceFiles,
  uploadImagesToR2,
  uploadRemoteImagesToR2,
  type LocalUploadDraftQuestion,
  type LocalUploadDropTarget,
  type UploadSourceFile,
  type UploadProgress,
  type UploadableImage,
} from "@/lib/r2Upload";
import {
  createUploadedQuestionSet,
  getCommunityQuestionSetDetail,
  getCommunityQuestionSets,
  parseImageUrlsText,
  parseQuestionImportText,
  prepareQuestionSetForStart,
} from "@/lib/cloudflareRooms";
import type {
  CommunityQuestionSetSort,
  CommunityQuestionSetSummary,
  PreparedQuestionUrlImport,
  QuestionSet,
  QuestionSetCreationMethod,
  QuestionUrlImportInput,
  Room,
} from "@/types/game";

type QuestionSetUploaderProps = {
  room: Room;
  presenterPlayerId: string;
  isCancelingPresenterSetup?: boolean;
  onRoomUpdated: (room: Room) => void;
  onError: (message: string) => void;
  onClearError?: () => void;
  onCancelPresenterSetup?: () => void;
};

type SetupMode = "upload" | "urlText" | "community";
type CommunityCreationMethodFilter = "all" | QuestionSetCreationMethod;
const maxUploadImageCount = 30;
const maxUploadImageBytes = 20 * 1024 * 1024;
const communityPageSize = 24;

type BrowserFileSystemFileHandle = {
  kind: "file";
  getFile: () => Promise<File>;
};

type BrowserFileSystemDirectoryHandle = {
  values: () => AsyncIterable<BrowserFileSystemFileHandle | { kind: "directory" }>;
};

const emptyProgress: UploadProgress = {
  done: 0,
  total: 0,
  success: 0,
  fail: 0,
  rawBytes: 0,
  uploadBytes: 0,
  latestMessage: "尚未开始",
};

function toImportInputs(items: ReturnType<typeof parseQuestionImportText>): QuestionUrlImportInput[] {
  return items.map((item, index) => ({
    imageUrl: item.imageUrl,
    labelText: item.labelText ?? null,
    isR18: item.isR18 ?? false,
    orderIndex: index,
  }));
}

function getQuestionSetUrls(questionSet: QuestionSet | null) {
  if (!questionSet) {
    return [];
  }

  const textUrls = parseImageUrlsText(questionSet.imageUrlsText ?? "");

  if (textUrls.length > 0) {
    return textUrls;
  }

  return (questionSet.questions ?? [])
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((question) => question.imageUrl);
}

function getQuestionSetPreviewItems(questionSet: QuestionSet | null) {
  if (!questionSet) {
    return [];
  }

  const questions = (questionSet.questions ?? []).slice().sort((a, b) => a.orderIndex - b.orderIndex);

  if (questions.length > 0) {
    return questions.map((question, index) => ({
      key: question.id,
      url: question.imageUrl,
      labelText: question.labelText ?? null,
      isR18: question.isR18,
      index,
    }));
  }

  return getQuestionSetUrls(questionSet).map((url, index) => ({
    key: `${url}-${index}`,
    url,
    labelText: null,
    isR18: false,
    index,
  }));
}

function getDraftQuestionSetTitle(room: Room) {
  return `房间 ${room.code} 临时题库`;
}

function getQuestionSetUploaderName(questionSet: Pick<QuestionSet, "createdByNickname">) {
  return questionSet.createdByNickname?.trim() || "未知上传者";
}

function formatQuestionSetCreatedAt(questionSet: Pick<QuestionSet, "createdAt">) {
  const publishedAt = new Date(questionSet.createdAt);

  if (Number.isNaN(publishedAt.getTime())) {
    return "未知时间";
  }

  const year = String(publishedAt.getFullYear()).slice(-2);
  const month = String(publishedAt.getMonth() + 1).padStart(2, "0");
  const day = String(publishedAt.getDate()).padStart(2, "0");

  return `${year}/${month}/${day}`;
}

function getCreationMethodShortLabel(creationMethod: QuestionSetCreationMethod | null | undefined) {
  if (creationMethod === "player_manual") return "手动出题";
  if (creationMethod === "creation_tool_assisted") return "出题工具";
  return null;
}

function isQuestionSetDetail(
  questionSet: QuestionSet | CommunityQuestionSetSummary | null,
): questionSet is QuestionSet {
  return Boolean(questionSet && ("questions" in questionSet || "imageUrlsText" in questionSet));
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}

function isCurrentFolderFile(sourceFile: UploadSourceFile) {
  return sourceFile.path.split(/[\\/]/).filter(Boolean).length <= 2;
}

async function pickCurrentFolderFiles() {
  const picker = (window as Window & {
    showDirectoryPicker?: () => Promise<BrowserFileSystemDirectoryHandle>;
  }).showDirectoryPicker;

  if (!picker) {
    return null;
  }

  const directoryHandle = await picker();
  const files: File[] = [];

  for await (const entry of directoryHandle.values()) {
    if (entry.kind === "file") {
      files.push(await entry.getFile());
    }
  }

  return files;
}

export function QuestionSetUploader({
  room,
  presenterPlayerId,
  isCancelingPresenterSetup = false,
  onRoomUpdated,
  onError,
  onClearError,
  onCancelPresenterSetup,
}: QuestionSetUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const jsonlInputRef = useRef<HTMLInputElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const draggedDraftKeyRef = useRef<string | null>(null);
  const communityRequestIdRef = useRef(0);
  const communityPreviewRequestIdRef = useRef(0);
  const communityDetailCacheRef = useRef(new Map<string, QuestionSet>());
  const [mode, setMode] = useState<SetupMode>("upload");
  const [urlText, setUrlText] = useState("");
  const [items, setItems] = useState<UploadableImage[]>([]);
  const [localUploadDraft, setLocalUploadDraft] = useState<LocalUploadDraftQuestion[] | null>(null);
  const [draftCreationMethod, setDraftCreationMethod] = useState<QuestionSetCreationMethod>("player_manual");
  const [draggedDraftKey, setDraggedDraftKey] = useState<string | null>(null);
  const [draftDropTarget, setDraftDropTarget] = useState<LocalUploadDropTarget | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingImport, setIsDraggingImport] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isCreatingFromText, setIsCreatingFromText] = useState(false);
  const [isLoadingCommunity, setIsLoadingCommunity] = useState(false);
  const [communitySort, setCommunitySort] = useState<CommunityQuestionSetSort>("latest");
  const [communityCreationMethod, setCommunityCreationMethod] = useState<CommunityCreationMethodFilter>("all");
  const [communitySets, setCommunitySets] = useState<CommunityQuestionSetSummary[]>([]);
  const [communitySearch, setCommunitySearch] = useState("");
  const [communityTotal, setCommunityTotal] = useState<number | null>(null);
  const [communityHasMore, setCommunityHasMore] = useState(false);
  const [communityNextOffset, setCommunityNextOffset] = useState(0);
  const [loadingCommunityPreviewId, setLoadingCommunityPreviewId] = useState<string | null>(null);
  const [loadingCommunitySelectionId, setLoadingCommunitySelectionId] = useState<string | null>(null);
  const [previewingCommunitySet, setPreviewingCommunitySet] = useState<QuestionSet | null>(null);
  const [isConfirmingQuestionSet, setIsConfirmingQuestionSet] = useState(false);
  const [progress, setProgress] = useState<UploadProgress>(emptyProgress);
  const [questionSet, setQuestionSet] = useState<QuestionSet | CommunityQuestionSetSummary | null>(null);
  const configStatus = getR2UploadConfigStatus();

  const detailedQuestionSet = isQuestionSetDetail(questionSet) ? questionSet : null;
  const previewUrls = useMemo(
    () => localUploadDraft?.map((question) => question.imageUrl) ?? getQuestionSetUrls(detailedQuestionSet),
    [detailedQuestionSet, localUploadDraft],
  );
  const previewItems = useMemo(
    () => localUploadDraft?.map((question, index) => ({
      key: question.key,
      url: question.imageUrl,
      labelText: question.labelText,
      isR18: question.isR18,
      index,
    })) ?? getQuestionSetPreviewItems(detailedQuestionSet),
    [detailedQuestionSet, localUploadDraft],
  );
  const importPreview = useMemo(() => {
    try {
      const importItems = parseQuestionImportText(urlText);
      return {
        items: importItems,
        labeledCount: importItems.filter((item) => item.labelText?.trim()).length,
        error: null,
      };
    } catch (error) {
      return {
        items: [],
        labeledCount: 0,
        error: error instanceof Error ? error.message : "题单JSONL格式错误",
      };
    }
  }, [urlText]);
  const urlsTextForPreview = previewUrls.join("\n");
  const progressPercent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const recognizedLabelCount = useMemo(
    () => items.filter((item) => extractCreationToolLabelFromFilename(item.name)).length,
    [items],
  );

  useEffect(() => {
    if (mode !== "community") {
      return;
    }

    const timer = window.setTimeout(() => {
      void handleLoadCommunitySets({
        sort: communitySort,
        search: communitySearch,
        creationMethod: communityCreationMethod,
        append: false,
      });
    }, communitySearch.trim() ? 300 : 0);

    return () => window.clearTimeout(timer);
  }, [communityCreationMethod, communitySearch, communitySort, mode]);

  function clearError() {
    onClearError?.();
  }

  function scrollToPreview() {
    window.setTimeout(() => {
      previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  function resetCreatedSet() {
    setQuestionSet(null);
    setLocalUploadDraft(null);
    setDraftCreationMethod("player_manual");
    draggedDraftKeyRef.current = null;
    setDraggedDraftKey(null);
    setDraftDropTarget(null);
  }

  function switchMode(nextMode: SetupMode) {
    setMode(nextMode);
    clearError();
    if (nextMode !== "community") {
      communityPreviewRequestIdRef.current += 1;
      setLoadingCommunityPreviewId(null);
      setPreviewingCommunitySet(null);
    }
  }

  function addFiles(sourceFiles: UploadSourceFile[] | null, skippedDirectoryCount = 0) {
    if (!sourceFiles || isConfirmingQuestionSet) {
      return;
    }

    const currentFolderFiles = sourceFiles.filter(isCurrentFolderFile);
    const skippedNestedFiles = sourceFiles.length - currentFolderFiles.length;
    const imageFiles = filesToUploadableImages(currentFolderFiles);
    const oversizedFiles = imageFiles.filter((item) => item.size > maxUploadImageBytes);
    const incoming = imageFiles.filter((item) => item.size <= maxUploadImageBytes);
    const skippedNonImages = currentFolderFiles.length - imageFiles.length;

    if (incoming.length === 0) {
      onError(
        oversizedFiles.length > 0
          ? `图片不能超过 ${formatBytes(maxUploadImageBytes)}`
          : "没有检测到可上传的图片",
      );
      return;
    }

    const existing = new Set(items.map((item) => item.path));
    const nextItems = [...items];

    for (const item of incoming) {
      if (!existing.has(item.path)) {
        nextItems.push(item);
        existing.add(item.path);
      }
    }

    const sortedItems = nextItems.sort((a, b) => a.path.localeCompare(b.path));
    const limitedItems = sortedItems.slice(0, maxUploadImageCount);
    const warningParts = [
      sortedItems.length > maxUploadImageCount ? `一次最多选择 ${maxUploadImageCount} 张图片，已保留前 ${maxUploadImageCount} 张` : "",
      skippedNestedFiles > 0 ? `已忽略 ${skippedNestedFiles} 个子文件夹内的文件` : "",
      skippedDirectoryCount > 0 ? `已忽略 ${skippedDirectoryCount} 个子文件夹` : "",
      oversizedFiles.length > 0 ? `已跳过 ${oversizedFiles.length} 张超过 ${formatBytes(maxUploadImageBytes)} 的图片` : "",
      skippedNonImages > 0 ? `已忽略 ${skippedNonImages} 个非图片文件` : "",
    ].filter(Boolean);

    setItems(limitedItems);

    if (warningParts.length > 0) {
      onError(`${warningParts.join("，")}`);
    } else {
      clearError();
    }

    resetCreatedSet();
  }

  async function handleChooseFolder() {
    if (isConfirmingQuestionSet) {
      return;
    }

    try {
      const pickedFiles = await pickCurrentFolderFiles();

      if (pickedFiles) {
        addFiles(toUploadSourceFiles(pickedFiles));
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      onError(error instanceof Error ? error.message : "读取文件夹失败，请重试");
      return;
    }

    folderInputRef.current?.click();
  }

  function clearFiles() {
    if (isConfirmingQuestionSet) {
      return;
    }

    setItems([]);
    setProgress(emptyProgress);
    resetCreatedSet();

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    if (folderInputRef.current) {
      folderInputRef.current.value = "";
    }
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (isConfirmingQuestionSet) {
      return;
    }
    const dataTransfer = event.dataTransfer;

    try {
      const dropped = await readDroppedUploadFiles(dataTransfer);
      addFiles(dropped.files, dropped.skippedDirectoryCount);
    } catch (error) {
      onError(error instanceof Error ? error.message : "读取拖入的文件夹失败，请重试");
    }
  }

  async function readJsonlFiles(fileList: FileList | File[] | null) {
    const files = Array.from(fileList ?? []).filter((file) => /\.jsonl$/i.test(file.name) || file.type === "application/json");

    if (files.length === 0) {
      onError("请上传 .jsonl 文件");
      return;
    }

    try {
      const texts = await Promise.all(files.map((file) => file.text()));
      setUrlText(texts.join("\n"));
      resetCreatedSet();
      clearError();
    } catch {
      onError("读取题单JSONL文件失败，请重试");
    } finally {
      if (jsonlInputRef.current) {
        jsonlInputRef.current.value = "";
      }
    }
  }

  function handleImportDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingImport(false);
    readJsonlFiles(event.dataTransfer.files);
  }

  async function handleUpload() {
    clearError();

    if (items.length === 0) {
      onError("请先选择至少一张图片");
      return;
    }

    setIsUploading(true);
    resetCreatedSet();
    setProgress({ ...emptyProgress, total: items.length, latestMessage: "开始压缩并上传图片" });

    try {
      const uploadResults = await uploadImagesToR2(items, setProgress);
      const { questions, creationMethod } = buildLocalUploadQuestionImport(items, uploadResults);

      if (questions.length === 0) {
        onError("没有图片上传成功，无法生成预览");
        return;
      }

      setLocalUploadDraft(questions);
      setDraftCreationMethod(creationMethod);
      clearError();
      scrollToPreview();
    } catch (error) {
      onError(error instanceof Error ? error.message : "上传图片失败，请稍后重试");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleCreateFromUrlText() {
    clearError();

    if (!room.id) {
      onError("当前房间信息不完整，请刷新后重试");
      return;
    }

    if (!urlText.trim()) {
      onError("请先粘贴图片链接，或上传题单JSONL文件");
      return;
    }

    if (importPreview.error) {
      onError(importPreview.error);
      return;
    }

    if (importPreview.items.length === 0) {
      onError("没有检测到有效图片链接。请使用 http/https 图片链接，或每行一个包含 image_url 的 JSON 对象");
      return;
    }

    if (importPreview.items.length > maxUploadImageCount) {
      onError(`一次最多导入 ${maxUploadImageCount} 张图片，请删减题单后重试`);
      return;
    }

    setIsCreatingFromText(true);
    resetCreatedSet();
    setProgress({ ...emptyProgress, total: importPreview.items.length, latestMessage: "开始抓取并压缩远端图片" });

    try {
      let preparedQuestions: PreparedQuestionUrlImport[] = [];
      let retryQuestions: QuestionUrlImportInput[] = toImportInputs(importPreview.items);
      while (retryQuestions.length > 0) {
        setProgress((current) => ({
          ...current,
          total: preparedQuestions.length + retryQuestions.length,
          done: preparedQuestions.length,
          success: preparedQuestions.length,
          fail: 0,
          latestMessage: preparedQuestions.length > 0
              ? `正在重试 ${retryQuestions.length} 张失败图片`
              : "正在下载、压缩并上传远端图片",
        }));

        const result = await uploadRemoteImagesToR2(
          retryQuestions,
          room.id,
          presenterPlayerId,
          (current) => setProgress({
            ...current,
            total: preparedQuestions.length + current.total,
            done: preparedQuestions.length + current.done,
            success: preparedQuestions.length + current.success,
          }),
        );
        preparedQuestions = [...preparedQuestions, ...result.preparedQuestions]
          .sort((a, b) => a.orderIndex - b.orderIndex);
        retryQuestions = result.failedQuestions.map(({ error: _error, ...item }) => item);
        if (result.failedQuestions.length === 0) break;
        setProgress({
          ...emptyProgress,
          total: preparedQuestions.length + result.failedQuestions.length,
          done: preparedQuestions.length + result.failedQuestions.length,
          success: preparedQuestions.length,
          fail: result.failedQuestions.length,
          latestMessage: `${result.failedQuestions.length} 张图片导入失败`,
        });

        const failedSummary = result.failedQuestions
          .slice(0, 5)
          .map((item) => `第 ${item.orderIndex + 1} 张：${item.error}`)
          .join("\n");
        const shouldRetry = window.confirm(
          `有 ${result.failedQuestions.length} 张图片导入失败。\n\n${failedSummary}${
            result.failedQuestions.length > 5 ? "\n..." : ""
          }\n\n点击“确定”只重试失败图片；点击“取消”保留已成功图片并生成预览。`,
        );

        if (shouldRetry) {
          continue;
        }
        break;
      }

      if (preparedQuestions.length === 0) {
        onError("没有图片导入成功，无法生成预览");
        return;
      }
      setLocalUploadDraft(buildPreparedUrlImportDraft(preparedQuestions));
      setDraftCreationMethod("creation_tool_assisted");
      setProgress({
        ...emptyProgress,
        total: preparedQuestions.length + retryQuestions.length,
        done: preparedQuestions.length + retryQuestions.length,
        success: preparedQuestions.length,
        fail: retryQuestions.length,
        latestMessage: retryQuestions.length > 0
          ? `已准备 ${preparedQuestions.length} 张图片，跳过 ${retryQuestions.length} 张失败图片`
          : `图片已准备：${preparedQuestions.length} 张图片已上传图库`,
      });
      clearError();
      scrollToPreview();
    } catch (error) {
      onError(error instanceof Error ? error.message : "从图片链接创建题库失败");
    } finally {
      setIsCreatingFromText(false);
    }
  }

  async function handleLoadCommunitySets(params: {
    sort?: CommunityQuestionSetSort;
    search?: string;
    creationMethod?: CommunityCreationMethodFilter;
    append?: boolean;
  } = {}) {
    const sort = params.sort ?? communitySort;
    const search = params.search ?? communitySearch;
    const creationMethod = params.creationMethod ?? communityCreationMethod;
    const append = params.append ?? false;
    const requestId = communityRequestIdRef.current + 1;
    communityRequestIdRef.current = requestId;
    clearError();
    setIsLoadingCommunity(true);
    if (!append) {
      setCommunityTotal(null);
    }

    try {
      const page = await getCommunityQuestionSets({
        sort,
        search,
        creationMethod: creationMethod === "all" ? undefined : creationMethod,
        offset: append ? communityNextOffset : 0,
        limit: communityPageSize,
        includeTotal: !append,
      });
      if (communityRequestIdRef.current !== requestId) {
        return;
      }

      setCommunitySets((current) => {
        if (!append) {
          return page.items;
        }
        const existingIds = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !existingIds.has(item.id))];
      });
      if (page.total !== null) {
        setCommunityTotal(page.total);
      }
      setCommunityHasMore(page.hasMore);
      setCommunityNextOffset(page.nextOffset);
    } catch (error) {
      if (communityRequestIdRef.current !== requestId) {
        return;
      }
      onError(error instanceof Error ? error.message : "加载社区题库失败");
    } finally {
      if (communityRequestIdRef.current === requestId) {
        setIsLoadingCommunity(false);
      }
    }
  }

  async function handlePreviewCommunitySet(questionSetSummary: CommunityQuestionSetSummary) {
    const requestId = communityPreviewRequestIdRef.current + 1;
    communityPreviewRequestIdRef.current = requestId;
    const cachedDetail = communityDetailCacheRef.current.get(questionSetSummary.id);
    if (cachedDetail) {
      setLoadingCommunityPreviewId(null);
      setPreviewingCommunitySet(cachedDetail);
      clearError();
      return;
    }

    clearError();
    setLoadingCommunityPreviewId(questionSetSummary.id);
    try {
      const detail = await getCommunityQuestionSetDetail(questionSetSummary.id);
      if (communityPreviewRequestIdRef.current !== requestId) {
        return;
      }
      if (!detail) {
        throw new Error("题库已取消公开或不存在");
      }
      communityDetailCacheRef.current.set(questionSetSummary.id, detail);
      setPreviewingCommunitySet(detail);
    } catch (error) {
      if (communityPreviewRequestIdRef.current !== requestId) {
        return;
      }
      onError(error instanceof Error ? error.message : "加载题库预览失败");
    } finally {
      if (communityPreviewRequestIdRef.current === requestId) {
        setLoadingCommunityPreviewId(null);
      }
    }
  }

  async function handleSelectCommunitySet(selectedQuestionSet: QuestionSet | CommunityQuestionSetSummary) {
    if (loadingCommunitySelectionId) {
      return;
    }

    setLoadingCommunitySelectionId(selectedQuestionSet.id);
    clearError();
    try {
      let detail = isQuestionSetDetail(selectedQuestionSet)
        ? selectedQuestionSet
        : communityDetailCacheRef.current.get(selectedQuestionSet.id);
      if (!detail) {
        detail = await getCommunityQuestionSetDetail(selectedQuestionSet.id) ?? undefined;
      }
      if (!detail) {
        throw new Error("题库已取消公开或不存在");
      }

      communityDetailCacheRef.current.set(detail.id, detail);
      setLocalUploadDraft(null);
      setDraftCreationMethod("player_manual");
      setQuestionSet(detail);
      clearError();
      scrollToPreview();
    } catch (error) {
      onError(error instanceof Error ? error.message : "加载社区题库失败");
    } finally {
      setLoadingCommunitySelectionId(null);
    }
  }

  function moveDraftQuestion(sourceKey: string, insertionIndex: number) {
    setLocalUploadDraft((current) => current
      ? moveLocalUploadDraftQuestionToIndex(current, sourceKey, insertionIndex)
      : current);
  }

  function handleDraftDragStart(event: DragEvent<HTMLElement>, questionKey: string) {
    draggedDraftKeyRef.current = questionKey;
    setDraggedDraftKey(questionKey);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", questionKey);
  }

  function getDraftDropTarget(container: HTMLDivElement, pointerX: number, pointerY: number) {
    const cardRects = Array.from(container.querySelectorAll<HTMLElement>("[data-draft-question-key]"))
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          key: element.dataset.draftQuestionKey ?? "",
          index: Number(element.dataset.draftQuestionIndex),
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
        };
      });
    return findNearestLocalUploadDropTarget(pointerX, pointerY, cardRects);
  }

  function clearDraftDragState() {
    draggedDraftKeyRef.current = null;
    setDraggedDraftKey(null);
    setDraftDropTarget(null);
  }

  function handleDraftGridDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const target = getDraftDropTarget(event.currentTarget, event.clientX, event.clientY);
    setDraftDropTarget((current) => (
      current?.insertionIndex === target?.insertionIndex
      && current?.cardKey === target?.cardKey
      && current?.side === target?.side
        ? current
        : target
    ));
  }

  function handleDraftGridDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const sourceKey = draggedDraftKeyRef.current || event.dataTransfer.getData("text/plain");
    const target = getDraftDropTarget(event.currentTarget, event.clientX, event.clientY);
    if (sourceKey && target) {
      moveDraftQuestion(sourceKey, target.insertionIndex);
    }
    clearDraftDragState();
  }

  function handleDraftGridDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setDraftDropTarget(null);
  }

  function handleDraftKeyboardMove(event: KeyboardEvent<HTMLElement>, questionKey: string) {
    if (
      event.target !== event.currentTarget
      || isConfirmingQuestionSet
      || !localUploadDraft
      || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      return;
    }

    const currentIndex = localUploadDraft.findIndex((question) => question.key === questionKey);
    const offset = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const targetIndex = currentIndex + offset;
    if (targetIndex < 0 || targetIndex >= localUploadDraft.length) {
      return;
    }

    event.preventDefault();
    moveDraftQuestion(questionKey, offset < 0 ? targetIndex : targetIndex + 1);
  }

  function handleDeleteDraftQuestion(questionKey: string) {
    if (isConfirmingQuestionSet) {
      return;
    }
    setLocalUploadDraft((current) => current ? removeLocalUploadDraftQuestion(current, questionKey) : current);
  }

  async function handleConfirmQuestionSet() {
    if (!room.id) {
      onError("当前房间信息不完整，请刷新后重试");
      return;
    }

    if (!localUploadDraft && !questionSet) {
      onError("请先创建或选择题库");
      return;
    }

    if (localUploadDraft?.length === 0) {
      onError("请至少保留一张图片");
      return;
    }

    setIsConfirmingQuestionSet(true);
    try {
      let selectedQuestionSet = questionSet;

      if (localUploadDraft) {
        selectedQuestionSet = await createUploadedQuestionSet({
          roomId: room.id,
          presenterPlayerId,
          title: getDraftQuestionSetTitle(room),
          description: "",
          questions: localUploadDraft.map((question) => ({
            imageUrl: question.imageUrl,
            labelText: question.labelText,
            isR18: question.isR18,
          })),
          creationMethod: draftCreationMethod,
        });
        setQuestionSet(selectedQuestionSet);
        setLocalUploadDraft(null);
      }

      if (!selectedQuestionSet) {
        throw new Error("请先创建或选择题库");
      }

      const nextRoom = await prepareQuestionSetForStart({
        roomId: room.id,
        presenterPlayerId,
        questionSetId: selectedQuestionSet.id,
      });
      onRoomUpdated({ ...room, ...nextRoom, players: room.players });
      clearError();
    } catch (error) {
      onError(error instanceof Error ? error.message : "确认题库失败，请稍后重试");
    } finally {
      setIsConfirmingQuestionSet(false);
    }
  }

  async function handleCopyUrlsText() {
    try {
      await navigator.clipboard.writeText(urlsTextForPreview);
      clearError();
    } catch {
      onError("复制失败，请手动选择图片链接文本");
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-slate-900 text-sm font-bold text-white">1</span>
          <h3 className="text-base font-semibold text-slate-950">选择来源</h3>
        </div>

        <div className="grid gap-2 sm:grid-cols-3" role="tablist" aria-label="题库来源">
          {[
            ["upload", "上传图片"],
            ["urlText", "题单JSONL/图片链接"],
            ["community", "社区题库"],
          ].map(([value, label]) => (
            <button
              aria-pressed={mode === value}
              className={[
                "rounded-md border px-4 py-3 text-left text-sm font-semibold transition",
                mode === value
                  ? "border-rose-300 bg-rose-50 text-rose-800 shadow-sm"
                  : "border-[var(--line)] bg-white text-slate-700 hover:bg-slate-50",
              ].join(" ")}
              key={value}
              type="button"
              onClick={() => switchMode(value as SetupMode)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "upload" ? (
          <div className="space-y-4">
            {!configStatus.isReady ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                图片上传服务未就绪，无法上传新图片。
              </div>
            ) : null}
            <div
              className={`rounded-md border-2 border-dashed p-6 text-center transition ${
                isDragging ? "border-rose-300 bg-rose-50" : "border-[var(--line)] bg-slate-50"
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <p className="text-base font-semibold text-slate-900">拖拽图片或文件夹到这里</p>
              <div className="mt-4 flex flex-wrap justify-center gap-3">
                <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={isConfirmingQuestionSet}>
                  选择图片
                </Button>
                <Button type="button" variant="secondary" onClick={handleChooseFolder} disabled={isConfirmingQuestionSet}>
                  选择文件夹
                </Button>
              </div>
              <p className="mt-3 text-xs text-[var(--muted)]">
                文件夹只取当前层图片，不读取子文件夹；单张不超过 {formatBytes(maxUploadImageBytes)}，最多 {maxUploadImageCount} 张
              </p>
              {items.length > 0 ? (
                <p className="mt-2 text-xs font-medium text-slate-700">
                  已从文件名识别 {recognizedLabelCount}/{items.length} 个答案
                </p>
              ) : null}
              <input
                ref={fileInputRef}
                className="hidden"
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => addFiles(toUploadSourceFiles(event.target.files ?? []))}
              />
              <input
                ref={folderInputRef}
                className="hidden"
                type="file"
                accept="image/*"
                multiple
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(event) => addFiles(toUploadSourceFiles(event.target.files ?? []))}
              />
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div
                className={
                  items.length > 0
                    ? "rounded-md border-2 border-emerald-500 bg-white p-3 shadow-sm"
                    : "rounded-md bg-slate-50 p-3"
                }
              >
                <span
                  className={items.length > 0 ? "flex items-center gap-1.5 text-xs font-semibold text-slate-600" : "block text-xs text-[var(--muted)]"}
                >
                  {items.length > 0 ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : null}
                  <span>已选择</span>
                </span>
                <span className={items.length > 0 ? "mt-1 block text-2xl font-bold text-emerald-800" : "mt-1 block text-xl font-semibold text-slate-950"}>
                  {items.length}
                </span>
              </div>
              <div className="rounded-md bg-slate-50 p-3">
                <span className="block text-xs text-[var(--muted)]">成功</span>
                <span className="mt-1 block text-xl font-semibold text-slate-950">{progress.success}</span>
              </div>
              <div className="rounded-md bg-slate-50 p-3">
                <span className="block text-xs text-[var(--muted)]">失败</span>
                <span className="mt-1 block text-xl font-semibold text-slate-950">{progress.fail}</span>
              </div>
            </div>
            {progress.total > 0 ? (
              <div>
                <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full bg-[var(--primary)] transition-all" style={{ width: `${progressPercent}%` }} />
                </div>
                <p className="mt-2 text-xs text-[var(--muted)]">{progress.latestMessage}</p>
              </div>
            ) : null}
            {progress.fail > 0 ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                有图片上传失败，可以再次点击上传重试
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <Button type="button" variant="secondary" onClick={clearFiles} disabled={isUploading || isConfirmingQuestionSet || items.length === 0}>
                清空
              </Button>
              <Button type="button" onClick={handleUpload} disabled={!configStatus.isReady || isUploading || isConfirmingQuestionSet || items.length === 0}>
                {isUploading ? "上传中…" : "上传并预览"}
              </Button>
            </div>
          </div>
        ) : null}

        {mode === "urlText" ? (
          <div className="space-y-4">
            <div
              className={`rounded-md border-2 border-dashed p-4 transition ${
                isDraggingImport ? "border-rose-300 bg-rose-50" : "border-[var(--line)] bg-slate-50"
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDraggingImport(true);
              }}
              onDragLeave={() => setIsDraggingImport(false)}
              onDrop={handleImportDrop}
            >
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <p className="text-sm font-semibold text-slate-900">粘贴图片链接，或上传题单JSONL</p>
                <Button type="button" variant="secondary" onClick={() => jsonlInputRef.current?.click()}>
                  选择题单JSONL
                </Button>
              </div>
              <input
                ref={jsonlInputRef}
                className="hidden"
                type="file"
                accept=".jsonl,application/json"
                multiple
                onChange={(event) => readJsonlFiles(event.target.files)}
              />
            </div>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-900">图片链接或题单JSONL</span>
              <textarea
                className="min-h-52 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                placeholder={
                  "https://game.example.com/api/r2-images/question-images/.../image.webp\nhttps://game.example.com/api/r2-images/question-images/.../image2.webp\n\n{\"image_url\":\"https://...jpg\",\"label_text\":\"动画名\"}"
                }
                value={urlText}
                onChange={(event) => {
                  setUrlText(event.target.value);
                  resetCreatedSet();
                  clearError();
                }}
              />
            </label>
            {importPreview.error ? (
              <p className="text-sm text-red-600">{importPreview.error}</p>
            ) : (
              <p className="text-sm text-[var(--muted)]">
                已识别 {importPreview.items.length} 张图片，{importPreview.labeledCount} 个带答案
              </p>
            )}
            <div className="flex justify-end">
              <Button type="button" onClick={handleCreateFromUrlText} disabled={isCreatingFromText || isConfirmingQuestionSet}>
                {isCreatingFromText ? "上传中…" : "上传并预览"}
              </Button>
            </div>
            {isCreatingFromText || progress.total > 0 ? (
              <div>
                <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full bg-[var(--primary)] transition-all" style={{ width: `${progressPercent}%` }} />
                </div>
                <p className="mt-2 text-xs text-[var(--muted)]">{progress.latestMessage}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {mode === "community" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-semibold text-slate-950">社区题库</p>
              <p className="text-sm text-[var(--muted)]">
                {communityTotal === null
                  ? "正在统计题库…"
                  : communitySearch.trim()
                    ? `找到 ${communityTotal} 套题库`
                    : `共 ${communityTotal} 套`}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="block flex-1">
                <span className="mb-2 block text-sm font-medium text-slate-900">搜索题库</span>
                <input
                  className="h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                  placeholder="搜索标题、简介或上传者"
                  value={communitySearch}
                  onChange={(event) => setCommunitySearch(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap justify-end gap-2">
                <select
                  aria-label="社区题库出题方式筛选"
                  className="h-11 rounded-md border border-[var(--line)] bg-white px-3 text-sm"
                  value={communityCreationMethod}
                  onChange={(event) => setCommunityCreationMethod(event.target.value as CommunityCreationMethodFilter)}
                >
                  <option value="all">全部来源</option>
                  <option value="player_manual">玩家手动出题</option>
                  <option value="creation_tool_assisted">出题工具辅助</option>
                </select>
                <select
                  aria-label="社区题库排序"
                  className="h-11 rounded-md border border-[var(--line)] bg-white px-3 text-sm"
                  value={communitySort}
                  onChange={(event) => {
                    const nextSort = event.target.value as CommunityQuestionSetSort;
                    setCommunitySort(nextSort);
                  }}
                >
                  <option value="latest">最新</option>
                  <option value="rating">评分最高</option>
                  <option value="plays">开局最多</option>
                </select>
                <Button
                  className="h-11"
                  type="button"
                  variant="secondary"
                  onClick={() => handleLoadCommunitySets({ append: false })}
                  disabled={isLoadingCommunity}
                >
                  {isLoadingCommunity ? "加载中…" : "刷新"}
                </Button>
              </div>
            </div>
            <div className="grid min-w-0 max-h-[54vh] gap-3 overflow-x-hidden overflow-y-auto pr-1">
              {communitySets.map((item) => (
                <div
                  className="min-w-0 rounded-md border border-[var(--line)] bg-white p-3 text-left transition hover:border-rose-300 hover:bg-rose-50"
                  key={item.id}
                >
                  <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-slate-950">{item.title}</p>
                      {item.description?.trim() ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-[var(--muted)] [overflow-wrap:anywhere]">
                          {item.description}
                        </p>
                      ) : null}
                      <p className="mt-1 flex min-w-0 items-baseline gap-x-4 text-xs">
                        <span className="shrink-0 text-slate-600">
                          {item.imageCount} 题 · {Number(item.ratingAvg).toFixed(1)} 分（{item.ratingCount} 评）· 开局 {item.playCount} 次
                        </span>
                        <span
                          className="min-w-0 truncate text-slate-500"
                          title={`${formatQuestionSetCreatedAt(item)} · 上传者 ${getQuestionSetUploaderName(item)}${
                            communityCreationMethod === "all" && getCreationMethodShortLabel(item.creationMethod)
                              ? ` · ${getCreationMethodShortLabel(item.creationMethod)}`
                              : ""
                          }`}
                        >
                          {formatQuestionSetCreatedAt(item)} · 上传者 {getQuestionSetUploaderName(item)}
                          {communityCreationMethod === "all" && getCreationMethodShortLabel(item.creationMethod)
                            ? ` · ${getCreationMethodShortLabel(item.creationMethod)}`
                            : null}
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 self-end gap-2 md:self-auto">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => handlePreviewCommunitySet(item)}
                        disabled={loadingCommunityPreviewId === item.id}
                      >
                        {loadingCommunityPreviewId === item.id ? "加载中…" : "预览"}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => handleSelectCommunitySet(item)}
                        disabled={loadingCommunitySelectionId !== null}
                      >
                        {loadingCommunitySelectionId === item.id ? "加载中…" : "选择"}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {!isLoadingCommunity && communitySets.length === 0 ? (
                <p className="rounded-md bg-slate-50 px-4 py-5 text-sm text-[var(--muted)]">
                  {communitySearch.trim() ? "没有匹配的题库" : "暂无社区题库"}
                </p>
              ) : null}
              {communitySets.length > 0 ? (
                <div className="flex flex-col items-center gap-2 py-1">
                  {communityTotal !== null ? (
                    <p className="text-xs text-[var(--muted)]">已显示 {communitySets.length} / {communityTotal} 套</p>
                  ) : null}
                  {communityHasMore ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => handleLoadCommunitySets({ append: true })}
                      disabled={isLoadingCommunity}
                    >
                      {isLoadingCommunity ? "加载中…" : "加载更多"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      {previewingCommunitySet ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 px-4 py-6">
          <div className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-2xl">
            <div className="flex flex-col justify-between gap-3 border-b border-[var(--line)] px-5 py-4 sm:flex-row sm:items-start">
              <div>
                <p className="text-lg font-semibold text-slate-950">{previewingCommunitySet.title}</p>
                <p className="mt-1 text-sm text-[var(--muted)]">{previewingCommunitySet.description?.trim() || "暂无简介"}</p>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  {previewingCommunitySet.imageCount} 题，评分 {Number(previewingCommunitySet.ratingAvg).toFixed(2)} / 5，
                  {previewingCommunitySet.ratingCount} 人评分，开局 {previewingCommunitySet.playCount} 次，创建于{" "}
                  {formatQuestionSetCreatedAt(previewingCommunitySet)}，{getQuestionSetUploaderName(previewingCommunitySet)}上传
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    handleSelectCommunitySet(previewingCommunitySet);
                    setPreviewingCommunitySet(null);
                  }}
                >
                  用这个题库
                </Button>
                <button
                  className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-semibold hover:bg-slate-50"
                  type="button"
                  onClick={() => setPreviewingCommunitySet(null)}
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {getQuestionSetPreviewItems(previewingCommunitySet).map((item) => (
                  <figure className="relative rounded-md border border-[var(--line)] bg-slate-50 p-2" key={item.key}>
                    <img alt="" className="aspect-video w-full rounded bg-black object-contain" src={item.url} />
                    {item.isR18 ? (
                      <span className="absolute left-4 top-4 rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white shadow">R18</span>
                    ) : null}
                    <figcaption className="mt-2 text-xs text-[var(--muted)]">
                      第 {item.index + 1} 张
                      <span className="mt-1 block font-medium text-slate-800">{item.labelText?.trim() || "未填写答案"}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <section ref={previewRef} className="space-y-4 border-t border-[var(--line)] pt-5 scroll-mt-4">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-slate-900 text-sm font-bold text-white">2</span>
          <h3 className="text-base font-semibold text-slate-950">确认题库</h3>
        </div>

        {localUploadDraft !== null || questionSet ? (
          <div className="rounded-md border border-[var(--line)] bg-slate-50 p-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <p className="font-semibold text-slate-950">
                  {localUploadDraft !== null ? getDraftQuestionSetTitle(room) : questionSet?.title}
                </p>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {localUploadDraft !== null
                    ? `${localUploadDraft.length} 张图片，尚未确认题库`
                    : `${questionSet?.imageCount ?? 0} 张图片，${questionSet?.isPublic ? "社区公开题库" : "未发布题库"}`}
                  {questionSet?.isPublic ? `，上传者：${getQuestionSetUploaderName(questionSet)}` : ""}
                </p>
              </div>
              <Button
                type="button"
                onClick={handleConfirmQuestionSet}
                disabled={isConfirmingQuestionSet || localUploadDraft?.length === 0}
              >
                {isConfirmingQuestionSet ? "确认中…" : "确认使用这个题库"}
              </Button>
            </div>
            <div
              className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
              role="list"
              onDragLeave={localUploadDraft !== null ? handleDraftGridDragLeave : undefined}
              onDragOver={localUploadDraft !== null ? handleDraftGridDragOver : undefined}
              onDrop={localUploadDraft !== null ? handleDraftGridDrop : undefined}
            >
              {previewItems.map((item) => (
                <figure
                  aria-label={localUploadDraft !== null ? `第 ${item.index + 1} 题，可拖拽或使用方向键调整顺序` : undefined}
                  className={`relative rounded-md border bg-white p-2 outline-none transition ${
                    draggedDraftKey === item.key
                      ? "border-rose-400 opacity-60"
                      : "border-[var(--line)] focus-visible:border-rose-400 focus-visible:ring-4 focus-visible:ring-rose-100"
                  } ${localUploadDraft !== null ? "cursor-grab active:cursor-grabbing" : ""}`}
                  draggable={localUploadDraft !== null && !isConfirmingQuestionSet}
                  data-draft-question-index={item.index}
                  data-draft-question-key={item.key}
                  key={item.key}
                  role="listitem"
                  tabIndex={localUploadDraft !== null ? 0 : undefined}
                  onDragEnd={clearDraftDragState}
                  onDragStart={(event) => handleDraftDragStart(event, item.key)}
                  onKeyDown={(event) => handleDraftKeyboardMove(event, item.key)}
                >
                  {draftDropTarget?.cardKey === item.key && draftDropTarget.side === "before" ? (
                    <span aria-hidden="true" className="pointer-events-none absolute -left-2 top-1 z-20 h-[calc(100%-0.5rem)] w-1 rounded-full bg-rose-500 shadow-sm" />
                  ) : null}
                  {draftDropTarget?.cardKey === item.key && draftDropTarget.side === "after" ? (
                    <span aria-hidden="true" className="pointer-events-none absolute -right-2 top-1 z-20 h-[calc(100%-0.5rem)] w-1 rounded-full bg-rose-500 shadow-sm" />
                  ) : null}
                  {item.isR18 ? (
                    <span className="absolute left-3 top-11 z-10 rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white shadow">R18</span>
                  ) : null}
                  <span className="absolute left-3 top-3 z-10 rounded bg-slate-950/80 px-2 py-1 text-xs font-bold text-white">
                    {item.index + 1}
                  </span>
                  {localUploadDraft !== null ? (
                    <button
                      aria-label={`删除第 ${item.index + 1} 题`}
                      className="group absolute right-0 top-0 z-10 grid h-8 w-8 place-items-center rounded-tr-md focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-rose-200 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isConfirmingQuestionSet}
                      type="button"
                      onClick={() => handleDeleteDraftQuestion(item.key)}
                      onDragStart={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <span className="grid h-6 w-6 place-items-center rounded-full bg-white/95 text-slate-500 shadow-sm ring-1 ring-slate-300/80 transition group-hover:bg-rose-50 group-hover:text-rose-600 group-hover:ring-rose-200">
                        <svg
                          aria-hidden="true"
                          className="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeWidth="2.25"
                          viewBox="0 0 24 24"
                        >
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </span>
                    </button>
                  ) : null}
                  <img
                    alt={`第 ${item.index + 1} 题预览`}
                    className="aspect-video w-full rounded bg-black object-contain"
                    draggable={false}
                    src={item.url}
                  />
                  <figcaption className="mt-2 truncate text-xs text-[var(--muted)]" title={item.labelText?.trim() || "未填写答案"}>
                    {item.labelText?.trim() || "未填写答案"}
                  </figcaption>
                </figure>
              ))}
              {localUploadDraft?.length === 0 ? (
                <p className="col-span-full rounded-md border border-dashed border-[var(--line)] px-4 py-6 text-center text-sm text-[var(--muted)]">
                  已删除全部图片，请重新上传后再确认。
                </p>
              ) : null}
            </div>
            {localUploadDraft && localUploadDraft.length > 0 ? (
              <p className="mt-3 text-center text-sm text-[var(--muted)]">
                拖拽图片可调整题目顺序
              </p>
            ) : null}
            {urlsTextForPreview ? (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-semibold text-slate-900">图片链接文本</summary>
                <textarea
                  className="mt-3 min-h-32 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-xs outline-none"
                  readOnly
                  value={urlsTextForPreview}
                />
                <Button className="mt-3" type="button" variant="secondary" onClick={handleCopyUrlsText}>
                  复制图片链接
                </Button>
              </details>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--line)] bg-slate-50 px-4 py-6 text-sm text-[var(--muted)]">
            上传图片或选择题库后，这里会显示预览
          </div>
        )}
      </section>

      {onCancelPresenterSetup ? (
        <div className="flex justify-end border-t border-[var(--line)] pt-5">
          <Button
            className="w-full sm:w-auto"
            type="button"
            variant="secondary"
            onClick={onCancelPresenterSetup}
            disabled={isCancelingPresenterSetup}
          >
            {isCancelingPresenterSetup ? "撤回中…" : "不当出题人了"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
