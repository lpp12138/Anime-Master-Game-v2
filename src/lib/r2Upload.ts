"use client";

import { isR2ImageUploadTooLarge, R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE } from "./r2UploadPolicy";
import type { FailedQuestionUrlImport, PreparedQuestionUrlImport, QuestionUrlImportInput } from "../types/game";

export type UploadableImage = {
  file: File;
  path: string;
  name: string;
  size: number;
  type: string;
};

export type UploadSourceFile = {
  file: File;
  path: string;
};

export type DroppedUploadFiles = {
  files: UploadSourceFile[];
  skippedDirectoryCount: number;
};

type BrowserFileSystemEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
};

type BrowserFileSystemFileEntry = BrowserFileSystemEntry & {
  isFile: true;
  file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
};

type BrowserFileSystemDirectoryReader = {
  readEntries: (
    success: (entries: BrowserFileSystemEntry[]) => void,
    failure?: (error: DOMException) => void,
  ) => void;
};

type BrowserFileSystemDirectoryEntry = BrowserFileSystemEntry & {
  isDirectory: true;
  createReader: () => BrowserFileSystemDirectoryReader;
};

export type R2UploadResult = {
  ok: true;
  path: string;
  url: string;
  r2Key: string;
  publicId: string;
  rawBytes: number;
  uploadBytes: number;
  usedOriginal: boolean;
};

export type R2UploadFailure = {
  ok: false;
  path: string;
  error: string;
  rawBytes: number;
};

export type R2UploadItemResult = R2UploadResult | R2UploadFailure;

export type LocalUploadDraftQuestion = {
  key: string;
  imageUrl: string;
  labelText: string | null;
  isR18: boolean;
};

