import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildExtractionPrompt,
  buildVisionExtractionPrompt,
  validateFieldConfig,
  validateExtractionResult,
} from '../prompts/extraction.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'document-types');
const packs = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }));

test('there are example document types to check', () => {
  assert.ok(packs.length >= 4);
});

for (const pack of packs) {
  test(`${pack.file}: configuration is valid`, () => {
    const result = validateFieldConfig(pack.fields);
    assert.deepEqual(result.errors, []);
    assert.ok(pack.fields.some((f) => f.isRequired), 'at least one required field');
  });

  test(`${pack.file}: builds text and vision prompts with every field`, () => {
    const text = buildExtractionPrompt(pack.documentType, pack.fields);
    const vision = buildVisionExtractionPrompt(pack.documentType, pack.fields);
    for (const f of pack.fields) {
      assert.match(text, new RegExp(`- ${f.name} \\(${f.type}\\)`));
      assert.match(vision, new RegExp(`- ${f.name} \\(${f.type}\\)`));
    }
  });

  test(`${pack.file}: an empty response forces review and lists every field as missing`, () => {
    const r = validateExtractionResult({ fields: {}, missingInformation: [], confidence: 0 }, pack.fields);
    assert.equal(r.ok, true);
    assert.equal(r.requiresReview, true);
    assert.equal(r.missingInformation.length, pack.fields.length);
  });
}

test('invoice: a synthetic response validates and normalises', () => {
  const invoice = packs.find((p) => p.file === 'invoice.json');
  const r = validateExtractionResult(
    {
      fields: {
        supplierName: { value: 'Example Supplies Pty Ltd', confidence: 0.97 },
        supplierTaxId: { value: null, confidence: 0 },
        invoiceNumber: { value: 'INV-10442', confidence: 0.99 },
        invoiceDate: { value: '2026-02-14', confidence: 0.95 },
        dueDate: { value: null, confidence: 0 },
        purchaseOrder: { value: 'PO-7781', confidence: 0.9 },
        currency: { value: 'Yen', confidence: 0.8 },
        totalAmount: { value: 1320.5, confidence: 0.96 },
        taxAmount: { value: 120.05, confidence: 0.92 },
        isCreditNote: { value: false, confidence: 0.9 },
      },
      missingInformation: ['supplierTaxId'],
      confidence: 0.9,
    },
    invoice.fields,
  );
  // "Yen" is not an allowed value, so it is rejected rather than stored.
  assert.equal(r.fields.currency.value, null);
  assert.ok(r.missingInformation.includes('dueDate'));
  assert.ok(r.missingInformation.includes('currency'));
  assert.equal(r.fields.totalAmount.value, 1320.5);
});
