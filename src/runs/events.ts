import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { aiRunEvents, aiRuns } from "@/db/schema";
import type { RunEventDetails, RunStatus } from "@/runs/types";

type RunTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function appendRunEventInTransaction(
  transaction: RunTransaction,
  input: {
    runId: string;
    stage: RunStatus | string;
    message: string;
    kind?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
    details?: RunEventDetails;
  },
): Promise<void> {
  const [last] = await transaction
    .select({ sequence: aiRunEvents.sequence })
    .from(aiRunEvents)
    .where(eq(aiRunEvents.runId, input.runId))
    .orderBy(sql`${aiRunEvents.sequence} desc`)
    .limit(1);
  await transaction.insert(aiRunEvents).values({
    runId: input.runId,
    sequence: (last?.sequence ?? 0) + 1,
    stage: input.stage,
    message: input.message,
    kind: input.kind ?? "INFO",
    details: input.details ?? {},
  });
}

export async function appendRunEvent(input: {
  runId: string;
  stage: RunStatus | string;
  message: string;
  kind?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  details?: RunEventDetails;
}): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select id from ${aiRuns} where id = ${input.runId} for update`);
    await appendRunEventInTransaction(transaction, input);
  });
}

export async function appendClaimedRunEvent(
  claimToken: string,
  input: Parameters<typeof appendRunEvent>[0],
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [owned] = await transaction
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(and(eq(aiRuns.id, input.runId), eq(aiRuns.claimToken, claimToken)))
      .for("update")
      .limit(1);
    if (!owned) throw new Error("Run claim was lost");
    await appendRunEventInTransaction(transaction, input);
  });
}

export async function transitionRun(
  runId: string,
  status: RunStatus,
  message: string,
  details?: RunEventDetails,
  claimToken?: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [updated] = await transaction
      .update(aiRuns)
      .set({ status, stage: status, heartbeatAt: new Date(), updatedAt: new Date() })
      .where(
        claimToken
          ? and(eq(aiRuns.id, runId), eq(aiRuns.claimToken, claimToken))
          : eq(aiRuns.id, runId),
      )
      .returning({ id: aiRuns.id });
    if (!updated) throw new Error("Run claim was lost");
    await appendRunEventInTransaction(transaction, { runId, stage: status, message, details });
  });
}