export type LocalUploadDropCardRect = {
  key: string;
  index: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type LocalUploadDropTarget = {
  insertionIndex: number;
  cardKey: string;
  side: "before" | "after";
};

export function buildPreparedUrlImportDraft(
  questions: Array<{ imageUrl: string; labelText?: string | null; isR18?: boolean; r2Key?: string | null }>,
): LocalUploadDraftQuestion[] {
  return questions.map((question, index) => ({
    key: `url-import:${index}:${question.r2Key ?? question.imageUrl}`,
    imageUrl: question.imageUrl,
    labelText: question.labelText?.trim() || null,
    isR18: question.isR18 === true,
  }));
}

type PreparedImage = {
  blob: Blob;
  uploadName: string;
  rawBytes: number;
  uploadBytes: number;
  usedOriginal: boolean;
};

type RemoteImportDependencies = {
  fetchSource?: (input: QuestionUrlImportInput) => Promise<{ blob: Blob; name: string }>;
  prepare?: (source: { blob: Blob; name: string }) => Promise<PreparedImage>;
  upload?: (prepared: PreparedImage) => Promise<{ key: string; url: string; publicId: string }>;
  concurrency?: number;
};

export type RemoteImageImportResult = {
  preparedQuestions: PreparedQuestionUrlImport[];
  failedQuestions: FailedQuestionUrlImport[];
};

export type UploadProgress = {
  done: number;
  total: number;
  success: number;
  fail: number;
  rawBytes: number;
  uploadBytes: number;
  latestMessage: string;
};

const clientEnv = (import.meta as ImportMeta & { env?: ImportMetaEnv }).env ?? {} as ImportMetaEnv;

const r2UploadConfig = {
  maxSize: Number(clientEnv.NEXT_PUBLIC_UPLOAD_IMAGE_MAX_SIZE ?? 1600),
  quality: Number(clientEnv.NEXT_PUBLIC_UPLOAD_IMAGE_QUALITY ?? 0.78),
  format: clientEnv.NEXT_PUBLIC_UPLOAD_IMAGE_FORMAT ?? "image/webp",
  concurrency: Number(clientEnv.NEXT_PUBLIC_R2_UPLOAD_CONCURRENCY ?? 2),
};

function apiBase() {
  return (clientEnv.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
}

function apiUrl(path: string) {
  return `${apiBase()}${path}`;
}

export function getR2UploadConfigStatus() {
  return {
    isReady: true,
    maxSize: r2UploadConfig.maxSize,
    quality: r2UploadConfig.quality,
    format: r2UploadConfig.format,
  };
}

export function toUploadSourceFiles(fileList: FileList | File[]) {
  return Array.from(fileList).map((file) => ({
    file,
    path: getPath(file),
  }));
}

export function filesToUploadableImages(sourceFiles: UploadSourceFile[]) {
  const seen = new Set<string>();

  return sourceFiles
    .filter(({ file }) => isImageFile(file))
    .map(({ file, path }) => ({
      file,
      path,
      name: file.name,
      size: file.size,
      type: file.type || guessMime(file.name),
    }))
    .filter((item) => {
      if (seen.has(item.path)) {
        return false;
      }

      seen.add(item.path);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function extractCreationToolLabelFromFilename(filename: string) {
  const basename = filename.replace(/^.*[\\/]/, "");
  const match = basename.match(/^\d+-(.+)-mosaic\.(?:jpe?g|png|webp|gif|avif)$/i);
  const label = match?.[1].trim() ?? "";
  return label || null;
}

export function getLocalUploadCreationMethod(labelTexts: Array<string | null>) {
  return labelTexts.length > 0 && labelTexts.every((labelText) => Boolean(labelText?.trim()))
    ? "creation_tool_assisted" as const
    : "player_manual" as const;
}

export function buildLocalUploadQuestionImport(
  items: UploadableImage[],
  uploadResults: R2UploadItemResult[],
) {
  const itemByPath = new Map(items.map((item) => [item.path, item]));
  const questions = uploadResults
    .filter((result): result is R2UploadResult => result.ok)
    .map((result) => ({
      key: result.path,
      imageUrl: result.url,
      labelText: extractCreationToolLabelFromFilename(itemByPath.get(result.path)?.name ?? ""),
      isR18: false,
    }));

  return {
    questions,
    creationMethod: getLocalUploadCreationMethod(questions.map((question) => question.labelText)),
  };
}

export function moveLocalUploadDraftQuestionToIndex(
  questions: LocalUploadDraftQuestion[],
  sourceKey: string,
  insertionIndex: number,
) {
  const sourceIndex = questions.findIndex((question) => question.key === sourceKey);

  if (sourceIndex < 0 || !Number.isInteger(insertionIndex)) {
    return questions;
  }

  const boundedInsertionIndex = Math.max(0, Math.min(insertionIndex, questions.length));
  const targetIndex = boundedInsertionIndex > sourceIndex ? boundedInsertionIndex - 1 : boundedInsertionIndex;
  if (sourceIndex === targetIndex) {
    return questions;
  }

  const nextQuestions = questions.slice();
  const [movedQuestion] = nextQuestions.splice(sourceIndex, 1);
  nextQuestions.splice(targetIndex, 0, movedQuestion);
  return nextQuestions;
}

export function findNearestLocalUploadDropTarget(
  pointerX: number,
  pointerY: number,
  cardRects: LocalUploadDropCardRect[],
): LocalUploadDropTarget | null {
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) {
    return null;
  }

  const cards = cardRects
    .filter((card) => Number.isInteger(card.index) && [card.left, card.right, card.top, card.bottom].every(Number.isFinite))
    .slice()
    .sort((a, b) => a.index - b.index);
  if (cards.length === 0) {
    return null;
  }

  const rows: Array<{ top: number; bottom: number; cards: LocalUploadDropCardRect[] }> = [];
  for (const card of cards) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(card.top - row.top) <= 4) {
      row.top = Math.min(row.top, card.top);
      row.bottom = Math.max(row.bottom, card.bottom);
      row.cards.push(card);
    } else {
      rows.push({ top: card.top, bottom: card.bottom, cards: [card] });
    }
  }

  let selectedRow = rows[0];
  let selectedRowDistance = verticalDistanceToRange(pointerY, selectedRow.top, selectedRow.bottom);
  for (const row of rows.slice(1)) {
    const distance = verticalDistanceToRange(pointerY, row.top, row.bottom);
    if (distance < selectedRowDistance || (distance === selectedRowDistance && row.top > selectedRow.top)) {
      selectedRow = row;
      selectedRowDistance = distance;
    }
  }

  let target: LocalUploadDropTarget | null = null;
  let targetDistance = Number.POSITIVE_INFINITY;
  for (const card of selectedRow.cards) {
    for (const candidate of [
      { insertionIndex: card.index, cardKey: card.key, side: "before" as const, edgeX: card.left },
      { insertionIndex: card.index + 1, cardKey: card.key, side: "after" as const, edgeX: card.right },
    ]) {
      const distance = Math.abs(pointerX - candidate.edgeX);
      if (distance < targetDistance) {
        target = {
          insertionIndex: candidate.insertionIndex,
          cardKey: candidate.cardKey,
          side: candidate.side,
        };
        targetDistance = distance;
      }
    }
  }

  return target;
}

function verticalDistanceToRange(value: number, start: number, end: number) {
  if (value < start) return start - value;
  if (value > end) return value - end;
  return 0;
}

export function removeLocalUploadDraftQuestion(
  questions: LocalUploadDraftQuestion[],
  questionKey: string,
) {
  return questions.filter((question) => question.key !== questionKey);
}

export async function readDroppedUploadFiles(dataTransfer: DataTransfer): Promise<DroppedUploadFiles> {
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === "file");
  const droppedItems = items.map((item) => {
    const candidate = item as unknown as { webkitGetAsEntry?: () => BrowserFileSystemEntry | null };
    const supportsEntry = typeof candidate.webkitGetAsEntry === "function";
    return {
      entry: supportsEntry ? candidate.webkitGetAsEntry?.() ?? null : null,
      fallbackFile: item.getAsFile(),
      supportsEntry,
    };
  });
  const supportsEntries = droppedItems.some((item) => item.supportsEntry);

  if (!supportsEntries) {
    return {
      files: toUploadSourceFiles(dataTransfer.files),
      skippedDirectoryCount: 0,
    };
  }

  const files: UploadSourceFile[] = [];
  let skippedDirectoryCount = 0;

  for (const droppedItem of droppedItems) {
    const entry = droppedItem.entry;

    if (!entry) {
      const file = droppedItem.fallbackFile;
      if (file) {
        files.push({ file, path: getPath(file) });
      }
      continue;
    }

    if (entry.isFile) {
      const file = await readFileEntry(entry as BrowserFileSystemFileEntry);
      files.push({ file, path: normalizeDroppedPath(entry.fullPath || file.name) });
      continue;
    }

    if (entry.isDirectory) {
      const directoryEntries = await readAllDirectoryEntries(entry as BrowserFileSystemDirectoryEntry);
      for (const child of directoryEntries) {
        if (child.isFile) {
          const file = await readFileEntry(child as BrowserFileSystemFileEntry);
          files.push({
            file,
            path: normalizeDroppedPath(child.fullPath || `${entry.name}/${file.name}`),
          });
        } else if (child.isDirectory) {
          skippedDirectoryCount += 1;
        }
      }
    }
  }

  return { files, skippedDirectoryCount };
}

export async function uploadImagesToR2(
  items: UploadableImage[],
  onProgress: (progress: UploadProgress) => void,
) {
  const results: R2UploadItemResult[] = [];
  const total = items.length;
  const limit = Math.max(1, Math.min(6, r2UploadConfig.concurrency || 2));
  let done = 0;
  let success = 0;
  let fail = 0;
  let rawBytes = 0;
  let uploadBytes = 0;

  await runPool(items, limit, async (item) => {
    try {
      const prepared = await compressImage(item);
      if (isR2ImageUploadTooLarge(prepared.uploadBytes)) {
        throw new Error(R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE);
      }
      rawBytes += prepared.rawBytes;
      uploadBytes += prepared.uploadBytes;

      const uploaded = await uploadPreparedFile(prepared);

      results.push({
        ok: true,
        path: item.path,
        url: uploaded.url,
        r2Key: uploaded.key,
        publicId: uploaded.publicId,
        rawBytes: prepared.rawBytes,
        uploadBytes: prepared.uploadBytes,
        usedOriginal: prepared.usedOriginal,
      });
      success += 1;
      onProgress({ done, total, success, fail, rawBytes, uploadBytes, latestMessage: `上传成功：${item.path}` });
    } catch (error) {
      rawBytes += item.size;
      fail += 1;
      results.push({
        ok: false,
        path: item.path,
        rawBytes: item.size,
        error: error instanceof Error ? error.message : String(error),
      });
      onProgress({ done, total, success, fail, rawBytes, uploadBytes, latestMessage: `上传失败：${item.path}` });
    } finally {
      done += 1;
      onProgress({ done, total, success, fail, rawBytes, uploadBytes, latestMessage: `已完成 ${done}/${total}` });
    }
  });

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function remoteFileName(rawUrl: string, contentType: string) {
  try {
    const url = new URL(rawUrl);
    const lastSegment = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "image");
    if (/\.[a-z0-9]{1,8}$/i.test(lastSegment)) return lastSegment;
    return `${lastSegment || "image"}${extensionForMime(contentType, "image.jpg")}`;
  } catch {
    return `image${extensionForMime(contentType, "image.jpg")}`;
  }
}

async function readRemoteResponse(response: Response, imageUrl: string) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `下载远端图片失败，状态码 ${response.status}。`);
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/") || contentType === "image/svg+xml") throw new Error("远端返回的不是受支持的位图图片。");
  const maxBytes = 20 * 1024 * 1024;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("远端原图不能超过 20 MB。");
  if (!response.body) throw new Error("远端图片内容为空。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("远端原图不能超过 20 MB。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) throw new Error("远端图片内容为空。");
  const blob = new Blob(chunks as BlobPart[], { type: contentType });
  return { blob, name: remoteFileName(imageUrl, contentType) };
}

