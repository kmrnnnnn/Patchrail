import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations");

  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const database = drizzle(client);
  try {
    // Web and worker services can deploy concurrently. A session-level advisory
    // lock serializes their pre-deploy migrations without relying on deploy order.
    await client`select pg_advisory_lock(734882915204741::bigint)`;
    await migrate(database, { migrationsFolder: "drizzle" });
    console.log(JSON.stringify({ level: "info", event: "database_migrated" }));
  } finally {
    await client`select pg_advisory_unlock(734882915204741::bigint)`;
    await client.end();
  }
}

void main().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "database_migration_failed",
      errorCode: "DATABASE_MIGRATION_FAILED",
    }),
  );
  process.exitCode = 1;
  void error;
});
