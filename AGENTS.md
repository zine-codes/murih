# AGENTS.md

## Product
Client-side PDF → dark-mode converter (downloadable PDF). Drop a PDF, get a
dark-mode version back. 100% client-side; files never leave the device.
Arabic (RTL) UI. Deploy: Cloudflare Pages, static, build dir `dist/`.

Stack: Vite + vanilla TypeScript, no framework.

## Owner requirements (non-negotiable)
- Zero uploads, no backend, no analytics. Nothing may be sent to any server;
  do NOT pull runtime assets (incl. Arabic fonts) from CDNs — bundle/self-host.
- Output PDF is built from rasterized pages. Text is NOT selectable in the
  output — accepted tradeoff for speed/reliability.
- Default output is strict 2-tone mapped onto a night palette: every pixel is
  exactly one of two colors — a near-black background and an off-white foreground —
  via a per-page Otsu threshold. Neutral (#121212 / #E6E6E6) is the default; a warm
  alternative (#181512 / #EBE3CF) is selectable in the UI. An optional `gray` mode
  keeps 256-level tones for image-heavy documents. User picks mode + palette in the
  UI before dropping the file.
- Per-page auto detection: light pages are binarized/inverted onto the night
  palette; already-dark pages are binarized/remapped into the palette range but
  never re-lightened (kept dark).
- Fast on mobile: lazy-load pdfjs-dist only after a file is dropped (first paint
  stays tiny); pixel work off the main thread where possible; process one page at
  a time; free each canvas before the next page.

## Limits (owner-specified, hard)
- Reject input file >= 50 MB or >= 1000 pages, with an Arabic error message.
- Render DPI adapts within the cap (300 → 220 → 150 → 96); never reject a file
  that fits the cap, just downscale. JPEG q≈0.8 (gray mode); `bw` mode embeds
  lossless deflated RGB so the exact 2-tone palette values stay pixel-perfect.

## Memory & quality model (critical)
Browsers die on pixel count, not file size:
- iOS Safari canvas area cap: width*height > 16,777,216 px blanks the canvas
  (iOS < 18; 8192² = 67,108,864 on iOS 18+). CLAMP every render canvas to
  <= ~16.7 MP — a 300 DPI A3 page (~17.4 MP) silently breaks on iPhones.
- ~300 DPI A4 ≈ 34 MB per RGBA canvas; pdf.js allocates a 2nd buffer while
  rendering, so peak per-page ≈ 2 canvases + one image blob.
- `src/pdfwriter.ts` has two writers. The in-RAM `PdfWriter` holds the entire
  output doc + all image streams until `save()` (used as fallback). The primary
  `PdfStreamWriter` streams each object straight to an OPFS-backed sink
  (`navigator.storage.getDirectory()` → `createWritable()`), so output size does
  NOT scale with RAM: a 100-page run stays flat (~610 MB peak chrome RSS vs
  ~1035 MB accumulating pre-fix) and survives a 300 MB heap cap. `converter.ts`
  picks the stream writer when OPFS is available and falls back to `PdfWriter`;
  the two produce byte-identical PDFs (asserted in unit tests). On failure the
  partial OPFS entry is removed.
- `bw` mode: RGB is deflated with the native `CompressionStream('deflate')` (zlib
  format, streaming/async) and embedded as a `/FlateDecode` image stream — no PNG
  round-trip and no main-thread decode step. Browsers without `CompressionStream`
  fall back to an unfiltered raw RGB stream (bigger file, still valid). In `bw`
  mode the RGBA→RGB conversion runs inside the pixel worker (`wantRgb`), so the
  main thread never holds the transformed RGBA buffer; the canvas is zeroed right
  after `getImageData`.
- Always process one page at a time and release the canvas before the next.

## Core pipeline
1. pdfjs-dist (v6) loads file; render page → <canvas> (DPI clamped per page).
   Render uses `intent: 'print'` — microtask-chunked, so conversion continues in a
   backgrounded tab (default `'display'` intent uses rAF, which pauses when hidden);
   it is also full-fidelity for rasterization. Keep this intent; it is a contract.
2. ImageData loop: luminance → grayscale + full-scan stats + 256-bin histogram in
   ONE pass (`scanAndHistogram`). Dark pages are never re-lightened.
3. `bw` mode: if the histogram has ≥ 2 distinct levels, split it with Otsu
   (`otsuThreshold`) and map every pixel to one of the two palette colors
   (`binarizePixels`), with polarity honoring the dark/light decision. Uniform
   pages skip Otsu and map through the palette LUT, so a flat page never gets a
   random threshold. `gray` mode: light pages map through a gamma-aware inverted
   palette LUT (`makeNightLut`); dark pages remap monotonically into the palette
   range (`makeDarkLut`) and are never re-lightened.
4. Encode per mode: `bw` → deflated RGB (`/FlateDecode`), `gray` → JPEG q≈0.8
   (`/DCTDecode`); `src/pdfwriter.ts` (first-party, no third-party code) builds the
   output PDF preserving the original MediaBox.

## pdf.js + Vite gotchas
- Worker: `pdfjs-dist/build/pdf.worker.mjs?url` (v6). Missing workerSrc is the
  #1 failure mode — verify the production build, not just dev.
- Arabic/CJK PDFs: set `cMapUrl` to `pdfjs-dist/cmaps` or glyphs render as boxes.
- JBIG2/JPEG2000/ICC (scanned PDFs): pass `wasmUrl: 'wasm/'`; copy
  `pdfjs-dist/wasm` → `public/wasm` or those streams fail (worker logs
  "No ICC color space support…" / "JBig2 failed to initialize"). `prepare`
  (`scripts/copy-assets.mjs`) copies cmaps + wasm into `public/` and the
  pdfjs-dist LICENSE into `public/licenses/pdfjs-dist.txt`.
- Pixel transform (stats + Otsu/grayscale/inversion) runs in a Web Worker via
  transferred ArrayBuffers (universal support); no OffscreenCanvas needed. Fall
  back to main thread if Worker construction fails. In `bw` mode the worker also
  produces the planar RGB buffer (`wantRgb: true`) so the RGBA→RGB conversion
  never happens on the main thread.

## Commands
- npm run dev / build / preview (Vite; `npm run build` runs `tsc --noEmit && vite build`
  then `scripts/gen-sw.mjs`, which writes `dist/sw.js`)
- npm run icons (regenerate PWA icons into `public/` via `scripts/generate-icons.mjs`)
- npm test (Vitest) for the inversion + dark-detection core (pure functions) and
  the output PDF writer (`src/pdfwriter.ts`)
- npm run test:e2e (Playwright + headless Chromium) — full browser run against the
  production build: drop a 3-page PDF (2 light incl. one with an offset MediaBox,
  1 dark-green/yellow), assert detection stats, mode/palette defaults +
  busy-disable, download filename, MediaBox preservation, bw 2-tone purity, a
  gray-mode re-run, a warm-palette re-run, the shipped pdfjs-dist license file,
  zero page errors, and zero CSP violations under the exact policy shipped in
  `public/_headers`. Requires `npx playwright install chromium`.
- npm run test:mem — Playwright memory stress run against the production build
  (`scripts/e2e-memory.mjs`): converts N noise A4 pages in gray mode under
  `--max-old-space-size` (`MEM_PAGES` default 40, `MEM_HEAP_MB` default 300) and
  fails if chrome RSS grows by >50% of the heap cap between progress ≤40% and
  ≥70% (guards against the output re-accumulating in RAM), or if the run doesn't
  finish at all.
- npm run typecheck (tsc --noEmit)

## PWA
- Installable via `public/manifest.webmanifest` + self-hosted icons (generated by
  `npm run icons`). iOS home-screen requires the opaque `apple-touch-icon.png`.
- `npm run build` runs `scripts/gen-sw.mjs` → `dist/sw.js`. It precaches the app
  shell (index.html + entry assets + icons + wasm decoders + licenses) and
  runtime-caches same-origin static assets (pdf.js chunks, cmaps)
  stale-while-revalidate, so offline conversion works once the needed libraries
  were used online. The SW must NEVER cache user files — only the app's own assets.
- The SW cache name is derived from the build output (hash of the `dist/` file
  list), so every deploy prunes the previous cache and stale assets never
  accumulate.
- SW registered in `src/main.ts` for PROD builds only; registration errors are
  swallowed silently.
- `public/_headers` forces `Cache-Control: no-cache` on `/sw.js` and
  `/manifest.webmanifest`. If the SW/caching behavior changes, extend the e2e.

## Deploy & security
- Cloudflare Pages, static, build dir `dist/`. `public/_headers` is copied into
  `dist/` and applies CSP + other security headers. Keep the CSP in sync with the
  e2e (it parses `public/_headers`); pdf.js needs `'wasm-unsafe-eval'` for its
  WebAssembly decoders and `worker-src 'self'` for the pdf/pixel workers.
- `_headers` ships `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  (Cloudflare Pages does not send it by default). Do NOT also enable HSTS in the
  Cloudflare dashboard — that duplicates the header. It stays green in the e2e because
  browsers ignore HSTS over plain HTTP (the e2e serves http://localhost).
- pdf-lib is a DEV-only dependency, used solely by `scripts/e2e-smoke.mjs` to
  build the input fixture and to verify the output (MediaBox). It is never
  bundled or shipped.
- Licenses: pdfjs-dist (Apache-2.0) is the ONLY third-party runtime component. Its
  LICENSE ships at `dist/licenses/pdfjs-dist.txt` (copied by `prepare`); the cmaps
  (Adobe BSD) and wasm decoders (BSD/MIT) license files ship inside
  `dist/cmaps/` and `dist/wasm/`. The e2e asserts the license file is served.
  Everything else in the bundle is first-party code.
- Cancellation is a per-run `AbortController` in `main.ts` (`shouldCancel` reads its
  signal); a stale run is abandoned and never touches the DOM.
