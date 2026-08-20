"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  getBangumiSubjectCharacters,
  searchBangumiAnime,
  type BangumiAnimeSearchResult,
  type BangumiSubjectCharacter,
} from "../lib/bangumiClient";
import { bangumiTagDisplayName, MAX_BANGUMI_CHARACTER_TAGS_PER_QUESTION } from "../lib/bangumiTags";
import type { BangumiAnimeTag, BangumiCharacterTag, BangumiSubjectScope } from "../types/game";

type Props = {
  uploadKey: string;
  answer: string;
  animeTag: BangumiAnimeTag | null;
  characterTags: BangumiCharacterTag[];
  disabled?: boolean;
  onAnswerChange: (answer: string) => void;
  onChange: (animeTag: BangumiAnimeTag | null, characterTags: BangumiCharacterTag[]) => void;
};

function matchesCharacter(character: BangumiSubjectCharacter, query: string) {
  if (!query) return true;
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  return `${character.name} ${character.relation ?? ""}`.normalize("NFKC").toLocaleLowerCase().includes(normalized);
}

const SUBJECT_SCOPE_OPTIONS: Array<{ value: BangumiSubjectScope; label: string }> = [
  { value: "anime", label: "动画" },
  { value: "game", label: "游戏" },
  { value: "all", label: "全部" },
];

function subjectTypeLabel(subjectType: 2 | 4 | null | undefined): string {
  return subjectType === 4 ? "游戏" : subjectType === 2 ? "动画" : "作品";
}

