"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import {
  CalendarClock,
  Check,
  CreditCard,
  FileText,
  Gauge,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, CardContent, CardHeader, StatusBadge } from "@/components/ui";
import type { BillingPageData } from "@/billing/types";
import styles from "./billing.module.css";

type PaymentFlow = "subscription" | "setup";

type ApiError = { error?: string };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as T & ApiError;
  if (!response.ok) throw new Error(payload.error ?? "Billing request failed.");
  return payload;
}

function currencyFromMinorUnits(amount: number, currency: string): string {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amount / 10 ** digits);
}

function formatBillingDate(value: string | null): string {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function statusTone(status: string): "positive" | "warning" | "critical" | "neutral" {
  if (status === "active" || status === "trialing") return "positive";
  if (status === "past_due" || status === "incomplete") return "warning";
  if (status === "unpaid" || status === "canceled" || status === "incomplete_expired") {
    return "critical";
  }
  return "neutral";
}

function PaymentForm({
  flow,
  returnUrl,
  onComplete,
}: {
  flow: PaymentFlow;
  returnUrl: string;
  onComplete: () => Promise<void>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setMessage(null);

    try {
      const submitResult = await elements.submit();
      if (submitResult.error) throw new Error(submitResult.error.message);

      if (flow === "subscription") {
        const result = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: returnUrl },
          redirect: "if_required",
        });
        if (result.error)
          throw new Error(result.error.message ?? "Payment could not be confirmed.");
      } else {
        const result = await stripe.confirmSetup({
          elements,
          confirmParams: { return_url: returnUrl },
          redirect: "if_required",
        });
        if (result.error) {
          throw new Error(result.error.message ?? "Payment details could not be saved.");
        }
        if (!result.setupIntent?.id) throw new Error("Stripe did not return the payment setup.");
        await requestJson("/api/stripe/setup-intent/complete", {
          method: "POST",
          body: JSON.stringify({ setupIntentId: result.setupIntent.id }),
        });
      }

      await onComplete();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Payment could not be completed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.paymentForm} onSubmit={submit}>
      <PaymentElement options={{ layout: "tabs" }} />
      {message ? (
        <p className={styles.formError} role="alert">
          {message}
        </p>
      ) : null}
      <Button disabled={!stripe || !elements} loading={submitting} type="submit">
        {flow === "subscription" ? "Start PRO subscription" : "Save payment method"}
      </Button>
      <p className={styles.terms}>
        {flow === "subscription"
          ? "By subscribing, you authorize the monthly price shown above to be charged until you cancel."
          : "By saving, you authorize this method for future Patchrail subscription renewals."}{" "}
        Stripe securely handles payment details; Patchrail never receives your card number or CVC.
      </p>
    </form>
  );
}

