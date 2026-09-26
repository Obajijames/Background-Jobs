import { z } from "zod";

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

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues
    .map((issue) => issue.path.join("."))
    .join(", ");
  throw new Error(`Invalid environment configuration: ${missing}`);
}

export const config = parsed.data;

export function logEffectiveConfig(): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "config",
      workerConcurrency: config.WORKER_CONCURRENCY,
      jobMaxAttempts: config.JOB_MAX_ATTEMPTS,
      jobBackoffBaseMs: config.JOB_BACKOFF_BASE_MS,
      jobBackoffJitterMs: config.JOB_BACKOFF_JITTER_MS,
      jobStuckTimeoutMs: config.JOB_STUCK_TIMEOUT_MS,
      pdfOutputDir: config.PDF_OUTPUT_DIR,
      workerPollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
      workerId: config.WORKER_ID,
      pdfTestFail: config.PDF_TEST_FAIL === "" ? "" : "set",
    })
  );
}