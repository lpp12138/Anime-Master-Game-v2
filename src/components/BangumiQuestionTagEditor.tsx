"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  getBangumiSubjectCharacters,
  searchBangumiAnime,
  type BangumiAnimeSearchResult,
  type BangumiSubjectCharacter,
} from "../lib/bangumiClient";
import { bangumiTagDisplayName, MAX_BANGUMI_CHARACTER_TAGS_PER_QUESTION } from "../lib/bangumiTags";
import type { BangumiAnimeTag, BangumiCharacterTag } from "../types/game";

type Props = {
  uploadKey: string;
  animeTag: BangumiAnimeTag | null;
  characterTags: BangumiCharacterTag[];
  disabled?: boolean;
  onChange: (animeTag: BangumiAnimeTag | null, characterTags: BangumiCharacterTag[]) => void;
  onAnswerSuggestion: (answer: string) => void;
};

function matchesCharacter(character: BangumiSubjectCharacter, query: string) {
  if (!query) return true;
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  return `${character.name} ${character.relation ?? ""}`.normalize("NFKC").toLocaleLowerCase().includes(normalized);
}

export function BangumiQuestionTagEditor({
  uploadKey,
  animeTag,
  characterTags,
  disabled = false,
  onChange,
  onAnswerSuggestion,
}: Props) {
  const [animeQuery, setAnimeQuery] = useState("");
  const [animeResults, setAnimeResults] = useState<BangumiAnimeSearchResult[]>([]);
  const [animeSearching, setAnimeSearching] = useState(false);
  const [animeError, setAnimeError] = useState("");
  const [characters, setCharacters] = useState<BangumiSubjectCharacter[] | null>(null);
  const [charactersLoading, setCharactersLoading] = useState(false);
  const [characterLoadAttempt, setCharacterLoadAttempt] = useState(0);
  const [characterQuery, setCharacterQuery] = useState("");
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false);
  const [characterError, setCharacterError] = useState("");
  const [activeCharacterIndex, setActiveCharacterIndex] = useState(-1);
  const characterListId = useId();
  const characterPickerRef = useRef<HTMLDivElement>(null);
  const animeSearchSequenceRef = useRef(0);
  const normalizedUploadKey = uploadKey.trim();

  useEffect(() => {
    animeSearchSequenceRef.current += 1;
    setAnimeQuery("");
    setAnimeResults([]);
    setAnimeError("");
    setAnimeSearching(false);
    setCharacters(null);
    setCharacterQuery("");
    setActiveCharacterIndex(-1);
    setCharacterPickerOpen(false);
    setCharacterError("");
  }, [animeTag?.id]);

  useEffect(() => {
    animeSearchSequenceRef.current += 1;
    setAnimeResults([]);
    setAnimeError("");
    setAnimeSearching(false);
    setCharacters(null);
    setCharacterError("");
    setCharacterPickerOpen(false);
  }, [normalizedUploadKey]);

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
        if (active) setCharacterError(error instanceof Error ? error.message : "角色列表加载失败。");
      })
      .finally(() => {
        if (active) setCharactersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [animeTag, characterLoadAttempt, characterPickerOpen, characters, normalizedUploadKey]);

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
    const query = animeQuery.trim();
    setAnimeResults([]);
    if (query.length < 2) {
      setAnimeError("请输入至少 2 个字符搜索番剧。");
      return;
    }
    if (!normalizedUploadKey) {
      setAnimeError("请先填写上传密钥。");
      return;
    }
    const searchSequence = ++animeSearchSequenceRef.current;
    setAnimeSearching(true);
    setAnimeError("");
    try {
      const results = await searchBangumiAnime(query, normalizedUploadKey);
      if (searchSequence !== animeSearchSequenceRef.current) return;
      setAnimeResults(results);
      if (results.length === 0) setAnimeError("没有找到匹配的动画条目，请尝试日文原名或 Bangumi 标题。");
    } catch (error) {
      if (searchSequence === animeSearchSequenceRef.current) {
        setAnimeError(error instanceof Error ? error.message : "番剧搜索失败。");
      }
    } finally {
      if (searchSequence === animeSearchSequenceRef.current) setAnimeSearching(false);
    }
  }

  function selectAnime(result: BangumiAnimeSearchResult) {
    animeSearchSequenceRef.current += 1;
    const selected: BangumiAnimeTag = { id: result.id, name: result.name, nameCn: result.nameCn };
    onChange(selected, []);
    onAnswerSuggestion(bangumiTagDisplayName(selected));
    setAnimeQuery("");
    setAnimeResults([]);
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
      className="space-y-2 rounded-lg border border-sky-100 bg-sky-50/70 p-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && characterPickerOpen) {
          event.preventDefault();
          event.stopPropagation();
          setCharacterPickerOpen(false);
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-sky-900">Bangumi 番剧 / 角色标签</span>
        <a
          className="text-[11px] text-sky-700 underline decoration-dotted"
          href="https://bangumi.github.io/api/"
          target="_blank"
          rel="noreferrer"
        >
          数据来自 Bangumi API
        </a>
      </div>

      {animeTag ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <a
              className="rounded-full bg-sky-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-800"
              href={`https://bgm.tv/subject/${animeTag.id}`}
              target="_blank"
              rel="noreferrer"
              title={animeTag.name}
            >
              番剧 · {bangumiTagDisplayName(animeTag)} · #{animeTag.id}
            </a>
            <button
              type="button"
              className="text-xs font-medium text-slate-500 underline disabled:opacity-50"
              disabled={disabled}
              onClick={() => onChange(null, [])}
            >
              更换番剧
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {characterTags.map((tag) => (
              <span key={tag.id} className="inline-flex items-center gap-1 rounded-full bg-fuchsia-100 px-2 py-1 text-xs text-fuchsia-900">
                角色 · {bangumiTagDisplayName(tag)}
                <button
                  type="button"
                  className="font-bold text-fuchsia-700 hover:text-fuchsia-950 disabled:opacity-50"
                  aria-label={`移除角色 ${bangumiTagDisplayName(tag)}`}
                  disabled={disabled}
                  onClick={() => onChange(animeTag, characterTags.filter((candidate) => candidate.id !== tag.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          {characterTags.length < MAX_BANGUMI_CHARACTER_TAGS_PER_QUESTION ? (
            <div ref={characterPickerRef} className="relative">
              <input
                aria-activedescendant={characterPickerOpen && filteredCharacters[activeCharacterIndex]
                  ? `${characterListId}-${filteredCharacters[activeCharacterIndex].id}`
                  : undefined}
                aria-autocomplete="list"
                aria-controls={characterListId}
                aria-expanded={characterPickerOpen}
                aria-haspopup="listbox"
                role="combobox"
                className="w-full rounded-md border border-sky-200 bg-white px-3 py-2 text-xs outline-none focus:border-sky-500 disabled:bg-slate-100"
                value={characterQuery}
                disabled={disabled || !normalizedUploadKey || charactersLoading}
                placeholder={!normalizedUploadKey ? "请先填写上传密钥" : charactersLoading ? "正在从 Bangumi 加载角色…" : "搜索并选择画面中出现的角色（可选）"}
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
                  } else if (event.key === "Enter" && characterPickerOpen && filteredCharacters[activeCharacterIndex]) {
                    event.preventDefault();
                    selectCharacter(filteredCharacters[activeCharacterIndex]);
                  }
                }}
              />
              {characterPickerOpen && !charactersLoading ? (
                <div id={characterListId} role="listbox" className="mt-1 max-h-52 overflow-y-auto rounded-md border border-sky-200 bg-white p-1 shadow-lg">
                  {filteredCharacters.length > 0 ? filteredCharacters.map((character) => (
                    <button
                      id={`${characterListId}-${character.id}`}
                      key={character.id}
                      type="button"
                      role="option"
                      aria-selected={filteredCharacters[activeCharacterIndex]?.id === character.id}
                      tabIndex={-1}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-sky-50 disabled:opacity-50"
                      disabled={disabled}
                      onMouseEnter={() => setActiveCharacterIndex(filteredCharacters.indexOf(character))}
                      onClick={() => selectCharacter(character)}
                    >
                      {character.imageUrl ? (
                        <img className="h-8 w-8 shrink-0 rounded object-cover" src={character.imageUrl} alt="" loading="lazy" />
                      ) : <span className="h-8 w-8 shrink-0 rounded bg-slate-100" />}
                      <span className="min-w-0 flex-1 truncate">{character.name}</span>
                      <span className="shrink-0 text-[10px] text-slate-500">{character.relation ?? "角色"}</span>
                    </button>
                  )) : (
                    <p className="px-2 py-3 text-center text-xs text-slate-500">没有匹配的未选角色。</p>
                  )}
                  <button
                    type="button"
                    className="w-full px-2 py-1 text-center text-[11px] text-slate-500 underline"
                    onClick={() => setCharacterPickerOpen(false)}
                  >
                    收起
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-[11px] text-slate-500">已达到每张图片最多 {MAX_BANGUMI_CHARACTER_TAGS_PER_QUESTION} 个角色标签。</p>
          )}
          {characterError ? (
            <p className="flex items-center gap-2 text-xs text-red-700">
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
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-3 py-2 text-xs outline-none focus:border-sky-500 disabled:bg-slate-100"
              value={animeQuery}
              disabled={disabled || animeSearching}
              placeholder="输入番剧中文名或原名"
              onChange={(event) => {
                setAnimeQuery(event.target.value);
                setAnimeResults([]);
                setAnimeError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void runAnimeSearch();
                }
              }}
            />
            <button
              type="button"
              className="rounded-md bg-sky-700 px-3 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
              disabled={disabled || animeSearching}
              onClick={() => void runAnimeSearch()}
            >
              {animeSearching ? "搜索中…" : "搜索番剧"}
            </button>
          </div>
          {animeResults.length > 0 ? (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-sky-200 bg-white p-1 shadow-lg">
              {animeResults.map((result) => (
                <button
                  key={result.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-sky-50"
                  disabled={disabled || animeSearching}
                  onClick={() => selectAnime(result)}
                >
                  {result.imageUrl ? (
                    <img className="h-12 w-9 shrink-0 rounded object-cover" src={result.imageUrl} alt="" loading="lazy" />
                  ) : <span className="h-12 w-9 shrink-0 rounded bg-slate-100" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-slate-900">{result.nameCn || result.name}</span>
                    {result.nameCn ? <span className="block truncate text-[10px] text-slate-500">{result.name}</span> : null}
                    <span className="block text-[10px] text-slate-500">#{result.id}{result.date ? ` · ${result.date}` : ""}{result.score ? ` · ${result.score.toFixed(1)} 分` : ""}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {animeError ? <p className="text-xs text-red-700">{animeError}</p> : null}
        </div>
      )}
      <p className="text-[11px] leading-5 text-slate-500">番剧标签来自官方条目；角色只添加画面中确实出现的人物，避免把整部番剧的角色误标到图片。</p>
    </div>
  );
}
