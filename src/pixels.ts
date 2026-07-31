export const DARK_LUMEN_THRESHOLD = 127;
export const NEAR_BLACK = 64;
export const DARK_FRACTION_THRESHOLD = 0.5;

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
  const n = data.length;
  let sum = 0;
  let darkCount = 0;
  for (let i = 0; i < n; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = luminance(r, g, b);
    sum += lum;
    if (lum < NEAR_BLACK) darkCount++;
    data[i] = lum;
    data[i + 1] = lum;
    data[i + 2] = lum;
  }
  const pixels = n / 4;
  const stats = {
    meanLum: pixels === 0 ? 255 : sum / pixels,
    darkFraction: pixels === 0 ? 0 : darkCount / pixels,
    isDark: false,
  };
  return classify(stats);
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
