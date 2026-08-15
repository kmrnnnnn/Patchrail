import { BillingError } from "@/billing/errors";
import { createQueuedRunWithReservation } from "@/billing/costs";
import { readAiEnv } from "@/lib/env";

export class RunStartError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "RunStartError";
  }
}

export async function startAiRun(input: {
  workspaceId: string;
  repositoryId: string;
  requestedBy: string;
}): Promise<{ id: string }> {
  const ai = readAiEnv();
  try {
    return await createQueuedRunWithReservation({
      ...input,
      amountUsd: ai.AI_MAX_RUN_COST_USD,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new RunStartError(
        "This repository already has an active Patchrail run",
        "DUPLICATE_ACTIVE_RUN",
        409,
      );
    }
    if (error instanceof BillingError) {
      if (error.code === "BUDGET_EXCEEDED") {
        throw new RunStartError(
          "This workspace has no Patchrail update allowance available. Review or change the workspace plan before starting another update.",
          "PLAN_ALLOWANCE_EXHAUSTED",
          error.status,
        );
      }
      if (error.message === "Repository not found.") {
        throw new RunStartError(error.message, "REPOSITORY_NOT_FOUND", error.status);
      }
      if (error.message === "Enable Patchrail first.") {
        throw new RunStartError(error.message, "REPOSITORY_NOT_ENABLED", error.status);
      }
      if (error.message === "GitHub repository access is unavailable.") {
        throw new RunStartError(error.message, "REPOSITORY_ACCESS_UNAVAILABLE", error.status);
      }
      if (error.code === "PLAN_LIMIT_REACHED") {
        throw new RunStartError(error.message, error.code, error.status);
      }
      throw new RunStartError(
        "Patchrail could not confirm this workspace’s update allowance. Refresh the repository before trying again.",
        "PLAN_ALLOWANCE_UNAVAILABLE",
        error.status,
      );
    }
    throw error;
  }
}
