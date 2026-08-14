import { describe, expect, it } from "vitest";
import {
  ACCOUNT_METADATA_KEY,
  stripeApiKeysUseSameMode,
  stripeMetadataMatchesWorkspace,
  WORKSPACE_METADATA_KEY,
} from "@/billing/stripe-policy";

describe("Stripe resource ownership policy", () => {
  const workspaceId = "1bcaac7a-f2c0-4cd1-a387-cd00a31e3134";
  const accountKey = "patchrail-production";

  it("requires the deployment key and exact workspace binding", () => {
    expect(
      stripeMetadataMatchesWorkspace(
        {
          [WORKSPACE_METADATA_KEY]: workspaceId,
          [ACCOUNT_METADATA_KEY]: accountKey,
        },
        { workspaceId, accountKey },
      ),
    ).toBe(true);
  });

  it("rejects a resource from another workspace under the same Stripe account", () => {
    expect(
      stripeMetadataMatchesWorkspace(
        {
          [WORKSPACE_METADATA_KEY]: "e382f2f0-e3cc-4963-b047-297822ade97b",
          [ACCOUNT_METADATA_KEY]: accountKey,
        },
        { workspaceId, accountKey },
      ),
    ).toBe(false);
  });

  it("rejects partially tagged resources", () => {
    expect(
      stripeMetadataMatchesWorkspace(
        { [WORKSPACE_METADATA_KEY]: workspaceId },
        { workspaceId, accountKey },
      ),
    ).toBe(false);
    expect(
      stripeMetadataMatchesWorkspace(
        { [ACCOUNT_METADATA_KEY]: accountKey },
        { workspaceId, accountKey },
      ),
    ).toBe(false);
  });

  it("requires server and browser keys from the same Stripe mode", () => {
    expect(stripeApiKeysUseSameMode("sk_test_server", "pk_test_browser")).toBe(true);
    expect(stripeApiKeysUseSameMode("sk_live_server", "pk_live_browser")).toBe(true);
    expect(stripeApiKeysUseSameMode("sk_live_server", "pk_test_browser")).toBe(false);
    expect(stripeApiKeysUseSameMode("sk_unknown", "pk_unknown")).toBe(false);
  });
});
