import { transformImageData, type ConvertMode, type PixelStats } from './pixels';

export interface WorkerTransformResult {
  buf: ArrayBuffer;
  stats: PixelStats;
}

export interface PixelWorker {
  transform(buf: ArrayBuffer, mode: ConvertMode): Promise<WorkerTransformResult>;
  dispose(): void;
}

interface PendingEntry {
  resolve: (r: WorkerTransformResult) => void;
  reject: (err: Error) => void;
}

const TRANSFORM_TIMEOUT_MS = 30_000;

function isPixelStats(value: unknown): value is PixelStats {
  const s = value as PixelStats;
  return (
    !!s &&
    typeof s.meanLum === 'number' &&
    typeof s.darkFraction === 'number' &&
    typeof s.isDark === 'boolean'
  );
}

export function createPixelWorker(): Promise<PixelWorker | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./pixel.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      resolve(null);
      return;
    }
    const pending = new Map<number, PendingEntry>();
    let nextId = 0;
    let disposed = false;

    const rejectAll = (err: Error) => {
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
    };

    worker.onmessage = (e: MessageEvent<{ id?: unknown; buf?: unknown; stats?: unknown }>) => {
      const data = e.data;
      const entry = typeof data?.id === 'number' ? pending.get(data.id) : undefined;
      if (!entry) return;
      pending.delete(data.id as number);
      if (!(data.buf instanceof ArrayBuffer) || !isPixelStats(data.stats)) {
        entry.reject(new Error('pixel worker returned malformed data'));
        return;
      }
      entry.resolve({ buf: data.buf, stats: data.stats });
    };
    worker.onerror = () => rejectAll(new Error('pixel worker failed'));

    resolve({
      transform(buf, mode) {
        if (mode !== 'bw' && mode !== 'gray') {
          return Promise.reject(new Error('pixel worker received invalid mode'));
        }
        return new Promise<WorkerTransformResult>((resolveFn, rejectFn) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            if (pending.delete(id)) rejectFn(new Error('pixel worker timed out'));
          }, TRANSFORM_TIMEOUT_MS);
          pending.set(id, {
            resolve: (r) => {
              clearTimeout(timer);
              resolveFn(r);
            },
            reject: (err) => {
              clearTimeout(timer);
              rejectFn(err);
            },
          });
          worker.postMessage({ id, buf, mode }, [buf]);
        });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        rejectAll(new Error('pixel worker disposed'));
        worker.terminate();
      },
    });
  });
}

export function transformPixelsOnMainThread(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mode: ConvertMode,
): PixelStats {
  const image = ctx.getImageData(0, 0, width, height);
  const stats = transformImageData(image.data, mode);
  ctx.putImageData(image, 0, 0);
  return stats;
}
