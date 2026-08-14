export class GitHubIntegrationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "GitHubIntegrationError";
  }
}

export function githubErrorResponse(error: unknown): Response | null {
  if (!(error instanceof GitHubIntegrationError)) return null;
  return Response.json({ error: error.message, code: error.code }, { status: error.status });
}
