import { connectInstallation, consumeInstallationState } from "@/github/installations";
import { GitHubIntegrationError } from "@/github/errors";
import { requireInstallationAccessibleToSignedInUser } from "@/github/user-authorization";
import { logger } from "@/lib/logger";
import {
  authorizationResponse,
  AuthorizationError,
  requireApiSession,
  requireWorkspaceMembership,
} from "@/server/session";

function integrationsUrl(request: Request, status: string, reason?: string): URL {
  const url = new URL("/app/settings/integrations", process.env.APP_URL ?? request.url);
  url.searchParams.set("github", status);
  if (reason) url.searchParams.set("reason", reason);
  return url;
}

export async function GET(request: Request): Promise<Response> {
  let workspaceId: string | undefined;
  try {
    const session = await requireApiSession();
    const requestUrl = new URL(request.url);
    const state = requestUrl.searchParams.get("state") ?? "";
    const consumed = await consumeInstallationState(state, session.user.id);
    workspaceId = consumed.workspaceId;
    await requireWorkspaceMembership(workspaceId, session.user.id);

    const rawInstallationId = requestUrl.searchParams.get("installation_id");
    if (!rawInstallationId) {
      return Response.redirect(integrationsUrl(request, "cancelled"), 303);
    }
    if (!/^\d+$/.test(rawInstallationId)) {
      return Response.redirect(integrationsUrl(request, "error", "invalid_installation"), 303);
    }
    const githubInstallationId = Number(rawInstallationId);
    if (!Number.isSafeInteger(githubInstallationId) || githubInstallationId <= 0) {
      return Response.redirect(integrationsUrl(request, "error", "invalid_installation"), 303);
    }

    // GitHub explicitly warns that installation_id on a setup URL can be
    // spoofed. Prove this installation appears in the signed-in user's list
    // before any local installation or repository record is persisted.
    await requireInstallationAccessibleToSignedInUser({
      requestHeaders: request.headers,
      githubInstallationId,
    });

    const connected = await connectInstallation({
      workspaceId,
      userId: session.user.id,
      githubInstallationId,
    });
    logger.info("github_installation_connected", {
      workspaceId,
      repositoryCount: connected.repositoryCount,
    });
    return Response.redirect(integrationsUrl(request, "connected"), 303);
  } catch (error) {
    const authorization = authorizationResponse(error);
    if (authorization) {
      if (error instanceof AuthorizationError && error.message === "Authentication required") {
        const loginUrl = new URL("/login", process.env.APP_URL ?? request.url);
        loginUrl.searchParams.set("reason", "github_installation_session_expired");
        return Response.redirect(loginUrl, 303);
      }
      return authorization;
    }
    if (error instanceof GitHubIntegrationError) {
      return Response.redirect(integrationsUrl(request, "error", error.code.toLowerCase()), 303);
    }
    logger.error("github_installation_callback_failed", {
      workspaceId,
      errorCode: "GITHUB_INSTALLATION_CALLBACK_FAILED",
    });
    return Response.redirect(integrationsUrl(request, "error", "callback_failed"), 303);
  }
}
