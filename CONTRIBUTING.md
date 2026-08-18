# Contributing

The AI Builder findings in this repo were established by testing, against the platform as at 2026.
Platform behaviour changes. **Confirmation or correction is the most valuable contribution here.**

## Especially useful

- **Whether the `Predict` limitation still holds.** If the bound `Predict` action can now be called
  outside the Power Apps host, that changes the architecture and the dual-runtime approach becomes
  unnecessary.
- **Whether PDF is still rejected** as a prompt image input.
- **Whether `additionalContext` ever became a usable file channel.**
- **Scan detection threshold.** 200 characters works in testing. If you find documents it
  misclassifies in either direction, say so.
- **Rasterisation quality.** Scale, page cap and format were chosen by experiment. Better settings
  welcome, with the reasoning.
- **Extraction accuracy patterns.** Prompt fragment styles that measurably improved a field.

When reporting, state the date and, if you can, the region — some behaviours differ.

## Pull requests

1. One concern per PR.
2. Keep the verified/unverified distinction accurate. If you add a claim, say how it was established.
3. Never commit real documents, extracted content, tenant identifiers or environment URLs. Use
   synthetic samples.
4. If you change the prompt definitions, keep both runtimes in step — the point of a shared
   definition is that they cannot drift.
5. Explain *why* in comments where behaviour is non-obvious. Most of this code exists to work around
   something undocumented, and a future reader needs to know which lines are load-bearing.

## Sample documents

Never contribute a real document. Generate synthetic samples that exercise the paths:

- A native-text PDF
- A scanned/image-only PDF, to exercise the vision path
- A document missing several expected fields, to exercise `missingInformation`
- A document with the same field stated twice with different values

## Code of conduct

Be constructive and assume good faith.
