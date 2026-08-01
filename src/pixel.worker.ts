import { transformImageData, type ConvertMode, type PixelStats } from './pixels';

export interface PixelWorkerMessage {
  id: number;
  buf: ArrayBuffer;
  mode: ConvertMode;
}

self.onmessage = (e: MessageEvent<PixelWorkerMessage>) => {
  const { id, buf, mode } = e.data;
  const data = new Uint8ClampedArray(buf);
  const stats = transformImageData(data, mode);
  self.postMessage(
    { id, buf, stats } satisfies { id: number; buf: ArrayBuffer; stats: PixelStats },
    [buf],
  );
};
