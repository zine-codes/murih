import {
  NEUTRAL_PALETTE,
  isPalette,
  transformImageData,
  type ConvertMode,
  type NightPalette,
  type PixelStats,
} from './pixels';

export interface PixelWorkerMessage {
  id: number;
  buf: ArrayBuffer;
  mode: ConvertMode;
  palette: NightPalette;
}

self.onmessage = (e: MessageEvent<PixelWorkerMessage>) => {
  const { id, buf, mode, palette } = e.data;
  const data = new Uint8ClampedArray(buf);
  const stats = transformImageData(data, mode, isPalette(palette) ? palette : NEUTRAL_PALETTE);
  self.postMessage(
    { id, buf, stats } satisfies { id: number; buf: ArrayBuffer; stats: PixelStats },
    [buf],
  );
};
