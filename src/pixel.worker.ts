import { invertPixels, processImageData, type PixelStats } from './pixels';

export interface PixelWorkerMessage {
  id: number;
  buf: ArrayBuffer;
}

self.onmessage = (e: MessageEvent<PixelWorkerMessage>) => {
  const { id, buf } = e.data;
  const data = new Uint8ClampedArray(buf);
  const stats = processImageData(data);
  if (!stats.isDark) invertPixels(data);
  self.postMessage({ id, buf, stats } satisfies { id: number; buf: ArrayBuffer; stats: PixelStats }, [
    buf,
  ]);
};
