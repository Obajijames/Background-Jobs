<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENT.md — PDF Job Processing System

Working manual for the agent building the **PDF Job Processing System**.

> **Read `docs/prd.md` in full before starting any work. It is the authoritative source of truth.** This file is the build manual derived from it. Where this file and the PRD conflict, the PRD wins.

## 1. Mission

Build a small background-job system that:

1. Accepts a PDF-generation request via `POST /api/jobs` with an idempotency key.
2. Validates the JSON payload, creates a `pending` Job row in PostgreSQL via Prisma, and returns `202 Accepted` + job ID **immediately**. PDF generation never happens on the request path.
3. Runs a **separate worker process** that polls due jobs, atomically claims them (`pending -> processing`), generates a genuine multi-page PDF with PDFKit, records success/failure, retries failures with exponential backoff + jitter, recovers jobs stuck in `processing`, and moves exhausted jobs to `dead`.
4. Exposes `GET /api/jobs/:id`, a minimal dead-letter view, and a manual retry action for `dead` jobs.

The point of the task is **reliable background-job engineering**, not the PDF product.

## 2. Locked stack (do not change)

- Next.js + TypeScript (strict mode stays enabled)
- PostgreSQL + Prisma (the only database access layer)
- PDFKit (the only PDF generation tool)
- PostgreSQL `Job` table as the queue — **no Redis, RabbitMQ, Kafka, or other broker**
- Worker is a separate process from the request handler
- Deployment is not locked, but must support a separately running worker process

## 3. Non-goals (do not build)

No full UI, landing page, full authentication, user management, PDF editor/document-management product, scheduled business workflows, payment processing, message broker, or PDF generation inside the request handler.

## 4. Lock decisions before coding

The PRD requires these decisions to be explicitly accepted before implementation. **Present them to the user (question tool) and get confirmation. Do not silently change them afterwards.**

| Decision | Recommended default (propose to user) |
| --- | --- |
| PDF job payload schema | `{ reportTitle: string, sections: { heading: string, body: string[] }[] }`, validated, non-empty sections |
| PDF report structure | Cover page (title, date, job ID, page count) + one page per section + footer with `Page X of Y`, header with report title |
| PDF output storage | Filesystem dir `output/`, filename `<jobId>.pdf` |
| `WORKER_CONCURRENCY` | `3` |
| `JOB_MAX_ATTEMPTS` | `5` |
| `JOB_BACKOFF_BASE_MS` | `1000` |
| `JOB_BACKOFF_JITTER_MS` | `500` |
| `JOB_STUCK_TIMEOUT_MS` | `60000` |
| Worker deployment/runtime | `tsx src/worker.ts`, started separately from the Next.js dev server |
| Controlled failure mechanism | Test-only switch (payload flag or env) that makes a job fail deterministically; real path stays genuine PDFKit generation |
| API response envelopes | Success: `{ ... }` object; error: `{ error: { code, message } }` (see §8) |
| Dead-letter retry behavior | `dead -> pending`, `runAt = now`, `attempts` reset to `0`, keep `lastError` for audit |

## 5. Architecture and expected files

```
AGENT.md
docs/prd.md
docs/evidence/                # evidence artifacts produced by the test campaign
.env / .env.example
prisma/schema.prisma          # Job model per PRD §9
src/lib/config.ts             # validated env config
src/lib/prisma.ts             # PrismaClient singleton
src/lib/jobs/backoff.ts       # delay = base * 2^n + jitter
src/lib/jobs/claim.ts         # atomic pending -> processing
src/lib/pdf/generate.ts       # PDFKit multi-page report + idempotent write
src/lib/pdf/payload.ts        # payload validation (zod or equivalent)
src/worker.ts                 # separate worker process (poll, claim, run, recover)
src/app/api/jobs/route.ts     # POST enqueue
src/app/api/jobs/[id]/route.ts# GET status
src/app/api/jobs/dead/route.ts# GET dead-letter list
src/app/api/jobs/[id]/retry/route.ts # POST manual retry
scripts/                      # evidence/test scripts (only if not covered by skills)
```

## 6. Required configuration

Minimum env vars (see PRD §7.4): `DATABASE_URL`, `WORKER_CONCURRENCY`, `JOB_MAX_ATTEMPTS`, `JOB_BACKOFF_BASE_MS`, `JOB_BACKOFF_JITTER_MS`, `JOB_STUCK_TIMEOUT_MS`.

Extra operational vars (implementation decisions, documented): `PDF_OUTPUT_DIR`, `WORKER_POLL_INTERVAL_MS`, `WORKER_ID` (for claim attribution logs), test-only failure switch.

All values must be explainable and visible in logs/config, never hardcoded in application logic. Commit `.env.example`; never commit `.env`.