export function BillingPanel({ initialData }: { initialData: BillingPageData }) {
  const [data, setData] = useState(initialData);
  const [flow, setFlow] = useState<PaymentFlow | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "critical"; text: string } | null>(null);
  const stripePromise = useMemo(
    () => (data.publishableKey ? loadStripe(data.publishableKey) : null),
    [data.publishableKey],
  );
  const handledReturn = useRef(false);

  useEffect(() => {
    if (handledReturn.current) return;
    const parameters = new URLSearchParams(window.location.search);
    if (parameters.get("billing") !== "complete") return;
    handledReturn.current = true;

    async function reconcileReturn() {
      setBusyAction("return");
      try {
        const setupIntentId = parameters.get("setup_intent");
        if (setupIntentId) {
          await requestJson("/api/stripe/setup-intent/complete", {
            method: "POST",
            body: JSON.stringify({ setupIntentId }),
          });
        }
        const refreshed = await requestJson<BillingPageData>("/api/stripe/billing", {
          method: "POST",
        });
        setData(refreshed);
        setNotice({ tone: "success", text: "Stripe confirmed your billing update." });
        window.history.replaceState({}, "", window.location.pathname);
      } catch (error) {
        setNotice({
          tone: "critical",
          text:
            error instanceof Error
              ? error.message
              : "Stripe returned successfully, but billing could not be synchronized.",
        });
      } finally {
        setBusyAction(null);
      }
    }

    void reconcileReturn();
  }, []);

  async function refresh() {
    const refreshed = await requestJson<BillingPageData>("/api/stripe/billing", { method: "POST" });
    setData(refreshed);
    setFlow(null);
    setClientSecret(null);
    setNotice({ tone: "success", text: "Billing details are up to date." });
  }

  async function beginSubscription() {
    setBusyAction("upgrade");
    setNotice(null);
    try {
      const result = await requestJson<{
        clientSecret: string | null;
        status: string;
        requiresPayment: boolean;
      }>("/api/stripe/subscription", { method: "POST", body: "{}" });
      if (result.clientSecret) {
        setFlow("subscription");
        setClientSecret(result.clientSecret);
      } else {
        await refresh();
      }
    } catch (error) {
      setNotice({
        tone: "critical",
        text: error instanceof Error ? error.message : "Upgrade failed.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function beginPaymentUpdate() {
    setBusyAction("payment");
    setNotice(null);
    try {
      const result = await requestJson<{ clientSecret: string }>("/api/stripe/setup-intent", {
        method: "POST",
        body: "{}",
      });
      setFlow("setup");
      setClientSecret(result.clientSecret);
    } catch (error) {
      setNotice({
        tone: "critical",
        text: error instanceof Error ? error.message : "Payment setup failed.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function updateCancellation(cancelAtPeriodEnd: boolean) {
    setBusyAction(cancelAtPeriodEnd ? "cancel" : "resume");
    setNotice(null);
    try {
      await requestJson(
        cancelAtPeriodEnd ? "/api/stripe/subscription/cancel" : "/api/stripe/subscription/resume",
        { method: "POST", body: "{}" },
      );
      await refresh();
      setNotice({
        tone: "success",
        text: cancelAtPeriodEnd
          ? "Your subscription will end after the current billing period."
          : "Your PRO subscription will renew as usual.",
      });
    } catch (error) {
      setNotice({
        tone: "critical",
        text: error instanceof Error ? error.message : "Subscription could not be updated.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  const { account, proPrice } = data;
  const proPriceLabel = proPrice
    ? currencyFromMinorUnits(proPrice.amount, proPrice.currency)
    : "PRO pricing unavailable";

  return (
    <div className={styles.stack}>
      {!data.configured ? (
        <Alert tone="warning" title="Billing setup is incomplete">
          {data.configurationMessage}
        </Alert>
      ) : null}
      {data.syncWarning ? (
        <Alert tone="warning" title="Showing saved billing details">
          {data.syncWarning}
        </Alert>
      ) : null}
      {notice ? <Alert tone={notice.tone} title={notice.text} /> : null}

      <section className={styles.planGrid} aria-label="Subscription plan">
        <Card className={styles.currentPlan}>
          <CardHeader
            title="Current plan"
            description="Workspace limits and AI allowance"
            action={
              <StatusBadge dot tone={account.plan === "PRO" ? "accent" : "neutral"}>
                {account.planName}
              </StatusBadge>
            }
          />
          <CardContent className={styles.planContent}>
            <div>
              <p className={styles.price}>
                {account.monthlyPrice !== null && account.currency
                  ? currencyFromMinorUnits(account.monthlyPrice, account.currency)
                  : "$0"}
                <span>/ month</span>
              </p>
              <StatusBadge tone={statusTone(account.subscriptionStatus)}>
                {account.subscriptionStatus === "NONE"
                  ? "No paid subscription"
                  : account.subscriptionStatus.replace(/_/g, " ")}
              </StatusBadge>
            </div>
            <dl className={styles.limitList}>
              <div>
                <dt>
                  <Gauge aria-hidden="true" size={17} /> AI budget
                </dt>
                <dd>${Number(account.aiBudgetUsd).toFixed(2)} / period</dd>
              </div>
              <div>
                <dt>
                  <ShieldCheck aria-hidden="true" size={17} /> Repositories
                </dt>
                <dd>Up to {account.repositoryLimit}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {account.plan === "FREE" ? (
          <Card className={styles.proCard}>
            <CardHeader
              title="Patchrail PRO"
              description="For teams maintaining production API integrations"
              action={<Sparkles aria-hidden="true" size={20} />}
            />
            <CardContent className={styles.proContent}>
              <p className={styles.price}>
                {proPriceLabel}
                {proPrice ? <span>/ {proPrice.interval}</span> : null}
              </p>
              <ul className={styles.features}>
                <li>
                  <Check aria-hidden="true" size={16} /> Larger monthly AI budget
                </li>
                <li>
                  <Check aria-hidden="true" size={16} /> More enabled repositories
                </li>
                <li>
                  <Check aria-hidden="true" size={16} /> Same tested Draft PR workflow
                </li>
              </ul>
              <Button
                disabled={!data.configured || !proPrice}
                loading={busyAction === "upgrade"}
                onClick={beginSubscription}
              >
                Upgrade with Stripe
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader title="Renewal" description="Your PRO subscription schedule" />
            <CardContent className={styles.renewalContent}>
              <CalendarClock aria-hidden="true" size={22} />
              <div>
                <strong>
                  {account.cancelAtPeriodEnd ? "Access ends" : "Next renewal"}{" "}
                  {formatBillingDate(account.currentPeriodEnd)}
                </strong>
                <p>
                  {account.cancelAtPeriodEnd
                    ? "PRO remains active until then. You can undo cancellation at any time before it ends."
                    : "Your saved payment method will be charged automatically."}
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      {flow && clientSecret && stripePromise ? (
        <Card className={styles.paymentCard}>
          <CardHeader
            title={flow === "subscription" ? "Complete your PRO upgrade" : "Update payment method"}
            description={
              flow === "subscription"
                ? `Subscribe for ${proPriceLabel} per month. Your plan updates after Stripe confirms payment.`
                : "This payment method will be used for future subscription renewals. No charge is made now."
            }
            action={
              <Button
                onClick={() => {
                  setFlow(null);
                  setClientSecret(null);
                }}
                size="sm"
                variant="ghost"
              >
                Close
              </Button>
            }
          />
          <CardContent>
            <Elements
              key={clientSecret}
              options={{
                clientSecret,
                appearance: {
                  theme: "stripe",
                  variables: {
                    colorPrimary: "#c97543",
                    colorText: "#121416",
                    colorBackground: "#fffefa",
                    colorDanger: "#a13f3c",
                    borderRadius: "7px",
                    fontFamily: "Instrument Sans, Aptos, Segoe UI, Helvetica, Arial, sans-serif",
                  },
                },
              }}
              stripe={stripePromise}
            >
              <PaymentForm
                flow={flow}
                onComplete={refresh}
                returnUrl={`${window.location.origin}/app/settings/billing?billing=complete`}
              />
            </Elements>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Payment method" description="Used for subscription renewals" />
        <CardContent className={styles.paymentRow}>
          <div className={styles.paymentIdentity}>
            <span className={styles.iconTile}>
              <CreditCard aria-hidden="true" size={20} />
            </span>
            <div>
              <strong>
                {account.paymentMethod
                  ? `${account.paymentMethod.brand} •••• ${account.paymentMethod.last4}`
                  : "No payment method saved"}
              </strong>
              <p>Payment details are stored securely by Stripe.</p>
            </div>
          </div>
          <Button
            disabled={!data.configured}
            loading={busyAction === "payment"}
            onClick={beginPaymentUpdate}
            variant="outline"
          >
            {account.paymentMethod ? "Update payment method" : "Add payment method"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Invoices" description="Receipts for this workspace" />
        <CardContent>
          {data.invoices.length === 0 ? (
            <div className={styles.emptyInvoices}>
              <FileText aria-hidden="true" size={22} />
              <p>No invoices yet.</p>
            </div>
          ) : (
            <div className={styles.invoiceList}>
              {data.invoices.map((invoice) => (
                <div className={styles.invoiceRow} key={invoice.id}>
                  <div>
                    <strong>{invoice.number ?? "Invoice"}</strong>
                    <span>{formatBillingDate(invoice.createdAt)}</span>
                  </div>
                  <StatusBadge tone={invoice.status === "paid" ? "positive" : "neutral"}>
                    {invoice.status ?? "unknown"}
                  </StatusBadge>
                  <strong>{currencyFromMinorUnits(invoice.amountPaid, invoice.currency)}</strong>
                  {invoice.invoicePdfUrl ? (
                    <a href={invoice.invoicePdfUrl} rel="noopener noreferrer" target="_blank">
                      Download PDF
                    </a>
                  ) : (
                    <span>PDF unavailable</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {account.plan === "PRO" ? (
        <Card className={styles.cancelCard}>
          <CardHeader
            title={account.cancelAtPeriodEnd ? "Subscription cancellation scheduled" : "Cancel PRO"}
            description={
              account.cancelAtPeriodEnd
                ? `PRO access remains available through ${formatBillingDate(account.currentPeriodEnd)}.`
                : "Cancellation takes effect at the end of the current period. We do not cancel immediately."
            }
            action={
              account.cancelAtPeriodEnd ? (
                <Button
                  loading={busyAction === "resume"}
                  onClick={() => updateCancellation(false)}
                  variant="outline"
                >
                  Undo cancellation
                </Button>
              ) : (
                <Button
                  loading={busyAction === "cancel"}
                  onClick={() => updateCancellation(true)}
                  variant="danger"
                >
                  Cancel at period end
                </Button>
              )
            }
          />
        </Card>
      ) : null}
    </div>
  );
}
