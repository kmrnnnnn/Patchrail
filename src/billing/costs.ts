import { and, count, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiRunEvents,
  aiRuns,
  billingAccounts,
  costReservations,
  repositories,
  verificationJobs,
} from "@/db/schema";
import { BillingError } from "@/billing/errors";
import { getWorkspaceFreeTrialBudgetUsd } from "@/billing/free-trial";
import {
  calculateBudgetAvailability,
  calculateReservationAccounting,
  microsToUsd,
  usdToMicros,
  utcCalendarMonth,
  validateCumulativeRunCost,
} from "@/billing/cost-policy";
import { getPlanDefinition, normalizeBillingPlan } from "@/billing/plans";
import { enforceWorkspaceRepositoryEntitlements } from "@/billing/repository-entitlements";
import { reconcilePaidBillingIfStale } from "@/billing/stripe";
import type { PlanDefinition, UsageSummary } from "@/billing/types";
import type { ModelUsage } from "@/runs/types";

export {
  calculateBudgetAvailability,
  calculateReservationAccounting,
  microsToUsd,
  usdToMicros,
  utcCalendarMonth,
  validateCumulativeRunCost,
};

export type RunCostAuthorization = {
  status: "RESERVED";
  authorizedUsd: string;
  incurredUsd: string;
  remainingUsd: string;
};

/**
 * Creates the durable run, reserves its maximum spend, and records its first
 * real event in one commit. Stripe reconciliation runs before this function's
 * transaction so no remote request holds database locks.
 */
export async function createQueuedRunWithReservation(input: {
  workspaceId: string;
  repositoryId: string;
  requestedBy: string;
  amountUsd: string | number;
}): Promise<{ id: string }> {
  const requestedMicros = usdToMicros(input.amountUsd);
  if (requestedMicros === 0) {
    throw new BillingError(
      "INVALID_BILLING_REQUEST",
      "The run cost reservation must be greater than zero.",
    );
  }

  await reconcilePaidBillingIfStale(input.workspaceId);
  await createFreeAccountIfMissing(input.workspaceId);

  return db.transaction(async (transaction) => {
    const [account] = await transaction
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (!account) throw new BillingError("BILLING_STATE_CONFLICT", "Billing account is missing.");

    // Reconciliation normally applies plan limits. This transactional backstop
    // also catches stale FREE rows and cleans up a temporary active-run excess
    // before authorizing any new paid work.
    await enforceWorkspaceRepositoryEntitlements(transaction, {
      workspaceId: input.workspaceId,
      plan: account.plan,
    });

    const [repository] = await transaction
      .select({
        id: repositories.id,
        enabled: repositories.enabled,
        accessState: repositories.accessState,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.workspaceId, input.workspaceId),
        ),
      )
      .for("update")
      .limit(1);
    if (!repository) {
      throw new BillingError("INVALID_BILLING_REQUEST", "Repository not found.", 404);
    }
    if (!repository.enabled) {
      throw new BillingError("INVALID_BILLING_REQUEST", "Enable Patchrail first.", 409);
    }
    if (repository.accessState !== "ACTIVE") {
      throw new BillingError(
        "INVALID_BILLING_REQUEST",
        "GitHub repository access is unavailable.",
        409,
      );
    }

    const totals = await getReservationTotals(
      transaction,
      input.workspaceId,
      getBillingPeriod(account),
    );
    const availability = calculateBudgetAvailability({
      budgetUsd: account.aiBudgetUsd,
      spentUsd: totals.spentUsd,
      reservedUsd: totals.reservedUsd,
      requestedUsd: input.amountUsd,
    });
    if (!availability.allowed) {
      throw new BillingError(
        "BUDGET_EXCEEDED",
        `This run needs up to ${microsToUsd(requestedMicros)} USD, but only ${microsToUsd(availability.remainingMicros)} USD remains in the AI budget.`,
        402,
      );
    }

    const amountUsd = microsToUsd(requestedMicros);
    const [run] = await transaction
      .insert(aiRuns)
      .values({
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        requestedBy: input.requestedBy,
        status: "QUEUED",
        stage: "QUEUED",
        estimatedCostUsd: amountUsd,
      })
      .returning({ id: aiRuns.id });
    if (!run) throw new BillingError("BILLING_STATE_CONFLICT", "The run was not created.");

    await transaction.insert(costReservations).values({
      workspaceId: input.workspaceId,
      runId: run.id,
      amountUsd,
    });
    await transaction.insert(aiRunEvents).values({
      runId: run.id,
      sequence: 1,
      stage: "QUEUED",
      message: "AI update queued; the maximum run cost is reserved",
      details: { maximumCostUsd: Number(amountUsd) },
    });
    return run;
  });
}

