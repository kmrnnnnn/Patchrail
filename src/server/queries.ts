import "server-only";

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { aiRunEvents, aiRuns, githubInstallations, repositories } from "@/db/schema";
import { customerEventMessage, customerRunFailure } from "@/runs/customer-presentation";

const ACTIVE_RUNS = [
  "QUEUED",
  "READING_REPOSITORY",
  "FINDING_APIS",
  "RESEARCHING_APIS",
  "PLANNING_CHANGES",
  "UPDATING_CODE",
  "VERIFYING",
  "REPAIRING",
  "CREATING_PR",
];

export async function getDashboardData(workspaceId: string) {
  const [repositoryCount, activeRunCount, recentRuns, installations] = await Promise.all([
    db
      .select({ value: count() })
      .from(repositories)
      .where(
        and(eq(repositories.workspaceId, workspaceId), eq(repositories.accessState, "ACTIVE")),
      ),
    db
      .select({ value: count() })
      .from(aiRuns)
      .where(and(eq(aiRuns.workspaceId, workspaceId), inArray(aiRuns.status, ACTIVE_RUNS))),
    db
      .select({
        id: aiRuns.id,
        status: aiRuns.status,
        stage: aiRuns.stage,
        summary: aiRuns.summary,
        createdAt: aiRuns.createdAt,
        completedAt: aiRuns.completedAt,
        githubPrUrl: aiRuns.githubPrUrl,
        githubPrNumber: aiRuns.githubPrNumber,
        repositoryId: repositories.id,
        repositoryName: repositories.fullName,
      })
      .from(aiRuns)
      .innerJoin(repositories, eq(aiRuns.repositoryId, repositories.id))
      .where(eq(aiRuns.workspaceId, workspaceId))
      .orderBy(desc(aiRuns.createdAt))
      .limit(8),
    db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.workspaceId, workspaceId),
          sql`${githubInstallations.disconnectedAt} is null`,
        ),
      ),
  ]);

  const updatesFound = recentRuns.reduce((total, run) => {
    return total + (run.status === "SUCCEEDED" && run.githubPrUrl ? 1 : 0);
  }, 0);

  return {
    repositoryCount: repositoryCount[0]?.value ?? 0,
    activeRunCount: activeRunCount[0]?.value ?? 0,
    updatesFound,
    draftPrCount: recentRuns.filter((run) => Boolean(run.githubPrUrl)).length,
    recentRuns,
    hasInstallation: installations.length > 0,
  };
}

export async function getRepositoriesWithLatestRun(workspaceId: string) {
  const rows = await db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId))
    .orderBy(desc(repositories.updatedAt));

  const latestRuns = await Promise.all(
    rows.map(async (repository) => {
      const [run] = await db
        .select({
          id: aiRuns.id,
          status: aiRuns.status,
          stage: aiRuns.stage,
          createdAt: aiRuns.createdAt,
          githubPrUrl: aiRuns.githubPrUrl,
        })
        .from(aiRuns)
        .where(eq(aiRuns.repositoryId, repository.id))
        .orderBy(desc(aiRuns.createdAt))
        .limit(1);
      return [repository.id, run] as const;
    }),
  );

  const byRepository = new Map(latestRuns);
  return rows.map((repository) => ({ ...repository, latestRun: byRepository.get(repository.id) }));
}

