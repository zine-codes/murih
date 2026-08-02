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
  wantRgb: boolean;
}

self.onmessage = (e: MessageEvent<PixelWorkerMessage>) => {
  const { id, buf, mode, palette, wantRgb } = e.data;
  const data = new Uint8ClampedArray(buf);
  const stats = transformImageData(data, mode, isPalette(palette) ? palette : NEUTRAL_PALETTE);
  if (wantRgb) {
    const n = data.length / 4;
    const rgb = new Uint8Array(n * 3);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const k = i * 4;
      rgb[j] = data[k];
      rgb[j + 1] = data[k + 1];
      rgb[j + 2] = data[k + 2];
    }
    self.postMessage(
      { id, stats, rgb: rgb.buffer } satisfies { id: number; stats: PixelStats; rgb: ArrayBuffer },
      [rgb.buffer],
    );
  } else {
    self.postMessage(
      { id, buf, stats } satisfies { id: number; buf: ArrayBuffer; stats: PixelStats },
      [buf],
    );
  }
};
