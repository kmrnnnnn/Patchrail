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
      const code =
        error.code === "BUDGET_EXCEEDED"
          ? "BUDGET_EXCEEDED"
          : error.message === "Repository not found."
            ? "REPOSITORY_NOT_FOUND"
            : error.message === "Enable Patchrail first."
              ? "REPOSITORY_NOT_ENABLED"
              : error.message === "GitHub repository access is unavailable."
                ? "REPOSITORY_ACCESS_UNAVAILABLE"
                : error.code;
      throw new RunStartError(error.message, code, error.status);
    }
    throw error;
  }
}
