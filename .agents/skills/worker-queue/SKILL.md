---
name: worker-queue
description: Use when implementing the separate worker process for the PDF job system: polling, atomic pending->processing claims, concurrency cap, exponential backoff with jitter, stuck-job recovery, manual-dead-retry semantics, structured logging, and graceful shutdown.
---

# Worker Process

The worker is a separate process from the Next.js request handler. It polls the `Job` table, claims work atomically, generates PDFs (see pdf-generation skill), and records outcomes. It must survive failures, recover stuck jobs, and never claim the same job as another worker.

## Process entry

`src/worker.ts` run standalone (e.g. `tsx src/worker.ts` / `npm run worker`). It initializes config + Prisma, then starts the poll loop. It must NOT be part of a Next.js request handler.

## Poll loop

Each tick (every `WORKER_POLL_INTERVAL_MS`):

1. While in-flight jobs < `WORKER_CONCURRENCY`, claim due jobs.
2. If nothing claimed, sleep the poll interval and repeat.
3. For each claimed job, run generation with bounded concurrency (a simple semaphore/promise pool sized to `WORKER_CONCURRENCY`).

## Atomic claim (CRITICAL — PRD §5.3)

Never `SELECT` then `UPDATE`. Use a single atomic UPDATE that only succeeds when the row is still `pending` and due, and returns the row it changed:

```ts
const rows = await prisma.$queryRaw<Job[]>`
  UPDATE "Job"
  SET status = 'processing', "startedAt" = now(), "updatedAt" = now()
  WHERE id = (
    SELECT id FROM "Job"
    WHERE status = 'pending' AND "runAt" <= now()
    ORDER BY "runAt"
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *
`;
```

Guard on `rows.length === 1`. `FOR UPDATE SKIP LOCKED` guarantees two workers competing for the same job cannot both claim it — only one wins, the other skips to the next row.

## Run, success, and failure

For each claimed job:

- **Success:** `status = 'succeeded'`, `finishedAt = now()`.
- **Failure:** set `lastError` (string) and transition:
  - If `attempts + 1 < maxAttempts`: `status = 'failed'` then immediately `status = 'pending'`, `runAt = now + backoff(nextAttempt)`. (Semantically the job is pending again; logging can report the `failed` transition per PRD stage-7.)
  - Else: `status = 'dead'`, keep `lastError` and set `finishedAt`.
  - Increment `attempts` on each failure (and on recovery).
- **Crash safety:** never mark a job successful without success; if the worker is killed mid-processing the job stays `processing` and is recovered by the recovery pass below.

Recommended — wrap generation so a `processing -> failed` update only happens on caught error, and a success update only after `generatePdf` resolves.

## Backoff (PRD §5.5)

`delay = BASE * 2^(n-1) + randomJitter`, where `n` is the upcoming attempt number (or `attempts` after increment) and `randomJitter` is uniform in `[0, JOB_BACKOFF_JITTER_MS)`:

```ts
function nextRunAt(attempt: number): Date {
  const base = config.JOB_BACKOFF_BASE_MS;
  const jitter = config.JOB_BACKOFF_JITTER_MS;
  const delay = base * Math.pow(2, attempt - 1) + Math.floor(Math.random() * jitter);
  return new Date(Date.now() + delay);
}
```

All three knobs (`base`, `jitter`, max attempts) come from config. Log the computed delay so the evidence tests can show growing intervals.

## Stuck-job recovery (PRD §5.7)

A separate pass (or the same loop, periodically) finds `processing` rows whose `startedAt` is older than `JOB_STUCK_TIMEOUT_MS` and returns them to `pending`:

- Update by `startedAt <= now() - timeout` and `status = 'processing'`, atomically (row-count guard).
- Increment `attempts`, set `lastError = "recovered: stuck in processing"` and `runAt = now + backoff`, keeping semantics aligned with failure handling.

## Concurrency cap (PRD §5.4)

Cap the number of simultaneously processing jobs to `WORKER_CONCURRENCY`. Implement with a promise pool / semaphore around the claim+run cycle so the check happens near claim time (claiming extra jobs beyond the cap would also break atomicity guarantees for the evidence test on the cap).

## Observability (PRD §7.10)

Structured JSON logs to stdout, one line per lifecycle event. Must make it possible to determine: when a job was claimed, which worker claimed it, when processing started, success/failure, current attempt number, next retry time, when a job became dead, when a stuck job was recovered.

Example:

```json
{ "ts": "...", "workerId": "worker-1", "jobId": "abc", "event": "claimed", "attempt": 1 }
{ "ts": "...", "workerId": "worker-1", "jobId": "abc", "event": "failed", "attempt": 1, "nextRunAt": "...", "delayMs": 1120, "lastError": "..." }
{ "ts": "...", "workerId": "worker-1", "jobId": "abc", "event": "dead", "attempt": 5 }
{ "ts": "...", "workerId": "worker-1", "jobId": "abc", "event": "recovered", "attempt": 2 }
```

Never log secrets or full payload bodies.

## Manual dead retry

The retry route flips `dead -> pending` (see api-routes skill); the worker needs no special handling — it simply picks the job up again on its next poll.

## Graceful shutdown

On SIGINT/SIGTERM: stop claiming new jobs, wait for in-flight jobs to finish (bounded), close Prisma, exit. Do not leave jobs artificially in `processing` longer than necessary.