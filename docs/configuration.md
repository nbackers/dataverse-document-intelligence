# Configuration

Defining what gets captured, without changing code.

---

## The idea

Most document-extraction builds hardcode the capture schema, so adding a field means editing a
prompt, a flow and a table. Here the schema is data: users define fields in a configuration UI, and
the prompt is assembled from them at run time.

A new document type becomes configuration rather than a release.

## Configuration tables

### Document type

One row per kind of document being processed.

| Column | Purpose |
|---|---|
| Name | e.g. "Supplier agreement" |
| Description | Shown in the upload UI |
| Target table | Where confirmed records are written |
| Prompt preamble | Context given to the model before the field list |
| Is active | Whether it appears as an option |

### Capture field

The fields to extract, one row each, belonging to a document type.

| Column | Purpose |
|---|---|
| Field name | Logical name in the output |
| Display label | Shown on the validation form |
| Data type | text, number, date, boolean, choice, currency |
| Prompt fragment | What the model should look for |
| Is required | Drives validation on the form |
| Allowed values | For choice fields |
| Target column | Column on the target table |
| Display order | Ordering on the form |
| Is routing signal | Whether the value directs the record downstream |

### Extraction run

One row per document processed, for audit.

| Column | Purpose |
|---|---|
| Document name | Original file name |
| Document type | Which configuration was used |
| Was scanned | Whether the vision path was taken |
| Raw response | Full model output |
| Overall confidence | As reported by the model |
| Missing information | What the document didn't contain |
| Confirmed by | Who validated it |
| Confirmed on | When |
| Target record | The record created on confirmation |

Keeping the raw response matters. When someone questions a value months later, the answer is
whether the model got it wrong or the reviewer approved it wrongly — and only the raw response
settles that.

---

## Assembling the prompt

The prompt is built from the document type's preamble plus each active capture field:

```
<preamble>

Extract the following fields. For each, return the value and a confidence between 0 and 1.
If the document does not contain a field, return null and add it to missingInformation.

Fields:
- <field name> (<type>): <prompt fragment>
- <field name> (<type>): <prompt fragment>
...

Return JSON:
{
  "fields":   { "<field name>": { "value": ..., "confidence": 0.0 } },
  "missingInformation": ["<field name>", ...],
  "confidence": 0.0
}
```

Because the wording is generated from configuration, adding a field cannot break the parsing — the
output shape is fixed and only the field list varies.

## Writing a good prompt fragment

The fragment is what the model uses to find the value. It carries the entire accuracy of that field.

**Weak:**

```
The contract value.
```

**Strong:**

```
The total contract value including any options or extensions. If several currencies appear,
return the value in the contract's stated currency and note the currency separately. If the
value is expressed as a rate rather than a total, return null rather than calculating it.
```

The pattern: say what to look for, how to handle the common ambiguity, and **what to do when it
isn't there**. That last part is what stops a model inventing a plausible number.

## Routing signals

Fields marked as routing signals direct the record downstream — which team reviews it, which
process it enters, whether it needs specialist attention.

These deserve the most carefully written fragments, because a wrong value doesn't just make a field
wrong, it sends the whole record to the wrong place.

Boolean routing signals work better than free text: *does this document involve X* is a question a
model answers reliably, where *what category is this* is not.

## Validation form

Generated from the capture field configuration:

- Fields in display order, with their labels
- Values pre-filled from the extraction
- **Low-confidence values highlighted** rather than presented as equally reliable
- Missing information listed explicitly
- A banner when the document was scanned
- Every field editable

Nothing is written to the target table until submitted.

## Adding a document type

1. Create the document type row and write the preamble.
2. Add capture fields with prompt fragments.
3. Test against three or four real documents, including a scanned one.
4. Review the `confidence` values — anything consistently low means the fragment needs work, not
   that the model is incapable.
5. Activate.

No deployment.
