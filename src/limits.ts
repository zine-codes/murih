export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PAGES = 1000;
export const MAX_CANVAS_PIXELS = 16_777_216;
export const MAX_CANVAS_DIMENSION = 16_384;
export const JPEG_QUALITY = 0.8;

export function fileWithinLimits(bytes: number): boolean {
  return bytes < MAX_FILE_BYTES;
}

export function pagesWithinLimits(n: number): boolean {
  return n < MAX_PAGES;
}

export function baseScale(pageCount: number): number {
  if (pageCount <= 100) return 300 / 72;
  if (pageCount <= 300) return 220 / 72;
  if (pageCount <= 600) return 150 / 72;
  return 96 / 72;
}

export function pageScale(widthPts: number, heightPts: number, base: number): number {
  const maxScaleByArea = Math.sqrt(MAX_CANVAS_PIXELS / (widthPts * heightPts));
  const maxScaleByDim = Math.min(
    MAX_CANVAS_DIMENSION / widthPts,
    MAX_CANVAS_DIMENSION / heightPts,
  );
  return Math.min(base, maxScaleByArea, maxScaleByDim);
}
