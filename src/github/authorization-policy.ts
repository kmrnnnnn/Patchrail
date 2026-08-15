import { GitHubIntegrationError } from "@/github/errors";

export type AccessibleInstallation = { id: number; app_id: number };
export type PersonalInstallationCandidate = AccessibleInstallation & {
  target_type?: string;
  account: { id: number } | null;
  suspended_at?: string | null;
};

function githubNumericAccountId(accountId: string): number | null {
  if (!/^[1-9]\d*$/.test(accountId)) return null;
  const parsed = Number(accountId);
  return Number.isSafeInteger(parsed) && String(parsed) === accountId ? parsed : null;
}

/**
 * A narrow reconciliation fallback for personal installations. It deliberately
 * rejects organizations, suspended installations, and any account-ID mismatch.
 */
export function personalInstallationIdsForGitHubAccount(
  installations: readonly PersonalInstallationCandidate[],
  appId: number,
  githubAccountId: string,
): number[] {
  const accountId = githubNumericAccountId(githubAccountId);
  if (accountId === null || !Number.isSafeInteger(appId) || appId <= 0) return [];

  return [
    ...new Set(
      installations.flatMap((installation) =>
        Number.isSafeInteger(installation.id) &&
        installation.id > 0 &&
        installation.app_id === appId &&
        installation.target_type === "User" &&
        installation.account?.id === accountId &&
        installation.suspended_at == null
          ? [installation.id]
          : [],
      ),
    ),
  ];
}

export function accessibleInstallationIdsForApp(
  installations: readonly AccessibleInstallation[],
  appId: number,
): number[] {
  if (!Number.isSafeInteger(appId) || appId <= 0) return [];

  return [
    ...new Set(
      installations.flatMap((installation) =>
        Number.isSafeInteger(installation.id) &&
        installation.id > 0 &&
        Number.isSafeInteger(installation.app_id) &&
        installation.app_id === appId
          ? [installation.id]
          : [],
      ),
    ),
  ];
}

export function hasAccessibleInstallation(
  installations: readonly AccessibleInstallation[],
  installationId: number,
  appId: number,
): boolean {
  return (
    Number.isSafeInteger(installationId) &&
    installationId > 0 &&
    Number.isSafeInteger(appId) &&
    appId > 0 &&
    accessibleInstallationIdsForApp(installations, appId).includes(installationId)
  );
}

export function requireAccessibleInstallation(
  installations: readonly AccessibleInstallation[],
  installationId: number,
  appId: number,
): void {
  if (!hasAccessibleInstallation(installations, installationId, appId)) {
    throw new GitHubIntegrationError(
      "The signed-in GitHub user cannot access this GitHub App installation",
      "INSTALLATION_NOT_ACCESSIBLE_TO_USER",
      403,
    );
  }
}
