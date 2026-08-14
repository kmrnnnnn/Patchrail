import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { aiRuns, verificationJobs } from "@/db/schema";
import {
  authenticateRunnerRequest,
  parseRunnerJson,
  runnerJson,
  runnerRequestError,
  runnerUnauthorized,
} from "@/runner/auth";
import {
  runnerClaimJobSchema,
  runnerClaimRequestSchema,
  runnerLeaseExpiresAt,
} from "@/runner/protocol";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!authenticateRunnerRequest(request)) return runnerUnauthorized();
  let input;
  try {
    input = await parseRunnerJson(request, runnerClaimRequestSchema, 2048);
  } catch (error) {
    const response = runnerRequestError(error);
    if (response) return response;
    throw error;
  }

  const job = await db.transaction(async (transaction) => {
    const [candidateRow] = await transaction
      .select({ job: verificationJobs })
      .from(verificationJobs)
      .innerJoin(aiRuns, eq(aiRuns.id, verificationJobs.runId))
      .where(
        and(
          eq(verificationJobs.status, "QUEUED"),
          inArray(aiRuns.status, [
            "QUEUED",
            "READING_REPOSITORY",
            "FINDING_APIS",
            "RESEARCHING_APIS",
            "PLANNING_CHANGES",
            "UPDATING_CODE",
            "VERIFYING",
            "REPAIRING",
            "CREATING_PR",
          ]),
        ),
      )
      .orderBy(verificationJobs.createdAt)
      .for("update", { skipLocked: true })
      .limit(1);
    const candidate = candidateRow?.job;
    if (!candidate) return null;

    const claimToken = crypto.randomUUID();
    const now = new Date();
    const descriptor = runnerClaimJobSchema.safeParse({
      id: candidate.id,
      runId: candidate.runId,
      claimToken,
      sourceCommitSha: candidate.sourceCommitSha,
      ecosystem: candidate.ecosystem,
      installCommand: candidate.installCommand,
      commands: candidate.commands,
      payload: candidate.payload ?? [],
      sourceUrl: `/api/runner/jobs/${candidate.id}/source`,
    });
    if (!descriptor.success) {
      await transaction
        .update(verificationJobs)
        .set({
          status: "FAILED",
          result: {
            status: "FAILED",
            commands: [],
            integrityPassed: false,
            integrityFindings: ["Verification job failed control-plane validation"],
            runner: "runner-control-plane",
            startedAt: now.toISOString(),
            completedAt: now.toISOString(),
          },
          errorMessage: "Verification job failed control-plane validation",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(verificationJobs.id, candidate.id));
      return null;
    }
    const [claimed] = await transaction
      .update(verificationJobs)
      .set({
        status: "RUNNING",
        runnerId: input.runnerId,
        claimToken,
        claimedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: runnerLeaseExpiresAt(now),
        updatedAt: now,
      })
      .where(eq(verificationJobs.id, candidate.id))
      .returning();
    return claimed ?? null;
  });

  if (!job) return runnerJson({ job: null });
  return runnerJson({
    job: {
      id: job.id,
      runId: job.runId,
      claimToken: job.claimToken,
      sourceCommitSha: job.sourceCommitSha,
      ecosystem: job.ecosystem,
      installCommand: job.installCommand,
      commands: job.commands,
      payload: job.payload ?? [],
      sourceUrl: `/api/runner/jobs/${job.id}/source`,
    },
  });
}
