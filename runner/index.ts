import { createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundedLog } from "../src/security/redaction";
import { executeVerification, extractGitHubArchive } from "../src/runner/execute";
import {
  MAX_CLAIM_RESPONSE_BYTES,
  MAX_RESULT_REQUEST_BYTES,
  MAX_SOURCE_ARCHIVE_BYTES,
  runnerClaimResponseSchema,
  runnerResultRequestSchema,
} from "../src/runner/protocol";
import type { VerificationResult } from "../src/runs/types";
import type { z } from "zod";

const rawBaseUrl = process.env.RUNNER_BASE_URL;
const secret = process.env.RUNNER_SHARED_SECRET;
if (!rawBaseUrl || !secret || Buffer.byteLength(secret) < 32)
  throw new Error("RUNNER_BASE_URL and a 32-byte RUNNER_SHARED_SECRET are required");

const baseUrl = new URL(rawBaseUrl);
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error("RUNNER_BASE_URL must not contain credentials, a query, or a fragment");
}
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (
  baseUrl.protocol !== "https:" &&
  !(baseUrl.protocol === "http:" && loopbackHosts.has(baseUrl.hostname))
) {
  throw new Error("RUNNER_BASE_URL must use HTTPS outside local development");
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Runner setting must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

const rawRunnerId = process.env.RUNNER_ID ?? `${os.hostname()}-${process.pid}`;
const sanitizedRunnerId = rawRunnerId.replace(/[^A-Za-z0-9._:-]/g, "-");
const runnerId =
  sanitizedRunnerId.length <= 100
    ? sanitizedRunnerId
    : `${sanitizedRunnerId.slice(0, 83)}-${createHash("sha256").update(rawRunnerId).digest("hex").slice(0, 16)}`;
if (runnerId.length < 3) throw new Error("RUNNER_ID must contain at least three safe characters");
const intervalMs = boundedInteger(process.env.RUNNER_POLL_INTERVAL_MS, 3000, 250, 60_000);
const concurrency = boundedInteger(process.env.RUNNER_MAX_CONCURRENCY, 1, 1, 16);
const shutdown = new AbortController();

function authenticatedHeaders(): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

function jsonHeaders(): Record<string, string> {
  return { ...authenticatedHeaders(), "content-type": "application/json" };
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new Error("Runner API response exceeded its size limit");
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("Runner API response exceeded its size limit");
        throw new Error("Runner API response exceeded its size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

async function claimNextJob() {
  const response = await fetch(new URL("/api/runner/jobs/claim", baseUrl), {
    method: "POST",
    headers: jsonHeaders(),
    redirect: "error",
    signal: requestSignal(15_000, shutdown.signal),
    body: JSON.stringify({ runnerId }),
  });
  const body = await readBoundedResponse(response, MAX_CLAIM_RESPONSE_BYTES);
  if (!response.ok) throw new Error(`Runner claim failed with ${response.status}`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Runner claim response was not valid JSON");
  }
  return runnerClaimResponseSchema.parse(decoded).job;
}

type ClaimedJob = NonNullable<Awaited<ReturnType<typeof claimNextJob>>>;

function sourceUrlForJob(job: ClaimedJob): URL {
  const sourceUrl = new URL(job.sourceUrl, baseUrl);
  if (sourceUrl.origin !== baseUrl.origin) throw new Error("Runner source URL changed origin");
  const expectedPath = `/api/runner/jobs/${job.id}/source`;
  if (sourceUrl.pathname !== expectedPath || sourceUrl.search || sourceUrl.hash) {
    throw new Error("Runner source URL is invalid");
  }
  return sourceUrl;
}

async function downloadSource(job: ClaimedJob, destination: string, signal: AbortSignal) {
  const response = await fetch(sourceUrlForJob(job), {
    headers: {
      ...authenticatedHeaders(),
      "x-patchrail-claim-token": job.claimToken,
      "x-patchrail-runner-id": runnerId,
    },
    redirect: "error",
    // The run worker reserves three minutes of orchestration overhead beyond
    // the verifier timeout, so source transfer must leave time for extraction.
    signal: requestSignal(2 * 60_000, signal),
  });
  if (!response.ok) {
    await readBoundedResponse(response, 8192).catch(() => Buffer.alloc(0));
    throw new Error(`Source download failed with ${response.status}`);
  }
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/gzip") {
    throw new Error("Source download returned an unexpected content type");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength <= 0 ||
    declaredLength > MAX_SOURCE_ARCHIVE_BYTES
  ) {
    throw new Error("Source archive size is missing or outside the safe limit");
  }
  const expectedDigest = response.headers.get("x-patchrail-archive-sha256")?.toLowerCase();
  if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error("Source archive digest is missing or invalid");
  }
  if (!response.body) throw new Error("Source archive response was empty");

  const file = await fs.open(destination, "wx");
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  let total = 0;
  let downloadError: unknown = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_SOURCE_ARCHIVE_BYTES || total > declaredLength) {
        await reader.cancel("Source archive exceeded its declared size");
        throw new Error("Source archive exceeded its safe size limit");
      }
      digest.update(value);
      await file.write(value);
    }
  } catch (error) {
    downloadError = error;
  } finally {
    reader.releaseLock();
    await file.close();
  }
  if (downloadError) {
    await fs.rm(destination, { force: true });
    throw downloadError;
  }
  if (total !== declaredLength || total === 0) {
    await fs.rm(destination, { force: true });
    throw new Error("Source archive length did not match its response");
  }
  const actualDigest = digest.digest();
  const expectedDigestBuffer = Buffer.from(expectedDigest, "hex");
  if (!timingSafeEqual(actualDigest, expectedDigestBuffer)) {
    await fs.rm(destination, { force: true });
    throw new Error("Source archive digest mismatch");
  }
}

