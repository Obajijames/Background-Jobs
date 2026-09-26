---
name: env-config
description: Use when setting up environment variables, .env.example, or the config loader for the PDF job system. Covers the required vars DATABASE_URL, WORKER_CONCURRENCY, JOB_MAX_ATTEMPTS, JOB_BACKOFF_BASE_MS, JOB_BACKOFF_JITTER_MS, JOB_STUCK_TIMEOUT_MS and the extra operational vars.
---

# Environment / Config

All operational parameters must live in configuration, not in application logic.

## Required variables (from PRD §7.4)

| Variable | Purpose | Recommended default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/jobs` |
| `WORKER_CONCURRENCY` | Max jobs processed at once per worker | `3` |
| `JOB_MAX_ATTEMPTS` | Retry limit before `dead` | `5` |
| `JOB_BACKOFF_BASE_MS` | Backoff base delay | `1000` |
| `JOB_BACKOFF_JITTER_MS` | Max random jitter added to delay | `500` |
| `JOB_STUCK_TIMEOUT_MS` | `processing` timeout before recovery | `60000` |

## Extra operational variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PDF_OUTPUT_DIR` | Where generated PDFs are written | `output/` |
| `WORKER_POLL_INTERVAL_MS` | Worker poll cadence | `1000` |
| `WORKER_ID` | Identifier used in claim/log attribution | hostname or `worker-1` |
| `PDF_TEST_FAIL` | Test-only failure switch (see pdf-generation skill) | empty |

## Rules

- Commit `.env.example` with every variable and its purpose. Never commit `.env` (gitignore it).
- Defaults are acceptable but document final chosen values in `.env.example` comments and in logs/README.
- Validate config at process startup with zod (or equivalent). Fail fast with a clear message naming the missing/invalid variable — do not silently coerce.
- Concurrency, backoff, attempts, and stuck-timeout values must be readable from config everywhere they are used.

## Config module shape

```ts
// src/lib/config.ts
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().int().positive(),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive(),
  JOB_BACKOFF_BASE_MS: z.coerce.number().nonnegative(),
  JOB_BACKOFF_JITTER_MS: z.coerce.number().nonnegative(),
  JOB_STUCK_TIMEOUT_MS: z.coerce.number().nonnegative(),
  PDF_OUTPUT_DIR: z.string().min(1).default("output"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().nonnegative().default(1000),
  WORKER_ID: z.string().default("worker-default"),
  PDF_TEST_FAIL: z.string().default(""),
});
```

Export validated `config` and log the effective values at startup so they are visible and explainable.