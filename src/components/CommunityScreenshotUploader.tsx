"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { BangumiQuestionTagEditor } from "@/components/BangumiQuestionTagEditor";
import { CommunityImageIndexPreview } from "@/components/CommunityImageIndexPreview";
import { searchBangumiAnime } from "@/lib/bangumiClient";
import {
  bangumiTagDisplayName,
  normalizeBangumiSearchText,
} from "@/lib/bangumiTags";
import {
  createUploadedCommunityQuestionSet,
  uploadCommunityScreenshot,
} from "@/lib/communityScreenshotUpload";
import { COMMUNITY_SCREENSHOT_MAX_QUESTIONS } from "@/lib/communityScreenshotPolicy";
import { getLocalSession } from "@/lib/localSession";
import type { BangumiAnimeTag, BangumiCharacterTag } from "@/types/game";

const DEFAULT_QUESTION_SET_TITLE = "猜猜群题库";
const ACCEPTED_IMAGE_EXTENSION = /\.(?:jpe?g|png|webp|gif|avif)$/i;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

type ScreenshotDraft = {
  id: string;
  file: File;
  labelText: string;
  animeTags: BangumiAnimeTag[];
  characterTags: BangumiCharacterTag[];
};

type UploadSuccess = {
  id: string;
  title: string;
  imageCount: number;
};

function suggestedLabel(filename: string) {
  const basename = filename.replace(/^.*[\\/]/, "");
  return basename.match(/^\d+-(.+)-mosaic\.(?:jpe?g|png|webp|gif|avif)$/i)?.[1]?.trim() ?? "";
}

