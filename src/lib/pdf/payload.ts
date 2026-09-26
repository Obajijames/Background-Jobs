import { z } from "zod";

const sectionSchema = z.object({
  heading: z.string().min(1).max(200),
  body: z.array(z.string().min(1)).min(1),
});

export const payloadSchema = z.object({
  reportTitle: z.string().min(1).max(200),
  sections: z.array(sectionSchema).min(3).max(40),
  _testFailure: z
    .object({ attemptsToFail: z.number().int().nonnegative() })
    .optional(),
});

export type PdfPayload = z.infer<typeof payloadSchema>;

export function formatPayloadError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}