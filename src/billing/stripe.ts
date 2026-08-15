import "server-only";

import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { billingAccounts, webhookDeliveries } from "@/db/schema";
import { stripeEnvSchema } from "@/lib/env";
import { logger } from "@/lib/logger";
import { BillingConfigurationError, BillingError } from "@/billing/errors";
import { getWorkspaceFreeTrialBudgetUsd } from "@/billing/free-trial";
import { getPlanDefinition, isProEntitled, normalizeBillingPlan } from "@/billing/plans";
import { enforceWorkspaceRepositoryEntitlements } from "@/billing/repository-entitlements";
import {
  ACCOUNT_METADATA_KEY,
  stripeApiKeysUseSameMode,
  stripeMetadataMatchesWorkspace,
  WORKSPACE_METADATA_KEY,
} from "@/billing/stripe-policy";
import type {
  BillingAccountView,
  BillingInvoice,
  BillingPageData,
  BillingPlan,
} from "@/billing/types";

const RECONCILIATION_MAX_AGE_MS = 5 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StripeConfiguration = ReturnType<typeof stripeEnvSchema.parse>;
type AuthenticatedUser = { id: string; name?: string | null; email?: string | null };

export type BillingSnapshot = {
  workspaceId: string;
  plan: BillingPlan;
  subscriptionStatus: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  currency: string | null;
  unitAmount: number | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  paymentMethodBrand: string | null;
  paymentMethodLast4: string | null;
  aiBudgetUsd: string;
  reconciledAt: Date;
};

let stripeClient: Stripe | undefined;
let stripeClientKey: string | undefined;
let cachedPrice: { key: string; expiresAt: number; price: Stripe.Price } | undefined;

export function getStripeConfiguration(): StripeConfiguration {
  const parsed = stripeEnvSchema.safeParse(process.env);
  if (!parsed.success) throw new BillingConfigurationError();
  if (
    !stripeApiKeysUseSameMode(
      parsed.data.STRIPE_SECRET_KEY,
      parsed.data.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    )
  ) {
    throw new BillingConfigurationError(
      "Stripe server and publishable keys must both be valid keys from the same test or live mode.",
    );
  }
  return parsed.data;
}

export function getStripeConfigurationState():
  | { configured: true; publishableKey: string }
  | { configured: false; publishableKey: null; message: string } {
  try {
    const configuration = getStripeConfiguration();
    return { configured: true, publishableKey: configuration.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY };
  } catch (error) {
    return {
      configured: false,
      publishableKey: null,
      message: error instanceof Error ? error.message : "Billing is not configured.",
    };
  }
}

export function getStripe(): Stripe {
  const configuration = getStripeConfiguration();
  if (!stripeClient || stripeClientKey !== configuration.STRIPE_SECRET_KEY) {
    stripeClient = new Stripe(configuration.STRIPE_SECRET_KEY, {
      appInfo: { name: "Patchrail", version: "0.1.0" },
      maxNetworkRetries: 2,
    });
    stripeClientKey = configuration.STRIPE_SECRET_KEY;
    cachedPrice = undefined;
  }
  return stripeClient;
}

function stripeResourceMissing(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeError && error.code === "resource_missing";
}

export async function getOrCreateBillingAccount(workspaceId: string) {
  const freeBudgetUsd = await getWorkspaceFreeTrialBudgetUsd(workspaceId);
  await db
    .insert(billingAccounts)
    .values({
      workspaceId,
      plan: "FREE",
      subscriptionStatus: "NONE",
      aiBudgetUsd: freeBudgetUsd,
    })
    .onConflictDoNothing({ target: billingAccounts.workspaceId });

  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.workspaceId, workspaceId))
    .limit(1);
  if (!account) throw new BillingError("BILLING_STATE_CONFLICT", "Billing account is missing.");
  return account;
}

function customerMatchesWorkspace(
  customer: Stripe.Customer,
  workspaceId: string,
  configuration: StripeConfiguration,
): boolean {
  return stripeMetadataMatchesWorkspace(customer.metadata, {
    workspaceId,
    accountKey: configuration.STRIPE_ACCOUNT_KEY,
  });
}

