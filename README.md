# مريح (Murih)

> **حوّل ملفات PDF إلى الوضع الداكن — دون رفعها من جهازك.**
> **Turn PDFs into dark mode — without ever uploading them.**

**Murih** is a small web app that takes any PDF and gives you back a dark-mode
version you can download. Drop a file, pick a mode, download the result. That's it.

Everything runs in your browser — **100% client-side**. Your documents never leave
your device, no account, no sign-up, no tracking.

[![Live](https://img.shields.io/badge/live-murih.pages.dev-blue)](https://murih.pages.dev)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
[![License](https://img.shields.io/badge/license-All%20rights%20reserved-blue)](#licenses)

## مشاريع أخرى | Related projects

More apps by the same author:

- **مريح (Murih)** — this project: <https://murih.pages.dev>
- All other apps: <https://zinedev.pages.dev>

## What makes it different

- **Zero uploads, zero backend.** Files are processed locally with your own CPU.
  Nothing is sent to any server — not the file, not a thumbnail, not analytics.
- **Fast on mobile.** The heavy library (pdf.js) loads only after you drop a
  file, so the app opens instantly. Pixel work runs off the main thread in a
  Web Worker; one page is processed at a time to keep memory low.
- **Installable + offline.** It's a PWA: add it to your home screen, and once
  you've converted online the app keeps working offline too.
- **Arabic (RTL) UI.** The interface is in Arabic, right-to-left.

## How to use it

1. Open the app.
2. Choose a mode and a night palette (see below).
3. Drop your PDF onto the page (or tap to pick it).
4. Download the converted dark-mode PDF.

### The two modes

| Mode | What it does | Best for |
| --- | --- | --- |
| **أبيض وأسود فقط (نصوص)** — `bw` (default) | Every pixel becomes one of two exact colors — a near-black background and an off-white foreground — using Otsu's method (a per-page threshold). Output is crisp 2-tone; colored pages (e.g. dark-green background + yellow text) come out clean instead of a gray mess. | Text documents, forms, papers |
| **تدرج رمادي (مستندات تحتوي صورًا)** — `gray` | Keeps 256 levels of tone. Light pages are flipped into dark mode, dark pages are remapped into the night palette but kept dark. | Documents with photos or graphics |

### Night palette (لون القراءة الليلية)

The output never uses harsh pure black/white — that combo causes glare and
smearing on phones. Instead every converted page is mapped onto a soft night
palette: a near-black background with an off-white foreground (still ~15:1
contrast, comfortably above the WCAG AAA target but far gentler at night).
Pick one in the UI before converting:

- **محايد (neutral)** — `#121212` background / `#E6E6E6` text (default)
- **دافئ (warm)** — `#181512` background / `#EBE3CF` text, cuts blue light further

In both modes, pages that are already dark are **never re-lightened** — they're
remapped into the chosen palette and kept dark.

## Limits

To keep things reliable on phones, files are capped at:

- **50 MB**
- **1000 pages**

If your file fits, the render resolution adapts automatically (300 → 220 → 150 →
96 DPI) so a large document still converts without crashing the tab.

**Note:** the output PDF is made of rasterized page images, so text in the
converted file is **not selectable**. That's a deliberate trade-off for speed and
reliability.

## Privacy

This is the whole point of the project:

- No uploads. The file is read entirely in your browser.
- No network calls at runtime — fonts, pdf.js, and its decoders are all self-hosted.
- A strict Content-Security-Policy blocks any third-party scripts.
- The service worker caches only the app's own assets; your PDFs are never sent
  anywhere. While converting, the output is written to your device's local OPFS
  storage (so memory stays low), is never uploaded, and is replaced the next time
  you convert.

## How it works (for the curious)

1. **Parse** — pdf.js (v6) reads the file, with Arabic/CJK support (`cmaps`) and
   JBIG2/JPEG2000/ICC decoding (`wasm`), all same-origin.
2. **Render** — each page renders to a `<canvas>` at an adaptive DPI, clamped so no
   canvas exceeds the iOS Safari limit (~16.7 MP).
3. **Grayscale + detect** — one pass converts every pixel to luminance (Rec. 709),
   builds a histogram, and classifies the page as light or dark.
4. **Map to the night palette** — `bw` splits the histogram with Otsu and maps
   every pixel to one of the two palette colors; `gray` maps light pages through
   a gamma-aware inverted LUT and remaps dark pages monotonically into the
   palette (kept dark, never re-lightened).
5. **Encode** — `bw` pages become lossless deflated RGB, `gray` pages JPEG
   (q≈0.8), and a small hand-rolled writer (`src/pdfwriter.ts`) assembles the
   output PDF, preserving the original page size (MediaBox). When available, the
   writer streams objects straight to OPFS disk storage instead of holding the
   whole output in RAM, so memory stays flat even for hundreds of pages.

## Tech stack

- [Vite](https://vitejs.dev) + vanilla TypeScript — no framework
- [pdf.js](https://github.com/mozilla/pdf.js) — parsing & rendering (the only
  third-party code shipped)
- `src/pdfwriter.ts` — a small hand-rolled PDF writer (first-party code)
- Web Worker — off-main-thread pixel processing
- Deployed as a static site on Cloudflare Pages

## Licenses

Everything in the bundle is first-party code except pdf.js and its decoders:

- **pdf.js** — [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0).
  The full license ships with the app at `dist/licenses/pdfjs-dist.txt`.
- **cmaps** (Adobe) — BSD-style, license at `dist/cmaps/LICENSE`.
- **wasm decoders** (PDFium/OpenJPEG/qcms, BSD/MIT) — licenses at
  `dist/wasm/LICENSE_*`.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main.ts` | UI glue: drop/pick, cancel (per-run `AbortController`), progress bar, error messages, download. |
| `src/converter.ts` | The conversion driver. Lazy-loads pdf.js only after a file is dropped; owns the page loop, worker fallback, and MediaBox preservation. |
| `src/pixels.ts` | Pure pixel math: luminance, stats classifier, Otsu threshold, binarize, per-mode transform (shared with unit tests). |
| `src/pdfwriter.ts` | First-party PDF writer: embeds JPEG (`/DCTDecode`) and deflated RGB (`/FlateDecode`) page images, preserving the MediaBox. |
| `src/pixel.worker.ts` | Web Worker entry: full-scan stats + transform per mode, returns the transferred buffer. |
| `src/transform.ts` | Worker wrapper: message validation, 120 s timeout, dispose; plus a main-thread fallback. |
| `src/limits.ts` | Hard limits (50 MB, 1000 pages) and canvas scaling/clamping math. |
| `scripts/e2e-smoke.mjs` | Playwright end-to-end test against the production build. |
| `scripts/gen-sw.mjs` | Generates the service worker (`dist/sw.js`) after each build. |
| `public/_headers` | Security headers incl. the Content-Security-Policy. |

## Development

```sh
npm install            # also copies pdf.js cmaps + wasm + license into public/
npm run dev            # local dev server
npm test               # unit tests (pixel math, limits, helpers)
npm run typecheck      # tsc --noEmit
npm run test:e2e       # build + full browser e2e (needs: npx playwright install chromium)
npm run build          # typecheck + vite build + generate service worker → dist/
npm run icons          # regenerate PWA icons into public/
```

## Deploying

It's a static site. Build it, then point any static host at `dist/`:

- **Cloudflare Pages** — build command `npm run build`, build output directory
  `dist/`. `public/_headers` is copied into `dist/` and applies the security
  headers automatically. Enable **HSTS** either in the `_headers` file (already
  shipped) *or* in the Cloudflare dashboard — not both.

## Background behavior

- Pages render with `intent: 'print'`, so conversion keeps going even when you
  switch tabs (the default `'display'` intent pauses when the tab is hidden).
- The pixel worker lives only for the duration of a conversion.
- Not preventable: iOS Safari may suspend background tabs, and closing the browser
  kills the tab.

## Contact

Feedback, feature requests, or bug reports: send.zine@gmail.com

## License

The code in this repository is **all rights reserved** (not open source). The only
third-party code shipped is pdf.js and its decoders, which keep their own licenses
(see [Licenses](#licenses) above).
