import type { AgentResult } from "@/runs/types";
import { isUpdateRequired } from "@/runs/types";

function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

function isSafeRepositoryEvidencePath(value: string): boolean {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function validateResearchCoverage(
  result: AgentResult,
  consultedUrls: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const normalizedConsulted = new Set([...consultedUrls].map(normalizedUrl));
  const ids = new Set(result.detectedApis.map((api) => api.id));

  for (const source of result.research) {
    if (!ids.has(source.apiId))
      issues.push(`Research source references unknown API ${source.apiId}`);
    try {
      const url = new URL(source.url);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        issues.push(`Research source URL is not a safe public web URL: ${source.url}`);
      }
    } catch {
      issues.push(`Research source URL is invalid: ${source.url}`);
    }
    if (!normalizedConsulted.has(normalizedUrl(source.url))) {
      issues.push(`Research source was not observed in web-search results: ${source.url}`);
    }
  }

  for (const api of result.detectedApis) {
    for (const file of api.files) {
      if (!isSafeRepositoryEvidencePath(file)) {
        issues.push(
          `${api.provider} ${api.product} references an invalid repository path: ${file}`,
        );
      }
    }
    for (const evidence of api.evidence) {
      if (!isSafeRepositoryEvidencePath(evidence.path)) {
        issues.push(
          `${api.provider} ${api.product} contains an invalid evidence path: ${evidence.path}`,
        );
      }
      if (
        evidence.lineStart !== null &&
        evidence.lineEnd !== null &&
        evidence.lineEnd < evidence.lineStart
      ) {
        issues.push(`${api.provider} ${api.product} contains an invalid evidence line range`);
      }
    }
    const research = result.research.filter((source) => source.apiId === api.id);
    if (research.length === 0) {
      issues.push(`${api.provider} ${api.product} has no current web research`);
      continue;
    }

    if (
      api.status !== "INSUFFICIENT_EVIDENCE" &&
      !research.some((source) => source.authoritative)
    ) {
      issues.push(`${api.provider} ${api.product} needs an authoritative first-party source`);
    }
  }

  if (result.needsInput && !result.question)
    issues.push("NEEDS_INPUT requires one concise question");
  if (!result.needsInput && result.question)
    issues.push("A question is only valid for NEEDS_INPUT");
  return issues;
}

export function validateMigrationOutcome(result: AgentResult, changedPaths: string[]): string[] {
  const issues: string[] = [];
  const required = result.detectedApis.filter((api) => isUpdateRequired(api.status));
  if (required.length > 0 && changedPaths.length === 0 && !result.needsInput) {
    issues.push("A required migration was identified but no repository files were changed");
  }
  if (required.length === 0 && changedPaths.length > 0) {
    issues.push("Repository files changed without a required API migration");
  }

  if (changedPaths.length > 0 && !result.plan) {
    issues.push("Repository changes require a structured change plan");
  }

  const planned = new Set(result.plan?.filesToChange ?? []);
  for (const path of changedPaths) {
    if (!planned.has(path)) issues.push(`Changed file was not included in the plan: ${path}`);
  }
  return issues;
}
