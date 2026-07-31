# مريح (Murih)

Client-side PDF → dark-mode converter. Drop a PDF, download a dark-mode version.
100% client-side: files never leave the device. Arabic (RTL) UI.

Built with Vite + vanilla TypeScript. Deploys as a static site to Cloudflare Pages
(`dist/`).

## How it works

The core pipeline (per page, one page at a time):

1. **Load** — `pdfjs-dist` (v6) parses the file with `cmaps/` (Arabic/CJK glyphs) and
   `wasm/` (JBIG2 / JPEG2000 / ICC support) served from the same origin.
2. **Render** — each page renders to a `<canvas>` at a DPI that adapts to the file
   (300 → 220 → 150 → 96 as page count grows) and is clamped so no canvas ever
   exceeds ~16.7 MP (iOS Safari canvas cap) or a 16,384 px dimension.
3. **Grayscale + detect** — every pixel is converted to luminance (Rec. 709).
   A page is "dark" when mean luminance < 127 **or** more than 50% of pixels are
   near-black (< 64). The decision uses a full-pixel scan, so an already-dark page
   is never re-lightened.
4. **Invert** — light pages are flipped (255 − luminance) into dark mode; dark
   pages are left dark. Output is 256-level grayscale, not 2-tone.
5. **Encode** — the canvas becomes a JPEG (quality 0.8) and is embedded with
   `pdf-lib`, preserving the original MediaBox. All raster pages are then saved
   into one PDF.

Text in the output is not selectable — output is rasterized. That is an accepted
tradeoff for speed and reliability.

## File map

| File | Purpose |
| --- | --- |
| `src/main.ts` | UI glue: drop/pick, cancel (per-run `AbortController`), progress bar, error mapping, download (blob URL, revoked on reset/`pagehide`). |
| `src/converter.ts` | The conversion driver. Lazy-loads pdf.js + pdf-lib only after a file is dropped. Owns the page loop, worker fallback, and MediaBox preservation. |
| `src/processPage` (`converter.ts`) | One page: render → transform → JPEG → embed into the output document. |
| `src/pixels.ts` | Pure pixel math: luminance, grayscale, `invertPixels`, and the dark/light classifier (shared with unit tests). |
| `src/pixel.worker.ts` | Web Worker entry: computes full-scan stats, inverts only if light, returns the transformed buffer. |
| `src/transform.ts` | Worker wrapper: message validation, 30 s timeout, dispose; plus the main-thread fallback used when a worker can't be created or fails. |
| `src/limits.ts` | Owner-specified hard limits (50 MB, 1000 pages) and the canvas scaling/clamping math. |
| `scripts/copy-assets.mjs` | Copies pdf.js `cmaps/` + `wasm/` into `public/` (runs on `npm install`). |
| `scripts/e2e-smoke.mjs` | Playwright e2e against the production build. |
| `public/_headers` | Cloudflare Pages security headers incl. CSP (see below). |

## Memory & quality model

Browsers die on pixel count, not file size:

- iOS Safari blanks any canvas above 16,777,216 px (iOS < 18). Every render canvas
  is clamped below that.
- A 300 DPI A4 page is ~34 MB of RGBA; pdf.js allocates a second buffer while
  rendering, so peak per-page is ~2 canvases + one JPEG blob.
- `pdf-lib` holds the **entire** output document plus every page image in RAM until
  `save()`.
- That's why only one page is processed at a time and each canvas is freed
  (`canvas.width = 0`) before the next page.

## Security

- Zero network calls at runtime: no CDN fonts, no analytics, no backend. pdf.js
  worker, cmaps, and wasm are all self-hosted.
- A strict Content-Security-Policy is shipped via `public/_headers`
  (`'wasm-unsafe-eval'` is required for pdf.js's WebAssembly decoders).
- No `innerHTML`/`eval`; the only object URLs are downloads, revoked on reset and
  `pagehide`.
- The e2e run injects the exact shipped CSP and fails on any policy violation.

## Development

```sh
npm install            # also runs copy-assets → public/cmaps + public/wasm
npm run dev            # local dev server
npm test               # Vitest: pixel math + limits + pure helpers
npm run typecheck      # tsc --noEmit
npm run test:e2e       # build + Playwright smoke test (needs: npx playwright install chromium)
npm run build          # tsc --noEmit && vite build → dist/
```

## Deploy

Static build output is `dist/`. Cloudflare Pages: build command `npm run build`,
output directory `dist`. `public/_headers` is copied into `dist/` and applied
automatically by Cloudflare Pages.
