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
export const RASTER_SCALE = 2.0;

/**
 * Browsers cap canvas dimensions (commonly 16384 or 32767 px per side, lower on some
 * mobile devices). Stay under the conservative limit and reduce scale if needed.
 */
export const MAX_CANVAS_DIMENSION = 16384;

/** AI Builder prompt file inputs are documented up to 25 MB. Fail early, not in the flow. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * @typedef {Object} ExtractionResult
 * @property {'text'|'image'} mode           Which prompt should handle this document.
 * @property {string}        [text]          Extracted text, when mode is 'text'.
 * @property {string}        [imageDataUrl]  PNG data URL, when mode is 'image'.
 * @property {boolean}       isScanned       True when there was no usable text layer.
 * @property {number}        pageCount
 * @property {boolean}       truncated       True when pages were dropped at MAX_RASTER_PAGES.
 * @property {boolean}       requiresReview  True when the result must not be trusted without a
 *                                           person checking it, for example pages were dropped.
 * @property {string[]}      warnings        Human-readable reasons behind requiresReview.
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

  try {
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((item) => item.str).join(' ') + '\n';
    }

    const trimmed = text.trim();

    if (trimmed.length >= TEXT_LAYER_THRESHOLD) {
      return textResult(trimmed, pdf.numPages);
    }

    // No usable text layer - the pages have to be read as images.
    const { dataUrl, rendered, scale } = await renderPdfToImage(pdf);

    const warnings = [];
    if (rendered < pdf.numPages) {
      warnings.push(
        `Only the first ${rendered} of ${pdf.numPages} pages were read. Fields on later pages will be missing.`,
      );
    }
    if (scale < RASTER_SCALE) {
      warnings.push(
        `Pages were rendered at scale ${scale.toFixed(2)} to fit the canvas limit. Small print may be misread.`,
      );
    }

    return {
      mode: 'image',
      imageDataUrl: dataUrl,
      isScanned: true,
      pageCount: pdf.numPages,
      truncated: rendered < pdf.numPages,
      requiresReview: warnings.length > 0,
      warnings,
    };
  } finally {
    // pdf.js holds worker memory per document until it is destroyed.
    if (typeof pdf.destroy === 'function') {
      await pdf.destroy();
    }
  }
}

/**
 * Choose a render scale that keeps the stacked image inside the canvas limit.
 *
 * @param {Array<{width: number, height: number}>} baseSizes  Page sizes at scale 1.
 * @param {number} [preferred]
 * @param {number} [maxDimension]
 * @returns {number}
 */
export function fitScale(baseSizes, preferred = RASTER_SCALE, maxDimension = MAX_CANVAS_DIMENSION) {
  const width = Math.max(...baseSizes.map((s) => s.width));
  const height = baseSizes.reduce((sum, s) => sum + s.height, 0);
  const limit = Math.min(maxDimension / width, maxDimension / height);
  return Math.min(preferred, limit);
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
 * Scale is reduced below RASTER_SCALE only when the stacked pages would exceed
 * MAX_CANVAS_DIMENSION; the caller flags that for review.
 *
 * @param {object} pdf  A pdf.js document proxy.
 * @returns {Promise<{ dataUrl: string, rendered: number, scale: number }>}
 */
export async function renderPdfToImage(pdf) {
  const pageCount = Math.min(pdf.numPages, MAX_RASTER_PAGES);

  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    pages.push(await pdf.getPage(i));
  }

  const scale = fitScale(pages.map((p) => p.getViewport({ scale: 1 })));
  const viewports = pages.map((page) => ({ page, viewport: page.getViewport({ scale }) }));

  const width = Math.ceil(Math.max(...viewports.map((v) => v.viewport.width)));
  const height = Math.ceil(viewports.reduce((sum, v) => sum + v.viewport.height, 0));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = get2dContext(canvas);

  // Must happen before rendering, or transparency exports as black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  let offsetY = 0;
  for (const { page, viewport } of viewports) {
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = Math.ceil(viewport.width);
    pageCanvas.height = Math.ceil(viewport.height);

    const pageCtx = get2dContext(pageCanvas);
    pageCtx.fillStyle = '#ffffff';
    pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

    await page.render({ canvasContext: pageCtx, viewport }).promise;

    ctx.drawImage(pageCanvas, 0, offsetY);
    offsetY += viewport.height;
  }

  return {
    dataUrl: canvas.toDataURL('image/png'),
    rendered: pageCount,
    scale,
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
  const out = textResult(result.value.trim(), 0);

  if (out.text.length === 0) {
    // A DOCX that is only embedded images has no text. Do not send an empty prompt.
    out.requiresReview = true;
    out.warnings.push('No text was found in the document. It may contain only images.');
  }

  return out;
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
  if (file.size > MAX_FILE_BYTES) {
    const mb = (file.size / 1048576).toFixed(1);
    throw new Error(`${file.name} is ${mb} MB. The limit is ${MAX_FILE_BYTES / 1048576} MB.`);
  }

  const buffer = await file.arrayBuffer();
  const name = file.name.toLowerCase();

  if (name.endsWith('.pdf')) {
    return extractFromPdf(buffer, deps.pdfjsLib);
  }

  if (name.endsWith('.docx')) {
    return extractFromDocx(buffer, deps.mammoth);
  }

  if (name.endsWith('.txt')) {
    return textResult(new TextDecoder().decode(buffer).trim(), 0);
  }

  throw new Error(`Unsupported file type: ${file.name}`);
}

function textResult(text, pageCount) {
  return {
    mode: 'text',
    text,
    isScanned: false,
    pageCount,
    truncated: false,
    requiresReview: false,
    warnings: [],
  };
}

function get2dContext(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // Returned when the canvas is too large for the device or 2D canvas is unavailable.
    throw new Error('Could not create a 2D canvas context to rasterise the document.');
  }
  return ctx;
}
