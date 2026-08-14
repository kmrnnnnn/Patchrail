import Link from "next/link";
import { ArrowUpRight, Bot, Coins, Search, TimerReset } from "lucide-react";
import { Card, CardContent, CardHeader, StatusBadge } from "@/components/ui";
import { formatUsd } from "@/lib/format";
import type { UsageSummary } from "@/billing/types";
import styles from "./billing.module.css";

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 100_000 ? "compact" : "standard",
  }).format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function UsagePanel({ summary }: { summary: UsageSummary }) {
  const budget = Number(summary.budgetUsd);
  const committed = Number(summary.spentUsd) + Number(summary.reservedUsd);
  const percentage = budget > 0 ? Math.min(100, (committed / budget) * 100) : 0;

  return (
    <div className={styles.stack}>
      <Card className={styles.usageHero}>
        <CardHeader
          title="AI budget"
          description={
            summary.periodEnd
              ? `${formatDate(summary.periodStart)} – ${formatDate(summary.periodEnd)}`
              : "One-time FREE trial allowance"
          }
          action={
            <StatusBadge tone={summary.plan === "PRO" ? "accent" : "neutral"}>
              {summary.plan}
            </StatusBadge>
          }
        />
        <CardContent>
          <div className={styles.budgetHeadline}>
            <div>
              <strong>{formatUsd(summary.remainingUsd)}</strong>
              <span>remaining of {formatUsd(summary.budgetUsd)}</span>
            </div>
            <span>{Math.round(percentage)}% committed</span>
          </div>
          <div
            aria-label={`${Math.round(percentage)} percent of AI budget committed`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(percentage)}
            className={styles.meter}
            role="progressbar"
          >
            <span style={{ width: `${percentage}%` }} />
          </div>
          <dl className={styles.usageStats}>
            <div>
              <dt>
                <Coins aria-hidden="true" size={17} /> Spent
              </dt>
              <dd>{formatUsd(summary.spentUsd)}</dd>
            </div>
            <div>
              <dt>
                <TimerReset aria-hidden="true" size={17} /> In active runs
              </dt>
              <dd>{formatUsd(summary.reservedUsd)}</dd>
            </div>
            <div>
              <dt>
                <Bot aria-hidden="true" size={17} /> Model calls
              </dt>
              <dd>{formatCount(summary.modelCalls)}</dd>
            </div>
            <div>
              <dt>
                <Search aria-hidden="true" size={17} /> Web research calls
              </dt>
              <dd>{formatCount(summary.webSearchCalls)}</dd>
            </div>
            <div>
              <dt>Input tokens</dt>
              <dd>{formatCount(summary.inputTokens)}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{formatCount(summary.outputTokens)}</dd>
            </div>
            <div>
              <dt>Cached input tokens</dt>
              <dd>{formatCount(summary.cachedInputTokens)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Runs this period"
          description={`${summary.runs} ${summary.runs === 1 ? "run" : "runs"} · ${formatCount(summary.inputTokens + summary.outputTokens)} model tokens`}
        />
        <CardContent>
          {summary.recentRuns.length === 0 ? (
            <p className={styles.emptyUsage}>
              No AI usage yet. Costs appear here after you start a run.
            </p>
          ) : (
            <div className={styles.runList}>
              {summary.recentRuns.map((run) => (
                <Link className={styles.runRow} href={`/app/runs/${run.id}`} key={run.id}>
                  <div>
                    <strong>{run.repositoryName}</strong>
                    <span>
                      {formatDate(run.createdAt)} · {run.status.replace(/_/g, " ").toLowerCase()}
                    </span>
                  </div>
                  <span>{run.modelCalls} model calls</span>
                  <span>{formatCount(run.inputTokens + run.outputTokens)} tokens</span>
                  <strong>{formatUsd(run.actualCostUsd)}</strong>
                  <ArrowUpRight aria-hidden="true" size={16} />
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
