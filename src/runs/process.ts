import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { aiRuns, verificationJobs } from "@/db/schema";
import {
  completeClaimedRun,
  pauseClaimedRunForInput,
  resumeRunCost,
  usdToMicros,
} from "@/billing/costs";
import { runRepositoryAgent } from "@/ai/agent";
import { totalModelCost } from "@/ai/cost";
import { discoverVerificationCommands, RepositoryWorkspace } from "@/ai/repository";
import {
  buildPatchrailPullRequestBody,
  deliverDraftPullRequest,
  fetchPinnedRepositorySource,
} from "@/github";
import { readAiEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { stableJson } from "@/lib/stable-json";
import { appendClaimedRunEvent, transitionRun } from "@/runs/events";
import { classifyRunError, VerificationInfrastructureError } from "@/runs/error-metadata";
import type { AgentResult, ChangedFilePayload, ModelUsage, VerificationResult } from "@/runs/types";
import { isUpdateRequired } from "@/runs/types";
import { boundedLog } from "@/security/redaction";
import { extractGitHubArchive } from "@/runner/execute";
import { verificationTimeoutSeconds } from "@/runner/protocol";

type ClaimedRun = typeof aiRuns.$inferSelect;
type AiConfiguration = ReturnType<typeof readAiEnv>;

function toCostString(value: number): string {
  return value.toFixed(6);
}

async function updateArtifacts(input: {
  runId: string;
  claimToken: string;
  result: AgentResult;
  usage: ModelUsage[];
  changedFiles: Awaited<ReturnType<RepositoryWorkspace["getChangedFiles"]>>;
}) {
  const [updated] = await db
    .update(aiRuns)
    .set({
      summary: input.result.summary,
      detectedApis: input.result.detectedApis,
      research: input.result.research,
      plan: input.result.plan,
      changedFiles: input.changedFiles,
      modelUsage: input.usage,
      actualCostUsd: toCostString(totalModelCost(input.usage)),
      inputQuestion: input.result.question,
      updatedAt: new Date(),
    })
    .where(and(eq(aiRuns.id, input.runId), eq(aiRuns.claimToken, input.claimToken)))
    .returning({ id: aiRuns.id });
  if (!updated) throw new Error("Run claim was lost");
}

async function createVerificationJob(input: {
  runId: string;
  claimToken: string;
  attempt: number;
  sourceCommitSha: string;
  ecosystem: string;
  installCommand: string | null;
  commands: string[];
  payload: ChangedFilePayload[];
  initialStatus?: "QUEUED" | "RUNNING";
  executionToken?: string;
  agentResult?: AgentResult;
  usage?: ModelUsage[];
  changedFiles?: Awaited<ReturnType<RepositoryWorkspace["getChangedFiles"]>>;
  repairState?: "PREPARED";
}) {
  if (input.initialStatus === "RUNNING" && !input.executionToken) {
    throw new Error("A Railway verification execution token is required");
  }
  return db.transaction(async (transaction) => {
    const [owned] = await transaction
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(and(eq(aiRuns.id, input.runId), eq(aiRuns.claimToken, input.claimToken)))
      .for("update")
      .limit(1);
    if (!owned) throw new Error("Run claim was lost");

    const [existing] = await transaction
      .select()
      .from(verificationJobs)
      .where(
        and(eq(verificationJobs.runId, input.runId), eq(verificationJobs.attempt, input.attempt)),
      )
      .limit(1);
    if (existing) {
      const matches =
        existing.sourceCommitSha === input.sourceCommitSha &&
        existing.ecosystem === input.ecosystem &&
        existing.installCommand === input.installCommand &&
        stableJson(existing.commands) === stableJson(input.commands) &&
        stableJson(existing.payload) === stableJson(input.payload) &&
        (input.agentResult === undefined ||
          stableJson(existing.agentResult) === stableJson(input.agentResult));
      if (!matches) throw new Error("Existing verification job does not match the pinned patch");
      if (
        input.initialStatus === "RUNNING" &&
        existing.status !== "SUCCEEDED" &&
        existing.status !== "FAILED"
      ) {
        const [running] = await transaction
          .update(verificationJobs)
          .set({
            status: "RUNNING",
            runnerId: "railway-sandbox",
            claimToken: input.executionToken,
            claimedAt: new Date(),
            heartbeatAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + (verificationTimeoutSeconds() + 300) * 1_000),
            updatedAt: new Date(),
          })
          .where(eq(verificationJobs.id, existing.id))
          .returning();
        if (!running) throw new Error("Railway verification job could not be resumed");
        return { job: running, created: false };
      }
      return { job: existing, created: false };
    }

    const [job] = await transaction
      .insert(verificationJobs)
      .values({
        runId: input.runId,
        attempt: input.attempt,
        sourceCommitSha: input.sourceCommitSha,
        ecosystem: input.ecosystem,
        installCommand: input.installCommand,
        commands: input.commands,
        payload: input.payload,
        agentResult: input.agentResult ?? null,
        status: input.initialStatus ?? "QUEUED",
        runnerId: input.initialStatus === "RUNNING" ? "railway-sandbox" : null,
        claimToken: input.initialStatus === "RUNNING" ? input.executionToken : null,
        claimedAt: input.initialStatus === "RUNNING" ? new Date() : null,
        heartbeatAt: input.initialStatus === "RUNNING" ? new Date() : null,
        leaseExpiresAt:
          input.initialStatus === "RUNNING"
            ? new Date(Date.now() + (verificationTimeoutSeconds() + 300) * 1_000)
            : null,
      })
      .returning();
    if (!job) throw new Error("Verification job could not be created");
    if (input.agentResult && input.usage && input.changedFiles && input.repairState) {
      const [updated] = await transaction
        .update(aiRuns)
        .set({
          summary: input.agentResult.summary,
          detectedApis: input.agentResult.detectedApis,
          research: input.agentResult.research,
          plan: input.agentResult.plan,
          changedFiles: input.changedFiles,
          modelUsage: input.usage,
          actualCostUsd: toCostString(totalModelCost(input.usage)),
          inputQuestion: input.agentResult.question,
          repairState: input.repairState,
          updatedAt: new Date(),
        })
        .where(and(eq(aiRuns.id, input.runId), eq(aiRuns.claimToken, input.claimToken)))
        .returning({ id: aiRuns.id });
      if (!updated) throw new Error("Run claim was lost");
    }
    return { job, created: true };
  });
}

