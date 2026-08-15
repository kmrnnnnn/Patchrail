"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Circle,
  CircleDot,
  Clock3,
  FileCode2,
  GitPullRequestDraft,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Button, ButtonLink, Card, Field, StatusBadge, Textarea } from "@/components/ui";
import { formatRelativeDate, shortSha } from "@/lib/format";
import { isTerminalRunStatus } from "@/runs/types";

type RunDetail = {
  run: {
    id: string;
    status: string;
    stage: string;
    startingCommitSha: string | null;
    detectedApis: Array<{
      id: string;
      provider: string;
      product: string;
      status: string;
      conclusion: string;
      files: string[];
      confidence?: number;
    }>;
    research: Array<{
      apiId: string;
      url: string;
      title: string;
      summary: string;
      authoritative: boolean;
    }>;
    changedFiles: Array<{ path: string; operation: string; additions: number; deletions: number }>;
    verification: null | {
      status: string;
      integrityPassed: boolean;
      integrityFindings: string[];
      commands: Array<{
        command: string;
        exitCode: number | null;
        durationMs: number;
        timedOut: boolean;
        stdout?: string;
        stderr?: string;
      }>;
    };
    githubPrNumber: number | null;
    githubPrUrl: string | null;
    failure: { title: string; message: string } | null;
    inputQuestion: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  };
  repository: { id: string; fullName: string };
  events: Array<{
    id: number;
    stage: string;
    kind: string;
    message: string;
    createdAt: string;
  }>;
};

const stages = [
  { key: "READ", label: "Read repository", statuses: ["READING_REPOSITORY"] },
  {
    key: "RESEARCH",
    label: "Find & research APIs",
    statuses: ["FINDING_APIS", "RESEARCHING_APIS"],
  },
  {
    key: "UPDATE",
    label: "Update code",
    statuses: ["PLANNING_CHANGES", "UPDATING_CODE", "REPAIRING"],
  },
  { key: "VERIFY", label: "Verify", statuses: ["VERIFYING"] },
  { key: "PR", label: "Draft PR", statuses: ["CREATING_PR"] },
];

function statusTone(status: string) {
  if (["CURRENT", "SUCCEEDED", "PASSED"].includes(status)) return "positive" as const;
  if (
    ["MIGRATION_REQUIRED", "DEPRECATED_USAGE", "BREAKING_CHANGE_RELEVANT", "FAILED"].includes(
      status,
    )
  ) {
    return "critical" as const;
  }
  if (["UPDATE_AVAILABLE", "NEEDS_INPUT"].includes(status)) return "warning" as const;
  if (
    [
      "QUEUED",
      "READING_REPOSITORY",
      "FINDING_APIS",
      "RESEARCHING_APIS",
      "PLANNING_CHANGES",
      "UPDATING_CODE",
      "VERIFYING",
      "REPAIRING",
      "CREATING_PR",
    ].includes(status)
  ) {
    return "info" as const;
  }
  return "neutral" as const;
}

