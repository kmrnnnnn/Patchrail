import type { Metadata } from "next";
import { ArrowUpRight, GitBranch, Github, Lock, ShieldCheck, Unlock } from "lucide-react";
import { notFound } from "next/navigation";

import { StartRunButton } from "@/components/start-run-button";
import {
  ButtonLink,
  Card,
  EmptyState,
  PageHeader,
  StatusBadge,
  SubmitButton,
} from "@/components/ui";
import { getConfigurationStatus } from "@/lib/env";
import { formatRelativeDate, shortSha } from "@/lib/format";
import { getRepositoryDetail } from "@/server/queries";
import { disableRepositoryAction, enableRepositoryAction } from "@/server/repositories";
import { getWorkspaceContext } from "@/server/session";

export const metadata: Metadata = { title: "Repository" };

function runTone(status: string) {
  if (status === "SUCCEEDED") return "positive" as const;
  if (status === "FAILED") return "critical" as const;
  if (status === "NEEDS_INPUT") return "warning" as const;
  return "info" as const;
}

export default async function RepositoryPage({
  params,
}: {
  params: Promise<{ repositoryId: string }>;
}) {
  const { workspace } = await getWorkspaceContext();
  const { repositoryId } = await params;
  const repository = await getRepositoryDetail(workspace.id, repositoryId);
  if (!repository) notFound();

  const configuration = getConfigurationStatus();
  const liveReady = configuration.github && configuration.ai && configuration.runner;
  const run = repository.lastRun;
  const hasActiveRun = Boolean(run && run.status !== "SUCCEEDED" && run.status !== "FAILED");
  const accessAvailable =
    repository.accessState === "ACTIVE" && !repository.installationDisconnectedAt;
  const missingConfiguration = [
    !configuration.github && "GitHub App",
    !configuration.ai && "analysis service",
    !configuration.runner && "verification runner",
  ].filter(Boolean);
  const runSummary = run
    ? run.status === "NEEDS_INPUT"
      ? (run.inputQuestion ?? "Patchrail needs a decision before it can continue.")
      : run.status === "FAILED"
        ? (run.failureMessage ?? "Patchrail could not complete this repository update.")
        : run.status === "SUCCEEDED" && !run.githubPrUrl
          ? run.detectedApis.length === 0
            ? "No material external API integrations were found. No code change or Draft PR was required."
            : "Detected API integrations appear current. No code change or Draft PR was required."
          : (run.summary ?? run.stage.replaceAll("_", " "))
    : null;

  return (
    <div className="product-page">
      <PageHeader
        actions={
          <div className="header-actions">
            <ButtonLink
              href={repository.htmlUrl}
              rel="noopener noreferrer"
              target="_blank"
              variant="ghost"
            >
              GitHub <ArrowUpRight aria-hidden="true" size={15} />
            </ButtonLink>
            {repository.enabled ? (
              <>
                <form action={disableRepositoryAction}>
                  <input name="repositoryId" type="hidden" value={repository.id} />
                  <SubmitButton
                    disabled={hasActiveRun}
                    pendingLabel="Disabling…"
                    title={hasActiveRun ? "Wait for the active run to finish" : undefined}
                    variant="outline"
                  >
                    Disable
                  </SubmitButton>
                </form>
                <StartRunButton
                  disabled={!liveReady || !accessAvailable || hasActiveRun}
                  repositoryId={repository.id}
                />
              </>
            ) : accessAvailable ? (
              <form action={enableRepositoryAction}>
                <input name="repositoryId" type="hidden" value={repository.id} />
                <SubmitButton pendingLabel="Enabling…">Enable Patchrail</SubmitButton>
              </form>
            ) : null}
          </div>
        }
        description={
          <>
            Default branch <code>{repository.defaultBranch}</code>
          </>
        }
        eyebrow={
          <span className="repository-eyebrow">
            {repository.isPrivate ? (
              <Lock aria-hidden="true" size={13} />
            ) : (
              <Unlock aria-hidden="true" size={13} />
            )}
            {repository.isPrivate ? "Private repository" : "Public repository"}
          </span>
        }
        title={repository.fullName}
      />

      {!liveReady ? (
        <div className="run-alert run-alert--warning" role="status">
          <ShieldCheck aria-hidden="true" size={19} />
          <div>
            <strong>Live updates are not configured yet</strong>
            <p>{missingConfiguration.join(", ")} must be configured before an update can start.</p>
          </div>
        </div>
      ) : null}

      {!accessAvailable ? (
        <div className="run-alert run-alert--error" role="alert">
          <ShieldCheck aria-hidden="true" size={19} />
          <div>
            <strong>GitHub repository access is unavailable</strong>
            <p>
              Reconnect or update this GitHub App installation before enabling Patchrail or starting
              another run. Existing run history remains available.
            </p>
            <ButtonLink href="/app/settings/integrations" size="sm" variant="outline">
              Manage GitHub access
            </ButtonLink>
          </div>
        </div>
      ) : null}

      <div className="repository-facts">
        <Card>
          <span>GitHub access</span>
          <strong>{accessAvailable ? "Connected" : "Unavailable"}</strong>
          <StatusBadge tone={accessAvailable ? "positive" : "critical"}>
            {accessAvailable
              ? "Active"
              : repository.installationDisconnectedAt
                ? "Disconnected"
                : repository.accessState.replaceAll("_", " ")}
          </StatusBadge>
        </Card>
        <Card>
          <span>Patchrail</span>
          <strong>{repository.enabled ? "Enabled" : "Not enabled"}</strong>
          <StatusBadge tone={repository.enabled && accessAvailable ? "accent" : "neutral"}>
            {repository.enabled && accessAvailable ? "Ready" : "Setup"}
          </StatusBadge>
        </Card>
        <Card>
          <span>Last analyzed commit</span>
          <strong>
            <code>{shortSha(repository.lastAnalyzedCommit)}</code>
          </strong>
          <GitBranch aria-hidden="true" size={18} />
        </Card>
      </div>

      <section className="product-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Latest run</span>
            <h2>Repository health</h2>
          </div>
          {run ? (
            <ButtonLink href={`/app/runs/${run.id}`} size="sm" variant="outline">
              View full run
            </ButtonLink>
          ) : null}
        </div>
        {!run ? (
          <Card>
            <EmptyState
              description={
                repository.enabled
                  ? "Patchrail will discover external APIs, research current official docs, update code, verify it, and open a Draft PR when needed."
                  : "Enabling is free and does not start an AI run."
              }
              title={
                repository.enabled ? "Ready for the first analysis" : "Enable Patchrail to begin"
              }
            />
          </Card>
        ) : (
          <div className="repository-result">
            <Card className="repository-result__summary">
              <div className="repository-result__title">
                <div>
                  <StatusBadge tone={runTone(run.status)}>
                    {run.status.replaceAll("_", " ")}
                  </StatusBadge>
                  <h3>{runSummary}</h3>
                </div>
                <span>{formatRelativeDate(run.createdAt)}</span>
              </div>
              <dl className="result-facts">
                <div>
                  <dt>Starting commit</dt>
                  <dd>
                    <code>{shortSha(run.startingCommitSha)}</code>
                  </dd>
                </div>
                <div>
                  <dt>External APIs</dt>
                  <dd>{run.detectedApis.length}</dd>
                </div>
                <div>
                  <dt>Updates requiring migration</dt>
                  <dd>
                    {
                      run.detectedApis.filter((api) =>
                        [
                          "MIGRATION_REQUIRED",
                          "DEPRECATED_USAGE",
                          "BREAKING_CHANGE_RELEVANT",
                        ].includes(api.status),
                      ).length
                    }
                  </dd>
                </div>
                <div>
                  <dt>Files changed</dt>
                  <dd>{run.changedFiles.length}</dd>
                </div>
              </dl>
              {run.githubPrUrl ? (
                <ButtonLink href={run.githubPrUrl} rel="noopener noreferrer" target="_blank">
                  <Github aria-hidden="true" size={16} /> Open Draft PR #{run.githubPrNumber}
                </ButtonLink>
              ) : null}
            </Card>
          </div>
        )}
      </section>
    </div>
  );
}
