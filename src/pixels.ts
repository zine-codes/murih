export const DARK_LUMEN_THRESHOLD = 127;
export const NEAR_BLACK = 64;
export const DARK_FRACTION_THRESHOLD = 0.5;
export const NIGHT_GAMMA = 1.0;

export type ConvertMode = 'bw' | 'gray';

export interface PixelStats {
  meanLum: number;
  darkFraction: number;
  isDark: boolean;
}

export type RGB = readonly [number, number, number];

export interface NightPalette {
  id: 'neutral' | 'warm';
  bg: RGB;
  fg: RGB;
}

export const NEUTRAL_PALETTE: NightPalette = {
  id: 'neutral',
  bg: [0x12, 0x12, 0x12],
  fg: [0xe6, 0xe6, 0xe6],
};

export const WARM_PALETTE: NightPalette = {
  id: 'warm',
  bg: [0x18, 0x15, 0x12],
  fg: [0xeb, 0xe3, 0xcf],
};

export const PALETTES: readonly NightPalette[] = [NEUTRAL_PALETTE, WARM_PALETTE];

export function defaultPalette(): NightPalette {
  return NEUTRAL_PALETTE;
}

export function isPalette(value: unknown): value is NightPalette {
  const p = value as NightPalette;
  return (
    !!p &&
    (p.id === 'neutral' || p.id === 'warm') &&
    Array.isArray(p.bg) &&
    p.bg.length === 3 &&
    Array.isArray(p.fg) &&
    p.fg.length === 3 &&
    p.bg.every((v) => typeof v === 'number' && v >= 0 && v <= 255) &&
    p.fg.every((v) => typeof v === 'number' && v >= 0 && v <= 255)
  );
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

export type NightLut = readonly RGB[];

export function makeNightLut(palette: NightPalette, gamma = NIGHT_GAMMA): NightLut {
  const lut: RGB[] = new Array(256);
  const inv = 1 / gamma;
  for (let l = 0; l < 256; l++) {
    const t = 1 - (l / 255) ** inv;
    lut[l] = [
      Math.round(palette.bg[0] + (palette.fg[0] - palette.bg[0]) * t),
      Math.round(palette.bg[1] + (palette.fg[1] - palette.bg[1]) * t),
      Math.round(palette.bg[2] + (palette.fg[2] - palette.bg[2]) * t),
    ];
  }
  return lut;
}

export function makeDarkLut(palette: NightPalette): NightLut {
  const lut: RGB[] = new Array(256);
  for (let l = 0; l < 256; l++) {
    const t = l / 255;
    lut[l] = [
      Math.round(palette.bg[0] + (palette.fg[0] - palette.bg[0]) * t),
      Math.round(palette.bg[1] + (palette.fg[1] - palette.bg[1]) * t),
      Math.round(palette.bg[2] + (palette.fg[2] - palette.bg[2]) * t),
    ];
  }
  return lut;
}

export function applyLut(data: Uint8ClampedArray, lut: NightLut): void {
  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    const c = lut[data[i]];
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
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

export function binarizePixels(
  data: Uint8ClampedArray,
  threshold: number,
  pageIsDark: boolean,
  palette: NightPalette = NEUTRAL_PALETTE,
): void {
  const n = data.length;
  const fg = palette.fg;
  const bg = palette.bg;
  for (let i = 0; i < n; i += 4) {
    const hi = data[i] >= threshold;
    const c = pageIsDark ? (hi ? fg : bg) : (hi ? bg : fg);
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
  }
}

export function transformImageData(
  data: Uint8ClampedArray,
  mode: ConvertMode,
  palette: NightPalette = NEUTRAL_PALETTE,
): PixelStats {
  const { stats, hist } = scanAndHistogram(data);
  if (mode === 'bw') {
    if (distinctBins(hist) >= 2) {
      binarizePixels(data, otsuThreshold(hist), stats.isDark, palette);
    } else {
      applyLut(data, stats.isDark ? makeDarkLut(palette) : makeNightLut(palette));
    }
  } else {
    applyLut(data, stats.isDark ? makeDarkLut(palette) : makeNightLut(palette));
  }
  return stats;
}
