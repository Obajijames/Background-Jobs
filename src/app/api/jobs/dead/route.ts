import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const jobs = await prisma.job.findMany({
    where: { status: "dead" },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      type: true,
      payload: true,
      attempts: true,
      lastError: true,
      runAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });

  const items = jobs.map((job) => {
    const payload = (job.payload ?? {}) as {
      reportTitle?: unknown;
      sections?: unknown;
    };
    const sectionCount = Array.isArray(payload.sections)
      ? payload.sections.length
      : null;
    return {
      id: job.id,
      type: job.type,
      payloadSummary: {
        reportTitle:
          typeof payload.reportTitle === "string"
            ? payload.reportTitle.slice(0, 200)
            : null,
        sectionCount,
      },
      attempts: job.attempts,
      lastError: job.lastError,
      runAt: job.runAt,
      finishedAt: job.finishedAt,
      createdAt: job.createdAt,
    };
  });

  return NextResponse.json({ jobs: items });
}