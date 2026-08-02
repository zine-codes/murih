import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { PdfWriter, PdfStreamWriter, deflate, rgbaToRgb } from '../src/pdfwriter';
import type { PdfSink, RasterPageSpec } from '../src/pdfwriter';

type Rgb = readonly [number, number, number];

function latin1(pdf: Uint8Array): string {
  let s = '';
  for (const b of pdf) s += String.fromCharCode(b);
  return s;
}

async function inflateBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream('deflate');
    const reader = ds.readable.getReader();
    const writer = ds.writable.getWriter();
    const writePromise = writer.write(bytes).then(() => writer.close()).catch(() => undefined);
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
    await writePromise;
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of parts) {
      out.set(part, off);
      off += part.length;
    }
    return out;
  } catch {
    return null;
  }
}

async function flateStreams(pdf: Uint8Array<ArrayBuffer>): Promise<Uint8Array[]> {
  const text = latin1(pdf);
  const out: Uint8Array[] = [];
  const re = /\/Length\s+(\d+)\s*>>\s*\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const len = Number(m[1]);
    const start = m.index + m[0].length;
    if (text.charCodeAt(start) !== 0x78) continue;
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = text.charCodeAt(start + i) & 0xff;
    const inflated = await inflateBytes(data as Uint8Array<ArrayBuffer>);
    if (inflated) out.push(inflated);
  }
  return out;
}

const BG: Rgb = [0x12, 0x12, 0x12];
const FG: Rgb = [0xe6, 0xe6, 0xe6];

