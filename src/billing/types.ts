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
  apisFound: number;
  filesChanged: number;
  hasDraftPr: boolean;
};

export type UsageSummary = {
  plan: BillingPlan;
  periodStart: string;
  periodEnd: string | null;
  runs: number;
  completedRuns: number;
  activeRuns: number;
  apisFound: number;
  filesChanged: number;
  draftPrs: number;
  recentRuns: UsageRun[];
};
