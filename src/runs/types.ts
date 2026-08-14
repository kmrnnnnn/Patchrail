import { z } from "zod";

export const RUN_STATUSES = [
  "QUEUED",
  "READING_REPOSITORY",
  "FINDING_APIS",
  "RESEARCHING_APIS",
  "PLANNING_CHANGES",
  "UPDATING_CODE",
  "VERIFYING",
  "REPAIRING",
  "CREATING_PR",
  "SUCCEEDED",
  "FAILED",
  "NEEDS_INPUT",
] as const;

export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const TERMINAL_RUN_STATUSES = ["SUCCEEDED", "FAILED", "NEEDS_INPUT"] as const;

export const API_STATUSES = [
  "CURRENT",
  "UPDATE_AVAILABLE",
  "DEPRECATED_USAGE",
  "BREAKING_CHANGE_RELEVANT",
  "MIGRATION_REQUIRED",
  "INSUFFICIENT_EVIDENCE",
] as const;

export const apiStatusSchema = z.enum(API_STATUSES);
export type ApiStatus = z.infer<typeof apiStatusSchema>;

export const evidenceReferenceSchema = z.object({
  path: z.string().min(1).max(500),
  lineStart: z.number().int().positive().nullable(),
  lineEnd: z.number().int().positive().nullable(),
  excerpt: z.string().max(500),
});

export const detectedApiSchema = z.object({
  id: z.string().min(1).max(120),
  provider: z.string().min(1).max(160),
  product: z.string().min(1).max(200),
  sdkPackage: z.string().max(200).nullable(),
  observedVersion: z.string().max(100).nullable(),
  usageSummary: z.string().min(1).max(2000),
  methods: z.array(z.string().max(300)).max(30),
  files: z.array(z.string().min(1).max(500)).max(100),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceReferenceSchema).min(1).max(30),
  status: apiStatusSchema,
  conclusion: z.string().min(1).max(3000),
});
export type DetectedApi = z.infer<typeof detectedApiSchema>;

export const researchSourceSchema = z.object({
  apiId: z.string().min(1).max(120),
  url: z.url().max(2000),
  title: z.string().min(1).max(500),
  sourceType: z.enum([
    "OFFICIAL_DOCS",
    "OFFICIAL_API_REFERENCE",
    "OFFICIAL_MIGRATION_GUIDE",
    "OFFICIAL_CHANGELOG",
    "OFFICIAL_SDK_REPOSITORY",
    "OFFICIAL_SCHEMA",
    "SECONDARY_LOCATOR",
  ]),
  summary: z.string().min(1).max(1800),
  retrievedAt: z.iso.datetime(),
  relevance: z.string().min(1).max(1000),
  authoritative: z.boolean(),
});
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const changePlanSchema = z.object({
  summary: z.string().min(1).max(3000),
  filesToChange: z.array(z.string().min(1).max(500)).max(100),
  dependencyChanges: z.array(z.string().max(1000)).max(50),
  sourceChanges: z.array(z.string().max(1000)).max(100),
  configurationChanges: z.array(z.string().max(1000)).max(50),
  testChanges: z.array(z.string().max(1000)).max(50),
  risks: z.array(z.string().max(1000)).max(50),
  verificationStrategy: z.array(z.string().max(500)).max(30),
});
export type ChangePlan = z.infer<typeof changePlanSchema>;

export const agentResultSchema = z.object({
  summary: z.string().min(1).max(4000),
  detectedApis: z.array(detectedApiSchema).max(30),
  research: z.array(researchSourceSchema).max(120),
  plan: changePlanSchema.nullable(),
  needsInput: z.boolean(),
  question: z.string().max(1000).nullable(),
});
export type AgentResult = z.infer<typeof agentResultSchema>;

export const changedFileSchema = z.object({
  path: z.string().min(1).max(500),
  operation: z.enum(["CREATE", "UPDATE", "DELETE"]),
  beforeSha256: z.string().length(64).nullable(),
  afterSha256: z.string().length(64).nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const changedFilePayloadSchema = changedFileSchema.extend({
  contentBase64: z.string().nullable(),
});
export type ChangedFilePayload = z.infer<typeof changedFilePayloadSchema>;

export const modelUsageSchema = z.object({
  callId: z.string().min(1),
  model: z.string().min(1),
  purpose: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  webSearchCalls: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

export const verificationCommandSchema = z.object({
  command: z.string().min(1).max(1000),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string().max(30000),
  stderr: z.string().max(30000),
  timedOut: z.boolean(),
});

export const verificationResultSchema = z.object({
  status: z.enum(["PASSED", "FAILED", "NO_COMMANDS"]),
  commands: z.array(verificationCommandSchema).max(20),
  integrityPassed: z.boolean(),
  integrityFindings: z.array(z.string().max(1000)).max(50),
  runner: z.string().min(1).max(100),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

export type RunEventDetails = Record<string, string | number | boolean | null>;

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function isUpdateRequired(status: ApiStatus): boolean {
  return ["DEPRECATED_USAGE", "BREAKING_CHANGE_RELEVANT", "MIGRATION_REQUIRED"].includes(status);
}
