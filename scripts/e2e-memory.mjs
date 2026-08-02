import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { join } from 'node:path';

function chromeProcs() {
  const procs = [];
  for (const dir of readdirSync('/proc')) {
    if (!/^\d+$/.test(dir)) continue;
    try {
      const cmd = readFileSync(`/proc/${dir}/cmdline`, 'utf8').split('\0');
      if (!cmd.some((c) => c.includes('chrome'))) continue;
      const status = readFileSync(`/proc/${dir}/status`, 'utf8');
      const ppid = parseInt(status.match(/PPid:\s+(\d+)/)?.[1] ?? '0', 10);
      const rssKb = parseInt(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? '0', 10);
      procs.push({ pid: +dir, ppid, rssKb, cmd: cmd.join(' ') });
    } catch {
      /* process gone */
    }
  }
  return procs;
}

function browserPid(marker) {
  const p = chromeProcs().find((x) => x.cmd.includes(marker));
  return p?.pid ?? null;
}

function treeRssKb(browserPid) {
  if (!browserPid) return 0;
  const procs = chromeProcs();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let total = 0;
  for (const p of procs) {
    if (p.pid === browserPid) {
      total += p.rssKb;
      continue;
    }
    let cur = p.pid;
    for (let i = 0; i < 20 && cur; i++) {
      if (cur === browserPid) {
        total += p.rssKb;
        break;
      }
      cur = byPid.get(cur)?.ppid ?? 0;
    }
  }
  return total;
}

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const PORT = 4175;
const PAGES = Number(process.env.MEM_PAGES ?? 40);
const HEAP_MB = Number(process.env.MEM_HEAP_MB ?? 300);
const TIMEOUT_MS = 900_000;

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function noisePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowBytes = w * 3 + 1;
  const raw = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes;
    raw[row] = 0;
    for (let x = 1; x < rowBytes; x++) raw[row + x] = (Math.random() * 256) | 0;
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function makeInputPdf() {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(noisePng(300, 425));
  for (let i = 0; i < PAGES; i++) {
    const p = doc.addPage([595, 842]);
    p.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  }
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

const server = await startPreview();
let context;
try {
  const inputBytes = await makeInputPdf();
  console.log(`fixture: ${PAGES} A4 pages of noise, input ${(inputBytes.length / 1024 / 1024).toFixed(1)} MB`);
  const marker = `/tmp/murih-mem-${Date.now()}`;
  context = await chromium.launchPersistentContext(marker, {
    args: [`--js-flags=--max-old-space-size=${HEAP_MB}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const rootPid = browserPid(marker);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const samples = [];
  let sampling = true;
  (async () => {
    while (sampling) {
      let pct = 0;
      try {
        pct = await page.evaluate(() => {
          const bar = document.getElementById('progress-bar');
          if (!bar || bar.style.width === '') return 0;
          return Number(bar.style.width.replace('%', '')) || 0;
        });
      } catch {
        /* page not ready yet */
      }
      samples.push({ rssKb: treeRssKb(rootPid), pct });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();

  await page.goto(`http://localhost:${PORT}/`);
  await page.check('input[name="mode"][value="gray"]');
  await page.setInputFiles('#file', {
    name: 'mem-stress.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(inputBytes),
  });

  const resultVisible = await page.waitForSelector('#result', { timeout: TIMEOUT_MS }).then(
    () => true,
    () => false,
  );
  sampling = false;
  await new Promise((resolve) => setTimeout(resolve, 250));

  const early = samples.filter((s) => s.pct > 0 && s.pct <= 40);
  const late = samples.filter((s) => s.pct >= 70);
  const earlyPeakMb = early.length ? Math.max(...early.map((s) => s.rssKb)) / 1024 : 0;
  const latePeakMb = late.length ? Math.max(...late.map((s) => s.rssKb)) / 1024 : 0;
  const peakMb = Math.max(...samples.map((s) => s.rssKb)) / 1024;
  const growthMb = latePeakMb - earlyPeakMb;
  let outSize = 0;
  if (resultVisible) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#download'),
    ]);
    const { readFile } = await import('node:fs/promises');
    outSize = (await readFile(await download.path())).length;
  }

  if (!resultVisible) {
    throw new Error(
      `conversion did not finish (heap cap ${HEAP_MB} MB, ${PAGES} pages); page errors: ${pageErrors.join('; ')}`,
    );
  }
  if (early.length && late.length && growthMb > HEAP_MB * 0.5) {
    throw new Error(
      `memory grows during conversion: ${earlyPeakMb.toFixed(0)} MB early (≤40%) → ` +
        `${latePeakMb.toFixed(0)} MB late (≥70%), +${growthMb.toFixed(0)} MB; ` +
        'output is accumulating in RAM instead of streaming to disk',
    );
  }
  console.log('MEM OK');
  console.log(`  pages:       ${PAGES}, mode gray, fixture ${(inputBytes.length / 1024 / 1024).toFixed(1)} MB input`);
  console.log(`  heap cap:    ${HEAP_MB} MB (--max-old-space-size)`);
  console.log(`  peak chrome RSS: ${peakMb.toFixed(0)} MB (${samples.length} samples)`);
  console.log(`  early peak:  ${earlyPeakMb.toFixed(0)} MB (progress ≤40%), late peak ${latePeakMb.toFixed(0)} MB (≥70%)`);
  console.log(`  output:      ${(outSize / 1024 / 1024).toFixed(1)} MB for ${PAGES} pages`);
} finally {
  if (context) await context.close();
  server.kill();
}