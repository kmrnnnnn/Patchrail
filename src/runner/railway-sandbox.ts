import { promises as fs } from "node:fs";
import { Sandbox } from "railway";
import { readVerificationEnv } from "@/lib/env";
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
const MAX_DOCKER_START_DIAGNOSTIC_BYTES = 4 * 1024;
const DOCKER_START_TIMEOUT_SECONDS = 45;
const VERIFIER_SANDBOX_TEMPLATE = Sandbox.template()
  // Debian 13 splits the CLI into a recommended package, while the SDK builds
  // minimal templates with --no-install-recommends.
  .withPackages("docker.io", "docker-cli")
  .run("docker --version >/dev/null && dockerd --version >/dev/null");
const START_DOCKER_DAEMON_COMMAND = [
  "set -eu",
  "if docker info >/dev/null 2>&1; then exit 0; fi",
  "rm -f /var/run/docker.pid /var/run/docker.sock",
  "nohup dockerd --host=unix:///var/run/docker.sock >/tmp/patchrail-dockerd.log 2>&1 </dev/null &",
  "attempt=0",
  'while [ "$attempt" -lt 30 ]; do if docker info >/dev/null 2>&1; then exit 0; fi; attempt=$((attempt + 1)); sleep 1; done',
  `tail -c ${MAX_DOCKER_START_DIAGNOSTIC_BYTES} /tmp/patchrail-dockerd.log >&2 || true`,
  "exit 1",
].join("\n");

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
  const verificationEnvironment = readVerificationEnv();
  if (verificationEnvironment.VERIFICATION_MODE !== "railway_sandbox") {
    throw new Error("Railway Sandbox verification requires VERIFICATION_MODE=railway_sandbox");
  }
  const sandbox = await Sandbox.create(VERIFIER_SANDBOX_TEMPLATE, {
    networkIsolation: "ISOLATED",
    idleTimeoutMinutes: verificationEnvironment.RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES,
  });
  let primaryError: unknown = null;

  try {
    await input.onCreated?.(sandbox.id);
    const dockerStartup = await sandbox.exec(START_DOCKER_DAEMON_COMMAND, {
      timeoutSec: DOCKER_START_TIMEOUT_SECONDS,
    });
    if (dockerStartup.exitCode !== 0 || dockerStartup.timedOut) {
      const diagnostics = dockerStartup.stderr.slice(-MAX_DOCKER_START_DIAGNOSTIC_BYTES);
      throw new Error(
        `Railway Sandbox Docker daemon failed to start${diagnostics ? `: ${diagnostics}` : ""}`,
      );
    }
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
