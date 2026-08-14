import { setSubscriptionCancellation } from "@/billing/stripe";
import { billingErrorResponse, requireSameOrigin } from "@/billing/http";
import { getApiWorkspaceContext } from "@/server/session";

export async function POST(request: Request): Promise<Response> {
  let workspaceId: string | undefined;
  try {
    requireSameOrigin(request);
    const { workspace } = await getApiWorkspaceContext();
    workspaceId = workspace.id;
    await setSubscriptionCancellation({ workspaceId, cancelAtPeriodEnd: true });
    return Response.json({ ok: true });
  } catch (error) {
    return billingErrorResponse(error, workspaceId);
  }
}
