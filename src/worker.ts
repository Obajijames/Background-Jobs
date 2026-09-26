import { config, logEffectiveConfig } from "./lib/config";
import { prisma } from "./lib/prisma";
import { claimDueJobs, type ClaimedJob } from "./lib/jobs/claim";
import { backoffDelayMs, nextRunAt } from "./lib/jobs/backoff";
import { generatePdf } from "./lib/pdf/generate";
import { payloadSchema, type PdfPayload } from "./lib/pdf/payload";

const workerId = config.WORKER_ID;
let inFlight = 0;
let shuttingDown = false;
const SHUTDOWN_GRACE_MS = 5000;

function log(
  event: string,
  extra: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), workerId, event, ...extra })
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RecoveredJob {
  id: string;
  attempts: number;
  runAt: Date;
}

async function recoverStuckJobs(): Promise<void> {
  const timeoutDate = new Date(Date.now() - config.JOB_STUCK_TIMEOUT_MS);
  if (config.JOB_STUCK_TIMEOUT_MS <= 0) return;

  const recovered = await prisma.$queryRaw<RecoveredJob[]>`
    UPDATE "Job"
    SET
      status = 'pending',
      attempts = attempts + 1,
      "lastError" = 'recovered: stuck in processing',
      "startedAt" = NULL,
      "updatedAt" = now(),
      "runAt" = now() + ((${config.JOB_BACKOFF_BASE_MS} * power(2, attempts)
                        + floor(random() * ${config.JOB_BACKOFF_JITTER_MS}))
                        * interval '1 millisecond')
    WHERE id IN (
      SELECT id FROM "Job"
      WHERE status = 'processing' AND "startedAt" <= ${timeoutDate}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, attempts, "runAt"
  `;

  for (const job of recovered) {
    log("recovered", { jobId: job.id, attempt: job.attempts, nextRunAt: job.runAt });
  }
  if (recovered.length > 0) {
    log("recovery_pass", { count: recovered.length });
  }
}

async function runJob(job: ClaimedJob): Promise<void> {
  const attempt = job.attempts + 1;
  log("claimed", { jobId: job.id, attempt, type: job.type });

  let parsed: PdfPayload;
  try {
    const result = payloadSchema.safeParse(job.payload);
    if (!result.success) {
      throw new Error(`invalid stored payload: ${result.error.message}`);
    }
    parsed = result.data;
  } catch (err) {
    return recordFailure(job, attempt, errorMessage(err));
  }

  try {
    const outputPath = await generatePdf(parsed, job.id, attempt);
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "succeeded", finishedAt: new Date(), lastError: null },
    });
    log("succeeded", { jobId: job.id, attempt, outputPath });
  } catch (err) {
    await recordFailure(job, attempt, errorMessage(err));
  }
}

async function recordFailure(
  job: ClaimedJob,
  attempt: number,
  lastError: string
): Promise<void> {
  if (attempt < job.maxAttempts) {
    const runAt = nextRunAt(attempt);
    const delayMs = backoffDelayMs(attempt);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "pending",
        attempts: attempt,
        lastError,
        runAt,
        startedAt: null,
      },
    });
    log("failed", { jobId: job.id, attempt, delayMs, nextRunAt: runAt, lastError });
  } else {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "dead",
        attempts: attempt,
        lastError,
        finishedAt: new Date(),
        startedAt: null,
      },
    });
    log("dead", { jobId: job.id, attempt, lastError });
  }
}

async function claimAvailable(): Promise<void> {
  const slots = Math.max(0, config.WORKER_CONCURRENCY - inFlight);
  if (slots === 0) return;

  const jobs = await claimDueJobs(slots);
  inFlight += jobs.length;
  for (const job of jobs) {
    void runJob(job)
      .catch((err) =>
        log("run_error", { jobId: job.id, error: errorMessage(err) })
      )
      .finally(() => {
        inFlight -= 1;
      });
  }
}

async function tickOnce(): Promise<void> {
  if (shuttingDown) return;
  try {
    await recoverStuckJobs();
  } catch (err) {
    log("recovery_error", { error: errorMessage(err) });
  }
  try {
    await claimAvailable();
  } catch (err) {
    log("claim_error", { error: errorMessage(err) });
  }
  await sleep(config.WORKER_POLL_INTERVAL_MS);
}

function installSignalHandlers(): void {
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutting_down", { signal, inFlight });
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    const drain = setInterval(() => {
      if (inFlight === 0 || Date.now() > deadline) {
        clearInterval(drain);
        void prisma
          .$disconnect()
          .catch(() => undefined)
          .finally(() => process.exit(0));
      }
    }, 100);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  logEffectiveConfig();
  installSignalHandlers();
  try {
    await prisma.$connect();
  } catch (err) {
    log("startup_error", { error: errorMessage(err) });
    process.exit(1);
  }
  log("started", { concurrency: config.WORKER_CONCURRENCY });
  while (!shuttingDown) {
    await tickOnce();
  }
  log("stopped");
}

void main();