# PRD --- Task 2: Background Jobs Done Properly

## 1. Product summary

### Product name

**PDF Job Processing System**

### Purpose

A small background-job system that accepts a request to generate a PDF,
places the work into a PostgreSQL-backed job queue, returns immediately
with a job ID, and lets a separate worker process the PDF generation
asynchronously.

The system is designed to demonstrate reliable background-job
engineering rather than to build a full PDF product.

### Locked stack

-   **Application/API:** Next.js + TypeScript
-   **Database and queue:** PostgreSQL + Prisma
-   **PDF generation:** PDFKit
-   **Queue model:** PostgreSQL `Job` table managed through Prisma
-   **Worker:** Separate worker process from the web request handler
-   **Deployment:** Not locked in this PRD; the deployment must support
    a separately running worker process.

### Core user journey

``` text
Client
  |
  | POST /api/jobs
  v
Next.js API
  |
  | create pending Job
  v
PostgreSQL
  |
  | return 202 + jobId immediately
  v
Client
  |
  | GET /api/jobs/:id
  v
Next.js API

Separate worker
  |
  | atomically claims pending Job
  v
PostgreSQL
  |
  | generates PDF with PDFKit
  |
  +--> succeeded
  |
  +--> failed --> retry with exponential backoff + jitter
                         |
                         +--> dead after max attempts
```

------------------------------------------------------------------------

## 2. Problem statement

The system needs to perform **PDF report generation** without making the
HTTP request wait for the work to finish.

A PDF generation request can involve creating a multi-page document from
structured input. The important engineering problem is not the PDF
itself; it is ensuring that the work continues safely after the request
returns and that every job has an observable outcome.

A naive implementation would generate the PDF directly inside the
request handler:

``` text
POST /api/jobs
    |
    +--> generate PDF
    |
    +--> wait
    |
    +--> return response
```

That violates the purpose of the task because slow work remains on the
request path.

The required design is:

``` text
POST /api/jobs
    |
    +--> create pending job
    |
    +--> return 202 immediately
             |
             +--> worker processes PDF later
```

The worker must survive failures, retry failed work with exponential
backoff and jitter, avoid processing the same job concurrently in two
workers, recover jobs left in `processing`, and move exhausted jobs to
`dead`.

### PDF job definition

Each PDF job generates a **structured multi-page PDF report** from a
validated JSON payload using PDFKit.

The PDF output is identified by the job ID so that repeated execution of
the same logical job does not create duplicate logical outputs.

### Important scope decision

The PDF report is intentionally simple enough to keep the assignment
focused on job processing.

The system is **not** a document-design product, PDF editor, storage
platform, or reporting SaaS.

------------------------------------------------------------------------

## 3. Goals and non-goals

### Goals

The system must:

1.  Move PDF generation out of the HTTP request path.
2.  Create a PostgreSQL-backed `Job` record when work is requested.
3.  Return `202 Accepted` immediately with the job ID.
4.  Support the full job lifecycle:
    -   `pending`
    -   `processing`
    -   `succeeded`
    -   `failed`
    -   `dead`
5.  Enforce an idempotency key at the database level.
6.  Claim jobs atomically so two workers cannot process the same job
    simultaneously.
7.  Limit worker concurrency through configuration.
8.  Retry failures using exponential backoff with jitter.
9.  Make PDF generation idempotent.
10. Recover jobs that remain stuck in `processing`.
11. Provide a dead-letter view for jobs in `dead` status.
12. Allow a human to manually retry a dead job.
13. Provide `GET /api/jobs/:id` for job status.
14. Provide evidence that the system survives intentional failure
    scenarios.

These goals follow the assignment's required job lifecycle, enqueue
behavior, atomic claiming, concurrency cap, backoff, idempotency,
stuck-job recovery, dead-letter view, status endpoint, and break-it
testing requirements.

### Non-goals

The assignment explicitly says the following are not being built:

-   A full user interface.
-   A landing page.
-   Full authentication.
-   A complex user-management system.
-   A full PDF editing or document-management product.
-   Automatic recurring/scheduled business workflows unrelated to the
    queue.
-   Payment processing.
-   A separate message broker such as Redis, RabbitMQ, or Kafka.
-   Performing the PDF generation inside the request handler.

Authentication is limited to identifying the user/requester where
necessary; it is not a feature of this task.

------------------------------------------------------------------------

## 4. User Persona

### Primary persona --- Job requester

**Role:** Developer or application client triggering PDF generation.

