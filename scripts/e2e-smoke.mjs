import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const PORT = 4174;

async function makeInputPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedStandardFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([400, 600]);
  p1.drawText('LIGHT PAGE', { x: 120, y: 290, size: 20, font, color: rgb(0, 0, 0) });
  const p2 = doc.addPage([400, 600]);
  p2.drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0, 60 / 255, 0) });
  p2.drawText('DARK PAGE', { x: 120, y: 290, size: 20, font, color: rgb(1, 0.9, 0) });
  const p3 = doc.addPage([400, 600]);
  p3.setMediaBox(100, 50, 400, 600);
  p3.drawText('OFFSET PAGE', { x: 120, y: 290, size: 20, font, color: rgb(0, 0, 0) });
  return doc.save();
}

function startPreview() {
  const child = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('preview server did not start'));
      child.kill();
    }, 20000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('Local:')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', () => reject(new Error('preview exited early')));
  });
}

async function hashedChunks() {
  const files = await readdir(join(DIST, 'assets'));
  const hash = '[a-zA-Z0-9_-]+';
  return {
    pdfChunk: files.find((f) => new RegExp(`^pdf-${hash}\\.js$`).test(f)),
    workerFile: files.find((f) => new RegExp(`^pdf\\.worker-${hash}\\.mjs$`).test(f)),
  };
}

async function measureLum(page, pdfChunk, workerFile, outBytes, scale) {
  return page.evaluate(
    async ({ pdfChunk, workerFile, outBytes, scale }) => {
      const m = await import(`/assets/${pdfChunk}`);
      m.GlobalWorkerOptions.workerSrc = `/assets/${workerFile}`;
      const doc = await m.getDocument({ data: new Uint8Array(outBytes) }).promise;
      const results = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        const vp = p.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(vp.width));
        canvas.height = Math.max(1, Math.floor(vp.height));
        const ctx = canvas.getContext('2d');
        await p.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const w = canvas.width;
        const h = canvas.height;
        let sum = 0;
        let n = 0;
        let pure = 0;
        let black = 0;
        let white = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const v = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
            if (x < 3 || y < 3 || x > w - 4 || y > h - 4) {
              sum += v;
              n++;
            }
            if (v < 30) black++;
            else if (v > 200) white++;
            if (v < 30 || v > 200) pure++;
          }
        }
        results.push({
          lum: n === 0 ? 255 : sum / n,
          pureFrac: pure / (w * h),
          hasBlack: black > 0,
          hasWhite: white > 0,
        });
      }
      return results;
    },
    { pdfChunk, workerFile, outBytes: new Uint8Array(outBytes), scale },
  );
}