function startHeartbeat(job: ClaimedJob, controller: AbortController): () => Promise<void> {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const pulse = async () => {
    try {
      const response = await fetch(new URL(`/api/runner/jobs/${job.id}/heartbeat`, baseUrl), {
        method: "POST",
        headers: jsonHeaders(),
        redirect: "error",
        signal: requestSignal(8000, controller.signal),
        body: JSON.stringify({ runnerId, claimToken: job.claimToken }),
      });
      await readBoundedResponse(response, 8192);
      if (response.status === 401 || response.status === 409) {
        controller.abort(new Error("Verification job lease was lost"));
        return;
      }
      if (!response.ok) throw new Error(`Heartbeat failed with ${response.status}`);
      failures = 0;
    } catch (error) {
      if (controller.signal.aborted || stopped) return;
      failures += 1;
      if (failures >= 3) {
        controller.abort(new Error("Verification runner could not renew its job lease"));
        return;
      }
      console.error(
        JSON.stringify({
          level: "warn",
          event: "runner_heartbeat_failed",
          runnerId,
          jobId: job.id,
          error: boundedLog(error instanceof Error ? error.message : "unknown", 500),
        }),
      );
    } finally {
      inFlight = null;
      if (!stopped && !controller.signal.aborted) {
        timer = setTimeout(() => {
          inFlight = pulse();
        }, 10_000);
      }
    }
  };
  inFlight = pulse();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight?.catch(() => undefined);
  };
}

type ResultRequest = z.input<typeof runnerResultRequestSchema>;

async function uploadResult(job: ClaimedJob, body: ResultRequest): Promise<void> {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > MAX_RESULT_REQUEST_BYTES) {
    throw new Error("Verification result exceeded its upload limit");
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(new URL(`/api/runner/jobs/${job.id}/result`, baseUrl), {
        method: "POST",
        headers: jsonHeaders(),
        redirect: "error",
        signal: requestSignal(15_000),
        body: encoded,
      });
      await readBoundedResponse(response, 8192);
      if (response.ok) return;
      if (response.status < 500) throw new Error(`Result upload failed with ${response.status}`);
      lastError = new Error(`Result upload failed with ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Result upload failed");
      if (/with 4\d\d$/.test(lastError.message)) throw lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  throw lastError ?? new Error("Result upload failed");
}

function infrastructureFailure(
  startedAt: Date,
  error: unknown,
): { result: VerificationResult; failure: NonNullable<ResultRequest["failure"]> } {
  const message = boundedLog(
    error instanceof Error ? error.message : "Unknown runner failure",
    1000,
  );
  return {
    result: {
      status: "FAILED",
      commands: [],
      integrityPassed: false,
      integrityFindings: [`Verification infrastructure error: ${message}`],
      runner: runnerId,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    },
    failure: { code: "RUNNER_INFRASTRUCTURE_ERROR", message },
  };
}

async function processJob(job: ClaimedJob): Promise<void> {
  const startedAt = new Date();
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "patchrail-runner-"));
  const archivePath = path.join(temporaryRoot, "source.tgz");
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const jobController = new AbortController();
  const abortForShutdown = () => jobController.abort(new Error("Runner is shutting down"));
  shutdown.signal.addEventListener("abort", abortForShutdown, { once: true });
  const stopHeartbeat = startHeartbeat(job, jobController);

  try {
    let result: VerificationResult;
    let failure: ResultRequest["failure"] = null;
    try {
      await downloadSource(job, archivePath, jobController.signal);
      await extractGitHubArchive(archivePath, repositoryRoot);
      result = await executeVerification({
        root: repositoryRoot,
        ecosystem: job.ecosystem,
        installCommand: job.installCommand,
        commands: job.commands,
        payload: job.payload,
        runnerId,
        signal: jobController.signal,
      });
    } catch (error) {
      ({ result, failure } = infrastructureFailure(startedAt, error));
    }
    await uploadResult(job, { runnerId, claimToken: job.claimToken, result, failure });
  } finally {
    await stopHeartbeat();
    shutdown.signal.removeEventListener("abort", abortForShutdown);
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function processNext(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) return false;
  await processJob(job);
  return true;
}

async function waitForPollInterval(): Promise<void> {
  if (shutdown.signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, intervalMs);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timeout);
      shutdown.signal.removeEventListener("abort", onAbort);
      resolve();
    }
    shutdown.signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runnerLoop(slot: number): Promise<void> {
  while (!shutdown.signal.aborted) {
    try {
      const processed = await processNext();
      if (!processed) await waitForPollInterval();
    } catch (error) {
      if (shutdown.signal.aborted) break;
      console.error(
        JSON.stringify({
          level: "error",
          event: "runner_iteration_failed",
          runnerId,
          slot,
          error: boundedLog(error instanceof Error ? error.message : "unknown", 1000),
        }),
      );
      await waitForPollInterval();
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort(new Error(`Runner received ${signal}`)));
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ level: "info", event: "runner_started", runnerId, concurrency }));
  await Promise.all(Array.from({ length: concurrency }, (_, slot) => runnerLoop(slot + 1)));
}

void main().catch(() => {
  console.error(JSON.stringify({ level: "error", event: "runner_start_failed", runnerId }));
  process.exitCode = 1;
});