**Needs:** - Submit a PDF-generation request. - Receive a job ID
immediately. - Know whether the job is pending, processing, succeeded,
failed, or dead. - Retrieve the error when a job fails. - Avoid
accidentally creating duplicate jobs when the same logical request is
submitted twice.

**Success for this persona:**

> "I can request a PDF without waiting for it to finish, and I can later
> find out exactly what happened."

### Secondary persona --- System operator

**Role:** Developer/operator responsible for the background worker.

**Needs:** - See failed and dead jobs. - Understand the last error. -
Retry a dead job manually. - Verify worker concurrency. - Diagnose stuck
jobs. - Understand why a job was retried or marked dead.

**Success for this persona:**

> "When something goes wrong, I can see what happened and recover the
> job without manually editing the database."

------------------------------------------------------------------------

## 5. Fundamental requirements

### 5.1 Enqueue

`POST /api/jobs` must:

1.  Validate the incoming request.
2.  Require an idempotency key.
3.  Create a job with `pending` status.
4.  Store the PDF input as JSON in `payload`.
5.  Return the job ID.
6.  Return HTTP `202 Accepted`.
7.  Never generate the PDF before returning the enqueue response.

If the same idempotency key is submitted again, the database uniqueness
constraint must prevent creation of a second logical job.

### 5.2 Job lifecycle

``` text
pending
   |
   v
processing
   |
   +--------> succeeded
   |
   +--------> failed
                  |
                  v
               pending
                  |
                  v
              processing
                  |
                  +----> dead
```

`failed` means the job is eligible for another attempt.

`dead` means the configured retry limit has been exhausted and the job
requires human attention.

### 5.3 Atomic job claiming

A worker must not:

``` text
SELECT job
UPDATE job
```

as two independent operations for claiming.

The claim operation must atomically change a job from `pending` to
`processing` so that two workers competing for the same job cannot both
claim it.

### 5.4 Concurrency

The worker must process no more than the configured number of jobs at
the same time.

Example:

``` text
WORKER_CONCURRENCY=5
```

means a worker process can have at most five jobs actively being
processed at once.

The concurrency value must live in configuration rather than being
hardcoded in application logic.

### 5.5 Failure and retry

When PDF generation fails:

1.  Increment `attempts`.
2.  Save the error in `lastError`.
3.  If attempts remain, set the job back to `pending`.
4.  Calculate the next `runAt`.
5.  Use exponential backoff with jitter.
6.  If the job has exhausted its allowed attempts, set status to `dead`.

Conceptually:

``` text
delay = baseDelay × 2^attempt + randomJitter
```

The exact parameters must be configuration values.

### 5.6 Idempotent PDF generation

A worker may crash after generating the PDF but before recording the job
as succeeded.

Therefore, running the same logical job again must not create an
unintended duplicate logical output.

The job ID is the stable identifier for the output.

### 5.7 Stuck-job recovery

If a worker dies while a job is `processing`, the job must not remain
there forever.

A recovery mechanism must identify jobs that have remained in
`processing` longer than the configured timeout and return them to
`pending` with an incremented attempt count.

The timeout must be configurable.

### 5.8 Dead-letter view

A minimal status view must list dead jobs with enough information to
understand the failure:

-   Job ID
-   Job type
-   Payload summary
-   Attempts
-   Last error
-   Relevant timestamps

A manual retry action must allow an operator to retry a dead job.

### 5.9 Status endpoint

``` http
GET /api/jobs/:id
```

must return:

-   Job ID
-   Type
-   Status
-   Attempts
-   Maximum attempts
-   Run time
-   Started time
-   Finished time
-   Last error when applicable

The client can poll this endpoint instead of waiting for the original
request.

------------------------------------------------------------------------

## 6. Processing Pipeline

### Stage 1 --- Request

Client sends:

``` http
POST /api/jobs
Idempotency-Key: <unique-key>
Content-Type: application/json
```

with validated PDF input.

### Stage 2 --- Enqueue

Next.js:

1.  Validates the payload.
2.  Checks/enforces the idempotency key.
3.  Creates the `Job` row with `pending` status.
4.  Returns:

``` http
202 Accepted
```

with the job ID.

### Stage 3 --- Worker polling

A separate worker process looks for jobs where:

``` text
status = pending
runAt <= now
```

### Stage 4 --- Atomic claim

The worker atomically changes:

``` text
pending → processing
```

Only the worker that successfully claims the row may execute the job.

### Stage 5 --- PDF generation

The worker:

1.  Reads the validated JSON payload.
2.  Generates the multi-page report using PDFKit.
3.  Writes the output using the job ID as its stable identifier.
4.  Records success.

### Stage 6 --- Success

