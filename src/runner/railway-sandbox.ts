import { promises as fs } from "node:fs";
import { Sandbox } from "railway";
import {
  runnerClaimJobSchema,
  MAX_SOURCE_ARCHIVE_BYTES,
  validateRunnerResultForJob,
  verificationTimeoutSeconds,
} from "@/runner/protocol";
import { verificationResourceLimits } from "@/runner/execute";
import {
  verificationResultSchema,
  type ChangedFilePayload,
  type VerificationResult,
} from "@/runs/types";

const MAX_DRIVER_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Runs the hardened Docker verifier inside a disposable Railway Sandbox VM.
 * No application, GitHub, model-provider, billing, or database secret is
 * uploaded. The sandbox receives only the pinned repository archive and patch.
 */
export async function verifyInRailwaySandbox(input: {
  archive: Buffer;
  ecosystem: string;
  installCommand: string | null;
  commands: string[];
  payload: ChangedFilePayload[];
  onCreated?: (sandboxId: string) => Promise<void>;
}): Promise<VerificationResult> {
  if (input.archive.byteLength === 0 || input.archive.byteLength > MAX_SOURCE_ARCHIVE_BYTES) {
    throw new Error("Repository archive is outside the Railway Sandbox size limit");
  }

  const descriptor = runnerClaimJobSchema.parse({
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    claimToken: crypto.randomUUID(),
    sourceCommitSha: "0".repeat(40),
    ecosystem: input.ecosystem,
    installCommand: input.installCommand,
    commands: input.commands,
    payload: input.payload,
    sourceUrl: `/api/runner/jobs/${crypto.randomUUID()}/source`,
  });
  const timeoutSeconds = verificationTimeoutSeconds();
  const resources = verificationResourceLimits();
  const sandbox = await Sandbox.create({
    networkIsolation: "ISOLATED",
    idleTimeoutMinutes: 30,
  });
  let primaryError: unknown = null;

  try {
    await input.onCreated?.(sandbox.id);
    await sandbox.files.write("/patchrail/source.tgz", new Uint8Array(input.archive));
    await sandbox.files.write(
      "/patchrail/job.json",
      JSON.stringify({
        ecosystem: descriptor.ecosystem,
        installCommand: descriptor.installCommand,
        commands: descriptor.commands,
        payload: descriptor.payload,
        timeoutSeconds,
        ...resources,
      }),
    );
    const driverSource = await fs.readFile(
      new URL("./sandbox-driver.mjs", import.meta.url),
      "utf8",
    );
    await sandbox.files.write("/patchrail/driver.mjs", driverSource);
    const execution = await sandbox.exec("node /patchrail/driver.mjs", {
      timeoutSec: timeoutSeconds + 300,
    });
    if (execution.exitCode !== 0 || execution.timedOut) {
      throw new Error(`Railway Sandbox verifier failed: ${execution.stderr.slice(0, 2000)}`);
    }
    if (Buffer.byteLength(execution.stdout, "utf8") > MAX_DRIVER_OUTPUT_BYTES) {
      throw new Error("Railway Sandbox verifier returned an oversized result");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(execution.stdout);
    } catch {
      throw new Error("Railway Sandbox verifier returned invalid JSON");
    }
    const result = verificationResultSchema.parse(decoded);
    return validateRunnerResultForJob({
      result,
      failure: null,
      runnerId: "railway-sandbox",
      installCommand: descriptor.installCommand,
      commands: descriptor.commands,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await sandbox.destroy();
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}
