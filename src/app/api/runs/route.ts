import { z } from "zod";
import { getConfigurationStatus } from "@/lib/env";
import { crossSiteRequestResponse, requireSameOrigin } from "@/security/request";
import { startAiRun, RunStartError } from "@/runs/start";
import { authorizationResponse, getApiWorkspaceContext } from "@/server/session";

const inputSchema = z.object({ repositoryId: z.uuid() });

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { session, workspace } = await getApiWorkspaceContext();
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
    const input = inputSchema.parse(await request.json());
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
      return Response.json({ error: "Invalid run request" }, { status: 400 });
    }
    throw error;
  }
}
