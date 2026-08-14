import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { aiRuns } from "@/db/schema";
import { getConfigurationStatus } from "@/lib/env";
import { RunStartError, startAiRun } from "@/runs/start";
import { authorizationResponse, getApiWorkspaceContext } from "@/server/session";
import { crossSiteRequestResponse, requireSameOrigin } from "@/security/request";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    requireSameOrigin(request);
    const { session, workspace } = await getApiWorkspaceContext();
    const { runId } = await context.params;
    z.uuid().parse(runId);
    const configuration = getConfigurationStatus();
    if (!configuration.github || !configuration.ai || !configuration.runner) {
      return Response.json({ error: "Live update configuration is unavailable" }, { status: 503 });
    }
    const [failedRun] = await db
      .select({ repositoryId: aiRuns.repositoryId, status: aiRuns.status })
      .from(aiRuns)
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.workspaceId, workspace.id)))
      .limit(1);
    if (!failedRun) return Response.json({ error: "Run not found" }, { status: 404 });
    if (failedRun.status !== "FAILED") {
      return Response.json({ error: "Only a failed run can be retried" }, { status: 409 });
    }

    const retry = await startAiRun({
      workspaceId: workspace.id,
      repositoryId: failedRun.repositoryId,
      requestedBy: session.user.id,
    });
    return Response.json({ runId: retry.id }, { status: 201 });
  } catch (error) {
    const crossSite = crossSiteRequestResponse(error);
    if (crossSite) return crossSite;
    const authorization = authorizationResponse(error);
    if (authorization) return authorization;
    if (error instanceof RunStartError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Invalid run ID" }, { status: 400 });
    }
    throw error;
  }
}
