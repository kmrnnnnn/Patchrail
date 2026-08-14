export const WORKSPACE_METADATA_KEY = "patchrail_workspace_id";
export const ACCOUNT_METADATA_KEY = "patchrail_account_key";

/** Bind every mutable Stripe resource to one Patchrail deployment and workspace. */
export function stripeMetadataMatchesWorkspace(
  metadata: Record<string, string | undefined> | null | undefined,
  input: { workspaceId: string; accountKey: string },
): boolean {
  return (
    metadata?.[WORKSPACE_METADATA_KEY] === input.workspaceId &&
    metadata?.[ACCOUNT_METADATA_KEY] === input.accountKey
  );
}

function stripeKeyMode(key: string, kind: "sk" | "pk"): "live" | "test" | null {
  if (key.startsWith(`${kind}_live_`)) return "live";
  if (key.startsWith(`${kind}_test_`)) return "test";
  return null;
}

export function stripeApiKeysUseSameMode(secretKey: string, publishableKey: string): boolean {
  const secretMode = stripeKeyMode(secretKey, "sk");
  return secretMode !== null && secretMode === stripeKeyMode(publishableKey, "pk");
}
