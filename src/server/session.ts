import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth, type AuthSession } from "@/auth/auth";
import { db } from "@/db/client";
import { workspaceMemberships, workspaces } from "@/db/schema";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/constants";

export class AuthorizationError extends Error {
  constructor(
    message = "You do not have access to this workspace",
    readonly status: 401 | 403 = 403,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export async function getSession(): Promise<AuthSession | null> {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireApiSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) throw new AuthorizationError("Authentication required", 401);
  return session;
}

export type WorkspaceMembership = {
  id: string;
  name: string;
  slug: string;
  role: string;
  lastActiveAt: Date;
};

export async function getUserWorkspaces(userId: string): Promise<WorkspaceMembership[]> {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMemberships.role,
      lastActiveAt: workspaceMemberships.lastActiveAt,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
    .where(eq(workspaceMemberships.userId, userId))
    .orderBy(desc(workspaceMemberships.lastActiveAt));
}

export async function requireWorkspaceMembership(
  workspaceId: string,
  userId?: string,
): Promise<WorkspaceMembership> {
  if (!z.uuid().safeParse(workspaceId).success) throw new AuthorizationError();
  const resolvedUserId = userId ?? (await requireApiSession()).user.id;
  const [membership] = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMemberships.role,
      lastActiveAt: workspaceMemberships.lastActiveAt,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, resolvedUserId),
      ),
    )
    .limit(1);

  if (!membership) throw new AuthorizationError();
  return membership;
}

export async function getWorkspaceContext(): Promise<{
  session: AuthSession;
  workspace: WorkspaceMembership;
  workspaces: WorkspaceMembership[];
}> {
  const session = await requireSession();
  const memberships = await getUserWorkspaces(session.user.id);
  if (memberships.length === 0) redirect("/app/onboarding");

  const cookieStore = await cookies();
  const preferredId = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const workspace = memberships.find((item) => item.id === preferredId) ?? memberships[0];
  if (!workspace) redirect("/app/onboarding");

  return { session, workspace, workspaces: memberships };
}

export async function getApiWorkspaceContext(workspaceId?: string): Promise<{
  session: AuthSession;
  workspace: WorkspaceMembership;
}> {
  const session = await requireApiSession();
  const explicitlyRequested = workspaceId !== undefined;
  let resolvedId = workspaceId;

  if (explicitlyRequested && !z.uuid().safeParse(resolvedId).success) {
    throw new AuthorizationError();
  }

  if (!resolvedId) {
    const cookieStore = await cookies();
    resolvedId = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;
    if (resolvedId && !z.uuid().safeParse(resolvedId).success) resolvedId = undefined;
  }

  if (resolvedId) {
    try {
      const workspace = await requireWorkspaceMembership(resolvedId, session.user.id);
      return { session, workspace };
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      if (explicitlyRequested) throw error;
      // A stale cookie must not block a returning member from their workspace.
    }
  }

  const [workspace] = await getUserWorkspaces(session.user.id);
  if (!workspace) throw new AuthorizationError("No active workspace selected");
  return { session, workspace };
}

export function authorizationResponse(error: unknown): Response | null {
  if (error instanceof AuthorizationError) {
    return Response.json(
      { error: error.message },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  }
  return null;
}
