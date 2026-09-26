---
name: api-routes
description: Use when building the Next.js App Router API routes for the PDF job system: POST /api/jobs enqueue (202 + idempotency key), GET /api/jobs/[id] status, GET /api/jobs/dead dead-letter list, and POST /api/jobs/[id]/retry. Covers validation, consistent error envelopes, and never generating PDFs on the request path.
---

# API Routes (Next.js + TypeScript)

The API must never generate a PDF or wait for the worker. It only enqueues and reads state.

## Response envelope

Every error uses a consistent shape:

```json
{ "error": { "code": "string", "message": "string" } }
```

Status codes: `202` accepted, `200` ok / duplicate, `400` invalid input, `404` unknown job, `409` wrong state.

## `POST /api/jobs` (enqueue)

1. Read `Idempotency-Key` header — required. Missing → `400` with code `idempotency_key_required`.
2. Parse and validate the JSON body against the payload schema (see pdf-generation skill). Invalid → `400` (code `invalid_payload`). **Invalid input must never reach the queue.**
3. Create the Job with `status: "pending"`, `type: "pdf.generate"`, `maxAttempts` from config, `runAt: new Date()`, `idempotencyKey` from the header.
4. Catch Prisma unique-constraint error `P2002` on `idempotencyKey`: return the existing job with `created: false` (no new row).
5. Respond `202 Accepted` with `{ "id": jobId, "status": "pending", "created": true }`.

Route handler example skeleton:

```ts
export async function POST(req: NextRequest) {
  const idempotencyKey = req.headers.get("Idempotency-Key");
  if (!idempotencyKey) {
    return NextResponse.json({ error: { code: "idempotency_key_required", message: "..." } }, { status: 400 });
  }
  const parsed = payloadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "invalid_payload", message: "..." } }, { status: 400 });
  }
  try {
    const job = await prisma.job.create({ data: { type: "pdf.generate", payload: parsed.data, maxAttempts: config.JOB_MAX_ATTEMPTS, idempotencyKey } });
    return NextResponse.json({ id: job.id, status: job.status, created: true }, { status: 202 });
  } catch (e) {
    if (isPrismaUniqueError(e)) {
      const existing = await prisma.job.findUnique({ where: { idempotencyKey } });
      return NextResponse.json({ id: existing!.id, status: existing!.status, created: false }, { status: 200 });
    }
    return NextResponse.json({ error: { code: "internal", message: "..." } }, { status: 500 });
  }
}
```

## `GET /api/jobs/[id]` (status)

Return `id`, `type`, `status`, `attempts`, `maxAttempts`, `runAt`, `startedAt`, `finishedAt`, `lastError` (when set), `createdAt`, `updatedAt`. Unknown id → `404` (code `job_not_found`). This is what clients poll.

## `GET /api/jobs/dead` (dead-letter view)

Minimal status view listing dead jobs: `id`, `type`, **payload summary** (never full payload), `attempts`, `lastError`, `runAt`, `finishedAt`, `createdAt`. Sort newest first.

## `POST /api/jobs/[id]/retry` (manual retry)

Only transitions a `dead` job to `pending`. Behavior: `status = pending`, `runAt = now`, `attempts = 0`, `lastError` kept (see AGENT.md §7). If job is not `dead` → `409` (code `wrong_state`). Unknown id → `404`.

## Notes

- Route ordering: static `dead` route must not be shadowed by the dynamic `[id]` route; define `/api/jobs/dead` before `/api/jobs/[id]` semantics if both coexist.
- Never call `generatePdf()` from any route handler.
- No full auth; authentication is out of scope.