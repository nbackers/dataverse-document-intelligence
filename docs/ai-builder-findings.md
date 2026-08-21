# AI Builder findings

Behaviours established by testing, not documentation. Each cost real time to find.

Established against AI Builder custom prompts (GPT) in 2026. Verify before relying on any of it - and please open an issue if something has changed.

---

## 1. `Predict` cannot be called outside the Power Apps host

The bound `Predict` action on a custom prompt rejects every call made from outside Power Apps:

```
InvalidRequest: Source is null
```

**Tested:** ten `source` parameter values, six header variants, three payload shapes. The payload
itself was confirmed correct against the published `PredictionSchema`.

The `source` parameter does not bind for a token issued to anything other than the Power Apps
client. This is not a payload problem and cannot be worked around by changing the request.

**Consequence.** AI Builder prompts are the right answer *in* Power Apps - solution-portable,
governed by the platform, no separate Azure dependency. They cannot be used from a local dev server,
a console app, or any external caller. If you need to run outside the host, you need a second
runtime with the same prompt text.

## 2. A document input is an object, not a string

`type: 'document'` on a prompt input produces this in the run data specification:

```json
{ "base64Encoded": "..." }
```

Not a plain `Base64String`. Passing raw base64 directly to the input does nothing useful.

## 3. `additionalContext` is not the file channel

AI Builder adds an optional `additionalContext` of type `Base64String` to **every** prompt
specification, including text-only prompts. It looks exactly like where a file belongs.

It is not. The prompt never reads it.

**This is the worst failure mode in the whole pipeline**: extraction succeeds, returns a well-formed
result with empty fields, and raises no error. There is nothing to investigate. If your extraction
returns empty fields for a document you know contains the data, check this first.

## 4. The value must be binary, not a base64 string

Passing the base64 string leaves the platform to encode it a second time. The service then sniffs
base64 *text* rather than an image.

The symptom that finally revealed this: a **valid one-pixel PNG** returned *"unable to identify the
mimetype"*.

Wrap the value in `base64ToBinary()` inside the flow:

```
base64ToBinary(triggerBody()['file'])
```

It must be applied to a **trigger value**, not a literal. A Logic Apps expression is capped at
**8192 characters**, and a page of scanned document is several hundred thousand.

## 5. PDF is rejected as a prompt image input

Passing a PDF to a document/image input returns:

> "You uploaded an unsupported image"

...and lists `png`, `jpeg`, `gif`, `webp`. This **contradicts the AI Builder documentation**.

Hence rasterising in the browser before the call.

### Rasterisation details that matter
- **One tall PNG, not one image per page.** Keeps it to a single prompt call.
- **PNG, not JPEG.** JPEG artefacts land on the thin strokes of small print and cost accuracy.
- **Fill the canvas white first.** Transparent regions flatten to black on export and take the text
  with them.
- **Scale 2.0.** Below about 1.5, small print stops being legible to the model.
- **Cap at eight pages.** Beyond that the image is unwieldy and the call too large.

## 6. `GetPredictionSchema` returns 404 for GPT prompts

The obvious way to discover a prompt's expected input shape doesn't work here - it is for form
processing models only.

Shape has to be established by probing.

---

## Diagnosing failures

**The app only ever sees `502 BadGateway`** from the connector gateway. That message is useless.
The real error is in the **flow run's action output**.

### Testing payload variants efficiently

A Power Apps triggered flow can only be run from the app, which makes iteration slow.

Build a probe flow on a **recurrence** trigger instead. It can be run on demand, and several payload
variants can sit in one flow as separate actions - so a single run reports on all of them at once.

That turns a multi-hour bisect into one run.

---

## Detecting a scanned document

A scanned PDF has no text layer, so extraction returns an empty string and the prompt silently
produces empty fields.

Threshold used here:

```js
const TEXT_LAYER_THRESHOLD = 200;  // characters
```

Below 200 characters, treat it as a scan and rasterise. The threshold exists because scanned PDFs
often carry stray whitespace or a handful of stamp characters, so testing for *empty* is not enough.

**Flag scanned documents to the reviewer.** Extraction from pages the model read itself warrants
closer checking than a native text layer, and the reviewer should know which they're looking at.

---

## What extraction should return

Beyond the captured fields:

| Field | Why |
|---|---|
| `confidence` | Lets the UI highlight uncertain values instead of presenting everything as equally reliable |
| `missingInformation` | States what the document did not contain, so the reviewer knows what to chase |

Both surfaced in the UI. An extraction that silently guesses is worse than one that admits a gap.

---

## Prompt settings

| Setting | Value | Why |
|---|---|---|
| Temperature | `0` | Extraction is not a creative task; the same document must give the same answer |
| Response format | `json_object` | Structured output, no prose to parse |

## Data residency

If documents contain personal information, the region the model runs in is a compliance question,
not a performance one. Contract and HR documents routinely contain personal information.

Check the deployment region before assuming a default is acceptable.
