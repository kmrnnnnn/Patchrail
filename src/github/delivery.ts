import "server-only";

import type { Octokit } from "@octokit/rest";
import type { ChangedFilePayload, VerificationResult } from "@/runs/types";
import type { PatchrailPullRequestBody } from "@/github/pr-body";
import { getInstallationOctokit } from "@/github/client";
import { GitHubIntegrationError } from "@/github/errors";
import {
  assertGitObjectSha,
  assertPatchrailBranchName,
  assertSha256,
  assertWorkflowPathAllowed,
  decodeBase64Strict,
  normalizeGitPath,
  sha256Hex,
} from "@/github/security";
import { getGitHubRepositoryAccess } from "@/github/source";

const MAX_CHANGED_FILES = 100;
const MAX_CHANGED_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_CHANGED_BYTES = 100 * 1024 * 1024;

type TreeEntry = {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string | null;
};

type PreparedFile = {
  path: string;
  operation: ChangedFilePayload["operation"];
  beforeSha256: string | null;
  afterSha256: string | null;
  content: Buffer | null;
};

type TreeCache = Map<string, TreeEntry[]>;

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === status
  );
}

async function getBranchCommitSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
): Promise<string> {
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
  });
  if (ref.object.type !== "commit") {
    throw new GitHubIntegrationError(
      "The pushed Patchrail branch does not point to a commit",
      "DELIVERY_REF_MISMATCH",
      502,
    );
  }
  assertGitObjectSha(ref.object.sha, "Delivered commit SHA");
  return ref.object.sha;
}

function prepareFiles(files: ChangedFilePayload[]): PreparedFile[] {
  if (files.length === 0 || files.length > MAX_CHANGED_FILES) {
    throw new GitHubIntegrationError(
      "Delivery requires between 1 and 100 changed files",
      "INVALID_CHANGED_FILES",
    );
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  return files.map((file) => {
    const path = normalizeGitPath(file.path);
    assertWorkflowPathAllowed(path);
    if (seen.has(path)) {
      throw new GitHubIntegrationError(`Changed file is duplicated: ${path}`, "DUPLICATE_FILE");
    }
    seen.add(path);

    if (file.operation === "DELETE") {
      if (file.contentBase64 !== null || file.afterSha256 !== null || file.beforeSha256 === null) {
        throw new GitHubIntegrationError(
          `Invalid deletion payload for ${path}`,
          "INVALID_CHANGED_FILE",
        );
      }
      assertSha256(file.beforeSha256, "beforeSha256");
      return {
        path,
        operation: file.operation,
        beforeSha256: file.beforeSha256.toLowerCase(),
        afterSha256: null,
        content: null,
      };
    }

    if (file.contentBase64 === null || file.afterSha256 === null) {
      throw new GitHubIntegrationError(`Missing content for ${path}`, "INVALID_CHANGED_FILE");
    }
    if (file.operation === "CREATE" && file.beforeSha256 !== null) {
      throw new GitHubIntegrationError(
        `Created file ${path} unexpectedly has a before digest`,
        "INVALID_CHANGED_FILE",
      );
    }
    if (file.operation === "UPDATE" && file.beforeSha256 === null) {
      throw new GitHubIntegrationError(
        `Updated file ${path} is missing its before digest`,
        "INVALID_CHANGED_FILE",
      );
    }
    if (file.beforeSha256 !== null) assertSha256(file.beforeSha256, "beforeSha256");
    assertSha256(file.afterSha256, "afterSha256");
    const content = decodeBase64Strict(file.contentBase64);
    if (content.byteLength > MAX_CHANGED_FILE_BYTES) {
      throw new GitHubIntegrationError(
        `Changed file is too large: ${path}`,
        "CHANGED_FILE_TOO_LARGE",
      );
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_TOTAL_CHANGED_BYTES) {
      throw new GitHubIntegrationError(
        "Changed files exceed the delivery size limit",
        "CHANGED_FILES_TOO_LARGE",
      );
    }
    if (sha256Hex(content) !== file.afterSha256.toLowerCase()) {
      throw new GitHubIntegrationError(
        `Verified digest does not match changed bytes for ${path}`,
        "CHANGED_FILE_DIGEST_MISMATCH",
      );
    }
    return {
      path,
      operation: file.operation,
      beforeSha256: file.beforeSha256?.toLowerCase() ?? null,
      afterSha256: file.afterSha256.toLowerCase(),
      content,
    };
  });
}

async function getTreeEntries(
  octokit: Octokit,
  owner: string,
  repo: string,
  treeSha: string,
  cache: TreeCache,
): Promise<TreeEntry[]> {
  const cached = cache.get(treeSha);
  if (cached) return cached;
  const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: treeSha });
  const entries: TreeEntry[] = data.tree;
  cache.set(treeSha, entries);
  return entries;
}

