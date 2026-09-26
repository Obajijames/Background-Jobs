import { config } from "../config";

function randomJitter(): number {
  return Math.floor(Math.random() * config.JOB_BACKOFF_JITTER_MS);
}

export function backoffDelayMs(attempt: number): number {
  return config.JOB_BACKOFF_BASE_MS * Math.pow(2, attempt - 1) + randomJitter();
}

export function nextRunAt(attempt: number): Date {
  return new Date(Date.now() + backoffDelayMs(attempt));
}