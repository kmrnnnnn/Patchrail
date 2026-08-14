import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CrossSiteRequestError,
  getConfiguredAppOrigin,
  requireSameOrigin,
} from "@/security/request";

afterEach(() => {
  vi.unstubAllEnvs();
});

function mutation(headers: HeadersInit = {}, url = "https://internal.invalid/api/runs") {
  return new Request(url, { method: "POST", headers });
}

describe("authenticated mutation origin validation", () => {
  it("uses APP_URL as the canonical origin instead of trusting the request host", () => {
    vi.stubEnv("APP_URL", "https://app.patchrail.example");
    vi.stubEnv("NODE_ENV", "production");

    expect(() =>
      requireSameOrigin(mutation({ origin: "https://app.patchrail.example" })),
    ).not.toThrow();
    expect(() => requireSameOrigin(mutation({ origin: "https://attacker.example" }))).toThrow(
      CrossSiteRequestError,
    );
  });

  it("rejects cross-site Fetch Metadata even when Origin is forged to the app", () => {
    vi.stubEnv("APP_URL", "https://app.patchrail.example");
    expect(() =>
      requireSameOrigin(
        mutation({
          origin: "https://app.patchrail.example",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toThrow(CrossSiteRequestError);
  });

  it("fails closed when every browser origin signal is missing", () => {
    vi.stubEnv("APP_URL", "https://app.patchrail.example");
    expect(() => requireSameOrigin(mutation())).toThrow(CrossSiteRequestError);
  });

  it("accepts forbidden same-origin Fetch Metadata or a canonical Referer fallback", () => {
    vi.stubEnv("APP_URL", "https://app.patchrail.example");
    expect(() => requireSameOrigin(mutation({ "sec-fetch-site": "same-origin" }))).not.toThrow();
    expect(() =>
      requireSameOrigin(mutation({ referer: "https://app.patchrail.example/app/repositories" })),
    ).not.toThrow();
  });

  it("requires HTTPS for a non-loopback production APP_URL", () => {
    vi.stubEnv("APP_URL", "http://app.patchrail.example");
    vi.stubEnv("NODE_ENV", "production");
    expect(getConfiguredAppOrigin()).toBeNull();
    expect(() => requireSameOrigin(mutation({ origin: "http://app.patchrail.example" }))).toThrow(
      CrossSiteRequestError,
    );
  });

  it("allows an HTTP loopback origin for a production-like local smoke test", () => {
    vi.stubEnv("APP_URL", "http://localhost:3000/");
    vi.stubEnv("NODE_ENV", "production");
    expect(getConfiguredAppOrigin()).toBe("http://localhost:3000");
  });
});
