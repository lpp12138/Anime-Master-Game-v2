"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { BangumiQuestionTagEditor } from "@/components/BangumiQuestionTagEditor";
import { Button } from "@/components/Button";
import { CommunityImageIndexPreview } from "@/components/CommunityImageIndexPreview";
import { searchBangumiAnime } from "@/lib/bangumiClient";
import { bangumiTagDisplayName, normalizeBangumiSearchText } from "@/lib/bangumiTags";
import {
  createUploadedCommunityQuestionSet,
  uploadCommunityScreenshot,
} from "@/lib/communityScreenshotUpload";
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
  file: File;
  previewUrl: string;
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

export default function CommunityUploadPage() {
  const router = useRouter();
  const [uploadKey, setUploadKey] = useState("");
  const [title, setTitle] = useState(DEFAULT_QUESTION_SET_TITLE);
  const [description, setDescription] = useState("");
  const [uploaderNickname, setUploaderNickname] = useState("");
  const [drafts, setDrafts] = useState<ScreenshotDraft[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [success, setSuccess] = useState<UploadSuccess | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAutoTagging, setIsAutoTagging] = useState(false);
  const isBusy = isUploading || isAutoTagging;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadKeyInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const draftsRef = useRef<ScreenshotDraft[]>([]);
  const submissionRef = useRef<{ id: string; signature: string } | null>(null);
  const uploadedKeysRef = useRef(new Map<string, string>());
  const operationAbortRef = useRef<AbortController | null>(null);
  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId) ?? drafts[0] ?? null;
  const selectedIndex = selectedDraft ? drafts.findIndex((draft) => draft.id === selectedDraft.id) : -1;
  const completedCount = drafts.filter((draft) => draft.labelText.trim()).length;
  const taggedCount = drafts.filter((draft) => draft.animeTags.length > 0).length;

  useEffect(() => {
    setUploaderNickname(getLocalSession().nickname);
    uploadKeyInputRef.current?.focus();
  }, []);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => () => {
    operationAbortRef.current?.abort();
    draftsRef.current.forEach((draft) => URL.revokeObjectURL(draft.previewUrl));
  }, []);

  useEffect(() => {
    if (drafts.length === 0) return;
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
  }, [drafts.length, isBusy]);

  useEffect(() => {
    if (drafts.length === 0) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [drafts.length]);

  function goHome() {
    if (isBusy) return;
    const historyState = window.history.state as { communityUploadEntry?: boolean } | null;
    if (historyState?.communityUploadEntry) window.history.back();
    else router.replace("/");
  }

  function cancelCurrentOperation() {
    operationAbortRef.current?.abort();
  }

  function focusEditorForDraft(id: string) {
    setSelectedDraftId(id);
    if (window.matchMedia("(max-width: 1023px)").matches) {
      window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
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
      setError(`${invalid.name} 不是支持的图片文件；现有截图和标签不会被清空。`);
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
    const additions = files.map((file) => ({
      id: `${fileIdentity(file)}:${crypto.randomUUID()}`,
      file,
      previewUrl: URL.createObjectURL(file),
      labelText: suggestedLabel(file.name),
      animeTags: [],
      characterTags: [],
    } satisfies ScreenshotDraft));
    setDrafts((current) => [...current, ...additions]);
    setSelectedDraftId((current) => current ?? additions[0]?.id ?? null);
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

  function removeDraft(id: string) {
    if (isBusy) return;
    const index = drafts.findIndex((draft) => draft.id === id);
    const removed = drafts[index];
    if (!removed) return;
    URL.revokeObjectURL(removed.previewUrl);
    uploadedKeysRef.current.delete(id);
    const nextDrafts = drafts.filter((draft) => draft.id !== id);
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
    if (!normalizedKey) return setError("请先填写上传密钥，再自动匹配 BGM 标签。");
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
    setStatus(`正在通过 BGM 匹配 ${candidates.length} 个不同答案（最多 3 个并发）……`);
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
        setError("已取消 BGM 自动匹配；已完成的查询仍会保留在浏览器缓存中。");
        return;
      }
      setDrafts((current) => current.map((draft) => {
        if (draft.animeTags.length > 0) return draft;
        const match = matches.get(normalizeBangumiSearchText(draft.labelText));
        return match ? { ...draft, animeTags: [match], characterTags: [] } : draft;
      }));
      const unresolved = candidates.length - matches.size;
      setStatus(`BGM 自动匹配完成：命中 ${matches.size} 个答案${unresolved ? `，${unresolved} 个需点击图片后手动选择` : ""}。`);
      if (failures.length > 0) setError(`部分 BGM 请求失败：${failures[0]}`);
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

      setStatus("图片上传完成，正在原子写入社区题库……");
      const result = await createUploadedCommunityQuestionSet({
        submissionId,
        title: normalizedTitle,
        description: description.trim() || undefined,
        playerId,
        nickname: normalizedNickname,
        questions,
      }, normalizedUploadKey, controller.signal);
      drafts.forEach((draft) => URL.revokeObjectURL(draft.previewUrl));
      setSuccess(result);
      setStatus("");
      setUploadKey("");
      setTitle(DEFAULT_QUESTION_SET_TITLE);
      setDescription("");
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
              选择截图后会以自适应网格展示。点击任意缩略图，在编辑区填写正确答案并搜索 BGM（Bangumi）番剧与角色标签。
            </p>
          </div>
          <div className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800">
            1–30 张 · 自动压缩至 1080p
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
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-semibold text-slate-900">题库标题</span>
                <input
                  className="h-11 w-full rounded-md border border-[var(--line)] px-3 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                  disabled={isBusy}
                  maxLength={80}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-semibold text-slate-900">上传者昵称</span>
                <input
                  className="h-11 w-full rounded-md border border-[var(--line)] px-3 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                  disabled={isBusy}
                  maxLength={20}
                  placeholder="社区中显示的昵称"
                  value={uploaderNickname}
                  onChange={(event) => setUploaderNickname(event.target.value)}
                />
              </label>
              <label className="block md:col-span-2">
                <span className="mb-1 block text-sm font-semibold text-slate-900">题库说明（可选）</span>
                <textarea
                  className="min-h-20 w-full resize-y rounded-md border border-[var(--line)] px-3 py-2 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                  disabled={isBusy}
                  maxLength={300}
                  placeholder="说明截图范围、难度或出处"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label className="block md:col-span-2">
                <span className="mb-1 block text-sm font-semibold text-slate-900">选择截图（可分多次追加）</span>
                <input
                  ref={fileInputRef}
                  accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                  className="block w-full rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[var(--primary)] file:px-4 file:py-2 file:font-semibold file:text-white hover:border-slate-400 disabled:opacity-50"
                  disabled={isBusy}
                  multiple
                  type="file"
                  onChange={handleFiles}
                />
                <span className="mt-1 block text-xs leading-5 text-slate-500">支持 JPEG、PNG、WebP、GIF、AVIF；GIF/AVIF 会转为静态图，单个原文件不超过 30 MB。</span>
              </label>
            </div>
          </section>

          {success ? (
            <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-800" role="status">
              <h2 className="font-bold">上传成功</h2>
              <p className="mt-1 text-sm leading-6">“{success.title}”已保存为包含 {success.imageCount} 道题的公开社区题库。</p>
            </section>
          ) : null}

          {drafts.length === 0 ? (
            <section className="grid min-h-64 place-items-center rounded-xl border-2 border-dashed border-slate-300 bg-white/70 px-5 py-12 text-center">
              <div>
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-slate-100 text-2xl" aria-hidden="true">▧</div>
                <h2 className="mt-4 text-lg font-bold text-slate-900">尚未选择截图</h2>
                <p className="mt-2 text-sm text-slate-500">通过上方文件框选择图片后，这里会显示可点击编辑的缩略图网格。</p>
              </div>
            </section>
          ) : (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
              <section className="min-w-0 rounded-xl border border-[var(--line)] bg-white p-4 shadow-sm sm:p-5" aria-labelledby="screenshot-grid-title">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-slate-950" id="screenshot-grid-title">截图网格</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      已选 {drafts.length} 张 · 已填答案 {completedCount}/{drafts.length} · BGM 标签 {taggedCount}/{drafts.length}
                    </p>
                  </div>
                  <button
                    className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-50"
                    disabled={isBusy}
                    type="button"
                    onClick={() => void autoMatchAnimeTags()}
                  >
                    {isAutoTagging ? "BGM 匹配中…" : "按答案批量匹配 BGM"}
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
                          disabled={isBusy}
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
                                  BGM · {bangumiTagDisplayName(animeTag)}
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
                          <p className="min-w-0 flex-1 truncate text-xs font-medium text-slate-600" title={draft.file.name}>{draft.file.name}</p>
                          <button
                            aria-label={`移除第 ${index + 1} 张截图：${draft.file.name}`}
                            className="shrink-0 text-xs font-semibold text-slate-500 hover:text-rose-700 disabled:opacity-50"
                            disabled={isBusy}
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
                        <p className="mt-1 truncate text-xs text-slate-500" title={selectedDraft.file.name}>{selectedDraft.file.name}</p>
                      </div>
                      {selectedIndex > 0 ? (
                        <button
                          className="shrink-0 rounded-md border border-slate-200 px-2 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                          disabled={isBusy}
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
                      disabled={isBusy}
                      uploadKey={uploadKey}
                      onAnswerChange={(answer) => updateLabel(selectedDraft.id, answer)}
                      onChange={(animeTag, characterTags) => updateTags(selectedDraft.id, animeTag, characterTags)}
                    />
                    <p className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                      输入或选择后，正确答案、BGM 番剧及角色标签会立即显示在对应缩略图上；最终仍由服务器重新规范化并校验角色归属。
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
              disabled={isBusy}
              uploadKey={uploadKey}
            />
          ) : null}

          {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700" role="alert">{error}</p> : null}
          {status ? <p aria-live="polite" className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-700">{status}</p> : null}

          <div className="z-30 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur sm:sticky sm:bottom-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
            <p className="text-xs text-slate-600">
              {drafts.length > 0 ? `${completedCount}/${drafts.length} 张已填写必填答案；BGM 与角色标签为可选规范索引。` : "请先选择截图。"}
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              {isBusy ? (
                <Button type="button" variant="secondary" onClick={cancelCurrentOperation}>取消当前操作</Button>
              ) : null}
              <Button disabled={isBusy || drafts.length === 0} type="submit">
                {isUploading ? "正在上传…" : isAutoTagging ? "正在匹配 BGM…" : `上传并创建题库${drafts.length ? `（${drafts.length} 张）` : ""}`}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
