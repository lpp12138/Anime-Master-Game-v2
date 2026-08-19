export const COMMUNITY_SCREENSHOT_MAX_QUESTIONS = 30;
export const COMMUNITY_SCREENSHOT_MAX_INPUT_BYTES = 30 * 1024 * 1024;
export const COMMUNITY_SCREENSHOT_MAX_LANDSCAPE_WIDTH = 1920;
export const COMMUNITY_SCREENSHOT_MAX_LANDSCAPE_HEIGHT = 1080;

export type CommunityScreenshotDimensions = {
  width: number;
  height: number;
};

export function getCommunityScreenshotLimits(width: number, height: number): CommunityScreenshotDimensions {
  return width >= height
    ? {
        width: COMMUNITY_SCREENSHOT_MAX_LANDSCAPE_WIDTH,
        height: COMMUNITY_SCREENSHOT_MAX_LANDSCAPE_HEIGHT,
      }
    : {
        width: COMMUNITY_SCREENSHOT_MAX_LANDSCAPE_HEIGHT,
        height: COMMUNITY_SCREENSHOT_MAX_LANDSCAPE_WIDTH,
      };
}

export function isCommunityScreenshotWithin1080p(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return false;
  }

  const limits = getCommunityScreenshotLimits(width, height);
  return width <= limits.width && height <= limits.height;
}

export function constrainCommunityScreenshotDimensions(width: number, height: number): CommunityScreenshotDimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("图片尺寸无效。");
  }

  const limits = getCommunityScreenshotLimits(width, height);
  const scale = Math.min(1, limits.width / width, limits.height / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
