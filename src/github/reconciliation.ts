import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { account, githubInstallations } from "@/db/schema";
import { personalInstallationIdsForGitHubAccount } from "@/github/authorization-policy";
import { getAppOctokit } from "@/github/client";
import { GitHubIntegrationError } from "@/github/errors";
import { connectInstallation, syncInstallationRepositories } from "@/github/installations";
import { listInstallationsAccessibleToSignedInUser } from "@/github/user-authorization";
import { readGithubAppEnv } from "@/lib/env";

export type GitHubReconciliationResult = {
  installationCount: number;
  repositoryCount: number;
};

async function linkedInstallations(workspaceId: string) {
  return db
    .select({
      id: githubInstallations.id,
      githubInstallationId: githubInstallations.githubInstallationId,
    })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.workspaceId, workspaceId),
        isNull(githubInstallations.disconnectedAt),
      ),
    );
}

export async function hasLinkedGitHubInstallation(workspaceId: string): Promise<boolean> {
  const [installation] = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.workspaceId, workspaceId),
        isNull(githubInstallations.disconnectedAt),
      ),
    )
    .limit(1);
  return Boolean(installation);
}

async function personalInstallationFallback(userId: string): Promise<number[]> {
  const githubAccounts = await db
    .select({ accountId: account.accountId })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(2);
  if (githubAccounts.length !== 1 || !githubAccounts[0]) return [];

  const appId = readGithubAppEnv().GITHUB_APP_ID;
  const appOctokit = getAppOctokit();
  const pages = appOctokit.paginate.iterator(appOctokit.rest.apps.listInstallations, {
    per_page: 100,
  });
  for await (const response of pages) {
    const installationIds = personalInstallationIdsForGitHubAccount(
      response.data,
      appId,
      githubAccounts[0].accountId,
    );
    // A GitHub App has at most one installation on a given personal account.
    if (installationIds.length > 0) return installationIds;
  }
  return [];
}

async function discoverInstallationIds(input: {
  requestHeaders: Headers;
  userId: string;
}): Promise<number[]> {
  // Automatic recovery is deliberately narrower than the explicit setup
  // callback: it may recover only the App installation on the signed-in
  // user's own GitHub account. Organization or other accessible
  // installations still require the callback's explicit installation ID.
  const personalInstallationIds = await personalInstallationFallback(input.userId);

  try {
    const accessibleInstallationIds = new Set(
      await listInstallationsAccessibleToSignedInUser(input.requestHeaders),
    );
    return personalInstallationIds.filter((installationId) =>
      accessibleInstallationIds.has(installationId),
    );
  } catch (error) {
    if (
      !(error instanceof GitHubIntegrationError) ||
      error.code !== "GITHUB_USER_AUTHORIZATION_REQUIRED"
    ) {
      throw error;
    }

    // Reconciliation-only fallback for a personal installation. The App JWT
    // may enumerate its own installations, but exact Better Auth provider
    // account identity is required before any workspace link is created.
    if (personalInstallationIds.length === 0) throw error;
    return personalInstallationIds;
  }
}

/**
 * Recovers installations whose setup redirect was missed. The user token only
 * participates in ownership discovery. connectInstallation independently
 * authenticates as the App and then as each installation before persisting
 * repository state.
 */
export async function reconcileInstallationsForSignedInUser(input: {
  requestHeaders: Headers;
  workspaceId: string;
  userId: string;
}): Promise<GitHubReconciliationResult> {
  const known = await linkedInstallations(input.workspaceId);
  let installationIds: number[];
  try {
    installationIds = await discoverInstallationIds(input);
  } catch (error) {
    // Once a workspace link has been ownership-verified, normal refreshes use
    // App installation auth and must not depend on every workspace member's
    // GitHub user token. With no known link, discovery remains fail-closed.
    if (known.length === 0) throw error;
    installationIds = [];
  }

  let repositoryCount = 0;
  const syncedGitHubIds = new Set<number>();

  for (const githubInstallationId of installationIds) {
    const connected = await connectInstallation({
      workspaceId: input.workspaceId,
      userId: input.userId,
      githubInstallationId,
    });
    repositoryCount += connected.repositoryCount;
    syncedGitHubIds.add(githubInstallationId);
  }

  for (const installation of known) {
    if (syncedGitHubIds.has(installation.githubInstallationId)) continue;
    const synced = await syncInstallationRepositories({
      workspaceId: input.workspaceId,
      localInstallationId: installation.id,
    });
    repositoryCount += synced.repositoryCount;
  }

  return {
    installationCount: new Set([
      ...known.map((installation) => installation.githubInstallationId),
      ...installationIds,
    ]).size,
    repositoryCount,
  };
}