export async function ensureStripeCustomer(input: {
  workspaceId: string;
  workspaceName: string;
  user: AuthenticatedUser;
}): Promise<Stripe.Customer> {
  const configuration = getStripeConfiguration();
  const stripe = getStripe();
  await getOrCreateBillingAccount(input.workspaceId);

  return db.transaction(async (transaction) => {
    const [account] = await transaction
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (!account) throw new BillingError("BILLING_STATE_CONFLICT", "Billing account is missing.");

    if (account.stripeCustomerId) {
      try {
        const existing = await stripe.customers.retrieve(account.stripeCustomerId);
        if (!existing.deleted) {
          if (!customerMatchesWorkspace(existing, input.workspaceId, configuration)) {
            throw new BillingError(
              "STRIPE_RESOURCE_MISMATCH",
              "The stored Stripe customer does not belong to this workspace.",
              409,
            );
          }
          return existing;
        }
      } catch (error) {
        if (!stripeResourceMissing(error)) throw error;
      }
    }

    const customer = await stripe.customers.create(
      {
        email: input.user.email ?? undefined,
        name: input.workspaceName,
        description: `Patchrail workspace: ${input.workspaceName}`,
        metadata: {
          [WORKSPACE_METADATA_KEY]: input.workspaceId,
          [ACCOUNT_METADATA_KEY]: configuration.STRIPE_ACCOUNT_KEY,
          patchrail_created_by: input.user.id,
        },
      },
      { idempotencyKey: `patchrail:customer:${input.workspaceId}:${account.updatedAt.getTime()}` },
    );

    await transaction
      .update(billingAccounts)
      .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
      .where(eq(billingAccounts.workspaceId, input.workspaceId));
    return customer;
  });
}

export async function resolveProPrice(): Promise<Stripe.Price> {
  const configuration = getStripeConfiguration();
  const cacheKey = `${configuration.STRIPE_SECRET_KEY.slice(-8)}:${configuration.STRIPE_PRO_LOOKUP_KEY}`;
  if (cachedPrice?.key === cacheKey && cachedPrice.expiresAt > Date.now()) return cachedPrice.price;

  const prices = await getStripe().prices.list({
    active: true,
    lookup_keys: [configuration.STRIPE_PRO_LOOKUP_KEY],
    type: "recurring",
    limit: 10,
  });
  const price = prices.data.find(
    (candidate) =>
      candidate.lookup_key === configuration.STRIPE_PRO_LOOKUP_KEY &&
      candidate.recurring?.interval === "month" &&
      candidate.recurring.interval_count === 1 &&
      candidate.recurring?.usage_type !== "metered" &&
      candidate.unit_amount !== null &&
      candidate.unit_amount > 0,
  );
  if (!price) {
    throw new BillingConfigurationError(
      `No active monthly licensed Stripe price has lookup key “${configuration.STRIPE_PRO_LOOKUP_KEY}”.`,
    );
  }

  cachedPrice = { key: cacheKey, expiresAt: Date.now() + RECONCILIATION_MAX_AGE_MS, price };
  return price;
}

function subscriptionPriority(subscription: Stripe.Subscription): number {
  const priorities: Record<string, number> = {
    active: 8,
    trialing: 7,
    past_due: 6,
    unpaid: 5,
    incomplete: 4,
    paused: 3,
    canceled: 2,
    incomplete_expired: 1,
  };
  return priorities[subscription.status] ?? 0;
}

function subscriptionBelongsToProduct(
  subscription: Stripe.Subscription,
  configuration: StripeConfiguration,
  workspaceId: string,
): boolean {
  return (
    stripeMetadataMatchesWorkspace(subscription.metadata, {
      workspaceId,
      accountKey: configuration.STRIPE_ACCOUNT_KEY,
    }) &&
    subscription.items.data.some(
      (item) => item.price.lookup_key === configuration.STRIPE_PRO_LOOKUP_KEY,
    )
  );
}

