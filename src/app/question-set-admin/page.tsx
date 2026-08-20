"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { bangumiTagDisplayName } from "@/lib/bangumiTags";
import {
  deleteAdminQuestionSet,
  getAdminQuestionSet,
  listAdminQuestionSets,
  QuestionSetAdminApiError,
  updateAdminQuestionSet,
  type AdminQuestionSetDetail,
  type AdminQuestionSetFilters,
  type AdminQuestionSetPage,
  type AdminQuestionSetSummary,
} from "@/lib/questionSetAdmin";
import {
  APP_BEFORE_ROUTE_CHANGE_EVENT,
  useRouter,
  type AppBeforeRouteChangeDetail,
} from "@/lib/router";

const PAGE_SIZE = 20;
const DEFAULT_FILTERS: AdminQuestionSetFilters = {
  search: "",
  visibility: "all",
  source: "all",
  limit: PAGE_SIZE,
  offset: 0,
};

type EditForm = {
  title: string;
  description: string;
  isPublic: boolean;
};

function editFormFromDetail(detail: AdminQuestionSetDetail): EditForm {
  return {
    title: detail.title,
    description: detail.description ?? "",
    isPublic: detail.isPublic,
  };
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function sourceLabel(item: AdminQuestionSetSummary) {
  if (item.source === "community") return "社区";
  if (item.creationMethod === "creation_tool_assisted") return "上传 · 工具辅助";
  return "上传";
}

function statusBadge(item: AdminQuestionSetSummary) {
  return item.isPublic
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : "border-slate-200 bg-slate-100 text-slate-700";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "题库管理操作失败，请稍后重试。";
}

function QuestionSetBadges({ item }: { item: AdminQuestionSetSummary }) {
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      <span className={`rounded-full border px-2 py-0.5 font-semibold ${statusBadge(item)}`}>
        {item.isPublic ? "公开" : "未公开"}
      </span>
      <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-sky-800">
        {sourceLabel(item)}
      </span>
      {item.isCanonicalCollection && (
        <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-violet-800">
          规范集合
        </span>
      )}
    </div>
  );
}

