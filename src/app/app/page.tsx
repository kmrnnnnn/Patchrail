import { ArrowRight, Boxes, CircleDot, Github, GitPullRequestDraft, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink, Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { ConnectGitHubButton } from "@/components/connect-github-button";
import { getConfigurationStatus } from "@/lib/env";
import { formatRelativeDate } from "@/lib/format";
import { getDashboardData } from "@/server/queries";
import { getWorkspaceContext } from "@/server/session";

export const metadata: Metadata = { title: "Overview" };

function runTone(status: string) {
  if (status === "SUCCEEDED") return "positive" as const;
  if (status === "FAILED") return "critical" as const;
  if (status === "NEEDS_INPUT") return "warning" as const;
  return "info" as const;
}

export default async function OverviewPage() {
  const { workspace } = await getWorkspaceContext();
  const dashboard = await getDashboardData(workspace.id);
  const configuration = getConfigurationStatus();
  const needsGitHub = !dashboard.hasInstallation;

  return (
    <div className="product-page">
      <PageHeader
        description="Repositories, active updates, and Draft PRs that need your attention."
        eyebrow="Workspace overview"
        title={`Good to see you in ${workspace.name}`}
        actions={
          needsGitHub && configuration.github ? (
            <ConnectGitHubButton>
              <Github size={17} /> Connect GitHub
            </ConnectGitHubButton>
          ) : needsGitHub ? (
            <ButtonLink href="/app/settings/integrations" variant="outline">
              View configuration
            </ButtonLink>
          ) : (
            <ButtonLink href="/app/repositories">
              View repositories <ArrowRight size={16} />
            </ButtonLink>
          )
        }
      />

      <div className="metric-strip" aria-label="Workspace status">
        <div>
          <span>Repositories</span>
          <strong>{dashboard.repositoryCount}</strong>
          <Boxes size={18} />
        </div>
        <div>
          <span>Active runs</span>
          <strong>{dashboard.activeRunCount}</strong>
          <CircleDot size={18} />
        </div>
        <div title="Verified updates among recent runs">
          <span>Recent verified updates</span>
          <strong>{dashboard.updatesFound}</strong>
          <Sparkles size={18} />
        </div>
        <div title="Draft pull requests among recent runs">
          <span>Recent Draft PRs</span>
          <strong>{dashboard.draftPrCount}</strong>
          <GitPullRequestDraft size={18} />
        </div>
      </div>

      {needsGitHub ? (
        <Card className="attention-panel">
          <div className="attention-panel__mark">
            <Github size={23} />
          </div>
          <div>
            <span className="eyebrow">Next step</span>
            <h2>Give Patchrail repository access</h2>
            <p>
              GitHub login proves who you are. The separate GitHub App gives Patchrail access only
              to repositories you select.
            </p>
          </div>
          {configuration.github ? (
            <ConnectGitHubButton>
              Install GitHub App <ArrowRight size={16} />
            </ConnectGitHubButton>
          ) : (
            <ButtonLink href="/app/settings/integrations" variant="outline">
              View required setup
            </ButtonLink>
          )}
        </Card>
      ) : dashboard.repositoryCount === 0 ? (
        <Card>
          <EmptyState
            title="Grant repository access"
            description="Select at least one repository in your GitHub App installation, then refresh access."
            action={<ButtonLink href="/app/settings/integrations">Manage GitHub access</ButtonLink>}
          />
        </Card>
      ) : dashboard.recentRuns.length === 0 ? (
        <Card>
          <EmptyState
            title="Analyze your first repository"
            description="Enable Patchrail on a repository and start one focused update."
            action={<ButtonLink href="/app/repositories">Choose a repository</ButtonLink>}
          />
        </Card>
      ) : null}

      <section className="product-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Latest</span>
            <h2>Recent activity</h2>
          </div>
          {dashboard.recentRuns.length > 0 ? (
            <Link className="subtle-link" href="/app/repositories">
              All repositories →
            </Link>
          ) : null}
        </div>
        {dashboard.recentRuns.length > 0 ? (
          <Card className="data-card">
            <div className="activity-list">
              {dashboard.recentRuns.map((run) => (
                <Link className="activity-row" href={`/app/runs/${run.id}`} key={run.id}>
                  <span
                    aria-hidden="true"
                    className={`activity-row__icon activity-row__icon--${run.status.toLowerCase()}`}
                  >
                    {run.githubPrUrl ? <GitPullRequestDraft size={17} /> : <CircleDot size={16} />}
                  </span>
                  <span className="activity-row__body">
                    <strong>{run.repositoryName}</strong>
                    <small>{run.summary ?? run.stage.replaceAll("_", " ")}</small>
                  </span>
                  <span className="activity-row__meta">
                    <StatusBadge tone={runTone(run.status)}>
                      {run.status.replaceAll("_", " ")}
                    </StatusBadge>
                    <time dateTime={new Date(run.createdAt).toISOString()}>
                      {formatRelativeDate(run.createdAt)}
                    </time>
                  </span>
                </Link>
              ))}
            </div>
          </Card>
        ) : (
          <div className="quiet-empty">No repository runs have started in this workspace yet.</div>
        )}
      </section>
    </div>
  );
}
