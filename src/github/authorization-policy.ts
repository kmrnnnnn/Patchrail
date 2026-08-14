import { GitHubIntegrationError } from "@/github/errors";

export type AccessibleInstallation = { id: number; app_id: number };

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
    installations.some(
      (installation) =>
        Number.isSafeInteger(installation.id) &&
        Number.isSafeInteger(installation.app_id) &&
        installation.id === installationId &&
        installation.app_id === appId,
    )
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
