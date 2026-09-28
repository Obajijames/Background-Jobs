# PDF Job Processing System

A background-job system that accepts PDF report requests over HTTP, returns immediately, and generates multi-page PDFs in a **separate worker process** against a PostgreSQL job queue.

- `POST /api/jobs` validates the payload, inserts a `pending` row, and returns `202` — PDF generation never happens on the request path.
- The worker atomically claims due jobs (`pending -> processing`), renders the report with PDFKit, and writes to `output/<jobId>.pdf`.
- Failures retry with exponential backoff + jitter until `JOB_MAX_ATTEMPTS` is exhausted, then the job lands in `dead` with a dead-letter view and a manual retry endpoint.

The root page (`src/app/page.tsx`) is a small test console for enqueueing jobs, watching status, and retrying dead ones.

## Prerequisites

- Node.js 20+
- A running PostgreSQL instance

## Getting Started

1. **Install dependencies**

   ```bash
   npm install
   ```

   `postinstall` runs `prisma generate`, so the Prisma client is built for you.

2. **Create the database and `.env`**

   The app validates its environment on boot and fails fast with
   `Invalid environment configuration: <missing vars>` if anything is absent,
   so copy the example file before starting anything:

   ```bash
   cp .env.example .env
   ```

   Then point `DATABASE_URL` at your PostgreSQL instance. The example assumes a
   local database named `pdf_jobs`; create it if it does not exist yet:

   ```bash
   createdb pdf_jobs
   ```

   `.env.example` documents every variable. The required ones are
   `DATABASE_URL`, `WORKER_CONCURRENCY`, `JOB_MAX_ATTEMPTS`,
   `JOB_BACKOFF_BASE_MS`, `JOB_BACKOFF_JITTER_MS`, and `JOB_STUCK_TIMEOUT_MS`;
   the rest (`PDF_OUTPUT_DIR`, `WORKER_POLL_INTERVAL_MS`, `WORKER_ID`,
   `PDF_TEST_FAIL`) have defaults. Never commit `.env`.

3. **Apply migrations**

   ```bash
   npm run db:migrate
   ```

4. **Start the web app**

   ```bash
   npm run dev
   ```

   Then open [http://localhost:3000](http://localhost:3000).

5. **Start the worker in a second terminal**

   ```bash
   npm run worker
   ```

   The worker is a separate process from the request handler. Without it, jobs
   are still accepted and created, but they stay `pending` forever — nothing
   generates PDFs on the request path.

## Verifying the Lifecycle

With both processes running, submit a job and watch it through the console or
the API:

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-1" \
  -d '{
    "reportTitle": "Demo Report",
    "sections": [
      { "heading": "Summary", "body": ["First paragraph of the summary."] },
      { "heading": "Methodology", "body": ["How the data was collected."] },
      { "heading": "Conclusions", "body": ["What the evidence supports."] }
    ]
  }'
```

`202 Accepted` returns `{ "id": "...", "status": "pending", "created": true }`.
Repeating the request with the same `Idempotency-Key` returns the existing job
with `created: false` instead of inserting a second row. The generated PDF lands
in `PDF_OUTPUT_DIR` as `<jobId>.pdf` once the worker picks the job up.

### API

| Method | Path                        | Purpose                                            |
| ------ | --------------------------- | -------------------------------------------------- |
| `POST` | `/api/jobs`                 | Enqueue a PDF job (`Idempotency-Key` required)      |
| `GET`  | `/api/jobs/:id`             | Job status and lifecycle timestamps                 |
| `GET`  | `/api/jobs/dead`            | Dead-letter list with payload summaries             |
| `POST` | `/api/jobs/:id/retry`       | Retry a `dead` job (`409` if it is not dead)        |

Errors use a consistent envelope: `{ "error": { "code": "...", "message": "..." } }`.

Job states are `pending`, `processing`, `succeeded`, `failed`, and `dead`. A
manual retry moves `dead -> pending`, resets `attempts` to `0`, and keeps
`lastError` for audit.

## Scripts

| Script                  | Purpose                                     |
| ----------------------- | ------------------------------------------- |
| `npm run dev`           | Next.js dev server                          |
| `npm run worker`        | Worker process (separate from the web app)  |
| `npm run build`         | Production build                            |
| `npm run lint`          | ESLint                                      |
| `npm run typecheck`     | `tsc --noEmit`                              |
| `npm run db:migrate`    | Apply/create a Prisma migration             |
| `npm run db:generate`   | Regenerate the Prisma client                |

The worker writes structured JSON logs to stdout (`workerId`, `jobId`, `event`,
timestamps). `WORKER_ID` identifies the process, which is what makes
multi-worker runs distinguishable in the logs.

## Project Layout

```
src/app/api/jobs/       # POST enqueue, GET status, dead list, retry
src/app/page.tsx        # test console
src/lib/config.ts       # validated env configuration
src/lib/jobs/           # backoff calculation, atomic claim
src/lib/pdf/            # payload validation, PDFKit report generation
src/worker.ts           # worker process: poll, claim, run, recover
prisma/schema.prisma    # Job model (the queue)
docs/prd.md             # product requirements
```

## Deployment Note

The web app and the worker must be deployed as two processes against the same
PostgreSQL database. Serverless platforms that suspend idle processes are a poor
fit for the worker; run it on a long-lived host or a container service. Vercel
works for the API, but the worker needs its own deployment.
