export class CrossSiteRequestError extends Error {
  constructor() {
    super("Cross-site request rejected");
    this.name = "CrossSiteRequestError";
  }
}

function normalizedHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Returns the canonical public origin, rejecting unsafe production HTTP URLs. */
export function getConfiguredAppOrigin(): string | null {
  const configured = process.env.APP_URL;
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (
      normalizedHttpOrigin(configured) === null ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      (process.env.NODE_ENV === "production" &&
        url.protocol !== "https:" &&
        !isLoopbackHostname(url.hostname))
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function expectedOrigin(request: Request): string | null {
  if (process.env.APP_URL) return getConfiguredAppOrigin();
  return normalizedHttpOrigin(request.url);
}

/** Rejects browser credentialed mutations not proven to originate from Patchrail. */
export function requireSameOrigin(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") {
    throw new CrossSiteRequestError();
  }

  const allowedOrigin = expectedOrigin(request);
  if (!allowedOrigin) throw new CrossSiteRequestError();

  const origin = request.headers.get("origin");
  if (origin) {
    if (normalizedHttpOrigin(origin) !== allowedOrigin) throw new CrossSiteRequestError();
    return;
  }

  // Fetch Metadata headers are forbidden browser headers. A same-origin value
  // is sufficient proof for older clients that omit Origin on an empty POST.
  if (fetchSite === "same-origin") return;

  const referer = request.headers.get("referer");
  if (referer && normalizedHttpOrigin(referer) === allowedOrigin) return;

  // Authenticated mutations are browser-only. Failing closed when all origin
  // signals are absent avoids silently weakening CSRF protection.
  throw new CrossSiteRequestError();
}

export function crossSiteRequestResponse(error: unknown): Response | null {
  return error instanceof CrossSiteRequestError
    ? Response.json({ error: error.message }, { status: 403 })
    : null;
}
