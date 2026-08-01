import { describe, expect, it } from 'vitest';
import {
  DARK_FRACTION_THRESHOLD,
  DARK_LUMEN_THRESHOLD,
  NEAR_BLACK,
  binarizePixels,
  invertPixels,
  luminance,
  otsuThreshold,
  processImageData,
  sampleStats,
  scanAndHistogram,
  transformImageData,
} from '../src/pixels';

function px(r: number, g: number, b: number): number[] {
  return [r, g, b, 255];
}

function flat(pixels: number[][]): Uint8ClampedArray {
  const data: number[] = [];
  for (const p of pixels) data.push(...p);
  return new Uint8ClampedArray(data);
}

describe('luminance', () => {
  it('uses Rec.709 weights', () => {
    expect(luminance(255, 255, 255)).toBeCloseTo(255);
    expect(luminance(0, 0, 0)).toBeCloseTo(0);
    expect(luminance(255, 0, 0)).toBeCloseTo(0.2126 * 255);
  });
});

describe('processImageData', () => {
  it('grayscales without inversion', () => {
    const data = flat([px(255, 0, 0), px(0, 255, 0)]);
    processImageData(data);
    const g1 = Math.round(0.2126 * 255);
    const g2 = Math.round(0.7152 * 255);
    expect(data[0]).toBe(g1);
    expect(data[1]).toBe(g1);
    expect(data[2]).toBe(g1);
    expect(data[4]).toBe(g2);
    expect(data[5]).toBe(g2);
    expect(data[6]).toBe(g2);
  });

  it('keeps alpha channel untouched', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 0, 10, 20, 30, 0]);
    processImageData(data);
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(0);
  });

  it('detects an all-white page as light', () => {
    const stats = processImageData(flat([px(255, 255, 255), px(240, 240, 240)]));
    expect(stats.meanLum).toBeGreaterThan(DARK_LUMEN_THRESHOLD);
    expect(stats.darkFraction).toBe(0);
    expect(stats.isDark).toBe(false);
  });

  it('detects an all-black page as dark', () => {
    const stats = processImageData(flat([px(0, 0, 0), px(5, 5, 5)]));
    expect(stats.meanLum).toBeLessThan(DARK_LUMEN_THRESHOLD);
    expect(stats.darkFraction).toBe(1);
    expect(stats.isDark).toBe(true);
  });

  it('flags a mostly-dark page via dark fraction', () => {
    const pixels = [px(20, 20, 20), px(20, 20, 20), px(200, 200, 200)];
    const stats = processImageData(flat(pixels));
    expect(stats.darkFraction).toBeCloseTo(2 / 3);
    expect(stats.darkFraction).toBeGreaterThan(DARK_FRACTION_THRESHOLD);
    expect(stats.isDark).toBe(true);
  });

  it('reports stats computed on the ORIGINAL luminance', () => {
    const data = flat([px(0, 0, 0)]);
    const stats = processImageData(data);
    expect(stats.meanLum).toBeCloseTo(0);
    expect(data[0]).toBe(0);
  });

  it('treats meanLum exactly at the threshold as light (< 127 required)', () => {
    const stats = processImageData(flat([px(127, 127, 127)]));
    expect(stats.meanLum).toBeCloseTo(127);
    expect(stats.isDark).toBe(false);
  });

  it('treats darkFraction exactly at the threshold as light (> 0.5 required)', () => {
    const stats = processImageData(
      flat([px(60, 60, 60), px(60, 60, 60), px(220, 220, 220), px(220, 220, 220)]),
    );
    expect(stats.meanLum).toBeGreaterThanOrEqual(127);
    expect(stats.darkFraction).toBeCloseTo(0.5);
    expect(stats.isDark).toBe(false);
  });

  it('NEAR_BLACK boundary: luminance exactly 64 is not near-black', () => {
    const stats = processImageData(
      flat([
        px(64, 64, 64),
        px(64, 64, 64),
        px(64, 64, 64),
        px(64, 64, 64),
        px(64, 64, 64),
        px(255, 255, 255),
        px(255, 255, 255),
        px(255, 255, 255),
      ]),
    );
    expect(stats.meanLum).toBeGreaterThanOrEqual(127);
    expect(stats.darkFraction).toBe(0);
    expect(stats.isDark).toBe(false);
  });

  it('fully transparent pixels are treated as black (pdf.js composites onto white in practice)', () => {
    const stats = processImageData(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0]));
    expect(stats.isDark).toBe(true);
  });
});

describe('invertPixels', () => {
  it('flips grayscale dark to light', () => {
    const data = flat([px(0, 0, 0), px(255, 255, 255)]);
    invertPixels(data);
    expect(data[0]).toBe(255);
    expect(data[1]).toBe(255);
    expect(data[2]).toBe(255);
    expect(data[4]).toBe(0);
    expect(data[5]).toBe(0);
    expect(data[6]).toBe(0);
  });

  it('double application restores the grayscale', () => {
    const data = flat([px(10, 10, 10), px(200, 200, 200)]);
    invertPixels(data);
    expect(data[0]).toBe(245);
    expect(data[4]).toBe(55);
    invertPixels(data);
    expect(data[0]).toBe(10);
    expect(data[4]).toBe(200);
  });
});

