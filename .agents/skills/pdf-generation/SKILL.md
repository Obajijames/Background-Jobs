---
name: pdf-generation
description: Use when implementing PDFKit report generation for the PDF job system: the validated payload schema, a genuine substantial multi-page report, idempotent output keyed by job ID, output storage, and the controlled failure switch for break-it testing.
---

# PDF Generation (PDFKit)

The worker generates a **genuinely substantial multi-page PDF report** from validated JSON using PDFKit. The PDF must be real work — not an artificial sleep. PDFKit fast-path loophole: a tiny PDF is too fast to demonstrate background processing, so the report builder must produce real multi-page output.

## Payload schema (to be locked with the user)

Recommended (see AGENT.md §4):

```ts
const sectionSchema = z.object({
  heading: z.string().min(1).max(200),
  body: z.array(z.string().min(1)).min(1),
});

export const payloadSchema = z.object({
  reportTitle: z.string().min(1).max(200),
  sections: z.array(sectionSchema).min(3).max(40),
});
```

- Used by the enqueue route (validation before creating a job) and by the worker (reading `payload`).
- The `min(3)` sections floor helps guarantee meaningful multi-page output while staying a real customer-shaped input.

## Report structure

- **Cover page:** report title, generation timestamp, job ID, total page count.
- **Content pages:** one page per section — heading + paragraphs (flow text, word-wrap long bodies so pages genuinely fill).
- **Header:** report title on every content page. **Footer:** `Page X of Y` on every page.
- Use a deterministic layout so the same payload + job ID always yields the same logical document (idempotent output).

## Idempotent output (PRD §5.6)

The **job ID is the stable identifier** for the output. A worker may crash after generating a PDF but before marking success; re-running the job must not create a duplicate logical output.

- Output path: `path.join(config.PDF_OUTPUT_DIR, `${jobId}.pdf`)`.
- Ensure the output dir exists (`fs.mkdirSync(recursive: true)`).
- Write atomically: generate to a temp file then `rename` into place, so a crash mid-write leaves a complete or absent file, never a corrupt final one.
- Re-running overwrites the same `<jobId>.pdf`; no timestamped copies, no per-attempt filenames.

## Controlled failure switch (test-only)

Provide a mechanism that makes a job fail deterministically for break-it testing (retry/dead paths), while the production path stays real PDF generation.

Recommended: payload flag `payload._testFailure = { attemptsToFail: number }` (or env `PDF_TEST_FAIL`). The worker, only when the flag is present, throws an error for the first `attemptsToFail` attempts, then succeeds. Document that this switch exists strictly for evidence tests and is ignored in normal operation. The switch must not replace or skip the PDF generation path.

## Signature

```ts
export async function generatePdf(payload: PdfPayload, jobId: string): Promise<string>
```

Returns the written file path. Throws on failure — the worker decides retry/dead per the queue rules (see worker-queue skill).