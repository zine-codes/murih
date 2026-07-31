import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sdRoundedRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function renderIcon(size, { roundedBg, shapeScale }) {
  const px = Buffer.alloc(size * size * 4);
  const edge = 2 / size;
  const out = { r: 0, g: 0, b: 0, a: 0 };

  const paint = (r, g, b, a) => {
    const da = a + out.a * (1 - a);
    if (da <= 0) {
      out.r = out.g = out.b = out.a = 0;
      return;
    }
    out.r = (r * a + out.r * out.a * (1 - a)) / da;
    out.g = (g * a + out.g * out.a * (1 - a)) / da;
    out.b = (b * a + out.b * out.a * (1 - a)) / da;
    out.a = da;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let u = (x + 0.5) / size;
      let v = (y + 0.5) / size;
      if (shapeScale !== 1) {
        u = 0.5 + (u - 0.5) * shapeScale;
        v = 0.5 + (v - 0.5) * shapeScale;
      }
      out.r = out.g = out.b = out.a = 0;

      let a = 1;
      if (roundedBg) {
        a = clamp(0.5 - sdRoundedRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.16) / edge, 0, 1);
      }
      paint(18, 22, 29, a);

      const c1 = Math.hypot(u - 0.4, v - 0.4);
      const c2 = Math.hypot(u - 0.335, v - 0.335);
      const moon = clamp(0.5 - Math.max(c1 - 0.235, -(c2 - 0.185)) / edge, 0, 1);
      if (moon > 0) paint(242, 197, 93, moon);

      let doc = sdRoundedRect(u, v, 0.775, 0.77, 0.11, 0.135, 0.03);
      doc = Math.max(doc, (u - 0.815) - (v - 0.635));
      const docA = clamp(0.5 - doc / edge, 0, 1);
      if (docA > 0) paint(223, 227, 232, docA);

      for (const cy of [0.71, 0.775, 0.84]) {
        const d = sdRoundedRect(u, v, 0.77, cy, 0.065, 0.011, 0.011);
        const lineA = clamp(0.5 - d / edge, 0, 1);
        if (lineA > 0) paint(18, 22, 29, lineA);
      }

      const i = (y * size + x) * 4;
      px[i] = Math.round(out.r);
      px[i + 1] = Math.round(out.g);
      px[i + 2] = Math.round(out.b);
      px[i + 3] = Math.round(out.a * 255);
    }
  }
  return encodePng(size, size, px);
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'pwa-192.png'), renderIcon(192, { roundedBg: true, shapeScale: 1 }));
await writeFile(join(OUT, 'pwa-512.png'), renderIcon(512, { roundedBg: true, shapeScale: 1 }));
await writeFile(join(OUT, 'maskable-512.png'), renderIcon(512, { roundedBg: false, shapeScale: 0.78 }));
await writeFile(join(OUT, 'apple-touch-icon.png'), renderIcon(180, { roundedBg: false, shapeScale: 0.9 }));

await writeFile(
  join(OUT, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#12161d"/>
  <mask id="m"><circle cx="25" cy="25" r="14" fill="#fff"/><circle cx="21" cy="21" r="11" fill="#000"/></mask>
  <circle cx="25" cy="25" r="14" fill="#f2c55d" mask="url(#m)"/>
  <rect x="42" y="40" width="15" height="16" rx="2" fill="#dfe3e8"/>
  <path d="M57 40h-9a3 3 0 0 0-3 3v13l6-6 6 6V40z" fill="#12161d"/>
  <rect x="45" y="45" width="9" height="1.5" rx="0.75" fill="#12161d"/>
  <rect x="45" y="48.5" width="9" height="1.5" rx="0.75" fill="#12161d"/>
  <rect x="45" y="52" width="6" height="1.5" rx="0.75" fill="#12161d"/>
</svg>
`,
);

console.log('icons written to public/');
