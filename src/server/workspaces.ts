"use server";

import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db/client";
import { billingAccounts, workspaceMemberships, workspaces } from "@/db/schema";
import { allocateLifetimeFreeTrial } from "@/billing/free-trial";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/constants";
import { readPlanEnv } from "@/lib/env";
import { slugify } from "@/lib/format";
import { requireSession, requireWorkspaceMembership } from "@/server/session";

const workspaceInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

function workspaceSlugCandidate(name: string, attempt: number): string {
  const base = slugify(name) || "workspace";
  if (attempt === 0) return base;
  if (attempt < 20) return `${base}-${attempt + 1}`;
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function isWorkspaceSlugConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const postgresError = error as { code?: string; constraint_name?: string };
  return (
    postgresError.code === "23505" &&
    (!postgresError.constraint_name || postgresError.constraint_name === "workspaces_slug_unique")
  );
}

async function insertWorkspace(input: { name: string; userId: string; freeBudget: string }) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const slug = workspaceSlugCandidate(input.name, attempt);
    try {
      return await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(workspaces)
          .values({ name: input.name, slug, createdBy: input.userId })
          .returning();
        if (!created) throw new Error("Workspace could not be created");

        await tx.insert(workspaceMemberships).values({
          workspaceId: created.id,
          userId: input.userId,
          role: "OWNER",
        });
        const aiBudgetUsd = await allocateLifetimeFreeTrial(tx, {
          userId: input.userId,
          workspaceId: created.id,
          configuredBudgetUsd: input.freeBudget,
        });
        await tx.insert(billingAccounts).values({
          workspaceId: created.id,
          plan: "FREE",
          subscriptionStatus: "NONE",
          aiBudgetUsd,
        });
        return created;
      });
    } catch (error) {
      if (isWorkspaceSlugConflict(error)) continue;
      throw error;
    }
  }

  throw new Error("A unique workspace URL could not be allocated");
}

export async function createWorkspaceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const input = workspaceInputSchema.parse({ name: formData.get("name") });
  const freeBudget = readPlanEnv().FREE_AI_BUDGET_USD.toFixed(6);
  const workspace = await insertWorkspace({
    name: input.name,
    userId: session.user.id,
    freeBudget,
  });

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, workspace.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect("/app");
}

export async function switchWorkspaceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const workspaceId = z.uuid().parse(formData.get("workspaceId"));
  await requireWorkspaceMembership(workspaceId, session.user.id);

  await db
    .update(workspaceMemberships)
    .set({ lastActiveAt: new Date() })
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, session.user.id),
      ),
    );

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect("/app");
}

export async function signOutAction(): Promise<void> {
  await authSignOut();
  redirect("/");
}

async function authSignOut() {
  const { auth } = await import("@/auth/auth");
  const { headers } = await import("next/headers");
  await auth.api.signOut({ headers: await headers() });
}
