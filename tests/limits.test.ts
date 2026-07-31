import { describe, expect, it } from 'vitest';
import {
  MAX_CANVAS_DIMENSION,
  MAX_CANVAS_PIXELS,
  MAX_FILE_BYTES,
  MAX_PAGES,
  baseScale,
  fileWithinLimits,
  pageScale,
  pagesWithinLimits,
} from '../src/limits';

describe('hard limits', () => {
  it('rejects files at or above 50 MB', () => {
    expect(fileWithinLimits(MAX_FILE_BYTES - 1)).toBe(true);
    expect(fileWithinLimits(MAX_FILE_BYTES)).toBe(false);
    expect(fileWithinLimits(MAX_FILE_BYTES + 1)).toBe(false);
  });

  it('rejects docs at or above 1000 pages', () => {
    expect(pagesWithinLimits(MAX_PAGES - 1)).toBe(true);
    expect(pagesWithinLimits(MAX_PAGES)).toBe(false);
    expect(pagesWithinLimits(MAX_PAGES + 1)).toBe(false);
  });
});

describe('baseScale', () => {
  it('uses 300 DPI for small docs', () => {
    expect(baseScale(1)).toBeCloseTo(300 / 72);
    expect(baseScale(100)).toBeCloseTo(300 / 72);
  });

  it('downscales as page count grows', () => {
    expect(baseScale(101)).toBeCloseTo(220 / 72);
    expect(baseScale(301)).toBeCloseTo(150 / 72);
    expect(baseScale(601)).toBeCloseTo(96 / 72);
    expect(baseScale(999)).toBeCloseTo(96 / 72);
  });
});

describe('pageScale', () => {
  it('never exceeds the requested base', () => {
    expect(pageScale(612, 792, 4)).toBeLessThanOrEqual(4);
  });

  it('clamps every canvas under the iOS area cap', () => {
    const a3pts = { w: 841.89, h: 1190.55 };
    const scale = pageScale(a3pts.w, a3pts.h, 300 / 72);
    const area = a3pts.w * scale * a3pts.h * scale;
    expect(area).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  });

  it('stays under the cap for a very large page', () => {
    const scale = pageScale(2000, 3000, 5);
    expect(2000 * scale * 3000 * scale).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  });

  it('area cap binds even when the requested base is huge', () => {
    const scale = pageScale(200, 300, 40);
    expect(scale).toBeLessThan(40);
    expect(200 * scale * 300 * scale).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 0.5);
  });

  it('clamps each dimension under the browser max canvas size', () => {
    const scale = pageScale(50000, 100, 5);
    expect(50000 * scale).toBeLessThanOrEqual(MAX_CANVAS_DIMENSION);
    expect(100 * scale).toBeLessThanOrEqual(MAX_CANVAS_DIMENSION);
  });
});
