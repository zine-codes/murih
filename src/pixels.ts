export const DARK_LUMEN_THRESHOLD = 127;
export const NEAR_BLACK = 64;
export const DARK_FRACTION_THRESHOLD = 0.5;

export type ConvertMode = 'bw' | 'gray';

export interface PixelStats {
  meanLum: number;
  darkFraction: number;
  isDark: boolean;
}

export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function classify(stats: PixelStats): PixelStats {
  return {
    ...stats,
    isDark:
      stats.meanLum < DARK_LUMEN_THRESHOLD ||
      stats.darkFraction > DARK_FRACTION_THRESHOLD,
  };
}

export function sampleStats(data: Uint8ClampedArray, step = 16): PixelStats {
  const n = data.length;
  let sum = 0;
  let darkCount = 0;
  let count = 0;
  for (let i = 0; i < n; i += step * 4) {
    const lum = luminance(data[i], data[i + 1], data[i + 2]);
    sum += lum;
    if (lum < NEAR_BLACK) darkCount++;
    count++;
  }
  if (count === 0) {
    return { meanLum: 255, darkFraction: 0, isDark: false };
  }
  return classify({
    meanLum: sum / count,
    darkFraction: darkCount / count,
    isDark: false,
  });
}

export function processImageData(data: Uint8ClampedArray): PixelStats {
  return scanAndHistogram(data).stats;
}

export function invertPixels(data: Uint8ClampedArray): void {
  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    const lum = luminance(data[i], data[i + 1], data[i + 2]);
    const out = 255 - lum;
    data[i] = out;
    data[i + 1] = out;
    data[i + 2] = out;
  }
}

export interface PageScan {
  stats: PixelStats;
  hist: Uint32Array;
}

export function scanAndHistogram(data: Uint8ClampedArray): PageScan {
  const hist = new Uint32Array(256);
  const n = data.length;
  let sum = 0;
  let darkCount = 0;
  for (let i = 0; i < n; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = luminance(r, g, b);
    const v = Math.round(lum);
    hist[v]++;
    sum += lum;
    if (lum < NEAR_BLACK) darkCount++;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  const pixels = n / 4;
  const stats = classify({
    meanLum: pixels === 0 ? 255 : sum / pixels,
    darkFraction: pixels === 0 ? 0 : darkCount / pixels,
    isDark: false,
  });
  return { stats, hist };
}

function distinctBins(hist: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < 256; i++) {
    if (hist[i] > 0) count++;
  }
  return count;
}

export function otsuThreshold(hist: Uint32Array): number {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sum += i * hist[i];
  }
  if (total === 0) return 127;
  let sumB = 0;
  let wB = 0;
  let maxBetween = 0;
  let threshold = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between >= maxBetween) {
      maxBetween = between;
      threshold = i;
    }
  }
  return threshold;
}

export function binarizePixels(data: Uint8ClampedArray, threshold: number, pageIsDark: boolean): void {
  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    const hi = data[i] >= threshold;
    const out = pageIsDark ? (hi ? 255 : 0) : (hi ? 0 : 255);
    data[i] = out;
    data[i + 1] = out;
    data[i + 2] = out;
  }
}

export function transformImageData(data: Uint8ClampedArray, mode: ConvertMode): PixelStats {
  const { stats, hist } = scanAndHistogram(data);
  if (mode === 'bw') {
    if (distinctBins(hist) >= 2) {
      binarizePixels(data, otsuThreshold(hist), stats.isDark);
    } else if (!stats.isDark) {
      invertPixels(data);
    }
  } else if (!stats.isDark) {
    invertPixels(data);
  }
  return stats;
}
