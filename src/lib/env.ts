import { z } from "zod";

const positiveNumber = z.coerce.number().finite().positive();
const positiveInt = z.coerce.number().int().positive();
const databaseUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "postgres:" || protocol === "postgresql:";
      } catch {
        return false;
      }
    },
    { message: "DATABASE_URL must use postgres:// or postgresql://" },
  );
const runnerBaseUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/" &&
          (url.protocol === "https:" || (url.protocol === "http:" && loopback))
        );
      } catch {
        return false;
      }
    },
    { message: "RUNNER_BASE_URL must be an HTTPS origin (HTTP is allowed only on loopback)" },
  );
const appUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/" &&
          (url.protocol === "https:" || (url.protocol === "http:" && loopback))
        );
      } catch {
        return false;
      }
    },
    { message: "APP_URL must be an HTTPS origin (HTTP is allowed only on loopback)" },
  );

export const commonEnvSchema = z.object({
  DATABASE_URL: databaseUrl,
  APP_URL: appUrl,
  AUTH_SECRET: z.string().min(32),
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1),
});

export const githubAppEnvSchema = z.object({
  GITHUB_APP_ID: positiveInt,
  GITHUB_APP_SLUG: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
});

export const aiEnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1),
  OPENAI_INPUT_USD_PER_1M: positiveNumber,
  OPENAI_OUTPUT_USD_PER_1M: positiveNumber,
  // Pricing is deliberately operator-supplied rather than hardcoded because
  // model and hosted-tool rates are volatile. Zero would silently undercount.
  OPENAI_CACHED_INPUT_USD_PER_1M: positiveNumber,
  OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS: positiveInt,
  OPENAI_LONG_CONTEXT_INPUT_USD_PER_1M: positiveNumber,
  OPENAI_LONG_CONTEXT_CACHED_INPUT_USD_PER_1M: positiveNumber,
  OPENAI_LONG_CONTEXT_OUTPUT_USD_PER_1M: positiveNumber,
  OPENAI_WEB_SEARCH_USD_PER_CALL: positiveNumber,
  OPENAI_MAX_WEB_SEARCH_CALLS_PER_RESPONSE: positiveInt.default(4),
  AI_MAX_RUN_COST_USD: positiveNumber,
  AI_MAX_MODEL_CALLS: positiveInt.default(8),
  AI_MAX_RESEARCH_CALLS: positiveInt.default(12),
  AI_MAX_REPOSITORY_READS: positiveInt.default(80),
  AI_MAX_FILES_WRITTEN: positiveInt.default(20),
  AI_MAX_CONTEXT_BYTES: positiveInt.default(250_000),
  AI_MAX_INPUT_TOKENS: positiveInt.default(400_000),
  AI_MAX_OUTPUT_TOKENS: positiveInt.default(20_000),
  AI_MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(1).default(1),
  AI_MAX_ELAPSED_MINUTES: positiveInt.default(45),
});

export const stripeEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  STRIPE_ACCOUNT_KEY: z.string().trim().min(1),
  STRIPE_PRO_LOOKUP_KEY: z.string().trim().min(1),
});

export const planEnvSchema = z.object({
  FREE_REPOSITORY_LIMIT: positiveInt.default(1),
  PRO_REPOSITORY_LIMIT: positiveInt.default(20),
  FREE_AI_BUDGET_USD: positiveNumber.default(5),
  PRO_AI_BUDGET_USD: positiveNumber.default(100),
});

export const verificationEnvSchema = z
  .discriminatedUnion("VERIFICATION_MODE", [
    z.object({
      VERIFICATION_MODE: z.literal("external_runner"),
      RUNNER_SHARED_SECRET: z.string().min(32),
      RUNNER_BASE_URL: runnerBaseUrl,
    }),
    z.object({
      VERIFICATION_MODE: z.literal("railway_sandbox"),
      RAILWAY_ENVIRONMENT_ID: z.string().min(1),
      RAILWAY_TOKEN: z.string().min(1).optional(),
      RAILWAY_API_TOKEN: z.string().min(1).optional(),
      RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(5),
    }),
  ])
  .superRefine((configuration, context) => {
    if (
      configuration.VERIFICATION_MODE === "railway_sandbox" &&
      !configuration.RAILWAY_TOKEN &&
      !configuration.RAILWAY_API_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        path: ["RAILWAY_TOKEN"],
        message: "A Railway project or account token is required for sandbox verification",
      });
    }
  });

function fromProcessEnv(): Record<string, string | undefined> {
  return process.env;
}

export function readCommonEnv() {
  return commonEnvSchema.parse(fromProcessEnv());
}

export function readGithubAppEnv() {
  return githubAppEnvSchema.parse(fromProcessEnv());
}

export function readAiEnv() {
  return aiEnvSchema.parse(fromProcessEnv());
}

export function readStripeEnv() {
  return stripeEnvSchema.parse(fromProcessEnv());
}

export function readPlanEnv() {
  return planEnvSchema.parse(fromProcessEnv());
}

export function readVerificationEnv() {
  return verificationEnvSchema.parse(fromProcessEnv());
}

export type ConfigurationArea = "database" | "auth" | "github" | "ai" | "billing" | "runner";

export function getConfigurationStatus(): Record<ConfigurationArea, boolean> {
  const env = fromProcessEnv();
  const runnerInput = {
    ...env,
    VERIFICATION_MODE: env.VERIFICATION_MODE ?? "external_runner",
  };

  return {
    database: databaseUrl.safeParse(env.DATABASE_URL).success,
    auth: commonEnvSchema.safeParse(env).success,
    github: githubAppEnvSchema.safeParse(env).success,
    ai: aiEnvSchema.safeParse(env).success,
    billing: stripeEnvSchema.safeParse(env).success,
    runner: verificationEnvSchema.safeParse(runnerInput).success,
  };
}

export function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n");
}
