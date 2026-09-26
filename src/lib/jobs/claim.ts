import type { JobStatus } from "@prisma/client";
import { prisma } from "../prisma";

export interface ClaimedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function claimDueJobs(limit: number): Promise<ClaimedJob[]> {
  if (limit <= 0) return [];

  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "Job"
    SET status = 'processing', "startedAt" = now(), "updatedAt" = now()
    WHERE id IN (
      SELECT id FROM "Job"
      WHERE status = 'pending' AND "runAt" <= now()
      ORDER BY "runAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;

  return rows;
}