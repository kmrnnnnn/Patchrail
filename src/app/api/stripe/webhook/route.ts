import { BillingError } from "@/billing/errors";
import { getPublicBillingError } from "@/billing/errors";
import { processStripeWebhook } from "@/billing/stripe";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
const MAX_STRIPE_WEBHOOK_BYTES = 1_000_000;

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "Missing Stripe signature." }, { status: 400 });
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_STRIPE_WEBHOOK_BYTES) {
    return Response.json({ error: "Stripe webhook payload is too large." }, { status: 413 });
  }

  try {
    // Stripe signature verification must receive the exact, unparsed bytes.
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_STRIPE_WEBHOOK_BYTES) {
      return Response.json({ error: "Stripe webhook payload is too large." }, { status: 413 });
    }
    const result = await processStripeWebhook(rawBody, signature);
    return Response.json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    const publicError = getPublicBillingError(error);
    logger.error("stripe.webhook_failed", {
      errorCode: error instanceof BillingError ? error.code : "STRIPE_WEBHOOK_ERROR",
    });
    return Response.json(
      { error: publicError.message },
      { status: publicError.status === 400 ? 400 : 500 },
    );
  }
}