function stageIndexFor(status: string): number {
  return stages.findIndex((stage) => stage.statuses.includes(status));
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function titleForRun(detail: RunDetail): string {
  if (detail.run.status === "QUEUED") return "Run queued";
  if (detail.run.status === "FAILED") return "Run stopped";
  if (detail.run.status === "NEEDS_INPUT") return "Decision needed";
  if (detail.run.status === "SUCCEEDED" && detail.run.githubPrUrl) return "Draft PR ready";
  if (detail.run.status === "SUCCEEDED" && detail.run.detectedApis.length === 0)
    return "No external APIs found";
  if (detail.run.status === "SUCCEEDED") return "API integrations appear current";
  return "API update run";
}

const UPDATE_STATUSES = new Set([
  "MIGRATION_REQUIRED",
  "DEPRECATED_USAGE",
  "BREAKING_CHANGE_RELEVANT",
]);

function formatDuration(detail: RunDetail): string {
  if (!detail.run.completedAt) return detail.run.status === "QUEUED" ? "Queued" : "In progress";

  const durationMs = Math.max(
    0,
    new Date(detail.run.completedAt).getTime() -
      new Date(detail.run.startedAt ?? detail.run.createdAt).getTime(),
  );
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function verificationFact(detail: RunDetail): string {
  if (detail.run.verification?.status === "PASSED") return "Passed";
  if (detail.run.verification?.status === "FAILED") return "Failed";
  if (detail.run.verification?.status === "NO_COMMANDS") return "Not required";
  if (detail.run.status === "SUCCEEDED") return "Not required";
  if (detail.run.status === "FAILED") return "Not reached";
  return "Pending";
}

function draftPrFact(detail: RunDetail): string {
  if (detail.run.githubPrNumber) return `#${detail.run.githubPrNumber}`;
  if (detail.run.status === "SUCCEEDED") return "Not needed";
  if (detail.run.status === "FAILED") return "Not created";
  return "Pending";
}

export function RunProgress({ initial }: { initial: RunDetail }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [pollingProblem, setPollingProblem] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState<"answer" | "retry" | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/runs/${detail.run.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Run updates are temporarily unavailable.");
      setDetail((await response.json()) as RunDetail);
      setPollingProblem(null);
    } catch {
      setPollingProblem(
        "The last durable state is still shown below. Check your connection and try again.",
      );
    }
  }, [detail.run.id]);

  useEffect(() => {
    if (isTerminalRunStatus(detail.run.status)) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(poll, 3000);
    };
    timer = window.setTimeout(poll, 3000);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [detail.run.status, refresh]);

  const currentIndex = useMemo(() => {
    const direct = stageIndexFor(detail.run.status);
    if (direct >= 0) return direct;
    if (detail.run.status === "QUEUED") return -1;

    for (let index = detail.events.length - 1; index >= 0; index -= 1) {
      const event = detail.events[index];
      if (!event) continue;
      const eventIndex = stageIndexFor(event.stage);
      if (eventIndex >= 0) return eventIndex;
    }
    return -1;
  }, [detail.events, detail.run.status]);

  const completedWithoutChanges = detail.run.status === "SUCCEEDED" && !detail.run.githubPrUrl;
  const stageLabels = completedWithoutChanges
    ? [
        "Read repository",
        "Find & research APIs",
        "No code change",
        "Verification not required",
        "No PR needed",
      ]
    : stages.map((stage) => stage.label);
  const updatedApis = detail.run.githubPrUrl
    ? detail.run.detectedApis.filter((api) => UPDATE_STATUSES.has(api.status)).length
    : 0;

  async function manualRefresh() {
    setManualRefreshing(true);
    await refresh();
    setManualRefreshing(false);
  }

  async function retryRun() {
    setRecoveryAction("retry");
    setRecoveryError(null);
    try {
      const response = await fetch(`/api/runs/${detail.run.id}/retry`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { runId?: string; error?: string };
      if (!response.ok || !body.runId)
        throw new Error(body.error ?? "This run could not be retried.");
      router.push(`/app/runs/${body.runId}`);
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : "This run could not be retried.");
      setRecoveryAction(null);
    }
  }

  async function submitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = answer.trim();
    if (!value) {
      setRecoveryError("Add a concise answer before continuing.");
      return;
    }

    setRecoveryAction("answer");
    setRecoveryError(null);
    try {
      const response = await fetch(`/api/runs/${detail.run.id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: value }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The answer could not be submitted.");
      setDetail((current) => ({
        ...current,
        run: { ...current.run, status: "QUEUED", stage: "QUEUED", inputQuestion: null },
      }));
      setAnswer("");
      await refresh();
    } catch (error) {
      setRecoveryError(
        error instanceof Error ? error.message : "The answer could not be submitted.",
      );
    } finally {
      setRecoveryAction(null);
    }
  }

  return (
    <div className="run-view">
      <div className="run-view__heading">
        <div>
          <Link className="subtle-link" href={`/app/repositories/${detail.repository.id}`}>
            ← {detail.repository.fullName}
          </Link>
          <h1>{titleForRun(detail)}</h1>
          <p>
            Started {formatRelativeDate(detail.run.createdAt)} · commit{" "}
            <code>{shortSha(detail.run.startingCommitSha)}</code>
          </p>
        </div>
        <StatusBadge dot tone={statusTone(detail.run.status)}>
          {detail.run.status.replaceAll("_", " ")}
        </StatusBadge>
      </div>

      <ol className="stage-rail" aria-label="Run stages">
        {stages.map((stage, index) => {
          const terminalSuccess = detail.run.status === "SUCCEEDED";
          const complete = terminalSuccess || index < currentIndex;
          const current = index === currentIndex && !terminalSuccess;
          const failed = current && detail.run.status === "FAILED";
          const paused = current && detail.run.status === "NEEDS_INPUT";
          const className = complete
            ? "is-complete"
            : failed
              ? "is-failed"
              : paused
                ? "is-paused"
                : current
                  ? "is-current"
                  : "";

          return (
            <li aria-current={current ? "step" : undefined} className={className} key={stage.key}>
              <span className="stage-rail__icon" aria-hidden="true">
                {complete ? (
                  <Check size={15} />
                ) : failed || paused ? (
                  <AlertTriangle size={14} />
                ) : current ? (
                  <CircleDot size={15} />
                ) : (
                  <Circle size={14} />
                )}
              </span>
              <span>{stageLabels[index]}</span>
            </li>
          );
        })}
      </ol>

      {pollingProblem ? (
        <div className="run-alert run-alert--warning" role="status">
          <AlertTriangle aria-hidden="true" size={20} />
          <div>
            <strong>Live updates paused</strong>
            <p>{pollingProblem}</p>
          </div>
          <Button loading={manualRefreshing} onClick={manualRefresh} size="sm" variant="outline">
            <RefreshCw aria-hidden="true" size={14} /> Refresh now
          </Button>
        </div>
      ) : null}

      {detail.run.status === "FAILED" ? (
        <div className="run-alert run-alert--error" role="alert">
          <AlertTriangle aria-hidden="true" size={20} />
          <div>
            <strong>
              {detail.run.failure?.title ?? "Patchrail could not complete this update"}
            </strong>
            <p>
              {detail.run.failure?.message ??
                "The run stopped before it could complete. No Draft PR was created."}
            </p>
            <div className="run-alert__actions">
              <Button loading={recoveryAction === "retry"} onClick={retryRun} size="sm">
                <RefreshCw aria-hidden="true" size={14} /> Retry as a new run
              </Button>
              <ButtonLink
                href={`/app/repositories/${detail.repository.id}`}
                size="sm"
                variant="outline"
              >
                Back to repository
              </ButtonLink>
            </div>
            {recoveryError ? (
              <p className="form-error" role="alert">
                {recoveryError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      {detail.run.status === "NEEDS_INPUT" ? (
        <div className="run-alert run-alert--warning" role="status">
          <AlertTriangle aria-hidden="true" size={20} />
          <div>
            <strong>Patchrail needs one decision before it can continue</strong>
            <p>{detail.run.inputQuestion ?? "Review is required before this run can continue."}</p>
            <form className="run-answer" onSubmit={submitAnswer}>
              <Field
                hint="Patchrail resumes the same pinned run. Do not include credentials or private keys."
                htmlFor="run-answer"
                label="Your answer"
              >
                <Textarea
                  id="run-answer"
                  maxLength={2000}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder="Give Patchrail the missing context…"
                  required
                  rows={4}
                  value={answer}
                />
              </Field>
              <Button loading={recoveryAction === "answer"} type="submit">
                Continue this run
              </Button>
              {recoveryError ? (
                <p className="form-error" role="alert">
                  {recoveryError}
                </p>
              ) : null}
            </form>
          </div>
        </div>
      ) : null}
      {detail.run.githubPrUrl ? (
        <div className="run-success">
          <GitPullRequestDraft aria-hidden="true" size={27} />
          <div>
            <strong>Verified Draft PR #{detail.run.githubPrNumber}</strong>
            <p>Review and merge remain entirely in your hands.</p>
          </div>
          <ButtonLink href={detail.run.githubPrUrl} rel="noopener noreferrer" target="_blank">
            Open Draft PR <ArrowUpRight aria-hidden="true" size={16} />
          </ButtonLink>
        </div>
      ) : completedWithoutChanges ? (
        <div className="run-success run-success--no-change" role="status">
          <Check aria-hidden="true" size={24} />
          <div>
            <strong>Analysis complete — no Draft PR needed</strong>
            <p>
              {detail.run.detectedApis.length === 0
                ? "No material external API integrations were found."
                : "The detected integrations appear current based on the researched sources."}
            </p>
          </div>
        </div>
      ) : null}

      <div className="run-grid">
        <Card className="run-card run-card--timeline">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Durable activity</span>
              <h2>What Patchrail has done</h2>
            </div>
            {!isTerminalRunStatus(detail.run.status) ? (
              <span className="live-indicator">
                <span aria-hidden="true" /> Updating
              </span>
            ) : null}
          </div>
          {detail.events.length > 0 ? (
            <ol className="event-list" aria-live="polite">
              {detail.events.map((event, index) => {
                const eventKind = event.kind.toLowerCase();
                return (
                  <li key={event.id}>
                    <span
                      aria-hidden="true"
                      className={`event-list__marker event-list__marker--${eventKind}`}
                    >
                      {event.kind === "SUCCESS" ? (
                        <Check size={13} />
                      ) : event.kind === "ERROR" || event.kind === "WARNING" ? (
                        <AlertTriangle size={12} />
                      ) : (
                        <Clock3 size={12} />
                      )}
                    </span>
                    <div>
                      <p>{event.message}</p>
                      <time dateTime={event.createdAt}>{formatRelativeDate(event.createdAt)}</time>
                    </div>
                    {index === detail.events.length - 1 &&
                    !isTerminalRunStatus(detail.run.status) ? (
                      <span aria-hidden="true" className="event-list__pulse" />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="event-list__empty" aria-live="polite">
              This run is queued. The first event will appear after a worker claims it.
            </p>
          )}
        </Card>

        <aside className="run-sidebar" aria-label="Run facts">
          <Card className="run-card">
            <span className="eyebrow">Run facts</span>
            <dl className="detail-list">
              <div>
                <dt>Starting commit</dt>
                <dd>
                  <code>{shortSha(detail.run.startingCommitSha)}</code>
                </dd>
              </div>
              <div>
                <dt>APIs found</dt>
                <dd>{detail.run.detectedApis.length}</dd>
              </div>
              <div>
                <dt>APIs updated</dt>
                <dd>{updatedApis}</dd>
              </div>
              <div>
                <dt>Files changed</dt>
                <dd>{detail.run.changedFiles.length}</dd>
              </div>
              <div>
                <dt>Verification</dt>
                <dd>{verificationFact(detail)}</dd>
              </div>
              <div>
                <dt>Draft PR</dt>
                <dd>{draftPrFact(detail)}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{formatDuration(detail)}</dd>
              </div>
            </dl>
          </Card>
        </aside>
      </div>

      {detail.run.detectedApis.length > 0 ? (
        <section className="run-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Findings</span>
              <h2>External APIs</h2>
            </div>
          </div>
          <div className="api-findings">
            {detail.run.detectedApis.map((api) => {
              const sources = detail.run.research.filter((source) => source.apiId === api.id);
              const officialSources = sources.filter((source) => source.authoritative).length;
              return (
                <article className="api-finding" key={api.id}>
                  <div className="api-finding__top">
                    <div>
                      <h3>{api.provider}</h3>
                      <p>{api.product}</p>
                    </div>
                    <StatusBadge tone={statusTone(api.status)}>
                      {api.status.replaceAll("_", " ")}
                    </StatusBadge>
                  </div>
                  <p className="api-finding__conclusion">{api.conclusion}</p>
                  <div className="api-finding__meta">
                    <span>
                      <FileCode2 aria-hidden="true" size={14} /> {api.files.length} referenced{" "}
                      {api.files.length === 1 ? "file" : "files"}
                    </span>
                    <span>
                      {officialSources} official {officialSources === 1 ? "source" : "sources"}
                    </span>
                    {typeof api.confidence === "number" ? (
                      <span>{Math.round(api.confidence * 100)}% confidence</span>
                    ) : null}
                  </div>
                  {sources.length > 0 ? (
                    <details className="source-evidence">
                      <summary>
                        Research evidence <span>{sources.length}</span>
                      </summary>
                      <div className="source-evidence__list">
                        {sources.map((source) => {
                          const safeUrl = isSafeExternalUrl(source.url);
                          const sourceTitle = (
                            <>
                              <span>{source.title}</span>
                              {safeUrl ? <ArrowUpRight aria-hidden="true" size={12} /> : null}
                            </>
                          );
                          return (
                            <article key={source.url}>
                              <div className="source-evidence__heading">
                                {safeUrl ? (
                                  <a href={source.url} rel="noopener noreferrer" target="_blank">
                                    {sourceTitle}
                                  </a>
                                ) : (
                                  <span>{sourceTitle}</span>
                                )}
                                <StatusBadge tone={source.authoritative ? "positive" : "neutral"}>
                                  {source.authoritative ? "Official" : "Secondary locator"}
                                </StatusBadge>
                              </div>
                              <p>{source.summary}</p>
                            </article>
                          );
                        })}
                      </div>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {detail.run.changedFiles.length > 0 ? (
        <section className="run-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Patch</span>
              <h2>Changed files</h2>
            </div>
          </div>
          <Card>
            <ul className="changed-files">
              {detail.run.changedFiles.map((file) => (
                <li key={file.path}>
                  <span>
                    <StatusBadge tone="neutral">{file.operation}</StatusBadge>
                    <code>{file.path}</code>
                  </span>
                  <span className="diff-count">
                    <b>+{file.additions}</b>
                    <i>−{file.deletions}</i>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {detail.run.verification ? (
        <section className="run-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Evidence</span>
              <h2>Verification</h2>
            </div>
            <StatusBadge tone={statusTone(detail.run.verification.status)}>
              {detail.run.verification.status === "NO_COMMANDS"
                ? "Not required"
                : detail.run.verification.status.replaceAll("_", " ")}
            </StatusBadge>
          </div>
          <Card>
            {detail.run.verification.commands.length > 0 ? (
              <ul className="verification-list">
                {detail.run.verification.commands.map((command) => (
                  <li key={command.command}>
                    <div className="verification-command__row">
                      <code>{command.command}</code>
                      <span>
                        {command.timedOut ? "Timed out" : `Exit ${command.exitCode}`} ·{" "}
                        {(command.durationMs / 1000).toFixed(1)}s
                      </span>
                    </div>
                    {command.stdout || command.stderr ? (
                      <details className="verification-command__output">
                        <summary>View bounded command output</summary>
                        {command.stdout ? <pre>{command.stdout}</pre> : null}
                        {command.stderr ? (
                          <pre className="verification-command__stderr">{command.stderr}</pre>
                        ) : null}
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="verification-empty">
                No code changed, so repository commands were not run.
              </p>
            )}
            {!detail.run.verification.integrityPassed ? (
              <div className="integrity-warning" role="alert">
                {detail.run.verification.integrityFindings.join(" · ")}
              </div>
            ) : null}
          </Card>
        </section>
      ) : null}
    </div>
  );
}
