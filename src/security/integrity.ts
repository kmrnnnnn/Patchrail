import type { RepositoryChange } from "@/ai/repository";

const suspiciousAddedPatterns: Array<[RegExp, string]> = [
  [/\.(?:skip|only)\s*\(/, "Focused or skipped test added"],
  [/\b(?:describe|it|test)\.skip\b/, "Skipped test added"],
  [/@ts-(?:ignore|nocheck)/, "Broad TypeScript suppression added"],
  [/"(?:noEmitOnError|strict|noImplicitAny)"\s*:\s*false/i, "TypeScript validation weakened"],
  [/#\s*type:\s*ignore/, "Python type suppression added"],
  [/eslint-disable(?:-next-line)?\b/, "Lint validation suppression added"],
  [/eslint-disable-file\b/, "File-wide lint validation disabled"],
  [/coverage:\s*ignore|istanbul\s+ignore/i, "Coverage suppression added"],
  [/pytest(?:mark)?\.(?:skip|xfail)|@unittest\.skip/i, "Python test skipped"],
  [/#\[ignore\]/, "Rust test skipped"],
  [/t\.Skip\s*\(/, "Go test skipped"],
];

const protectedVerificationConfiguration =
  /(?:^|\/)(?:vitest|vite|jest|playwright|pytest|tox|nox|cargo|tsconfig)(?:\.[^/]+)?\.(?:js|cjs|mjs|ts|json|toml|ini)$|(?:^|\/)pytest\.ini$|(?:^|\/)tox\.ini$/i;

function countMatches(value: string, pattern: RegExp): number {
  return value.split("\n").filter((line) => pattern.test(line)).length;
}

function inspectNodeVerificationScripts(
  path: string,
  before: string,
  after: string,
  findings: string[],
): void {
  if (path.toLowerCase() !== "package.json" || before.length === 0) return;
  try {
    const beforeManifest = JSON.parse(before) as {
      scripts?: Record<string, unknown>;
      packageManager?: unknown;
    };
    const afterManifest = JSON.parse(after) as {
      scripts?: Record<string, unknown>;
      packageManager?: unknown;
    };
    const beforeScripts = beforeManifest.scripts ?? {};
    const afterScripts = afterManifest.scripts ?? {};
    if (afterManifest.packageManager !== beforeManifest.packageManager) {
      findings.push(`${path}: Package-manager selection changed`);
    }
    for (const script of ["typecheck", "test", "build"] as const) {
      const original = beforeScripts[script];
      if (typeof original === "string" && afterScripts[script] !== original) {
        findings.push(`${path}: Existing ${script} verification script changed or removed`);
      }
      if (typeof original === "string") {
        for (const hook of [`pre${script}`, `post${script}`]) {
          if (afterScripts[hook] !== beforeScripts[hook]) {
            findings.push(`${path}: ${script} verification lifecycle hook changed`);
          }
        }
      }
    }
  } catch {
    findings.push(`${path}: package.json could not be checked for verification-script integrity`);
  }
}

export function inspectTestIntegrity(changes: RepositoryChange[]): {
  passed: boolean;
  findings: string[];
} {
  const findings: string[] = [];

  for (const change of changes) {
    const before = change.before?.toString("utf8") ?? "";
    const after = change.after?.toString("utf8") ?? "";
    const addedLines = after
      .split("\n")
      .filter((line) => !before.split("\n").includes(line))
      .join("\n");

    inspectNodeVerificationScripts(change.path, before, after, findings);

    for (const [pattern, message] of suspiciousAddedPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(addedLines)) findings.push(`${change.path}: ${message}`);
    }
    if (before !== after && protectedVerificationConfiguration.test(change.path)) {
      findings.push(`${change.path}: Verification configuration changed`);
    }

    const isTestFile = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(
      change.path,
    );
    if (!isTestFile) continue;

    if (change.operation === "DELETE") {
      findings.push(`${change.path}: Test file deleted`);
      continue;
    }

    const beforeAssertions = countMatches(before, /\bexpect\s*\(|\bassert\b|should\s*\(/);
    const afterAssertions = countMatches(after, /\bexpect\s*\(|\bassert\b|should\s*\(/);
    if (beforeAssertions >= 3 && afterAssertions < Math.ceil(beforeAssertions * 0.6)) {
      findings.push(`${change.path}: Large assertion reduction detected`);
    }

    const beforeLines = before.split("\n").length;
    const afterLines = after.split("\n").length;
    if (beforeLines >= 30 && afterLines < beforeLines * 0.55) {
      findings.push(`${change.path}: Large test deletion detected`);
    }
  }

  return { passed: findings.length === 0, findings };
}
