import "server-only";

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiRunEvents,
  aiRuns,
  billingAccounts,
  githubInstallations,
  repositories,
} from "@/db/schema";

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
        actualCostUsd: aiRuns.actualCostUsd,
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
    .select()
    .from(aiRuns)
    .where(and(eq(aiRuns.repositoryId, repositoryId), eq(aiRuns.workspaceId, workspaceId)))
    .orderBy(desc(aiRuns.createdAt))
    .limit(1);

  return { ...repository, lastRun };
}

export async function getRunDetail(workspaceId: string, runId: string) {
  const [run] = await db
    .select({
      run: aiRuns,
      repository: {
        id: repositories.id,
        fullName: repositories.fullName,
        htmlUrl: repositories.htmlUrl,
      },
    })
    .from(aiRuns)
    .innerJoin(repositories, eq(aiRuns.repositoryId, repositories.id))
    .where(and(eq(aiRuns.id, runId), eq(aiRuns.workspaceId, workspaceId)))
    .limit(1);

  if (!run) return null;
  const events = await db
    .select()
    .from(aiRunEvents)
    .where(eq(aiRunEvents.runId, runId))
    .orderBy(aiRunEvents.sequence);
  return { ...run, events };
}

export async function getUsageData(workspaceId: string) {
  const [billing] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.workspaceId, workspaceId))
    .limit(1);

  const runs = await db
    .select({
      id: aiRuns.id,
      repositoryName: repositories.fullName,
      status: aiRuns.status,
      actualCostUsd: aiRuns.actualCostUsd,
      estimatedCostUsd: aiRuns.estimatedCostUsd,
      modelUsage: aiRuns.modelUsage,
      createdAt: aiRuns.createdAt,
    })
    .from(aiRuns)
    .innerJoin(repositories, eq(aiRuns.repositoryId, repositories.id))
    .where(eq(aiRuns.workspaceId, workspaceId))
    .orderBy(desc(aiRuns.createdAt))
    .limit(50);

  const spend = runs.reduce((sum, run) => sum + Number(run.actualCostUsd), 0);
  const budget = Number(billing?.aiBudgetUsd ?? 0);
  return { billing, runs, spend, budget, remaining: Math.max(0, budget - spend) };
}
