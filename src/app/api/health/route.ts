import { getConfigurationStatus } from "@/lib/env";

export function GET() {
  const configuration = getConfigurationStatus();
  return Response.json(
    {
      ok: true,
      service: "patchrail-web",
      version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? "development",
      configuration: {
        database: configuration.database,
        auth: configuration.auth,
        github: configuration.github,
        ai: configuration.ai,
        billing: configuration.billing,
        runner: configuration.runner,
      },
      timestamp: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