async function waitForVerification(jobId: string, timeoutMs: number): Promise<VerificationResult> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const [job] = await db
      .select()
      .from(verificationJobs)
      .where(eq(verificationJobs.id, jobId))
      .limit(1);
    if (!job) throw new Error("Verification job disappeared");
    if (job.errorMessage) {
      throw new VerificationInfrastructureError(
        `Verification infrastructure failed: ${boundedLog(job.errorMessage, 1_000)}`,
      );
    }
    if ((job.status === "SUCCEEDED" || job.status === "FAILED") && job.result) return job.result;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new VerificationInfrastructureError("Verification infrastructure timed out");
}

async function verifyPatch(input: {
  run: ClaimedRun;
  claimToken: string;
  archive: Buffer;
  sourceCommitSha: string;
  ecosystem: string;
  installCommand: string | null;
  commands: string[];
  payload: ChangedFilePayload[];
  attempt: number;
  agentResult?: AgentResult;
}): Promise<VerificationResult> {
  if (input.commands.length === 0) {
    return {
      status: "NO_COMMANDS",
      commands: [],
      integrityPassed: true,
      integrityFindings: [],
      runner: "none",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  if (process.env.VERIFICATION_MODE === "railway_sandbox") {
    const { verifyInRailwaySandbox } = await import("@/runner/railway-sandbox");
    const executionToken = randomUUID();
    const durable = await createVerificationJob({
      runId: input.run.id,
      claimToken: input.claimToken,
      attempt: input.attempt,
      sourceCommitSha: input.sourceCommitSha,
      ecosystem: input.ecosystem,
      installCommand: input.installCommand,
      commands: input.commands,
      payload: input.payload,
      agentResult: input.agentResult,
      initialStatus: "RUNNING",
      executionToken,
    });
    if (durable.job.errorMessage) {
      throw new VerificationInfrastructureError(
        `Verification infrastructure failed: ${boundedLog(durable.job.errorMessage, 1_000)}`,
      );
    }
    if (
      (durable.job.status === "SUCCEEDED" || durable.job.status === "FAILED") &&
      durable.job.result
    ) {
      return durable.job.result;
    }
    if (durable.job.status === "SUCCEEDED" || durable.job.status === "FAILED") {
      throw new VerificationInfrastructureError(
        "Verification infrastructure returned a terminal job without a result",
      );
    }

    try {
      const result = await verifyInRailwaySandbox({
        archive: input.archive,
        ecosystem: input.ecosystem,
        installCommand: input.installCommand,
        commands: input.commands,
        payload: input.payload,
        onCreated: async (sandboxId) => {
          const [updated] = await db
            .update(verificationJobs)
            .set({
              sandboxId,
              heartbeatAt: new Date(),
              leaseExpiresAt: new Date(Date.now() + (verificationTimeoutSeconds() + 300) * 1_000),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(verificationJobs.id, durable.job.id),
                eq(verificationJobs.claimToken, executionToken),
              ),
            )
            .returning({ id: verificationJobs.id });
          if (!updated) throw new Error("Railway verification job disappeared");
          await appendClaimedRunEvent(input.claimToken, {
            runId: input.run.id,
            stage: "VERIFYING",
            message: "Disposable Railway verification sandbox created",
            details: { sandboxId },
          });
        },
      });
      await db.transaction(async (transaction) => {
        const [owned] = await transaction
          .select({ id: aiRuns.id })
          .from(aiRuns)
          .where(and(eq(aiRuns.id, input.run.id), eq(aiRuns.claimToken, input.claimToken)))
          .for("update")
          .limit(1);
        if (!owned) throw new Error("Run claim was lost");
        const [stored] = await transaction
          .update(verificationJobs)
          .set({
            status: result.status === "PASSED" ? "SUCCEEDED" : "FAILED",
            result,
            errorMessage: null,
            completedAt: new Date(),
            heartbeatAt: new Date(),
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(verificationJobs.id, durable.job.id),
              eq(verificationJobs.claimToken, executionToken),
            ),
          )
          .returning({ id: verificationJobs.id });
        if (!stored) throw new Error("Railway verification execution was superseded");
      });
      return result;
    } catch (error) {
      const message = boundedLog(
        error instanceof Error ? error.message : "Railway Sandbox verification failed",
        1_000,
      );
      await db
        .update(verificationJobs)
        .set({
          status: "FAILED",
          errorMessage: message,
          completedAt: new Date(),
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(verificationJobs.id, durable.job.id),
            eq(verificationJobs.claimToken, executionToken),
          ),
        );
      throw new VerificationInfrastructureError(message);
    }
  }

  const queued = await createVerificationJob({
    runId: input.run.id,
    claimToken: input.claimToken,
    attempt: input.attempt,
    sourceCommitSha: input.sourceCommitSha,
    ecosystem: input.ecosystem,
    installCommand: input.installCommand,
    commands: input.commands,
    payload: input.payload,
    agentResult: input.agentResult,
  });
  if (queued.created) {
    await appendClaimedRunEvent(input.claimToken, {
      runId: input.run.id,
      stage: "VERIFYING",
      message: "Verification job queued for the isolated Docker runner",
      details: { commandCount: input.commands.length, attempt: input.attempt },
    });
  }
  return waitForVerification(
    queued.job.id,
    Number(process.env.VERIFICATION_TIMEOUT_SECONDS ?? 1200) * 1_000 + 180_000,
  );
}

function verificationDiagnostics(result: VerificationResult): string {
  return boundedLog(
    [
      `Status: ${result.status}`,
      ...result.integrityFindings.map((finding) => `Integrity: ${finding}`),
      ...result.commands
        .filter((command) => command.exitCode !== 0 || command.timedOut)
        .map(
          (command) =>
            `Command: ${command.command}\nExit: ${command.exitCode}\nstdout:\n${command.stdout}\nstderr:\n${command.stderr}`,
        ),
    ].join("\n\n"),
    20_000,
  );
}

function buildBranchName(runId: string): string {
  return `patchrail/api-update-${runId.slice(0, 8)}`;
}

function previousAgentResult(run: ClaimedRun): AgentResult | undefined {
  if (!run.summary) return undefined;
  return {
    summary: run.summary,
    detectedApis: run.detectedApis,
    research: run.research,
    plan: run.plan,
    needsInput: run.inputQuestion !== null,
    question: run.inputQuestion,
  };
}

function remainingAgentLimits(
  ai: AiConfiguration,
  usage: ModelUsage[],
  authorizedMaximumCostUsd: number,
) {
  const modelCalls = usage.length;
  const researchCalls = usage.reduce((total, item) => total + item.webSearchCalls, 0);
  const inputTokens = usage.reduce((total, item) => total + item.inputTokens, 0);
  const outputTokens = usage.reduce((total, item) => total + item.outputTokens, 0);
  const elapsedMs = usage.reduce((total, item) => total + item.durationMs, 0);
  const costUsd = totalModelCost(usage);
  const remaining = {
    maxModelCalls: ai.AI_MAX_MODEL_CALLS - modelCalls,
    maxResearchCalls: Math.max(0, ai.AI_MAX_RESEARCH_CALLS - researchCalls),
    maxCostUsd: Math.min(ai.AI_MAX_RUN_COST_USD, authorizedMaximumCostUsd) - costUsd,
    maxElapsedMinutes: (ai.AI_MAX_ELAPSED_MINUTES * 60_000 - elapsedMs) / 60_000,
    maxInputTokens: ai.AI_MAX_INPUT_TOKENS - inputTokens,
    maxOutputTokens: ai.AI_MAX_OUTPUT_TOKENS - outputTokens,
    maxWebSearchCallsPerResponse: ai.OPENAI_MAX_WEB_SEARCH_CALLS_PER_RESPONSE,
  };
  if (
    remaining.maxModelCalls <= 0 ||
    remaining.maxCostUsd <= 0 ||
    remaining.maxElapsedMinutes <= 0 ||
    remaining.maxInputTokens <= 0 ||
    remaining.maxOutputTokens <= 0
  ) {
    throw new Error("AI run limit reached before another model call could begin");
  }
  return remaining;
}

function priorAgentPhaseCalls(
  usage: ModelUsage[],
  phase: "NORMAL" | "CLARIFICATION" | "REPAIR",
): number {
  const purposePrefix =
    phase === "REPAIR"
      ? "verification_repair"
      : phase === "CLARIFICATION"
        ? "repository_clarification"
        : "repository_analysis_migration";
  return usage.filter((item) => item.purpose.startsWith(purposePrefix)).length;
}

async function applyExistingPayload(
  workspace: RepositoryWorkspace,
  payload: ChangedFilePayload[],
): Promise<void> {
  for (const file of payload) {
    await workspace.applyPatch({
      path: file.path,
      operation: file.operation,
      content:
        file.contentBase64 === null
          ? null
          : Buffer.from(file.contentBase64, "base64").toString("utf8"),
      expectedSha256: file.beforeSha256,
    });
  }
}

export async function processClaimedRun(run: ClaimedRun, claimToken: string): Promise<void> {
  const ai = readAiEnv();
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), `patchrail-${run.id}-`));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  let accumulatedUsage: ModelUsage[] = run.modelUsage ?? [];
  let currentStage = run.stage;
  let heartbeatUpdateInFlight = false;

  const heartbeatTimer = setInterval(() => {
    if (heartbeatUpdateInFlight) return;
    heartbeatUpdateInFlight = true;
    void db
      .update(aiRuns)
      .set({ heartbeatAt: new Date(), updatedAt: new Date() })
      .where(and(eq(aiRuns.id, run.id), eq(aiRuns.claimToken, claimToken)))
      .catch(() => {
        logger.warn("run_heartbeat_failed", { runId: run.id, stage: currentStage });
      })
      .finally(() => {
        heartbeatUpdateInFlight = false;
      });
  }, 30_000);
  heartbeatTimer.unref();

  const stillOwnsClaim = async () => {
    const [current] = await db
      .select({ claimToken: aiRuns.claimToken })
      .from(aiRuns)
      .where(eq(aiRuns.id, run.id))
      .limit(1);
    if (current?.claimToken !== claimToken) throw new Error("Run claim was lost");
  };

  const persistUsage = async (previousUsage: ModelUsage[], nextUsage: ModelUsage[]) => {
    const [updated] = await db
      .update(aiRuns)
      .set({
        modelUsage: nextUsage,
        actualCostUsd: toCostString(totalModelCost(nextUsage)),
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(aiRuns.id, run.id), eq(aiRuns.claimToken, claimToken)))
      .returning({ id: aiRuns.id });
    if (!updated) {
      accumulatedUsage = previousUsage;
      throw new Error("Run claim was lost");
    }
    accumulatedUsage = nextUsage;
  };

  // Reserve a conservative, per-call upper bound before crossing the provider
  // boundary. If the worker dies after OpenAI accepts a request but before its
  // response is persisted, the authorization remains accounted for instead of
  // being released as unused spend.
  const recordCallStarted = async (pendingUsage: ModelUsage) => {
    const previousUsage = accumulatedUsage;
    await persistUsage(previousUsage, [...previousUsage, pendingUsage]);
  };

  const recordUsage = async (pendingCallId: string, usage: ModelUsage) => {
    const previousUsage = accumulatedUsage;
    const pendingIndex = previousUsage.findIndex((item) => item.callId === pendingCallId);
    if (pendingIndex < 0) {
      throw new Error("The in-flight AI cost authorization was not found");
    }
    const nextUsage = [...previousUsage];
    nextUsage[pendingIndex] = usage;
    await persistUsage(previousUsage, nextUsage);
  };

  try {
    await stillOwnsClaim();
    const authorization = await resumeRunCost({
      workspaceId: run.workspaceId,
      runId: run.id,
    });
    const authorizedMaximumCostUsd = Number(authorization.authorizedUsd);
    currentStage = "READING_REPOSITORY";
    await transitionRun(
      run.id,
      "READING_REPOSITORY",
      "Fetching the current GitHub repository",
      undefined,
      claimToken,
    );
    const source = await fetchPinnedRepositorySource({
      workspaceId: run.workspaceId,
      repositoryId: run.repositoryId,
      commitSha: run.startingCommitSha ?? undefined,
    });
    const [pinned] = await db
      .update(aiRuns)
      .set({ startingCommitSha: source.commitSha, updatedAt: new Date() })
      .where(and(eq(aiRuns.id, run.id), eq(aiRuns.claimToken, claimToken)))
      .returning({ id: aiRuns.id });
    if (!pinned) throw new Error("Run claim was lost");
    await appendClaimedRunEvent(claimToken, {
      runId: run.id,
      stage: "READING_REPOSITORY",
      message: `Pinned source commit ${source.commitSha.slice(0, 7)}`,
      details: { commitSha: source.commitSha },
    });

    const archivePath = path.join(temporaryRoot, "source.tgz");
    await fs.writeFile(archivePath, source.archive);
    await extractGitHubArchive(archivePath, repositoryRoot);

    let repositoryWorkspace = new RepositoryWorkspace(repositoryRoot, {
      maxReads: ai.AI_MAX_REPOSITORY_READS,
      maxFilesWritten: ai.AI_MAX_FILES_WRITTEN,
      maxContextBytes: ai.AI_MAX_CONTEXT_BYTES,
    });
    const repositoryMap = await repositoryWorkspace.createInitialMap();
    const originalVerificationCommands = await discoverVerificationCommands(repositoryRoot);
    await appendClaimedRunEvent(claimToken, {
      runId: run.id,
      stage: "READING_REPOSITORY",
      message: "Repository map built",
      details: {
        fileEntries: repositoryMap.tree.length,
        manifests: repositoryMap.manifests.length,
      },
    });

    const [resumableVerification] = await db
      .select()
      .from(verificationJobs)
      .where(eq(verificationJobs.runId, run.id))
      .orderBy(desc(verificationJobs.attempt))
      .limit(1);
    if (
      resumableVerification?.sourceCommitSha !== undefined &&
      resumableVerification.sourceCommitSha !== source.commitSha
    ) {
      throw new Error("Existing verification job does not match the pinned source commit");
    }

    const storedResult = previousAgentResult(run);
    if (resumableVerification && resumableVerification.attempt > 1) {
      throw new Error("Durable verification state exceeds the bounded repair policy");
    }
    if (resumableVerification && !resumableVerification.agentResult) {
      throw new Error("Durable verification state is missing its bound AI result");
    }
    if (
      resumableVerification?.attempt === 1 &&
      (run.repairAttempts !== 1 || run.repairState !== "PREPARED")
    ) {
      throw new Error("Prepared repair verification state is inconsistent");
    }
    if (run.repairState === "PREPARED" && resumableVerification?.attempt !== 1) {
      throw new Error("Prepared repair state is missing its verification job");
    }
    if (run.repairState === "IN_PROGRESS" && resumableVerification?.attempt !== 1) {
      throw new Error("An indeterminate repair provider call cannot be replayed safely");
    }
    if (
      run.repairState === "WAITING_INPUT" &&
      (resumableVerification?.attempt !== 0 || !storedResult?.needsInput || !run.inputAnswer)
    ) {
      throw new Error("Repair clarification state is inconsistent");
    }
    if (
      storedResult?.needsInput &&
      run.inputAnswer &&
      !resumableVerification &&
      usdToMicros(totalModelCost(accumulatedUsage)) > usdToMicros(authorization.incurredUsd)
    ) {
      throw new Error("An indeterminate clarification provider call cannot be replayed safely");
    }
    const durableAgentResult = resumableVerification?.agentResult ?? storedResult;
    const resumingRepairClarification = Boolean(
      storedResult?.needsInput &&
      run.inputAnswer &&
      run.repairState === "WAITING_INPUT" &&
      resumableVerification?.attempt === 0,
    );
    if (storedResult?.needsInput && !run.inputAnswer && !resumableVerification) {
      // updateArtifacts is durable before the atomic pause. Recover the narrow
      // crash window without paying for or asking a second model call.
      await pauseClaimedRunForInput({
        runId: run.id,
        claimToken,
        cumulativeActualCostUsd: totalModelCost(accumulatedUsage),
        question: storedResult.question ?? "A human decision is required",
      });
      return;
    }

    let agent: Awaited<ReturnType<typeof runRepositoryAgent>>;
    let changedFiles: Awaited<ReturnType<RepositoryWorkspace["getChangedFiles"]>>;
    let payload: ChangedFilePayload[];
    let verificationCommands: Awaited<ReturnType<typeof discoverVerificationCommands>> | null =
      null;
    let verificationAttempt = 0;
    let durableVerificationResult: VerificationResult | null = null;
    const canReuseStoredNoChange =
      storedResult !== undefined &&
      !storedResult.needsInput &&
      run.modelUsage.length > 0 &&
      run.changedFiles.length === 0 &&
      !resumableVerification;

    if (resumableVerification) {
      const durablePayload = resumableVerification.payload;
      if (!durableAgentResult || !durablePayload || durablePayload.length === 0) {
        throw new Error("Durable verification state is missing its structured AI artifacts");
      }
      await applyExistingPayload(repositoryWorkspace, durablePayload);
      agent = {
        result: resumingRepairClarification ? storedResult! : durableAgentResult,
        usage: [],
        consultedUrls: run.research.map((item) => item.url),
      };
      changedFiles = await repositoryWorkspace.getChangedFiles();
      payload = await repositoryWorkspace.getChangedPayload();
      verificationCommands = {
        ecosystem: resumableVerification.ecosystem,
        installCommand: resumableVerification.installCommand,
        commands: resumableVerification.commands,
      };
      verificationAttempt = resumableVerification.attempt;
      await appendClaimedRunEvent(claimToken, {
        runId: run.id,
        stage: "VERIFYING",
        message: "Resuming the durable isolated verification job",
        details: { attempt: verificationAttempt },
      });
      if (resumableVerification.errorMessage) {
        throw new VerificationInfrastructureError(
          `Verification infrastructure failed: ${boundedLog(resumableVerification.errorMessage, 1_000)}`,
        );
      }
      const durableResult =
        (resumableVerification.status === "SUCCEEDED" ||
          resumableVerification.status === "FAILED") &&
        resumableVerification.result
          ? resumableVerification.result
          : null;
      if (durableResult) {
        // Avoid enqueueing or waiting on an already-completed durable job after
        // a worker crash. The normal repair/delivery gates below still apply.
        durableVerificationResult = durableResult;
      } else if (
        resumableVerification.status === "SUCCEEDED" ||
        resumableVerification.status === "FAILED"
      ) {
        throw new VerificationInfrastructureError(
          "Verification infrastructure returned a terminal job without a result",
        );
      }
    } else if (canReuseStoredNoChange) {
      agent = {
        result: storedResult,
        usage: [],
        consultedUrls: run.research.map((item) => item.url),
      };
      changedFiles = [];
      payload = [];
    } else {
      currentStage = "FINDING_APIS";
      await transitionRun(
        run.id,
        "FINDING_APIS",
        "AI is inspecting repository API usage",
        undefined,
        claimToken,
      );
      agent = await runRepositoryAgent({
        workspace: repositoryWorkspace,
        repositoryMap,
        repositoryName: `${source.repository.owner}/${source.repository.name}`,
        startingCommitSha: source.commitSha,
        model: ai.OPENAI_MODEL,
        pricing: {
          inputUsdPer1M: ai.OPENAI_INPUT_USD_PER_1M,
          outputUsdPer1M: ai.OPENAI_OUTPUT_USD_PER_1M,
          cachedInputUsdPer1M: ai.OPENAI_CACHED_INPUT_USD_PER_1M,
          longContextThresholdTokens: ai.OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
          longContextInputUsdPer1M: ai.OPENAI_LONG_CONTEXT_INPUT_USD_PER_1M,
          longContextCachedInputUsdPer1M: ai.OPENAI_LONG_CONTEXT_CACHED_INPUT_USD_PER_1M,
          longContextOutputUsdPer1M: ai.OPENAI_LONG_CONTEXT_OUTPUT_USD_PER_1M,
          webSearchUsdPerCall: ai.OPENAI_WEB_SEARCH_USD_PER_CALL,
        },
        limits: remainingAgentLimits(ai, accumulatedUsage, authorizedMaximumCostUsd),
        priorPhaseModelCalls: priorAgentPhaseCalls(
          accumulatedUsage,
          run.inputAnswer ? "CLARIFICATION" : "NORMAL",
        ),
        humanAnswer: run.inputAnswer ?? undefined,
        priorResult: storedResult,
        priorConsultedUrls: run.research.map((item) => item.url),
        onProgress: async (progress) => {
          currentStage = progress.stage;
          await transitionRun(
            run.id,
            progress.stage,
            progress.message,
            progress.details,
            claimToken,
          );
        },
        onCallStarted: recordCallStarted,
        onUsage: recordUsage,
      });
      changedFiles = await repositoryWorkspace.getChangedFiles();
      payload = await repositoryWorkspace.getChangedPayload();
      await updateArtifacts({
        runId: run.id,
        claimToken,
        result: agent.result,
        usage: accumulatedUsage,
        changedFiles,
      });
      await appendClaimedRunEvent(claimToken, {
        runId: run.id,
        stage: "RESEARCHING_APIS",
        message: `${agent.result.detectedApis.length} external API ${agent.result.detectedApis.length === 1 ? "integration" : "integrations"} assessed`,
        details: {
          apiCount: agent.result.detectedApis.length,
          updatesRequired: agent.result.detectedApis.filter((api) => isUpdateRequired(api.status))
            .length,
          officialSources: agent.result.research.filter((item) => item.authoritative).length,
        },
      });
    }

    if (agent.result.needsInput && !resumingRepairClarification) {
      if (run.inputAnswer) {
        throw new Error(
          "Migration evidence remained ambiguous after the one permitted human clarification",
        );
      }
      const cost = totalModelCost(accumulatedUsage);
      await pauseClaimedRunForInput({
        runId: run.id,
        claimToken,
        cumulativeActualCostUsd: cost,
        question: agent.result.question ?? "A human decision is required",
      });
      return;
    }

    if (changedFiles.length === 0) {
      const cost = totalModelCost(accumulatedUsage);
      await completeClaimedRun({
        runId: run.id,
        claimToken,
        cumulativeActualCostUsd: cost,
        status: "SUCCEEDED",
        runValues: {
          verification: {
            status: "NO_COMMANDS",
            commands: [],
            integrityPassed: true,
            integrityFindings: [],
            runner: "not-required",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        },
        lastAnalyzedRepository: {
          repositoryId: run.repositoryId,
          commitSha: source.commitSha,
        },
        event: {
          kind: "SUCCESS",
          message:
            agent.result.detectedApis.length === 0
              ? "No material external API integrations were found; no code change or PR was required"
              : "Detected API integrations appear current; no code change or PR was required",
        },
      });
      return;
    }

    // Commands are selected from the immutable source tree. The patch must not
    // earn a green result by deleting or replacing its own validation scripts.
    verificationCommands ??= originalVerificationCommands;
    if (verificationCommands.commands.length === 0) {
      throw new Error(
        "Verification failed: no applicable repository verification commands were found",
      );
    }
    currentStage = "VERIFYING";

    // Persist the patch and the structured result as one durable generation
    // before waiting on an external verifier. Recovery never pairs payload
    // bytes with mutable artifacts from a later model phase.
    if (!resumableVerification) {
      await createVerificationJob({
        runId: run.id,
        claimToken,
        attempt: 0,
        sourceCommitSha: source.commitSha,
        ...verificationCommands,
        payload,
        agentResult: agent.result,
      });
    }
    await transitionRun(
      run.id,
      "VERIFYING",
      "Running repository verification in isolation",
      { commandCount: verificationCommands.commands.length },
      claimToken,
    );
    await stillOwnsClaim();
    let verification =
      durableVerificationResult ??
      (await verifyPatch({
        run,
        claimToken,
        archive: source.archive,
        sourceCommitSha: source.commitSha,
        ...verificationCommands,
        payload,
        attempt: verificationAttempt,
        agentResult: agent.result,
      }));
    const [verificationStored] = await db
      .update(aiRuns)
      .set({ verification, updatedAt: new Date() })
      .where(and(eq(aiRuns.id, run.id), eq(aiRuns.claimToken, claimToken)))
      .returning({ id: aiRuns.id });
    if (!verificationStored) throw new Error("Run claim was lost");

    if (
      verification.status !== "PASSED" &&
      ai.AI_MAX_REPAIR_ATTEMPTS === 1 &&
      verificationAttempt === 0 &&
      (run.repairAttempts < 1 || resumingRepairClarification)
    ) {
      currentStage = "REPAIRING";
      await transitionRun(
        run.id,
        "REPAIRING",
        resumingRepairClarification
          ? "Applying the clarification to the one permitted repair attempt"
          : "Verification failed; starting the one permitted repair attempt",
        undefined,
        claimToken,
      );
      if (!resumingRepairClarification) {
        const [repairPreparing] = await db
          .update(aiRuns)
          .set({ repairState: "PREPARING", updatedAt: new Date() })
          .where(
            and(
              eq(aiRuns.id, run.id),
              eq(aiRuns.claimToken, claimToken),
              eq(aiRuns.repairAttempts, 0),
            ),
          )
          .returning({ id: aiRuns.id });
        if (!repairPreparing) throw new Error("The bounded repair attempt was already consumed");
      }
      await fs.rm(repositoryRoot, { recursive: true, force: true });
      await extractGitHubArchive(archivePath, repositoryRoot);
      repositoryWorkspace = new RepositoryWorkspace(repositoryRoot, {
        maxReads: ai.AI_MAX_REPOSITORY_READS,
        maxFilesWritten: ai.AI_MAX_FILES_WRITTEN,
        maxContextBytes: ai.AI_MAX_CONTEXT_BYTES,
      });
      await applyExistingPayload(repositoryWorkspace, payload);
      const repairMap = await repositoryWorkspace.createInitialMap();
      const consultedBeforeRepair = [
        ...new Set([...agent.consultedUrls, ...agent.result.research.map((item) => item.url)]),
      ];
      let repairBoundaryCrossed = false;
      const repair = await runRepositoryAgent({
        workspace: repositoryWorkspace,
        repositoryMap: repairMap,
        repositoryName: `${source.repository.owner}/${source.repository.name}`,
        startingCommitSha: source.commitSha,
        model: ai.OPENAI_MODEL,
        pricing: {
          inputUsdPer1M: ai.OPENAI_INPUT_USD_PER_1M,
          outputUsdPer1M: ai.OPENAI_OUTPUT_USD_PER_1M,
          cachedInputUsdPer1M: ai.OPENAI_CACHED_INPUT_USD_PER_1M,
          longContextThresholdTokens: ai.OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
          longContextInputUsdPer1M: ai.OPENAI_LONG_CONTEXT_INPUT_USD_PER_1M,
          longContextCachedInputUsdPer1M: ai.OPENAI_LONG_CONTEXT_CACHED_INPUT_USD_PER_1M,
          longContextOutputUsdPer1M: ai.OPENAI_LONG_CONTEXT_OUTPUT_USD_PER_1M,
          webSearchUsdPerCall: ai.OPENAI_WEB_SEARCH_USD_PER_CALL,
        },
        limits: remainingAgentLimits(ai, accumulatedUsage, authorizedMaximumCostUsd),
        priorPhaseModelCalls: priorAgentPhaseCalls(accumulatedUsage, "REPAIR"),
        repairDiagnostics: verificationDiagnostics(verification),
        humanAnswer: run.inputAnswer ?? undefined,
        priorResult: agent.result,
        priorConsultedUrls: consultedBeforeRepair,
        onProgress: async (progress) => {
          await appendClaimedRunEvent(claimToken, {
            runId: run.id,
            stage: "REPAIRING",
            message: progress.message,
            details: progress.details,
          });
        },
        onCallStarted: async (pendingUsage) => {
          if (!repairBoundaryCrossed) {
            const expectedState = resumingRepairClarification ? "WAITING_INPUT" : "PREPARING";
            const expectedAttempts = resumingRepairClarification ? 1 : 0;
            const [repairAuthorized] = await db
              .update(aiRuns)
              .set({ repairAttempts: 1, repairState: "IN_PROGRESS", updatedAt: new Date() })
              .where(
                and(
                  eq(aiRuns.id, run.id),
                  eq(aiRuns.claimToken, claimToken),
                  eq(aiRuns.repairAttempts, expectedAttempts),
                  eq(aiRuns.repairState, expectedState),
                ),
              )
              .returning({ id: aiRuns.id });
            if (!repairAuthorized) {
              throw new Error("The bounded repair attempt was already consumed");
            }
            repairBoundaryCrossed = true;
          }
          await recordCallStarted(pendingUsage);
        },
        onUsage: recordUsage,
      });
      agent = repair;
      changedFiles = await repositoryWorkspace.getChangedFiles();
      payload = await repositoryWorkspace.getChangedPayload();
      if (repair.result.needsInput) {
        if (run.inputAnswer) {
          const failureMessage =
            "Migration evidence remained ambiguous after the one permitted human clarification";
          await completeClaimedRun({
            runId: run.id,
            claimToken,
            cumulativeActualCostUsd: totalModelCost(accumulatedUsage),
            status: "FAILED",
            runValues: {
              errorCode: "INSUFFICIENT_EVIDENCE",
              errorMessage: failureMessage,
            },
            event: { kind: "ERROR", message: failureMessage },
          });
          return;
        }
        await pauseClaimedRunForInput({
          runId: run.id,
          claimToken,
          cumulativeActualCostUsd: totalModelCost(accumulatedUsage),
          question: repair.result.question ?? "A human decision is required",
          runValues: {
            summary: repair.result.summary,
            detectedApis: repair.result.detectedApis,
            research: repair.result.research,
            plan: repair.result.plan,
            changedFiles,
            modelUsage: accumulatedUsage,
            repairState: "WAITING_INPUT",
          },
        });
        return;
      } else if (changedFiles.length === 0) {
        await completeClaimedRun({
          runId: run.id,
          claimToken,
          cumulativeActualCostUsd: totalModelCost(accumulatedUsage),
          status: "SUCCEEDED",
          runValues: {
            summary: repair.result.summary,
            detectedApis: repair.result.detectedApis,
            research: repair.result.research,
            plan: repair.result.plan,
            changedFiles,
            modelUsage: accumulatedUsage,
            inputQuestion: null,
            verification: {
              status: "NO_COMMANDS",
              commands: [],
              integrityPassed: true,
              integrityFindings: [],
              runner: "not-required",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            },
          },
          lastAnalyzedRepository: {
            repositoryId: run.repositoryId,
            commitSha: source.commitSha,
          },
          event: {
            kind: "SUCCESS",
            message:
              repair.result.detectedApis.length === 0
                ? "No material external API integrations were found; no code change or PR was required"
                : "Detected API integrations appear current; no code change or PR was required",
          },
        });
        return;
      } else {
        // Persist the repaired bytes before the verification wait. If the
        // worker dies after the model call, recovery can execute attempt 1
        // without spending the single repair allowance again.
        const prepared = await createVerificationJob({
          runId: run.id,
          claimToken,
          attempt: 1,
          sourceCommitSha: source.commitSha,
          ...verificationCommands,
          payload,
          agentResult: repair.result,
          usage: accumulatedUsage,
          changedFiles,
          repairState: "PREPARED",
        });
        if (prepared.created) {
          await appendClaimedRunEvent(claimToken, {
            runId: run.id,
            stage: "VERIFYING",
            message: "Repaired patch was durably prepared for isolated verification",
            details: { commandCount: verificationCommands.commands.length, attempt: 1 },
          });
        }
      }
      await stillOwnsClaim();
      verification = await verifyPatch({
        run,
        claimToken,
        archive: source.archive,
        sourceCommitSha: source.commitSha,
        ...verificationCommands,
        payload,
        attempt: 1,
        agentResult: agent.result,
      });
      const [repairedVerificationStored] = await db
        .update(aiRuns)
        .set({ verification, updatedAt: new Date() })
        .where(and(eq(aiRuns.id, run.id), eq(aiRuns.claimToken, claimToken)))
        .returning({ id: aiRuns.id });
      if (!repairedVerificationStored) throw new Error("Run claim was lost");
    }

    if (verification.status !== "PASSED") {
      throw new Error("Verification failed after the bounded repair attempt");
    }
    await appendClaimedRunEvent(claimToken, {
      runId: run.id,
      stage: "VERIFYING",
      kind: "SUCCESS",
      message: "Repository verification succeeded",
      details: { commandCount: verification.commands.length },
    });

    currentStage = "CREATING_PR";
    await transitionRun(
      run.id,
      "CREATING_PR",
      "Creating the verified GitHub Draft PR",
      undefined,
      claimToken,
    );
    await stillOwnsClaim();
    const cost = totalModelCost(accumulatedUsage);
    const branchName = buildBranchName(run.id);
    const body = buildPatchrailPullRequestBody({
      summary: agent.result.summary,
      detectedApis: agent.result.detectedApis,
      research: agent.result.research,
      changedFiles,
      verification,
    });
    const delivery = await deliverDraftPullRequest({
      workspaceId: run.workspaceId,
      repositoryId: run.repositoryId,
      startingCommitSha: source.commitSha,
      branchName,
      commitMessage: "chore: update external API integrations",
      title: "Update external API integrations",
      body,
      changedFiles: payload,
      verification,
    });
    await completeClaimedRun({
      runId: run.id,
      claimToken,
      cumulativeActualCostUsd: cost,
      status: "SUCCEEDED",
      runValues: {
        githubBranch: delivery.branch,
        githubCommitSha: delivery.commitSha,
        githubPrNumber: delivery.pullRequestNumber,
        githubPrUrl: delivery.pullRequestUrl,
      },
      lastAnalyzedRepository: {
        repositoryId: run.repositoryId,
        commitSha: source.commitSha,
      },
      event: {
        kind: "SUCCESS",
        message: `Verified Draft PR #${delivery.pullRequestNumber} created`,
        details: { prNumber: delivery.pullRequestNumber, prUrl: delivery.pullRequestUrl },
      },
    });
  } catch (error) {
    const [ownership] = await db
      .select({ claimToken: aiRuns.claimToken })
      .from(aiRuns)
      .where(eq(aiRuns.id, run.id))
      .limit(1);
    if (ownership?.claimToken !== claimToken) {
      logger.warn("run_processing_abandoned_after_claim_loss", {
        workspaceId: run.workspaceId,
        repositoryId: run.repositoryId,
        runId: run.id,
      });
      return;
    }
    const failure = classifyRunError(error, currentStage);
    const actualCost = totalModelCost(accumulatedUsage);
    try {
      await completeClaimedRun({
        runId: run.id,
        claimToken,
        cumulativeActualCostUsd: actualCost,
        status: "FAILED",
        runValues: {
          modelUsage: accumulatedUsage,
          errorCode: failure.code,
          errorMessage: failure.message.slice(0, 4_000),
        },
        event: {
          kind: "ERROR",
          message: failure.message.slice(0, 1_000),
          details: { errorCode: failure.code },
        },
      });
    } catch (terminalError) {
      logger.error("run_cost_finalization_failed", {
        runId: run.id,
        errorCode: "BILLING_FINALIZE",
      });
      throw terminalError;
    }
    logger.error("run_failed", {
      workspaceId: run.workspaceId,
      repositoryId: run.repositoryId,
      runId: run.id,
      stage: currentStage,
      errorCode: failure.code,
    });
  } finally {
    clearInterval(heartbeatTimer);
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
