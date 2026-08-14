import { createPaymentMethodSetup } from "@/billing/stripe";
import { billingErrorResponse, requireSameOrigin } from "@/billing/http";
import { getApiWorkspaceContext } from "@/server/session";

export async function POST(request: Request): Promise<Response> {
  let workspaceId: string | undefined;
  try {
    requireSameOrigin(request);
    const { session, workspace } = await getApiWorkspaceContext();
    workspaceId = workspace.id;
    const setup = await createPaymentMethodSetup({
      workspaceId,
      workspaceName: workspace.name,
      user: session.user,
    });
    return Response.json(setup);
  } catch (error) {
    return billingErrorResponse(error, workspaceId);
  }
}
