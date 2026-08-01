import type * as pdfjsType from 'pdfjs-dist';
import type { PDFDocument } from 'pdf-lib';
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
  bytes: Uint8Array<ArrayBuffer>;
  fileName: string;
  lightPages: number;
  darkPages: number;
}

export function darkFileName(name: string): string {
  const base = name.replace(/\.pdf$/i, '');
  return `${base}-darkmode.pdf`;
}

let pdfjsModule: Promise<typeof pdfjsType> | null = null;
let pdflibModule: Promise<typeof import('pdf-lib')> | null = null;

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

function loadPdfLib(): Promise<typeof import('pdf-lib')> {
  if (!pdflibModule) {
    pdflibModule = import('pdf-lib').catch((err) => {
      pdflibModule = null;
      throw err;
    });
  }
  return pdflibModule;
}

export async function convertPdf(options: ConvertOptions): Promise<ConvertResult> {
  const { file, mode, onProgress, shouldCancel } = options;
  const palette = options.palette ?? NEUTRAL_PALETTE;
  if (!fileWithinLimits(file.size)) throw new AppError('fileTooLarge');

  const pdfjs = await loadPdfjs();
  const { PDFDocument } = await loadPdfLib();
  const worker: PixelWorker | null = await createPixelWorker();

  let doc: pdfjsType.PDFDocumentProxy | null = null;
  let loadingTask: pdfjsType.PDFDocumentLoadingTask | null = null;
  let bytes: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let lightPages = 0;
  let darkPages = 0;

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

    const out = await PDFDocument.create();
    const base = baseScale(total);
    let workerOk = worker !== null;

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

    bytes = (await out.save()) as Uint8Array<ArrayBuffer>;
    if (shouldCancel()) throw new AppError('cancelled');
  } catch (err) {
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

  return { bytes, fileName: darkFileName(file.name), lightPages, darkPages };
}

async function processPage(
  doc: pdfjsType.PDFDocumentProxy,
  index: number,
  out: PDFDocument,
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
  if (worker && workerOk) {
    const image = ctx.getImageData(0, 0, width, height);
    try {
      const { buf, stats: fullStats } = await worker.transform(image.data.buffer, mode, palette);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), width, height), 0, 0);
      stats = fullStats;
    } catch {
      workerOk = false;
      stats = transformPixelsOnMainThread(ctx, width, height, mode, palette);
    }
  } else {
    stats = transformPixelsOnMainThread(ctx, width, height, mode, palette);
  }

  if (shouldCancel()) throw new AppError('cancelled');
  const mime = mode === 'bw' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new AppError('encodeFailed'))),
      mime,
      mode === 'bw' ? undefined : JPEG_QUALITY,
    );
  });
  canvas.width = 0;
  canvas.height = 0;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const image = mode === 'bw' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  const outPage = out.addPage([points.width, points.height]);
  const origin = { x: 0, y: 0 };
  if (points.rotation === 0) {
    const view = page.view;
    outPage.setMediaBox(view[0], view[1], points.width, points.height);
    origin.x = view[0];
    origin.y = view[1];
  }
  outPage.drawImage(image, {
    x: origin.x,
    y: origin.y,
    width: points.width,
    height: points.height,
  });

  page.cleanup();
  return { stats, workerOk };
}
