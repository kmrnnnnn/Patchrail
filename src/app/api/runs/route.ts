import { z } from "zod";
import { getConfigurationStatus } from "@/lib/env";
import { logger } from "@/lib/logger";
import { crossSiteRequestResponse, requireSameOrigin } from "@/security/request";
import { startAiRun, RunStartError } from "@/runs/start";
import { authorizationResponse, getApiWorkspaceContext } from "@/server/session";

const inputSchema = z.object({ repositoryId: z.uuid() });

function safeCauseCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,64}$/.test(error.code)
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name.slice(0, 64) : "UNKNOWN";
}

export async function POST(request: Request) {
  let workspaceId: string | undefined;
  let repositoryId: string | undefined;
  try {
    requireSameOrigin(request);
    const { session, workspace } = await getApiWorkspaceContext();
    workspaceId = workspace.id;
    const configuration = getConfigurationStatus();
    const unavailable = [
      !configuration.github && "GitHub App",
      !configuration.ai && "OpenAI/pricing",
      !configuration.runner && "verification runner",
    ].filter(Boolean);
    if (unavailable.length > 0) {
      return Response.json(
        { error: `${unavailable.join(", ")} configuration is unavailable` },
        { status: 503 },
      );
    }
    let requestBody: unknown;
    try {
      requestBody = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid run request", code: "INVALID_RUN_REQUEST" },
        { status: 400 },
      );
    }
    const input = inputSchema.parse(requestBody);
    repositoryId = input.repositoryId;
    const run = await startAiRun({
      workspaceId: workspace.id,
      repositoryId: input.repositoryId,
      requestedBy: session.user.id,
    });
    return Response.json({ runId: run.id }, { status: 201 });
  } catch (error) {
    const crossSite = crossSiteRequestResponse(error);
    if (crossSite) return crossSite;
    const authorization = authorizationResponse(error);
    if (authorization) return authorization;
    if (error instanceof RunStartError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "Invalid run request", code: "INVALID_RUN_REQUEST" },
        { status: 400 },
      );
    }
    logger.error("ai_run_start_failed", {
      workspaceId,
      repositoryId,
      errorCode: "RUN_START_FAILED",
      causeCode: safeCauseCode(error),
    });
    return Response.json(
      {
        error:
          "Patchrail could not confirm that the AI run was created. Refresh this repository before trying again.",
        code: "RUN_START_FAILED",
      },
      { status: 500 },
    );
  }
}
