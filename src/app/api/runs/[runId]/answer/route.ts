import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { aiRuns } from "@/db/schema";
import { failExhaustedPausedRun, resumeRunCost } from "@/billing/costs";
import { BillingError } from "@/billing/errors";
import { billingErrorResponse, requireSameOrigin } from "@/billing/http";
import { appendRunEventInTransaction } from "@/runs/events";
import { authorizationResponse, getApiWorkspaceContext } from "@/server/session";

const answerSchema = z.object({
  answer: z.string().trim().min(1).max(2_000),
});

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    requireSameOrigin(request);
    const { workspace } = await getApiWorkspaceContext();
    const { runId } = await context.params;
    z.uuid().parse(runId);
    const input = answerSchema.parse(await request.json());
    try {
      await resumeRunCost({ workspaceId: workspace.id, runId });
    } catch (error) {
      if (error instanceof BillingError && error.code === "BUDGET_EXCEEDED") {
        const exhausted = await failExhaustedPausedRun({
          workspaceId: workspace.id,
          runId,
          message: "The run could not resume because its Patchrail allowance was exhausted",
        });
        if (exhausted === "FAILED") {
          return Response.json(
            {
              error:
                "This run has used its available Patchrail allowance. It has been closed; review or change the workspace plan before starting a new run.",
              code: "PLAN_ALLOWANCE_EXHAUSTED",
            },
            { status: 402 },
          );
        }
      }
      throw error;
    }

    const resumed = await db.transaction(async (transaction) => {
      const [run] = await transaction
        .select({ id: aiRuns.id, status: aiRuns.status, inputAnswer: aiRuns.inputAnswer })
        .from(aiRuns)
        .where(and(eq(aiRuns.id, runId), eq(aiRuns.workspaceId, workspace.id)))
        .for("update")
        .limit(1);
      if (!run) return "NOT_FOUND" as const;
      if (run.status !== "NEEDS_INPUT" || run.inputAnswer !== null) return "NOT_WAITING" as const;

      await transaction
        .update(aiRuns)
        .set({
          inputAnswer: input.answer,
          status: "QUEUED",
          stage: "QUEUED",
          errorCode: null,
          errorMessage: null,
          claimToken: null,
          claimedAt: null,
          heartbeatAt: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(aiRuns.id, runId));
      await appendRunEventInTransaction(transaction, {
        runId,
        stage: "QUEUED",
        message: "Human clarification received; the same pinned run was queued to resume",
      });
      return "RESUMED" as const;
    });

    if (resumed === "NOT_FOUND") {
      return Response.json({ error: "Run not found" }, { status: 404 });
    }
    if (resumed === "NOT_WAITING") {
      return Response.json(
        { error: "This run is no longer waiting for an answer" },
        { status: 409 },
      );
    }
    return Response.json({ runId, status: "QUEUED" }, { status: 202 });
  } catch (error) {
    const authorization = authorizationResponse(error);
    if (authorization) return authorization;
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "Provide a concise answer of at most 2,000 characters" },
        { status: 400 },
      );
    }
    return billingErrorResponse(error);
  }
}
