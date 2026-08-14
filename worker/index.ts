import os from "node:os";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "../src/db/client";
import { aiRuns, verificationJobs, workerHeartbeats, workspaces } from "../src/db/schema";
import { readAiEnv, readGithubAppEnv, readPlanEnv, readVerificationEnv } from "../src/lib/env";
import { logger } from "../src/lib/logger";
import { processClaimedRun } from "../src/runs/process";

const workerId = process.env.WORKER_ID ?? `${os.hostname()}-${process.pid}`;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Worker setting must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

const pollInterval = boundedInteger(process.env.WORKER_POLL_INTERVAL_MS, 3000, 250, 60_000);
const concurrency = boundedInteger(process.env.WORKER_CONCURRENCY, 2, 1, 32);
const staleMinutes = boundedInteger(process.env.WORKER_STALE_AFTER_MINUTES, 15, 2, 1440);
const active = new Set<Promise<void>>();
const shutdown = new AbortController();
const processingStatuses = [
  "READING_REPOSITORY",
  "FINDING_APIS",
  "RESEARCHING_APIS",
  "PLANNING_CHANGES",
  "UPDATING_CODE",
  "VERIFYING",
  "REPAIRING",
  "CREATING_PR",
];
let lastRecoveryAt = 0;
let lastHeartbeatLogAt = 0;

function validateWorkerConfiguration(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const protocol = new URL(databaseUrl).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  readGithubAppEnv();
  readAiEnv();
  readPlanEnv();
  readVerificationEnv();
}

async function heartbeat() {
  await db
    .insert(workerHeartbeats)
    .values({ id: workerId, kind: "RUN_WORKER", version: "0.1.0", metadata: { concurrency } })
    .onConflictDoUpdate({
      target: workerHeartbeats.id,
      set: { heartbeatAt: new Date(), metadata: { concurrency } },
    });
  if (Date.now() - lastHeartbeatLogAt >= 60_000) {
    logger.info("worker_heartbeat", { workerId, concurrency, activeRuns: active.size });
    lastHeartbeatLogAt = Date.now();
  }
}

async function recoverStaleWork() {
  const staleAt = new Date(Date.now() - staleMinutes * 60_000);
  await db
    .update(aiRuns)
    .set({
      status: "QUEUED",
      stage: "QUEUED",
      claimToken: null,
      claimedAt: null,
      heartbeatAt: null,
    })
    .where(
      and(
        inArray(aiRuns.status, processingStatuses),
        or(
          lt(aiRuns.heartbeatAt, staleAt),
          and(isNull(aiRuns.heartbeatAt), lt(aiRuns.claimedAt, staleAt)),
        ),
      ),
    );
  await db
    .update(verificationJobs)
    .set({
      status: "QUEUED",
      claimToken: null,
      claimedAt: null,
      heartbeatAt: null,
      runnerId: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(verificationJobs.status, "RUNNING"),
        or(
          isNull(verificationJobs.leaseExpiresAt),
          lt(verificationJobs.leaseExpiresAt, new Date()),
        ),
      ),
    );
  lastRecoveryAt = Date.now();
}

async function claimRun() {
  return db.transaction(async (transaction) => {
    const candidates = await transaction
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.status, "QUEUED"))
      .orderBy(aiRuns.createdAt)
      .for("update", { skipLocked: true })
      .limit(Math.max(20, concurrency * 4));
    const checkedWorkspaces = new Set<string>();

    for (const candidate of candidates) {
      if (checkedWorkspaces.has(candidate.workspaceId)) continue;
      checkedWorkspaces.add(candidate.workspaceId);

      // The workspace row is the concurrency mutex. Two workers may lock
      // different queued rows for one workspace, so locking only the run is not enough.
      await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, candidate.workspaceId))
        .for("update")
        .limit(1);
      const [workspaceActive] = await transaction
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.workspaceId, candidate.workspaceId),
            inArray(aiRuns.status, processingStatuses),
          ),
        )
        .limit(1);
      if (workspaceActive) continue;

      const claimToken = crypto.randomUUID();
      const now = new Date();
      const [claimed] = await transaction
        .update(aiRuns)
        .set({
          status: "READING_REPOSITORY",
          stage: "READING_REPOSITORY",
          claimToken,
          claimedAt: now,
          heartbeatAt: now,
          startedAt: candidate.startedAt ?? now,
          attemptCount: candidate.attemptCount + 1,
          updatedAt: now,
        })
        .where(and(eq(aiRuns.id, candidate.id), eq(aiRuns.status, "QUEUED")))
        .returning();
      if (claimed) return { run: claimed, claimToken };
    }
    return null;
  });
}

async function startClaimedRun() {
  const claimed = await claimRun();
  if (!claimed) return false;
  const task = processClaimedRun(claimed.run, claimed.claimToken).catch(() => undefined);
  active.add(task);
  void task.finally(() => active.delete(task));
  return true;
}

async function waitForPollInterval(): Promise<void> {
  if (shutdown.signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, pollInterval);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timeout);
      shutdown.signal.removeEventListener("abort", onAbort);
      resolve();
    }
    shutdown.signal.addEventListener("abort", onAbort, { once: true });
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info("worker_shutdown_requested", { workerId, signal });
    shutdown.abort(new Error(`Worker received ${signal}`));
  });
}

async function main(): Promise<void> {
  validateWorkerConfiguration();
  logger.info("worker_started", { workerId, concurrency });
  await recoverStaleWork();
  while (!shutdown.signal.aborted) {
    try {
      await heartbeat();
      if (Date.now() - lastRecoveryAt >= 60_000) await recoverStaleWork();
      let claimedAny = false;
      while (!shutdown.signal.aborted && active.size < concurrency) {
        const claimed = await startClaimedRun();
        if (!claimed) break;
        claimedAny = true;
      }
      if (!claimedAny) await waitForPollInterval();
    } catch {
      if (shutdown.signal.aborted) break;
      logger.error("worker_iteration_failed", { workerId, errorCode: "WORKER_LOOP" });
      await waitForPollInterval();
    }
  }
  await Promise.allSettled([...active]);
  logger.info("worker_stopped", { workerId });
}

void main().catch(() => {
  logger.error("worker_start_failed", { workerId, errorCode: "WORKER_START" });
  process.exitCode = 1;
});
