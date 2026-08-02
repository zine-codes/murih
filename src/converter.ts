import type * as pdfjsType from 'pdfjs-dist';
import { PdfWriter, PdfStreamWriter, createOpfsSink, rgbaToRgb } from './pdfwriter';
import {
  NEUTRAL_PALETTE,
  type ConvertMode,
  type NightPalette,
  type PixelStats,
} from './pixels';
import {
  JPEG_QUALITY,
  baseScale,
  fileWithinLimits,
  pageScale,
  pagesWithinLimits,
} from './limits';
import {
  createPixelWorker,
  transformPixelsOnMainThread,
  type PixelWorker,
} from './transform';

const MURIH_OUTPUT_NAME = 'murih-output.pdf';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    detail?: unknown,
  ) {
    super(detail instanceof Error ? detail.message : detail ? String(detail) : code);
    this.name = 'AppError';
  }
}

export interface ConvertOptions {
  file: File;
  mode: ConvertMode;
  palette?: NightPalette;
  onProgress: (done: number, total: number) => void;
  shouldCancel: () => boolean;
}

export interface ConvertResult {
  blob: Blob;
  fileName: string;
  lightPages: number;
  darkPages: number;
}

export function darkFileName(name: string): string {
  const base = name.replace(/\.pdf$/i, '');
  return `${base}-darkmode.pdf`;
}

let pdfjsModule: Promise<typeof pdfjsType> | null = null;

function loadPdfjs(): Promise<typeof pdfjsType> {
  if (!pdfjsModule) {
    pdfjsModule = import('pdfjs-dist')
      .then(async (m) => {
        const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.mjs?url');
        m.GlobalWorkerOptions.workerSrc = workerUrl;
        return m;
      })
      .catch((err) => {
        pdfjsModule = null;
        throw err;
      });
  }
  return pdfjsModule;
}

export async function convertPdf(options: ConvertOptions): Promise<ConvertResult> {
  const { file, mode, onProgress, shouldCancel } = options;
  const palette = options.palette ?? NEUTRAL_PALETTE;
  if (!fileWithinLimits(file.size)) throw new AppError('fileTooLarge');

  const pdfjs = await loadPdfjs();
  const worker: PixelWorker | null = await createPixelWorker();

  let doc: pdfjsType.PDFDocumentProxy | null = null;
  let loadingTask: pdfjsType.PDFDocumentLoadingTask | null = null;
  let blob: Blob = new Blob();
  let lightPages = 0;
  let darkPages = 0;
  let out: PdfWriter | PdfStreamWriter | null = null;
  let cleanupOpfs: (() => Promise<void>) | null = null;

  try {
    const data = await file.arrayBuffer();
    loadingTask = pdfjs.getDocument({
      data,
      cMapUrl: 'cmaps/',
      cMapPacked: true,
      wasmUrl: 'wasm/',
    });
    doc = await loadingTask.promise;

    const total = doc.numPages;
    if (!pagesWithinLimits(total)) throw new AppError('tooManyPages');

    const base = baseScale(total);
    let workerOk = worker !== null;

    const created = await createOutput(total);
    out = created.writer;
    cleanupOpfs = created.cleanupOpfs;

    for (let i = 1; i <= total; i++) {
      const { stats, workerOk: ok } = await processPage(
        doc,
        i,
        out,
        base,
        worker,
        workerOk,
        mode,
        palette,
        shouldCancel,
      );
      workerOk = ok;
      if (stats.isDark) darkPages++;
      else lightPages++;
      onProgress(i, total);
    }

    if (shouldCancel()) throw new AppError('cancelled');

    if (out instanceof PdfStreamWriter) {
      blob = await out.finalize();
    } else {
      blob = new Blob([out.save()], { type: 'application/pdf' });
    }
  } catch (err) {
    if (out instanceof PdfStreamWriter) await out.abort().catch(() => undefined);
    if (cleanupOpfs) await cleanupOpfs().catch(() => undefined);
    if (err instanceof AppError) throw err;
    const name = (err as { name?: string })?.name;
    const message = err instanceof Error ? err.message : String(err ?? '');
    if (name === 'PasswordException' || /password/i.test(message)) {
      throw new AppError('encrypted', err);
    }
    if (name === 'InvalidPDFException' || /Invalid PDF|format/i.test(message)) {
      throw new AppError('notPdf', err);
    }
    throw new AppError('unknown', err);
  } finally {
    worker?.dispose();
    if (loadingTask) loadingTask.destroy().catch(() => undefined);
  }

  return { blob, fileName: darkFileName(file.name), lightPages, darkPages };
}

