import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accessibleInstallationIdsForApp,
  hasAccessibleInstallation,
  personalInstallationIdsForGitHubAccount,
  requireAccessibleInstallation,
} from "@/github/authorization-policy";
import {
  assertPatchrailBranchName,
  assertWorkflowPathAllowed,
  verifyGitHubWebhookSignature,
} from "@/github/security";

describe("GitHub installation authorization", () => {
  const appId = 7;
  const accessible = [
    { id: 10, app_id: appId },
    { id: 42, app_id: appId },
  ];

  it("accepts only an installation returned for the signed-in user and this GitHub App", () => {
    expect(hasAccessibleInstallation(accessible, 42, appId)).toBe(true);
    expect(() => requireAccessibleInstallation(accessible, 42, appId)).not.toThrow();
  });

  it("discovers only unique, safe installation IDs for the configured app", () => {
    expect(
      accessibleInstallationIdsForApp(
        [
          ...accessible,
          { id: 42, app_id: appId },
          { id: 99, app_id: 8 },
          { id: Number.MAX_SAFE_INTEGER + 1, app_id: appId },
          { id: 0, app_id: appId },
        ],
        appId,
      ),
    ).toEqual([10, 42]);
    expect(accessibleInstallationIdsForApp(accessible, 0)).toEqual([]);
  });

  it("recovers only an exact, active personal installation for the GitHub account", () => {
    const candidates = [
      {
        id: 50,
        app_id: appId,
        target_type: "User",
        account: { id: 1234 },
        suspended_at: null,
      },
      {
        id: 51,
        app_id: appId,
        target_type: "Organization",
        account: { id: 1234 },
        suspended_at: null,
      },
      {
        id: 52,
        app_id: appId,
        target_type: "User",
        account: { id: 9999 },
        suspended_at: null,
      },
      {
        id: 53,
        app_id: appId,
        target_type: "User",
        account: { id: 1234 },
        suspended_at: "2026-08-15T00:00:00Z",
      },
    ];

    expect(personalInstallationIdsForGitHubAccount(candidates, appId, "1234")).toEqual([50]);
    expect(personalInstallationIdsForGitHubAccount(candidates, appId, "9998")).toEqual([]);
    expect(personalInstallationIdsForGitHubAccount(candidates, appId, "01234")).toEqual([]);
  });

  it("rejects a spoofed setup URL installation ID", () => {
    expect(hasAccessibleInstallation(accessible, 41, appId)).toBe(false);
    expect(() => requireAccessibleInstallation(accessible, 41, appId)).toThrowError(
      expect.objectContaining({
        code: "INSTALLATION_NOT_ACCESSIBLE_TO_USER",
        status: 403,
      }),
    );
  });

  it("rejects an installation belonging to another GitHub App", () => {
    expect(hasAccessibleInstallation([{ id: 42, app_id: 99 }], 42, appId)).toBe(false);
    expect(() => requireAccessibleInstallation([{ id: 42, app_id: 99 }], 42, appId)).toThrowError(
      expect.objectContaining({ code: "INSTALLATION_NOT_ACCESSIBLE_TO_USER", status: 403 }),
    );
  });

  it("rejects unsafe numeric installation IDs", () => {
    expect(hasAccessibleInstallation(accessible, Number.MAX_SAFE_INTEGER + 1, appId)).toBe(false);
    expect(hasAccessibleInstallation(accessible, 0, appId)).toBe(false);
    expect(hasAccessibleInstallation(accessible, 42, 0)).toBe(false);
  });
});

describe("GitHub boundary protections", () => {
  it("validates the raw webhook body with HMAC SHA-256", () => {
    const body = Buffer.from('{"action":"created"}', "utf8");
    const secret = "a webhook secret with enough entropy";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    expect(verifyGitHubWebhookSignature(body, signature, secret)).toBe(true);
    expect(
      verifyGitHubWebhookSignature(Buffer.from('{"action":"deleted"}'), signature, secret),
    ).toBe(false);
  });

  it("rejects workflow files and invalid delivery branches", () => {
    expect(() => assertWorkflowPathAllowed(".github/workflows/release.yml")).toThrow(
      "workflow permission",
    );
    expect(() => assertPatchrailBranchName("feature/unscoped")).toThrow("Invalid Patchrail branch");
    expect(() => assertPatchrailBranchName("patchrail/run-123")).not.toThrow();
  });
});