async function findTreeEntry(
  octokit: Octokit,
  owner: string,
  repo: string,
  rootTreeSha: string,
  path: string,
  cache: TreeCache,
): Promise<TreeEntry | null> {
  const segments = path.split("/");
  let treeSha = rootTreeSha;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const entries = await getTreeEntries(octokit, owner, repo, treeSha, cache);
    const entry = entries.find((candidate) => candidate.path === segment);
    if (!entry) return null;
    if (index === segments.length - 1) return entry;
    if (entry.type !== "tree" || !entry.sha) return null;
    treeSha = entry.sha;
  }
  return null;
}

async function readBlob(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<Buffer> {
  const { data } = await octokit.rest.git.getBlob({ owner, repo, file_sha: sha });
  if (data.encoding !== "base64") {
    throw new GitHubIntegrationError(
      "GitHub returned an unsupported blob encoding",
      "INVALID_GITHUB_BLOB",
      502,
    );
  }
  return Buffer.from(data.content.replace(/\s/g, ""), "base64");
}

async function validateStartingFiles(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  baseTreeSha: string;
  files: PreparedFile[];
}): Promise<Map<string, TreeEntry>> {
  const cache: TreeCache = new Map();
  const existingByPath = new Map<string, TreeEntry>();

  for (const file of input.files) {
    const entry = await findTreeEntry(
      input.octokit,
      input.owner,
      input.repo,
      input.baseTreeSha,
      file.path,
      cache,
    );
    if (file.operation === "CREATE") {
      if (entry) {
        throw new GitHubIntegrationError(
          `File already exists at the pinned commit: ${file.path}`,
          "STARTING_TREE_MISMATCH",
        );
      }
      continue;
    }
    if (!entry?.sha || entry.type !== "blob") {
      throw new GitHubIntegrationError(
        `File is missing at the pinned commit: ${file.path}`,
        "STARTING_TREE_MISMATCH",
      );
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new GitHubIntegrationError(
        `Special Git entry types cannot be changed: ${file.path}`,
        "UNSUPPORTED_GIT_ENTRY",
      );
    }
    const bytes = await readBlob(input.octokit, input.owner, input.repo, entry.sha);
    if (sha256Hex(bytes) !== file.beforeSha256) {
      throw new GitHubIntegrationError(
        `Pinned source digest does not match the verified copy for ${file.path}`,
        "STARTING_FILE_DIGEST_MISMATCH",
      );
    }
    existingByPath.set(file.path, entry);
  }
  return existingByPath;
}

async function verifyDeliveredTree(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  commitSha: string;
  expectedTreeSha: string;
  files: PreparedFile[];
}): Promise<void> {
  const { data: commit } = await input.octokit.rest.git.getCommit({
    owner: input.owner,
    repo: input.repo,
    commit_sha: input.commitSha,
  });
  if (commit.tree.sha !== input.expectedTreeSha) {
    throw new GitHubIntegrationError(
      "The pushed branch tree does not match the verified commit",
      "DELIVERY_TREE_MISMATCH",
      502,
    );
  }

  const cache: TreeCache = new Map();
  for (const file of input.files) {
    const entry = await findTreeEntry(
      input.octokit,
      input.owner,
      input.repo,
      commit.tree.sha,
      file.path,
      cache,
    );
    if (file.operation === "DELETE") {
      if (entry) {
        throw new GitHubIntegrationError(
          `Deleted file still exists on the pushed branch: ${file.path}`,
          "DELIVERY_FILE_MISMATCH",
          502,
        );
      }
      continue;
    }
    if (!entry?.sha || entry.type !== "blob") {
      throw new GitHubIntegrationError(
        `Changed file is missing on the pushed branch: ${file.path}`,
        "DELIVERY_FILE_MISMATCH",
        502,
      );
    }
    const bytes = await readBlob(input.octokit, input.owner, input.repo, entry.sha);
    if (sha256Hex(bytes) !== file.afterSha256) {
      throw new GitHubIntegrationError(
        `Changed file digest differs on the pushed branch: ${file.path}`,
        "DELIVERY_FILE_MISMATCH",
        502,
      );
    }
  }
}

