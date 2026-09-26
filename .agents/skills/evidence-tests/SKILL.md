---
name: evidence-tests
description: Use when running or writing the break-it evidence campaign for the PDF job system. Covers the eight PRD §7.11 scenarios: 50-job burst, concurrency cap, repeated failure to dead, growing backoff, killed-worker recovery, idempotency duplicate, two-worker atomic claiming, and manual dead retry — with real captured output, not mocks.
---

# Evidence Tests (break-it testing)

All evidence must come from **actual running behavior** — real logs, real DB state, real HTTP responses. Never mock or fabricate. Store artifacts under `docs/evidence/` and summarize in the final report.

Unless otherwise noted: start the API (`npm run dev`) and worker(s) with distinct `WORKER_ID`s, and use small retry/backoff/stuck values via env for fast, observable results (e.g. `JOB_BACKOFF_BASE_MS=200`, `JOB_STUCK_TIMEOUT_MS=3000`), documenting the values used.

## 1. 50 jobs enqueued at once

- POST 50 requests to `/api/jobs` with unique `Idempotency-Key`s (some in parallel).
- Assert: all return `202`, each with a unique `id`.
- Assert: DB contains exactly 50 rows; all eventually reach `succeeded`.
- Capture: the response list + a status-count summary from the DB.

## 2. Configured concurrency cap holds

- Set `WORKER_CONCURRENCY=3`, enqueue 50 jobs.
- During processing, sample `SELECT count(*) WHERE status = 'processing'` at frequent intervals (or watch worker logs).
- Assert: max concurrently-`processing` count never exceeds 3.
- Capture: the max-observed value + interval sample series.

## 3. Repeated failure eventually dead

- Enqueue a job with the controlled failure switch set to always fail (`attemptsToFail` very high, or `PDF_TEST_FAIL`).
- Assert: it retries and becomes `dead` after exactly `JOB_MAX_ATTEMPTS` failures.
- Assert: `attempts = maxAttempts`, `lastError` non-empty, status `dead`, and it stops retrying.
- Capture: worker fail/dead log lines + final DB row.

## 4. Backoff delays increase

- From the failure-evidence above (or a dedicated job), collect each `delayMs` / `nextRunAt` logged per attempt.
- Assert: delays grow (approximately) exponentially: base, base×2, base×4, ... plus jitter within `[0, JOB_BACKOFF_JITTER_MS)`.
- Capture: a table of attempt → delay → nextRunAt.

## 5. Worker killed during processing → recovery

- Start a worker with a small `JOB_STUCK_TIMEOUT_MS`; enqueue enough jobs that one is mid-`processing`, then hard-kill the worker (e.g. `taskkill /F` / `kill -9`) without graceful shutdown.
- Assert: the job stays `processing` until the timeout, then flips back to `pending` (recovery log emitted) and is eventually completed by a restarted/other worker.
- Capture: the stuck window (startedAt → recoveredAt) and the recovery log line.

## 6. Idempotency key submitted twice

- POST the same body with the same `Idempotency-Key` twice.
- Assert: second response has `created: false` and the same `id`; DB still has exactly one row.
- Capture: both responses + row count.

## 7. Two workers, zero duplicate claims

- Start two worker processes simultaneously (`WORKER_ID` distinct: `worker-a`, `worker-b`), enqueue ≥ 30 jobs.
- Assert: no `jobId` is ever claimed by both workers (scan worker logs for duplicate `claimed` events), and all jobs succeed exactly once.
- Capture: both workers' claimed-job sets and a proof none overlap (e.g. sorted diff).

## 8. Dead job manually retried

- Produce a `dead` job (repeat scenario 3).
- `POST /api/jobs/:id/retry`.
- Assert: status flips to `pending`, `attempts` resets to `0`, `lastError` retained; job succeeds on next worker run.
- Capture: pre/post retry DB rows + final `succeeded` row.

## Deliverable

- Scripts (or documented commands) under `scripts/evidence/` that reproduce every scenario.
- Output artifacts (logs, query results, timing tables) under `docs/evidence/`.
- A final summary mapping each PRD §7.11 / §10 metric to its evidence artifact.