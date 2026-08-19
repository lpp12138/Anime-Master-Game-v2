"use client";

import type { BangumiAnimeTag, BangumiCharacterTag } from "../types/game";
import {
  COMMUNITY_SCREENSHOT_MAX_INPUT_BYTES,
  constrainCommunityScreenshotDimensions,
} from "./communityScreenshotPolicy";
import { isR2ImageUploadTooLarge, R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE } from "./r2UploadPolicy";

export type CommunityScreenshotUploadResult = {
  key: string;
  url: string;
  width: number;
  height: number;
  size: number;
};

export type CommunityQuestionSetUploadInput = {
  submissionId: string;
  title: string;
  description?: string;
  playerId: string;
  nickname: string;
  questions: Array<{
    r2Key: string;
    labelText: string;
    animeTags: BangumiAnimeTag[];
    characterTags: BangumiCharacterTag[];
  }>;
};

export type CommunityQuestionSetUploadResult = {
  id: string;
  title: string;
  imageCount: number;
};

export type CommunityIndexedImage = {
  questionId: string;
  questionSetId: string;
  imageUrl: string;
  orderIndex: number;
  animeSubjectId: number;
  animeTags: BangumiAnimeTag[];
  characterTags: BangumiCharacterTag[];
  createdAt: string;
};

const clientEnv = (import.meta as ImportMeta & { env?: ImportMetaEnv }).env ?? {} as ImportMetaEnv;

function apiUrl(path: string) {
  const base = (clientEnv.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
  return `${base}${path}`;
}

function loadImage(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("图片解码失败，请确认文件没有损坏。"));
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, contentType: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("浏览器无法编码压缩后的图片。"));
    }, contentType, quality);
  });
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("操作已取消。");
}

async function prepareScreenshot(file: File, signal?: AbortSignal) {
  assertNotAborted(signal);
  if (file.size <= 0) throw new Error(`${file.name} 是空文件。`);
  if (file.size > COMMUNITY_SCREENSHOT_MAX_INPUT_BYTES) {
    throw new Error(`${file.name} 超过 30 MB，请先缩小文件。`);
  }

  const image = await loadImage(file);
  assertNotAborted(signal);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const output = constrainCommunityScreenshotDimensions(sourceWidth, sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    image.src = "";
    throw new Error("浏览器无法创建图片压缩画布。");
  }

  try {
    context.fillStyle = "#000";
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(image, 0, 0, output.width, output.height);

    let blob: Blob;
    try {
      blob = await canvasToBlob(canvas, "image/webp", 0.86);
      if (blob.type !== "image/webp") throw new Error("WebP 编码不可用");
    } catch {
      assertNotAborted(signal);
      blob = await canvasToBlob(canvas, "image/jpeg", 0.88);
    }

    assertNotAborted(signal);
    if (isR2ImageUploadTooLarge(blob.size)) throw new Error(R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE);
    return {
      blob,
      width: output.width,
      height: output.height,
    };
  } finally {
    image.src = "";
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function readJsonResponse<T>(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || fallback);
  return payload;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  timeoutMessage: string,
) {
  assertNotAborted(externalSignal);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (externalSignal?.aborted) throw new Error("操作已取消。");
    if (timedOut) throw new Error(timeoutMessage);
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function uploadCommunityScreenshot(
  file: File,
  uploadKey: string,
  signal?: AbortSignal,
): Promise<CommunityScreenshotUploadResult> {
  const prepared = await prepareScreenshot(file, signal);
  const response = await fetchWithTimeout(
    apiUrl("/api/community-screenshot-upload"),
    {
      method: "POST",
      headers: {
        "content-type": prepared.blob.type,
        "x-community-upload-key": uploadKey.trim(),
      },
      body: prepared.blob,
    },
    120_000,
    signal,
    `${file.name} 上传超时，请检查网络后重试。`,
  );
  const result = await readJsonResponse<Partial<CommunityScreenshotUploadResult>>(
    response,
    `${file.name} 上传失败，请稍后重试。`,
  );
  if (!result.key || !result.url || !result.width || !result.height || typeof result.size !== "number") {
    throw new Error("图片服务返回了无效结果。");
  }
  return result as CommunityScreenshotUploadResult;
}

export async function searchCommunityImageIndex(
  animeSubjectId: number,
  characterId: number | null,
  uploadKey: string,
  signal?: AbortSignal,
): Promise<CommunityIndexedImage[]> {
  const query = new URLSearchParams({
    animeSubjectId: String(animeSubjectId),
    limit: "20",
  });
  if (characterId != null) query.set("characterId", String(characterId));
  const response = await fetchWithTimeout(apiUrl(`/api/community-image-index?${query}`), {
    headers: { "x-community-upload-key": uploadKey.trim() },
  }, 15_000, signal, "图片索引查询超时，请检查网络后重试。");
  const result = await readJsonResponse<{ images?: CommunityIndexedImage[] }>(
    response,
    "图片索引查询失败，请稍后重试。",
  );
  if (!Array.isArray(result.images)) throw new Error("图片索引服务返回了无效结果。");
  return result.images;
}

export async function createUploadedCommunityQuestionSet(
  input: CommunityQuestionSetUploadInput,
  uploadKey: string,
  signal?: AbortSignal,
): Promise<CommunityQuestionSetUploadResult> {
  const response = await fetchWithTimeout(apiUrl("/api/community-question-set"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-community-upload-key": uploadKey.trim(),
    },
    body: JSON.stringify(input),
  }, 30_000, signal, "题库保存超时，请重试；重复提交不会创建重复题库。");
  const result = await readJsonResponse<Partial<CommunityQuestionSetUploadResult>>(
    response,
    "题库保存失败，请稍后重试。",
  );
  if (!result.id || !result.title || typeof result.imageCount !== "number") {
    throw new Error("题库服务返回了无效结果。");
  }
  return result as CommunityQuestionSetUploadResult;
}