export type DraftPullRequestDeliveryInput = {
  workspaceId: string;
  repositoryId: string;
  startingCommitSha: string;
  branchName: string;
  commitMessage: string;
  title: string;
  body: PatchrailPullRequestBody;
  changedFiles: ChangedFilePayload[];
  verification: VerificationResult;
};

export type DraftPullRequestDeliveryResult = {
  branch: string;
  commitSha: string;
  treeSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
};

export async function deliverDraftPullRequest(
  input: DraftPullRequestDeliveryInput,
): Promise<DraftPullRequestDeliveryResult> {
  assertGitObjectSha(input.startingCommitSha, "Starting commit SHA");
  assertPatchrailBranchName(input.branchName);
  if (input.commitMessage.trim().length === 0 || input.commitMessage.length > 1_000) {
    throw new GitHubIntegrationError("Invalid commit message", "INVALID_COMMIT_MESSAGE");
  }
  if (input.title.trim().length === 0 || input.title.length > 256) {
    throw new GitHubIntegrationError("Invalid pull request title", "INVALID_PR_TITLE");
  }
  if (input.body.length > 65_536) {
    throw new GitHubIntegrationError("Pull request body is too large", "INVALID_PR_BODY");
  }
  if (input.verification.status !== "PASSED" || !input.verification.integrityPassed) {
    throw new GitHubIntegrationError(
      "A draft PR can be created only from a verified patch with intact tests",
      "PATCH_NOT_VERIFIED",
      409,
    );
  }
  if (
    input.verification.commands.length === 0 ||
    input.verification.commands.some((command) => command.timedOut || command.exitCode !== 0)
  ) {
    throw new GitHubIntegrationError(
      "Verification command results do not qualify for delivery",
      "PATCH_NOT_VERIFIED",
      409,
    );
  }
  const files = prepareFiles(input.changedFiles);
  const repository = await getGitHubRepositoryAccess(input.workspaceId, input.repositoryId, {
    requireEnabled: true,
    requireWrite: true,
  });
  const octokit = getInstallationOctokit(repository.githubInstallationId);
  const { data: startingCommit } = await octokit.rest.git.getCommit({
    owner: repository.owner,
    repo: repository.name,
    commit_sha: input.startingCommitSha,
  });
  const existingByPath = await validateStartingFiles({
    octokit,
    owner: repository.owner,
    repo: repository.name,
    baseTreeSha: startingCommit.tree.sha,
    files,
  });

  const treeEntries: Array<{
    path: string;
    mode: "100644" | "100755";
    type: "blob";
    sha: string | null;
  }> = [];
  for (const file of files) {
    const existing = existingByPath.get(file.path);
    const mode = existing?.mode === "100755" ? existing.mode : "100644";
    if (file.operation === "DELETE") {
      treeEntries.push({ path: file.path, mode, type: "blob", sha: null });
      continue;
    }
    const { data: blob } = await octokit.rest.git.createBlob({
      owner: repository.owner,
      repo: repository.name,
      content: file.content?.toString("base64") ?? "",
      encoding: "base64",
    });
    treeEntries.push({ path: file.path, mode, type: "blob", sha: blob.sha });
  }

  const { data: tree } = await octokit.rest.git.createTree({
    owner: repository.owner,
    repo: repository.name,
    base_tree: startingCommit.tree.sha,
    tree: treeEntries,
  });
  const { data: createdCommit } = await octokit.rest.git.createCommit({
    owner: repository.owner,
    repo: repository.name,
    message: input.commitMessage,
    tree: tree.sha,
    parents: [input.startingCommitSha],
  });

  let branchCommitSha = createdCommit.sha;
  try {
    await octokit.rest.git.createRef({
      owner: repository.owner,
      repo: repository.name,
      ref: `refs/heads/${input.branchName}`,
      sha: createdCommit.sha,
    });
  } catch (error) {
    if (!hasStatus(error, 422)) throw error;
    const existingCommitSha = await getBranchCommitSha(
      octokit,
      repository.owner,
      repository.name,
      input.branchName,
    );
    const { data: existingCommit } = await octokit.rest.git.getCommit({
      owner: repository.owner,
      repo: repository.name,
      commit_sha: existingCommitSha,
    });
    if (
      existingCommit.tree.sha !== tree.sha ||
      existingCommit.parents.length !== 1 ||
      existingCommit.parents[0]?.sha !== input.startingCommitSha
    ) {
      throw new GitHubIntegrationError(
        "The Patchrail branch already exists with different content",
        "DELIVERY_BRANCH_CONFLICT",
        409,
      );
    }
    branchCommitSha = existingCommitSha;
  }

  const pushedCommitSha = await getBranchCommitSha(
    octokit,
    repository.owner,
    repository.name,
    input.branchName,
  );
  if (pushedCommitSha !== branchCommitSha) {
    throw new GitHubIntegrationError(
      "The Patchrail branch changed while it was being delivered",
      "DELIVERY_REF_MISMATCH",
      409,
    );
  }

  // Refetch every changed path through the commit now referenced by GitHub before
  // opening the PR. A mismatch leaves no PR that could be mistaken for verified.
  await verifyDeliveredTree({
    octokit,
    owner: repository.owner,
    repo: repository.name,
    commitSha: branchCommitSha,
    expectedTreeSha: tree.sha,
    files,
  });

  let pullRequest: { number: number; html_url: string; draft?: boolean | null } | undefined;
  try {
    const response = await octokit.rest.pulls.create({
      owner: repository.owner,
      repo: repository.name,
      title: input.title,
      body: input.body,
      head: input.branchName,
      base: repository.defaultBranch,
      draft: true,
    });
    pullRequest = response.data;
  } catch (error) {
    if (!hasStatus(error, 422)) throw error;
    const { data: existing } = await octokit.rest.pulls.list({
      owner: repository.owner,
      repo: repository.name,
      state: "open",
      head: `${repository.owner}:${input.branchName}`,
      base: repository.defaultBranch,
      per_page: 10,
    });
    pullRequest = existing.find((candidate) => candidate.draft === true);
    if (!pullRequest) throw error;
    const refreshed = await octokit.rest.pulls.update({
      owner: repository.owner,
      repo: repository.name,
      pull_number: pullRequest.number,
      title: input.title,
      body: input.body,
    });
    pullRequest = refreshed.data;
  }

  if (pullRequest.draft !== true) {
    // This should not occur when GitHub honors draft:true, but Patchrail's
    // no-non-draft invariant is stronger than assuming the upstream response.
    await octokit.rest.pulls
      .update({
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullRequest.number,
        state: "closed",
      })
      .catch(() => undefined);
    throw new GitHubIntegrationError(
      "GitHub did not create the pull request as a draft",
      "DELIVERY_NOT_DRAFT",
      502,
    );
  }

  const finalCommitSha = await getBranchCommitSha(
    octokit,
    repository.owner,
    repository.name,
    input.branchName,
  );
  if (finalCommitSha !== branchCommitSha) {
    await octokit.rest.pulls
      .update({
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullRequest.number,
        state: "closed",
      })
      .catch(() => undefined);
    throw new GitHubIntegrationError(
      "The Patchrail branch changed before delivery completed",
      "DELIVERY_REF_MISMATCH",
      409,
    );
  }

  return {
    branch: input.branchName,
    commitSha: branchCommitSha,
    treeSha: tree.sha,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.html_url,
  };
}
