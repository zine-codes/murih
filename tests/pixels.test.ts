import { describe, expect, it } from 'vitest';
import {
  DARK_FRACTION_THRESHOLD,
  DARK_LUMEN_THRESHOLD,
  NEAR_BLACK,
  invertPixels,
  luminance,
  processImageData,
  sampleStats,
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
