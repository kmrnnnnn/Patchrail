import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { verificationJobs } from "@/db/schema";
import {
  authenticateRunnerRequest,
  parseRunnerJson,
  runnerJson,
  runnerRequestError,
  runnerUnauthorized,
} from "@/runner/auth";
import { runnerHeartbeatRequestSchema, runnerLeaseExpiresAt } from "@/runner/protocol";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!authenticateRunnerRequest(request)) return runnerUnauthorized();
  const { jobId } = await context.params;
  const parsedJobId = z.uuid().safeParse(jobId);
  if (!parsedJobId.success)
    return runnerJson({ error: "Invalid verification job ID" }, { status: 400 });
  let input;
  try {
    input = await parseRunnerJson(request, runnerHeartbeatRequestSchema, 4096);
  } catch (error) {
    const response = runnerRequestError(error);
    if (response) return response;
    throw error;
  }
  const now = new Date();
  const [updated] = await db
    .update(verificationJobs)
    .set({
      heartbeatAt: now,
      leaseExpiresAt: runnerLeaseExpiresAt(now),
      updatedAt: now,
    })
    .where(
      and(
        eq(verificationJobs.id, jobId),
        eq(verificationJobs.status, "RUNNING"),
        eq(verificationJobs.claimToken, input.claimToken),
        eq(verificationJobs.runnerId, input.runnerId),
        gt(verificationJobs.leaseExpiresAt, now),
      ),
    )
    .returning({ id: verificationJobs.id });
  if (!updated) return runnerJson({ error: "Verification job claim is invalid" }, { status: 409 });
  return runnerJson({ ok: true });
}
