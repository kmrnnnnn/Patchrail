import { readPlanEnv } from "@/lib/env";
import type { BillingPlan, PlanDefinition } from "@/billing/types";

export function normalizeBillingPlan(value: string | null | undefined): BillingPlan {
  return value === "PRO" ? "PRO" : "FREE";
}

export function getPlanDefinition(plan: BillingPlan): PlanDefinition {
  const configuration = readPlanEnv();

  if (plan === "PRO") {
    return {
      id: "PRO",
      name: "Pro",
      repositoryLimit: configuration.PRO_REPOSITORY_LIMIT,
      aiBudgetUsd: configuration.PRO_AI_BUDGET_USD.toFixed(6),
      paid: true,
    };
  }

  return {
    id: "FREE",
    name: "Free",
    repositoryLimit: configuration.FREE_REPOSITORY_LIMIT,
    aiBudgetUsd: configuration.FREE_AI_BUDGET_USD.toFixed(6),
    paid: false,
  };
}

export function isProEntitled(status: string): boolean {
  return status === "active" || status === "trialing";
}
