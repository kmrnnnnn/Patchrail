CREATE TABLE "free_trial_grants" (
	"user_id" text PRIMARY KEY NOT NULL,
	"granted_workspace_id" uuid,
	"budget_usd" numeric(12, 6) NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "free_trial_grants" ADD CONSTRAINT "free_trial_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_trial_grants" ADD CONSTRAINT "free_trial_grants_granted_workspace_id_workspaces_id_fk" FOREIGN KEY ("granted_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "free_trial_grants_workspace_unique" ON "free_trial_grants" USING btree ("granted_workspace_id");