import "server-only";

import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { githubInstallations, githubInstallStates, repositories } from "@/db/schema";
import { getAppOctokit, getInstallationOctokit } from "@/github/client";
import { GitHubIntegrationError } from "@/github/errors";
import { createInstallationState, hashInstallationState } from "@/github/security";

const INSTALL_STATE_TTL_MS = 10 * 60 * 1_000;
const UPSERT_BATCH_SIZE = 100;

function githubStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

type GitHubInstallation = Awaited<
  ReturnType<ReturnType<typeof getAppOctokit>["rest"]["apps"]["getInstallation"]>
>["data"];

function accountDetails(installation: GitHubInstallation): {
  accountId: number;
  accountLogin: string;
  accountType: string;
} {
  const account = installation.account;
  if (
    !account ||
    typeof account.id !== "number" ||
    !Number.isSafeInteger(account.id) ||
    account.id <= 0
  ) {
    throw new GitHubIntegrationError(
      "GitHub did not return an installation account",
      "INVALID_INSTALLATION_ACCOUNT",
      502,
    );
  }

  const login =
    "login" in account && typeof account.login === "string"
      ? account.login
      : "slug" in account && typeof account.slug === "string"
        ? account.slug
        : `account-${account.id}`;

  return {
    accountId: account.id,
    accountLogin: login,
    accountType: installation.target_type ?? ("type" in account ? String(account.type) : "Unknown"),
  };
}

function cleanPermissions(permissions: GitHubInstallation["permissions"]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(permissions ?? {}).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
}

export async function issueInstallationState(workspaceId: string, userId: string): Promise<string> {
  const { state, stateHash } = createInstallationState();
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.delete(githubInstallStates).where(lt(githubInstallStates.expiresAt, now));
    await tx
      .delete(githubInstallStates)
      .where(
        and(
          eq(githubInstallStates.userId, userId),
          eq(githubInstallStates.workspaceId, workspaceId),
        ),
      );
    await tx.insert(githubInstallStates).values({
      stateHash,
      workspaceId,
      userId,
      expiresAt: new Date(now.getTime() + INSTALL_STATE_TTL_MS),
    });
  });

  return state;
}

export async function consumeInstallationState(
  state: string,
  userId: string,
): Promise<{ workspaceId: string }> {
  if (state.length < 32 || state.length > 256) {
    throw new GitHubIntegrationError("Invalid or expired GitHub state", "INVALID_STATE", 400);
  }

  const [stored] = await db
    .delete(githubInstallStates)
    .where(
      and(
        eq(githubInstallStates.stateHash, hashInstallationState(state)),
        eq(githubInstallStates.userId, userId),
      ),
    )
    .returning({
      workspaceId: githubInstallStates.workspaceId,
      expiresAt: githubInstallStates.expiresAt,
    });

  if (!stored || stored.expiresAt.getTime() <= Date.now()) {
    throw new GitHubIntegrationError("Invalid or expired GitHub state", "INVALID_STATE", 400);
  }
  return { workspaceId: stored.workspaceId };
}

export async function connectInstallation(input: {
  workspaceId: string;
  userId: string;
  githubInstallationId: number;
}) {
  const appOctokit = getAppOctokit();
  const { data: remote } = await appOctokit.rest.apps.getInstallation({
    installation_id: input.githubInstallationId,
  });
  const account = accountDetails(remote);
  const now = new Date();

  const [installation] = await db
    .insert(githubInstallations)
    .values({
      workspaceId: input.workspaceId,
      githubInstallationId: input.githubInstallationId,
      ...account,
      repositorySelection: remote.repository_selection,
      permissions: cleanPermissions(remote.permissions),
      installedBy: input.userId,
      suspendedAt: remote.suspended_at ? new Date(remote.suspended_at) : null,
      disconnectedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [githubInstallations.workspaceId, githubInstallations.githubInstallationId],
      set: {
        ...account,
        repositorySelection: remote.repository_selection,
        permissions: cleanPermissions(remote.permissions),
        installedBy: input.userId,
        suspendedAt: remote.suspended_at ? new Date(remote.suspended_at) : null,
        disconnectedAt: null,
        updatedAt: now,
      },
    })
    .returning();

  if (!installation) {
    throw new GitHubIntegrationError(
      "Could not save the GitHub installation",
      "INSTALLATION_SAVE_FAILED",
      500,
    );
  }

  const sync = await syncInstallationRepositories({
    workspaceId: input.workspaceId,
    localInstallationId: installation.id,
  });
  return { installation, ...sync };
}

