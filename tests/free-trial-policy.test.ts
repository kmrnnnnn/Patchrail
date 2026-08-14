import { describe, expect, it } from "vitest";
import {
  existingFreeTrialBudgetForWorkspace,
  NO_FREE_BUDGET_USD,
} from "@/billing/free-trial-policy";

describe("lifetime FREE trial policy", () => {
  const originalWorkspaceId = "4d682c68-bc97-4a6e-9ca4-dc681d58f58f";

  it("keeps the original grant idempotent for its workspace", () => {
    expect(
      existingFreeTrialBudgetForWorkspace(
        { grantedWorkspaceId: originalWorkspaceId, budgetUsd: "5.000000" },
        originalWorkspaceId,
      ),
    ).toBe("5.000000");
  });

  it("does not grant the allowance to a later workspace", () => {
    expect(
      existingFreeTrialBudgetForWorkspace(
        { grantedWorkspaceId: originalWorkspaceId, budgetUsd: "5.000000" },
        "41032c37-e39a-493e-ae99-a7f485926b2d",
      ),
    ).toBe(NO_FREE_BUDGET_USD);
  });

  it("does not restore eligibility after the original workspace is deleted", () => {
    expect(
      existingFreeTrialBudgetForWorkspace(
        { grantedWorkspaceId: null, budgetUsd: "5.000000" },
        "41032c37-e39a-493e-ae99-a7f485926b2d",
      ),
    ).toBe(NO_FREE_BUDGET_USD);
  });
});
