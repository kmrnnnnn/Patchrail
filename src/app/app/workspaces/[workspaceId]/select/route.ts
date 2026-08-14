import { cookies } from "next/headers";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { workspaceMemberships } from "@/db/schema";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/constants";
import { crossSiteRequestResponse, requireSameOrigin } from "@/security/request";
import {
  authorizationResponse,
  requireApiSession,
  requireWorkspaceMembership,
} from "@/server/session";

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  try {
    requireSameOrigin(request);
    const session = await requireApiSession();
    const { workspaceId } = await context.params;
    z.uuid().parse(workspaceId);
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
    return new Response(null, { status: 204 });
  } catch (error) {
    const crossSite = crossSiteRequestResponse(error);
    if (crossSite) return crossSite;
    const authorization = authorizationResponse(error);
    if (authorization) return authorization;
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Invalid workspace ID" }, { status: 400 });
    }
    throw error;
  }
}