export async function syncInstallationRepositories(input: {
  workspaceId: string;
  localInstallationId: string;
}): Promise<{ repositoryCount: number }> {
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.id, input.localInstallationId),
        eq(githubInstallations.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  if (!installation || installation.disconnectedAt) {
    throw new GitHubIntegrationError(
      "GitHub installation is not connected to this workspace",
      "INSTALLATION_NOT_CONNECTED",
      404,
    );
  }
  const appOctokit = getAppOctokit();
  let remoteInstallation: GitHubInstallation;
  try {
    ({ data: remoteInstallation } = await appOctokit.rest.apps.getInstallation({
      installation_id: installation.githubInstallationId,
    }));
  } catch (error) {
    if (githubStatus(error) === 404) {
      await setInstallationAvailability({
        githubInstallationId: installation.githubInstallationId,
        state: "DELETED",
      });
      throw new GitHubIntegrationError(
        "GitHub App access was revoked. Reconnect the installation to restore repository access.",
        "INSTALLATION_REVOKED",
        410,
      );
    }
    throw error;
  }
  const remoteAccount = accountDetails(remoteInstallation);
  if (remoteInstallation.suspended_at) {
    const suspendedAt = new Date(remoteInstallation.suspended_at);
    await db.transaction(async (tx) => {
      await tx
        .update(githubInstallations)
        .set({ suspendedAt, updatedAt: new Date() })
        .where(eq(githubInstallations.id, installation.id));
      await tx
        .update(repositories)
        .set({ accessState: "SUSPENDED", enabled: false, updatedAt: new Date() })
        .where(eq(repositories.installationId, installation.id));
    });
    throw new GitHubIntegrationError(
      "GitHub installation is suspended",
      "INSTALLATION_SUSPENDED",
      409,
    );
  }

  const octokit = getInstallationOctokit(installation.githubInstallationId);
  const accessible = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
    per_page: 100,
  });
  if (accessible.some((repository) => !Number.isSafeInteger(repository.id) || repository.id <= 0)) {
    throw new GitHubIntegrationError(
      "GitHub returned an unsupported repository identifier",
      "INVALID_REPOSITORY_ID",
      502,
    );
  }
  const now = new Date();
  const accessibleIds = new Set(accessible.map((repository) => repository.id));

  await db.transaction(async (tx) => {
    for (let offset = 0; offset < accessible.length; offset += UPSERT_BATCH_SIZE) {
      const batch = accessible.slice(offset, offset + UPSERT_BATCH_SIZE);
      if (batch.length === 0) continue;

      await tx
        .insert(repositories)
        .values(
          batch.map((repository) => ({
            workspaceId: input.workspaceId,
            installationId: installation.id,
            githubRepositoryId: repository.id,
            owner: repository.owner.login,
            name: repository.name,
            fullName: repository.full_name,
            isPrivate: repository.private,
            defaultBranch: repository.default_branch,
            htmlUrl: repository.html_url,
            accessState: "ACTIVE",
            lastSyncedAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [repositories.workspaceId, repositories.githubRepositoryId],
          set: {
            installationId: sql`excluded.installation_id`,
            owner: sql`excluded.owner`,
            name: sql`excluded.name`,
            fullName: sql`excluded.full_name`,
            isPrivate: sql`excluded.is_private`,
            defaultBranch: sql`excluded.default_branch`,
            htmlUrl: sql`excluded.html_url`,
            accessState: sql`excluded.access_state`,
            lastSyncedAt: sql`excluded.last_synced_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    const known = await tx
      .select({ id: repositories.id, githubRepositoryId: repositories.githubRepositoryId })
      .from(repositories)
      .where(eq(repositories.installationId, installation.id));
    const revokedIds = known
      .filter((repository) => !accessibleIds.has(repository.githubRepositoryId))
      .map((repository) => repository.id);

    for (let offset = 0; offset < revokedIds.length; offset += UPSERT_BATCH_SIZE) {
      const batch = revokedIds.slice(offset, offset + UPSERT_BATCH_SIZE);
      if (batch.length > 0) {
        await tx
          .update(repositories)
          .set({ accessState: "REVOKED", enabled: false, lastSyncedAt: now, updatedAt: now })
          .where(inArray(repositories.id, batch));
      }
    }

    await tx
      .update(githubInstallations)
      .set({
        ...remoteAccount,
        repositorySelection: remoteInstallation.repository_selection,
        permissions: cleanPermissions(remoteInstallation.permissions),
        suspendedAt: null,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(githubInstallations.id, installation.id));
  });

  return { repositoryCount: accessible.length };
}

export async function syncInstallationsByGitHubId(githubInstallationId: number): Promise<void> {
  const linked = await db
    .select({ id: githubInstallations.id, workspaceId: githubInstallations.workspaceId })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.githubInstallationId, githubInstallationId),
        isNull(githubInstallations.disconnectedAt),
      ),
    );

  for (const installation of linked) {
    await syncInstallationRepositories({
      localInstallationId: installation.id,
      workspaceId: installation.workspaceId,
    });
  }
}

export async function setInstallationAvailability(input: {
  githubInstallationId: number;
  state: "SUSPENDED" | "DELETED";
}): Promise<void> {
  const now = new Date();
  const installationFilter =
    input.state === "SUSPENDED"
      ? and(
          eq(githubInstallations.githubInstallationId, input.githubInstallationId),
          isNull(githubInstallations.disconnectedAt),
        )
      : eq(githubInstallations.githubInstallationId, input.githubInstallationId);
  await db.transaction(async (tx) => {
    const affected = await tx
      .update(githubInstallations)
      .set(
        input.state === "SUSPENDED"
          ? { suspendedAt: now, updatedAt: now }
          : { disconnectedAt: now, updatedAt: now },
      )
      .where(installationFilter)
      .returning({ id: githubInstallations.id });
    const ids = affected.map((installation) => installation.id);
    if (ids.length > 0) {
      await tx
        .update(repositories)
        .set({ accessState: input.state, enabled: false, updatedAt: now })
        .where(inArray(repositories.installationId, ids));
    }
  });
}

export async function clearInstallationSuspension(githubInstallationId: number): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ suspendedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(githubInstallations.githubInstallationId, githubInstallationId),
        isNull(githubInstallations.disconnectedAt),
      ),
    );
}

export async function disconnectInstallation(input: {
  workspaceId: string;
  localInstallationId: string;
}): Promise<boolean> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [disconnected] = await tx
      .update(githubInstallations)
      .set({ disconnectedAt: now, updatedAt: now })
      .where(
        and(
          eq(githubInstallations.id, input.localInstallationId),
          eq(githubInstallations.workspaceId, input.workspaceId),
        ),
      )
      .returning({ id: githubInstallations.id });
    if (!disconnected) return false;

    await tx
      .update(repositories)
      .set({ accessState: "DISCONNECTED", enabled: false, updatedAt: now })
      .where(eq(repositories.installationId, disconnected.id));
    return true;
  });
}
