import { describe, expect, it } from "vitest";
import { validateMigrationOutcome, validateResearchCoverage } from "@/ai/validation";
import type { AgentResult } from "@/runs/types";

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    summary: "Stripe usage assessed.",
    detectedApis: [
      {
        id: "stripe-api",
        provider: "Stripe",
        product: "Payments API",
        sdkPackage: "stripe",
        observedVersion: "12",
        usageSummary: "Creates PaymentIntents.",
        methods: ["paymentIntents.create"],
        files: ["src/payments.ts"],
        confidence: 0.97,
        evidence: [
          { path: "src/payments.ts", lineStart: 3, lineEnd: 5, excerpt: "stripe.paymentIntents" },
        ],
        status: "MIGRATION_REQUIRED",
        conclusion: "The observed argument was removed.",
      },
    ],
    research: [
      {
        apiId: "stripe-api",
        url: "https://docs.stripe.com/changelog/example",
        title: "Stripe changelog",
        sourceType: "OFFICIAL_CHANGELOG",
        summary: "The argument was removed.",
        retrievedAt: new Date().toISOString(),
        relevance: "Covers the exact observed method.",
        authoritative: true,
      },
    ],
    plan: {
      summary: "Remove the retired argument.",
      filesToChange: ["src/payments.ts"],
      dependencyChanges: [],
      sourceChanges: ["Update PaymentIntent arguments"],
      configurationChanges: [],
      testChanges: [],
      risks: [],
      verificationStrategy: ["Run tests"],
    },
    needsInput: false,
    question: null,
    ...overrides,
  };
}

describe("AI artifact safety", () => {
  it("accepts official sources actually consulted by web search", () => {
    expect(
      validateResearchCoverage(result(), new Set(["https://docs.stripe.com/changelog/example"])),
    ).toEqual([]);
  });

  it("rejects invented research URLs", () => {
    expect(validateResearchCoverage(result(), new Set())).toContain(
      "Research source was not observed in web-search results: https://docs.stripe.com/changelog/example",
    );
  });

  it("rejects researched links with an unsafe protocol or embedded credentials", () => {
    const candidate = result({
      research: result().research.map((source) => ({
        ...source,
        url: "https://user:password@docs.stripe.com/changelog/example",
      })),
    });
    expect(validateResearchCoverage(candidate, new Set([candidate.research[0]!.url]))).toContain(
      `Research source URL is not a safe public web URL: ${candidate.research[0]!.url}`,
    );
  });

  it("requires authoritative evidence for migrations", () => {
    const candidate = result({
      research: result().research.map((source) => ({ ...source, authoritative: false })),
    });
    expect(validateResearchCoverage(candidate, new Set([candidate.research[0]!.url]))).toContain(
      "Stripe Payments API needs an authoritative first-party source",
    );
  });

  it("requires authoritative evidence before declaring an integration current", () => {
    const candidate = result({
      detectedApis: result().detectedApis.map((api) => ({ ...api, status: "CURRENT" })),
      research: result().research.map((source) => ({ ...source, authoritative: false })),
      plan: null,
    });
    expect(validateResearchCoverage(candidate, new Set([candidate.research[0]!.url]))).toContain(
      "Stripe Payments API needs an authoritative first-party source",
    );
  });

  it("rejects external-API evidence that claims paths outside the repository", () => {
    const candidate = result({
      detectedApis: result().detectedApis.map((api) => ({
        ...api,
        files: ["../secrets.txt"],
        evidence: [{ ...api.evidence[0]!, path: "C:\\outside.txt" }],
      })),
    });
    const issues = validateResearchCoverage(candidate, new Set([candidate.research[0]!.url]));
    expect(issues.some((issue) => issue.includes("invalid repository path"))).toBe(true);
    expect(issues.some((issue) => issue.includes("invalid evidence path"))).toBe(true);
  });

  it("requires changed files for a migration conclusion", () => {
    expect(validateMigrationOutcome(result(), [])).toContain(
      "A required migration was identified but no repository files were changed",
    );
  });

  it("rejects changes missing from the structured plan", () => {
    expect(validateMigrationOutcome(result(), ["src/payments.ts", "package.json"])).toContain(
      "Changed file was not included in the plan: package.json",
    );
  });

  it("rejects speculative edits when research found no required migration", () => {
    const candidate = result({
      detectedApis: result().detectedApis.map((api) => ({ ...api, status: "UPDATE_AVAILABLE" })),
    });
    expect(validateMigrationOutcome(candidate, ["src/payments.ts"])).toContain(
      "Repository files changed without a required API migration",
    );
  });
});
