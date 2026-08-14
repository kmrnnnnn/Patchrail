export const NO_FREE_BUDGET_USD = "0.000000";

export function existingFreeTrialBudgetForWorkspace(
  grant: { grantedWorkspaceId: string | null; budgetUsd: string } | undefined,
  workspaceId: string,
): string {
  return grant?.grantedWorkspaceId === workspaceId ? grant.budgetUsd : NO_FREE_BUDGET_USD;
}