The job becomes:

``` text
succeeded
```

and records `finishedAt`.

### Stage 7 --- Failure

If generation fails:

``` text
processing
     |
     v
failed
```

The worker records the error and increments the attempt count.

If attempts remain:

``` text
failed → pending
```

with a future `runAt`.

If no attempts remain:

``` text
failed → dead
```

### Stage 8 --- Status checking

The client calls:

``` http
GET /api/jobs/:id
```

to observe the current state.

### Stage 9 --- Recovery

A recovery process identifies stale `processing` jobs and returns them
to `pending` according to the configured stuck-job timeout.

### Stage 10 --- Human recovery

An operator opens the dead-letter view, reviews the error, and manually
retries a dead job when appropriate.

------------------------------------------------------------------------

## 7. Technical requirements

### 7.1 Framework and language

-   Next.js
-   TypeScript
-   Prisma
-   PostgreSQL
-   PDFKit

TypeScript strictness should remain enabled.

### 7.2 Database

PostgreSQL is the queue storage.

Prisma is the database access layer.

The database is the source of truth for job state.

### 7.3 Job state

The application must use the five required states:

``` text
pending
processing
succeeded
failed
dead
```

No alternative state should be introduced without a documented reason.

### 7.4 Required configuration

At minimum:

``` text
DATABASE_URL
WORKER_CONCURRENCY
JOB_MAX_ATTEMPTS
JOB_BACKOFF_BASE_MS
JOB_BACKOFF_JITTER_MS
JOB_STUCK_TIMEOUT_MS
```

The exact values are implementation decisions and must be documented.

### 7.5 API behavior

The enqueue endpoint must return `202 Accepted`.

The status endpoint must expose enough information for the requester to
understand what happened.

Errors must use consistent response structures.

### 7.6 Validation

The PDF job payload must be validated before the job is created.

Invalid input must not enter the queue as a valid job.

### 7.7 Worker separation

The worker must be a separate process from the request handler.

The API route must never wait for PDF generation to finish.

### 7.8 Atomicity

Job claiming must be atomic.

Idempotency must be enforced by a database uniqueness constraint.

### 7.9 Backoff

Retry delay must increase exponentially and include jitter.

The implementation must make the configured parameters visible and
explainable.

### 7.10 Observability

Logs must make it possible to determine:

-   When a job was claimed.
-   Which worker claimed it.
-   When processing started.
-   Whether it succeeded or failed.
-   Current attempt number.
-   Next retry time.
-   When a job became dead.
-   When a stuck job was recovered.

Logs must not expose secrets or unnecessary sensitive payload data.

### 7.11 Evidence tests

The implementation must intentionally demonstrate:

1.  50 jobs enqueued at once.
2.  Configured concurrency cap holding.
3.  A job failing repeatedly and eventually becoming `dead`.
4.  Backoff delays increasing between attempts.
5.  Worker killed during processing and job subsequently recovered.
6.  Same idempotency key submitted twice and only one job created.
7.  Two workers operating simultaneously without claiming the same job.
8.  A dead job manually retried.

------------------------------------------------------------------------

## 8. Risk

  ---------------------------------------------------------------------------
  Risk                    Impact                  Mitigation
  ----------------------- ----------------------- ---------------------------
  PDF generation is too   High                    Use a sufficiently
  fast to demonstrate                             substantial multi-page
  background processing                           report payload and measure
  clearly                                         actual processing behavior
                                                  rather than adding an
                                                  arbitrary sleep as the core
                                                  design

  PDF generation itself   High                    Provide a controlled
  is deterministic and                            failure mechanism strictly
  may not naturally fail                          for break-it testing, while
                                                  keeping the real PDF
                                                  generation path valid

  Two workers claim one   Critical                Use an atomic database
  job                                             claim

  Worker crashes after    Critical                Make output idempotent
  doing work but before                           using the job ID
  marking success                                 

  Job remains             High                    Configurable stuck-job
  `processing` forever                            recovery

  Failed jobs retry       High                    Enforce `maxAttempts` and
  forever                                         transition to `dead`

  Many failed jobs retry  High                    Exponential backoff with
  simultaneously                                  jitter

  Duplicate enqueue       Critical                Unique database constraint
  creates duplicate work                          on `idempotencyKey`

  Worker exceeds          Medium                  Configurable concurrency
  downstream resource                             cap
  capacity                                        

  Request handler         Critical                Keep worker in a separate
  performs the PDF work                           process

  Database connection     High                    Log failures clearly and
  problems stop queue                             ensure worker failure does
  processing                                      not silently mark jobs
                                                  successful

  Deployment platform     Critical                Choose deployment
  cannot run a persistent                         infrastructure that
  worker                                          supports a separate worker
                                                  process before production
                                                  deployment

  Dead-letter view        Medium                  Show only the information
  exposes too much                                necessary for diagnosis
  payload data                                    

  Configuration is hidden Medium                  Put operational parameters
  in source code                                  in
                                                  environment/configuration

  Retry timing cannot be  Medium                  Store timestamps and
  proven                                          capture evidence of growing
                                                  retry intervals
  ---------------------------------------------------------------------------

