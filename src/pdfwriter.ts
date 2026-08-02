const encoder = new TextEncoder();

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

function fmtRect(box: readonly [number, number, number, number]): string {
  return `${fmtNum(box[0])} ${fmtNum(box[1])} ${fmtNum(box[2])} ${fmtNum(box[3])}`;
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function rgbaToRgb(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const n = width * height;
  const out = new Uint8Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const k = i * 4;
    out[j] = rgba[k];
    out[j + 1] = rgba[k + 1];
    out[j + 2] = rgba[k + 2];
  }
  return out;
}

export async function deflate(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate');
    const reader = cs.readable.getReader();
    const writeAll = (async () => {
      const w = cs.writable.getWriter();
      await w.write(bytes);
      await w.close();
    })();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
    await writeAll;
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of parts) {
      out.set(part, off);
      off += part.length;
    }
    return out;
  } catch {
    return null;
  }
}

export interface RasterPageSpec {
  widthPts: number;
  heightPts: number;
  mediaBox: readonly [number, number, number, number];
  drawX: number;
  drawY: number;
  image:
    | { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number }
    | { kind: 'rgb'; rgb: Uint8Array<ArrayBuffer>; width: number; height: number };
}

function buildContent(widthPts: number, heightPts: number, drawX: number, drawY: number): Uint8Array {
  return encoder.encode(
    `q ${fmtNum(widthPts)} 0 0 ${fmtNum(heightPts)} ${fmtNum(drawX)} ${fmtNum(drawY)} cm /Im0 Do Q\n`,
  );
}

async function encodeImage(
  image: RasterPageSpec['image'],
): Promise<{ filterPart: string; data: Uint8Array }> {
  if (image.kind === 'jpeg') {
    return { filterPart: ' /Filter /DCTDecode', data: image.bytes };
  }
  const deflated = await deflate(image.rgb);
  if (deflated) {
    return { filterPart: ' /Filter /FlateDecode', data: deflated };
  }
  return { filterPart: '', data: image.rgb };
}

function buildCatalog(): Uint8Array {
  return encoder.encode('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
}

function buildPagesTree(count: number): Uint8Array {
  const kids = Array.from({ length: count }, (_, i) => `${3 + i * 3} 0 R`).join(' ');
  return encoder.encode(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${count} >>\nendobj\n`);
}

function buildImageObject(
  ref: number,
  width: number,
  height: number,
  filterPart: string,
  data: Uint8Array,
): Uint8Array {
  return joinBytes([
    encoder.encode(
      `${ref} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height}` +
        ` /ColorSpace /DeviceRGB /BitsPerComponent 8${filterPart} /Length ${data.length} >>\nstream\n`,
    ),
    data,
    encoder.encode('\nendstream\nendobj\n'),
  ]);
}

function buildContentObject(ref: number, content: Uint8Array): Uint8Array {
  return joinBytes([
    encoder.encode(`${ref} 0 obj\n<< /Length ${content.length} >>\nstream\n`),
    content,
    encoder.encode('\nendstream\nendobj\n'),
  ]);
}

function buildPageObject(
  ref: number,
  mediaBox: readonly [number, number, number, number],
  contentRef: number,
  imageRef: number,
): Uint8Array {
  return encoder.encode(
    `${ref} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [${fmtRect(mediaBox)}]` +
      ` /Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 ${imageRef} 0 R >> >>` +
      ` /Contents ${contentRef} 0 R >>\nendobj\n`,
  );
}

function buildXref(offsets: number[], count: number): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(`xref\n0 ${count}\n0000000000 65535 f \n`)];
  for (let n = 1; n < count; n++) {
    parts.push(encoder.encode(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`));
  }
  return joinBytes(parts);
}

function buildTrailer(count: number, startxref: number): Uint8Array {
  return encoder.encode(
    `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`,
  );
}

interface StoredPage {
  mediaBox: readonly [number, number, number, number];
  width: number;
  height: number;
  filterPart: string;
  data: Uint8Array;
  content: Uint8Array;
}

export class PdfWriter {
  private pages: StoredPage[] = [];

