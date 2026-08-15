import { githubErrorResponse } from "@/github/errors";
import { reconcileInstallationsForSignedInUser } from "@/github/reconciliation";
import { logger } from "@/lib/logger";
import { crossSiteRequestResponse, requireSameOrigin } from "@/security/request";
import { authorizationResponse, getApiWorkspaceContext } from "@/server/session";

export async function POST(request: Request): Promise<Response> {
  let workspaceId: string | undefined;
  try {
    requireSameOrigin(request);
    const { session, workspace } = await getApiWorkspaceContext();
    workspaceId = workspace.id;
    const result = await reconcileInstallationsForSignedInUser({
      requestHeaders: request.headers,
      workspaceId,
      userId: session.user.id,
    });
    logger.info("github_installation_reconciliation_succeeded", {
      workspaceId,
      installationCount: result.installationCount,
      repositoryCount: result.repositoryCount,
    });
    return Response.json(result);
  } catch (error) {
    const crossSite = crossSiteRequestResponse(error);
    if (crossSite) return crossSite;
    const expected = authorizationResponse(error) ?? githubErrorResponse(error);
    if (expected) return expected;
    logger.error("github_installation_reconciliation_failed", {
      workspaceId,
      errorCode: "GITHUB_INSTALLATION_RECONCILIATION_FAILED",
    });
    return Response.json({ error: "Could not refresh GitHub installations" }, { status: 502 });
  }
}