async function listTargetSubscriptions(
  customerId: string,
  workspaceId: string,
): Promise<Stripe.Subscription[]> {
  const configuration = getStripeConfiguration();
  const subscriptions = await getStripe().subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
    expand: ["data.default_payment_method"],
  });
  return subscriptions.data
    .filter((subscription) =>
      subscriptionBelongsToProduct(subscription, configuration, workspaceId),
    )
    .sort(
      (left, right) =>
        subscriptionPriority(right) - subscriptionPriority(left) || right.created - left.created,
    );
}

async function getExpandedInvoice(
  latestInvoice: string | Stripe.Invoice | null,
): Promise<Stripe.Invoice | null> {
  if (!latestInvoice) return null;
  if (typeof latestInvoice !== "string") return latestInvoice;
  return getStripe().invoices.retrieve(latestInvoice, { expand: ["confirmation_secret"] });
}

async function subscriptionClientSecret(subscription: Stripe.Subscription): Promise<string | null> {
  const invoice = await getExpandedInvoice(subscription.latest_invoice);
  return invoice?.confirmation_secret?.client_secret ?? null;
}

export async function createProSubscription(input: {
  workspaceId: string;
  workspaceName: string;
  user: AuthenticatedUser;
}): Promise<{
  subscriptionId: string;
  clientSecret: string | null;
  status: string;
  requiresPayment: boolean;
}> {
  const configuration = getStripeConfiguration();
  const stripe = getStripe();
  const price = await resolveProPrice();
  const customer = await ensureStripeCustomer(input);

  return db.transaction(async (transaction) => {
    const [lockedAccount] = await transaction
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (!lockedAccount) {
      throw new BillingError("BILLING_STATE_CONFLICT", "Billing account is missing.");
    }
    if (lockedAccount.stripeCustomerId !== customer.id) {
      throw new BillingError(
        "BILLING_STATE_CONFLICT",
        "The Stripe customer changed while the subscription was starting. Please try again.",
        409,
      );
    }

    let subscription: Stripe.Subscription | undefined;
    if (lockedAccount.stripeSubscriptionId) {
      try {
        const existing = await stripe.subscriptions.retrieve(lockedAccount.stripeSubscriptionId, {
          expand: ["latest_invoice.confirmation_secret", "default_payment_method"],
        });
        if (
          subscriptionBelongsToProduct(existing, configuration, input.workspaceId) &&
          !["canceled", "incomplete_expired"].includes(existing.status)
        ) {
          subscription = existing;
        }
      } catch (error) {
        if (!stripeResourceMissing(error)) throw error;
      }
    }

    if (!subscription) {
      const candidates = await listTargetSubscriptions(customer.id, input.workspaceId);
      subscription = candidates.find(
        (candidate) => !["canceled", "incomplete_expired"].includes(candidate.status),
      );
    }

    if (!subscription) {
      subscription = await stripe.subscriptions.create(
        {
          customer: customer.id,
          items: [{ price: price.id }],
          payment_behavior: "default_incomplete",
          payment_settings: {
            payment_method_types: ["card"],
            save_default_payment_method: "on_subscription",
          },
          billing_mode: { type: "flexible" },
          metadata: {
            [WORKSPACE_METADATA_KEY]: input.workspaceId,
            [ACCOUNT_METADATA_KEY]: configuration.STRIPE_ACCOUNT_KEY,
          },
          expand: ["latest_invoice.confirmation_secret", "default_payment_method"],
        },
        {
          idempotencyKey: `patchrail:subscription:${input.workspaceId}:${lockedAccount.updatedAt.getTime()}`,
        },
      );
    }

    const snapshot = await buildSnapshotFromStripe(input.workspaceId, customer, subscription);
    await persistBillingSnapshot(transaction, snapshot);
    const entitled = isProEntitled(subscription.status);
    const clientSecret = entitled ? null : await subscriptionClientSecret(subscription);
    if (!entitled && !clientSecret) {
      throw new BillingError(
        "STRIPE_STATE_UNAVAILABLE",
        "Stripe created the subscription but did not return a payment confirmation secret. Please try again.",
        502,
      );
    }
    return {
      subscriptionId: subscription.id,
      clientSecret,
      status: subscription.status,
      requiresPayment: !entitled,
    };
  });
}