function twoToneRgba(width: number, height: number, pattern: readonly Rgb[]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const c = pattern[i % pattern.length];
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

describe('rgbaToRgb', () => {
  it('drops the alpha channel, keeping exact RGB', () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 0]);
    expect(Array.from(rgbaToRgb(rgba, 2, 1))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('PdfWriter flate (bw) pages', () => {
  it('writes a valid PDF preserving the MediaBox and exact 2-tone pixels', async () => {
    const writer = new PdfWriter();
    const rgba = twoToneRgba(2, 2, [BG, FG, FG, BG]);
    await writer.addPage({
      widthPts: 400,
      heightPts: 600,
      mediaBox: [100, 50, 500, 650],
      drawX: 100,
      drawY: 50,
      image: { kind: 'rgb', rgb: rgbaToRgb(rgba, 2, 2), width: 2, height: 2 },
    });
    const pdf = writer.save();

    const text = latin1(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.endsWith('%%EOF')).toBe(true);

    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    const box = doc.getPage(0).getMediaBox();
    expect(Math.round(box.x)).toBe(100);
    expect(Math.round(box.y)).toBe(50);
    expect(Math.round(box.width)).toBe(400);
    expect(Math.round(box.height)).toBe(600);

    const [stream] = await flateStreams(pdf);
    expect(stream).toBeDefined();
    expect(Array.from(stream)).toEqual([
      BG[0], BG[1], BG[2], FG[0], FG[1], FG[2],
      FG[0], FG[1], FG[2], BG[0], BG[1], BG[2],
    ]);
  });

  it('defaults the MediaBox to the origin for rotated pages', async () => {
    const writer = new PdfWriter();
    await writer.addPage({
      widthPts: 600,
      heightPts: 400,
      mediaBox: [0, 0, 600, 400],
      drawX: 0,
      drawY: 0,
      image: { kind: 'rgb', rgb: rgbaToRgb(twoToneRgba(1, 1, [FG]), 1, 1), width: 1, height: 1 },
    });
    const pdf = writer.save();
    const doc = await PDFDocument.load(pdf);
    const box = doc.getPage(0).getMediaBox();
    expect(Math.round(box.width)).toBe(600);
    expect(Math.round(box.height)).toBe(400);
  });

  it('assembles multiple pages in order', async () => {
    const writer = new PdfWriter();
    for (const w of [400, 500]) {
      await writer.addPage({
        widthPts: w,
        heightPts: 600,
        mediaBox: [0, 0, w, 600],
        drawX: 0,
        drawY: 0,
        image: { kind: 'rgb', rgb: rgbaToRgb(twoToneRgba(1, 1, [BG]), 1, 1), width: 1, height: 1 },
      });
    }
    const pdf = writer.save();
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    expect(Math.round(doc.getPage(0).getMediaBox().width)).toBe(400);
    expect(Math.round(doc.getPage(1).getMediaBox().width)).toBe(500);
  });

  it('xref table covers every object, including the last page image', async () => {
    const writer = new PdfWriter();
    for (let i = 0; i < 3; i++) {
      await writer.addPage({
        widthPts: 400,
        heightPts: 600,
        mediaBox: [0, 0, 400, 600],
        drawX: 0,
        drawY: 0,
        image: { kind: 'rgb', rgb: rgbaToRgb(twoToneRgba(1, 1, [BG]), 1, 1), width: 1, height: 1 },
      });
    }
    const pdf = writer.save();
    const text = latin1(pdf);

    const objRe = /\n(\d+) 0 obj/g;
    let highest = 0;
    let m: RegExpExecArray | null;
    while ((m = objRe.exec(text))) highest = Math.max(highest, Number(m[1]));

    const xref = /xref\n0 (\d+)\n([\s\S]*?)\ntrailer/.exec(text)!;
    const size = Number(xref[1]);
    expect(size).toBe(highest + 1);

    const entries = xref[2].trim().split('\n');
    expect(entries.length).toBe(size);
    for (let n = 1; n < size; n++) {
      const offset = Number(entries[n].slice(0, 10));
      expect(text.slice(offset, offset + String(n).length + 6)).toBe(`${n} 0 obj`);
    }
  });

  it('falls back to an unfiltered raw stream when deflate is unavailable', async () => {
    const orig = globalThis.CompressionStream;
    delete (globalThis as { CompressionStream?: unknown }).CompressionStream;
    try {
      const writer = new PdfWriter();
      const rgb = new Uint8Array([BG[0], BG[1], BG[2], FG[0], FG[1], FG[2]]);
      await writer.addPage({
        widthPts: 2,
        heightPts: 1,
        mediaBox: [0, 0, 2, 1],
        drawX: 0,
        drawY: 0,
        image: { kind: 'rgb', rgb, width: 2, height: 1 },
      });
      const pdf = writer.save();
      const text = latin1(pdf);
      expect(text).not.toContain('/Filter');
      expect(text).toContain('/Length 6 >>');
      const doc = await PDFDocument.load(pdf);
      expect(doc.getPageCount()).toBe(1);
    } finally {
      (globalThis as { CompressionStream?: unknown }).CompressionStream = orig;
    }
  });
});

describe('PdfStreamWriter', () => {
  function fakeSink(): { sink: PdfSink; bytes: Uint8Array[] } {
    const bytes: Uint8Array[] = [];
    return {
      sink: {
        write: async (b) => {
          bytes.push(b.slice());
        },
        close: async () => undefined,
        getFile: async () => {
          const merged = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
          let off = 0;
          for (const b of bytes) {
            merged.set(b, off);
            off += b.length;
          }
          return new File([merged], 'out.pdf');
        },
      },
      bytes,
    };
  }

  async function makeSpecs(): Promise<RasterPageSpec[]> {
    return [
      {
        widthPts: 400,
        heightPts: 600,
        mediaBox: [100, 50, 500, 650],
        drawX: 100,
        drawY: 50,
        image: { kind: 'rgb', rgb: rgbaToRgb(twoToneRgba(3, 2, [BG, FG, FG]), 3, 2), width: 3, height: 2 },
      },
      {
        widthPts: 500,
        heightPts: 400,
        mediaBox: [0, 0, 500, 400],
        drawX: 0,
        drawY: 0,
        image: { kind: 'rgb', rgb: rgbaToRgb(twoToneRgba(1, 1, [FG]), 1, 1), width: 1, height: 1 },
      },
      {
        widthPts: 300,
        heightPts: 200,
        mediaBox: [0, 0, 300, 200],
        drawX: 0,
        drawY: 0,
        image: { kind: 'jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]), width: 64, height: 48 },
      },
    ];
  }

  it('produces byte-identical output to PdfWriter', async () => {
    const specs = await makeSpecs();
    const { sink, bytes } = fakeSink();
    const stream = new PdfStreamWriter(sink, specs.length);
    for (const spec of specs) await stream.addPage(spec);
    const file = await stream.finalize();
    const streamed = new Uint8Array(await file.arrayBuffer());
    expect(streamed).toEqual(bytes.reduce((a, b) => {
      const o = new Uint8Array(a.length + b.length);
      o.set(a, 0);
      o.set(b, a.length);
      return o;
    }, new Uint8Array(0)));

    const inRam = new PdfWriter();
    for (const spec of specs) await inRam.addPage(spec);
    expect(streamed).toEqual(inRam.save());
  });

  it('writes a valid multi-page PDF with a preserved offset MediaBox', async () => {
    const specs = await makeSpecs();
    const { sink } = fakeSink();
    const stream = new PdfStreamWriter(sink, specs.length);
    for (const spec of specs) await stream.addPage(spec);
    const file = await stream.finalize();

    const doc = await PDFDocument.load(await file.arrayBuffer());
    expect(doc.getPageCount()).toBe(3);
    const box = doc.getPage(0).getMediaBox();
    expect(Math.round(box.x)).toBe(100);
    expect(Math.round(box.y)).toBe(50);
    expect(Math.round(box.width)).toBe(400);
    expect(Math.round(box.height)).toBe(600);
  });
});

describe('PdfWriter jpeg (gray) pages', () => {
  it('embeds the bytes as a /DCTDecode image with the raster dimensions', async () => {
    const writer = new PdfWriter();
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    await writer.addPage({
      widthPts: 300,
      heightPts: 200,
      mediaBox: [0, 0, 300, 200],
      drawX: 0,
      drawY: 0,
      image: { kind: 'jpeg', bytes: fakeJpeg, width: 64, height: 48 },
    });
    const pdf = writer.save();
    const text = latin1(pdf);
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/Width 64 /Height 48');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
  });
});

describe('deflate', () => {
  it('produces zlib-wrapped output that inflates back', async () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await deflate(input);
    expect(out).not.toBeNull();
    expect(Array.from((await inflateBytes(out!))!)).toEqual([1, 2, 3, 4, 5]);
    expect(out![0]).toBe(0x78);
  });
});
