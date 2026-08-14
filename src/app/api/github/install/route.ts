import { getGitHubAppInstallationUrl } from "@/github/client";
import { issueInstallationState } from "@/github/installations";
import { logger } from "@/lib/logger";
import { crossSiteRequestResponse, requireSameOrigin } from "@/security/request";
import { authorizationResponse, getApiWorkspaceContext } from "@/server/session";

async function createInstallUrl(): Promise<string> {
  const { session, workspace } = await getApiWorkspaceContext();
  const state = await issueInstallationState(workspace.id, session.user.id);
  return getGitHubAppInstallationUrl(state);
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    return Response.json({ url: await createInstallUrl() });
  } catch (error) {
    const crossSite = crossSiteRequestResponse(error);
    if (crossSite) return crossSite;
    const authorization = authorizationResponse(error);
    if (authorization) return authorization;
    logger.error("github_install_start_failed", { errorCode: "GITHUB_INSTALL_START_FAILED" });
    return Response.json({ error: "Could not start GitHub installation" }, { status: 500 });
  }
}