async function fetchRemoteSource(input: QuestionUrlImportInput, roomId: string, presenterPlayerId: string) {
  const response = await fetch(apiUrl("/api/remote-image-source"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId, presenterPlayerId, imageUrl: input.imageUrl }),
  });
  return await readRemoteResponse(response, input.imageUrl);
}

function defaultRemoteImportConcurrency() {
  if (typeof navigator === "undefined") return 1;
  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigatorWithMemory.deviceMemory ?? 8) <= 4
    ? 1
    : 2;
}

export async function uploadRemoteImagesToR2(
  inputs: QuestionUrlImportInput[],
  roomId: string,
  presenterPlayerId: string,
  onProgress: (progress: UploadProgress) => void,
  dependencies: RemoteImportDependencies = {},
): Promise<RemoteImageImportResult> {
  const preparedQuestions: PreparedQuestionUrlImport[] = [];
  const failedQuestions: FailedQuestionUrlImport[] = [];
  const fetchSource = dependencies.fetchSource ?? ((input) => fetchRemoteSource(input, roomId, presenterPlayerId));
  const prepare = dependencies.prepare ?? ((source) => compressImage({
    file: source.blob as File,
    path: source.name,
    name: source.name,
    size: source.blob.size,
    type: source.blob.type,
  }));
  const upload = dependencies.upload ?? uploadPreparedFile;
  const limit = Math.max(1, Math.min(2, dependencies.concurrency ?? defaultRemoteImportConcurrency()));
  let done = 0;
  let success = 0;
  let fail = 0;
  let rawBytes = 0;
  let uploadBytes = 0;

  await runPool(inputs, limit, async (input) => {
    try {
      onProgress({ done, total: inputs.length, success, fail, rawBytes, uploadBytes, latestMessage: `正在下载第 ${input.orderIndex + 1} 张图片` });
      const source = await fetchSource(input);
      const prepared = await prepare(source);
      if (isR2ImageUploadTooLarge(prepared.uploadBytes)) throw new Error(R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE);
      const uploaded = await upload(prepared);
      rawBytes += prepared.rawBytes;
      uploadBytes += prepared.uploadBytes;
      success += 1;
      preparedQuestions.push({
        ...input,
        imageUrl: uploaded.url,
        originalImageUrl: input.imageUrl,
        r2Key: uploaded.key,
        rawBytes: prepared.rawBytes,
        uploadBytes: prepared.uploadBytes,
        usedOriginal: prepared.usedOriginal,
      });
    } catch (error) {
      fail += 1;
      failedQuestions.push({ ...input, error: error instanceof Error ? error.message : String(error) });
    } finally {
      done += 1;
      onProgress({ done, total: inputs.length, success, fail, rawBytes, uploadBytes, latestMessage: `已完成 ${done}/${inputs.length}` });
    }
  });

  return {
    preparedQuestions: preparedQuestions.sort((a, b) => a.orderIndex - b.orderIndex),
    failedQuestions: failedQuestions.sort((a, b) => a.orderIndex - b.orderIndex),
  };
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|avif)$/i.test(file.name);
}

