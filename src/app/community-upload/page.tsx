"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent, type FormEvent } from "react";
import { BangumiQuestionTagEditor } from "@/components/BangumiQuestionTagEditor";
import { Button } from "@/components/Button";
import { CommunityImageIndexPreview } from "@/components/CommunityImageIndexPreview";
import { searchBangumiAnime } from "@/lib/bangumiClient";
import { bangumiTagDisplayName, normalizeBangumiSearchText } from "@/lib/bangumiTags";
import {
  createUploadedCommunityQuestionSet,
  importCommunityScreenshotFromUrl,
  uploadCommunityScreenshot,
} from "@/lib/communityScreenshotUpload";
import {
  findAppendableQuestionSetByTitle,
  getDefaultAppendableQuestionSetId,
  toAppendableQuestionSetOptions,
  type AppendableQuestionSetOption,
} from "@/lib/communityUploadTitleOptions";
import { listAdminQuestionSets } from "@/lib/questionSetAdmin";
import {
  CREATION_TOOL_QUESTION_LIST_MAX_BYTES,
  isSupportedCreationToolImageUrl,
  parseCreationToolQuestionList,
  parseScreenshotLinkList,
} from "@/lib/creationToolQuestionList";
import { COMMUNITY_SCREENSHOT_MAX_QUESTIONS } from "@/lib/communityScreenshotPolicy";
import { getLocalSession } from "@/lib/localSession";
import {
  APP_BEFORE_ROUTE_CHANGE_EVENT,
  useRouter,
  type AppBeforeRouteChangeDetail,
} from "@/lib/router";
import type { BangumiAnimeTag, BangumiCharacterTag } from "@/types/game";

const DEFAULT_QUESTION_SET_TITLE = "猜猜群题库";
const ACCEPTED_IMAGE_EXTENSION = /\.(?:jpe?g|png|webp|gif|avif)$/i;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

type ScreenshotDraft = {
  id: string;
  file: File | null;
  displayName: string;
  previewUrl: string;
  previewIsObjectUrl: boolean;
  sourceUrl: string | null;
  labelText: string;
  animeTags: BangumiAnimeTag[];
  characterTags: BangumiCharacterTag[];
};

type UploadSuccess = {
  id: string;
  title: string;
  imageCount: number;
  appended: boolean;
  addedImageCount: number;
};

function suggestedLabel(filename: string) {
  const basename = filename.replace(/^.*[\\/]/, "");
  return basename.match(/^\d+-(.+)-mosaic\.(?:jpe?g|png|webp|gif|avif)$/i)?.[1]?.trim() ?? "";
}

