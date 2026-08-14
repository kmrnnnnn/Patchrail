export type BillingErrorCode =
  | "BILLING_NOT_CONFIGURED"
  | "BILLING_STATE_CONFLICT"
  | "BUDGET_EXCEEDED"
  | "INVALID_BILLING_REQUEST"
  | "PLAN_LIMIT_REACHED"
  | "STRIPE_RESOURCE_MISMATCH"
  | "STRIPE_STATE_UNAVAILABLE";

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export class BillingConfigurationError extends BillingError {
  constructor(
    message = "Billing is not configured yet. Add the Stripe keys and PRO price lookup key to enable billing.",
  ) {
    super("BILLING_NOT_CONFIGURED", message, 503);
    this.name = "BillingConfigurationError";
  }
}

export function getPublicBillingError(error: unknown): {
  code: BillingErrorCode | "INTERNAL_ERROR";
  message: string;
  status: number;
} {
  if (error instanceof BillingError) {
    return { code: error.code, message: error.message, status: error.status };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "Billing could not be updated. Please try again.",
    status: 500,
  };
}