const server = await startPreview();
let browser;
try {
  const inputBytes = await makeInputPdf();
  const headersText = await readFile(join(ROOT, 'public', '_headers'), 'utf8');
  const csp = headersText.match(/Content-Security-Policy: (.+)/)?.[1]?.trim();
  if (!csp) throw new Error('CSP not found in public/_headers');

  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  const wasmWarnings = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') {
      const text = msg.text();
      if (/wasm|ICC|JBig2|Jbig2|OpenJPEG|openjpeg/i.test(text)) {
        wasmWarnings.push(text);
      }
    }
  });
  await page.setExtraHTTPHeaders({ 'Content-Security-Policy': csp });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });

  const cmap = await page.request.get(`http://localhost:${PORT}/cmaps/78-H.bcmap`);
  if (cmap.status() !== 200) {
    throw new Error(`cmap asset not served (HTTP ${cmap.status()})`);
  }
  const licenseRes = await page.request.get(`http://localhost:${PORT}/licenses/pdfjs-dist.txt`);
  const licenseBody = await licenseRes.text();
  if (licenseRes.status() !== 200 || !/Apache License/.test(licenseBody)) {
    throw new Error(`pdfjs-dist license not served (HTTP ${licenseRes.status()})`);
  }
  for (const wasm of ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm']) {
    const res = await page.request.get(`http://localhost:${PORT}/wasm/${wasm}`);
    const body = await res.body();
    const isWasm = body.length >= 4 && body[0] === 0 && body[1] === 0x61 && body[2] === 0x73 && body[3] === 0x6d;
    if (res.status() !== 200 || !isWasm) {
      throw new Error(
        `wasm asset "${wasm}" not served correctly (HTTP ${res.status()}, wasm magic: ${isWasm})`,
      );
    }
  }

  await page.goto(`http://localhost:${PORT}/`);

  const manifestRes = await page.request.get(`http://localhost:${PORT}/manifest.webmanifest`);
  if (manifestRes.status() !== 200) {
    throw new Error(`manifest not served (HTTP ${manifestRes.status()})`);
  }
  const swRes = await page.request.get(`http://localhost:${PORT}/sw.js`);
  if (swRes.status() !== 200 || !/javascript/i.test(swRes.headers()['content-type'] ?? '')) {
    throw new Error(
      `sw.js not served correctly (HTTP ${swRes.status()}, ${swRes.headers()['content-type']})`,
    );
  }
  const swScope = await page.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) return reg.scope;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  });
  if (!swScope) throw new Error('service worker not registered');

  const dropzoneAttrs = await page.evaluate(() => {
    const el = document.getElementById('dropzone');
    return {
      tabindex: el?.getAttribute('tabindex'),
      ariaLabel: el?.getAttribute('aria-label'),
    };
  });
  if (dropzoneAttrs.tabindex !== '0' || dropzoneAttrs.ariaLabel !== 'اختر ملف PDF') {
    throw new Error(`dropzone a11y mismatch: ${JSON.stringify(dropzoneAttrs)}`);
  }

  const contactHref = await page.evaluate(() =>
    document.querySelector('#app footer a[href^="mailto:"]')?.getAttribute('href') ?? null,
  );
  if (contactHref !== 'mailto:send.zine@gmail.com') {
    throw new Error(`contact link mismatch: ${JSON.stringify(contactHref)}`);
  }

  const defaultMode = await page.evaluate(
    () => document.querySelector('input[name="mode"]:checked')?.value ?? null,
  );
  if (defaultMode !== 'bw') {
    throw new Error(`mode default should be bw, got: ${JSON.stringify(defaultMode)}`);
  }
  const defaultPalette = await page.evaluate(
    () => document.querySelector('input[name="palette"]:checked')?.value ?? null,
  );
  if (defaultPalette !== 'neutral') {
    throw new Error(`palette default should be neutral, got: ${JSON.stringify(defaultPalette)}`);
  }

  await page.setInputFiles('#file', {
    name: 'input-test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(inputBytes),
  });

  await page.waitForSelector('#progress-wrap:not([hidden])');
  const controlsDisabledWhileBusy = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[name="mode"], input[name="palette"]')).every((el) => el.disabled),
  );
  if (!controlsDisabledWhileBusy) {
    throw new Error('mode/palette radios should be disabled while converting');
  }

  await page.waitForSelector('#result', { timeout: 90000 });
  const statsText = await page.textContent('#stats');
  const statsMatch = statsText?.match(/(\d+)[^\d]+(\d+)/);
  const [light, dark] = statsMatch ? [+statsMatch[1], +statsMatch[2]] : [-1, -1];
  if (light !== 2 || dark !== 1) {
    throw new Error(`unexpected page stats: "${statsText}"`);
  }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#download'),
  ]);
  if (download.suggestedFilename() !== 'input-test-darkmode.pdf') {
    throw new Error(`unexpected download filename: "${download.suggestedFilename()}"`);
  }
  const outBytes = await readFile(await download.path());

  const outDoc = await PDFDocument.load(outBytes);
  if (outDoc.getPageCount() !== 3) {
    throw new Error(`expected 3 output pages, got ${outDoc.getPageCount()}`);
  }
  if (!outBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('output is not a PDF');
  }

  const mediaBox = outDoc.getPage(2).getMediaBox();
  if (
    Math.round(mediaBox.x) !== 100 ||
    Math.round(mediaBox.y) !== 50 ||
    Math.round(mediaBox.width) !== 400 ||
    Math.round(mediaBox.height) !== 600
  ) {
    throw new Error(`MediaBox not preserved: ${JSON.stringify(mediaBox)}`);
  }

  const { pdfChunk, workerFile } = await hashedChunks();
  if (!pdfChunk || !workerFile) {
    throw new Error('could not locate pdfjs chunks in dist/assets');
  }

  const lum = await measureLum(page, pdfChunk, workerFile, outBytes, 1);

  if (lum.length !== 3) throw new Error('could not render output pages');
  for (const [idx, value] of lum.entries()) {
    if (value.lum > 64) {
      throw new Error(`page ${idx + 1} border luminance ${value.lum.toFixed(1)} — expected dark`);
    }
    if (value.pureFrac < 0.9) {
      throw new Error(
        `page ${idx + 1} not 2-tone: only ${(value.pureFrac * 100).toFixed(1)}% pure (${(value.lum).toFixed(0)})`,
      );
    }
    if (!value.hasBlack || !value.hasWhite) {
      throw new Error(`page ${idx + 1} missing palette bg or fg in bw output`);
    }
  }

  const bwLum = (await measureLum(page, pdfChunk, workerFile, outBytes, 0.5)).map((r) => r.lum);

  await page.check('input[name="mode"][value="gray"]');
  await page.setInputFiles('#file', {
    name: 'input-test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(inputBytes),
  });
  await page.waitForFunction(() => document.getElementById('result')?.hidden === true);
  await page.waitForSelector('#result', { timeout: 90000 });
  const [grayDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#download'),
  ]);
  const grayBytes = await readFile(await grayDownload.path());
  const grayLum2 = (await measureLum(page, pdfChunk, workerFile, grayBytes, 0.5)).map((r) => r.lum);
  for (const [idx, value] of grayLum2.entries()) {
    if (value > 64) {
      throw new Error(`gray-mode page ${idx + 1} border luminance ${value.toFixed(1)} — expected dark`);
    }
  }
  const grayLumDiffers = bwLum.some((v, i) => Math.abs(v - grayLum2[i]) > 1);
  if (!grayLumDiffers) {
    throw new Error('gray-mode output should differ from bw output');
  }

  await page.check('input[name="mode"][value="bw"]');
  await page.check('input[name="palette"][value="warm"]');
  await page.setInputFiles('#file', {
    name: 'input-test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(inputBytes),
  });
  await page.waitForFunction(() => document.getElementById('result')?.hidden === true);
  await page.waitForSelector('#result', { timeout: 90000 });
  const [warmDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#download'),
  ]);
  const warmBytes = await readFile(await warmDownload.path());
  const warmLum = await measureLum(page, pdfChunk, workerFile, warmBytes, 1);
  if (warmLum.length !== 3) throw new Error('could not render warm-mode output pages');
  for (const [idx, value] of warmLum.entries()) {
    if (value.lum > 64) {
      throw new Error(`warm-mode page ${idx + 1} border luminance ${value.lum.toFixed(1)} — expected dark`);
    }
    if (value.pureFrac < 0.9) {
      throw new Error(
        `warm-mode page ${idx + 1} not 2-tone: only ${(value.pureFrac * 100).toFixed(1)}% pure`,
      );
    }
    if (!value.hasBlack || !value.hasWhite) {
      throw new Error(`warm-mode page ${idx + 1} missing palette bg or fg in output`);
    }
  }

  const outSize = outBytes.length;
  const cspViolations = await page.evaluate(() => window.__cspViolations ?? []);

  await page.context().setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  const offlineOk = await page.evaluate(() => {
    const el = document.getElementById('dropzone');
    return !!el && el.getAttribute('aria-label') === 'اختر ملف PDF';
  });
  await page.context().setOffline(false);
  if (!offlineOk) throw new Error('app shell did not load offline from the service worker');

  if (wasmWarnings.length) {
    throw new Error(`wasm-related console warnings:\n${wasmWarnings.join('\n')}`);
  }
  if (pageErrors.length) {
    throw new Error(`page errors during conversion:\n${pageErrors.join('\n')}`);
  }
  if (cspViolations.length) {
    throw new Error(`CSP violations under shipped policy:\n${cspViolations.join('\n')}`);
  }
  console.log('E2E OK');
  console.log(`  input  pages: 3 (2 light, 1 dark-green/yellow)`);
  console.log(`  stats  UI:    "${statsText}"`);
  console.log(`  output pages: ${outDoc.getPageCount()}, %PDF verified, ${(outSize / 1024).toFixed(0)} KB`);
  console.log(`  bw 2-tone:    page1=${(lum[0].pureFrac * 100).toFixed(1)}% page2=${(lum[1].pureFrac * 100).toFixed(1)}% page3=${(lum[2].pureFrac * 100).toFixed(1)}% pure`);
  console.log(`  border luminance: page1=${lum[0].lum.toFixed(1)} page2=${lum[1].lum.toFixed(1)} page3=${lum[2].lum.toFixed(1)} (all < 64)`);
  console.log(`  gray mode:    re-run OK, borders ${grayLum2.map((v) => v.toFixed(1)).join('/')} (all < 64)`);
  console.log(`  warm palette: re-run OK, 2-tone ${warmLum.map((v) => `${(v.pureFrac * 100).toFixed(1)}%`).join('/')} pure`);
  console.log(`  CSP: ${cspViolations.length} violations under shipped policy`);
  console.log(`  PWA:  sw registered (scope ${swScope}), offline reload OK`);

  await mkdir(join(ROOT, '.e2e'), { recursive: true });
  await writeFile(join(ROOT, '.e2e', 'output.pdf'), outBytes);
} finally {
  if (browser) await browser.close();
  server.kill();
}
