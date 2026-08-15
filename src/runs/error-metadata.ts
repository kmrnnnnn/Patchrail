import { APIError } from "openai";
import { GitHubIntegrationError } from "@/github/errors";

export class VerificationInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationInfrastructureError";
  }
}

export function classifyRunError(error: unknown, stage: string): { code: string; message: string } {
  const message = error instanceof Error ? error.message : "Unknown run failure";

  if (stage === "CREATING_PR") return { code: "GITHUB_PR_CREATION_FAILED", message };
  if (error instanceof VerificationInfrastructureError) {
    return { code: "VERIFICATION_INFRASTRUCTURE_FAILED", message };
  }
  if (error instanceof APIError) {
    return {
      code: error.code === "invalid_json_schema" ? "AI_SCHEMA_INVALID" : "AI_PROVIDER_FAILED",
      message,
    };
  }
  if (error instanceof GitHubIntegrationError) {
    return { code: "REPOSITORY_READ_FAILED", message };
  }
  switch (stage) {
    case "READING_REPOSITORY":
      return { code: "REPOSITORY_READ_FAILED", message };
    case "FINDING_APIS":
    case "RESEARCHING_APIS":
    case "PLANNING_CHANGES":
    case "UPDATING_CODE":
    case "REPAIRING":
      return { code: "AI_PROVIDER_FAILED", message };
    case "VERIFYING":
      return { code: "VERIFICATION_FAILED", message };
    default:
      return { code: "RUN_FAILED", message };
  }
}
