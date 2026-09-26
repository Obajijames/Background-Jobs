import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) {
    return errorResponse("job_not_found", "Job not found", 404);
  }
  return NextResponse.json({
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    runAt: job.runAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ...(job.lastError ? { lastError: job.lastError } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
}