async function createOutput(
  total: number,
): Promise<{ writer: PdfWriter | PdfStreamWriter; cleanupOpfs: (() => Promise<void>) | null }> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      'storage' in navigator &&
      typeof navigator.storage?.getDirectory === 'function'
    ) {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(MURIH_OUTPUT_NAME, { create: true });
      const sink = await createOpfsSink(handle);
      return {
        writer: new PdfStreamWriter(sink, total),
        cleanupOpfs: async () => {
          try {
            await root.removeEntry(MURIH_OUTPUT_NAME);
          } catch {
            /* entry already removed */
          }
        },
      };
    }
  } catch {
    /* OPFS unavailable — fall back to in-RAM */
  }
  return { writer: new PdfWriter(), cleanupOpfs: null };
}

async function processPage(
  doc: pdfjsType.PDFDocumentProxy,
  index: number,
  out: PdfWriter | PdfStreamWriter,
  base: number,
  worker: PixelWorker | null,
  workerOk: boolean,
  mode: ConvertMode,
  palette: NightPalette,
  shouldCancel: () => boolean,
): Promise<{ stats: PixelStats; workerOk: boolean }> {
  if (shouldCancel()) throw new AppError('cancelled');

  const page = await doc.getPage(index);
  const points = page.getViewport({ scale: 1 });
  const scale = pageScale(points.width, points.height, base);
  const viewport = page.getViewport({ scale });

  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new AppError('noCanvas');

  const renderTask = page.render({ canvasContext: ctx, canvas, viewport, intent: 'print' });
  const cancelWatch = setInterval(() => {
    if (shouldCancel()) {
      try {
        renderTask.cancel();
      } catch {
        /* render already finished */
      }
    }
  }, 100);
  try {
    await renderTask.promise;
  } catch (err) {
    if (shouldCancel()) throw new AppError('cancelled');
    throw err;
  } finally {
    clearInterval(cancelWatch);
  }

  let stats: PixelStats;
  let workerOkOut = workerOk;
  let image:
    | { kind: 'rgb'; rgb: Uint8Array<ArrayBuffer>; width: number; height: number }
    | { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number };

  if (mode === 'bw') {
    if (worker && workerOkOut) {
      const img = ctx.getImageData(0, 0, width, height);
      try {
        const { stats: fullStats, rgb } = await worker.transform(img.data.buffer, mode, palette, true);
        if (!rgb) throw new Error('worker returned no rgb');
        stats = fullStats;
        canvas.width = 0;
        canvas.height = 0;
        image = { kind: 'rgb', rgb: new Uint8Array(rgb), width, height };
      } catch {
        workerOkOut = false;
        const fallback = transformPixelsOnMainThread(ctx, width, height, mode, palette);
        stats = fallback.stats;
        canvas.width = 0;
        canvas.height = 0;
        image = { kind: 'rgb', rgb: rgbaToRgb(fallback.data, width, height), width, height };
      }
    } else {
      const fallback = transformPixelsOnMainThread(ctx, width, height, mode, palette);
      stats = fallback.stats;
      canvas.width = 0;
      canvas.height = 0;
      image = { kind: 'rgb', rgb: rgbaToRgb(fallback.data, width, height), width, height };
    }
  } else {
    if (worker && workerOkOut) {
      const img = ctx.getImageData(0, 0, width, height);
      try {
        const { buf, stats: fullStats } = await worker.transform(img.data.buffer, mode, palette, false);
        if (!buf) throw new Error('worker returned no rgba');
        ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), width, height), 0, 0);
        stats = fullStats;
      } catch {
        workerOkOut = false;
        const fallback = transformPixelsOnMainThread(ctx, width, height, mode, palette);
        stats = fallback.stats;
      }
    } else {
      const fallback = transformPixelsOnMainThread(ctx, width, height, mode, palette);
      stats = fallback.stats;
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new AppError('encodeFailed'))),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    canvas.width = 0;
    canvas.height = 0;
    image = { kind: 'jpeg', bytes, width, height };
  }

  if (shouldCancel()) throw new AppError('cancelled');

  const view = page.view;
  const mediaBox: [number, number, number, number] =
    points.rotation === 0
      ? [view[0], view[1], view[0] + points.width, view[1] + points.height]
      : [0, 0, points.width, points.height];
  const origin = points.rotation === 0 ? { x: view[0], y: view[1] } : { x: 0, y: 0 };

  await out.addPage({
    widthPts: points.width,
    heightPts: points.height,
    mediaBox,
    drawX: origin.x,
    drawY: origin.y,
    image,
  });

  page.cleanup();
  return { stats, workerOk: workerOkOut };
}