export default function QuestionSetAdminPage() {
  const router = useRouter();
  const [uploadKey, setUploadKey] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [draftFilters, setDraftFilters] = useState(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState<AdminQuestionSetPage | null>(null);
  const [detail, setDetail] = useState<AdminQuestionSetDetail | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

  const isDirty = useMemo(() => {
    if (!detail || !editForm) return false;
    const original = editFormFromDetail(detail);
    return editForm.title !== original.title
      || editForm.description !== original.description
      || editForm.isPublic !== original.isPublic;
  }, [detail, editForm]);
  const isBusy = isLoadingList || isLoadingDetail || isSaving || isDeleting;

  useEffect(() => {
    keyInputRef.current?.focus();
    return () => {
      listAbortRef.current?.abort();
      detailAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!isDirty) return;
    const confirmRouteExit = (event: Event) => {
      const routeEvent = event as CustomEvent<AppBeforeRouteChangeDetail>;
      if (routeEvent.detail?.path === "/question-set-admin") return;
      if (!window.confirm("题库元数据尚未保存，确定离开管理页面吗？")) event.preventDefault();
    };
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener(APP_BEFORE_ROUTE_CHANGE_EVENT, confirmRouteExit);
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      window.removeEventListener(APP_BEFORE_ROUTE_CHANGE_EVENT, confirmRouteExit);
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
  }, [isDirty]);

  function handleRequestError(requestError: unknown) {
    if (requestError instanceof QuestionSetAdminApiError && requestError.status === 401) {
      setIsAuthenticated(false);
      setPage(null);
      setDetail(null);
      setEditForm(null);
    }
    setError(errorMessage(requestError));
  }

  async function loadPage(
    filters: AdminQuestionSetFilters,
    key = uploadKey.trim(),
    options: { markAuthenticated?: boolean } = {},
  ) {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    setIsLoadingList(true);
    setError("");
    setNotice("");
    try {
      const loaded = await listAdminQuestionSets(filters, key, controller.signal);
      setPage(loaded);
      setAppliedFilters(filters);
      if (options.markAuthenticated) setIsAuthenticated(true);
      return loaded;
    } catch (requestError) {
      if (!controller.signal.aborted) handleRequestError(requestError);
      return null;
    } finally {
      if (listAbortRef.current === controller) {
        listAbortRef.current = null;
        setIsLoadingList(false);
      }
    }
  }

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (isAuthenticated && !canLeaveCurrentEdit()) return;
    const key = uploadKey.trim();
    if (!key) {
      setError("请输入管理密钥。");
      keyInputRef.current?.focus();
      return;
    }
    const filters = { ...draftFilters, offset: 0 };
    const loaded = await loadPage(filters, key, { markAuthenticated: true });
    if (loaded) setNotice(`已验证密钥，共找到 ${loaded.total} 个题库。`);
  }

  function canLeaveCurrentEdit() {
    return !isDirty || window.confirm("当前题库元数据尚未保存，确定放弃修改吗？");
  }

  async function loadDetail(questionSetId: string) {
    if (isDirty && !canLeaveCurrentEdit()) return;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setIsLoadingDetail(true);
    setError("");
    setNotice("");
    setShowDelete(false);
    setDeleteConfirmation("");
    try {
      const loaded = await getAdminQuestionSet(questionSetId, uploadKey, controller.signal);
      setDetail(loaded);
      setEditForm(editFormFromDetail(loaded));
      window.requestAnimationFrame(() => {
        document.getElementById("question-set-admin-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (requestError) {
      if (!controller.signal.aborted) handleRequestError(requestError);
    } finally {
      if (detailAbortRef.current === controller) {
        detailAbortRef.current = null;
        setIsLoadingDetail(false);
      }
    }
  }

  async function submitFilters(event: FormEvent) {
    event.preventDefault();
    await loadPage({ ...draftFilters, offset: 0 });
  }

  async function changePage(offset: number) {
    if (!canLeaveCurrentEdit()) return;
    setDetail(null);
    setEditForm(null);
    await loadPage({ ...appliedFilters, offset });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveDetail(event: FormEvent) {
    event.preventDefault();
    if (!detail || !editForm || !isDirty) return;
    const title = editForm.title.replace(/[\r\n]+/g, " ").trim();
    if (!title) return setError("题库标题不能为空。");
    if (title.length > 80) return setError("题库标题最多 80 个字符。");
    const description = editForm.description.trim();
    if (description.length > 300) return setError("题库说明最多 300 个字符。");

    setIsSaving(true);
    setError("");
    setNotice("");
    try {
      const updated = await updateAdminQuestionSet(detail.id, {
        title,
        description: description || null,
        isPublic: editForm.isPublic,
        expectedUpdatedAt: detail.updatedAt,
      }, uploadKey);
      setDetail(updated);
      setEditForm(editFormFromDetail(updated));
      setPage((current) => current ? {
        ...current,
        items: current.items.map((item) => item.id === updated.id ? updated : item),
      } : current);
      setNotice("题库标题、说明和公开状态已保存。");
    } catch (requestError) {
      handleRequestError(requestError);
    } finally {
      setIsSaving(false);
    }
  }

  async function removeDetail() {
    if (!detail || !detail.canDelete || deleteConfirmation !== detail.title) return;
    setIsDeleting(true);
    setError("");
    setNotice("");
    try {
      const deleted = await deleteAdminQuestionSet(detail.id, detail.updatedAt, uploadKey);
      const nextOffset = page && page.items.length === 1 && page.offset > 0
        ? Math.max(0, page.offset - page.limit)
        : page?.offset ?? 0;
      setDetail(null);
      setEditForm(null);
      setShowDelete(false);
      setDeleteConfirmation("");
      await loadPage({ ...appliedFilters, offset: nextOffset });
      const cleanup = deleted.imageCleanup;
      const cleanupText = cleanup.pendingCount > 0
        ? `；${cleanup.pendingCount} 个图片对象将在维护任务中重试清理`
        : cleanup.preservedSharedCount > 0
          ? `；保留 ${cleanup.preservedSharedCount} 个仍被其他题库引用的图片对象`
          : cleanup.deletedCount > 0
            ? `；已清理 ${cleanup.deletedCount} 个独占图片对象`
            : "";
      setNotice(`题库“${deleted.title}”已安全删除${cleanupText}。`);
    } catch (requestError) {
      handleRequestError(requestError);
    } finally {
      setIsDeleting(false);
    }
  }

  function logout() {
    if (!canLeaveCurrentEdit()) return;
    listAbortRef.current?.abort();
    detailAbortRef.current?.abort();
    setUploadKey("");
    setIsAuthenticated(false);
    setPage(null);
    setDetail(null);
    setEditForm(null);
    setError("");
    setNotice("管理密钥已从当前页面内存清除。");
    window.requestAnimationFrame(() => keyInputRef.current?.focus());
  }

  return (
    <main className="min-h-screen px-4 py-5 sm:px-6 sm:py-8">
      <div className="mx-auto w-full max-w-7xl">
        <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-sm font-semibold">
              <button className="text-slate-600 hover:text-slate-950" type="button" onClick={() => router.push("/")}>← 返回首页</button>
              <button className="text-sky-700 hover:text-sky-950" type="button" onClick={() => router.push("/community-upload")}>前往截图投稿</button>
            </div>
            <h1 className="text-3xl font-bold text-slate-950 sm:text-4xl">题库管理</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
              使用管理密钥检索和检查题库、查看正确答案与 Bangumi 标签、修改公开状态，或安全删除没有房间与游戏引用的题库。
            </p>
          </div>
          <div className="self-start rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900">
            受保护管理区 · 答案不通过公开 API 暴露
          </div>
        </header>

        <section className="rounded-xl border border-[var(--line)] bg-white p-4 shadow-sm sm:p-6" aria-labelledby="admin-auth-title">
          <h2 className="sr-only" id="admin-auth-title">管理身份验证</h2>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
            <form className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-end" onSubmit={authenticate}>
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-sm font-semibold text-slate-900">管理密钥</span>
                <input
                  ref={keyInputRef}
                  autoComplete="off"
                  className="h-11 w-full rounded-md border border-[var(--line)] px-3 outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100"
                  disabled={isBusy}
                  maxLength={256}
                  placeholder="与截图投稿相同的管理密钥"
                  type="password"
                  value={uploadKey}
                  onChange={(event) => setUploadKey(event.target.value)}
                />
                <span className="mt-1 block text-xs leading-5 text-slate-500">密钥只保留在当前页面内存，并仅通过请求头发送。</span>
              </label>
              <Button className="h-11 shrink-0 sm:w-32" disabled={isBusy || !uploadKey.trim()} type="submit">
                {isLoadingList && !isAuthenticated ? "验证中…" : isAuthenticated ? "重新验证" : "进入管理"}
              </Button>
            </form>
            {isAuthenticated && (
              <Button className="h-11 shrink-0" disabled={isBusy} type="button" variant="secondary" onClick={logout}>退出并清除密钥</Button>
            )}
          </div>
        </section>

        {(error || notice) && (
          <div className={`mt-4 rounded-lg border px-4 py-3 text-sm leading-6 ${error ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`} role={error ? "alert" : "status"} aria-live="polite">
            {error || notice}
          </div>
        )}

        {isAuthenticated && page && (
          <>
            <section className="mt-6 rounded-xl border border-[var(--line)] bg-white p-4 shadow-sm sm:p-6" aria-labelledby="admin-list-title">
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-xl font-bold text-slate-950" id="admin-list-title">题库列表</h2>
                  <p className="mt-1 text-sm text-slate-600">共 {page.total} 个，当前显示 {page.offset + (page.items.length ? 1 : 0)}–{page.offset + page.items.length}。</p>
                </div>
                <Button className="h-10 self-start px-3" disabled={isBusy} type="button" variant="secondary" onClick={() => loadPage(appliedFilters)}>
                  {isLoadingList ? "刷新中…" : "刷新列表"}
                </Button>
              </div>

              <form className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_10rem_auto]" onSubmit={submitFilters}>
                <label className="min-w-0">
                  <span className="mb-1 block text-xs font-semibold text-slate-700">搜索标题、题库 ID 或上传者</span>
                  <input
                    className="h-10 w-full rounded-md border border-[var(--line)] px-3 text-sm outline-none focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                    maxLength={100}
                    placeholder="输入关键词"
                    type="search"
                    value={draftFilters.search}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, search: event.target.value }))}
                  />
                </label>
                <label>
                  <span className="mb-1 block text-xs font-semibold text-slate-700">公开状态</span>
                  <select className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" value={draftFilters.visibility} onChange={(event) => setDraftFilters((current) => ({ ...current, visibility: event.target.value as AdminQuestionSetFilters["visibility"] }))}>
                    <option value="all">全部状态</option>
                    <option value="public">公开</option>
                    <option value="private">未公开</option>
                  </select>
                </label>
                <label>
                  <span className="mb-1 block text-xs font-semibold text-slate-700">题库来源</span>
                  <select className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" value={draftFilters.source} onChange={(event) => setDraftFilters((current) => ({ ...current, source: event.target.value as AdminQuestionSetFilters["source"] }))}>
                    <option value="all">全部来源</option>
                    <option value="uploaded">上传题库</option>
                    <option value="community">社区题库</option>
                  </select>
                </label>
                <Button className="h-10 self-end px-5" disabled={isBusy} type="submit">搜索</Button>
              </form>

              {page.items.length === 0 ? (
                <div className="mt-5 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-600">没有符合条件的题库。</div>
              ) : (
                <>
                  <div className="mt-5 hidden overflow-x-auto md:block">
                    <table className="w-full min-w-[900px] border-separate border-spacing-0 text-left text-sm">
                      <thead>
                        <tr className="text-xs uppercase tracking-wide text-slate-500">
                          <th className="border-b border-slate-200 px-3 py-2">题库</th>
                          <th className="border-b border-slate-200 px-3 py-2">题数 / 索引</th>
                          <th className="border-b border-slate-200 px-3 py-2">引用</th>
                          <th className="border-b border-slate-200 px-3 py-2">更新时间</th>
                          <th className="border-b border-slate-200 px-3 py-2 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {page.items.map((item) => (
                          <tr className={detail?.id === item.id ? "bg-rose-50/60" : "hover:bg-slate-50"} key={item.id}>
                            <td className="max-w-md border-b border-slate-100 px-3 py-3 align-top">
                              <p className="break-words font-semibold text-slate-950">{item.title}</p>
                              <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{item.id}</p>
                              <div className="mt-2"><QuestionSetBadges item={item} /></div>
                            </td>
                            <td className="border-b border-slate-100 px-3 py-3 align-top text-slate-700">{item.imageCount} / {item.indexedImageCount}</td>
                            <td className="border-b border-slate-100 px-3 py-3 align-top text-xs leading-5 text-slate-600">游戏 {item.gameSessionCount}<br />归档 {item.archivedGameCount}<br />房间 {item.preparedRoomCount}</td>
                            <td className="border-b border-slate-100 px-3 py-3 align-top text-xs text-slate-600">{formatDate(item.updatedAt)}</td>
                            <td className="border-b border-slate-100 px-3 py-3 text-right align-top">
                              <Button className="h-9 px-3" disabled={isBusy} type="button" variant="secondary" onClick={() => loadDetail(item.id)}>查看与管理</Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-5 grid gap-3 md:hidden">
                    {page.items.map((item) => (
                      <article className={`min-w-0 rounded-lg border p-4 ${detail?.id === item.id ? "border-rose-300 bg-rose-50/60" : "border-slate-200 bg-white"}`} key={item.id}>
                        <h3 className="break-words font-bold text-slate-950">{item.title}</h3>
                        <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{item.id}</p>
                        <div className="mt-3"><QuestionSetBadges item={item} /></div>
                        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                          <div><dt className="text-slate-500">题数 / 索引</dt><dd className="mt-0.5 font-semibold">{item.imageCount} / {item.indexedImageCount}</dd></div>
                          <div><dt className="text-slate-500">游戏 / 归档 / 房间</dt><dd className="mt-0.5 font-semibold">{item.gameSessionCount} / {item.archivedGameCount} / {item.preparedRoomCount}</dd></div>
                          <div className="col-span-2"><dt className="text-slate-500">更新时间</dt><dd className="mt-0.5">{formatDate(item.updatedAt)}</dd></div>
                        </dl>
                        <Button className="mt-4 h-10 w-full" disabled={isBusy} type="button" variant="secondary" onClick={() => loadDetail(item.id)}>查看与管理</Button>
                      </article>
                    ))}
                  </div>
                </>
              )}

              <div className="mt-5 flex items-center justify-between gap-3">
                <Button className="h-10 px-3" disabled={isBusy || page.offset === 0} type="button" variant="secondary" onClick={() => changePage(Math.max(0, page.offset - page.limit))}>上一页</Button>
                <span className="text-center text-xs text-slate-500">第 {Math.floor(page.offset / page.limit) + 1} 页</span>
                <Button className="h-10 px-3" disabled={isBusy || !page.hasMore} type="button" variant="secondary" onClick={() => changePage(page.nextOffset)}>下一页</Button>
              </div>
            </section>

            {(isLoadingDetail || detail) && (
              <section className="mt-6 scroll-mt-4 rounded-xl border border-[var(--line)] bg-white p-4 shadow-sm sm:p-6" id="question-set-admin-detail" aria-labelledby="admin-detail-title">
                {isLoadingDetail && !detail ? (
                  <div className="py-12 text-center text-sm text-slate-600">正在读取题库详情与答案…</div>
                ) : detail && editForm ? (
                  <>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h2 className="break-words text-2xl font-bold text-slate-950" id="admin-detail-title">{detail.title}</h2>
                        <p className="mt-1 break-all font-mono text-xs text-slate-500">{detail.id}</p>
                        <div className="mt-3"><QuestionSetBadges item={detail} /></div>
                      </div>
                      <Button className="h-10 shrink-0" disabled={isBusy} type="button" variant="secondary" onClick={() => loadDetail(detail.id)}>刷新详情</Button>
                    </div>

                    <dl className="mt-5 grid gap-3 rounded-lg bg-slate-50 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                      <div><dt className="text-xs text-slate-500">题目 / 图片索引</dt><dd className="mt-1 font-semibold">{detail.questions.length} / {detail.indexedImageCount}</dd></div>
                      <div><dt className="text-xs text-slate-500">存储 / 修订</dt><dd className="mt-1 font-semibold">{detail.storageKind === "manifest" ? "manifest" : detail.storageKind === "rows" ? "逐题表" : "损坏"} / {detail.manifestRevision}</dd></div>
                      <div><dt className="text-xs text-slate-500">投稿记录</dt><dd className="mt-1 font-semibold">{detail.submissionCount}</dd></div>
                      <div><dt className="text-xs text-slate-500">创建者</dt><dd className="mt-1 break-all font-semibold">{detail.createdByNickname || detail.createdByPlayerId}</dd></div>
                      <div><dt className="text-xs text-slate-500">评分</dt><dd className="mt-1 font-semibold">{detail.ratingAvg.toFixed(1)}（{detail.ratingCount} 次）</dd></div>
                      <div><dt className="text-xs text-slate-500">游玩次数</dt><dd className="mt-1 font-semibold">{detail.playCount}</dd></div>
                      <div><dt className="text-xs text-slate-500">创建时间</dt><dd className="mt-1">{formatDate(detail.createdAt)}</dd></div>
                      <div><dt className="text-xs text-slate-500">更新时间</dt><dd className="mt-1">{formatDate(detail.updatedAt)}</dd></div>
                    </dl>

                    {detail.integrityIssues.length > 0 && (
                      <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" role="alert">
                        <p className="font-bold">检测到存储一致性问题</p>
                        <ul className="mt-2 list-disc space-y-1 pl-5">
                          {detail.integrityIssues.map((issue) => <li key={issue}>{issue}</li>)}
                        </ul>
                      </div>
                    )}

                    <form className="mt-6 rounded-lg border border-slate-200 p-4 sm:p-5" onSubmit={saveDetail}>
                      <h3 className="text-lg font-bold text-slate-950">元数据与公开状态</h3>
                      <div className="mt-4 grid gap-4 lg:grid-cols-2">
                        <label className="block">
                          <span className="mb-1 block text-sm font-semibold text-slate-900">题库标题</span>
                          <input className="h-11 w-full rounded-md border border-[var(--line)] px-3 outline-none focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100" disabled={isSaving || isDeleting} maxLength={80} value={editForm.title} onChange={(event) => setEditForm((current) => current ? { ...current, title: event.target.value } : current)} />
                          <span className="mt-1 block text-xs text-slate-500">{editForm.title.length} / 80</span>
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-sm font-semibold text-slate-900">题库公开状态</span>
                          <span className="flex min-h-11 items-center gap-3 rounded-md border border-[var(--line)] px-3">
                            <input checked={editForm.isPublic} disabled={isSaving || isDeleting} type="checkbox" onChange={(event) => setEditForm((current) => current ? { ...current, isPublic: event.target.checked } : current)} />
                            <span className="text-sm font-medium">允许在公开社区题库中显示和选用</span>
                          </span>
                          {detail.isCanonicalCollection && !editForm.isPublic && <span className="mt-1 block text-xs leading-5 text-amber-700">取消公开会同时释放该规范同标题集合；以后同标题投稿可能创建新题库。</span>}
                        </label>
                        <label className="block lg:col-span-2">
                          <span className="mb-1 block text-sm font-semibold text-slate-900">题库说明</span>
                          <textarea className="min-h-24 w-full resize-y rounded-md border border-[var(--line)] px-3 py-2 outline-none focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100 disabled:bg-slate-100" disabled={isSaving || isDeleting} maxLength={300} value={editForm.description} onChange={(event) => setEditForm((current) => current ? { ...current, description: event.target.value } : current)} />
                          <span className="mt-1 block text-xs text-slate-500">{editForm.description.length} / 300</span>
                        </label>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-3">
                        <Button className="h-10" disabled={!isDirty || isSaving || isDeleting} type="submit">{isSaving ? "保存中…" : "保存修改"}</Button>
                        <Button className="h-10" disabled={!isDirty || isSaving || isDeleting} type="button" variant="secondary" onClick={() => setEditForm(editFormFromDetail(detail))}>放弃修改</Button>
                        {isDirty && <span className="text-xs font-semibold text-amber-700">有未保存修改</span>}
                      </div>
                    </form>

                    <div className="mt-6">
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                          <h3 className="text-lg font-bold text-slate-950">题目、答案与 Bangumi 标签</h3>
                          <p className="mt-1 text-xs leading-5 text-slate-500">答案只从已验证的管理接口加载。图片使用 no-referrer，管理密钥不会发送到图片源站。</p>
                        </div>
                        <span className="text-xs text-slate-500">共 {detail.questions.length} 题</span>
                      </div>
                      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {detail.questions.map((question) => (
                          <article className={`min-w-0 overflow-hidden rounded-lg border bg-white ${question.answerMismatch ? "border-amber-300" : "border-slate-200"}`} key={question.id}>
                            <div className="aspect-video w-full bg-slate-950">
                              <img alt={`第 ${question.orderIndex + 1} 题截图`} className="h-full w-full object-contain" loading="lazy" referrerPolicy="no-referrer" src={question.imageUrl} />
                            </div>
                            <div className="p-4">
                              <div className="flex items-start justify-between gap-3">
                                <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-bold text-white">第 {question.orderIndex + 1} 题</span>
                                {question.answerMismatch && <span className="text-xs font-semibold text-amber-700">答案索引不一致</span>}
                              </div>
                              <p className="mt-3 text-xs font-semibold text-slate-500">正确答案</p>
                              <p className="mt-1 break-words text-base font-bold text-rose-700">{question.answerText || "（未填写）"}</p>
                              {question.animeTags.length > 0 && (
                                <div className="mt-3">
                                  <p className="text-xs font-semibold text-slate-500">番剧</p>
                                  <div className="mt-1 flex flex-wrap gap-1.5">{question.animeTags.map((tag) => <span className="rounded-full bg-sky-50 px-2 py-1 text-xs text-sky-800" key={tag.id}>{bangumiTagDisplayName(tag)}</span>)}</div>
                                </div>
                              )}
                              {question.characterTags.length > 0 && (
                                <div className="mt-3">
                                  <p className="text-xs font-semibold text-slate-500">画面角色</p>
                                  <div className="mt-1 flex flex-wrap gap-1.5">{question.characterTags.map((tag) => <span className="rounded-full bg-violet-50 px-2 py-1 text-xs text-violet-800" key={tag.id}>{tag.nameCn || tag.name}</span>)}</div>
                                </div>
                              )}
                              <p className="mt-3 break-all font-mono text-[10px] text-slate-400">{question.id}</p>
                            </div>
                          </article>
                        ))}
                      </div>
                    </div>

                    <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 sm:p-5">
                      <h3 className="text-lg font-bold text-rose-950">危险操作</h3>
                      {!detail.canDelete ? (
                        <p className="mt-2 text-sm leading-6 text-rose-900">
                          当前不能删除：活动游戏引用 {detail.gameSessionCount}、已准备房间 {detail.preparedRoomCount}{detail.storageKind === "corrupt" ? "，且 manifest 已损坏" : ""}。历史归档是自包含快照，不会阻止删除；服务器不会绕过活动引用或完整性约束强制删除。
                        </p>
                      ) : !showDelete ? (
                        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-sm leading-6 text-rose-900">删除会原子移除题库、题目索引、投稿记录和评分；只清理不再被其他题库引用的本项目 R2 图片。{detail.archivedGameCount > 0 ? ` ${detail.archivedGameCount} 条历史归档为自包含快照，将继续保留。` : ""}</p>
                          <Button className="h-10 shrink-0 border-rose-300 text-rose-800 hover:bg-rose-100" disabled={isBusy || isDirty} type="button" variant="secondary" onClick={() => setShowDelete(true)}>准备删除</Button>
                        </div>
                      ) : (
                        <div className="mt-4">
                          <label className="block">
                            <span className="text-sm font-semibold text-rose-950">输入完整题库标题“{detail.title}”确认</span>
                            <input className="mt-2 h-11 w-full rounded-md border border-rose-300 bg-white px-3 outline-none focus:ring-4 focus:ring-rose-200" disabled={isDeleting} value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} />
                          </label>
                          <div className="mt-3 flex flex-wrap gap-3">
                            <Button className="h-10 bg-rose-700 shadow-none hover:bg-rose-800" disabled={isDeleting || deleteConfirmation !== detail.title} type="button" onClick={removeDetail}>{isDeleting ? "正在安全删除…" : "永久删除这个题库"}</Button>
                            <Button className="h-10" disabled={isDeleting} type="button" variant="secondary" onClick={() => { setShowDelete(false); setDeleteConfirmation(""); }}>取消</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : null}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
