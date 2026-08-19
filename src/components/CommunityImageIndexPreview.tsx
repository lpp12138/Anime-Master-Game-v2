"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { bangumiTagDisplayName } from "../lib/bangumiTags";
import {
  searchCommunityImageIndex,
  type CommunityIndexedImage,
} from "../lib/communityScreenshotUpload";
import type { BangumiAnimeTag, BangumiCharacterTag } from "../types/game";

type Props = {
  uploadKey: string;
  animeTags: BangumiAnimeTag[];
  characterTags: BangumiCharacterTag[];
  disabled?: boolean;
};

export function CommunityImageIndexPreview({
  uploadKey,
  animeTags,
  characterTags,
  disabled = false,
}: Props) {
  const [animeId, setAnimeId] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [images, setImages] = useState<CommunityIndexedImage[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const querySequenceRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const animeOptions = useMemo(() => {
    const byId = new Map<number, BangumiAnimeTag>();
    animeTags.forEach((tag) => byId.set(tag.id, tag));
    return [...byId.values()];
  }, [animeTags]);
  const effectiveAnimeId = animeOptions.some((tag) => String(tag.id) === animeId)
    ? animeId
    : animeOptions[0] ? String(animeOptions[0].id) : "";
  const characterOptions = useMemo(() => {
    const selectedAnimeId = Number(effectiveAnimeId);
    const byId = new Map<number, BangumiCharacterTag>();
    characterTags
      .filter((tag) => tag.subjectId === selectedAnimeId)
      .forEach((tag) => byId.set(tag.id, tag));
    return [...byId.values()];
  }, [characterTags, effectiveAnimeId]);
  const effectiveCharacterId = characterOptions.some((tag) => String(tag.id) === characterId)
    ? characterId
    : "";

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    querySequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setImages([]);
    setError("");
  }, [uploadKey, effectiveAnimeId, effectiveCharacterId]);

  async function runQuery() {
    if (loading || disabled) return;
    if (!uploadKey.trim()) {
      setError("请先填写上传密钥。");
      return;
    }
    if (!effectiveAnimeId) {
      setError("请先为至少一张截图选择番剧标签。");
      return;
    }

    const controller = new AbortController();
    const sequence = ++querySequenceRef.current;
    abortRef.current = controller;
    setLoading(true);
    setImages([]);
    setError("");
    try {
      const nextImages = await searchCommunityImageIndex(
        Number(effectiveAnimeId),
        effectiveCharacterId ? Number(effectiveCharacterId) : null,
        uploadKey,
        controller.signal,
      );
      if (sequence !== querySequenceRef.current) return;
      setImages(nextImages);
      if (nextImages.length === 0) setError("当前公开题库中没有匹配的已索引图片。");
    } catch (queryError) {
      if (sequence === querySequenceRef.current && !controller.signal.aborted) {
        setError(queryError instanceof Error ? queryError.message : "图片索引查询失败。");
      }
    } finally {
      if (sequence === querySequenceRef.current) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }

  return (
    <details className="rounded-lg border border-violet-200 bg-violet-50/60 p-3">
      <summary className="cursor-pointer text-sm font-semibold text-violet-950">
        预览同标签的公开题库图片（不含答案）
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs leading-5 text-slate-600">
          仅使用当前草稿里已选的规范标签查询；结果最多 20 张，不会读取或显示正确答案。
        </p>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="space-y-1 text-xs font-medium text-slate-700">
            <span>番剧</span>
            <select
              className="w-full rounded-md border border-violet-200 bg-white px-2 py-2 outline-none focus:border-violet-500 disabled:bg-slate-100"
              value={effectiveAnimeId}
              disabled={disabled || loading || animeOptions.length === 0}
              onChange={(event) => {
                setAnimeId(event.target.value);
                setCharacterId("");
              }}
            >
              {animeOptions.length === 0 ? <option value="">请先选择番剧标签</option> : null}
              {animeOptions.map((tag) => (
                <option key={tag.id} value={tag.id}>{bangumiTagDisplayName(tag)} · #{tag.id}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium text-slate-700">
            <span>角色（可选）</span>
            <select
              className="w-full rounded-md border border-violet-200 bg-white px-2 py-2 outline-none focus:border-violet-500 disabled:bg-slate-100"
              value={effectiveCharacterId}
              disabled={disabled || loading || !effectiveAnimeId}
              onChange={(event) => setCharacterId(event.target.value)}
            >
              <option value="">全部角色</option>
              {characterOptions.map((tag) => (
                <option key={tag.id} value={tag.id}>{bangumiTagDisplayName(tag)} · #{tag.id}</option>
              ))}
            </select>
          </label>
          <button
            className="self-end rounded-md bg-violet-700 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
            disabled={disabled || (!loading && animeOptions.length === 0)}
            type="button"
            onClick={loading ? () => abortRef.current?.abort() : () => void runQuery()}
          >
            {loading ? "取消查询" : "查询索引"}
          </button>
        </div>

        {error ? <p className="text-xs text-red-700" role="alert">{error}</p> : null}
        {images.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-live="polite">
            {images.map((image) => (
              <a
                key={image.questionId}
                className="overflow-hidden rounded-md border border-violet-100 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                href={image.imageUrl}
                target="_blank"
                rel="noreferrer"
                title={`题库 ${image.questionSetId}`}
              >
                <img
                  className="aspect-video w-full bg-slate-100 object-cover"
                  src={image.imageUrl}
                  alt="同标签公开题库截图"
                  loading="lazy"
                />
                <span className="block truncate px-2 py-1.5 text-[11px] text-violet-900">
                  {image.characterTags.length > 0
                    ? image.characterTags.map(bangumiTagDisplayName).join("、")
                    : image.animeTags.map(bangumiTagDisplayName).join("、")}
                </span>
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
