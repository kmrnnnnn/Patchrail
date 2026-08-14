import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { aiRuns, verificationJobs } from "@/db/schema";
import { downloadRepositoryTarballAtCommit, getGitHubRepositoryAccess } from "@/github/source";
import { authenticateRunnerRequest, runnerJson, runnerUnauthorized } from "@/runner/auth";
import { runnerHeartbeatRequestSchema } from "@/runner/protocol";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!authenticateRunnerRequest(request)) return runnerUnauthorized();
  const { jobId } = await context.params;
  const parsedJobId = z.uuid().safeParse(jobId);
  if (!parsedJobId.success)
    return runnerJson({ error: "Invalid verification job ID" }, { status: 400 });
  const claim = runnerHeartbeatRequestSchema.safeParse({
    claimToken: request.headers.get("x-patchrail-claim-token"),
    runnerId: request.headers.get("x-patchrail-runner-id"),
  });
  if (!claim.success)
    return runnerJson({ error: "Invalid verification job claim" }, { status: 400 });
  const now = new Date();

  const [row] = await db
    .select({
      job: verificationJobs,
      workspaceId: aiRuns.workspaceId,
      repositoryId: aiRuns.repositoryId,
    })
    .from(verificationJobs)
    .innerJoin(aiRuns, eq(verificationJobs.runId, aiRuns.id))
    .where(
      and(
        eq(verificationJobs.id, jobId),
        eq(verificationJobs.status, "RUNNING"),
        eq(verificationJobs.claimToken, claim.data.claimToken),
        eq(verificationJobs.runnerId, claim.data.runnerId),
        gt(verificationJobs.leaseExpiresAt, now),
      ),
    )
    .limit(1);
  if (!row) return runnerJson({ error: "Verification job claim is invalid" }, { status: 404 });

  const repository = await getGitHubRepositoryAccess(row.workspaceId, row.repositoryId, {
    requireEnabled: true,
  });
  const { archive, archiveSha256 } = await downloadRepositoryTarballAtCommit({
    githubInstallationId: repository.githubInstallationId,
    owner: repository.owner,
    repository: repository.name,
    commitSha: row.job.sourceCommitSha,
  });
  return new Response(new Uint8Array(archive), {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(archive.length),
      "x-patchrail-archive-sha256": archiveSha256,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