describe('scanAndHistogram', () => {
  it('returns grayscaled data plus a matching histogram', () => {
    const data = flat([px(255, 255, 0), px(0, 255, 255)]);
    const { stats, hist } = scanAndHistogram(data);
    const g1 = Math.round(0.2126 * 255 + 0.7152 * 255);
    const g2 = Math.round(0.7152 * 255 + 0.0722 * 255);
    expect(data[0]).toBe(g1);
    expect(data[4]).toBe(g2);
    expect(stats.isDark).toBe(false);
    expect(hist[g1]).toBe(1);
    expect(hist[g2]).toBe(1);
    expect(hist.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe('otsuThreshold', () => {
  it('splits a clean bimodal histogram near the valley', () => {
    const hist = new Uint32Array(256);
    for (let i = 0; i < 100; i++) hist[i]++;
    for (let i = 200; i < 256; i++) hist[i]++;
    const thr = otsuThreshold(hist);
    expect(thr).toBeGreaterThanOrEqual(90);
    expect(thr).toBeLessThanOrEqual(210);
  });

  it('returns a sane fallback for empty histograms', () => {
    expect(otsuThreshold(new Uint32Array(256))).toBe(127);
  });

  it('does not crash on a degenerate single-value histogram', () => {
    const hist = new Uint32Array(256);
    hist[42] = 1000;
    const thr = otsuThreshold(hist);
    expect(thr).toBeGreaterThanOrEqual(0);
    expect(thr).toBeLessThanOrEqual(255);
  });
});

describe('binarizePixels', () => {
  it('maps light pages to white-on-black', () => {
    const data = flat([px(0, 0, 0), px(255, 255, 255), px(128, 128, 128)]);
    binarizePixels(data, 128, false);
    expect(Array.from(data)).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  });

  it('maps dark pages to pure black (never re-lightened)', () => {
    const data = flat([px(0, 0, 0), px(255, 255, 255), px(128, 128, 128)]);
    binarizePixels(data, 128, true);
    expect(Array.from(data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  });
});

describe('transformImageData', () => {
  it('bw: dark-green page with yellow text becomes pure black/white', () => {
    const bg = px(0, 40, 0);
    const text = px(255, 240, 0);
    const data = flat([
      bg, bg, bg, bg,
      text, text, text, text,
      bg, bg, bg, bg,
    ]);
    const stats = transformImageData(data, 'bw');
    expect(stats.isDark).toBe(true);
    const values = new Set<number>();
    for (let i = 0; i < data.length; i += 4) values.add(data[i]);
    expect(values.size).toBe(2);
    expect(values.has(0)).toBe(true);
    expect(values.has(255)).toBe(true);
    expect(data[0]).toBe(0);
    const textPx = data.slice(16, 19);
    expect(Array.from(textPx)).toEqual([255, 255, 255]);
  });

  it('bw: white page with black text stays black-on-white', () => {
    const data = flat([
      px(255, 255, 255), px(255, 255, 255), px(255, 255, 255), px(255, 255, 255),
      px(255, 255, 255), px(255, 255, 255), px(255, 255, 255), px(255, 255, 255),
      px(0, 0, 0), px(0, 0, 0),
    ]);
    transformImageData(data, 'bw');
    const rgb = (from: number, to: number): number[] => {
      const out: number[] = [];
      for (let i = from; i < to; i++) {
        out.push(data[4 * i], data[4 * i + 1], data[4 * i + 2]);
      }
      return out;
    };
    expect(rgb(0, 8).every((v) => v === 0)).toBe(true);
    expect(rgb(8, 10).every((v) => v === 255)).toBe(true);
  });

  it('bw: uniform page falls back to inversion instead of a random threshold', () => {
    const data = flat([px(0, 0, 0)]);
    transformImageData(data, 'bw');
    expect(Array.from(data)).toEqual([0, 0, 0, 255]);
    const light = flat([px(240, 240, 240)]);
    transformImageData(light, 'bw');
    expect(Array.from(light)).toEqual([15, 15, 15, 255]);
  });

  it('gray: keeps 256-level grayscale behavior (no binarization)', () => {
    const bg = px(0, 40, 0);
    const text = px(255, 240, 0);
    const data = flat([bg, bg, bg, text]);
    const stats = transformImageData(data, 'gray');
    expect(stats.isDark).toBe(true);
    expect(data[0]).toBe(Math.round(0.7152 * 40));
    const values = new Set<number>();
    for (let i = 0; i < data.length; i += 4) values.add(data[i]);
    expect(values.size).toBe(2);
    expect(values.has(0)).toBe(false);
    expect(values.has(255)).toBe(false);
  });

  it('gray: light page is inverted to dark', () => {
    const data = flat([px(0, 0, 0), px(255, 255, 255)]);
    transformImageData(data, 'gray');
    expect(Array.from(data)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });
});

describe('sampleStats', () => {
  it('matches full-scan classification on uniform data', () => {
    const data = flat([px(0, 0, 0), px(20, 20, 20), px(50, 50, 50)]);
    const full = processImageData(flat([px(0, 0, 0), px(20, 20, 20), px(50, 50, 50)]));
    const sampled = sampleStats(data, 1);
    expect(sampled.isDark).toBe(full.isDark);
    expect(sampled.meanLum).toBeCloseTo(full.meanLum);
    expect(sampled.darkFraction).toBeCloseTo(full.darkFraction);
  });

  it('treats empty data as light', () => {
    const stats = sampleStats(new Uint8ClampedArray(0));
    expect(stats.isDark).toBe(false);
  });

  it('near-black pixels count toward the dark fraction', () => {
    const data = flat([px(NEAR_BLACK - 1, NEAR_BLACK - 1, NEAR_BLACK - 1)]);
    const stats = sampleStats(data, 1);
    expect(stats.darkFraction).toBe(1);
  });

  it('step sampling can disagree with the full scan on striped data (why the pipeline uses the full scan)', () => {
    const white = px(255, 255, 255);
    const data = flat([px(0, 0, 0), ...Array(9).fill(white)]);
    const full = processImageData(flat([px(0, 0, 0), ...Array(9).fill(white)]));
    expect(full.isDark).toBe(false);
    const sampled = sampleStats(data, 16);
    expect(sampled.isDark).toBe(true);
  });
});
