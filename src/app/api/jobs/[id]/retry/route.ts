import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<"/api/jobs/[id]/retry">
) {
  const { id } = await ctx.params;
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) {
    return errorResponse("job_not_found", "Job not found", 404);
  }
  if (job.status !== "dead") {
    return errorResponse(
      "wrong_state",
      `Job is in status ${job.status}; only dead jobs can be retried`,
      409
    );
  }
  const updated = await prisma.job.update({
    where: { id },
    data: {
      status: "pending",
      runAt: new Date(),
      attempts: 0,
      startedAt: null,
      finishedAt: null,
    },
  });
  return NextResponse.json({
    id: updated.id,
    status: updated.status,
    attempts: updated.attempts,
    retried: true,
  });
}