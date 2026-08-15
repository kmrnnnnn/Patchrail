import "server-only";

import { auth } from "@/auth/auth";
import {
  accessibleInstallationIdsForApp,
  requireAccessibleInstallation,
} from "@/github/authorization-policy";
import { getGitHubUserOctokit } from "@/github/client";
import { GitHubIntegrationError } from "@/github/errors";
import { readGithubAppEnv } from "@/lib/env";

function userAuthorizationRequired(): GitHubIntegrationError {
  return new GitHubIntegrationError(
    "GitHub login must use this same GitHub App before Patchrail can discover installations. Sign out and sign in again after the App OAuth credentials are configured.",
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
  const accessibleInstallationIds = await listInstallationsAccessibleToSignedInUser(
    input.requestHeaders,
  );
  if (accessibleInstallationIds.includes(input.githubInstallationId)) return;

  requireAccessibleInstallation([], input.githubInstallationId, readGithubAppEnv().GITHUB_APP_ID);
}

/**
 * Lists installation IDs owned or otherwise accessible to the signed-in user.
 * The GitHub App user token is deliberately confined to ownership discovery;
 * repository reads and writes continue to use installation access tokens.
 */
export async function listInstallationsAccessibleToSignedInUser(
  requestHeaders: Headers,
): Promise<number[]> {
  const accessToken = await getSignedInGitHubUserAccessToken(requestHeaders);
  const octokit = getGitHubUserOctokit(accessToken);
  const appId = readGithubAppEnv().GITHUB_APP_ID;
  const installationIds = new Set<number>();

  try {
    const pages = octokit.paginate.iterator(
      octokit.rest.apps.listInstallationsForAuthenticatedUser,
      { per_page: 100 },
    );
    for await (const response of pages) {
      for (const installationId of accessibleInstallationIdsForApp(response.data, appId)) {
        installationIds.add(installationId);
      }
    }
  } catch (error) {
    if (error instanceof GitHubIntegrationError) throw error;
    // A standalone OAuth App token cannot call GET /user/installations. Fail
    // closed and direct the operator to use this GitHub App's OAuth credentials.
    throw userAuthorizationRequired();
  }

  return [...installationIds];
}
