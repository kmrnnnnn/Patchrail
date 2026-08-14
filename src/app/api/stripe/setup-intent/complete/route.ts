import { z } from "zod";
import { completePaymentMethodSetup } from "@/billing/stripe";
import { BillingError } from "@/billing/errors";
import { billingErrorResponse, requireSameOrigin } from "@/billing/http";
import { getApiWorkspaceContext } from "@/server/session";

const requestSchema = z.object({ setupIntentId: z.string().min(6).max(255) }).strict();

export async function POST(request: Request): Promise<Response> {
  let workspaceId: string | undefined;
  try {
    requireSameOrigin(request);
    const { workspace } = await getApiWorkspaceContext();
    workspaceId = workspace.id;
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new BillingError("INVALID_BILLING_REQUEST", "Invalid payment setup request.");
    }
    await completePaymentMethodSetup({ workspaceId, setupIntentId: parsed.data.setupIntentId });
    return Response.json({ ok: true });
  } catch (error) {
    return billingErrorResponse(error, workspaceId);
  }
}
