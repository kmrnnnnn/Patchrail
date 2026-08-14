import "server-only";

import { auth } from "@/auth/auth";
import { requireAccessibleInstallation } from "@/github/authorization-policy";
import { getGitHubUserOctokit } from "@/github/client";
import { GitHubIntegrationError } from "@/github/errors";
import { readGithubAppEnv } from "@/lib/env";

function userAuthorizationRequired(): GitHubIntegrationError {
  return new GitHubIntegrationError(
    "Sign in with the same GitHub App before connecting repository access",
    "GITHUB_USER_AUTHORIZATION_REQUIRED",
    409,
  );
}

export async function getSignedInGitHubUserAccessToken(requestHeaders: Headers): Promise<string> {
  try {
    const tokens = await auth.api.getAccessToken({
      body: { providerId: "github" },
      headers: requestHeaders,
    });
    if (!tokens.accessToken || tokens.accessToken.length < 20 || /\s/.test(tokens.accessToken)) {
      throw userAuthorizationRequired();
    }
    return tokens.accessToken;
  } catch (error) {
    if (error instanceof GitHubIntegrationError) throw error;
    // Better Auth decrypts (and, when configured, refreshes) the encrypted
    // provider token. Never include its error or token in application logs.
    throw userAuthorizationRequired();
  }
}

/**
 * Defends the GitHub setup URL against a spoofed installation_id. This REST
 * endpoint accepts only a user access token issued by the same GitHub App.
 */
export async function requireInstallationAccessibleToSignedInUser(input: {
  requestHeaders: Headers;
  githubInstallationId: number;
}): Promise<void> {
  const accessToken = await getSignedInGitHubUserAccessToken(input.requestHeaders);
  const octokit = getGitHubUserOctokit(accessToken);
  const appId = readGithubAppEnv().GITHUB_APP_ID;

  try {
    const pages = octokit.paginate.iterator(
      octokit.rest.apps.listInstallationsForAuthenticatedUser,
      { per_page: 100 },
    );
    for await (const response of pages) {
      if (
        response.data.some(
          (installation) =>
            installation.id === input.githubInstallationId && installation.app_id === appId,
        )
      ) {
        requireAccessibleInstallation(response.data, input.githubInstallationId, appId);
        return;
      }
    }
  } catch (error) {
    if (error instanceof GitHubIntegrationError) throw error;
    // A standalone OAuth App token cannot call GET /user/installations. Fail
    // closed and direct the operator to use this GitHub App's OAuth credentials.
    throw userAuthorizationRequired();
  }

  requireAccessibleInstallation([], input.githubInstallationId, appId);
}