export async function createPaymentMethodSetup(input: {
  workspaceId: string;
  workspaceName: string;
  user: AuthenticatedUser;
}): Promise<{ setupIntentId: string; clientSecret: string }> {
  const configuration = getStripeConfiguration();
  const customer = await ensureStripeCustomer(input);
  const intent = await getStripe().setupIntents.create({
    customer: customer.id,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: {
      [WORKSPACE_METADATA_KEY]: input.workspaceId,
      [ACCOUNT_METADATA_KEY]: configuration.STRIPE_ACCOUNT_KEY,
    },
  });
  if (!intent.client_secret) {
    throw new BillingError(
      "STRIPE_STATE_UNAVAILABLE",
      "Stripe did not return a payment setup secret.",
      502,
    );
  }
  return { setupIntentId: intent.id, clientSecret: intent.client_secret };
}

export async function completePaymentMethodSetup(input: {
  workspaceId: string;
  setupIntentId: string;
}): Promise<BillingSnapshot> {
  if (!/^seti_[A-Za-z0-9_]+$/.test(input.setupIntentId)) {
    throw new BillingError("INVALID_BILLING_REQUEST", "Invalid payment setup identifier.");
  }
  const account = await getOrCreateBillingAccount(input.workspaceId);
  if (!account.stripeCustomerId) {
    throw new BillingError(
      "STRIPE_STATE_UNAVAILABLE",
      "This workspace has no Stripe customer.",
      409,
    );
  }

  const stripe = getStripe();
  const intent = await stripe.setupIntents.retrieve(input.setupIntentId);
  const customerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
  const paymentMethodId =
    typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
  if (customerId !== account.stripeCustomerId) {
    throw new BillingError(
      "STRIPE_RESOURCE_MISMATCH",
      "The payment setup does not belong to this workspace.",
      403,
    );
  }
  const configuration = getStripeConfiguration();
  if (
    !stripeMetadataMatchesWorkspace(intent.metadata, {
      workspaceId: input.workspaceId,
      accountKey: configuration.STRIPE_ACCOUNT_KEY,
    })
  ) {
    throw new BillingError(
      "STRIPE_RESOURCE_MISMATCH",
      "The payment setup was not created for this workspace.",
      403,
    );
  }
  if (intent.status !== "succeeded" || !paymentMethodId) {
    throw new BillingError(
      "BILLING_STATE_CONFLICT",
      "Payment details have not finished saving yet.",
      409,
    );
  }

  await setDefaultPaymentMethod(
    input.workspaceId,
    account.stripeCustomerId,
    paymentMethodId,
    account.stripeSubscriptionId,
  );
  return reconcileWorkspaceBilling(input.workspaceId);
}

async function setDefaultPaymentMethod(
  workspaceId: string,
  customerId: string,
  paymentMethodId: string,
  subscriptionId: string | null,
): Promise<void> {
  const stripe = getStripe();
  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  const paymentCustomerId =
    typeof paymentMethod.customer === "string"
      ? paymentMethod.customer
      : paymentMethod.customer?.id;
  if (paymentCustomerId !== customerId) {
    throw new BillingError(
      "STRIPE_RESOURCE_MISMATCH",
      "The payment method does not belong to this Stripe customer.",
      403,
    );
  }

  let subscription: Stripe.Subscription | null = null;
  if (subscriptionId) {
    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (error) {
      if (!stripeResourceMissing(error)) throw error;
    }
    if (subscription) {
      const configuration = getStripeConfiguration();
      const subscriptionCustomerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id;
      if (
        subscriptionCustomerId !== customerId ||
        !subscriptionBelongsToProduct(subscription, configuration, workspaceId)
      ) {
        throw new BillingError(
          "STRIPE_RESOURCE_MISMATCH",
          "The Stripe subscription does not belong to this workspace.",
          403,
        );
      }
    }
  }

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  if (subscription) {
    try {
      await stripe.subscriptions.update(subscription.id, {
        default_payment_method: paymentMethodId,
      });
    } catch (error) {
      if (!stripeResourceMissing(error)) throw error;
    }
  }
}

