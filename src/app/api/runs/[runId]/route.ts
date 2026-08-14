import { z } from "zod";
import { getRunDetail } from "@/server/queries";
import { authorizationResponse, getApiWorkspaceContext } from "@/server/session";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { workspace } = await getApiWorkspaceContext();
    const { runId } = await context.params;
    z.uuid().parse(runId);
    const detail = await getRunDetail(workspace.id, runId);
    if (!detail) return Response.json({ error: "Run not found" }, { status: 404 });
    return Response.json(detail, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const authorization = authorizationResponse(error);
    if (authorization) return authorization;
    if (error instanceof z.ZodError)
      return Response.json({ error: "Invalid run ID" }, { status: 400 });
    throw error;
  }
}
