import "server-only";

import { authorizationResponse } from "@/server/session";
import { BillingError, getPublicBillingError } from "@/billing/errors";
import { logger } from "@/lib/logger";
import { requireSameOrigin as requireRequestSameOrigin } from "@/security/request";

export function requireSameOrigin(request: Request): void {
  try {
    requireRequestSameOrigin(request);
  } catch {
    throw new BillingError("INVALID_BILLING_REQUEST", "Cross-site billing request rejected.", 403);
  }
}

export function billingErrorResponse(error: unknown, workspaceId?: string): Response {
  const authorization = authorizationResponse(error);
  if (authorization) return authorization;

  const publicError = getPublicBillingError(error);
  logger.error("billing.request_failed", {
    workspaceId,
    errorCode: publicError.code,
  });
  return Response.json(
    { error: publicError.message, code: publicError.code },
    { status: publicError.status },
  );
}