### Important loophole to resolve before implementation

**"PDF generation" must genuinely exercise the job system.**

PDFKit can generate a small PDF very quickly. Therefore, the
implementation should use a sufficiently substantial multi-page report
so that PDF generation is meaningful work. A test-only failure switch
may be used to exercise the retry/dead paths, but the production job
itself should remain a real PDF generation operation.

This distinction prevents the project from becoming:

``` text
fake delay → pretend it is a slow job
```

and keeps the actual work as PDF generation.

------------------------------------------------------------------------

## 9. Prisma model

### Job model

``` prisma
enum JobStatus {
  pending
  processing
  succeeded
  failed
  dead
}

model Job {
  id              String    @id @default(cuid())
  type            String
  payload         Json
  status          JobStatus @default(pending)
  attempts        Int       @default(0)
  maxAttempts     Int
  lastError       String?
  runAt           DateTime  @default(now())
  startedAt       DateTime?
  finishedAt      DateTime?
  idempotencyKey  String    @unique
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([status, runAt])
  @@index([status, startedAt])
}
```

### Field decisions

  Field              Purpose
  ------------------ -----------------------------------------------
  `id`               Stable generated job identifier
  `type`             Identifies the work type, e.g. `pdf.generate`
  `payload`          JSON input required to generate the PDF
  `status`           Current lifecycle state
  `attempts`         Number of processing attempts
  `maxAttempts`      Retry limit for the job
  `lastError`        Most recent processing error
  `runAt`            Earliest time the job may be processed
  `startedAt`        Time processing began
  `finishedAt`       Time processing completed
  `idempotencyKey`   Prevents duplicate logical jobs
  `createdAt`        Job creation time
  `updatedAt`        Last database update

### Why no separate Queue table?

PostgreSQL itself is the queue through the `Job` table.

A separate message broker is intentionally outside the locked stack and
is not required for this task.

------------------------------------------------------------------------

## 10. Success metrics

The system is successful when the following can be demonstrated:

### Functional metrics

-   **100%** of valid enqueue requests create a job and return
    `202 Accepted`.
-   **100%** of duplicate idempotency-key submissions result in one
    logical job rather than two.
-   **0 duplicate claims** occur when two workers process the same queue
    concurrently.
-   Jobs can be observed in all five required states.
-   Failed jobs retry until they either succeed or reach `dead`.
-   No exhausted job retries indefinitely.
-   Stuck `processing` jobs are recovered according to the configured
    timeout.
-   Dead jobs can be manually retried.

### Reliability metrics

-   A 50-job burst respects the configured concurrency cap.
-   Retry timestamps demonstrate increasing exponential delays with
    jitter.
-   A worker killed during processing does not permanently strand the
    job.
-   Re-running a job does not create an unintended duplicate logical PDF
    output.

### Evidence metrics

The final submission contains evidence for:

-   Every job status.
-   Backoff timing.
-   Concurrency cap.
-   Stuck-job recovery.
-   Dead-letter handling.
-   Idempotency.
-   Two-worker atomic claiming.

------------------------------------------------------------------------

## 11. Assumptions

1.  PostgreSQL is available and is the persistent queue/state store.
2.  Prisma is the only database access layer.
3.  PDFKit is responsible for PDF generation.
4.  A separate worker process can access the same PostgreSQL database as
    the Next.js application.
5.  The deployment environment must support both the Next.js application
    and a continuously running worker process.
6.  No Redis, RabbitMQ, Kafka, or other external queue is required.
7.  Authentication is limited to identifying the requester and is not a
    core feature.
8.  PDF output can be stored using a filesystem or deployment-supported
    object storage mechanism, but the exact storage provider is not
    locked by this PRD.
9.  The job ID is the stable identifier for a generated PDF.
10. The PDF payload is JSON and must be validated before enqueueing.
11. The exact retry count, backoff base, jitter range, concurrency
    limit, and stuck-job timeout are configuration decisions.
12. The PDF report format is intentionally simple and structured so the
    engineering focus remains the job system.
