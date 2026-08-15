import { describe, expect, it } from "vitest";
import { aiEnvSchema, commonEnvSchema, verificationEnvSchema } from "@/lib/env";

describe("environment validation", () => {
  it("rejects malformed and non-PostgreSQL database URLs without throwing", () => {
    const base = {
      APP_URL: "https://patchrail.example",
      AUTH_SECRET: "x".repeat(32),
      GITHUB_OAUTH_CLIENT_ID: "client",
      GITHUB_OAUTH_CLIENT_SECRET: "secret",
    };

    expect(commonEnvSchema.safeParse({ ...base, DATABASE_URL: "not-a-url" }).success).toBe(false);
    expect(
      commonEnvSchema.safeParse({ ...base, DATABASE_URL: "https://example.com" }).success,
    ).toBe(false);
  });

  it("requires APP_URL to be a canonical secure origin", () => {
    const base = {
      DATABASE_URL: "postgresql://user:password@db.example/patchrail",
      AUTH_SECRET: "x".repeat(32),
      GITHUB_OAUTH_CLIENT_ID: "client",
      GITHUB_OAUTH_CLIENT_SECRET: "secret",
    };

    expect(
      commonEnvSchema.safeParse({ ...base, APP_URL: "https://patchrail.example" }).success,
    ).toBe(true);
    expect(
      commonEnvSchema.safeParse({ ...base, APP_URL: "https://patchrail.example/path" }).success,
    ).toBe(false);
    expect(
      commonEnvSchema.safeParse({ ...base, APP_URL: "http://patchrail.example" }).success,
    ).toBe(false);
  });

  it("requires a Railway credential for sandbox verification", () => {
    expect(
      verificationEnvSchema.safeParse({
        VERIFICATION_MODE: "railway_sandbox",
        RAILWAY_ENVIRONMENT_ID: "environment",
      }).success,
    ).toBe(false);
    const railwayConfiguration = verificationEnvSchema.safeParse({
      VERIFICATION_MODE: "railway_sandbox",
      RAILWAY_ENVIRONMENT_ID: "environment",
      RAILWAY_TOKEN: "project-token",
    });
    expect(railwayConfiguration.success).toBe(true);
    if (!railwayConfiguration.success) throw new Error("Expected valid Railway configuration");
    if (railwayConfiguration.data.VERIFICATION_MODE !== "railway_sandbox") {
      throw new Error("Expected Railway Sandbox configuration");
    }
    expect(railwayConfiguration.data.RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES).toBe(5);
    expect(
      verificationEnvSchema.safeParse({
        VERIFICATION_MODE: "railway_sandbox",
        RAILWAY_ENVIRONMENT_ID: "environment",
        RAILWAY_TOKEN: "project-token",
        RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES: 121,
      }).success,
    ).toBe(false);
  });

  it("requires operator-supplied standard and long-context AI pricing", () => {
    const configuration = {
      OPENAI_API_KEY: "key",
      OPENAI_MODEL: "model",
      OPENAI_INPUT_USD_PER_1M: 2,
      OPENAI_CACHED_INPUT_USD_PER_1M: 0.2,
      OPENAI_OUTPUT_USD_PER_1M: 12,
      OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS: 272_000,
      OPENAI_LONG_CONTEXT_INPUT_USD_PER_1M: 4,
      OPENAI_LONG_CONTEXT_CACHED_INPUT_USD_PER_1M: 0.4,
      OPENAI_LONG_CONTEXT_OUTPUT_USD_PER_1M: 18,
      OPENAI_WEB_SEARCH_USD_PER_CALL: 0.01,
      AI_MAX_RUN_COST_USD: 5,
    };

    const parsed = aiEnvSchema.safeParse(configuration);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Expected valid AI configuration");
    expect(parsed.data.AI_MAX_MODEL_CALLS).toBe(22);
    expect(aiEnvSchema.safeParse({ ...configuration, AI_MAX_MODEL_CALLS: 23 }).success).toBe(false);
    expect(
      aiEnvSchema.safeParse({
        ...configuration,
        OPENAI_LONG_CONTEXT_OUTPUT_USD_PER_1M: undefined,
      }).success,
    ).toBe(false);
  });

  it("allows an external runner only at an HTTPS origin or loopback HTTP", () => {
    const secret = "x".repeat(32);
    expect(
      verificationEnvSchema.safeParse({
        VERIFICATION_MODE: "external_runner",
        RUNNER_SHARED_SECRET: secret,
        RUNNER_BASE_URL: "http://runner.internal",
      }).success,
    ).toBe(false);
    expect(
      verificationEnvSchema.safeParse({
        VERIFICATION_MODE: "external_runner",
        RUNNER_SHARED_SECRET: secret,
        RUNNER_BASE_URL: "http://localhost:3000",
      }).success,
    ).toBe(true);
  });
});
