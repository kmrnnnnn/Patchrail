ALTER TABLE "ai_runs" ADD COLUMN "repair_state" text DEFAULT 'NOT_STARTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_jobs" ADD COLUMN "agent_result" jsonb;