import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { aiRuns, repositories } from "@/db/schema";
import { getPlanDefinition, normalizeBillingPlan } from "@/billing/plans";
import { selectEnabledRepositoriesWithinLimit } from "@/billing/repository-entitlement-policy";

const ACTIVE_RUN_STATUSES = [
  "QUEUED",
  "READING_REPOSITORY",
  "FINDING_APIS",
  "RESEARCHING_APIS",
  "PLANNING_CHANGES",
  "UPDATING_CODE",
  "VERIFYING",
  "REPAIRING",
  "CREATING_PR",
  "NEEDS_INPUT",
] as const;

type BillingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Applies the current plan's repository entitlement while the billing-account
 * row is locked by the caller. Enabled repositories are ordered by immutable
 * creation time and ID, so every reconciliation makes the same choice.
 */
export async function enforceWorkspaceRepositoryEntitlements(
  transaction: BillingTransaction,
  input: { workspaceId: string; plan: string },
): Promise<{ disabledIds: string[]; activeExcess: number }> {
  const limit = getPlanDefinition(normalizeBillingPlan(input.plan)).repositoryLimit;
  const enabled = await transaction
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.workspaceId, input.workspaceId), eq(repositories.enabled, true)))
    .orderBy(asc(repositories.createdAt), asc(repositories.id))
    .for("update");

  if (enabled.length <= limit) return { disabledIds: [], activeExcess: 0 };

  const enabledIds = enabled.map((repository) => repository.id);
  const active = await transaction
    .selectDistinct({ repositoryId: aiRuns.repositoryId })
    .from(aiRuns)
    .where(
      and(
        eq(aiRuns.workspaceId, input.workspaceId),
        inArray(aiRuns.repositoryId, enabledIds),
        inArray(aiRuns.status, ACTIVE_RUN_STATUSES),
      ),
    );
  const selection = selectEnabledRepositoriesWithinLimit({
    orderedRepositoryIds: enabledIds,
    activeRepositoryIds: new Set(active.map((run) => run.repositoryId)),
    limit,
  });

  if (selection.disableIds.length > 0) {
    await transaction
      .update(repositories)
      .set({ enabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(repositories.workspaceId, input.workspaceId),
          inArray(repositories.id, selection.disableIds),
        ),
      );
  }

  return { disabledIds: selection.disableIds, activeExcess: selection.activeExcess };
}
