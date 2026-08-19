export type ValidatedImageMetadata = {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  extension: ".jpg" | ".png" | ".webp";
  width: number;
  height: number;
};

export class InvalidImageError extends Error {
  constructor(message = "图片内容无效或格式不受支持。") {
    super(message);
    this.name = "InvalidImageError";
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function validateDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new InvalidImageError("无法读取有效的图片尺寸。");
  }
  return { width, height };
}

function parsePng(bytes: Uint8Array, view: DataView): ValidatedImageMetadata | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < signature.length || !signature.every((value, index) => bytes[index] === value)) {
    return null;
  }

  let offset = 8;
  let dimensions: { width: number; height: number } | null = null;
  let sawImageData = false;
  let sawEnd = false;

  while (offset + 12 <= bytes.length) {
    const chunkLength = view.getUint32(offset, false);
    const type = readAscii(bytes, offset + 4, 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataOffset || chunkEnd > bytes.length) {
      throw new InvalidImageError("PNG 图片数据不完整。");
    }

    if (!dimensions) {
      if (type !== "IHDR" || chunkLength !== 13) {
        throw new InvalidImageError("PNG 图片缺少有效的 IHDR 头。");
      }
      dimensions = validateDimensions(view.getUint32(dataOffset, false), view.getUint32(dataOffset + 4, false));
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (chunkLength !== 0) throw new InvalidImageError("PNG 图片的 IEND 数据无效。");
      sawEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!dimensions || !sawImageData || !sawEnd || offset !== bytes.length) {
    throw new InvalidImageError("PNG 图片数据不完整。");
  }

  return { contentType: "image/png", extension: ".png", ...dimensions };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function parseJpeg(bytes: Uint8Array, view: DataView): ValidatedImageMetadata | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new InvalidImageError("JPEG 图片数据不完整。");
  }

  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  let sawScan = false;

  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) throw new InvalidImageError("JPEG 图片段结构无效。");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new InvalidImageError("JPEG 图片数据不完整。");

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) break;
    if (marker === 0x00 || marker === 0xd8) throw new InvalidImageError("JPEG 图片标记无效。");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new InvalidImageError("JPEG 图片数据不完整。");

    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new InvalidImageError("JPEG 图片段长度无效。");
    }

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) throw new InvalidImageError("JPEG 图片尺寸段无效。");
      dimensions = validateDimensions(view.getUint16(offset + 5, false), view.getUint16(offset + 3, false));
    }
    if (marker === 0xda) {
      sawScan = true;
      break;
    }
    offset += segmentLength;
  }

  if (!dimensions || !sawScan) throw new InvalidImageError("JPEG 图片缺少有效的图像数据。");
  return { contentType: "image/jpeg", extension: ".jpg", ...dimensions };
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function parseWebp(bytes: Uint8Array, view: DataView): ValidatedImageMetadata | null {
  if (bytes.length < 20 || readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WEBP") {
    return null;
  }
  if (view.getUint32(4, true) + 8 !== bytes.length) {
    throw new InvalidImageError("WebP 图片数据不完整。");
  }

  let offset = 12;
  let canvasDimensions: { width: number; height: number } | null = null;
  let frameDimensions: { width: number; height: number } | null = null;
  let sawImageData = false;

  while (offset + 8 <= bytes.length) {
    const type = readAscii(bytes, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    const chunkEnd = dataEnd + (chunkLength % 2);
    if (dataEnd < dataOffset || chunkEnd > bytes.length) {
      throw new InvalidImageError("WebP 图片块长度无效。");
    }

    if (type === "VP8X") {
      if (chunkLength !== 10) throw new InvalidImageError("WebP VP8X 图片头无效。");
      canvasDimensions = validateDimensions(
        readUint24LittleEndian(bytes, dataOffset + 4) + 1,
        readUint24LittleEndian(bytes, dataOffset + 7) + 1,
      );
    } else if (type === "VP8 ") {
      if (
        chunkLength < 10
        || bytes[dataOffset + 3] !== 0x9d
        || bytes[dataOffset + 4] !== 0x01
        || bytes[dataOffset + 5] !== 0x2a
      ) {
        throw new InvalidImageError("WebP VP8 图片头无效。");
      }
      frameDimensions = validateDimensions(
        view.getUint16(dataOffset + 6, true) & 0x3fff,
        view.getUint16(dataOffset + 8, true) & 0x3fff,
      );
      sawImageData = true;
    } else if (type === "VP8L") {
      if (chunkLength < 5 || bytes[dataOffset] !== 0x2f) {
        throw new InvalidImageError("WebP VP8L 图片头无效。");
      }
      frameDimensions = validateDimensions(
        1 + bytes[dataOffset + 1] + ((bytes[dataOffset + 2] & 0x3f) << 8),
        1 + (bytes[dataOffset + 2] >> 6) + (bytes[dataOffset + 3] << 2) + ((bytes[dataOffset + 4] & 0x0f) << 10),
      );
      sawImageData = true;
    } else if (type === "ANMF") {
      if (chunkLength < 16) throw new InvalidImageError("WebP 动画帧无效。");
      sawImageData = true;
    }

    offset = chunkEnd;
  }

  if (offset !== bytes.length || !sawImageData || (!canvasDimensions && !frameDimensions)) {
    throw new InvalidImageError("WebP 图片缺少有效的图像数据。");
  }

  const dimensions = canvasDimensions ?? frameDimensions!;
  return { contentType: "image/webp", extension: ".webp", ...dimensions };
}

export function validateRasterImage(body: ArrayBuffer): ValidatedImageMetadata {
  const bytes = new Uint8Array(body);
  const view = new DataView(body);
  const metadata = parsePng(bytes, view) ?? parseJpeg(bytes, view) ?? parseWebp(bytes, view);
  if (!metadata) throw new InvalidImageError();
  return metadata;
}
