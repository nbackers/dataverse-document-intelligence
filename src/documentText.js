/**
 * Document text extraction with automatic scanned-document detection.
 *
 * A scanned PDF is a picture of a page in a PDF wrapper. It has no text layer, so
 * text extraction returns nothing and a downstream prompt silently produces an empty
 * result - the worst failure mode, because nothing errors.
 *
 * This module detects that case and rasterises the pages instead, so a vision prompt
 * can read them.
 */

/** Below this many characters, treat the document as a scan rather than a text layer. */
export const TEXT_LAYER_THRESHOLD = 200;

/** Rasterising more than this makes the image unusable and the prompt call too large. */
export const MAX_RASTER_PAGES = 8;

/** Rendering scale. Below ~1.5 small print stops being legible to the model. */
const RASTER_SCALE = 2.0;

/**
 * @typedef {Object} ExtractionResult
 * @property {'text'|'image'} mode      Which prompt should handle this document.
 * @property {string}        [text]     Extracted text, when mode is 'text'.
 * @property {string}        [imageDataUrl] PNG data URL, when mode is 'image'.
 * @property {boolean}       isScanned  True when there was no usable text layer.
 * @property {number}        pageCount
 * @property {boolean}       truncated  True when pages were dropped at MAX_RASTER_PAGES.
 */

/**
 * Extract from a PDF, falling back to rasterisation when there is no text layer.
 *
 * @param {ArrayBuffer} buffer
 * @param {object} pdfjsLib  The pdf.js library.
 * @returns {Promise<ExtractionResult>}
 */
export async function extractFromPdf(buffer, pdfjsLib) {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(' ') + '\n';
  }

  const trimmed = text.trim();

  if (trimmed.length >= TEXT_LAYER_THRESHOLD) {
    return {
      mode: 'text',
      text: trimmed,
      isScanned: false,
      pageCount: pdf.numPages,
      truncated: false,
    };
  }

  // No usable text layer - the pages have to be read as images.
  const { dataUrl, rendered } = await renderPdfToImage(pdf);

  return {
    mode: 'image',
    imageDataUrl: dataUrl,
    isScanned: true,
    pageCount: pdf.numPages,
    truncated: rendered < pdf.numPages,
  };
}

/**
 * Render PDF pages into a single tall PNG.
 *
 * One image rather than one per page keeps this to a single prompt call.
 *
 * PNG, not JPEG: JPEG compression artefacts land on the thin strokes of small print
 * and cost real accuracy.
 *
 * The canvas is filled white first. Without it, transparent regions flatten to black
 * on export and take the text with them.
 *
 * @param {object} pdf  A pdf.js document proxy.
 * @returns {Promise<{ dataUrl: string, rendered: number }>}
 */
export async function renderPdfToImage(pdf) {
  const pageCount = Math.min(pdf.numPages, MAX_RASTER_PAGES);

  const viewports = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    viewports.push({ page, viewport: page.getViewport({ scale: RASTER_SCALE }) });
  }

  const width = Math.max(...viewports.map((v) => v.viewport.width));
  const height = viewports.reduce((sum, v) => sum + v.viewport.height, 0);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');

  // Must happen before rendering, or transparency exports as black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  let offsetY = 0;
  for (const { page, viewport } of viewports) {
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = viewport.width;
    pageCanvas.height = viewport.height;

    const pageCtx = pageCanvas.getContext('2d');
    pageCtx.fillStyle = '#ffffff';
    pageCtx.fillRect(0, 0, viewport.width, viewport.height);

    await page.render({ canvasContext: pageCtx, viewport }).promise;

    ctx.drawImage(pageCanvas, 0, offsetY);
    offsetY += viewport.height;
  }

  return {
    dataUrl: canvas.toDataURL('image/png'),
    rendered: pageCount,
  };
}

/**
 * Extract text from a DOCX using mammoth.
 *
 * @param {ArrayBuffer} buffer
 * @param {object} mammoth
 * @returns {Promise<ExtractionResult>}
 */
export async function extractFromDocx(buffer, mammoth) {
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  const text = result.value.trim();

  return {
    mode: 'text',
    text,
    isScanned: false,
    pageCount: 0,
    truncated: false,
  };
}

/**
 * Strip the data URL prefix, leaving raw base64.
 *
 * Note the value passed to a Power Automate flow must be converted with
 * base64ToBinary() inside the flow - see docs/ai-builder-findings.md. Passing the
 * string alone results in it being encoded twice, and the service then reports
 * "unable to identify the mimetype".
 *
 * @param {string} dataUrl
 * @returns {string}
 */
export function toBase64(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/**
 * Route a file to the right extractor.
 *
 * @param {File} file
 * @param {{ pdfjsLib: object, mammoth: object }} deps
 * @returns {Promise<ExtractionResult>}
 */
export async function extractDocument(file, deps) {
  const buffer = await file.arrayBuffer();
  const name = file.name.toLowerCase();

  if (name.endsWith('.pdf')) {
    return extractFromPdf(buffer, deps.pdfjsLib);
  }

  if (name.endsWith('.docx')) {
    return extractFromDocx(buffer, deps.mammoth);
  }

  if (name.endsWith('.txt')) {
    const text = new TextDecoder().decode(buffer).trim();
    return { mode: 'text', text, isScanned: false, pageCount: 0, truncated: false };
  }

  throw new Error(`Unsupported file type: ${file.name}`);
}
