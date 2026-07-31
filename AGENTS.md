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
- Grayscale (256 levels), not strict 2-tone.
- Per-page auto detection: light pages are grayscaled + inverted; already-dark
  pages are grayscaled but never re-lightened (kept dark).
- Fast on mobile: lazy-load pdfjs-dist + pdf-lib only after a file is dropped
  (first paint stays tiny); pixel work off the main thread where possible;
  process one page at a time; free each canvas before the next page.

## Limits (owner-specified, hard)
- Reject input file >= 50 MB or >= 1000 pages, with an Arabic error message.
- Render DPI adapts within the cap (300 → 220 → 150 → 96); never reject a file
  that fits the cap, just downscale. JPEG q≈0.8.

## Memory & quality model (critical)
Browsers die on pixel count, not file size:
- iOS Safari canvas area cap: width*height > 16,777,216 px blanks the canvas
  (iOS < 18; 8192² = 67,108,864 on iOS 18+). CLAMP every render canvas to
  <= ~16.7 MP — a 300 DPI A3 page (~17.4 MP) silently breaks on iPhones.
- ~300 DPI A4 ≈ 34 MB per RGBA canvas; pdf.js allocates a 2nd buffer while
  rendering, so peak per-page ≈ 2 canvases + JPEG blob.
- pdf-lib holds the ENTIRE output doc + all images in RAM until save().
- Always process one page at a time and release the canvas before the next.

## Core pipeline
1. pdfjs-dist (v6) loads file; render page → <canvas> (DPI clamped per page).
2. ImageData loop: luminance → grayscale; invert only if page is light.
3. Dark/light decision: page is "dark" when mean luminance < ~127 or
   > 50% of pixels are near-black — reuse this function in tests. The invert
   decision uses the FULL-scan stats (not sampling) so a dark page is never
   re-lightened; the pixel worker computes stats then flips in a second pass.
4. JPEG per page; pdf-lib builds output PDF preserving the original MediaBox.

## pdf.js + Vite gotchas
- Worker: `pdfjs-dist/build/pdf.worker.mjs?url` (v6). Missing workerSrc is the
  #1 failure mode — verify the production build, not just dev.
- Arabic/CJK PDFs: set `cMapUrl` to `pdfjs-dist/cmaps` or glyphs render as boxes.
- JBIG2/JPEG2000/ICC (scanned PDFs): pass `wasmUrl: 'wasm/'`; copy
  `pdfjs-dist/wasm` → `public/wasm` or those streams fail (worker logs
  "No ICC color space support…" / "JBig2 failed to initialize"). `prepare`
  (`scripts/copy-assets.mjs`) copies cmaps + wasm into `public/`.
- Pixel inversion runs in a Web Worker via transferred ArrayBuffers (universal
  support); no OffscreenCanvas needed. Fall back to main thread if Worker
  construction fails.

## Commands
- npm run dev / build / preview (Vite; `npm run build` outputs to `dist/`)
- npm test (Vitest) for the inversion + dark-detection core (pure functions)
- npm run test:e2e (Playwright + headless Chromium) — full browser run against the
  production build: drop a 3-page PDF (2 light incl. one with an offset MediaBox,
  1 dark), assert detection stats, download filename, MediaBox preservation, output
  border luminance, zero page errors, and zero CSP violations under the exact policy
  shipped in `public/_headers`. Requires `npx playwright install chromium`.
- npm run typecheck (tsc --noEmit)

## Deploy & security
- Cloudflare Pages, static, build dir `dist/`. `public/_headers` is copied into
  `dist/` and applies CSP + other security headers. Keep the CSP in sync with the
  e2e (it parses `public/_headers`); pdf.js needs `'wasm-unsafe-eval'` for its
  WebAssembly decoders and `worker-src 'self'` for the pdf/pixel workers.
- Cancellation is a per-run `AbortController` in `main.ts` (`shouldCancel` reads its
  signal); a stale run is abandoned and never touches the DOM.
