"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent, type FormEvent } from "react";
import { BangumiQuestionTagEditor } from "./BangumiQuestionTagEditor";
import { Button } from "./Button";
import { importCommunityScreenshotFromUrl, uploadCommunityScreenshot } from "../lib/communityScreenshotUpload";
import { isSupportedCreationToolImageUrl } from "../lib/creationToolQuestionList";
import {
  createAdminQuestionSetQuestion,
  updateAdminQuestionSetQuestion,
  type AdminQuestionMutationResult,
  type AdminQuestionSetQuestion,
} from "../lib/questionSetAdmin";
import type { BangumiAnimeTag, BangumiCharacterTag } from "../types/game";

type Props = {
  mode: "create" | "edit";
  questionSetId: string;
  expectedUpdatedAt: string;
  uploadKey: string;
  question?: AdminQuestionSetQuestion;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onCancel: () => void;
  onSaved: (result: AdminQuestionMutationResult, action: "created" | "updated") => void;
};

function fileSignature(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function tagsSignature(animeTags: BangumiAnimeTag[], characterTags: BangumiCharacterTag[]) {
  return JSON.stringify({ animeTags, characterTags });
}

export function AdminQuestionEditor({
  mode,
  questionSetId,
  expectedUpdatedAt,
  uploadKey,
  question,
  disabled = false,
  onBusyChange,
  onDirtyChange,
  onCancel,
  onSaved,
}: Props) {
  const [answerText, setAnswerText] = useState(question?.answerText ?? "");
  const [animeTags, setAnimeTags] = useState<BangumiAnimeTag[]>(question?.animeTags ?? []);
  const [characterTags, setCharacterTags] = useState<BangumiCharacterTag[]>(question?.characterTags ?? []);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [uploadedImage, setUploadedImage] = useState<{ signature: string; r2Key: string } | null>(null);
  const [imageLink, setImageLink] = useState("");
  const [remoteImage, setRemoteImage] = useState<{ sourceUrl: string; r2Key: string; fileName: string } | null>(null);
  const [isImportingLink, setIsImportingLink] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const operationAbortRef = useRef<AbortController | null>(null);
  const dragDepthRef = useRef(0);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const originalTags = useMemo(
    () => tagsSignature(question?.animeTags ?? [], question?.characterTags ?? []),
    [question?.animeTags, question?.characterTags],
  );
  const isDirty = mode === "create"
    ? Boolean(file || imageLink.trim() || answerText.trim() || animeTags.length || characterTags.length)
    : Boolean(
      file
      || imageLink.trim()
      || answerText !== (question?.answerText ?? "")
      || tagsSignature(animeTags, characterTags) !== originalTags,
    );

  useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  useEffect(() => () => {
    operationAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    const handleClipboardPaste = (event: ClipboardEvent) => {
      if (disabled || isSaving || isImportingLink) return;
      const target = event.target;
      const isEditable = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable);
      const pastedText = event.clipboardData?.getData("text/plain").trim() ?? "";
      // 网页复制可能同时提供图片与文本；编辑框内优先保留原生文本粘贴。
      if (isEditable && pastedText) return;
      const imageItems = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file != null);
      if (imageItems.length === 0) return;
      event.preventDefault();
      adoptImageFile(imageItems[0]);
    };
    window.addEventListener("paste", handleClipboardPaste);
    return () => window.removeEventListener("paste", handleClipboardPaste);
  }, [disabled, isSaving, isImportingLink]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function adoptImageFile(selected: File | null) {
    if (!selected) return;
    if (!ACCEPTED_IMAGE_TYPES.has(selected.type.toLowerCase())) {
      setError(`${selected.name || "剪贴板内容"} 不是支持的图片格式；请选择 JPEG、PNG 或 WebP。`);
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
    setUploadedImage(null);
    setRemoteImage(null);
    setImageLink("");
    setError("");
  }

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    event.target.value = "";
    adoptImageFile(selected);
  }

  function handleDragEnter(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingImage(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>) {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingImage(false);
  }

  function handleImageDrop(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingImage(false);
    if (disabled || isSaving || isImportingLink) return;
    const files = Array.from(event.dataTransfer.files).filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type.toLowerCase()));
    if (files.length > 0) {
      adoptImageFile(files[0]);
      return;
    }
    const droppedText = (event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain")).trim();
    const firstLine = droppedText.split(/\r?\n/).find((item) => item.trim());
    if (firstLine && isSupportedCreationToolImageUrl(firstLine.trim())) {
      handleImageLinkChange(firstLine.trim());
      setError("");
    } else if (droppedText) {
      try {
        new URL(firstLine?.trim() ?? "");
        setError("拖入的链接不受支持；仅允许 FanCaps 或 Bangumi 的 HTTPS 图片直链。");
      } catch {
        setError("拖入的文本不是有效的截图链接。");
      }
    }
  }

  function handleImageLinkChange(value: string) {
    setImageLink(value);
    if (remoteImage && remoteImage.sourceUrl !== value.trim()) {
      setRemoteImage(null);
      setPreviewUrl("");
    }
    setError("");
  }

  async function importLinkImage() {
    const sourceUrl = imageLink.trim();
    if (!sourceUrl) return setError("请先粘贴要导入的截图直链。");
    if (sourceUrl.length > 2048 || !isSupportedCreationToolImageUrl(sourceUrl)) {
      return setError("链接不受支持；仅允许 FanCaps 或 Bangumi 的 HTTPS 图片直链。");
    }
    if (remoteImage?.sourceUrl === sourceUrl) return;
    const controller = new AbortController();
    operationAbortRef.current?.abort();
    operationAbortRef.current = controller;
    setIsImportingLink(true);
    onBusyChange?.(true);
    setError("");
    try {
      const uploaded = await importCommunityScreenshotFromUrl(sourceUrl, uploadKey, controller.signal);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setFile(null);
      setUploadedImage(null);
      setPreviewUrl(uploaded.url);
      setRemoteImage({ sourceUrl, r2Key: uploaded.key, fileName: uploaded.fileName });
    } catch (importError) {
      if (!controller.signal.aborted) {
        setError(importError instanceof Error ? importError.message : "链接图片导入失败，请稍后重试。");
      }
    } finally {
      if (operationAbortRef.current === controller) operationAbortRef.current = null;
      setIsImportingLink(false);
      onBusyChange?.(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const answer = answerText.trim();
    if (!answer) return setError("请填写正确答案。");
    if (answer.length > 100) return setError("正确答案最多 100 个字符。");
    const sourceUrl = imageLink.trim();
    if (mode === "create" && !file && !remoteImage && !sourceUrl) {
      return setError("请选择要新增的截图，或粘贴 FanCaps / Bangumi 直链导入。");
    }

    const controller = new AbortController();
    operationAbortRef.current?.abort();
    operationAbortRef.current = controller;
    setIsSaving(true);
    onBusyChange?.(true);
    setError("");
    try {
      let r2Key: string | undefined;
      if (file) {
        const signature = fileSignature(file);
        if (uploadedImage?.signature === signature) {
          r2Key = uploadedImage.r2Key;
        } else {
          const uploaded = await uploadCommunityScreenshot(file, uploadKey, controller.signal);
          r2Key = uploaded.key;
          setUploadedImage({ signature, r2Key });
        }
      } else if (remoteImage?.sourceUrl === sourceUrl) {
        r2Key = remoteImage.r2Key;
      } else if (sourceUrl) {
        const uploaded = await importCommunityScreenshotFromUrl(sourceUrl, uploadKey, controller.signal);
        r2Key = uploaded.key;
        setRemoteImage({ sourceUrl, r2Key, fileName: uploaded.fileName });
      }
      const input = {
        answerText: answer,
        animeTags,
        characterTags,
        expectedUpdatedAt,
        ...(r2Key ? { r2Key } : {}),
      };
      const result = mode === "create"
        ? await createAdminQuestionSetQuestion(
          questionSetId,
          { ...input, r2Key: r2Key! },
          uploadKey,
          controller.signal,
        )
        : await updateAdminQuestionSetQuestion(
          questionSetId,
          question!.id,
          input,
          uploadKey,
          controller.signal,
        );
      onDirtyChange?.(false);
      onSaved(result, mode === "create" ? "created" : "updated");
    } catch (saveError) {
      if (!controller.signal.aborted) {
        setError(saveError instanceof Error ? saveError.message : "题目保存失败，请稍后重试。");
      }
    } finally {
      if (operationAbortRef.current === controller) operationAbortRef.current = null;
      setIsSaving(false);
      onBusyChange?.(false);
    }
  }

  const imageUrl = previewUrl || question?.imageUrl || "";
  return (
    <form
      className="rounded-xl border border-sky-200 bg-sky-50/50 p-4 sm:p-5"
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="text-base font-bold text-slate-950">{mode === "create" ? "新增一道截图题" : `编辑第 ${(question?.orderIndex ?? 0) + 1} 题`}</h4>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            {mode === "create" ? "新题会追加到题库末尾；可拖放、粘贴截图或导入 FanCaps / Bangumi 直链。" : "可修改答案、标签，或拖放 / 粘贴 / 导入链接替换截图；不选文件或链接会保留原图。"}
          </p>
        </div>
        <Button
          className="h-9 self-start px-3"
          type="button"
          variant="secondary"
          onClick={isSaving || isImportingLink ? () => operationAbortRef.current?.abort() : onCancel}
        >
          {isSaving || isImportingLink ? "取消当前操作" : "取消"}
        </Button>
      </div>

      <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div
            className={`relative aspect-video overflow-hidden rounded-lg bg-slate-950 transition ${isDraggingImage ? "ring-4 ring-rose-300" : ""}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleImageDrop}
          >
            {imageUrl
              ? <img alt={mode === "create" ? "待新增截图预览" : "待编辑截图预览"} className="h-full w-full object-contain" referrerPolicy="no-referrer" src={imageUrl} />
              : <div className="flex h-full items-center justify-center px-4 text-center text-sm text-slate-400">选择或粘贴 JPEG、PNG、WebP 截图，也可拖放图片 / 链接到此处</div>}
            {isDraggingImage && (
              <div className="absolute inset-0 grid place-items-center bg-slate-950/70">
                <span className="rounded-md bg-white/95 px-3 py-2 text-sm font-semibold text-slate-900">松开即可替换截图</span>
              </div>
            )}
          </div>
          <label className="mt-3 block">
            <span className="text-sm font-semibold text-slate-900">{mode === "create" ? "截图文件" : "替换截图（可选）"}</span>
            <input
              accept="image/jpeg,image/png,image/webp"
              className="mt-2 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:font-semibold"
              disabled={disabled || isSaving || isImportingLink}
              type="file"
              onChange={selectFile}
            />
          </label>
          <p className="mt-1 text-xs leading-5 text-slate-500">可把图片文件拖到预览框，或在页面任意处 Ctrl / Cmd + V 粘贴剪贴板截图。</p>
          {uploadedImage && <p className="mt-2 text-xs font-semibold text-emerald-700">图片已上传；保存冲突时会复用该对象，不会重复上传。</p>}
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
            <label className="block">
              <span className="text-sm font-semibold text-slate-900">{mode === "create" ? "或粘贴截图直链" : "或粘贴替换截图直链（可选）"}</span>
              <input
                ref={linkInputRef}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                className="mt-2 h-10 w-full break-all rounded-md border border-slate-300 bg-white px-3 font-mono text-xs outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                disabled={disabled || isSaving || isImportingLink}
                inputMode="url"
                maxLength={2048}
                placeholder="https://cdni.fancaps.net/file/…"
                spellCheck={false}
                type="text"
                value={imageLink}
                onChange={(event) => handleImageLinkChange(event.target.value)}
              />
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                className="h-9 px-3"
                disabled={disabled || isSaving || isImportingLink || !imageLink.trim()}
                type="button"
                variant="secondary"
                onClick={() => void importLinkImage()}
              >{isImportingLink ? "正在导入…" : "导入链接图片"}</Button>
              {remoteImage && (
                <span className="min-w-0 truncate text-xs font-semibold text-emerald-700" title={remoteImage.fileName}>
                  已导入 {remoteImage.fileName}；保存时复用已上传对象，不会重复上传。
                </span>
              )}
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">仅支持 FanCaps 或 Bangumi 的 HTTPS 图片直链，经受保护接口下载、压缩后上传到本项目存储，不会直连第三方站点。</p>
          </div>
        </div>

        <BangumiQuestionTagEditor
          answer={answerText}
          animeTag={animeTags[0] ?? null}
          characterTags={characterTags}
          disabled={disabled || isSaving}
          uploadKey={uploadKey}
          onAnswerChange={setAnswerText}
          onChange={(animeTag, nextCharacterTags) => {
            setAnimeTags(animeTag ? [animeTag] : []);
            setCharacterTags(nextCharacterTags);
          }}
        />
      </div>

      {error && <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</div>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button className="h-10" disabled={disabled || isSaving || isImportingLink || !isDirty} type="submit">
          {isSaving
            ? file || remoteImage ? "正在保存…" : "正在导入并保存…"
            : isImportingLink
              ? "正在导入链接…"
              : mode === "create" ? "上传并新增题目" : "保存本题修改"}
        </Button>
        {isDirty && <span className="text-xs font-semibold text-amber-700">本题有未保存修改</span>}
      </div>
    </form>
  );
}
