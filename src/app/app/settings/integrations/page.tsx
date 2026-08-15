import { and, desc, eq, isNull } from "drizzle-orm";
import { CheckCircle2, Github, KeyRound, LockKeyhole } from "lucide-react";
import type { Metadata } from "next";
import { IntegrationActions } from "@/components/integration-actions";
import { ConnectGitHubButton } from "@/components/connect-github-button";
import {
  GitHubInstallationRecovery,
  RefreshGitHubButton,
} from "@/components/refresh-github-button";
import { Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { db } from "@/db/client";
import { githubInstallations, repositories } from "@/db/schema";
import { getConfigurationStatus } from "@/lib/env";
import { formatRelativeDate } from "@/lib/format";
import { getWorkspaceContext } from "@/server/session";

export const metadata: Metadata = { title: "GitHub integration" };

async function loadInstallations(workspaceId: string) {
  return db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.workspaceId, workspaceId),
        isNull(githubInstallations.disconnectedAt),
      ),
    )
    .orderBy(desc(githubInstallations.createdAt));
}

export default async function IntegrationsPage() {
  const { session, workspace } = await getWorkspaceContext();
  const configuration = getConfigurationStatus();
  const installations = await loadInstallations(workspace.id);
  const repositoryCounts = await Promise.all(
    installations.map(async (installation) => ({
      id: installation.id,
      count: (
        await db
          .select({ id: repositories.id })
          .from(repositories)
          .where(
            and(
              eq(repositories.installationId, installation.id),
              eq(repositories.accessState, "ACTIVE"),
            ),
          )
      ).length,
    })),
  );
  const counts = new Map(repositoryCounts.map((item) => [item.id, item.count]));
  const activeInstallations = installations.filter((installation) => !installation.suspendedAt);

  return (
    <div className="product-page">
      <PageHeader
        eyebrow="Settings"
        title="GitHub integration"
        description="Your GitHub login identifies you. A separate GitHub App authorization grants scoped repository access and creates Draft PRs."
      />
      <div className="identity-separation">
        <Card>
          <div className="identity-separation__icon">
            <KeyRound size={20} />
          </div>
          <div>
            <span className="eyebrow">Identity</span>
            <h2>GitHub login</h2>
            <p>
              Signed in as <strong>{session.user.name}</strong> ({session.user.email}). This does
              not grant repository access.
            </p>
          </div>
          <StatusBadge tone="positive">
            <CheckCircle2 size={13} /> Connected
          </StatusBadge>
        </Card>
        <Card>
          <div className="identity-separation__icon">
            <LockKeyhole size={20} />
          </div>
          <div>
            <span className="eyebrow">Repository access</span>
            <h2>GitHub App</h2>
            <p>
              Contents read/write, pull requests read/write, and metadata read—only for repositories
              you select.
            </p>
          </div>
          <StatusBadge tone={activeInstallations.length > 0 ? "positive" : "warning"}>
            {activeInstallations.length > 0
              ? "Connected"
              : installations.length > 0
                ? "Suspended"
                : "Action needed"}
          </StatusBadge>
        </Card>
      </div>
      {!configuration.github ? (
        <div className="run-alert run-alert--warning">
          <Github size={19} />
          <div>
            <strong>GitHub App configuration unavailable</strong>
            <p>
              Set the GitHub App ID, slug, private key, and webhook secret before connecting
              repository access.
            </p>
          </div>
        </div>
      ) : null}
      <section className="product-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Installations</span>
            <h2>Repository access</h2>
          </div>
        </div>
        {installations.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Github size={22} />}
              title="No GitHub App installed"
              description="Select exactly which repositories Patchrail may read and update. Login and repository authorization remain separate."
              action={
                configuration.github ? (
                  <GitHubInstallationRecovery>
                    <div className="integration-actions">
                      <RefreshGitHubButton variant="outline" />
                      <ConnectGitHubButton>Connect GitHub</ConnectGitHubButton>
                    </div>
                  </GitHubInstallationRecovery>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <div className="installation-list">
            {installations.map((installation) => (
              <Card className="installation-card" key={installation.id}>
                <div className="installation-card__top">
                  <div className="installation-card__avatar">
                    <Github size={19} />
                  </div>
                  <div>
                    <h3>{installation.accountLogin}</h3>
                    <p>
                      {installation.accountType} ·{" "}
                      {installation.repositorySelection === "all"
                        ? "All repositories"
                        : "Selected repositories"}
                    </p>
                  </div>
                  <StatusBadge tone={installation.suspendedAt ? "critical" : "positive"}>
                    {installation.suspendedAt ? "Suspended" : "Active"}
                  </StatusBadge>
                </div>
                <dl>
                  <div>
                    <dt>Available repositories</dt>
                    <dd>{counts.get(installation.id) ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Last synced</dt>
                    <dd>
                      {installation.lastSyncedAt
                        ? formatRelativeDate(installation.lastSyncedAt)
                        : "Not yet"}
                    </dd>
                  </div>
                </dl>
                <IntegrationActions
                  githubInstallationId={installation.githubInstallationId}
                  installationId={installation.id}
                />
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
