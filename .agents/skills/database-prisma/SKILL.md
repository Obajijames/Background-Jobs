---
name: database-prisma
description: Use when setting up PostgreSQL + Prisma for the PDF job system: the Job model, JobStatus enum, unique idempotencyKey constraint, indexes, migrations, and the PrismaClient singleton.
---

# Database (PostgreSQL + Prisma)

The database is the source of truth for job state. PostgreSQL is the queue via the `Job` table — no separate Queue table, no message broker.

## Prisma schema (from PRD §9)

Use the exact model:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum JobStatus {
  pending
  processing
  succeeded
  failed
  dead
}

model Job {
  id             String    @id @default(cuid())
  type           String
  payload        Json
  status         JobStatus @default(pending)
  attempts       Int       @default(0)
  maxAttempts    Int
  lastError      String?
  runAt          DateTime  @default(now())
  startedAt      DateTime?
  finishedAt     DateTime?
  idempotencyKey String    @unique
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([status, runAt])
  @@index([status, startedAt])
}
```

Non-negotiables:

- `JobStatus` has exactly the five states. No alternative states without a documented reason.
- `idempotencyKey` is `@unique` — idempotency is enforced at the database level, not in app code only.
- Both `@@index` lines must exist; the worker and recovery query on `(status, runAt)` / `(status, startedAt)`.
- `payload` is `Json` (stores the validated PDF input).
- `type` for this system: `pdf.generate`.

## Setup steps

1. `npx prisma init` (creates `prisma/schema.prisma` and `.env` if absent), set provider `postgresql`, wire `DATABASE_URL`.
2. Write/sync the schema above.
3. `npx prisma migrate dev --name init` to create and apply the migration.
4. Keep migrations committed; they are part of the deliverable.

## PrismaClient singleton

Create `src/lib/prisma.ts`:

```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

- Single shared client for the API and the worker (do not open a client per request in dev).
- Handle duplicate-idempotency-key create errors by catching the Prisma unique-constraint error (`P2002`) in the enqueue route — see api-routes skill.

## Verification

- `npx prisma validate`
- `npx prisma migrate status`
- Confirm the `idempotencyKey` unique constraint exists in the applied migration.