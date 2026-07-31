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
  p2.drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0, 0, 0) });
  p2.drawText('DARK PAGE', { x: 120, y: 290, size: 20, font, color: rgb(1, 1, 1) });
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
  return {
    pdfChunk: files.find((f) => /^pdf-[a-z0-9]+\.js$/i.test(f)),
    workerFile: files.find((f) => /^pdf\.worker-[a-z0-9]+\.(mjs|js)$/i.test(f)),
  };
}

function borderLuminance(data, w, h) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y += 8) {
    for (let x = 0; x < w; x += 8) {
      if (x < 3 || y < 3 || x > w - 4 || y > h - 4) {
        const i = (y * w + x) * 4;
        sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        n++;
      }
    }
  }
  return sum / n;
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

  await page.setInputFiles('#file', {
    name: 'input-test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(inputBytes),
  });

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

  const lum = await page.evaluate(
    async ({ pdfChunk, workerFile, outBytes }) => {
      const m = await import(`/assets/${pdfChunk}`);
      m.GlobalWorkerOptions.workerSrc = `/assets/${workerFile}`;
      const doc = await m.getDocument({ data: new Uint8Array(outBytes) }).promise;
      const results = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        const vp = p.getViewport({ scale: 0.5 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const ctx = canvas.getContext('2d');
        await p.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let sum = 0;
        let n = 0;
        const w = canvas.width;
        const h = canvas.height;
        for (let y = 0; y < h; y += 8) {
          for (let x = 0; x < w; x += 8) {
            if (x < 3 || y < 3 || x > w - 4 || y > h - 4) {
              const i = (y * w + x) * 4;
              sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
              n++;
            }
          }
        }
        results.push(sum / n);
      }
      return results;
    },
    { pdfChunk, workerFile, outBytes: new Uint8Array(outBytes) },
  );

  if (lum.length !== 3) throw new Error('could not render output pages');
  for (const [idx, value] of lum.entries()) {
    if (value > 64) {
      throw new Error(`page ${idx + 1} border luminance ${value.toFixed(1)} — expected dark`);
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
  console.log(`  input  pages: 3 (2 light, 1 dark)`);
  console.log(`  stats  UI:    "${statsText}"`);
  console.log(`  output pages: ${outDoc.getPageCount()}, %PDF verified, ${(outSize / 1024).toFixed(0)} KB`);
  console.log(`  border luminance: page1=${lum[0].toFixed(1)} page2=${lum[1].toFixed(1)} page3=${lum[2].toFixed(1)} (all < 64)`);
  console.log(`  CSP: ${cspViolations.length} violations under shipped policy`);
  console.log(`  PWA:  sw registered (scope ${swScope}), offline reload OK`);

  await mkdir(join(ROOT, '.e2e'), { recursive: true });
  await writeFile(join(ROOT, '.e2e', 'output.pdf'), outBytes);
} finally {
  if (browser) await browser.close();
  server.kill();
}
