"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db/client";
import { aiRuns, repositories } from "@/db/schema";
import { enableRepositoryWithinPlan } from "@/billing/costs";
import { getWorkspaceContext } from "@/server/session";

export async function enableRepositoryAction(formData: FormData): Promise<void> {
  const repositoryId = z.uuid().parse(formData.get("repositoryId"));
  const { workspace } = await getWorkspaceContext();
  const [repository] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.id, repositoryId), eq(repositories.workspaceId, workspace.id)))
    .limit(1);

  if (!repository) throw new Error("Repository not found");
  await enableRepositoryWithinPlan({ workspaceId: workspace.id, repositoryId });
  revalidatePath("/app/repositories");
  revalidatePath(`/app/repositories/${repositoryId}`);
  redirect(`/app/repositories/${repositoryId}`);
}

export async function disableRepositoryAction(formData: FormData): Promise<void> {
  const repositoryId = z.uuid().parse(formData.get("repositoryId"));
  const { workspace } = await getWorkspaceContext();
  await db.transaction(async (transaction) => {
    const [repository] = await transaction
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.id, repositoryId), eq(repositories.workspaceId, workspace.id)))
      .for("update")
      .limit(1);
    if (!repository) throw new Error("Repository not found");

    const [activeRun] = await transaction
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.repositoryId, repositoryId),
          inArray(aiRuns.status, [
            "PENDING_RESERVATION",
            "QUEUED",
            "READING_REPOSITORY",
            "FINDING_APIS",
            "RESEARCHING_APIS",
            "PLANNING_CHANGES",
            "UPDATING_CODE",
            "VERIFYING",
            "REPAIRING",
            "CREATING_PR",
            "NEEDS_INPUT",
          ]),
        ),
      )
      .limit(1);
    if (activeRun) throw new Error("Wait for the active run to finish before disabling Patchrail");

    await transaction
      .update(repositories)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(repositories.id, repositoryId));
  });
  revalidatePath("/app/repositories");
  revalidatePath(`/app/repositories/${repositoryId}`);
  redirect(`/app/repositories/${repositoryId}`);
}