function getPath(file: File) {
  return file.webkitRelativePath || file.name;
}

function normalizeDroppedPath(path: string) {
  return path.replace(/^[\\/]+/, "");
}

function readFileEntry(entry: BrowserFileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function readAllDirectoryEntries(entry: BrowserFileSystemDirectoryEntry) {
  const reader = entry.createReader();
  const entries: BrowserFileSystemEntry[] = [];

  while (true) {
    const batch = await new Promise<BrowserFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });

    if (batch.length === 0) {
      return entries;
    }

    entries.push(...batch);
  }
}

function guessMime(name: string) {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".webp")) return "image/webp";
  if (lowerName.endsWith(".gif")) return "image/gif";
  if (lowerName.endsWith(".avif")) return "image/avif";
  return "application/octet-stream";
}

async function compressImage(item: UploadableImage): Promise<PreparedImage> {
  if ((item.type || "").includes("gif") || item.name.toLowerCase().endsWith(".gif")) {
    return {
      blob: item.file,
      uploadName: item.name,
      rawBytes: item.size,
      uploadBytes: item.size,
      usedOriginal: true,
    };
  }

  const targetMime = r2UploadConfig.format || "image/webp";
  const quality = Math.max(0.1, Math.min(1, r2UploadConfig.quality || 0.78));
  const maxSize = Math.max(100, r2UploadConfig.maxSize || 1600);
  const image = await loadImageFromBlob(item.file);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  if (!width || !height) {
    image.src = "";
    throw new Error("无法读取图片尺寸。");
  }

  const scale = Math.min(1, maxSize / width, maxSize / height);
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  const context = canvas.getContext("2d", { alpha: targetMime === "image/png" || targetMime === "image/webp" });
  if (!context) {
    image.src = "";
    canvas.width = 0;
    canvas.height = 0;
    throw new Error("浏览器无法创建图片压缩画布。");
  }

  try {
    context.drawImage(image, 0, 0, outputWidth, outputHeight);

    let blob: Blob;
    try {
      blob = await canvasToBlob(canvas, targetMime, quality);
    } catch (error) {
      if (targetMime !== "image/webp") {
        throw error;
      }

      blob = await canvasToBlob(canvas, "image/jpeg", quality);
    }

    if (blob.size >= item.size) {
      return {
        blob: item.file,
        uploadName: item.name,
        rawBytes: item.size,
        uploadBytes: item.size,
        usedOriginal: true,
      };
    }

    return {
      blob,
      uploadName: replaceExtension(item.name, extensionForMime(blob.type || targetMime, item.name)),
      rawBytes: item.size,
      uploadBytes: blob.size,
      usedOriginal: false,
    };
  } finally {
    image.src = "";
    canvas.width = 0;
    canvas.height = 0;
  }
}