export function BangumiQuestionTagEditor({
  uploadKey,
  answer,
  animeTag,
  characterTags,
  disabled = false,
  onAnswerChange,
  onChange,
}: Props) {
  const [animeResults, setAnimeResults] = useState<BangumiAnimeSearchResult[]>([]);
  const [subjectScope, setSubjectScope] = useState<BangumiSubjectScope>(() => (
    animeTag?.subjectType === 4 ? "game" : animeTag?.subjectType === 2 ? "anime" : "all"
  ));
  const [animeSearching, setAnimeSearching] = useState(false);
  const [animeError, setAnimeError] = useState("");
  const [activeAnimeIndex, setActiveAnimeIndex] = useState(-1);
  const [animeResultsOpen, setAnimeResultsOpen] = useState(false);
  const [characters, setCharacters] = useState<BangumiSubjectCharacter[] | null>(null);
  const [charactersLoading, setCharactersLoading] = useState(false);
  const [characterLoadAttempt, setCharacterLoadAttempt] = useState(0);
  const [characterQuery, setCharacterQuery] = useState("");
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false);
  const [characterError, setCharacterError] = useState("");
  const [activeCharacterIndex, setActiveCharacterIndex] = useState(-1);
  const animeListId = useId();
  const characterListId = useId();
  const characterPickerRef = useRef<HTMLDivElement>(null);
  const animeSearchSequenceRef = useRef(0);
  const animeSearchAbortRef = useRef<AbortController | null>(null);
  const normalizedUploadKey = uploadKey.trim();

  useEffect(() => {
    animeSearchSequenceRef.current += 1;
    animeSearchAbortRef.current?.abort();
    animeSearchAbortRef.current = null;
    setAnimeResults([]);
    setAnimeError("");
    setAnimeSearching(false);
    setActiveAnimeIndex(-1);
    setAnimeResultsOpen(false);
  }, [answer, normalizedUploadKey, subjectScope]);

  useEffect(() => () => animeSearchAbortRef.current?.abort(), []);

  useEffect(() => {
    setCharacters(null);
    setCharactersLoading(false);
    setCharacterQuery("");
    setActiveCharacterIndex(-1);
    setCharacterPickerOpen(false);
    setCharacterError("");
  }, [animeTag?.id, normalizedUploadKey]);

  useEffect(() => {
    if (!animeTag || !normalizedUploadKey || !characterPickerOpen || characters !== null) return;
    let active = true;
    setCharactersLoading(true);
    setCharacterError("");
    getBangumiSubjectCharacters(animeTag.id, normalizedUploadKey)
      .then((next) => {
        if (active) setCharacters(next);
      })
      .catch((error) => {
        if (active) setCharacterError(error instanceof Error ? error.message : "Bangumi 角色列表加载失败。");
      })
      .finally(() => {
        if (active) setCharactersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [animeTag?.id, characterLoadAttempt, characterPickerOpen, characters, normalizedUploadKey]);

  useEffect(() => {
    if (!characterPickerOpen) return;
    const closeWhenOutside = (event: Event) => {
      if (event.target instanceof Node && !characterPickerRef.current?.contains(event.target)) {
        setCharacterPickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("focusin", closeWhenOutside);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("focusin", closeWhenOutside);
    };
  }, [characterPickerOpen]);

  const filteredCharacters = useMemo(() => {
    const selectedIds = new Set(characterTags.map((tag) => tag.id));
    return (characters ?? [])
      .filter((character) => !selectedIds.has(character.id) && matchesCharacter(character, characterQuery.trim()))
      .slice(0, 50);
  }, [characterQuery, characterTags, characters]);

  async function runAnimeSearch() {
    const query = answer.trim();
    setAnimeResults([]);
    setAnimeResultsOpen(false);
    setActiveAnimeIndex(-1);
    if (query.length < 2) {
      setAnimeError("请先输入至少 2 个字符作为正确答案或 Bangumi 搜索词。");
      return;
    }
    if (!normalizedUploadKey) {
      setAnimeError("请先填写上传密钥。");
      return;
    }
    const searchSequence = ++animeSearchSequenceRef.current;
    const controller = new AbortController();
    animeSearchAbortRef.current?.abort();
    animeSearchAbortRef.current = controller;
    setAnimeSearching(true);
    setAnimeError("");
    try {
      const results = await searchBangumiAnime(query, normalizedUploadKey, subjectScope, controller.signal);
      if (searchSequence !== animeSearchSequenceRef.current) return;
      setAnimeResults(results);
      setActiveAnimeIndex(results.length > 0 ? 0 : -1);
      setAnimeResultsOpen(results.length > 0);
      if (results.length === 0) setAnimeError("Bangumi 中没有找到匹配的条目，请尝试中文名、日文原名或作品名。");
    } catch (error) {
      if (searchSequence === animeSearchSequenceRef.current && !controller.signal.aborted) {
        setAnimeError(error instanceof Error ? error.message : "Bangumi 作品搜索失败。");
      }
    } finally {
      if (animeSearchAbortRef.current === controller) animeSearchAbortRef.current = null;
      if (searchSequence === animeSearchSequenceRef.current) setAnimeSearching(false);
    }
  }

  function selectAnime(result: BangumiAnimeSearchResult) {
    animeSearchSequenceRef.current += 1;
    animeSearchAbortRef.current?.abort();
    animeSearchAbortRef.current = null;
    const selected: BangumiAnimeTag = {
      id: result.id,
      name: result.name,
      nameCn: result.nameCn,
      subjectType: result.subjectType ?? 2,
    };
    onChange(selected, []);
    setAnimeResults([]);
    setAnimeResultsOpen(false);
    setActiveAnimeIndex(-1);
    setAnimeError("");
    setCharacterQuery("");
  }

  function selectCharacter(character: BangumiSubjectCharacter) {
    if (!animeTag || characterTags.length >= MAX_BANGUMI_CHARACTER_TAGS_PER_QUESTION) return;
    onChange(animeTag, [
      ...characterTags,
      {
        id: character.id,
        subjectId: animeTag.id,
        name: character.name,
        nameCn: null,
        relation: character.relation,
      },
    ]);
    setCharacterQuery("");
    setActiveCharacterIndex(-1);
    setCharacterPickerOpen(false);
  }

  return (
    <div
      className="space-y-4"
      onKeyDown={(event) => {
        if (event.key === "Escape" && characterPickerOpen) {
          event.preventDefault();
          event.stopPropagation();
          setCharacterPickerOpen(false);
        }
      }}
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-sm font-semibold text-slate-900" htmlFor={`${animeListId}-answer`}>
            正确答案 / Bangumi 作品搜索（动画/游戏） <span className="text-rose-600">*</span>
          </label>
          <a
            className="text-xs text-sky-700 underline decoration-dotted"
            href="https://bangumi.github.io/api/"
            target="_blank"
            rel="noreferrer"
          >
            Bangumi API 文档
          </a>
        </div>
        <div className="flex w-full items-center gap-1 rounded-md border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label="Bangumi 搜索范围">
          {SUBJECT_SCOPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={subjectScope === option.value}
              disabled={disabled}
              className={`flex-1 rounded px-2 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${subjectScope === option.value ? "bg-sky-700 text-white" : "text-slate-600 hover:bg-slate-100"}`}
              onClick={() => setSubjectScope(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <input
          id={`${animeListId}-answer`}
          aria-activedescendant={animeResultsOpen && animeResults[activeAnimeIndex]
            ? `${animeListId}-${animeResults[activeAnimeIndex].id}`
            : undefined}
          aria-autocomplete="list"
          aria-controls={animeListId}
          aria-expanded={animeResultsOpen}
          aria-haspopup="listbox"
          role="combobox"
          className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2.5 text-sm outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100 disabled:bg-slate-100"
          value={answer}
          disabled={disabled}
          maxLength={100}
          placeholder="输入正确答案，再搜索并关联 Bangumi 作品（动画/游戏）"
          onChange={(event) => onAnswerChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && animeResults.length > 0) {
              event.preventDefault();
              setAnimeResultsOpen(true);
              setActiveAnimeIndex((current) => (current + 1) % animeResults.length);
            } else if (event.key === "ArrowUp" && animeResults.length > 0) {
              event.preventDefault();
              setAnimeResultsOpen(true);
              setActiveAnimeIndex((current) => current <= 0 ? animeResults.length - 1 : current - 1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (animeResultsOpen && animeResults[activeAnimeIndex]) selectAnime(animeResults[activeAnimeIndex]);
              else void runAnimeSearch();
            } else if (event.key === "Escape" && animeResultsOpen) {
              event.preventDefault();
              setAnimeResultsOpen(false);
            }
          }}
        />
        <button
          type="button"
          className="w-full rounded-md bg-sky-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
          disabled={disabled || animeSearching}
          onClick={() => void runAnimeSearch()}
        >
          {animeSearching ? "搜索中…" : "搜索 Bangumi"}
        </button>

        {animeTag ? (
          <div className="flex flex-wrap items-center gap-2">
            <a
              className="max-w-full break-all rounded-full bg-sky-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-800"
              href={`https://bgm.tv/subject/${animeTag.id}`}
              target="_blank"
              rel="noreferrer"
              title={animeTag.name}
            >
              Bangumi · {subjectTypeLabel(animeTag.subjectType)} · {bangumiTagDisplayName(animeTag)} · #{animeTag.id}
            </a>
            <button
              type="button"
              className="text-xs font-medium text-slate-500 underline disabled:opacity-50"
              disabled={disabled}
              onClick={() => onChange(null, [])}
            >
              移除作品标签
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500">答案可以单独保存；选择搜索结果后会同时加入规范 Bangumi 作品（动画/游戏）标签。</p>
        )}

        {animeResultsOpen && animeResults.length > 0 ? (
          <div id={animeListId} role="listbox" aria-label="Bangumi 作品搜索结果" className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-sky-200 bg-white p-1 shadow-lg">
            {animeResults.map((result, index) => (
              <button
                id={`${animeListId}-${result.id}`}
                key={result.id}
                type="button"
                role="option"
                aria-selected={activeAnimeIndex === index}
                tabIndex={-1}
                className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left ${activeAnimeIndex === index ? "bg-sky-100" : "hover:bg-sky-50"}`}
                disabled={disabled || animeSearching}
                onMouseEnter={() => setActiveAnimeIndex(index)}
                onClick={() => selectAnime(result)}
              >
                {result.imageUrl ? (
                  <img className="h-14 w-10 shrink-0 rounded object-cover" src={result.imageUrl} alt="" loading="lazy" />
                ) : <span className="h-14 w-10 shrink-0 rounded bg-slate-100" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">{result.nameCn || result.name}</span>
                  {result.nameCn ? <span className="block truncate text-xs text-slate-500">{result.name}</span> : null}
                  <span className="block text-[11px] text-slate-500">#{result.id} · {subjectTypeLabel(result.subjectType)}{result.date ? ` · ${result.date}` : ""}{result.score ? ` · ${result.score.toFixed(1)} 分` : ""}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {animeError ? <p className="text-xs text-red-700" role="alert">{animeError}</p> : null}
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-4">
        <label className="text-sm font-semibold text-slate-900" htmlFor={`${characterListId}-query`}>
          角色名（可选）
        </label>
        <p className="text-xs leading-5 text-slate-500">
          先选择作品，再从该作品的官方 Bangumi 角色列表搜索并添加画面中实际出现的角色。
        </p>

        <div className="flex flex-wrap gap-1.5">
          {characterTags.map((tag) => (
            <span key={tag.id} className="inline-flex items-center gap-1 rounded-full bg-fuchsia-100 px-2 py-1 text-xs text-fuchsia-900">
              {bangumiTagDisplayName(tag)}{tag.relation ? ` · ${tag.relation}` : ""}
              <button
                type="button"
                className="font-bold text-fuchsia-700 hover:text-fuchsia-950 disabled:opacity-50"
                aria-label={`移除角色 ${bangumiTagDisplayName(tag)}`}
                disabled={disabled}
                onClick={() => animeTag && onChange(animeTag, characterTags.filter((candidate) => candidate.id !== tag.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>

        {characterTags.length < MAX_BANGUMI_CHARACTER_TAGS_PER_QUESTION ? (
          <div ref={characterPickerRef} className="relative">
            <input
              id={`${characterListId}-query`}
              aria-activedescendant={characterPickerOpen && filteredCharacters[activeCharacterIndex]
                ? `${characterListId}-${filteredCharacters[activeCharacterIndex].id}`
                : undefined}
              aria-autocomplete="list"
              aria-controls={characterListId}
              aria-expanded={characterPickerOpen && !charactersLoading}
              aria-haspopup="listbox"
              role="combobox"
              className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2.5 text-sm outline-none transition focus:border-fuchsia-500 focus:ring-4 focus:ring-fuchsia-100 disabled:bg-slate-100"
              value={characterQuery}
              disabled={disabled || !animeTag || !normalizedUploadKey}
              placeholder={!animeTag
                ? "请先通过上方搜索选择 Bangumi 作品"
                : !normalizedUploadKey
                  ? "请先填写上传密钥"
                  : charactersLoading ? "正在加载 Bangumi 角色列表…" : "输入角色名搜索并添加"}
              onFocus={() => setCharacterPickerOpen(true)}
              onChange={(event) => {
                setCharacterQuery(event.target.value);
                setActiveCharacterIndex(-1);
                setCharacterPickerOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && filteredCharacters.length > 0) {
                  event.preventDefault();
                  setCharacterPickerOpen(true);
                  setActiveCharacterIndex((current) => (current + 1) % filteredCharacters.length);
                } else if (event.key === "ArrowUp" && filteredCharacters.length > 0) {
                  event.preventDefault();
                  setCharacterPickerOpen(true);
                  setActiveCharacterIndex((current) => current <= 0 ? filteredCharacters.length - 1 : current - 1);
                } else if (event.key === "Enter") {
                  // Character search is never a form-submit action. Select the
                  // active option when available; otherwise keep the draft open.
                  event.preventDefault();
                  if (characterPickerOpen && filteredCharacters[activeCharacterIndex]) {
                    selectCharacter(filteredCharacters[activeCharacterIndex]);
                  }
                }
              }}
            />
            {characterPickerOpen && !charactersLoading ? (
              <div id={characterListId} role="listbox" aria-label="Bangumi 角色搜索结果" className="absolute z-40 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-fuchsia-200 bg-white p-1 shadow-xl">
                {filteredCharacters.length > 0 ? filteredCharacters.map((character, index) => (
                  <button
                    id={`${characterListId}-${character.id}`}
                    key={character.id}
                    type="button"
                    role="option"
                    aria-selected={activeCharacterIndex === index}
                    tabIndex={-1}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${activeCharacterIndex === index ? "bg-fuchsia-50" : "hover:bg-fuchsia-50"}`}
                    disabled={disabled}
                    onMouseEnter={() => setActiveCharacterIndex(index)}
                    onClick={() => selectCharacter(character)}
                  >
                    {character.imageUrl ? (
                      <img className="h-9 w-9 shrink-0 rounded object-cover" src={character.imageUrl} alt="" loading="lazy" />
                    ) : <span className="h-9 w-9 shrink-0 rounded bg-slate-100" />}
                    <span className="min-w-0 flex-1 truncate">{character.name}</span>
                    <span className="shrink-0 text-[10px] text-slate-500">{character.relation ?? "角色"}</span>
                  </button>
                )) : (
                  <p className="px-2 py-3 text-center text-xs text-slate-500">没有匹配的未选角色。</p>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-slate-500">已达到每张图片最多 {MAX_BANGUMI_CHARACTER_TAGS_PER_QUESTION} 个角色标签。</p>
        )}

        {characterError ? (
          <p className="flex items-center gap-2 text-xs text-red-700" role="alert">
            <span>{characterError}</span>
            <button
              className="underline disabled:opacity-50"
              disabled={disabled || charactersLoading}
              type="button"
              onClick={() => {
                setCharacters(null);
                setCharacterError("");
                setCharacterPickerOpen(true);
                setCharacterLoadAttempt((current) => current + 1);
              }}
            >重试</button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
