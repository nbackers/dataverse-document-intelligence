/**
 * Prompt definitions, shared by both runtimes.
 *
 * The wording lives here once and is used by:
 *   - AI Builder custom prompts (in-platform, via the bound Predict action)
 *   - a direct model call (local development, outside the Power Apps host)
 *
 * Keeping one definition means what you develop against and what ships cannot drift.
 *
 * See docs/ai-builder-findings.md for why two runtimes are necessary: the bound
 * Predict action cannot be invoked outside the Power Apps host.
 */

/**
 * Instructions common to every extraction prompt.
 *
 * The "do not infer" rule is the important one. Without it a model will confidently
 * produce a plausible value for a field the document never mentioned, and a plausible
 * wrong value is far more damaging than an admitted gap - a reviewer skims past it.
 */
const SHARED_RULES = `
Return only valid JSON. No commentary, no markdown fences.

For every field return both the value and a confidence between 0 and 1 reflecting how
directly the document supported it.

Do not infer, estimate or calculate a value that is not stated. If the document does not
contain a field, return null for it and add its name to missingInformation. An admitted
gap is useful; an invented value is not.

Do not normalise or reformat values beyond the type requested. Return what the document
says.

If the same field appears more than once with different values, return the one from the
most specific or most recent context and lower the confidence.
`.trim();

/**
 * Output contract. Fixed regardless of which fields are configured, so adding a field
 * cannot break parsing.
 */
const OUTPUT_SHAPE = `
{
  "fields": {
    "<fieldName>": { "value": <value or null>, "confidence": <0..1> }
  },
  "missingInformation": ["<fieldName>", ...],
  "confidence": <0..1 overall>
}
`.trim();

/**
 * Build the extraction prompt for a configured document type.
 *
 * @param {Object} documentType
 * @param {string} documentType.name
 * @param {string} documentType.preamble
 * @param {Array<{name: string, type: string, promptFragment: string, allowedValues?: string[]}>} fields
 * @returns {string}
 */
export function buildExtractionPrompt(documentType, fields) {
  const fieldLines = fields
    .map((f) => {
      const allowed =
        f.allowedValues && f.allowedValues.length
          ? ` One of: ${f.allowedValues.join(', ')}.`
          : '';
      return `- ${f.name} (${f.type}): ${f.promptFragment}${allowed}`;
    })
    .join('\n');

  return `
You are extracting structured data from a ${documentType.name}.

${documentType.preamble}

${SHARED_RULES}

Fields to extract:
${fieldLines}

Return JSON in exactly this shape:
${OUTPUT_SHAPE}
`.trim();
}

/**
 * Build the prompt for a scanned document read as an image.
 *
 * Same fields and same output shape as the text prompt - only the reading instruction
 * differs, so the two paths stay comparable.
 *
 * @param {Object} documentType
 * @param {Array} fields
 * @returns {string}
 */
export function buildVisionExtractionPrompt(documentType, fields) {
  const base = buildExtractionPrompt(documentType, fields);

  return `
${base}

The document is supplied as an image of its pages, stacked vertically in reading order.
Read the pages as a single continuous document.

Where print is unclear, lower the confidence rather than guessing. If a value is
genuinely illegible, return null and add the field to missingInformation.
`.trim();
}

/**
 * Model settings.
 *
 * Temperature 0 because extraction is not a creative task - the same document must
 * produce the same answer every time.
 */
export const MODEL_SETTINGS = {
  temperature: 0,
  responseFormat: 'json_object',
};
