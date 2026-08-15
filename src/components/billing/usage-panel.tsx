import Link from "next/link";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  FileCode2,
  GitPullRequestDraft,
  Search,
} from "lucide-react";
import { Card, CardContent, CardHeader, StatusBadge } from "@/components/ui";
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
  const planName = summary.plan === "PRO" ? "Pro" : "Free";
  return (
    <div className={styles.stack}>
      <Card className={styles.usageHero}>
        <CardHeader
          title="Patchrail usage"
          description={
            summary.periodEnd
              ? `${formatDate(summary.periodStart)} – ${formatDate(summary.periodEnd)}`
              : "Free trial allowance"
          }
          action={
            <StatusBadge tone={summary.plan === "PRO" ? "accent" : "neutral"}>
              {planName}
            </StatusBadge>
          }
        />
        <CardContent>
          <div className={styles.budgetHeadline}>
            <div>
              <strong>{formatCount(summary.runs)}</strong>
              <span>{summary.runs === 1 ? "repository update" : "repository updates"}</span>
            </div>
            <span>Included with your {planName} plan</span>
          </div>
          <dl className={styles.usageStats}>
            <div>
              <dt>
                <CheckCircle2 aria-hidden="true" size={17} /> Completed
              </dt>
              <dd>{formatCount(summary.completedRuns)}</dd>
            </div>
            <div>
              <dt>
                <CircleDot aria-hidden="true" size={17} /> Active
              </dt>
              <dd>{formatCount(summary.activeRuns)}</dd>
            </div>
            <div>
              <dt>
                <Search aria-hidden="true" size={17} /> APIs found
              </dt>
              <dd>{formatCount(summary.apisFound)}</dd>
            </div>
            <div>
              <dt>
                <FileCode2 aria-hidden="true" size={17} /> Files changed
              </dt>
              <dd>{formatCount(summary.filesChanged)}</dd>
            </div>
            <div>
              <dt>
                <GitPullRequestDraft aria-hidden="true" size={17} /> Draft PRs
              </dt>
              <dd>{formatCount(summary.draftPrs)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="Runs this period"
          description={`${summary.runs} ${summary.runs === 1 ? "repository update" : "repository updates"}`}
        />
        <CardContent>
          {summary.recentRuns.length === 0 ? (
            <p className={styles.emptyUsage}>
              No repository updates yet. Activity appears here after you start a run.
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
                  <span>{run.apisFound} APIs found</span>
                  <span>{run.filesChanged} files changed</span>
                  <strong>
                    {run.hasDraftPr
                      ? "Draft PR"
                      : run.status === "SUCCEEDED"
                        ? "No PR needed"
                        : run.status === "FAILED"
                          ? "Stopped"
                          : "In progress"}
                  </strong>
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