export async function setSubscriptionCancellation(input: {
  workspaceId: string;
  cancelAtPeriodEnd: boolean;
}): Promise<BillingSnapshot> {
  const account = await getOrCreateBillingAccount(input.workspaceId);
  if (!account.stripeSubscriptionId || !account.stripeCustomerId) {
    throw new BillingError(
      "BILLING_STATE_CONFLICT",
      "This workspace has no PRO subscription.",
      409,
    );
  }

  const configuration = getStripeConfiguration();
  const subscription = await getStripe().subscriptions.retrieve(account.stripeSubscriptionId);
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  if (
    customerId !== account.stripeCustomerId ||
    !subscriptionBelongsToProduct(subscription, configuration, input.workspaceId)
  ) {
    throw new BillingError(
      "STRIPE_RESOURCE_MISMATCH",
      "The Stripe subscription does not belong to this workspace.",
      403,
    );
  }
  if (["canceled", "incomplete_expired"].includes(subscription.status)) {
    throw new BillingError(
      "BILLING_STATE_CONFLICT",
      "This subscription has already ended. Start a new PRO subscription instead.",
      409,
    );
  }

  await getStripe().subscriptions.update(subscription.id, {
    cancel_at_period_end: input.cancelAtPeriodEnd,
  });
  return reconcileWorkspaceBilling(input.workspaceId);
}

function unixDate(value: number | null | undefined): Date | null {
  return typeof value === "number" ? new Date(value * 1_000) : null;
}

async function resolveDefaultPaymentMethod(
  customer: Stripe.Customer,
  subscription: Stripe.Subscription | null,
): Promise<Stripe.PaymentMethod | null> {
  const candidate =
    subscription?.default_payment_method ?? customer.invoice_settings.default_payment_method;
  if (!candidate) return null;
  if (typeof candidate !== "string") return candidate;
  try {
    return await getStripe().paymentMethods.retrieve(candidate);
  } catch (error) {
    if (stripeResourceMissing(error)) return null;
    throw error;
  }
}

function paymentSummary(paymentMethod: Stripe.PaymentMethod | null): {
  brand: string | null;
  last4: string | null;
} {
  if (!paymentMethod) return { brand: null, last4: null };
  if (paymentMethod.card) {
    return {
      brand: paymentMethod.card.brand.replace(/_/g, " "),
      last4: paymentMethod.card.last4,
    };
  }
  if (paymentMethod.us_bank_account) {
    return {
      brand: paymentMethod.us_bank_account.bank_name ?? "Bank account",
      last4: paymentMethod.us_bank_account.last4,
    };
  }
  return { brand: paymentMethod.type.replace(/_/g, " "), last4: null };
}

async function buildSnapshotFromStripe(
  workspaceId: string,
  customer: Stripe.Customer,
  subscription: Stripe.Subscription | null,
): Promise<BillingSnapshot> {
  const entitled = subscription ? isProEntitled(subscription.status) : false;
  const plan: BillingPlan = entitled ? "PRO" : "FREE";
  const aiBudgetUsd =
    plan === "PRO"
      ? getPlanDefinition("PRO").aiBudgetUsd
      : await getWorkspaceFreeTrialBudgetUsd(workspaceId);
  const lookupKey = getStripeConfiguration().STRIPE_PRO_LOOKUP_KEY;
  const item =
    subscription?.items.data.find((candidate) => candidate.price.lookup_key === lookupKey) ??
    subscription?.items.data[0] ??
    null;
  const paymentMethod = await resolveDefaultPaymentMethod(customer, subscription);
  const payment = paymentSummary(paymentMethod);

  return {
    workspaceId,
    plan,
    subscriptionStatus: subscription?.status ?? "NONE",
    stripeCustomerId: customer.id,
    stripeSubscriptionId: subscription?.id ?? null,
    stripePriceId: item?.price.id ?? null,
    currency: item?.price.currency ?? null,
    unitAmount: item?.price.unit_amount ?? null,
    currentPeriodStart: unixDate(item?.current_period_start),
    currentPeriodEnd: unixDate(item?.current_period_end),
    cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
    paymentMethodBrand: payment.brand,
    paymentMethodLast4: payment.last4,
    aiBudgetUsd,
    reconciledAt: new Date(),
  };
}

