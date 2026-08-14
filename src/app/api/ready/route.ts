import { checkDatabase } from "@/db/client";
import { logger } from "@/lib/logger";

export async function GET() {
  const database = await checkDatabase();
  if (!database.ok) {
    logger.error("readiness.database_failed", {
      errorCode:
        database.error === "DATABASE_URL is not configured"
          ? "DATABASE_NOT_CONFIGURED"
          : "DATABASE_UNAVAILABLE",
    });
  }
  return Response.json(
    {
      ok: database.ok,
      database: database.ok
        ? { ok: true }
        : { ok: false, error: "Database readiness check failed" },
      timestamp: new Date().toISOString(),
    },
    { status: database.ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
