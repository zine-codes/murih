import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const cmapSrc = join(root, 'node_modules', 'pdfjs-dist', 'cmaps');
const cmapDest = join(root, 'public', 'cmaps');
await mkdir(dirname(cmapDest), { recursive: true });
await cp(cmapSrc, cmapDest, { recursive: true });
console.log(`copied pdfjs cmaps -> ${cmapDest}`);

const wasmSrc = join(root, 'node_modules', 'pdfjs-dist', 'wasm');
const wasmDest = join(root, 'public', 'wasm');
await mkdir(wasmDest, { recursive: true });
await cp(wasmSrc, wasmDest, { recursive: true });
console.log(`copied pdfjs wasm -> ${wasmDest}`);

const licensesDest = join(root, 'public', 'licenses');
await mkdir(licensesDest, { recursive: true });
const licenseSrc = join(root, 'node_modules', 'pdfjs-dist', 'LICENSE');
await cp(licenseSrc, join(licensesDest, 'pdfjs-dist.txt'));
console.log(`copied pdfjs LICENSE -> ${join(licensesDest, 'pdfjs-dist.txt')}`);