export async function getRepositoryDetail(workspaceId: string, repositoryId: string) {
  const [repository] = await db
    .select({
      id: repositories.id,
      workspaceId: repositories.workspaceId,
      owner: repositories.owner,
      name: repositories.name,
      fullName: repositories.fullName,
      isPrivate: repositories.isPrivate,
      defaultBranch: repositories.defaultBranch,
      htmlUrl: repositories.htmlUrl,
      enabled: repositories.enabled,
      accessState: repositories.accessState,
      lastAnalyzedCommit: repositories.lastAnalyzedCommit,
      installationId: repositories.installationId,
      installationDisconnectedAt: githubInstallations.disconnectedAt,
    })
    .from(repositories)
    .innerJoin(githubInstallations, eq(repositories.installationId, githubInstallations.id))
    .where(and(eq(repositories.id, repositoryId), eq(repositories.workspaceId, workspaceId)))
    .limit(1);

  if (!repository) return null;

  const [lastRun] = await db
    .select({
      id: aiRuns.id,
      status: aiRuns.status,
      stage: aiRuns.stage,
      summary: aiRuns.summary,
      startingCommitSha: aiRuns.startingCommitSha,
      detectedApis: aiRuns.detectedApis,
      changedFiles: aiRuns.changedFiles,
      verification: aiRuns.verification,
      githubPrNumber: aiRuns.githubPrNumber,
      githubPrUrl: aiRuns.githubPrUrl,
      inputQuestion: aiRuns.inputQuestion,
      errorCode: aiRuns.errorCode,
      createdAt: aiRuns.createdAt,
      completedAt: aiRuns.completedAt,
    })
    .from(aiRuns)
    .where(and(eq(aiRuns.repositoryId, repositoryId), eq(aiRuns.workspaceId, workspaceId)))
    .orderBy(desc(aiRuns.createdAt))
    .limit(1);

  if (!lastRun) return { ...repository, lastRun: undefined };
  const { errorCode, ...customerRun } = lastRun;
  return {
    ...repository,
    lastRun: {
      ...customerRun,
      failureMessage:
        lastRun.status === "FAILED" ? customerRunFailure(errorCode, lastRun.stage).message : null,
    },
  };
}

export async function getRunDetail(workspaceId: string, runId: string) {
  const [run] = await db
    .select({
      run: {
        id: aiRuns.id,
        status: aiRuns.status,
        stage: aiRuns.stage,
        startingCommitSha: aiRuns.startingCommitSha,
        detectedApis: aiRuns.detectedApis,
        research: aiRuns.research,
        changedFiles: aiRuns.changedFiles,
        verification: aiRuns.verification,
        githubPrNumber: aiRuns.githubPrNumber,
        githubPrUrl: aiRuns.githubPrUrl,
        inputQuestion: aiRuns.inputQuestion,
        errorCode: aiRuns.errorCode,
        createdAt: aiRuns.createdAt,
        startedAt: aiRuns.startedAt,
        completedAt: aiRuns.completedAt,
      },
      repository: {
        id: repositories.id,
        fullName: repositories.fullName,
      },
    })
    .from(aiRuns)
    .innerJoin(repositories, eq(aiRuns.repositoryId, repositories.id))
    .where(and(eq(aiRuns.id, runId), eq(aiRuns.workspaceId, workspaceId)))
    .limit(1);

  if (!run) return null;
  const events = await db
    .select({
      id: aiRunEvents.id,
      stage: aiRunEvents.stage,
      kind: aiRunEvents.kind,
      message: aiRunEvents.message,
      createdAt: aiRunEvents.createdAt,
    })
    .from(aiRunEvents)
    .where(eq(aiRunEvents.runId, runId))
    .orderBy(aiRunEvents.sequence);
  const failure =
    run.run.status === "FAILED" ? customerRunFailure(run.run.errorCode, run.run.stage) : null;
  const verification = run.run.verification
    ? {
        status: run.run.verification.status,
        integrityPassed: run.run.verification.integrityPassed,
        integrityFindings: run.run.verification.integrityFindings,
        commands: run.run.verification.commands.map((command) => ({
          command: command.command,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
          timedOut: command.timedOut,
          stdout: command.stdout,
          stderr: command.stderr,
        })),
      }
    : null;
  return {
    run: {
      id: run.run.id,
      status: run.run.status,
      stage: run.run.stage,
      startingCommitSha: run.run.startingCommitSha,
      detectedApis: run.run.detectedApis.map((api) => ({
        id: api.id,
        provider: api.provider,
        product: api.product,
        status: api.status,
        conclusion: api.conclusion,
        files: api.files,
        confidence: api.confidence,
      })),
      research: run.run.research.map((source) => ({
        apiId: source.apiId,
        url: source.url,
        title: source.title,
        summary: source.summary,
        authoritative: source.authoritative,
      })),
      changedFiles: run.run.changedFiles.map((file) => ({
        path: file.path,
        operation: file.operation,
        additions: file.additions,
        deletions: file.deletions,
      })),
      verification,
      githubPrNumber: run.run.githubPrNumber,
      githubPrUrl: run.run.githubPrUrl,
      failure,
      inputQuestion: run.run.inputQuestion,
      createdAt: run.run.createdAt,
      startedAt: run.run.startedAt,
      completedAt: run.run.completedAt,
    },
    repository: run.repository,
    events: events.map((event) => ({
      ...event,
      message: customerEventMessage({ ...event, failure }),
    })),
  };
}
