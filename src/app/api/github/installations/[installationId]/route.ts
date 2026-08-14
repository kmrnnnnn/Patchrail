import { z } from "zod";
import { disconnectInstallation } from "@/github/installations";
import { logger } from "@/lib/logger";
import { authorizationResponse, getApiWorkspaceContext } from "@/server/session";
import { crossSiteRequestResponse, requireSameOrigin } from "@/security/request";

type RouteContext = { params: Promise<{ installationId: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  let workspaceId: string | undefined;
  try {
    requireSameOrigin(request);
    const { installationId } = await context.params;
    const { workspace } = await getApiWorkspaceContext();
    workspaceId = workspace.id;
    if (!z.uuid().safeParse(installationId).success) {
      return Response.json({ error: "Invalid GitHub installation ID" }, { status: 400 });
    }
    const disconnected = await disconnectInstallation({
      workspaceId,
      localInstallationId: installationId,
    });
    if (!disconnected) {
      return Response.json({ error: "GitHub installation was not found" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    const crossSite = crossSiteRequestResponse(error);
    if (crossSite) return crossSite;
    const authorization = authorizationResponse(error);
    if (authorization) return authorization;
    logger.error("github_installation_disconnect_failed", {
      workspaceId,
      errorCode: "GITHUB_INSTALLATION_DISCONNECT_FAILED",
    });
    return Response.json({ error: "Could not disconnect GitHub installation" }, { status: 500 });
  }
}