function fileIdentity(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function revokeDraftPreview(draft: ScreenshotDraft) {
  if (draft.previewIsObjectUrl) URL.revokeObjectURL(draft.previewUrl);
}

export default function CommunityUploadPage() {
  const router = useRouter();
  const [uploadKey, setUploadKey] = useState("");
  const [newTitle, setNewTitle] = useState(DEFAULT_QUESTION_SET_TITLE);
  const [selectedExistingSetId, setSelectedExistingSetId] = useState("");
  const [existingSetOptions, setExistingSetOptions] = useState<AppendableQuestionSetOption[]>([]);
  const [existingSetsStatus, setExistingSetsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [existingSetsError, setExistingSetsError] = useState("");
  const [description, setDescription] = useState("");
  const [uploaderNickname, setUploaderNickname] = useState("");
  const [questionListText, setQuestionListText] = useState("");
  const [imageUrlText, setImageUrlText] = useState("");
  const [isDraggingImages, setIsDraggingImages] = useState(false);
  const [drafts, setDrafts] = useState<ScreenshotDraft[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [success, setSuccess] = useState<UploadSuccess | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAutoTagging, setIsAutoTagging] = useState(false);
  const [isImportingQuestionList, setIsImportingQuestionList] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const questionListInputRef = useRef<HTMLInputElement>(null);
  const uploadKeyInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const dragDepthRef = useRef(0);
  const draftsRef = useRef<ScreenshotDraft[]>([]);
  const userChoseTitleRef = useRef(false);
  const submissionRef = useRef<{ id: string; signature: string } | null>(null);
  const uploadedKeysRef = useRef(new Map<string, string>());
  const operationAbortRef = useRef<AbortController | null>(null);
  const existingSetsAbortRef = useRef<AbortController | null>(null);
  const existingSetsLoadedKeyRef = useRef("");
  const isBusy = isUploading || isAutoTagging || isImportingQuestionList;
  // 密钥只有在受保护列表接口成功返回后才算验证通过；为空、防抖/加载中或失败时
  // 除密钥输入与返回导航外，上传/导入/编辑/提交/题库选择全部禁用。
  const normalizedUploadKey = uploadKey.trim();
  const isKeyVerified = existingSetsStatus === "ready"
    && normalizedUploadKey !== ""
    && existingSetsLoadedKeyRef.current === normalizedUploadKey;
  const isLocked = !isKeyVerified || isBusy;
  // 验证/重试按钮：密钥非空、不在加载中、不在业务操作中时允许点击（验证失败后仍可重试）。
  const canVerifyKey = normalizedUploadKey !== "" && !isBusy && existingSetsStatus !== "loading";
  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId) ?? drafts[0] ?? null;
  const selectedExistingSet = existingSetOptions.find((option) => option.id === selectedExistingSetId) ?? null;
  const matchedExistingSet = findAppendableQuestionSetByTitle(existingSetOptions, newTitle);
  const selectedIndex = selectedDraft ? drafts.findIndex((draft) => draft.id === selectedDraft.id) : -1;
  const completedCount = drafts.filter((draft) => draft.labelText.trim()).length;
  const taggedCount = drafts.filter((draft) => draft.animeTags.length > 0).length;
  const questionListPreview = useMemo(() => {
    if (!questionListText.trim()) return { count: 0, error: "" };
    try {
      return { count: parseCreationToolQuestionList(questionListText).length, error: "" };
    } catch (previewError) {
      return { count: 0, error: previewError instanceof Error ? previewError.message : "题单格式无效。" };
    }
  }, [questionListText]);
  const hasUnsubmittedWork = drafts.length > 0 || Boolean(questionListText.trim()) || Boolean(imageUrlText.trim()) || isBusy;

  // 上传者昵称不再从本地会话自动填入，必须由用户手动填写（提交时校验非空）。
  useEffect(() => {
    uploadKeyInputRef.current?.focus();
  }, []);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  // 密钥变化后（防抖）自动加载可继续追加的现有社区题库；密钥为空时回到空闲态。
  useEffect(() => {
    const key = uploadKey.trim();
    if (!key) {
      existingSetsAbortRef.current?.abort();
      existingSetsLoadedKeyRef.current = "";
      userChoseTitleRef.current = false;
      setExistingSetOptions([]);
      setSelectedExistingSetId("");
      setExistingSetsStatus("idle");
      setExistingSetsError("");
      return;
    }
    if (key === existingSetsLoadedKeyRef.current) return;
    // 密钥已变化：立即中止仍在进行的旧密钥请求，并重置选项/状态，
    // 避免旧密钥的结果在防抖期间或快速改回原密钥后覆盖当前状态。
    existingSetsAbortRef.current?.abort();
    existingSetsLoadedKeyRef.current = "";
    userChoseTitleRef.current = false;
    setExistingSetOptions([]);
    setSelectedExistingSetId("");
    setExistingSetsStatus("idle");
    setExistingSetsError("");
    const timer = window.setTimeout(() => {
      void loadAppendableQuestionSets(key);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [uploadKey]);

  // 刷新后所选题库若已不可追加（被删除、改结构等），回到新建模式并保留自定义标题；
  // 若用户从未主动选择，则重新应用默认选中逻辑。
  useEffect(() => {
    if (!selectedExistingSetId) return;
    if (existingSetOptions.some((option) => option.id === selectedExistingSetId)) return;
    if (!userChoseTitleRef.current) {
      applyDefaultTitleSelection(existingSetOptions);
    } else {
      setSelectedExistingSetId("");
    }
  }, [existingSetOptions, selectedExistingSetId]);

  useEffect(() => {
    const handleClipboardPaste = (event: ClipboardEvent) => {
      if (isLocked) return;
      const target = event.target;
      const isEditable = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable);
      const pastedText = event.clipboardData?.getData("text/plain").trim() ?? "";
      // Some browsers expose both an image and text when copying from a web
      // page. Never swallow the user's text paste inside an editable field.
      if (isEditable && pastedText) return;
      const imageFiles = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file != null);
      if (imageFiles.length > 0) {
        event.preventDefault();
        addLocalFiles(imageFiles, "已从剪贴板粘贴");
        return;
      }
      if (isEditable) return;
      const pastedUrls = pastedText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      if (pastedUrls.length > 0 && pastedUrls.every((item) => isSupportedCreationToolImageUrl(item))) {
        event.preventDefault();
        setImageUrlText((current) => [current.trim(), ...pastedUrls].filter(Boolean).join("\n"));
        setStatus(`已粘贴 ${pastedUrls.length} 个截图链接；请点击“导入截图链接”。`);
      }
    };
    window.addEventListener("paste", handleClipboardPaste);
    return () => window.removeEventListener("paste", handleClipboardPaste);
  }, [isLocked]);

  useEffect(() => () => {
    operationAbortRef.current?.abort();
    existingSetsAbortRef.current?.abort();
    draftsRef.current.forEach(revokeDraftPreview);
  }, []);

  useEffect(() => {
    if (!hasUnsubmittedWork) return;
    const confirmRouteExit = (event: Event) => {
      const routeEvent = event as CustomEvent<AppBeforeRouteChangeDetail>;
      if (routeEvent.detail?.path === "/community-upload") return;
      const message = isBusy
        ? "当前操作仍在进行，离开会中止浏览器请求，服务器可能已经保存部分内容。确定离开吗？"
        : "当前截图和标签尚未提交，确定离开上传页面吗？";
      if (!window.confirm(message)) event.preventDefault();
    };
    window.addEventListener(APP_BEFORE_ROUTE_CHANGE_EVENT, confirmRouteExit);
    return () => window.removeEventListener(APP_BEFORE_ROUTE_CHANGE_EVENT, confirmRouteExit);
  }, [hasUnsubmittedWork, isBusy]);

  useEffect(() => {
    if (!hasUnsubmittedWork) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsubmittedWork]);

  function goHome() {
    if (isBusy) return;
    const historyState = window.history.state as { communityUploadEntry?: boolean } | null;
    if (historyState?.communityUploadEntry) window.history.back();
    else router.replace("/");
  }

  function cancelCurrentOperation() {
    operationAbortRef.current?.abort();
  }

  // 通过受保护的管理列表接口加载可继续追加的现有社区题库；只使用公开摘要字段，
  // 不读取题目/答案。服务端按“规范集合、公开、未被人工改动、manifest 当前版本”
  // 追加（见 worker/gameService.ts），这里过滤后再按精确标题去重。
  async function loadAppendableQuestionSets(key: string) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      setExistingSetsStatus("idle");
      setExistingSetsError("");
      return;
    }
    existingSetsAbortRef.current?.abort();
    const controller = new AbortController();
    existingSetsAbortRef.current = controller;
    setExistingSetsStatus("loading");
    setExistingSetsError("");
    try {
      const page = await listAdminQuestionSets(
        { search: "", visibility: "public", source: "all", limit: 50, offset: 0 },
        normalizedKey,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      let items = page.items;
      let options = toAppendableQuestionSetOptions(items);
      // “猜猜群题库”即使不在最近更新的首 50 项中，也应能成为默认选项。
      if (page.hasMore && !findAppendableQuestionSetByTitle(options, DEFAULT_QUESTION_SET_TITLE)) {
        const preferredPage = await listAdminQuestionSets(
          { search: DEFAULT_QUESTION_SET_TITLE, visibility: "public", source: "all", limit: 50, offset: 0 },
          normalizedKey,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const knownIds = new Set(items.map((item) => item.id));
        items = [...items, ...preferredPage.items.filter((item) => !knownIds.has(item.id))];
        options = toAppendableQuestionSetOptions(items);
      }
      existingSetsLoadedKeyRef.current = normalizedKey;
      setExistingSetOptions(options);
      setExistingSetsStatus("ready");
      // 密钥验证成功且用户尚未主动选择时应用默认选中：精确标题
      // DEFAULT_QUESTION_SET_TITLE 优先，其次第一项现有可追加题库，
      // 没有任何现有题库时才保持“新建题库”。用户主动选择后不再覆盖。
      if (!userChoseTitleRef.current) applyDefaultTitleSelection(options);
    } catch (loadError) {
      if (controller.signal.aborted) return;
      existingSetsLoadedKeyRef.current = "";
      setExistingSetsError(loadError instanceof Error ? loadError.message : "现有题库加载失败。");
      setExistingSetsStatus("error");
    } finally {
      if (existingSetsAbortRef.current === controller) existingSetsAbortRef.current = null;
    }
  }

  /**
   * 默认选中逻辑：精确标题“猜猜群题库”优先；不存在时选第一项现有可追加题库；
   * 没有任何现有题库时落到“新建题库”。
   */
  function applyDefaultTitleSelection(options: AppendableQuestionSetOption[]) {
    setSelectedExistingSetId(getDefaultAppendableQuestionSetId(options, DEFAULT_QUESTION_SET_TITLE));
  }

  function focusEditorForDraft(id: string) {
    setSelectedDraftId(id);
    if (window.matchMedia("(max-width: 1023px)").matches) {
      window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  function updateDrafts(updater: (current: ScreenshotDraft[]) => ScreenshotDraft[]) {
    setDrafts((current) => {
      const next = updater(current);
      draftsRef.current = next;
      return next;
    });
  }

  function addLocalFiles(selectedFiles: File[], sourceLabel = "已选择") {
    setError("");
    setStatus("");
    setSuccess(null);
    if (selectedFiles.length === 0) return;
    const invalid = selectedFiles.find((file) => !ACCEPTED_IMAGE_TYPES.has(file.type.toLowerCase()) && !ACCEPTED_IMAGE_EXTENSION.test(file.name));
    if (invalid) {
      setError(`${invalid.name || "剪贴板内容"} 不是支持的图片文件；现有截图和标签不会被清空。`);
      return;
    }
    const currentDrafts = draftsRef.current;
    const existingFiles = new Set(currentDrafts.flatMap((draft) => draft.file ? [fileIdentity(draft.file)] : []));
    const files = selectedFiles.filter((file, index) => {
      const identity = fileIdentity(file);
      return !existingFiles.has(identity) && selectedFiles.findIndex((candidate) => fileIdentity(candidate) === identity) === index;
    });
    if (files.length === 0) {
      setError("这些图片已在当前题库中。");
      return;
    }
    if (currentDrafts.length + files.length > COMMUNITY_SCREENSHOT_MAX_QUESTIONS) {
      setError(`本次已有 ${currentDrafts.length} 张；再加入 ${files.length} 张会超过 ${COMMUNITY_SCREENSHOT_MAX_QUESTIONS} 张上限。`);
      return;
    }
    const additions = files.map((file, index) => {
      const displayName = file.name || `clipboard-${Date.now()}-${index + 1}.png`;
      return {
        id: `${fileIdentity(file)}:${crypto.randomUUID()}`,
        file,
        displayName,
        previewUrl: URL.createObjectURL(file),
        previewIsObjectUrl: true,
        sourceUrl: null,
        labelText: suggestedLabel(displayName),
        animeTags: [],
        characterTags: [],
      } satisfies ScreenshotDraft;
    });
    const nextDrafts = [...currentDrafts, ...additions];
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    setSelectedDraftId((current) => current ?? additions[0]?.id ?? null);
    setStatus(`${sourceLabel} ${additions.length} 张截图，可继续拖放、粘贴或选择图片。`);
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    addLocalFiles(selectedFiles);
  }

  function handleDragEnter(event: ReactDragEvent<HTMLElement>) {
    // 始终阻止默认行为（否则浏览器会直接打开被拖入的文件），
    // 但未验证密钥时不进入可添加状态。
    event.preventDefault();
    if (isLocked) return;
    dragDepthRef.current += 1;
    setIsDraggingImages(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = isLocked ? "none" : "copy";
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>) {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingImages(false);
  }

  function handleImageDrop(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingImages(false);
    if (isLocked) return;
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/") || ACCEPTED_IMAGE_EXTENSION.test(file.name));
    if (files.length > 0) {
      addLocalFiles(files, "已拖放");
      return;
    }
    const droppedText = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (!droppedText.trim()) {
      setError("没有从拖放内容中识别到图片文件或链接。");
      return;
    }
    try {
      const links = parseScreenshotLinkList(droppedText);
      setImageUrlText((current) => [current.trim(), ...links].filter(Boolean).join("\n"));
      setStatus(`已接收拖放的 ${links.length} 个截图链接；请检查后点击“导入截图链接”。`);
    } catch (dropError) {
      setError(dropError instanceof Error ? dropError.message : "拖放内容不是受支持的截图链接。");
    }
  }

  async function importQuestionList(
    text = questionListText,
    options: { clearQuestionList?: boolean; sourceName?: string } = {},
  ): Promise<boolean> {
    if (isBusy || operationAbortRef.current) return false;
    const sourceName = options.sourceName ?? "题单";
    setError("");
    setStatus("");
    setSuccess(null);

    const normalizedUploadKey = uploadKey.trim();
    if (!normalizedUploadKey) {
      setError(`请先填写上传密钥，再导入${sourceName}。`);
      return false;
    }
    let items;
    try {
      items = parseCreationToolQuestionList(text);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : `${sourceName}格式无效。`);
      return false;
    }
    const currentDrafts = draftsRef.current;
    const existingSourceUrls = new Set(currentDrafts.flatMap((draft) => draft.sourceUrl ? [draft.sourceUrl] : []));
    const pendingItems = items.filter((item) => !existingSourceUrls.has(item.imageUrl));
    if (pendingItems.length === 0) {
      setStatus(`${sourceName}中的图片都已在当前截图网格中。`);
      return true;
    }
    if (currentDrafts.length + pendingItems.length > COMMUNITY_SCREENSHOT_MAX_QUESTIONS) {
      setError(`当前已有 ${currentDrafts.length} 张，再导入 ${pendingItems.length} 张会超过 ${COMMUNITY_SCREENSHOT_MAX_QUESTIONS} 张上限。`);
      return false;
    }

    const controller = new AbortController();
    operationAbortRef.current = controller;
    setIsImportingQuestionList(true);
    const additions: Array<{ order: number; draft: ScreenshotDraft }> = [];
    const failures: Array<{ order: number; message: string }> = [];
    let fatalError = "";
    let nextIndex = 0;
    let completed = 0;
    const remoteImportConcurrency = window.matchMedia("(max-width: 767px)").matches ? 1 : 2;
    const workers = Array.from({ length: Math.min(remoteImportConcurrency, pendingItems.length) }, async () => {
      while (nextIndex < pendingItems.length && !controller.signal.aborted) {
        const order = nextIndex;
        nextIndex += 1;
        const item = pendingItems[order];
        setStatus(`正在下载、压缩并上传${sourceName}图片 ${completed + 1} / ${pendingItems.length}……`);
        try {
          const uploaded = await importCommunityScreenshotFromUrl(
            item.imageUrl,
            normalizedUploadKey,
            controller.signal,
          );
          const id = `remote-image:${crypto.randomUUID()}`;
          uploadedKeysRef.current.set(id, uploaded.key);
          additions.push({
            order,
            draft: {
              id,
              file: null,
              displayName: uploaded.fileName,
              previewUrl: uploaded.url,
              previewIsObjectUrl: false,
              sourceUrl: item.imageUrl,
              labelText: item.labelText,
              animeTags: [],
              characterTags: [],
            },
          });
        } catch (itemError) {
          if (!controller.signal.aborted) {
            const message = itemError instanceof Error ? itemError.message : "图片导入失败。";
            failures.push({ order, message });
            if (/上传密钥无效|截图上传功能尚未配置/.test(message)) {
              fatalError = message;
              controller.abort();
            }
          }
        } finally {
          completed += 1;
        }
      }
    });

    let completedWithoutFailures = false;
    try {
      await Promise.all(workers);
      const orderedAdditions = additions.sort((left, right) => left.order - right.order).map(({ draft }) => draft);
      if (orderedAdditions.length > 0) {
        const nextDrafts = [...currentDrafts, ...orderedAdditions];
        draftsRef.current = nextDrafts;
        setDrafts(nextDrafts);
        setSelectedDraftId((current) => current ?? orderedAdditions[0].id);
      }
      if (fatalError) {
        setStatus(orderedAdditions.length > 0 ? `已保留成功导入的 ${orderedAdditions.length} 张图片。` : "");
        setError(fatalError);
      } else if (controller.signal.aborted) {
        setStatus(orderedAdditions.length > 0 ? `已保留成功导入的 ${orderedAdditions.length} 张图片。` : "");
        setError(`已取消${sourceName}导入；服务器已接收的图片会保留供本次提交复用。`);
      } else if (failures.length > 0) {
        failures.sort((left, right) => left.order - right.order);
        setStatus(`成功导入 ${orderedAdditions.length} 张，${failures.length} 张失败；再次导入只会重试失败图片。`);
        setError(`第 ${failures[0].order + 1} 张导入失败：${failures[0].message}`);
      } else {
        completedWithoutFailures = true;
        if (options.clearQuestionList !== false) setQuestionListText("");
        setStatus(`已从${sourceName}导入 ${orderedAdditions.length} 张图片，可继续编辑答案和 Bangumi 标签。`);
      }
    } finally {
      if (operationAbortRef.current === controller) operationAbortRef.current = null;
      setIsImportingQuestionList(false);
    }
    return completedWithoutFailures;
  }

  async function importImageLinks() {
    let links: string[];
    try {
      links = parseScreenshotLinkList(imageUrlText);
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : "截图链接格式无效。");
      return;
    }
    const imported = await importQuestionList(
      JSON.stringify(links.map((imageUrl) => ({ image_url: imageUrl, label_text: "" }))),
      { clearQuestionList: false, sourceName: "截图链接" },
    );
    if (imported) setImageUrlText("");
  }

  async function handleQuestionListFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/\.(?:json|jsonl|ndjson)$/i.test(file.name) && !/^(?:application\/(?:json|x-ndjson)|text\/plain)$/i.test(file.type)) {
      setError("请选择出题工具导出的 .jsonl 或 .json 文件。");
      return;
    }
    if (file.size > CREATION_TOOL_QUESTION_LIST_MAX_BYTES) {
      setError("题单文件不能超过 256 KiB。");
      return;
    }
    try {
      const text = await file.text();
      setQuestionListText(text);
      await importQuestionList(text);
    } catch {
      setError("题单文件读取失败，请重试。");
    }
  }

  function updateLabel(id: string, labelText: string) {
    updateDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, labelText } : draft));
  }

  function updateTags(id: string, animeTag: BangumiAnimeTag | null, characterTags: BangumiCharacterTag[]) {
    updateDrafts((current) => current.map((draft) => draft.id === id
      ? { ...draft, animeTags: animeTag ? [animeTag] : [], characterTags }
      : draft));
  }

  function copyPreviousTags(index: number) {
    if (index <= 0) return;
    updateDrafts((current) => {
      const previous = current[index - 1];
      const target = current[index];
      if (!previous || !target) return current;
      return current.map((draft, draftIndex) => draftIndex === index
        ? {
          ...draft,
          animeTags: previous.animeTags.map((tag) => ({ ...tag })),
          characterTags: previous.characterTags.map((tag) => ({ ...tag })),
        }
        : draft);
    });
  }

  function removeDraft(id: string) {
    if (isBusy) return;
    const currentDrafts = draftsRef.current;
    const index = currentDrafts.findIndex((draft) => draft.id === id);
    const removed = currentDrafts[index];
    if (!removed) return;
    revokeDraftPreview(removed);
    uploadedKeysRef.current.delete(id);
    const nextDrafts = currentDrafts.filter((draft) => draft.id !== id);
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    if (selectedDraftId === id) {
      setSelectedDraftId(nextDrafts[Math.min(index, nextDrafts.length - 1)]?.id ?? null);
    }
  }

  async function autoMatchAnimeTags() {
    if (isBusy || operationAbortRef.current) return;
    setError("");
    setSuccess(null);
    const normalizedKey = uploadKey.trim();
    if (!normalizedKey) return setError("请先填写上传密钥，再自动匹配 Bangumi 标签。");
    const candidates = Array.from(new Map(
      drafts
        .filter((draft) => !draft.animeTags.length && draft.labelText.trim())
        .map((draft) => [normalizeBangumiSearchText(draft.labelText), draft.labelText.trim()]),
    ).entries()).filter(([normalizedAnswer]) => normalizedAnswer);
    if (candidates.length === 0) {
      setStatus("没有需要自动匹配的答案；已标记的图片会保持不变。");
      return;
    }

    const controller = new AbortController();
    operationAbortRef.current = controller;
    setIsAutoTagging(true);
    setStatus(`正在通过 Bangumi 匹配 ${candidates.length} 个不同答案（最多 3 个并发）……`);
    const matches = new Map<string, BangumiAnimeTag>();
    const failures: string[] = [];
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(3, candidates.length) }, async () => {
      while (nextIndex < candidates.length && !controller.signal.aborted) {
        const candidateIndex = nextIndex;
        nextIndex += 1;
        const [normalizedAnswer, answer] = candidates[candidateIndex];
        try {
          const results = await searchBangumiAnime(answer, normalizedKey, "all", controller.signal);
          const exact = results.find((result) => [result.name, result.nameCn]
            .some((name) => name && normalizeBangumiSearchText(name) === normalizedAnswer));
          if (exact) matches.set(normalizedAnswer, {
            id: exact.id,
            name: exact.name,
            nameCn: exact.nameCn,
            subjectType: exact.subjectType ?? 2,
          });
        } catch (matchError) {
          if (controller.signal.aborted) return;
          failures.push(matchError instanceof Error ? matchError.message : `${answer} 匹配失败`);
        }
      }
    });

    try {
      await Promise.all(workers);
      if (controller.signal.aborted) {
        setStatus("");
        setError("已取消 Bangumi 自动匹配；已完成的查询仍会保留在浏览器缓存中。");
        return;
      }
      updateDrafts((current) => current.map((draft) => {
        if (draft.animeTags.length > 0) return draft;
        const match = matches.get(normalizeBangumiSearchText(draft.labelText));
        return match ? { ...draft, animeTags: [match], characterTags: [] } : draft;
      }));
      const unresolved = candidates.length - matches.size;
      setStatus(`Bangumi 自动匹配完成：命中 ${matches.size} 个答案${unresolved ? `，${unresolved} 个需点击图片后手动选择` : ""}。`);
      if (failures.length > 0) setError(`部分 Bangumi 请求失败：${failures[0]}`);
    } finally {
      if (operationAbortRef.current === controller) operationAbortRef.current = null;
      setIsAutoTagging(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy || operationAbortRef.current) return;
    setError("");
    setSuccess(null);

    const normalizedTitle = selectedExistingSetId
      ? selectedExistingSet?.title ?? ""
      : newTitle.trim();
    const normalizedNickname = uploaderNickname.trim();
    const normalizedUploadKey = uploadKey.trim();
    if (!normalizedUploadKey) return setError("请输入上传密钥。");
    if (!normalizedNickname) return setError("请输入上传者昵称。");
    if (normalizedNickname.length > 20) return setError("上传者昵称最多 20 个字符。");
    if (selectedExistingSetId && !selectedExistingSet) {
      return setError("所选的现有题库已不可追加，请重新选择或改为新建题库。");
    }
    if (!normalizedTitle) return setError(selectedExistingSetId ? "请选择要追加的现有题库。" : "请输入题库标题。");
    if (normalizedTitle.length > 80) return setError("题库标题最多 80 个字符。");
    if (description.trim().length > 300) return setError("题库说明最多 300 个字符。");
    if (drafts.length === 0) return setError("请选择至少一张截图。");
    const firstMissingAnswer = drafts.findIndex((draft) => !draft.labelText.trim());
    if (firstMissingAnswer >= 0) {
      focusEditorForDraft(drafts[firstMissingAnswer].id);
      return setError(`第 ${firstMissingAnswer + 1} 张截图尚未填写正确答案。`);
    }
    if (drafts.some((draft) => draft.labelText.trim().length > 100)) return setError("单题答案最多 100 个字符。");

    const playerId = getLocalSession().playerId;
    const submissionSignature = JSON.stringify({
      title: normalizedTitle.replace(/[\r\n]+/g, " "),
      description: description.trim() || null,
      playerId,
      nickname: normalizedNickname.replace(/[\r\n]+/g, " "),
      questions: drafts.map((draft) => ({
        draftId: draft.id,
        labelText: draft.labelText.trim(),
        animeSubjectId: draft.animeTags[0]?.id ?? null,
        characterIds: draft.characterTags.map((tag) => tag.id),
      })),
    });
    if (submissionRef.current?.signature !== submissionSignature) {
      submissionRef.current = { id: crypto.randomUUID(), signature: submissionSignature };
    }
    const submissionId = submissionRef.current.id;

    const controller = new AbortController();
    operationAbortRef.current = controller;
    setIsUploading(true);
    let hasStoredUploads = uploadedKeysRef.current.size > 0;
    try {
      const questions: Array<{
        r2Key: string;
        labelText: string;
        animeTags: BangumiAnimeTag[];
        characterTags: BangumiCharacterTag[];
      }> = [];
      for (const [index, draft] of drafts.entries()) {
        let r2Key = uploadedKeysRef.current.get(draft.id);
        if (!r2Key) {
          if (!draft.file) throw new Error(`第 ${index + 1} 张导入图片缺少可复用的服务器对象，请重新导入题单。`);
          setStatus(`正在压缩并上传第 ${index + 1} / ${drafts.length} 张：${draft.displayName}`);
          const uploaded = await uploadCommunityScreenshot(draft.file, normalizedUploadKey, controller.signal);
          r2Key = uploaded.key;
          uploadedKeysRef.current.set(draft.id, r2Key);
          hasStoredUploads = true;
        } else {
          setStatus(`正在复用已上传的第 ${index + 1} / ${drafts.length} 张：${draft.displayName}`);
        }
        questions.push({
          r2Key,
          labelText: draft.labelText.trim(),
          animeTags: draft.animeTags,
          characterTags: draft.characterTags,
        });
      }

      setStatus("图片上传完成，正在原子创建或追加社区题库……");
      const result = await createUploadedCommunityQuestionSet({
        submissionId,
        title: normalizedTitle,
        description: description.trim() || undefined,
        playerId,
        nickname: normalizedNickname,
        questions,
      }, normalizedUploadKey, controller.signal);
      drafts.forEach(revokeDraftPreview);
      setSuccess(result);
      setStatus("");
      setUploadKey("");
      setNewTitle(DEFAULT_QUESTION_SET_TITLE);
      setSelectedExistingSetId("");
      userChoseTitleRef.current = false;
      existingSetsLoadedKeyRef.current = "";
      setDescription("");
      setQuestionListText("");
      setImageUrlText("");
      draftsRef.current = [];
      setDrafts([]);
      setSelectedDraftId(null);
      submissionRef.current = null;
      uploadedKeysRef.current.clear();
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "上传失败，请稍后重试。";
      if (message.includes("投稿内容已发生变化")) submissionRef.current = null;
      setError(hasStoredUploads
        ? `${message} 已上传的图片会保留供本次重试复用；移除后会由服务器定时清理。`
        : message);
      setStatus("");
    } finally {
      if (operationAbortRef.current === controller) operationAbortRef.current = null;
      setIsUploading(false);
    }
  }

  return (
    <main className="min-h-screen px-4 py-5 sm:px-6 sm:py-8">
      <div className="mx-auto w-full max-w-7xl">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <button
              className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-slate-600 hover:text-slate-950 disabled:opacity-50"
              disabled={isBusy}
              type="button"
              onClick={goHome}
            >
              <span aria-hidden="true">←</span> 返回首页
            </button>
            <h1 className="text-3xl font-bold text-slate-950 sm:text-4xl">密钥上传截图</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
              可拖放、粘贴或选择本地截图，也可粘贴 FanCaps / Bangumi 截图直链，或上传/粘贴动画截图工具的 JSON 题单。图片会进入自适应网格，点击任意缩略图即可填写答案并搜索 Bangumi 作品（动画/游戏）与角色标签。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950 disabled:opacity-50"
              disabled={isLocked}
              type="button"
              onClick={() => router.push("/question-set-admin")}
            >
              题库管理
            </button>
            <div className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800">
              单次 1–30 张 · 自动压缩至 1080p
            </div>
          </div>
        </header>

        <form
          className="space-y-6"
          onKeyDown={(event) => {
            const target = event.target;
            if (
              event.key === "Enter"
              && target instanceof HTMLInputElement
              && ["text", "search", "password"].includes(target.type)
            ) event.preventDefault();
          }}
          onSubmit={submit}
        >
          <section className="rounded-xl border border-[var(--line)] bg-white p-4 shadow-sm sm:p-6" aria-labelledby="upload-settings-title">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold text-slate-950" id="upload-settings-title">题库与上传设置</h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">密钥只通过请求头发送，不会保存到浏览器或写入图片。</p>
              </div>
              <span className="text-xs text-slate-500">默认标题：{DEFAULT_QUESTION_SET_TITLE}</span>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block md:col-span-2">
                <span className="mb-1 block text-sm font-semibold text-slate-900">上传密钥</span>
                <input
                  ref={uploadKeyInputRef}
                  autoComplete="off"
                  className="h-11 w-full rounded-md border border-[var(--line)] px-3 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                  disabled={isBusy}
                  maxLength={256}
                  placeholder="输入管理员提供的密钥"
                  type="password"
                  value={uploadKey}
                  onChange={(event) => setUploadKey(event.target.value)}
                />
                {!isKeyVerified ? (
                  <span className="mt-1 block text-xs leading-5 text-slate-500" role="status">
                    {existingSetsStatus === "loading"
                      ? "正在验证密钥并加载现有题库…"
                      : existingSetsStatus === "error"
                        ? "密钥验证失败：上传、导入与编辑功能已禁用。"
                        : "请输入上传密钥；验证通过前，上传、导入与编辑功能不可用。"}
                  </span>
                ) : (
                  <span className="mt-1 block text-xs leading-5 text-emerald-700" role="status">密钥已通过验证，可开始上传。</span>
                )}
              </label>
              <div className="space-y-2">
                <span className="mb-1 block text-sm font-semibold text-slate-900">题库标题</span>
                <div className="flex items-stretch gap-2">
                  <select
                    aria-label="题库标题：新建或选择现有题库"
                    className="h-11 min-w-0 flex-1 rounded-md border border-[var(--line)] bg-white px-3 text-sm outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                    disabled={isLocked}
                    value={selectedExistingSetId}
                    onChange={(event) => {
                      userChoseTitleRef.current = true;
                      setSelectedExistingSetId(event.target.value);
                    }}
                  >
                    {isKeyVerified ? (
                      <>
                        <option value="">＋ 新建题库（自定义标题）</option>
                        {existingSetOptions.length > 0 ? (
                          <optgroup label="追加到现有题库（精确标题）">
                            {existingSetOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.title}（已有 {option.imageCount} 题）
                              </option>
                            ))}
                          </optgroup>
                        ) : null}
                      </>
                    ) : (
                      <option value="">请先验证上传密钥</option>
                    )}
                  </select>
                  <button
                    className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-950 disabled:opacity-50"
                    disabled={!canVerifyKey}
                    type="button"
                    onClick={() => void loadAppendableQuestionSets(uploadKey)}
                  >
                    {existingSetsStatus === "loading" ? "加载中…" : isKeyVerified ? "刷新" : "验证"}
                  </button>
                </div>
                {isKeyVerified && selectedExistingSetId === "" ? (
                  <>
                    <input
                      className="h-11 w-full rounded-md border border-[var(--line)] px-3 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                      disabled={isLocked}
                      maxLength={80}
                      placeholder="输入新题库的标题"
                      value={newTitle}
                      onChange={(event) => {
                        userChoseTitleRef.current = true;
                        setNewTitle(event.target.value);
                      }}
                    />
                    {existingSetsStatus === "ready" && matchedExistingSet ? (
                      <p className="text-xs leading-5 text-amber-700">
                        标题与现有题库「{matchedExistingSet.title}」完全相同，本次提交会按顺序追加到该题库（当前 {matchedExistingSet.imageCount} 题）；如需独立新题库，请更换标题。
                      </p>
                    ) : (
                      <p className="text-xs leading-5 text-slate-500">新建独立题库；若标题与现有社区截图题库完全相同，本次图片会按顺序追加到该题库（整套不再受累计 30 题限制，单次投稿最多 {COMMUNITY_SCREENSHOT_MAX_QUESTIONS} 张）。</p>
                    )}
                  </>
                ) : selectedExistingSet ? (
                  <p className="rounded-md bg-sky-50 px-3 py-2 text-xs leading-5 text-slate-700">
                    已选择「{selectedExistingSet.title}」：本次提交的截图会按顺序追加到该公开社区题库（当前 {selectedExistingSet.imageCount} 题），提交标题使用题库的精确标题。
                  </p>
                ) : null}
                {existingSetsStatus === "loading" ? (
                  <p className="text-xs text-slate-500">正在加载可继续追加的现有题库…</p>
                ) : existingSetsStatus === "error" ? (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-rose-700" role="alert">
                    <span>现有题库加载失败：{existingSetsError}</span>
                    <button className="underline disabled:opacity-50" disabled={!canVerifyKey} type="button" onClick={() => void loadAppendableQuestionSets(uploadKey)}>重试</button>
                  </p>
                ) : existingSetsStatus === "ready" && existingSetOptions.length === 0 ? (
                  <p className="text-xs text-slate-500">当前没有可继续追加的现有社区题库（需公开且未被人工改动）。</p>
                ) : uploadKey.trim() === "" && existingSetsStatus === "idle" ? (
                  <p className="text-xs text-slate-500">填写上传密钥后，可加载并选择可继续追加的现有社区题库。</p>
                ) : null}
              </div>
              <label className="block">
                <span className="mb-1 block text-sm font-semibold text-slate-900">上传者昵称</span>
                <input
                  className="h-11 w-full rounded-md border border-[var(--line)] px-3 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                  disabled={isLocked}
                  maxLength={20}
                  placeholder="社区中显示的昵称"
                  required
                  value={uploaderNickname}
                  onChange={(event) => setUploaderNickname(event.target.value)}
                />
              </label>
              <label className="block md:col-span-2">
                <span className="mb-1 block text-sm font-semibold text-slate-900">题库说明（可选）</span>
                <textarea
                  className="min-h-20 w-full resize-y rounded-md border border-[var(--line)] px-3 py-2 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                  disabled={isLocked}
                  maxLength={300}
                  placeholder="说明截图范围、难度或出处"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <div className="md:col-span-2">
                <span className="mb-1 block text-sm font-semibold text-slate-900">选择截图（可分多次追加）</span>
                <div
                  aria-label="拖放、粘贴或选择截图区域"
                  className={`grid place-items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition ${isDraggingImages ? "border-[var(--primary)] bg-rose-50 ring-4 ring-rose-100" : "border-slate-300 bg-slate-50 hover:border-slate-400"}`}
                  onDragEnter={handleDragEnter}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDrop={handleImageDrop}
                >
                  <p className="text-sm font-semibold text-slate-800">{isDraggingImages ? "松开即可添加图片或链接" : isLocked ? "请先验证上传密钥" : "把截图拖到这里"}</p>
                  <p className="max-w-xl text-xs leading-5 text-slate-500">可一次拖入多张 JPEG、PNG、WebP、GIF、AVIF 图片，也可拖入 FanCaps / Bangumi 图片直链。</p>
                  <button
                    className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                    disabled={isLocked}
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                  >选择图片文件</button>
                  <p className="text-xs leading-5 text-slate-500">或在页面任意位置按 Ctrl / Cmd + V 粘贴剪贴板截图。</p>
                  <input
                    ref={fileInputRef}
                    accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                    className="hidden"
                    disabled={isLocked}
                    multiple
                    type="file"
                    onChange={handleFiles}
                  />
                </div>
                <span className="mt-1 block text-xs leading-5 text-slate-500">单个原文件不超过 30 MB；GIF/AVIF 会转为静态图，所有图片自动压缩至 1080p。</span>
              </div>
              <section className="space-y-3 rounded-xl border border-sky-200 bg-sky-50/60 p-4 md:col-span-2" aria-labelledby="screenshot-link-import-title">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-950" id="screenshot-link-import-title">粘贴截图直链</h3>
                    <p className="mt-1 text-xs leading-5 text-slate-600">每行一个 FanCaps 或 Bangumi 的 HTTPS 图片直链；图片会经受保护端点下载、压缩并加入下方网格。</p>
                  </div>
                  <button
                    className="shrink-0 rounded-md bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
                    disabled={isLocked || !imageUrlText.trim()}
                    type="button"
                    onClick={() => void importImageLinks()}
                  >{isImportingQuestionList ? "正在导入…" : "导入截图链接"}</button>
                </div>
                <textarea
                  aria-label="截图图片直链，每行一个"
                  className="min-h-24 w-full resize-y break-all rounded-md border border-sky-200 bg-white px-3 py-2 font-mono text-xs leading-5 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                  disabled={isLocked}
                  placeholder={"https://cdni.fancaps.net/file/...jpg\nhttps://lain.bgm.tv/pic/cover/...jpg"}
                  value={imageUrlText}
                  onChange={(event) => {
                    setImageUrlText(event.target.value);
                    setError("");
                    setSuccess(null);
                  }}
                />
                <p className="text-xs leading-5 text-slate-600">
                  支持 FanCaps（cdni.fancaps.net 等）与 Bangumi（lain.bgm.tv）的 HTTPS 直链，单次最多 {COMMUNITY_SCREENSHOT_MAX_QUESTIONS} 个；`#` 开头的行为注释，已成功导入的图片在重试或提交时会复用服务器对象。
                </p>
              </section>
              <section className="space-y-3 rounded-xl border border-sky-200 bg-sky-50/60 p-4 md:col-span-2" aria-labelledby="question-list-import-title">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-950" id="question-list-import-title">导入动画截图工具题单</h3>
                    <p className="mt-1 text-xs leading-5 text-slate-600">可上传工具导出的 JSONL / JSON 文件，或直接粘贴题单内容；图片会从 FanCaps / Bangumi 下载、压缩并加入下方网格。</p>
                  </div>
                  <button
                    className="shrink-0 rounded-md border border-sky-300 bg-white px-3 py-2 text-xs font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-50"
                    disabled={isLocked}
                    type="button"
                    onClick={() => questionListInputRef.current?.click()}
                  >选择题单文件</button>
                  <input
                    ref={questionListInputRef}
                    accept=".json,.jsonl,.ndjson,application/json,application/x-ndjson,text/plain"
                    className="hidden"
                    disabled={isLocked}
                    type="file"
                    onChange={(event) => void handleQuestionListFile(event)}
                  />
                </div>
                <textarea
                  aria-label="出题工具 JSON 题单内容"
                  className="min-h-32 w-full resize-y rounded-md border border-sky-200 bg-white px-3 py-2 font-mono text-xs leading-5 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                  disabled={isLocked}
                  placeholder={'{"image_url":"https://cdni.fancaps.net/file/...jpg","label_text":"动画名"}'}
                  value={questionListText}
                  onChange={(event) => {
                    setQuestionListText(event.target.value);
                    setError("");
                    setSuccess(null);
                  }}
                />
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className={`text-xs leading-5 ${questionListPreview.error ? "text-rose-700" : "text-slate-600"}`}>
                    {questionListPreview.error
                      ? questionListPreview.error
                      : questionListPreview.count > 0
                        ? `已识别 ${questionListPreview.count} 道题；空答案可在导入后逐题补充。`
                        : "兼容截图工具复制或导出的 image_url / label_text 格式，单次最多 30 题。"}
                  </p>
                  <button
                    className="shrink-0 rounded-md bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
                    disabled={isLocked || !questionListText.trim() || Boolean(questionListPreview.error)}
                    type="button"
                    onClick={() => void importQuestionList()}
                  >{isImportingQuestionList ? "正在导入…" : "导入粘贴题单"}</button>
                </div>
              </section>
            </div>
          </section>

          {success ? (
            <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-800" role="status">
              <h2 className="font-bold">上传成功</h2>
              <p className="mt-1 text-sm leading-6">
                {success.appended
                  ? `本次已向“${success.title}”追加 ${success.addedImageCount} 道题；题库目前共 ${success.imageCount} 道题。`
                  : `“${success.title}”已创建为包含 ${success.imageCount} 道题的公开社区题库。`}
              </p>
            </section>
          ) : null}

          {drafts.length === 0 ? (
            <section className="grid min-h-64 place-items-center rounded-xl border-2 border-dashed border-slate-300 bg-white/70 px-5 py-12 text-center">
              <div>
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-slate-100 text-2xl" aria-hidden="true">▧</div>
                <h2 className="mt-4 text-lg font-bold text-slate-900">尚未选择截图</h2>
                <p className="mt-2 text-sm text-slate-500">把图片拖入上方拖放区、按 Ctrl / Cmd + V 粘贴截图、选择图片文件或粘贴截图直链后，这里会显示可点击编辑的缩略图网格。</p>
              </div>
            </section>
          ) : (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
              <section className="min-w-0 rounded-xl border border-[var(--line)] bg-white p-4 shadow-sm sm:p-5" aria-labelledby="screenshot-grid-title">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-slate-950" id="screenshot-grid-title">截图网格</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      已选 {drafts.length} 张 · 已填答案 {completedCount}/{drafts.length} · Bangumi 标签 {taggedCount}/{drafts.length}
                    </p>
                  </div>
                  <button
                    className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-50"
                    disabled={isLocked}
                    type="button"
                    onClick={() => void autoMatchAnimeTags()}
                  >
                    {isAutoTagging ? "Bangumi 匹配中…" : "按答案批量匹配 Bangumi"}
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {drafts.map((draft, index) => {
                    const animeTag = draft.animeTags[0] ?? null;
                    const isSelected = selectedDraft?.id === draft.id;
                    const hasAnswer = Boolean(draft.labelText.trim());
                    return (
                      <article
                        key={draft.id}
                        className={`overflow-hidden rounded-xl border-2 bg-white transition ${isSelected ? "border-rose-500 shadow-lg shadow-rose-100" : hasAnswer ? "border-slate-200 hover:border-slate-400" : "border-amber-300"}`}
                      >
                        <button
                          className="group relative block aspect-video w-full overflow-hidden bg-slate-950 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-rose-300"
                          type="button"
                          aria-pressed={isSelected}
                          aria-label={`编辑第 ${index + 1} 张截图${hasAnswer ? `，答案 ${draft.labelText.trim()}` : "，尚未填写答案"}`}
                          disabled={isLocked}
                          onClick={() => focusEditorForDraft(draft.id)}
                        >
                          <img className="h-full w-full object-contain transition duration-200 group-hover:scale-[1.02]" src={draft.previewUrl} alt="" />
                          <span className="absolute left-2 top-2 rounded-full bg-slate-950/75 px-2 py-1 text-[11px] font-bold text-white">#{index + 1}</span>
                          <span className={`absolute right-2 top-2 rounded-full px-2 py-1 text-[10px] font-bold ${hasAnswer ? "bg-emerald-500 text-white" : "bg-amber-300 text-amber-950"}`}>
                            {hasAnswer ? "答案已填" : "待填写"}
                          </span>
                          <span className="absolute inset-x-0 bottom-0 block bg-gradient-to-t from-slate-950 via-slate-950/85 to-transparent px-3 pb-3 pt-10 text-white">
                            <span className="block truncate text-sm font-bold" title={draft.labelText.trim() || undefined}>
                              {draft.labelText.trim() || "点击添加正确答案"}
                            </span>
                            <span className="mt-1 flex flex-wrap gap-1">
                              {animeTag ? (
                                <span className="max-w-full truncate rounded bg-sky-500/90 px-1.5 py-0.5 text-[10px] font-semibold">
                                  Bangumi · {bangumiTagDisplayName(animeTag)}
                                </span>
                              ) : null}
                              {draft.characterTags.slice(0, 2).map((tag) => (
                                <span key={tag.id} className="max-w-full truncate rounded bg-fuchsia-500/90 px-1.5 py-0.5 text-[10px] font-semibold">
                                  {bangumiTagDisplayName(tag)}
                                </span>
                              ))}
                              {draft.characterTags.length > 2 ? (
                                <span className="rounded bg-fuchsia-500/90 px-1.5 py-0.5 text-[10px] font-semibold">+{draft.characterTags.length - 2}</span>
                              ) : null}
                            </span>
                          </span>
                        </button>
                        <div className="flex items-center gap-2 px-3 py-2">
                          <p className="min-w-0 flex-1 truncate text-xs font-medium text-slate-600" title={draft.displayName}>{draft.displayName}</p>
                          <button
                            aria-label={`移除第 ${index + 1} 张截图：${draft.displayName}`}
                            className="shrink-0 text-xs font-semibold text-slate-500 hover:text-rose-700 disabled:opacity-50"
                            disabled={isLocked}
                            type="button"
                            onClick={() => removeDraft(draft.id)}
                          >移除</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              <aside ref={editorRef} className="scroll-mt-4 rounded-xl border border-[var(--line)] bg-white p-4 shadow-sm lg:sticky lg:top-4 sm:p-5" aria-labelledby="selected-screenshot-editor-title">
                {selectedDraft ? (
                  <>
                    <div className="mb-4 flex items-start justify-between gap-3 border-b border-slate-200 pb-4">
                      <div className="min-w-0">
                        <h2 className="text-lg font-bold text-slate-950" id="selected-screenshot-editor-title">编辑第 {selectedIndex + 1} 张</h2>
                        <p className="mt-1 truncate text-xs text-slate-500" title={selectedDraft.displayName}>{selectedDraft.displayName}</p>
                      </div>
                      {selectedIndex > 0 ? (
                        <button
                          className="shrink-0 rounded-md border border-slate-200 px-2 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                          disabled={isLocked}
                          type="button"
                          onClick={() => copyPreviousTags(selectedIndex)}
                        >复制上一张标签</button>
                      ) : null}
                    </div>
                    <BangumiQuestionTagEditor
                      key={selectedDraft.id}
                      answer={selectedDraft.labelText}
                      animeTag={selectedDraft.animeTags[0] ?? null}
                      characterTags={selectedDraft.characterTags}
                      disabled={isLocked}
                      uploadKey={uploadKey}
                      onAnswerChange={(answer) => updateLabel(selectedDraft.id, answer)}
                      onChange={(animeTag, characterTags) => updateTags(selectedDraft.id, animeTag, characterTags)}
                    />
                    <p className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                      输入或选择后，正确答案、Bangumi 作品（动画/游戏）及角色标签会立即显示在对应缩略图上；最终仍由服务器重新规范化并校验角色归属。
                    </p>
                  </>
                ) : null}
              </aside>
            </div>
          )}

          {drafts.some((draft) => draft.animeTags.length > 0) ? (
            <CommunityImageIndexPreview
              animeTags={drafts.flatMap((draft) => draft.animeTags)}
              characterTags={drafts.flatMap((draft) => draft.characterTags)}
              disabled={isLocked}
              uploadKey={uploadKey}
            />
          ) : null}

          {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700" role="alert">{error}</p> : null}
          {status ? <p aria-live="polite" className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-700">{status}</p> : null}

          <div className="z-30 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur sm:sticky sm:bottom-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
            <p className="text-xs text-slate-600">
              {drafts.length > 0 ? `${completedCount}/${drafts.length} 张已填写必填答案；Bangumi 与角色标签为可选规范索引。` : "请先选择截图。"}
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              {isBusy ? (
                <Button type="button" variant="secondary" onClick={cancelCurrentOperation}>取消当前操作</Button>
              ) : null}
              <Button disabled={isLocked || drafts.length === 0} type="submit">
                {isUploading
                  ? "正在上传…"
                  : isAutoTagging
                    ? "正在匹配 Bangumi…"
                    : isImportingQuestionList
                      ? "正在导入题单…"
                      : `上传并保存题库${drafts.length ? `（${drafts.length} 张）` : ""}`}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
