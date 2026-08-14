import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { freeTrialGrants } from "@/db/schema";
import {
  existingFreeTrialBudgetForWorkspace,
  NO_FREE_BUDGET_USD,
} from "@/billing/free-trial-policy";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Atomically assigns the caller's sole lifetime FREE trial to a workspace.
 * The primary key on user_id is the concurrency boundary: simultaneous
 * workspace creations can never both receive the allowance.
 */
export async function allocateLifetimeFreeTrial(
  transaction: Transaction,
  input: { userId: string; workspaceId: string; configuredBudgetUsd: string },
): Promise<string> {
  const [inserted] = await transaction
    .insert(freeTrialGrants)
    .values({
      userId: input.userId,
      grantedWorkspaceId: input.workspaceId,
      budgetUsd: input.configuredBudgetUsd,
    })
    .onConflictDoNothing({ target: freeTrialGrants.userId })
    .returning({
      grantedWorkspaceId: freeTrialGrants.grantedWorkspaceId,
      budgetUsd: freeTrialGrants.budgetUsd,
    });
  if (inserted) return inserted.budgetUsd;

  // Makes the helper idempotent for the same transaction/workspace while a
  // different workspace under the same creator receives no renewed allowance.
  const [existing] = await transaction
    .select({
      grantedWorkspaceId: freeTrialGrants.grantedWorkspaceId,
      budgetUsd: freeTrialGrants.budgetUsd,
    })
    .from(freeTrialGrants)
    .where(eq(freeTrialGrants.userId, input.userId))
    .limit(1);
  return existingFreeTrialBudgetForWorkspace(existing, input.workspaceId);
}

export async function getWorkspaceFreeTrialBudgetUsd(workspaceId: string): Promise<string> {
  const [grant] = await db
    .select({ budgetUsd: freeTrialGrants.budgetUsd })
    .from(freeTrialGrants)
    .where(eq(freeTrialGrants.grantedWorkspaceId, workspaceId))
    .limit(1);
  return grant?.budgetUsd ?? NO_FREE_BUDGET_USD;
}
