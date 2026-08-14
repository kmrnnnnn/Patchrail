import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { verificationJobs } from "@/db/schema";
import {
  authenticateRunnerRequest,
  parseRunnerJson,
  runnerJson,
  RunnerRequestError,
  runnerRequestError,
  runnerUnauthorized,
} from "@/runner/auth";
import {
  MAX_RESULT_REQUEST_BYTES,
  runnerResultRequestSchema,
  validateRunnerResultForJob,
  verificationTimeoutSeconds,
} from "@/runner/protocol";
import { boundedLog } from "@/security/redaction";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!authenticateRunnerRequest(request)) return runnerUnauthorized();
  const { jobId } = await context.params;
  if (!z.uuid().safeParse(jobId).success) {
    return runnerJson({ error: "Invalid verification job ID" }, { status: 400 });
  }

  let input;
  try {
    input = await parseRunnerJson(request, runnerResultRequestSchema, MAX_RESULT_REQUEST_BYTES);
  } catch (error) {
    const response = runnerRequestError(error);
    if (response) return response;
    throw error;
  }

  try {
    const outcome = await db.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(verificationJobs)
        .where(eq(verificationJobs.id, jobId))
        .for("update")
        .limit(1);
      if (!job) return "invalid" as const;

      if (job.claimToken !== input.claimToken || job.runnerId !== input.runnerId) {
        return "invalid" as const;
      }

      let result;
      try {
        result = validateRunnerResultForJob({
          result: input.result,
          failure: input.failure,
          runnerId: input.runnerId,
          installCommand: job.installCommand,
          commands: job.commands,
        });
      } catch {
        throw new RunnerRequestError("Verification result is inconsistent with its job");
      }

      if (job.status === "SUCCEEDED" || job.status === "FAILED") {
        return job.result && isDeepStrictEqual(job.result, result)
          ? ("replayed" as const)
          : ("invalid" as const);
      }

      const now = new Date();
      if (job.status !== "RUNNING" || !job.leaseExpiresAt || job.leaseExpiresAt <= now) {
        return "invalid" as const;
      }

      const startedAt = Date.parse(result.startedAt);
      const completedAt = Date.parse(result.completedAt);
      const maximumDurationMs = (verificationTimeoutSeconds() + 300) * 1000;
      if (
        !job.claimedAt ||
        startedAt < job.claimedAt.getTime() - 60_000 ||
        startedAt > now.getTime() + 60_000 ||
        completedAt > now.getTime() + 60_000 ||
        completedAt < startedAt ||
        completedAt - startedAt > maximumDurationMs
      ) {
        throw new RunnerRequestError("Verification result timestamps are invalid");
      }

      await transaction
        .update(verificationJobs)
        .set({
          status: result.status === "PASSED" ? "SUCCEEDED" : "FAILED",
          result,
          errorMessage: input.failure ? boundedLog(input.failure.message, 2000) : null,
          heartbeatAt: now,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(verificationJobs.id, job.id));
      return "stored" as const;
    });

    if (outcome === "invalid") {
      return runnerJson({ error: "Verification job claim is invalid" }, { status: 409 });
    }
    return runnerJson({ ok: true, replayed: outcome === "replayed" });
  } catch (error) {
    const response = runnerRequestError(error);
    if (response) return response;
    throw error;
  }
}