function fileIdentity(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function CommunityScreenshotUploader({ nickname = "", className = "" }: { nickname?: string; className?: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [uploadKey, setUploadKey] = useState("");
  const [title, setTitle] = useState(DEFAULT_QUESTION_SET_TITLE);
  const [description, setDescription] = useState("");
  const [uploaderNickname, setUploaderNickname] = useState(nickname);
  const [drafts, setDrafts] = useState<ScreenshotDraft[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [success, setSuccess] = useState<UploadSuccess | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAutoTagging, setIsAutoTagging] = useState(false);
  const isBusy = isUploading || isAutoTagging;
  const titleId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadKeyInputRef = useRef<HTMLInputElement>(null);
  const dialogPanelRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const submissionRef = useRef<{ id: string; signature: string } | null>(null);
  const uploadedKeysRef = useRef(new Map<string, string>());
  const operationAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => operationAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isBusy) operationAbortRef.current?.abort();
      else setIsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isBusy, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    if (!wasOpenRef.current && !uploaderNickname.trim() && nickname.trim()) {
      setUploaderNickname(nickname);
    }
    wasOpenRef.current = true;
  }, [isOpen, nickname, uploaderNickname]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => uploadKeyInputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen]);

  function close() {
    if (!isBusy) setIsOpen(false);
  }

  function cancelCurrentOperation() {
    operationAbortRef.current?.abort();
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    setError("");
    setStatus("");
    setSuccess(null);
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selectedFiles.length === 0) return;
    const invalid = selectedFiles.find((file) => !ACCEPTED_IMAGE_TYPES.has(file.type.toLowerCase()) && !ACCEPTED_IMAGE_EXTENSION.test(file.name));
    if (invalid) {
      setError(`${invalid.name} 不是支持的图片文件；已填写的截图不会被清空。`);
      return;
    }
    const existingFiles = new Set(drafts.map((draft) => fileIdentity(draft.file)));
    const files = selectedFiles.filter((file, index) => {
      const identity = fileIdentity(file);
      return !existingFiles.has(identity) && selectedFiles.findIndex((candidate) => fileIdentity(candidate) === identity) === index;
    });
    if (files.length === 0) {
      setError("所选图片已在当前题库中。");
      return;
    }
    if (drafts.length + files.length > COMMUNITY_SCREENSHOT_MAX_QUESTIONS) {
      setError(`当前已有 ${drafts.length} 张；每个题库最多上传 ${COMMUNITY_SCREENSHOT_MAX_QUESTIONS} 张图片。`);
      return;
    }
    setDrafts((current) => [...current, ...files.map((file) => ({
      id: `${fileIdentity(file)}:${crypto.randomUUID()}`,
      file,
      labelText: suggestedLabel(file.name),
      animeTags: [],
      characterTags: [],
    }))]);
  }

  function updateLabel(id: string, labelText: string) {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, labelText } : draft));
  }

  function updateTags(id: string, animeTag: BangumiAnimeTag | null, characterTags: BangumiCharacterTag[]) {
    setDrafts((current) => current.map((draft) => draft.id === id
      ? { ...draft, animeTags: animeTag ? [animeTag] : [], characterTags }
      : draft));
  }

  function copyPreviousTags(index: number) {
    if (index <= 0) return;
    setDrafts((current) => {
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
    ).entries());
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
          const results = await searchBangumiAnime(answer, normalizedKey, controller.signal);
          const exact = results.find((result) => [result.name, result.nameCn]
            .some((name) => name && normalizeBangumiSearchText(name) === normalizedAnswer));
          if (exact) matches.set(normalizedAnswer, { id: exact.id, name: exact.name, nameCn: exact.nameCn });
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
      setDrafts((current) => current.map((draft) => {
        if (draft.animeTags.length > 0) return draft;
        const match = matches.get(normalizeBangumiSearchText(draft.labelText));
        return match ? { ...draft, animeTags: [match], characterTags: [] } : draft;
      }));
      const unresolved = candidates.length - matches.size;
      setStatus(`Bangumi 自动匹配完成：命中 ${matches.size} 个答案${unresolved ? `，${unresolved} 个需手动搜索选择` : ""}。角色需按画面实际出现情况选择。`);
      if (failures.length > 0) setError(`部分 Bangumi 请求失败：${failures[0]}`);
    } finally {
      if (operationAbortRef.current === controller) operationAbortRef.current = null;
      setIsAutoTagging(false);
    }
  }

  function removeDraft(id: string) {
    uploadedKeysRef.current.delete(id);
    setDrafts((current) => current.filter((draft) => draft.id !== id));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy || operationAbortRef.current) return;
    setError("");
    setSuccess(null);

    const normalizedTitle = title.trim();
    const normalizedNickname = uploaderNickname.trim();
    const normalizedUploadKey = uploadKey.trim();
    if (!normalizedUploadKey) return setError("请输入上传密钥。");
    if (!normalizedNickname) return setError("请输入上传者昵称。");
    if (normalizedNickname.length > 20) return setError("上传者昵称最多 20 个字符。");
    if (!normalizedTitle) return setError("请输入题库标题。");
    if (normalizedTitle.length > 80) return setError("题库标题最多 80 个字符。");
    if (description.trim().length > 300) return setError("题库说明最多 300 个字符。");
    if (drafts.length === 0) return setError("请选择至少一张截图。");
    const firstMissingAnswer = drafts.findIndex((draft) => !draft.labelText.trim());
    if (firstMissingAnswer >= 0) return setError(`第 ${firstMissingAnswer + 1} 张截图尚未填写正确答案。`);
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
          setStatus(`正在压缩并上传第 ${index + 1} / ${drafts.length} 张：${draft.file.name}`);
          const uploaded = await uploadCommunityScreenshot(draft.file, normalizedUploadKey, controller.signal);
          r2Key = uploaded.key;
          uploadedKeysRef.current.set(draft.id, r2Key);
          hasStoredUploads = true;
        } else {
          setStatus(`正在复用已上传的第 ${index + 1} / ${drafts.length} 张：${draft.file.name}`);
        }
        questions.push({
          r2Key,
          labelText: draft.labelText.trim(),
          animeTags: draft.animeTags,
          characterTags: draft.characterTags,
        });
      }

      setStatus("图片上传完成，正在写入社区题库……");
      const result = await createUploadedCommunityQuestionSet({
        submissionId,
        title: normalizedTitle,
        description: description.trim() || undefined,
        playerId,
        nickname: normalizedNickname,
        questions,
      }, normalizedUploadKey, controller.signal);
      setSuccess(result);
      setStatus("");
      setUploadKey("");
      setTitle(DEFAULT_QUESTION_SET_TITLE);
      setDescription("");
      setDrafts([]);
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
    <>
      <Button className={className} type="button" variant="secondary" onClick={() => {
        setIsOpen(true);
        setTitle((current) => current.trim() || DEFAULT_QUESTION_SET_TITLE);
        setError("");
        setStatus("");
        setSuccess(null);
      }}>
        密钥上传截图
      </Button>

      {isOpen ? (
        <div
          aria-labelledby={titleId}
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center overscroll-contain bg-slate-950/50 px-3 py-4 sm:px-5"
          role="dialog"
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const focusable = Array.from(dialogPanelRef.current?.querySelectorAll<HTMLElement>(
              "a[href], summary, button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
            ) ?? []).filter((element) => element.offsetParent !== null);
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!dialogPanelRef.current?.contains(document.activeElement)) {
              event.preventDefault();
              (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) close();
          }}
        >
          <div ref={dialogPanelRef} className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
              <div>
                <h2 className="text-xl font-bold text-slate-950" id={titleId}>上传截图到服务器题库</h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  仅持有密钥者可上传。横图最大 1920×1080，竖图最大 1080×1920，超出会在浏览器中自动等比压缩。
                </p>
              </div>
              <button
                aria-label={isBusy ? "取消当前操作" : "关闭"}
                className="grid h-9 min-w-9 shrink-0 place-items-center rounded-md border border-[var(--line)] px-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
                type="button"
                onClick={isBusy ? cancelCurrentOperation : close}
              >{isBusy ? "停止" : "×"}</button>
            </div>

            <form
              className="min-h-0 overflow-y-auto px-5 py-4"
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
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-sm font-semibold text-slate-900">上传密钥</span>
                  <input
                    ref={uploadKeyInputRef}
                    autoComplete="off"
                    className="h-11 w-full rounded-md border border-[var(--line)] px-3 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                    disabled={isBusy}
                    maxLength={256}
                    placeholder="输入管理员提供的密钥"
                    type="password"
                    value={uploadKey}
                    onChange={(event) => setUploadKey(event.target.value)}
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-sm font-semibold text-slate-900">题库标题</span>
                  <input
                    className="h-11 w-full rounded-md border border-[var(--line)] px-3 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                    disabled={isBusy}
                    maxLength={80}
                    placeholder="例如：2026 夏季动画截图"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-sm font-semibold text-slate-900">上传者昵称</span>
                  <input
                    className="h-11 w-full rounded-md border border-[var(--line)] px-3 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                    disabled={isBusy}
                    maxLength={20}
                    placeholder="社区中显示的昵称"
                    value={uploaderNickname}
                    onChange={(event) => setUploaderNickname(event.target.value)}
                  />
                </label>

                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-sm font-semibold text-slate-900">题库说明（可选）</span>
                  <textarea
                    className="min-h-20 w-full resize-y rounded-md border border-[var(--line)] px-3 py-2 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                    disabled={isBusy}
                    maxLength={300}
                    placeholder="说明截图范围、难度或出处"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>

                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-sm font-semibold text-slate-900">截图（1–30 张）</span>
                  <input
                    ref={fileInputRef}
                    accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                    className="block w-full rounded-md border border-dashed border-[var(--line)] bg-slate-50 p-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[var(--primary)] file:px-3 file:py-2 file:font-semibold file:text-white"
                    disabled={isBusy}
                    multiple
                    type="file"
                    onChange={handleFiles}
                  />
                  <span className="mt-1 block text-xs leading-5 text-slate-500">GIF/AVIF 也会转为静态 WebP；单个原文件不超过 30 MB。</span>
                </label>
              </div>

              {drafts.length > 0 ? (
                <section className="mt-4 overflow-hidden rounded-md border border-[var(--line)]">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] bg-slate-50 px-3 py-2 text-sm">
                    <div>
                      <span className="font-semibold text-slate-900">已选择 {drafts.length} 张</span>
                      <span className="ml-2 text-rose-700">每张图片的答案均为必填</span>
                    </div>
                    <button
                      className="rounded-md border border-sky-300 bg-white px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-50 disabled:opacity-50"
                      disabled={isBusy}
                      type="button"
                      onClick={() => void autoMatchAnimeTags()}
                    >
                      {isAutoTagging ? "Bangumi 匹配中…" : "按答案自动匹配番剧"}
                    </button>
                  </div>
                  <div className="max-h-[36rem] divide-y divide-[var(--line)] overflow-y-auto">
                    {drafts.map((draft, index) => {
                      const animeTag = draft.animeTags[0] ?? null;
                      return (
                        <article className="space-y-3 px-3 py-4" key={draft.id}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800" title={draft.file.name}>
                              {index + 1}. {draft.file.name}
                            </p>
                            <div className="flex gap-2">
                              {index > 0 ? (
                                <button
                                  className="h-8 rounded-md border border-[var(--line)] px-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                                  disabled={isBusy}
                                  type="button"
                                  onClick={() => copyPreviousTags(index)}
                                >复制上一题标签</button>
                              ) : null}
                              <button
                                className="h-8 rounded-md border border-[var(--line)] px-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                                disabled={isBusy}
                                type="button"
                                onClick={() => removeDraft(draft.id)}
                              >移除</button>
                            </div>
                          </div>

                          <label className="block">
                            <span className="mb-1 block text-xs font-semibold text-slate-900">
                              正确答案 <span className="text-rose-600">*</span>
                            </span>
                            <input
                              aria-label={`${draft.file.name} 的正确答案`}
                              className="h-10 w-full rounded-md border border-[var(--line)] px-3 text-sm outline-none focus:border-[var(--primary)] disabled:bg-slate-100"
                              disabled={isBusy}
                              maxLength={100}
                              placeholder="正确答案（必填，可用番剧名或你的标准答案）"
                              required
                              value={draft.labelText}
                              onChange={(event) => updateLabel(draft.id, event.target.value)}
                            />
                          </label>

                          <BangumiQuestionTagEditor
                            animeTag={animeTag}
                            characterTags={draft.characterTags}
                            disabled={isBusy}
                            uploadKey={uploadKey.trim()}
                            onAnswerSuggestion={(answer) => {
                              if (!draft.labelText.trim()) updateLabel(draft.id, answer);
                            }}
                            onChange={(nextAnimeTag, nextCharacterTags) => updateTags(draft.id, nextAnimeTag, nextCharacterTags)}
                          />

                          {animeTag ? (
                            <p className="text-xs text-slate-500">
                              当前索引：番剧“{bangumiTagDisplayName(animeTag)}”
                              {draft.characterTags.length ? `，角色 ${draft.characterTags.map(bangumiTagDisplayName).join("、")}` : "，尚未选择画面角色"}。
                            </p>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {drafts.length > 0 ? (
                <div className="mt-4">
                  <CommunityImageIndexPreview
                    animeTags={drafts.flatMap((draft) => draft.animeTags)}
                    characterTags={drafts.flatMap((draft) => draft.characterTags)}
                    disabled={isBusy}
                    uploadKey={uploadKey}
                  />
                </div>
              ) : null}

              {error ? <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-700" role="alert">{error}</p> : null}
              {status ? <p aria-live="polite" className="mt-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm leading-6 text-sky-700">{status}</p> : null}
              {success ? (
                <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-6 text-emerald-700" role="status">
                  上传成功：“{success.title}”已保存为包含 {success.imageCount} 道题的公开社区题库，可在房间的“社区题库”中选择。
                </p>
              ) : null}

              <div className="mt-5 flex flex-col-reverse gap-2 border-t border-[var(--line)] pt-4 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" onClick={isBusy ? cancelCurrentOperation : close}>
                  {isBusy ? "取消当前操作" : "关闭"}
                </Button>
                <Button disabled={isBusy || drafts.length === 0} type="submit">
                  {isUploading ? "正在上传…" : isAutoTagging ? "正在匹配标签…" : `压缩并上传${drafts.length ? ` ${drafts.length} 张` : ""}`}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
