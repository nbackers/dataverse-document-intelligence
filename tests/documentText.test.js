import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDocument,
  extractFromPdf,
  fitScale,
  toBase64,
  MAX_FILE_BYTES,
  MAX_RASTER_PAGES,
  RASTER_SCALE,
  TEXT_LAYER_THRESHOLD,
} from '../src/documentText.js';

// Minimal stand-ins for pdf.js and the DOM canvas, enough to drive the code paths.

function fakePdf({ pages, text = '', width = 612, height = 792 }) {
  const state = { destroyed: false };
  const pdf = {
    numPages: pages,
    async getPage() {
      return {
        async getTextContent() {
          return { items: [{ str: text }] };
        },
        getViewport({ scale }) {
          return { width: width * scale, height: height * scale };
        },
        render() {
          return { promise: Promise.resolve() };
        },
      };
    },
    async destroy() {
      state.destroyed = true;
    },
  };
  return { lib: { getDocument: () => ({ promise: Promise.resolve(pdf) }) }, state };
}

let created;
let contextAvailable;

beforeEach(() => {
  created = [];
  contextAvailable = true;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => (contextAvailable ? { fillRect() {}, drawImage() {}, fillStyle: '' } : null),
        toDataURL: (type) => `data:${type};base64,AAAA`,
      };
      created.push(canvas);
      return canvas;
    },
  };
});

afterEach(() => {
  delete globalThis.document;
});

const fileOf = (name, content, size) => ({
  name,
  size: size ?? content.length,
  arrayBuffer: async () => new TextEncoder().encode(content).buffer,
});

test('a PDF with a text layer takes the text path and is released', async () => {
  const { lib, state } = fakePdf({ pages: 2, text: 'x'.repeat(TEXT_LAYER_THRESHOLD) });
  const r = await extractFromPdf(new ArrayBuffer(0), lib);
  assert.equal(r.mode, 'text');
  assert.equal(r.requiresReview, false);
  assert.equal(state.destroyed, true);
});

test('a PDF without a text layer is rasterised into one PNG', async () => {
  const { lib } = fakePdf({ pages: 3, text: '   ' });
  const r = await extractFromPdf(new ArrayBuffer(0), lib);
  assert.equal(r.mode, 'image');
  assert.equal(r.isScanned, true);
  assert.match(r.imageDataUrl, /^data:image\/png;/);
  assert.equal(r.requiresReview, false);
  assert.equal(created[0].height, Math.ceil(792 * RASTER_SCALE * 3));
});

test('dropping pages past the cap forces review', async () => {
  const { lib } = fakePdf({ pages: MAX_RASTER_PAGES + 4 });
  const r = await extractFromPdf(new ArrayBuffer(0), lib);
  assert.equal(r.truncated, true);
  assert.equal(r.requiresReview, true);
  assert.match(r.warnings[0], /Only the first 8 of 12 pages/);
});

test('scale is reduced to fit the canvas limit, and that forces review', async () => {
  // Eight tall pages at scale 2 would exceed 16384 px.
  const { lib } = fakePdf({ pages: 8, height: 1400 });
  const r = await extractFromPdf(new ArrayBuffer(0), lib);
  assert.ok(created[0].height <= 16384);
  assert.equal(r.requiresReview, true);
  assert.ok(r.warnings.some((w) => /canvas limit/.test(w)));
});

test('fitScale keeps the preferred scale when it fits', () => {
  assert.equal(fitScale([{ width: 612, height: 792 }]), RASTER_SCALE);
});

test('a missing 2D context throws a clear error and still releases the PDF', async () => {
  contextAvailable = false;
  const { lib, state } = fakePdf({ pages: 1 });
  await assert.rejects(extractFromPdf(new ArrayBuffer(0), lib), /2D canvas context/);
  assert.equal(state.destroyed, true);
});

test('files over the size limit are rejected before reading', async () => {
  await assert.rejects(extractDocument(fileOf('big.pdf', '', MAX_FILE_BYTES + 1), {}), /limit is 25 MB/);
});

test('txt files are read as text', async () => {
  const r = await extractDocument(fileOf('note.TXT', '  hello  '), {});
  assert.equal(r.mode, 'text');
  assert.equal(r.text, 'hello');
});

test('an image-only DOCX is flagged rather than sent as an empty prompt', async () => {
  const mammoth = { extractRawText: async () => ({ value: '  ' }) };
  const r = await extractDocument(fileOf('scan.docx', 'x'), { mammoth });
  assert.equal(r.requiresReview, true);
});

test('unsupported types throw', async () => {
  await assert.rejects(extractDocument(fileOf('a.xlsx', 'x'), {}), /Unsupported file type/);
});

test('toBase64 strips the data URL prefix', () => {
  assert.equal(toBase64('data:image/png;base64,QUJD'), 'QUJD');
  assert.equal(toBase64('QUJD'), 'QUJD');
});
