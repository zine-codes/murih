import { createHash } from 'node:crypto';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');

const ROOT_SHELL = [
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './apple-touch-icon.png',
  './pwa-192.png',
  './pwa-512.png',
  './maskable-512.png',
];

const WASM = [
  './wasm/jbig2.wasm',
  './wasm/openjpeg.wasm',
  './wasm/qcms_bg.wasm',
  './wasm/quickjs-eval.wasm',
];

async function listDist(dir = '') {
  const entries = await readdir(join(DIST, dir), { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listDist(p)));
    else out.push(p);
  }
  return out.sort();
}

const html = await readFile(join(DIST, 'index.html'), 'utf8');
const entryAssets = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => `./${m[1]}`);
const wasm = (
  await Promise.all(
    WASM.map(async (f) => {
      try {
        await access(join(DIST, f.replace(/^\.\//, '')));
        return f;
      } catch {
        return null;
      }
    }),
  )
).filter((f) => f !== null);

const OPTIONAL_SHELL = ['./licenses/pdfjs-dist.txt'];

async function existing(file) {
  try {
    await access(join(DIST, file.replace(/^\.\//, '')));
    return file;
  } catch {
    return null;
  }
}

const shell = [
  ...new Set([...ROOT_SHELL, ...entryAssets, ...wasm, ...(await Promise.all(OPTIONAL_SHELL.map(existing))).filter(Boolean)]),
];
const allFiles = await listDist();
const cacheHash = createHash('sha256').update(JSON.stringify(allFiles)).digest('hex').slice(0, 10);
const CACHE = `murih-${cacheHash}`;

const sw = `const CACHE = ${JSON.stringify(CACHE)};
const base = self.registration.scope;
const SHELL = ${JSON.stringify(shell)}.map((p) => new URL(p, base).href);
const indexUrl = new URL("./index.html", base).href;

const isAppAsset = (url) => {
  const p = url.pathname;
  return (
    p === "/" ||
    p.endsWith("/index.html") ||
    p.startsWith("/assets/") ||
    p.startsWith("/cmaps/") ||
    p.startsWith("/wasm/") ||
    p.startsWith("/licenses/") ||
    p.endsWith("/manifest.webmanifest") ||
    p.endsWith("/favicon.svg") ||
    p.includes("/pwa-") ||
    p.includes("/maskable-") ||
    p.endsWith("/apple-touch-icon.png")
  );
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(indexUrl, copy));
          }
          return response;
        })
        .catch(() => caches.match(indexUrl)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && isAppAsset(url)) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
`;

await writeFile(join(DIST, 'sw.js'), sw);
console.log(`sw.js written to dist/ (cache ${CACHE}, ${shell.length} precached assets)`);