## 7. Job lifecycle rules (enforce exactly)

Five states only: `pending`, `processing`, `succeeded`, `failed`, `dead`. `failed` = eligible for another attempt. `dead` = retry limit exhausted, human attention required.

- **Enqueue:** validate payload → create Job with `status=pending`, `runAt=now()` → never generate PDF.
- **Claim (atomic):** single UPDATE turning `pending -> processing` with `startedAt=now()`; must be race-safe (row-count guard / `RETURNING`). No separate SELECT-then-UPDATE.
- **Success:** `processing -> succeeded`, set `finishedAt`.
- **Failure:** record `lastError`; increment `attempts`; if `attempts < maxAttempts` → `failed -> pending` with future `runAt = now + backoff`; else → `dead`.
- **Recovery:** jobs in `processing` older than `JOB_STUCK_TIMEOUT_MS` → back to `pending`, increment `attempts`, set `lastError = "stuck processing ... recovered"`, future `runAt` with backoff.
- **Manual retry:** `dead -> pending`, `runAt = now`, `attempts = 0` (decision §4), keep `lastError`.
- **Idempotency:** `idempotencyKey` unique constraint at DB level; duplicate submissions must not create a second row.

## 8. API contract

Consistent error envelope for all endpoints:

```json
{ "error": { "code": "string", "message": "string" } }
```

### `POST /api/jobs`
- Requires `Idempotency-Key` header and `Content-Type: application/json`.
- Validates payload **before** creating the job. Invalid input → `400`, never enqueued.
- Success → `202 Accepted` with `{ "id": "<jobId>", "status": "pending", "created": true }`.
- Duplicate idempotency key → return the existing job (no second row), `created: false`; decide status code with the user (recommended `200`).
- Must never await PDF generation, worker, or any background work.

### `GET /api/jobs/:id`
Returns: `id`, `type`, `status`, `attempts`, `maxAttempts`, `runAt`, `startedAt`, `finishedAt`, `lastError` (when set), `createdAt`, `updatedAt`. Unknown id → `404`.

### `GET /api/jobs/dead`  (dead-letter view)
Lists dead jobs with: `id`, `type`, payload summary (never full sensitive payload), `attempts`, `lastError`, `runAt`, `finishedAt`, `createdAt`.

### `POST /api/jobs/:id/retry`
Only affects `dead` jobs; transitions per §7 manual retry. Not dead → `409`. Unknown id → `404`.

## 9. Coding conventions

- TypeScript strict mode; no `any` leaks.
- Follow existing library usage patterns; check `package.json` before adding a dependency. Zod is acceptable for payload/env validation (does not violate the locked stack).
- Structured JSON logs to stdout for the worker (`workerId`, `jobId`, `event`, timestamps). Logs must never include secrets or full sensitive payloads.
- Idempotent PDF write: output path derived from the job ID, so re-runs overwrite the same logical output instead of creating duplicates.
- Do not add comments beyond what the codebase conventions require.

## 10. Build phases (checklist)

1. Scaffold Next.js + TypeScript strict app; add deps: `@prisma/client`, `prisma`, `pdfkit`, `@types/pdfkit`, `tsx`, `zod`.
2. Lock decisions with the user (§4).
3. Prisma `Job` model per PRD §9 + migrate. (skill: `database-prisma`)
4. Env config module + `.env.example`. (skill: `env-config`)
5. Payload validation + PDF generation with PDFKit, idempotent output. (skill: `pdf-generation`)
6. API routes: enqueue, status, dead list, retry. (skill: `api-routes`)
7. Worker process: atomic claim, concurrency, backoff, recovery, logging. (skill: `worker-queue`)
8. Evidence campaign for all PRD §7.11 scenarios. (skill: `evidence-tests`)
9. Verify: `npm run build`, typecheck, lint, `prisma validate`.

## 11. Evidence requirements (PRD §7.11 and §10)

Must demonstrate from **actual running behavior** (not mocks):

1. 50 jobs enqueued at once.
2. Configured concurrency cap holds.
3. A job fails repeatedly and becomes `dead`.
4. Backoff delays increase between attempts (timestamps/logs show it).
5. Worker killed during processing, job later recovered.
6. Same idempotency key twice → one job.
7. Two workers running simultaneously, zero duplicate claims.
8. A dead job manually retried.

Store artifacts (logs, DB snapshots, timing tables) under `docs/evidence/` and summarize results in the final report.

## 12. Verification before finishing

- `npx prisma validate` and migration applied.
- `npm run build` passes with strict TS.
- Worker starts standalone: `npm run worker` (or documented equivalent).
- API returns `202` on enqueue; `GET /api/jobs/:id` shows full lifecycle.
- Every PRD §7.11 evidence scenario has a reproducible script + captured output.