13. A controlled failure mechanism may exist for testing retry and
    dead-letter behavior; it must not replace the real PDF generation
    path.
14. The system will be tested with more than one worker process to prove
    atomic claiming.
15. Evidence will be captured from actual running behavior rather than
    mocked screenshots.

------------------------------------------------------------------------

# Decision log to lock before coding

The following decisions should be explicitly accepted before downstream
implementation artifacts are generated:

-   [ ] PDF job payload schema
-   [ ] PDF report structure
-   [ ] PDF output storage mechanism
-   [ ] `WORKER_CONCURRENCY`
-   [ ] `JOB_MAX_ATTEMPTS`
-   [ ] `JOB_BACKOFF_BASE_MS`
-   [ ] `JOB_BACKOFF_JITTER_MS`
-   [ ] `JOB_STUCK_TIMEOUT_MS`
-   [ ] Worker deployment/runtime
-   [ ] Controlled failure mechanism for break-it testing
-   [ ] Exact API response envelopes
-   [ ] Exact dead-letter retry behavior

These decisions should not be silently changed by the coding agent after
implementation begins.

------------------------------------------------------------------------

## 15. UI Surfaces (Internal Debug Panel)

The task does **not** require a user interface: the functional surfaces are
the API routes from §8 and the evidence campaign from §7.11. However, an
**internal debug panel** is permitted and recommended for manually testing
job rendering in the browser while developing. It is scoped as a debug
tool, not a product:

-   **Not** a landing page, marketing page, or product shell.
-   **Not** a full user interface (no navigation, theming, auth flows,
    user management, or editor experience).
-   Provides exactly **three plain views**, each wired to the existing
    endpoints. It performs no logic beyond those endpoints and never
    generates PDFs or performs queue work itself.
-   Serves only as a visible, clickable front end to the API so an
    operator can trigger and observe jobs without curl.

### 15.1 Enqueue view

Wires to `POST /api/jobs`.

-   Requires an **Idempotency-Key** (free-text input).
-   Payload builder for `reportTitle` and `sections` (heading + body
    paragraphs), starting with at least three valid sections.
-   Optional test-only flag `_testFailure = { attemptsToFail }` selector so
    the retry/dead-letter paths can be exercised by hand.
-   On submit, shows the HTTP status and the response body (`{ id, status,
    created }`). A duplicate idempotency key must show `created: false`
    with the original job id.
-   On success, passes the returned job id to the status view for
    auto-polling.

### 15.2 Job status view

Wires to `GET /api/jobs/:id`.

-   Input a job id (or receive it from the enqueue view).
-   Auto-polls until the job reaches a terminal state (`succeeded` or
    `dead`).
-   Displays the full status object from §8: `id`, `type`, `status`,
    `attempts`, `maxAttempts`, `runAt`, `startedAt`, `finishedAt`,
    `lastError` (when set), `createdAt`, `updatedAt`.

### 15.3 Dead-letter view

Wires to `GET /api/jobs/dead` and `POST /api/jobs/:id/retry`.

-   Lists dead jobs newest-first with the dead-letter fields from §8:
    `payloadSummary` (never full payload), `attempts`, `lastError`, `runAt`,
    `finishedAt`, `createdAt`.
-   Each row exposes a **Retry** action that calls the retry endpoint and
    refreshes the list.
-   Refreshes on demand; it must not display raw payload JSON.

### 15.5 Requester identity (no authentication)

The panel may "recognize" an operator **without authentication**, in line
with the PRD's auth limitation (identifying the requester is not a
feature):

-   On first load the panel generates a persistent **client id** (a UUID
    stored in browser `localStorage`).
-   The panel displays it (e.g. a short badge: "Recognized as
    `deadbeef…`") so the operator can confirm who they are.
-   The panel sends it as an `X-Client-Id` header on API calls; the
    backend may accept and ignore it. It is **not** persisted and the
    `Job` model from §9 is **not** changed to store it.
-   The default generated `Idempotency-Key` is prefixed with a short slice
    of the client id, so the operator's identity is implicitly attributed
    to enqueued work at the queue level without a schema change.
-   The panel keeps the operator's recent job ids in `localStorage` and
    renders them as "Your recent jobs" for re-polling.

### 15.6 Constraints

-   The panel reads and writes only through the four API routes in §8.
-   It must not bypass validation, idempotency, or queue semantics.
-   It is an internal/dev surface; it may be excluded from production
    builds at deployment time, but excluding it is optional.
-   Nothing in §15 changes the locked stack, the job lifecycle, or the
    evidence requirements.
