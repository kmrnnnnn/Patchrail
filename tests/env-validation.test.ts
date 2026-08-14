import { describe, expect, it } from "vitest";
import { commonEnvSchema, verificationEnvSchema } from "@/lib/env";

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
    expect(
      verificationEnvSchema.safeParse({
        VERIFICATION_MODE: "railway_sandbox",
        RAILWAY_ENVIRONMENT_ID: "environment",
        RAILWAY_TOKEN: "project-token",
      }).success,
    ).toBe(true);
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
