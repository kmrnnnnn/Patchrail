import type { Metadata } from "next";
import { ArrowRight, Lock, Search, Unlock } from "lucide-react";
import Link from "next/link";
import { ConnectGitHubButton } from "@/components/connect-github-button";
import {
  GitHubInstallationRecovery,
  RefreshGitHubButton,
} from "@/components/refresh-github-button";

import {
  Button,
  ButtonLink,
  Card,
  EmptyState,
  Input,
  PageHeader,
  StatusBadge,
  SubmitButton,
} from "@/components/ui";
import { formatRelativeDate, shortSha } from "@/lib/format";
import { hasLinkedGitHubInstallation } from "@/github/reconciliation";
import { getConfigurationStatus } from "@/lib/env";
import { getRepositoriesWithLatestRun } from "@/server/queries";
import { enableRepositoryAction } from "@/server/repositories";
import { getWorkspaceContext } from "@/server/session";

export const metadata: Metadata = { title: "Repositories" };

function runTone(status: string) {
  if (status === "SUCCEEDED") return "positive" as const;
  if (status === "FAILED") return "critical" as const;
  if (status === "NEEDS_INPUT") return "warning" as const;
  return "info" as const;
}

export default async function RepositoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { workspace } = await getWorkspaceContext();
  const configuration = getConfigurationStatus();
  const hasInstallation = await hasLinkedGitHubInstallation(workspace.id);
  const repositories = await getRepositoriesWithLatestRun(workspace.id);
  const query = (await searchParams).q?.trim().toLowerCase() ?? "";
  const filtered = query
    ? repositories.filter((repository) => repository.fullName.toLowerCase().includes(query))
    : repositories;

  return (
    <div className="product-page">
      <PageHeader
        actions={
          configuration.github && hasInstallation ? (
            <div className="integration-actions">
              <RefreshGitHubButton variant="outline" />
              <ButtonLink href="/app/settings/integrations" variant="outline">
                Manage GitHub access
              </ButtonLink>
            </div>
          ) : (
            <ButtonLink href="/app/settings/integrations" variant="outline">
              GitHub integration
            </ButtonLink>
          )
        }
        description="Repositories granted through your GitHub App installation. Enabling one never starts paid AI work."
        eyebrow="Source control"
        title="Repositories"
      />

      {repositories.length > 0 ? (
        <form className="repository-search" role="search">
          <Search aria-hidden="true" size={17} />
          <Input
            aria-label="Search repositories"
            defaultValue={query}
            name="q"
            placeholder="Search repositories…"
            type="search"
          />
          <Button size="sm" type="submit" variant="ghost">
            Search
          </Button>
        </form>
      ) : null}

      {repositories.length === 0 ? (
        <Card>
          <EmptyState
            action={
              configuration.github && hasInstallation ? (
                <ButtonLink href="/app/settings/integrations">Manage GitHub access</ButtonLink>
              ) : configuration.github ? (
                <GitHubInstallationRecovery>
                  <div className="integration-actions">
                    <RefreshGitHubButton variant="outline" />
                    <ConnectGitHubButton>Grant repository access</ConnectGitHubButton>
                  </div>
                </GitHubInstallationRecovery>
              ) : (
                <ButtonLink href="/app/settings/integrations">View required setup</ButtonLink>
              )
            }
            description="Install the GitHub App and select the repositories Patchrail may access."
            title="No repositories available"
          />
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            action={
              <ButtonLink href="/app/repositories" variant="outline">
                Clear search
              </ButtonLink>
            }
            description="Try a repository owner or name."
            title="No matching repositories"
          />
        </Card>
      ) : (
        <Card className="data-card">
          <div className="repository-list">
            {filtered.map((repository) => (
              <article className="repository-row" key={repository.id}>
                <div className="repository-row__identity">
                  <span
                    aria-label={repository.isPrivate ? "Private repository" : "Public repository"}
                    className="repository-row__privacy"
                    role="img"
                  >
                    {repository.isPrivate ? (
                      <Lock aria-hidden="true" size={15} />
                    ) : (
                      <Unlock aria-hidden="true" size={15} />
                    )}
                  </span>
                  <div>
                    <Link href={`/app/repositories/${repository.id}`}>{repository.fullName}</Link>
                    <p>
                      {repository.isPrivate ? "Private" : "Public"} ·{" "}
                      <code>{repository.defaultBranch}</code>
                    </p>
                  </div>
                </div>
                <div className="repository-row__commit">
                  <span>Last analyzed</span>
                  <code>{shortSha(repository.lastAnalyzedCommit)}</code>
                </div>
                <div className="repository-row__run">
                  {repository.latestRun ? (
                    <>
                      <StatusBadge tone={runTone(repository.latestRun.status)}>
                        {repository.latestRun.status.replaceAll("_", " ")}
                      </StatusBadge>
                      <small>{formatRelativeDate(repository.latestRun.createdAt)}</small>
                    </>
                  ) : (
                    <span className="muted">Never analyzed</span>
                  )}
                </div>
                <div className="repository-row__action">
                  {repository.accessState !== "ACTIVE" ? (
                    <>
                      <StatusBadge tone="critical">Access removed</StatusBadge>
                      <ButtonLink
                        href={`/app/repositories/${repository.id}`}
                        size="sm"
                        variant="ghost"
                      >
                        View history
                      </ButtonLink>
                    </>
                  ) : repository.enabled ? (
                    <ButtonLink
                      href={`/app/repositories/${repository.id}`}
                      size="sm"
                      variant="outline"
                    >
                      Open <ArrowRight aria-hidden="true" size={14} />
                    </ButtonLink>
                  ) : (
                    <form action={enableRepositoryAction}>
                      <input name="repositoryId" type="hidden" value={repository.id} />
                      <SubmitButton pendingLabel="Enabling…" size="sm">
                        Enable Patchrail
                      </SubmitButton>
                    </form>
                  )}
                </div>
              </article>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
