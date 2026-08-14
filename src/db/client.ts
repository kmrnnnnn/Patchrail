import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

const globalForDb = globalThis as unknown as {
  patchrailSql?: ReturnType<typeof postgres>;
  patchrailDb?: ReturnType<typeof drizzle<typeof schema>>;
};

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://unconfigured:unconfigured@127.0.0.1:1/unconfigured";

export const sql =
  globalForDb.patchrailSql ??
  postgres(connectionString, {
    max: process.env.NODE_ENV === "production" ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });

export const db = globalForDb.patchrailDb ?? drizzle(sql, { schema });

if (process.env.NODE_ENV !== "production") {
  globalForDb.patchrailSql = sql;
  globalForDb.patchrailDb = db;
}

export async function checkDatabase(): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.DATABASE_URL) return { ok: false, error: "DATABASE_URL is not configured" };

  try {
    await sql`select 1`;
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Database connection failed",
    };
  }
}
