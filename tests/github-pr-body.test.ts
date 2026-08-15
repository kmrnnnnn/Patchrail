import { describe, expect, it } from "vitest";
import { buildPatchrailPullRequestBody, type PullRequestBodyInput } from "@/github/pr-body";

type InternalEconomicsKey = Extract<
  keyof PullRequestBodyInput,
  | "provider"
  | "model"
  | "modelCalls"
  | "tokens"
  | "inputTokens"
  | "outputTokens"
  | "cachedInputTokens"
  | "costUsd"
  | "reservationUsd"
>;

describe("GitHub Draft PR body", () => {
  it("keeps engineering evidence while excluding internal AI economics", () => {
    const acceptsNoInternalEconomics: InternalEconomicsKey extends never ? true : false = true;
    expect(acceptsNoInternalEconomics).toBe(true);

    const input: PullRequestBodyInput & Record<string, unknown> = {
      summary: "Updated a deprecated payments integration.",
      detectedApis: [
        {
          id: "payments",
          provider: "Example Payments",
          product: "Checkout API",
          sdkPackage: "example-payments",
          observedVersion: "1.0.0",
          usageSummary: "The repository creates hosted checkout sessions.",
          methods: ["checkout.create"],
          files: ["src/payments.ts"],
          confidence: 0.95,
          evidence: [
            {
              path: "src/payments.ts",
              lineStart: 10,
              lineEnd: 12,
              excerpt: "checkout.create()",
            },
          ],
          status: "MIGRATION_REQUIRED",
          conclusion: "The integration uses a retired request shape.",
        },
        {
          id: "analytics",
          provider: "Example Analytics",
          product: "Events API",
          sdkPackage: null,
          observedVersion: null,
          usageSummary: "The repository posts analytics events.",
          methods: ["POST /events"],
          files: ["src/analytics.ts"],
          confidence: 0.6,
          evidence: [
            {
              path: "src/analytics.ts",
              lineStart: 4,
              lineEnd: 6,
              excerpt: "fetch(eventsUrl)",
            },
          ],
          status: "INSUFFICIENT_EVIDENCE",
          conclusion: "The deployed API version could not be confirmed from repository evidence.",
        },
      ],
      research: [
        {
          apiId: "payments",
          url: "https://docs.example.com/migration",
          title: "Official migration guide",
          sourceType: "OFFICIAL_MIGRATION_GUIDE",
          summary: "The guide documents the replacement request shape.",
          retrievedAt: "2026-08-15T00:00:00.000Z",
          relevance: "It covers the detected checkout call.",
          authoritative: true,
        },
      ],
      changedFiles: [
        {
          path: "src/payments.ts",
          operation: "UPDATE",
          beforeSha256: "a".repeat(64),
          afterSha256: "b".repeat(64),
          additions: 4,
          deletions: 2,
        },
      ],
      verification: {
        status: "PASSED",
        commands: [
          {
            command: "pnpm test",
            exitCode: 0,
            durationMs: 1250,
            stdout: "passed",
            stderr: "",
            timedOut: false,
          },
        ],
        integrityPassed: true,
        integrityFindings: [],
        runner: "railway",
        startedAt: "2026-08-15T00:00:00.000Z",
        completedAt: "2026-08-15T00:00:02.000Z",
      },
      model: "gpt-internal-do-not-publish",
      provider: "internal-provider-do-not-publish",
      tokens: 71_738,
      costUsd: 1.99,
      reservationUsd: 3,
    };

    const body = buildPatchrailPullRequestBody(input);

    expect(body).toContain("## Patchrail summary");
    expect(body).toContain("## External APIs found");
    expect(body).toContain("## Official sources researched");
    expect(body).toContain("https://docs.example.com/migration");
    expect(body).toContain("## Changed files");
    expect(body).toContain("pnpm test");
    expect(body).toContain("## Limitations");
    expect(body).toContain("deployed API version could not be confirmed");
    expect(body).toContain("## Draft status");
    expect(body).not.toContain("## AI usage");
    expect(body).not.toContain("gpt-internal-do-not-publish");
    expect(body).not.toContain("internal-provider-do-not-publish");
    expect(body).not.toContain("71,738");
    expect(body).not.toContain("$1.99");
    expect(body).not.toContain("$3");
  });
});