type BillingWriter = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function persistBillingSnapshot(
  writer: BillingWriter,
  snapshot: BillingSnapshot,
): Promise<void> {
  await writer
    .insert(billingAccounts)
    .values(snapshot)
    .onConflictDoUpdate({
      target: billingAccounts.workspaceId,
      set: {
        plan: snapshot.plan,
        subscriptionStatus: snapshot.subscriptionStatus,
        stripeCustomerId: snapshot.stripeCustomerId,
        stripeSubscriptionId: snapshot.stripeSubscriptionId,
        stripePriceId: snapshot.stripePriceId,
        currency: snapshot.currency,
        unitAmount: snapshot.unitAmount,
        currentPeriodStart: snapshot.currentPeriodStart,
        currentPeriodEnd: snapshot.currentPeriodEnd,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        paymentMethodBrand: snapshot.paymentMethodBrand,
        paymentMethodLast4: snapshot.paymentMethodLast4,
        aiBudgetUsd: snapshot.aiBudgetUsd,
        reconciledAt: snapshot.reconciledAt,
        updatedAt: new Date(),
      },
    });
  await enforceWorkspaceRepositoryEntitlements(writer, {
    workspaceId: snapshot.workspaceId,
    plan: snapshot.plan,
  });
}

export async function buildWorkspaceBillingSnapshot(workspaceId: string): Promise<BillingSnapshot> {
  const configuration = getStripeConfiguration();
  const account = await getOrCreateBillingAccount(workspaceId);
  if (!account.stripeCustomerId) {
    const freeBudgetUsd = await getWorkspaceFreeTrialBudgetUsd(workspaceId);
    return {
      workspaceId,
      plan: "FREE",
      subscriptionStatus: "NONE",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripePriceId: null,
      currency: null,
      unitAmount: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      paymentMethodBrand: null,
      paymentMethodLast4: null,
      aiBudgetUsd: freeBudgetUsd,
      reconciledAt: new Date(),
    };
  }

  let customer: Stripe.Customer;
  try {
    const stripeCustomer = await getStripe().customers.retrieve(account.stripeCustomerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    if (stripeCustomer.deleted) throw new Error("deleted");
    customer = stripeCustomer;
  } catch (error) {
    if (!stripeResourceMissing(error) && !(error instanceof Error && error.message === "deleted")) {
      throw error;
    }
    const freeBudgetUsd = await getWorkspaceFreeTrialBudgetUsd(workspaceId);
    return {
      workspaceId,
      plan: "FREE",
      subscriptionStatus: "NONE",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripePriceId: null,
      currency: null,
      unitAmount: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      paymentMethodBrand: null,
      paymentMethodLast4: null,
      aiBudgetUsd: freeBudgetUsd,
      reconciledAt: new Date(),
    };
  }

  if (!customerMatchesWorkspace(customer, workspaceId, configuration)) {
    throw new BillingError(
      "STRIPE_RESOURCE_MISMATCH",
      "The stored Stripe customer does not belong to this workspace.",
      409,
    );
  }
  const subscriptions = await listTargetSubscriptions(customer.id, workspaceId);
  return buildSnapshotFromStripe(workspaceId, customer, subscriptions[0] ?? null);
}

export async function reconcileWorkspaceBilling(workspaceId: string): Promise<BillingSnapshot> {
  const snapshot = await buildWorkspaceBillingSnapshot(workspaceId);
  await db.transaction(async (transaction) => persistBillingSnapshot(transaction, snapshot));
  return snapshot;
}

export async function reconcilePaidBillingIfStale(workspaceId: string): Promise<void> {
  const account = await getOrCreateBillingAccount(workspaceId);
  if (normalizeBillingPlan(account.plan) !== "PRO") return;
  if (
    !account.reconciledAt ||
    Date.now() - account.reconciledAt.getTime() >= RECONCILIATION_MAX_AGE_MS
  ) {
    await reconcileWorkspaceBilling(workspaceId);
  }
}

export async function listInvoices(workspaceId: string): Promise<BillingInvoice[]> {
  const account = await getOrCreateBillingAccount(workspaceId);
  if (!account.stripeCustomerId) return [];
  const invoices = await getStripe().invoices.list({
    customer: account.stripeCustomerId,
    limit: 12,
  });
  return invoices.data.map((invoice) => ({
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    amountPaid: invoice.amount_paid,
    amountDue: invoice.amount_due,
    currency: invoice.currency,
    createdAt: new Date(invoice.created * 1_000).toISOString(),
    invoicePdfUrl: invoice.invoice_pdf ?? null,
  }));
}

function accountView(
  account: Awaited<ReturnType<typeof getOrCreateBillingAccount>>,
): BillingAccountView {
  const plan = normalizeBillingPlan(account.plan);
  const definition = getPlanDefinition(plan);
  return {
    plan,
    planName: definition.name,
    subscriptionStatus: account.subscriptionStatus,
    monthlyPrice: plan === "PRO" ? account.unitAmount : null,
    currency: plan === "PRO" ? account.currency : null,
    currentPeriodStart: account.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: account.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: account.cancelAtPeriodEnd,
    paymentMethod:
      account.paymentMethodBrand && account.paymentMethodLast4
        ? { brand: account.paymentMethodBrand, last4: account.paymentMethodLast4 }
        : null,
    repositoryLimit: definition.repositoryLimit,
  };
}

export async function getBillingPageData(
  workspaceId: string,
  options: { forceReconcile?: boolean } = {},
): Promise<BillingPageData> {
  const configurationState = getStripeConfigurationState();
  let account = await getOrCreateBillingAccount(workspaceId);
  let syncWarning: string | null = null;

  if (configurationState.configured && account.stripeCustomerId) {
    const stale =
      !account.reconciledAt ||
      Date.now() - account.reconciledAt.getTime() >= RECONCILIATION_MAX_AGE_MS;
    if (options.forceReconcile || stale) {
      try {
        await reconcileWorkspaceBilling(workspaceId);
        account = await getOrCreateBillingAccount(workspaceId);
      } catch (error) {
        logger.warn("billing.reconciliation_failed", {
          workspaceId,
          errorCode: error instanceof BillingError ? error.code : "STRIPE_ERROR",
        });
        syncWarning =
          "Stripe could not be reached, so this page is showing the last synchronized billing state.";
      }
    }
  }

  let proPrice: BillingPageData["proPrice"] = null;
  let invoices: BillingInvoice[] = [];
  if (configurationState.configured) {
    try {
      const [price, invoiceRows] = await Promise.all([
        resolveProPrice(),
        account.stripeCustomerId ? listInvoices(workspaceId) : Promise.resolve([]),
      ]);
      proPrice = price.recurring
        ? {
            amount: price.unit_amount ?? 0,
            currency: price.currency,
            interval: price.recurring.interval,
            intervalCount: price.recurring.interval_count,
          }
        : null;
      invoices = invoiceRows;
    } catch (error) {
      syncWarning ??=
        error instanceof BillingConfigurationError
          ? error.message
          : "Stripe details are temporarily unavailable. Your saved plan is still shown below.";
    }
  }

  return {
    configured: configurationState.configured,
    publishableKey: configurationState.publishableKey,
    configurationMessage: configurationState.configured ? null : configurationState.message,
    syncWarning,
    account: accountView(account),
    proPrice,
    invoices,
  };
}

function metadataFromEventObject(object: Stripe.Event.Data.Object): Stripe.Metadata | null {
  if ("metadata" in object && object.metadata && typeof object.metadata === "object") {
    return object.metadata as Stripe.Metadata;
  }
  return null;
}

function stringCustomerId(object: Stripe.Event.Data.Object): string | null {
  if (!("customer" in object)) return null;
  const customer = object.customer;
  if (typeof customer === "string") return customer;
  if (customer && typeof customer === "object" && "id" in customer) return String(customer.id);
  return null;
}

export async function workspaceIdForStripeEvent(event: Stripe.Event): Promise<string | null> {
  const configuration = getStripeConfiguration();
  const object = event.data.object;
  const metadata = metadataFromEventObject(object);
  const customerId =
    event.type === "customer.deleted" && "id" in object
      ? String(object.id)
      : stringCustomerId(object);
  const objectId = "id" in object ? String(object.id) : null;
  const objectKind = "object" in object ? String(object.object) : null;
  const [account] = await db
    .select({ workspaceId: billingAccounts.workspaceId })
    .from(billingAccounts)
    .where(
      customerId
        ? eq(billingAccounts.stripeCustomerId, customerId)
        : objectId && objectKind === "customer"
          ? eq(billingAccounts.stripeCustomerId, objectId)
          : objectId && objectKind === "subscription"
            ? eq(billingAccounts.stripeSubscriptionId, objectId)
            : eq(billingAccounts.workspaceId, "00000000-0000-0000-0000-000000000000"),
    )
    .limit(1);
  if (account) return account.workspaceId;

  const metadataWorkspaceId = metadata?.[WORKSPACE_METADATA_KEY];
  if (
    metadata?.[ACCOUNT_METADATA_KEY] === configuration.STRIPE_ACCOUNT_KEY &&
    metadataWorkspaceId &&
    UUID_PATTERN.test(metadataWorkspaceId)
  ) {
    const [metadataAccount] = await db
      .select({ workspaceId: billingAccounts.workspaceId })
      .from(billingAccounts)
      .where(eq(billingAccounts.workspaceId, metadataWorkspaceId))
      .limit(1);
    return metadataAccount?.workspaceId ?? null;
  }
  return null;
}

async function prepareStripeEvent(event: Stripe.Event): Promise<{
  workspaceId: string | null;
  snapshot: BillingSnapshot | null;
}> {
  const workspaceId = await workspaceIdForStripeEvent(event);
  if (!workspaceId) return { workspaceId: null, snapshot: null };

  if (event.type === "setup_intent.succeeded") {
    const intent = event.data.object;
    const customerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
    const paymentMethodId =
      typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
    const account = await getOrCreateBillingAccount(workspaceId);
    const configuration = getStripeConfiguration();
    if (
      customerId &&
      paymentMethodId &&
      customerId === account.stripeCustomerId &&
      stripeMetadataMatchesWorkspace(intent.metadata, {
        workspaceId,
        accountKey: configuration.STRIPE_ACCOUNT_KEY,
      })
    ) {
      await setDefaultPaymentMethod(
        workspaceId,
        customerId,
        paymentMethodId,
        account.stripeSubscriptionId,
      );
    }
  }

  return { workspaceId, snapshot: await buildWorkspaceBillingSnapshot(workspaceId) };
}

/** Verifies, de-duplicates, and reconciles a Stripe webhook delivery. */
export async function processStripeWebhook(
  rawBody: string,
  signature: string,
): Promise<{
  duplicate: boolean;
  eventType: string;
}> {
  const configuration = getStripeConfiguration();
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      configuration.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    throw new BillingError("INVALID_BILLING_REQUEST", "Invalid Stripe webhook signature.", 400);
  }

  let prepared: Awaited<ReturnType<typeof prepareStripeEvent>> = {
    workspaceId: null,
    snapshot: null,
  };
  const duplicate = await db.transaction(async (transaction) => {
    const inserted = await transaction
      .insert(webhookDeliveries)
      .values({ id: event.id, provider: "STRIPE", eventType: event.type })
      .onConflictDoNothing({ target: webhookDeliveries.id })
      .returning({ id: webhookDeliveries.id });
    if (inserted.length === 0) return true;
    // Keep the delivery marker and normalized billing snapshot in the same
    // transaction. A failed reconciliation rolls the marker back, allowing
    // Stripe's retry to safely process the event again. Concurrent duplicates
    // wait on the unique event ID and do no Stripe-side work after losing it.
    prepared = await prepareStripeEvent(event);
    if (prepared.snapshot) await persistBillingSnapshot(transaction, prepared.snapshot);
    return false;
  });

  logger.info("stripe.webhook_processed", {
    workspaceId: prepared.workspaceId ?? undefined,
    eventType: event.type,
    duplicate,
  });
  return { duplicate, eventType: event.type };
}
