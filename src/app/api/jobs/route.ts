import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { formatPayloadError, payloadSchema } from "@/lib/pdf/payload";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const idempotencyKey = req.headers.get("Idempotency-Key");
  if (!idempotencyKey) {
    return errorResponse(
      "idempotency_key_required",
      "Idempotency-Key header is required",
      400
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid_payload", "Request body must be valid JSON", 400);
  }

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("invalid_payload", formatPayloadError(parsed.error), 400);
  }

  try {
    const job = await prisma.job.create({
      data: {
        type: "pdf.generate",
        payload: parsed.data as unknown as Prisma.InputJsonValue,
        maxAttempts: config.JOB_MAX_ATTEMPTS,
        idempotencyKey,
      },
    });
    return NextResponse.json(
      { id: job.id, status: job.status, created: true },
      { status: 202 }
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await prisma.job.findUnique({ where: { idempotencyKey } });
      if (!existing) {
        return errorResponse("internal", "Failed to look up existing job", 500);
      }
      return NextResponse.json(
        { id: existing.id, status: existing.status, created: false },
        { status: 200 }
      );
    }
    return errorResponse("internal", "Failed to enqueue job", 500);
  }
}