type BillingPeriod = { start: Date; end: Date | null };

function getBillingPeriod(account: {
  plan: string;
  createdAt: Date;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}): BillingPeriod {
  const plan = normalizeBillingPlan(account.plan);
  if (
    plan === "PRO" &&
    account.currentPeriodStart &&
    account.currentPeriodEnd &&
    account.currentPeriodEnd > account.currentPeriodStart
  ) {
    return { start: account.currentPeriodStart, end: account.currentPeriodEnd };
  }

  // The FREE allowance is a one-time trial budget. This also prevents a paid
  // workspace from repeatedly downgrading to mint new trial allowance.
  if (plan === "FREE") return { start: account.createdAt, end: null };
  return utcCalendarMonth();
}

async function createFreeAccountIfMissing(workspaceId: string): Promise<void> {
  const freeBudgetUsd = await getWorkspaceFreeTrialBudgetUsd(workspaceId);
  await db
    .insert(billingAccounts)
    .values({
      workspaceId,
      plan: "FREE",
      subscriptionStatus: "NONE",
      aiBudgetUsd: freeBudgetUsd,
    })
    .onConflictDoNothing({ target: billingAccounts.workspaceId });
  await db
    .update(billingAccounts)
    .set({ aiBudgetUsd: freeBudgetUsd, updatedAt: new Date() })
    .where(and(eq(billingAccounts.workspaceId, workspaceId), eq(billingAccounts.plan, "FREE")));
}

/**
 * Reserves the configured worst-case run amount before any model call. The
 * billing-account row is locked while usage is summed and the reservation is
 * inserted, so concurrent runs cannot both consume the same remaining budget.
 */
export async function reserveRunCost(input: {
  workspaceId: string;
  runId: string;
  amountUsd: string | number;
}): Promise<{ reservationId: string; amountUsd: string; remainingAfterUsd: string }> {
  const requestedMicros = usdToMicros(input.amountUsd);
  if (requestedMicros === 0) {
    throw new BillingError(
      "INVALID_BILLING_REQUEST",
      "The run cost reservation must be greater than zero.",
    );
  }

  // Paid entitlements are refreshed before the locked budget decision. If
  // Stripe is unavailable and the cached PRO state is stale, the run does not
  // begin and cannot spend against an unverified allowance.
  await reconcilePaidBillingIfStale(input.workspaceId);
  await createFreeAccountIfMissing(input.workspaceId);

  return db.transaction(async (transaction) => {
    const [account] = await transaction
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (!account) throw new BillingError("BILLING_STATE_CONFLICT", "Billing account is missing.");

    const configuredBudgetUsd = account.aiBudgetUsd;

    const [run] = await transaction
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(and(eq(aiRuns.id, input.runId), eq(aiRuns.workspaceId, input.workspaceId)))
      .limit(1);
    if (!run) {
      throw new BillingError(
        "INVALID_BILLING_REQUEST",
        "The run does not belong to the active workspace.",
        404,
      );
    }

    const [existing] = await transaction
      .select()
      .from(costReservations)
      .where(eq(costReservations.runId, input.runId))
      .limit(1);
    if (existing) {
      if (existing.status === "RESERVED" && usdToMicros(existing.amountUsd) === requestedMicros) {
        const summary = await getReservationTotals(
          transaction,
          input.workspaceId,
          getBillingPeriod(account),
        );
        const availability = calculateBudgetAvailability({
          budgetUsd: configuredBudgetUsd,
          spentUsd: summary.spentUsd,
          reservedUsd: summary.reservedUsd,
          requestedUsd: 0,
        });
        return {
          reservationId: existing.id,
          amountUsd: existing.amountUsd,
          remainingAfterUsd: microsToUsd(availability.remainingMicros),
        };
      }
      throw new BillingError(
        "BILLING_STATE_CONFLICT",
        `This run already has a ${existing.status.toLowerCase()} cost reservation.`,
        409,
      );
    }

    const totals = await getReservationTotals(
      transaction,
      input.workspaceId,
      getBillingPeriod(account),
    );
    const availability = calculateBudgetAvailability({
      budgetUsd: configuredBudgetUsd,
      spentUsd: totals.spentUsd,
      reservedUsd: totals.reservedUsd,
      requestedUsd: input.amountUsd,
    });

    if (!availability.allowed) {
      throw new BillingError(
        "BUDGET_EXCEEDED",
        `This run needs up to ${microsToUsd(requestedMicros)} USD, but only ${microsToUsd(availability.remainingMicros)} USD remains in the AI budget.`,
        402,
      );
    }

    const amountUsd = microsToUsd(requestedMicros);
    const [reservation] = await transaction
      .insert(costReservations)
      .values({ workspaceId: input.workspaceId, runId: input.runId, amountUsd })
      .returning({ id: costReservations.id });
    if (!reservation) {
      throw new BillingError("BILLING_STATE_CONFLICT", "The cost reservation was not created.");
    }

    return {
      reservationId: reservation.id,
      amountUsd,
      remainingAfterUsd: microsToUsd(availability.remainingMicros - requestedMicros),
    };
  });
}

