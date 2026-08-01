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
- Default output is strict 2-tone: every pixel pure black or pure white via a
  per-page Otsu threshold. An optional `gray` mode keeps 256-level grayscale for
  image-heavy documents. User picks in the UI before dropping the file.
- Per-page auto detection: light pages are binarized/inverted to white-on-black;
  already-dark pages are binarized/grayscaled but never re-lightened (kept dark).
- Fast on mobile: lazy-load pdfjs-dist + pdf-lib only after a file is dropped
  (first paint stays tiny); pixel work off the main thread where possible;
  process one page at a time; free each canvas before the next page.

## Limits (owner-specified, hard)
- Reject input file >= 50 MB or >= 1000 pages, with an Arabic error message.
- Render DPI adapts within the cap (300 → 220 → 150 → 96); never reject a file
  that fits the cap, just downscale. JPEG q≈0.8 (gray mode); `bw` mode encodes
  lossless PNG so 0/255 stays pixel-perfect.

## Memory & quality model (critical)
Browsers die on pixel count, not file size:
- iOS Safari canvas area cap: width*height > 16,777,216 px blanks the canvas
  (iOS < 18; 8192² = 67,108,864 on iOS 18+). CLAMP every render canvas to
  <= ~16.7 MP — a 300 DPI A3 page (~17.4 MP) silently breaks on iPhones.
- ~300 DPI A4 ≈ 34 MB per RGBA canvas; pdf.js allocates a 2nd buffer while
  rendering, so peak per-page ≈ 2 canvases + one image blob.
- `bw` mode: pdf-lib's `embedPng` fully decodes the PNG on the main thread (to read
  width/height) before embedding the original bytes losslessly — a transient decode
  buffer and a brief UI-thread pause per page. JPEG (`gray` mode) has no such step.
- pdf-lib holds the ENTIRE output doc + all images in RAM until save().
- Always process one page at a time and release the canvas before the next.

## Core pipeline
1. pdfjs-dist (v6) loads file; render page → <canvas> (DPI clamped per page).
   Render uses `intent: 'print'` — microtask-chunked, so conversion continues in a
   backgrounded tab (default `'display'` intent uses rAF, which pauses when hidden);
   it is also full-fidelity for rasterization. Keep this intent; it is a contract.
2. ImageData loop: luminance → grayscale + full-scan stats + 256-bin histogram in
   ONE pass (`scanAndHistogram`). Dark pages are never re-lightened.
3. `bw` mode: if the histogram has ≥ 2 distinct levels, split it with Otsu
   (`otsuThreshold`) and map every pixel to pure 0/255 (`binarizePixels`), with
   polarity honoring the dark/light decision. Uniform pages skip Otsu and just
   invert, so a flat page never gets a random threshold. `gray` mode: light pages
   invert (255 − luminance), dark pages stay grayscale.
4. Encode per mode: `bw` → PNG (`embedPng`), `gray` → JPEG q≈0.8 (`embedJpg`);
   pdf-lib builds output PDF preserving the original MediaBox.

## pdf.js + Vite gotchas
- Worker: `pdfjs-dist/build/pdf.worker.mjs?url` (v6). Missing workerSrc is the
  #1 failure mode — verify the production build, not just dev.
- Arabic/CJK PDFs: set `cMapUrl` to `pdfjs-dist/cmaps` or glyphs render as boxes.
- JBIG2/JPEG2000/ICC (scanned PDFs): pass `wasmUrl: 'wasm/'`; copy
  `pdfjs-dist/wasm` → `public/wasm` or those streams fail (worker logs
  "No ICC color space support…" / "JBig2 failed to initialize"). `prepare`
  (`scripts/copy-assets.mjs`) copies cmaps + wasm into `public/`.
- Pixel transform (stats + Otsu/grayscale/inversion) runs in a Web Worker via
  transferred ArrayBuffers (universal support); no OffscreenCanvas needed. Fall
  back to main thread if Worker construction fails.

## Commands
- npm run dev / build / preview (Vite; `npm run build` runs `tsc --noEmit && vite build`
  then `scripts/gen-sw.mjs`, which writes `dist/sw.js`)
- npm run icons (regenerate PWA icons into `public/` via `scripts/generate-icons.mjs`)
- npm test (Vitest) for the inversion + dark-detection core (pure functions)
- npm run test:e2e (Playwright + headless Chromium) — full browser run against the
  production build: drop a 3-page PDF (2 light incl. one with an offset MediaBox,
  1 dark-green/yellow), assert detection stats, mode default + busy-disable,
  download filename, MediaBox preservation, bw 2-tone purity, a gray-mode re-run,
  zero page errors, and zero CSP violations under the exact policy shipped in
  `public/_headers`. Requires `npx playwright install chromium`.
- npm run typecheck (tsc --noEmit)

## PWA
- Installable via `public/manifest.webmanifest` + self-hosted icons (generated by
  `npm run icons`). iOS home-screen requires the opaque `apple-touch-icon.png`.
- `npm run build` runs `scripts/gen-sw.mjs` → `dist/sw.js`. It precaches the app
  shell (index.html + entry assets + icons + wasm decoders) and runtime-caches
  same-origin static assets (pdf.js/pdf-lib chunks, cmaps) stale-while-revalidate,
  so offline conversion works once the needed libraries were used online. The SW
  must NEVER cache user files — only the app's own assets.
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
- pdf-lib is used ONLY for output (`create`/`embed*`/`save`). Its upstream advisories —
  DecodeStream decompression bomb (pdf-lib#1777) and `parseDate` ReDoS (#1773) — require
  `PDFDocument.load()` / `setMetadata()`, which this app never calls. If pdf-lib is ever
  used to read an input PDF, re-audit both.
- Cancellation is a per-run `AbortController` in `main.ts` (`shouldCancel` reads its
  signal); a stale run is abandoned and never touches the DOM.
