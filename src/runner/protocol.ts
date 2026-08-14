import { z } from "zod";
import {
  changedFilePayloadSchema,
  verificationResultSchema,
  type VerificationResult,
} from "@/runs/types";
import { boundedLog } from "@/security/redaction";

export const MAX_RUNNER_ID_LENGTH = 100;
export const MAX_VERIFICATION_COMMANDS = 20;
export const MAX_VERIFICATION_FILES = 20;
export const MAX_VERIFICATION_FILE_BYTES = 512_000;
export const MAX_VERIFICATION_PAYLOAD_BYTES = MAX_VERIFICATION_FILES * MAX_VERIFICATION_FILE_BYTES;
export const MAX_SOURCE_ARCHIVE_BYTES = 250 * 1024 * 1024;
export const MAX_CLAIM_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_RESULT_REQUEST_BYTES = 2 * 1024 * 1024;

const runnerIdSchema = z
  .string()
  .min(3)
  .max(MAX_RUNNER_ID_LENGTH)
  .regex(/^[A-Za-z0-9._:-]+$/, "Runner IDs may only contain safe hostname characters");

const runnerPayloadFileSchema = changedFilePayloadSchema.extend({
  contentBase64: z
    .string()
    .max(Math.ceil(MAX_VERIFICATION_FILE_BYTES / 3) * 4 + 4)
    .nullable(),
});

export const runnerClaimRequestSchema = z.object({
  runnerId: runnerIdSchema,
});

export const runnerClaimJobSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    claimToken: z.uuid(),
    sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/i),
    ecosystem: z.enum(["node", "python", "rust", "go"]),
    installCommand: z.string().min(1).max(1000).nullable(),
    commands: z.array(z.string().min(1).max(1000)).min(1).max(MAX_VERIFICATION_COMMANDS),
    payload: z.array(runnerPayloadFileSchema).min(1).max(MAX_VERIFICATION_FILES),
    sourceUrl: z.string().regex(/^\/api\/runner\/jobs\/[0-9a-f-]+\/source$/i),
  })
  .superRefine((job, context) => {
    if (job.commands.length + (job.installCommand ? 1 : 0) > MAX_VERIFICATION_COMMANDS) {
      context.addIssue({
        code: "custom",
        message: `At most ${MAX_VERIFICATION_COMMANDS} verification steps are allowed`,
        path: ["commands"],
      });
    }
    const encodedBytes = job.payload.reduce(
      (total, file) => total + (file.contentBase64?.length ?? 0),
      0,
    );
    // Base64 is at most 4/3 the decoded size, plus padding per file.
    if (encodedBytes > Math.ceil((MAX_VERIFICATION_PAYLOAD_BYTES * 4) / 3) + 80) {
      context.addIssue({
        code: "custom",
        message: "Verification payload is too large",
        path: ["payload"],
      });
    }
  });

export const runnerClaimResponseSchema = z.object({
  job: runnerClaimJobSchema.nullable(),
});

export const runnerResultRequestSchema = z.object({
  runnerId: runnerIdSchema,
  claimToken: z.uuid(),
  result: verificationResultSchema,
  failure: z
    .object({
      code: z.literal("RUNNER_INFRASTRUCTURE_ERROR"),
      message: z.string().min(1).max(2000),
    })
    .nullable()
    .default(null),
});

export const runnerHeartbeatRequestSchema = z.object({
  runnerId: runnerIdSchema,
  claimToken: z.uuid(),
});

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Runner configuration must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

/** A short renewable lease lets another runner recover work before the parent run times out. */
export function runnerLeaseExpiresAt(now = new Date()): Date {
  const leaseSeconds = boundedInteger(process.env.RUNNER_LEASE_SECONDS, 90, 30, 300);
  return new Date(now.getTime() + leaseSeconds * 1000);
}

export function verificationTimeoutSeconds(): number {
  return boundedInteger(process.env.VERIFICATION_TIMEOUT_SECONDS, 1200, 30, 3600);
}

export function validateRunnerResultForJob(input: {
  result: VerificationResult;
  failure: { code: string; message: string } | null;
  runnerId: string;
  installCommand: string | null;
  commands: string[];
}): VerificationResult {
  const result: VerificationResult = {
    ...input.result,
    commands: input.result.commands.map((command) => ({
      ...command,
      stdout: boundedLog(command.stdout),
      stderr: boundedLog(command.stderr),
    })),
    integrityFindings: input.result.integrityFindings.map((finding) => boundedLog(finding, 1000)),
  };

  if (result.runner !== input.runnerId)
    throw new Error("Verification result runner does not match");
  if (result.status === "NO_COMMANDS") {
    throw new Error("A claimed verification job cannot report NO_COMMANDS");
  }
  if (input.failure && result.status !== "FAILED") {
    throw new Error("An infrastructure failure must report a failed result");
  }
  if (
    input.failure &&
    (result.integrityPassed || result.integrityFindings.length === 0 || result.commands.length > 0)
  ) {
    throw new Error("Infrastructure failure result is internally inconsistent");
  }

  const expected = [...(input.installCommand ? [input.installCommand] : []), ...input.commands];
  if (result.commands.length > expected.length) {
    throw new Error("Verification result contains unexpected commands");
  }
  for (const [index, command] of result.commands.entries()) {
    if (command.command !== expected[index]) {
      throw new Error("Verification result command sequence does not match the job");
    }
    if (index < result.commands.length - 1 && (command.exitCode !== 0 || command.timedOut)) {
      throw new Error("Verification continued after a command failed");
    }
  }

  if (result.status === "PASSED") {
    if (
      input.failure ||
      !result.integrityPassed ||
      result.integrityFindings.length > 0 ||
      result.commands.length !== expected.length ||
      result.commands.some((command) => command.exitCode !== 0 || command.timedOut)
    ) {
      throw new Error("Passed verification result is internally inconsistent");
    }
    return result;
  }

  if (!result.integrityPassed) {
    if (result.integrityFindings.length === 0) {
      throw new Error("Failed integrity verification must include a finding");
    }
    return result;
  }

  if (!input.failure) {
    const lastCommand = result.commands.at(-1);
    if (!lastCommand || (lastCommand.exitCode === 0 && !lastCommand.timedOut)) {
      throw new Error("Failed verification result must identify a failed command");
    }
  }
  return result;
}
