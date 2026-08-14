export const BILLING_PLANS = ["FREE", "PRO"] as const;
export type BillingPlan = (typeof BILLING_PLANS)[number];

export type PlanDefinition = {
  id: BillingPlan;
  name: string;
  repositoryLimit: number;
  aiBudgetUsd: string;
  paid: boolean;
};

export type BillingInvoice = {
  id: string;
  number: string | null;
  status: string | null;
  amountPaid: number;
  amountDue: number;
  currency: string;
  createdAt: string;
  invoicePdfUrl: string | null;
};

export type BillingAccountView = {
  plan: BillingPlan;
  planName: string;
  subscriptionStatus: string;
  monthlyPrice: number | null;
  currency: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  paymentMethod: { brand: string; last4: string } | null;
  repositoryLimit: number;
  aiBudgetUsd: string;
  reconciledAt: string | null;
};

export type BillingPageData = {
  configured: boolean;
  publishableKey: string | null;
  configurationMessage: string | null;
  syncWarning: string | null;
  account: BillingAccountView;
  proPrice: {
    amount: number;
    currency: string;
    interval: string;
    intervalCount: number;
  } | null;
  invoices: BillingInvoice[];
};

export type UsageRun = {
  id: string;
  repositoryName: string;
  status: string;
  createdAt: string;
  actualCostUsd: string;
  estimatedCostUsd: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  webSearchCalls: number;
};

export type UsageSummary = {
  plan: BillingPlan;
  periodStart: string;
  periodEnd: string | null;
  budgetUsd: string;
  spentUsd: string;
  reservedUsd: string;
  remainingUsd: string;
  runs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  webSearchCalls: number;
  recentRuns: UsageRun[];
};