export async function settleRunCost(
  runId: string,
  actualCostUsd: string | number,
): Promise<{ status: "SETTLED"; reservedUsd: string; actualUsd: string; overageUsd: string }> {
  const actualMicros = usdToMicros(actualCostUsd);

  return db.transaction(async (transaction) => {
    const [reservation] = await transaction
      .select()
      .from(costReservations)
      .where(eq(costReservations.runId, runId))
      .for("update")
      .limit(1);
    if (!reservation) {
      throw new BillingError(
        "BILLING_STATE_CONFLICT",
        "No cost reservation exists for this run.",
        409,
      );
    }

    if (reservation.status === "RELEASED") {
      throw new BillingError(
        "BILLING_STATE_CONFLICT",
        "The cost reservation was already released.",
        409,
      );
    }
    if (reservation.status === "SETTLED") {
      if (usdToMicros(reservation.settledAmountUsd ?? "0") !== actualMicros) {
        throw new BillingError(
          "BILLING_STATE_CONFLICT",
          "The cost reservation was already settled with a different amount.",
          409,
        );
      }
      return settlementResult(reservation.amountUsd, actualMicros);
    }

    const accounting = validatedCumulativeCost({
      authorizedUsd: reservation.amountUsd,
      previouslyIncurredUsd: reservation.settledAmountUsd,
      cumulativeActualUsd: actualCostUsd,
    });
    const actualUsd = microsToUsd(accounting.incurredMicros);
    await transaction
      .update(costReservations)
      .set({
        status: "SETTLED",
        settledAmountUsd: actualUsd,
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(costReservations.id, reservation.id));
    await transaction
      .update(aiRuns)
      .set({ actualCostUsd: actualUsd, updatedAt: new Date() })
      .where(eq(aiRuns.id, runId));

    return settlementResult(reservation.amountUsd, accounting.incurredMicros);
  });
}

/**
 * Records all spend incurred so far while retaining the unused authorization.
 * Use this immediately before a run enters NEEDS_INPUT. It is idempotent for
 * the same cumulative amount and refuses decreases, which prevents a resume
 * path from freeing spend that already occurred.
 */
export async function checkpointRunCost(
  runId: string,
  cumulativeActualCostUsd: string | number,
): Promise<RunCostAuthorization> {
  return db.transaction(async (transaction) => {
    const [reservation] = await transaction
      .select()
      .from(costReservations)
      .where(eq(costReservations.runId, runId))
      .for("update")
      .limit(1);
    if (!reservation) {
      throw new BillingError(
        "BILLING_STATE_CONFLICT",
        "No cost reservation exists for this run.",
        409,
      );
    }
    if (reservation.status !== "RESERVED") {
      throw new BillingError(
        "BILLING_STATE_CONFLICT",
        `A ${reservation.status.toLowerCase()} cost reservation cannot be checkpointed.`,
        409,
      );
    }

    const accounting = validatedCumulativeCost({
      authorizedUsd: reservation.amountUsd,
      previouslyIncurredUsd: reservation.settledAmountUsd,
      cumulativeActualUsd: cumulativeActualCostUsd,
    });
    const incurredUsd = microsToUsd(accounting.incurredMicros);
    await transaction
      .update(costReservations)
      .set({ settledAmountUsd: incurredUsd, updatedAt: new Date() })
      .where(eq(costReservations.id, reservation.id));
    await transaction
      .update(aiRuns)
      .set({ actualCostUsd: incurredUsd, updatedAt: new Date() })
      .where(eq(aiRuns.id, runId));

    return authorizationResult(reservation.amountUsd, accounting.incurredMicros);
  });
}

/**
 * Atomically checkpoints cumulative spend and pauses a currently claimed run.
 * The event is committed in the same visibility boundary as the state change.
 */
export async function pauseClaimedRunForInput(input: {
  runId: string;
  claimToken: string;
  cumulativeActualCostUsd: string | number;
  question: string;
  runValues?: Partial<typeof aiRuns.$inferInsert>;
}): Promise<RunCostAuthorization> {
  return db.transaction(async (transaction) => {
    const [reservation] = await transaction
      .select()
      .from(costReservations)
      .where(eq(costReservations.runId, input.runId))
      .for("update")
      .limit(1);
    if (!reservation || reservation.status !== "RESERVED") {
      throw new BillingError(
        "BILLING_STATE_CONFLICT",
        "The run no longer has an active cost authorization.",
        409,
      );
    }
    const accounting = validatedCumulativeCost({
      authorizedUsd: reservation.amountUsd,
      previouslyIncurredUsd: reservation.settledAmountUsd,
      cumulativeActualUsd: input.cumulativeActualCostUsd,
    });
    const incurredUsd = microsToUsd(accounting.incurredMicros);
    const [owned] = await transaction
      .update(aiRuns)
      .set({
        ...input.runValues,
        status: "NEEDS_INPUT",
        stage: "NEEDS_INPUT",
        inputQuestion: input.question,
        actualCostUsd: incurredUsd,
        claimToken: null,
        claimedAt: null,
        heartbeatAt: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(aiRuns.id, input.runId), eq(aiRuns.claimToken, input.claimToken)))
      .returning({ id: aiRuns.id });
    if (!owned) {
      throw new BillingError("BILLING_STATE_CONFLICT", "Run claim was lost.", 409);
    }
    await transaction
      .update(costReservations)
      .set({ settledAmountUsd: incurredUsd, updatedAt: new Date() })
      .where(eq(costReservations.id, reservation.id));
    const [last] = await transaction
      .select({ sequence: aiRunEvents.sequence })
      .from(aiRunEvents)
      .where(eq(aiRunEvents.runId, input.runId))
      .orderBy(sql`${aiRunEvents.sequence} desc`)
      .limit(1);
    await transaction.insert(aiRunEvents).values({
      runId: input.runId,
      sequence: (last?.sequence ?? 0) + 1,
      stage: "NEEDS_INPUT",
      kind: "WARNING",
      message: input.question,
      details: {},
    });
    return authorizationResult(reservation.amountUsd, accounting.incurredMicros);
  });
}

export async function completeClaimedRun(input: {
  runId: string;
  claimToken: string;
  cumulativeActualCostUsd: string | number;
  status: "SUCCEEDED" | "FAILED";
  event: {
    message: string;
    kind: "SUCCESS" | "ERROR";
    details?: Record<string, string | number | boolean | null>;
  };
  runValues?: Partial<typeof aiRuns.$inferInsert>;
  lastAnalyzedRepository?: { repositoryId: string; commitSha: string };
}): Promise<void> {
  await db.transaction(async (transaction) => {
    const [reservation] = await transaction
      .select()
      .from(costReservations)
      .where(eq(costReservations.runId, input.runId))
      .for("update")
      .limit(1);
    if (!reservation || reservation.status === "RELEASED") {
      throw new BillingError(
        "BILLING_STATE_CONFLICT",
        "The run no longer has a settleable cost authorization.",
        409,
      );
    }
    const accounting = validatedCumulativeCost({
      authorizedUsd: reservation.amountUsd,
      previouslyIncurredUsd: reservation.settledAmountUsd,
      cumulativeActualUsd: input.cumulativeActualCostUsd,
    });
    const actualUsd = microsToUsd(accounting.incurredMicros);
    const [owned] = await transaction
      .update(aiRuns)
      .set({
        ...input.runValues,
        status: input.status,
        stage: input.status,
        actualCostUsd: actualUsd,
        claimToken: null,
        claimedAt: null,
        heartbeatAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(aiRuns.id, input.runId), eq(aiRuns.claimToken, input.claimToken)))
      .returning({ id: aiRuns.id });
    if (!owned) {
      throw new BillingError("BILLING_STATE_CONFLICT", "Run claim was lost.", 409);
    }
    await transaction
      .update(costReservations)
      .set({
        status: accounting.incurredMicros === 0 ? "RELEASED" : "SETTLED",
        settledAmountUsd: accounting.incurredMicros === 0 ? null : actualUsd,
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(costReservations.id, reservation.id));
    await transaction
      .update(verificationJobs)
      .set({
        status: "FAILED",
        errorMessage: input.status === "FAILED" ? input.event.message : "Parent run completed",
        leaseExpiresAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(verificationJobs.runId, input.runId),
          inArray(verificationJobs.status, ["QUEUED", "RUNNING"]),
        ),
      );
    if (input.lastAnalyzedRepository) {
      await transaction
        .update(repositories)
        .set({
          lastAnalyzedCommit: input.lastAnalyzedRepository.commitSha,
          updatedAt: new Date(),
        })
        .where(eq(repositories.id, input.lastAnalyzedRepository.repositoryId));
    }
    const [last] = await transaction
      .select({ sequence: aiRunEvents.sequence })
      .from(aiRunEvents)
      .where(eq(aiRunEvents.runId, input.runId))
      .orderBy(sql`${aiRunEvents.sequence} desc`)
      .limit(1);
    await transaction.insert(aiRunEvents).values({
      runId: input.runId,
      sequence: (last?.sequence ?? 0) + 1,
      stage: input.status,
      kind: input.event.kind,
      message: input.event.message,
      details: input.event.details ?? {},
    });
  });
}

/**
 * Validates and returns the existing authorization before a paused run is put
 * back on the queue. This never creates a second reservation and never resets
 * its checkpointed cost.
 */
export async function resumeRunCost(input: {
  workspaceId: string;
  runId: string;
}): Promise<RunCostAuthorization> {
  await reconcilePaidBillingIfStale(input.workspaceId);
  const [reservation] = await db
    .select({
      workspaceId: costReservations.workspaceId,
      amountUsd: costReservations.amountUsd,
      settledAmountUsd: costReservations.settledAmountUsd,
      status: costReservations.status,
      runStatus: aiRuns.status,
    })
    .from(costReservations)
    .innerJoin(aiRuns, eq(aiRuns.id, costReservations.runId))
    .where(
      and(
        eq(costReservations.runId, input.runId),
        eq(costReservations.workspaceId, input.workspaceId),
        eq(aiRuns.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!reservation) {
    throw new BillingError(
      "INVALID_BILLING_REQUEST",
      "The run has no cost authorization in this workspace.",
      404,
    );
  }
  if (reservation.status !== "RESERVED") {
    throw new BillingError(
      "BILLING_STATE_CONFLICT",
      `This run's cost authorization is already ${reservation.status.toLowerCase()}.`,
      409,
    );
  }
  if (reservation.runStatus === "SUCCEEDED" || reservation.runStatus === "FAILED") {
    throw new BillingError(
      "BILLING_STATE_CONFLICT",
      `A ${reservation.runStatus.toLowerCase()} run cannot resume paid AI work.`,
      409,
    );
  }
  const accounting = calculateReservationAccounting({
    status: "RESERVED",
    authorizedUsd: reservation.amountUsd,
    incurredUsd: reservation.settledAmountUsd,
  });
  if (accounting.reservedMicros === 0) {
    throw new BillingError(
      "BUDGET_EXCEEDED",
      "This run has used its full cost authorization and cannot resume paid AI work.",
      402,
    );
  }
  return authorizationResult(reservation.amountUsd, accounting.incurredMicros);
}

/**
 * Ends an abandoned NEEDS_INPUT run at its last durable checkpoint, preserving
 * incurred spend and releasing only the unused remainder. Until this explicit
 * action occurs, the full authorization stays committed and cannot be spent by
 * another run.
 */
export async function abandonPausedRunCost(
  runId: string,
): Promise<{ status: "SETTLED" | "RELEASED"; actualUsd: string }> {
  return db.transaction(async (transaction) => {
    const [reservation] = await transaction
      .select({
        id: costReservations.id,
        amountUsd: costReservations.amountUsd,
        settledAmountUsd: costReservations.settledAmountUsd,
        status: costReservations.status,
        runStatus: aiRuns.status,
      })
      .from(costReservations)
      .innerJoin(aiRuns, eq(aiRuns.id, costReservations.runId))
      .where(eq(costReservations.runId, runId))
      .for("update")
      .limit(1);
    if (!reservation) {
      throw new BillingError(
        "BILLING_STATE_CONFLICT",
        "No cost reservation exists for this run.",
        409,
      );
    }
    if (reservation.status === "SETTLED") {
      return { status: "SETTLED", actualUsd: reservation.settledAmountUsd ?? "0.000000" };
    }
    if (reservation.status === "RELEASED") {
      return { status: "RELEASED", actualUsd: "0.000000" };
    }
    if (reservation.runStatus !== "FAILED") {
      throw new BillingError(
        "BILLING_STATE_CONFLICT",
        "Mark a paused run as failed before abandoning its cost authorization.",
        409,
      );
    }

    const actualMicros = usdToMicros(reservation.settledAmountUsd ?? 0);
    const actualUsd = microsToUsd(actualMicros);
    const status = actualMicros === 0 ? "RELEASED" : "SETTLED";
    await transaction
      .update(costReservations)
      .set({
        status,
        settledAmountUsd: actualMicros === 0 ? null : actualUsd,
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(costReservations.id, reservation.id));
    await transaction
      .update(aiRuns)
      .set({ actualCostUsd: actualUsd, updatedAt: new Date() })
      .where(eq(aiRuns.id, runId));
    return { status, actualUsd };
  });
}

/** Atomically closes a fully exhausted paused run and its cost authorization. */
export async function failExhaustedPausedRun(input: {
  workspaceId: string;
  runId: string;
  message: string;
}): Promise<"FAILED" | "NOT_FOUND" | "NOT_WAITING"> {
  return db.transaction(async (transaction) => {
    const [reservation] = await transaction
      .select({
        id: costReservations.id,
        status: costReservations.status,
        settledAmountUsd: costReservations.settledAmountUsd,
        runStatus: aiRuns.status,
      })
      .from(costReservations)
      .innerJoin(aiRuns, eq(aiRuns.id, costReservations.runId))
      .where(
        and(
          eq(costReservations.runId, input.runId),
          eq(costReservations.workspaceId, input.workspaceId),
          eq(aiRuns.workspaceId, input.workspaceId),
        ),
      )
      .for("update")
      .limit(1);
    if (!reservation) return "NOT_FOUND";
    if (reservation.runStatus !== "NEEDS_INPUT" || reservation.status !== "RESERVED") {
      return "NOT_WAITING";
    }

    const actualMicros = usdToMicros(reservation.settledAmountUsd ?? 0);
    const actualUsd = microsToUsd(actualMicros);
    await transaction
      .update(aiRuns)
      .set({
        status: "FAILED",
        stage: "FAILED",
        errorCode: "COST_LIMIT_REACHED",
        errorMessage: input.message,
        actualCostUsd: actualUsd,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aiRuns.id, input.runId));
    await transaction
      .update(costReservations)
      .set({
        status: actualMicros === 0 ? "RELEASED" : "SETTLED",
        settledAmountUsd: actualMicros === 0 ? null : actualUsd,
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(costReservations.id, reservation.id));
    const [last] = await transaction
      .select({ sequence: aiRunEvents.sequence })
      .from(aiRunEvents)
      .where(eq(aiRunEvents.runId, input.runId))
      .orderBy(sql`${aiRunEvents.sequence} desc`)
      .limit(1);
    await transaction.insert(aiRunEvents).values({
      runId: input.runId,
      sequence: (last?.sequence ?? 0) + 1,
      stage: "FAILED",
      kind: "ERROR",
      message: input.message,
      details: {},
    });
    return "FAILED";
  });
}

function invalidCumulativeCost(error: unknown): BillingError {
  return new BillingError(
    "BILLING_STATE_CONFLICT",
    error instanceof Error ? error.message : "Invalid cumulative run cost.",
    409,
  );
}

function validatedCumulativeCost(input: {
  authorizedUsd: string | number;
  previouslyIncurredUsd: string | number | null;
  cumulativeActualUsd: string | number;
}) {
  try {
    return validateCumulativeRunCost(input);
  } catch (error) {
    throw invalidCumulativeCost(error);
  }
}

function authorizationResult(authorizedUsd: string, incurredMicros: number): RunCostAuthorization {
  const authorizedMicros = usdToMicros(authorizedUsd);
  return {
    status: "RESERVED",
    authorizedUsd,
    incurredUsd: microsToUsd(incurredMicros),
    remainingUsd: microsToUsd(authorizedMicros - incurredMicros),
  };
}

function settlementResult(reservedUsd: string, actualMicros: number) {
  const reservedMicros = usdToMicros(reservedUsd);
  return {
    status: "SETTLED" as const,
    reservedUsd,
    actualUsd: microsToUsd(actualMicros),
    overageUsd: microsToUsd(Math.max(0, actualMicros - reservedMicros)),
  };
}

export async function releaseRunCost(runId: string): Promise<{ status: "RELEASED" }> {
  return db.transaction(async (transaction) => {
    const [reservation] = await transaction
      .select()
      .from(costReservations)
      .where(eq(costReservations.runId, runId))
      .for("update")
      .limit(1);
    if (!reservation) return { status: "RELEASED" as const };
    if (reservation.status === "SETTLED") {
      throw new BillingError("BILLING_STATE_CONFLICT", "A settled cost cannot be released.", 409);
    }
    if (reservation.status === "RESERVED") {
      if (usdToMicros(reservation.settledAmountUsd ?? 0) > 0) {
        throw new BillingError(
          "BILLING_STATE_CONFLICT",
          "A reservation with incurred cost cannot be released. Finalize or abandon it instead.",
          409,
        );
      }
      await transaction
        .update(costReservations)
        .set({
          status: "RELEASED",
          settledAmountUsd: null,
          settledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(costReservations.id, reservation.id));
    }
    return { status: "RELEASED" as const };
  });
}

export async function finalizeRunCost(
  runId: string,
  actualCostUsd: string | number,
): Promise<{ status: "SETTLED" | "RELEASED" }> {
  if (usdToMicros(actualCostUsd) === 0) return releaseRunCost(runId);
  await settleRunCost(runId, actualCostUsd);
  return { status: "SETTLED" };
}

/** Atomically enables a repository only if the workspace still has a plan slot. */
export async function enableRepositoryWithinPlan(input: {
  workspaceId: string;
  repositoryId: string;
}): Promise<{ enabled: true; enabledRepositories: number; limit: number }> {
  await reconcilePaidBillingIfStale(input.workspaceId);
  await createFreeAccountIfMissing(input.workspaceId);
  return db.transaction(async (transaction) => {
    const [account] = await transaction
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (!account) throw new BillingError("BILLING_STATE_CONFLICT", "Billing account is missing.");

    await enforceWorkspaceRepositoryEntitlements(transaction, {
      workspaceId: input.workspaceId,
      plan: account.plan,
    });

    const [repository] = await transaction
      .select({ id: repositories.id, enabled: repositories.enabled })
      .from(repositories)
      .where(
        and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    if (!repository) {
      throw new BillingError("INVALID_BILLING_REQUEST", "Repository not found.", 404);
    }

    const [{ value: enabledRepositories = 0 } = { value: 0 }] = await transaction
      .select({ value: count() })
      .from(repositories)
      .where(and(eq(repositories.workspaceId, input.workspaceId), eq(repositories.enabled, true)));
    const limit = getPlanDefinition(normalizeBillingPlan(account.plan)).repositoryLimit;
    if (!repository.enabled && enabledRepositories >= limit) {
      throw new BillingError(
        "PLAN_LIMIT_REACHED",
        `Your plan includes ${limit} enabled ${limit === 1 ? "repository" : "repositories"}. Upgrade or disable another repository first.`,
        409,
      );
    }

    if (!repository.enabled) {
      await transaction
        .update(repositories)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(repositories.id, repository.id));
    }
    return {
      enabled: true,
      enabledRepositories: enabledRepositories + (repository.enabled ? 0 : 1),
      limit,
    };
  });
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function getReservationTotals(
  executor: Transaction,
  workspaceId: string,
  period: BillingPeriod,
): Promise<{ spentUsd: string; reservedUsd: string }> {
  const accountedAt = sql<Date>`coalesce(${costReservations.settledAt}, ${costReservations.createdAt})`;
  const inPeriod = period.end
    ? and(gte(accountedAt, period.start), lt(accountedAt, period.end))
    : gte(accountedAt, period.start);

  const [row] = await executor
    .select({
      spentUsd: sql<string>`coalesce(sum(case when ${costReservations.status} in ('RESERVED', 'SETTLED') then coalesce(${costReservations.settledAmountUsd}, 0) else 0 end), 0)`,
      reservedUsd: sql<string>`coalesce(sum(case when ${costReservations.status} = 'RESERVED' then greatest(${costReservations.amountUsd} - coalesce(${costReservations.settledAmountUsd}, 0), 0) else 0 end), 0)`,
    })
    .from(costReservations)
    .where(
      and(
        eq(costReservations.workspaceId, workspaceId),
        or(eq(costReservations.status, "RESERVED"), inPeriod),
      ),
    );
  return { spentUsd: row?.spentUsd ?? "0", reservedUsd: row?.reservedUsd ?? "0" };
}

export async function getUsageSummary(workspaceId: string): Promise<UsageSummary> {
  await createFreeAccountIfMissing(workspaceId);
  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.workspaceId, workspaceId))
    .limit(1);
  if (!account) throw new BillingError("BILLING_STATE_CONFLICT", "Billing account is missing.");

  const period = getBillingPeriod(account);
  const accountedAt = sql<Date>`coalesce(${costReservations.settledAt}, ${costReservations.createdAt})`;
  const accountedInPeriod = period.end
    ? and(gte(accountedAt, period.start), lt(accountedAt, period.end))
    : gte(accountedAt, period.start);

  const rows = await db
    .select({
      id: aiRuns.id,
      repositoryName: repositories.fullName,
      status: aiRuns.status,
      createdAt: aiRuns.createdAt,
      actualCostUsd: aiRuns.actualCostUsd,
      estimatedCostUsd: aiRuns.estimatedCostUsd,
      modelUsage: aiRuns.modelUsage,
    })
    .from(aiRuns)
    .innerJoin(repositories, eq(repositories.id, aiRuns.repositoryId))
    .innerJoin(costReservations, eq(costReservations.runId, aiRuns.id))
    .where(
      and(
        eq(aiRuns.workspaceId, workspaceId),
        or(eq(costReservations.status, "RESERVED"), accountedInPeriod),
      ),
    )
    .orderBy(desc(aiRuns.createdAt));

  const plan = normalizeBillingPlan(account.plan);
  const budgetMicros = usdToMicros(account.aiBudgetUsd);
  const [totals] = await db
    .select({
      spentUsd: sql<string>`coalesce(sum(case when ${costReservations.status} in ('RESERVED', 'SETTLED') then coalesce(${costReservations.settledAmountUsd}, 0) else 0 end), 0)`,
      reservedUsd: sql<string>`coalesce(sum(case when ${costReservations.status} = 'RESERVED' then greatest(${costReservations.amountUsd} - coalesce(${costReservations.settledAmountUsd}, 0), 0) else 0 end), 0)`,
    })
    .from(costReservations)
    .where(
      and(
        eq(costReservations.workspaceId, workspaceId),
        or(
          eq(costReservations.status, "RESERVED"),
          period.end
            ? and(gte(accountedAt, period.start), lt(accountedAt, period.end))
            : gte(accountedAt, period.start),
        ),
      ),
    );
  const spentMicros = usdToMicros(totals?.spentUsd ?? "0");
  const reservedMicros = usdToMicros(totals?.reservedUsd ?? "0");

  const usageTotals = rows.reduce(
    (accumulator, row) => {
      for (const usage of row.modelUsage as ModelUsage[]) {
        accumulator.modelCalls += 1;
        accumulator.inputTokens += usage.inputTokens;
        accumulator.outputTokens += usage.outputTokens;
        accumulator.cachedInputTokens += usage.cachedInputTokens;
        accumulator.webSearchCalls += usage.webSearchCalls;
      }
      return accumulator;
    },
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, webSearchCalls: 0 },
  );

  return {
    plan,
    periodStart: period.start.toISOString(),
    periodEnd: period.end?.toISOString() ?? null,
    budgetUsd: microsToUsd(budgetMicros),
    spentUsd: microsToUsd(spentMicros),
    reservedUsd: microsToUsd(reservedMicros),
    remainingUsd: microsToUsd(Math.max(0, budgetMicros - spentMicros - reservedMicros)),
    runs: rows.length,
    ...usageTotals,
    recentRuns: rows.slice(0, 25).map((row) => {
      const usage = row.modelUsage as ModelUsage[];
      return {
        id: row.id,
        repositoryName: row.repositoryName,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        actualCostUsd: row.actualCostUsd,
        estimatedCostUsd: row.estimatedCostUsd,
        modelCalls: usage.length,
        inputTokens: usage.reduce((total, item) => total + item.inputTokens, 0),
        outputTokens: usage.reduce((total, item) => total + item.outputTokens, 0),
        cachedInputTokens: usage.reduce((total, item) => total + item.cachedInputTokens, 0),
        webSearchCalls: usage.reduce((total, item) => total + item.webSearchCalls, 0),
      };
    }),
  };
}

export async function getWorkspacePlan(workspaceId: string): Promise<PlanDefinition> {
  await createFreeAccountIfMissing(workspaceId);
  const [account] = await db
    .select({ plan: billingAccounts.plan, aiBudgetUsd: billingAccounts.aiBudgetUsd })
    .from(billingAccounts)
    .where(eq(billingAccounts.workspaceId, workspaceId))
    .limit(1);
  const definition = getPlanDefinition(normalizeBillingPlan(account?.plan));
  return { ...definition, aiBudgetUsd: account?.aiBudgetUsd ?? "0.000000" };
}
