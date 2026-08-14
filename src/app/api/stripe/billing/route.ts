import { getBillingPageData } from "@/billing/stripe";
import { billingErrorResponse, requireSameOrigin } from "@/billing/http";
import { getApiWorkspaceContext } from "@/server/session";

export async function GET(): Promise<Response> {
  let workspaceId: string | undefined;
  try {
    const { workspace } = await getApiWorkspaceContext();
    workspaceId = workspace.id;
    return Response.json(await getBillingPageData(workspaceId, { forceReconcile: true }));
  } catch (error) {
    return billingErrorResponse(error, workspaceId);
  }
}

export async function POST(request: Request): Promise<Response> {
  let workspaceId: string | undefined;
  try {
    requireSameOrigin(request);
    const { workspace } = await getApiWorkspaceContext();
    workspaceId = workspace.id;
    return Response.json(await getBillingPageData(workspaceId, { forceReconcile: true }));
  } catch (error) {
    return billingErrorResponse(error, workspaceId);
  }
}
