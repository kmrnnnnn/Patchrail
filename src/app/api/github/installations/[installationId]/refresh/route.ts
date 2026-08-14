import { z } from "zod";
import { githubErrorResponse } from "@/github/errors";
import { syncInstallationRepositories } from "@/github/installations";
import { logger } from "@/lib/logger";
import { authorizationResponse, getApiWorkspaceContext } from "@/server/session";
import { crossSiteRequestResponse, requireSameOrigin } from "@/security/request";

type RouteContext = { params: Promise<{ installationId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  let workspaceId: string | undefined;
  try {
    requireSameOrigin(request);
    const { installationId } = await context.params;
    const { workspace } = await getApiWorkspaceContext();
    workspaceId = workspace.id;
    if (!z.uuid().safeParse(installationId).success) {
      return Response.json({ error: "Invalid GitHub installation ID" }, { status: 400 });
    }
    const result = await syncInstallationRepositories({
      workspaceId,
      localInstallationId: installationId,
    });
    return Response.json(result);
  } catch (error) {
    const crossSite = crossSiteRequestResponse(error);
    if (crossSite) return crossSite;
    const expected = authorizationResponse(error) ?? githubErrorResponse(error);
    if (expected) return expected;
    logger.error("github_repository_sync_failed", {
      workspaceId,
      errorCode: "GITHUB_REPOSITORY_SYNC_FAILED",
    });
    return Response.json({ error: "Could not refresh GitHub repositories" }, { status: 502 });
  }
}