function loadImageFromBlob(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败。"));
    };

    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("浏览器不支持该图片格式的 Canvas 编码。"));
          return;
        }

        resolve(blob);
      },
      mime,
      quality,
    );
  });
}

function extensionForMime(mime: string, originalName: string) {
  if (mime === "image/webp") return ".webp";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  return originalName.match(/\.[^.]+$/)?.[0] || ".jpg";
}

function replaceExtension(name: string, extension: string) {
  return name.replace(/\.[^.]+$/, "") + extension;
}

async function uploadPreparedFile(prepared: PreparedImage) {
  const endpoint = apiUrl(`/api/r2-upload?filename=${encodeURIComponent(prepared.uploadName)}`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": prepared.blob.type || "application/octet-stream",
    },
    body: prepared.blob,
  });
  const data = (await response.json().catch(() => ({}))) as {
    key?: string;
    url?: string;
    publicId?: string;
    error?: string;
  };

  if (!response.ok) {
    throw new Error(data.error ?? `图片上传失败，请检查 R2 配置和网络。状态码 ${response.status}。`);
  }

  if (!data.url || !data.key) {
    throw new Error("图片服务未返回图片地址。");
  }

  return {
    key: data.key,
    url: data.url,
    publicId: data.publicId ?? data.key,
  };
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      await worker(items[current]);
    }
  });

  await Promise.all(workers);
}
