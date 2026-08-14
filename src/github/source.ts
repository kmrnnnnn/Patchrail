import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { githubInstallations, repositories } from "@/db/schema";
import { getInstallationOctokit } from "@/github/client";
import { GitHubIntegrationError } from "@/github/errors";
import { assertGitObjectSha, sha256Hex } from "@/github/security";

const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const ARCHIVE_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;

export type GitHubRepositoryAccess = {
  repositoryId: string;
  workspaceId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  githubInstallationId: number;
  permissions: Record<string, string>;
};

export async function getGitHubRepositoryAccess(
  workspaceId: string,
  repositoryId: string,
  options: { requireEnabled?: boolean; requireWrite?: boolean } = {},
): Promise<GitHubRepositoryAccess> {
  const [repository] = await db
    .select({
      repositoryId: repositories.id,
      workspaceId: repositories.workspaceId,
      owner: repositories.owner,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
      enabled: repositories.enabled,
      accessState: repositories.accessState,
      githubInstallationId: githubInstallations.githubInstallationId,
      permissions: githubInstallations.permissions,
      suspendedAt: githubInstallations.suspendedAt,
      disconnectedAt: githubInstallations.disconnectedAt,
    })
    .from(repositories)
    .innerJoin(githubInstallations, eq(repositories.installationId, githubInstallations.id))
    .where(and(eq(repositories.id, repositoryId), eq(repositories.workspaceId, workspaceId)))
    .limit(1);

  if (!repository) {
    throw new GitHubIntegrationError("Repository was not found", "REPOSITORY_NOT_FOUND", 404);
  }
  if (
    repository.accessState !== "ACTIVE" ||
    repository.suspendedAt !== null ||
    repository.disconnectedAt !== null
  ) {
    throw new GitHubIntegrationError(
      "GitHub access to this repository is unavailable",
      "REPOSITORY_ACCESS_UNAVAILABLE",
      409,
    );
  }
  if (options.requireEnabled && !repository.enabled) {
    throw new GitHubIntegrationError(
      "Patchrail is not enabled for this repository",
      "REPOSITORY_NOT_ENABLED",
      409,
    );
  }
  if (repository.permissions.contents !== "read" && repository.permissions.contents !== "write") {
    throw new GitHubIntegrationError(
      "The GitHub App needs Contents permission to read this repository",
      "INSUFFICIENT_GITHUB_PERMISSIONS",
      409,
    );
  }
  if (
    options.requireWrite &&
    (repository.permissions.contents !== "write" ||
      repository.permissions.pull_requests !== "write")
  ) {
    throw new GitHubIntegrationError(
      "The GitHub App needs Contents and Pull requests read/write permissions to create a draft PR",
      "INSUFFICIENT_GITHUB_PERMISSIONS",
      409,
    );
  }

  return {
    repositoryId: repository.repositoryId,
    workspaceId: repository.workspaceId,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
    githubInstallationId: repository.githubInstallationId,
    permissions: repository.permissions,
  };
}

export async function resolveBranchHead(input: {
  githubInstallationId: number;
  owner: string;
  repository: string;
  branch: string;
}): Promise<string> {
  const octokit = getInstallationOctokit(input.githubInstallationId);
  const { data } = await octokit.rest.git.getRef({
    owner: input.owner,
    repo: input.repository,
    ref: `heads/${input.branch}`,
  });
  if (data.object.type !== "commit") {
    throw new GitHubIntegrationError(
      "The repository default branch did not resolve to a commit",
      "INVALID_SOURCE_REF",
      502,
    );
  }
  assertGitObjectSha(data.object.sha, "Source commit SHA");
  return data.object.sha;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("Repository archive exceeded Patchrail's size limit");
        throw new GitHubIntegrationError(
          "Repository archive is too large to process safely",
          "REPOSITORY_ARCHIVE_TOO_LARGE",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

export async function downloadRepositoryTarballAtCommit(input: {
  githubInstallationId: number;
  owner: string;
  repository: string;
  commitSha: string;
}): Promise<{ archive: Buffer; archiveSha256: string }> {
  assertGitObjectSha(input.commitSha, "Source commit SHA");
  const octokit = getInstallationOctokit(input.githubInstallationId);
  const response = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
    owner: input.owner,
    repo: input.repository,
    ref: input.commitSha,
    request: {
      parseSuccessResponseBody: false,
      signal: AbortSignal.timeout(ARCHIVE_REQUEST_TIMEOUT_MS),
    },
  });

  const contentLength = Number(response.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
    throw new GitHubIntegrationError(
      "Repository archive is too large to process safely",
      "REPOSITORY_ARCHIVE_TOO_LARGE",
      413,
    );
  }

  const body = response.data;
  if (!(body instanceof ReadableStream)) {
    throw new GitHubIntegrationError(
      "GitHub returned an invalid repository archive",
      "INVALID_REPOSITORY_ARCHIVE",
      502,
    );
  }
  const archive = await readBoundedStream(body, MAX_ARCHIVE_BYTES);
  if (archive.byteLength === 0) {
    throw new GitHubIntegrationError(
      "GitHub returned an empty repository archive",
      "INVALID_REPOSITORY_ARCHIVE",
      502,
    );
  }
  return { archive, archiveSha256: sha256Hex(archive) };
}

/** Resolves once, pins the exact SHA, then downloads that immutable revision. */
export async function fetchPinnedRepositorySource(input: {
  workspaceId: string;
  repositoryId: string;
  /** Reuses an existing immutable pin when a NEEDS_INPUT run resumes. */
  commitSha?: string;
}): Promise<{
  repository: GitHubRepositoryAccess;
  commitSha: string;
  archive: Buffer;
  archiveSha256: string;
}> {
  const repository = await getGitHubRepositoryAccess(input.workspaceId, input.repositoryId, {
    requireEnabled: true,
  });
  if (input.commitSha) assertGitObjectSha(input.commitSha, "Source commit SHA");
  const commitSha =
    input.commitSha ??
    (await resolveBranchHead({
      githubInstallationId: repository.githubInstallationId,
      owner: repository.owner,
      repository: repository.name,
      branch: repository.defaultBranch,
    }));
  const tarball = await downloadRepositoryTarballAtCommit({
    githubInstallationId: repository.githubInstallationId,
    owner: repository.owner,
    repository: repository.name,
    commitSha,
  });
  return { repository, commitSha, ...tarball };
}