  async addPage(spec: RasterPageSpec): Promise<void> {
    const { widthPts, heightPts, mediaBox, drawX, drawY, image } = spec;
    const content = buildContent(widthPts, heightPts, drawX, drawY);
    const { filterPart, data } = await encodeImage(image);
    this.pages.push({
      mediaBox,
      width: image.width,
      height: image.height,
      filterPart,
      data,
      content,
    });
  }

  save(): Uint8Array<ArrayBuffer> {
    const count = 3 + this.pages.length * 3;
    const offsets = new Array<number>(count);
    const parts: Uint8Array[] = [];
    let pos = 0;
    const emit = (b: Uint8Array): void => {
      parts.push(b);
      pos += b.length;
    };

    emit(encoder.encode('%PDF-1.4\n'));
    offsets[1] = pos;
    emit(buildCatalog());
    offsets[2] = pos;
    emit(buildPagesTree(this.pages.length));

    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      const pageRef = 3 + i * 3;
      const contentRef = pageRef + 1;
      const imageRef = pageRef + 2;

      offsets[imageRef] = pos;
      emit(buildImageObject(imageRef, page.width, page.height, page.filterPart, page.data));
      offsets[contentRef] = pos;
      emit(buildContentObject(contentRef, page.content));
      offsets[pageRef] = pos;
      emit(buildPageObject(pageRef, page.mediaBox, contentRef, imageRef));
    }

    const startxref = pos;
    emit(buildXref(offsets, count));
    emit(buildTrailer(count, startxref));
    return joinBytes(parts) as Uint8Array<ArrayBuffer>;
  }
}

export interface PdfSink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  getFile(): Promise<File>;
}

export class PdfStreamWriter {
  private sink: PdfSink;
  private totalPages: number;
  private pos = 0;
  private offsets: number[] = [];
  private started = false;
  private pagesDone = 0;

  constructor(sink: PdfSink, totalPages: number) {
    this.sink = sink;
    this.totalPages = totalPages;
  }

  private async begin(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.write(encoder.encode('%PDF-1.4\n'));
    this.offsets[1] = this.pos;
    await this.write(buildCatalog());
    this.offsets[2] = this.pos;
    await this.write(buildPagesTree(this.totalPages));
  }

  private async write(bytes: Uint8Array): Promise<void> {
    await this.sink.write(bytes);
    this.pos += bytes.length;
  }

  private async writeObject(ref: number, bytes: Uint8Array): Promise<void> {
    this.offsets[ref] = this.pos;
    await this.write(bytes);
  }

  async addPage(spec: RasterPageSpec): Promise<void> {
    await this.begin();
    const { widthPts, heightPts, mediaBox, drawX, drawY, image } = spec;
    const content = buildContent(widthPts, heightPts, drawX, drawY);
    const { filterPart, data } = await encodeImage(image);

    const pageRef = 3 + this.pagesDone * 3;
    const contentRef = pageRef + 1;
    const imageRef = pageRef + 2;

    await this.writeObject(imageRef, buildImageObject(imageRef, image.width, image.height, filterPart, data));
    await this.writeObject(contentRef, buildContentObject(contentRef, content));
    await this.writeObject(pageRef, buildPageObject(pageRef, mediaBox, contentRef, imageRef));
    this.pagesDone++;
  }

  async finalize(): Promise<File> {
    if (this.pagesDone !== this.totalPages) {
      throw new Error(`PdfStreamWriter finalized with ${this.pagesDone}/${this.totalPages} pages`);
    }
    await this.begin();
    const count = 3 + this.totalPages * 3;
    const startxref = this.pos;
    await this.write(buildXref(this.offsets, count));
    await this.write(buildTrailer(count, startxref));
    await this.sink.close();
    return this.sink.getFile();
  }

  async abort(): Promise<void> {
    try {
      await this.sink.close();
    } catch {
      /* sink already closed or unusable */
    }
  }
}

export function createOpfsSink(handle: FileSystemFileHandle): Promise<PdfSink> {
  return handle.createWritable().then((stream) => ({
    async write(bytes) {
      await stream.write(bytes as Uint8Array<ArrayBuffer>);
    },
    async close() {
      await stream.close();
    },
    async getFile() {
      return handle.getFile();
    },
  }));
}
