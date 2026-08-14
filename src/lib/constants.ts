export const APP_NAME = "Patchrail";
export const APP_TAGLINE = "API integrations that maintain themselves.";
export const ACTIVE_WORKSPACE_COOKIE = "patchrail_workspace";
export const GITHUB_API_VERSION = "2026-03-10";
export const RUN_POLL_INTERVAL_MS = 3_000;
export const MAX_EVENT_LOG_LENGTH = 30_000;

export const RUN_STAGE_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  READING_REPOSITORY: "Read repository",
  FINDING_APIS: "Find APIs",
  RESEARCHING_APIS: "Research APIs",
  PLANNING_CHANGES: "Plan changes",
  UPDATING_CODE: "Update code",
  VERIFYING: "Verify",
  REPAIRING: "Repair",
  CREATING_PR: "Create Draft PR",
  SUCCEEDED: "Complete",
  FAILED: "Failed",
  NEEDS_INPUT: "Needs input",
};
