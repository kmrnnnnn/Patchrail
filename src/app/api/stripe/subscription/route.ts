import { createProSubscription } from "@/billing/stripe";
import { billingErrorResponse, requireSameOrigin } from "@/billing/http";
import { getApiWorkspaceContext } from "@/server/session";

export async function POST(request: Request): Promise<Response> {
  let workspaceId: string | undefined;
  try {
    requireSameOrigin(request);
    const { session, workspace } = await getApiWorkspaceContext();
    workspaceId = workspace.id;
    const result = await createProSubscription({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      user: session.user,
    });
    return Response.json(result);
  } catch (error) {
    return billingErrorResponse(error, workspaceId);
  }
}
