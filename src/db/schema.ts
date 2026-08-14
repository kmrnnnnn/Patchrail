import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type {
  AgentResult,
  ChangePlan,
  ChangedFile,
  ChangedFilePayload,
  DetectedApi,
  ModelUsage,
  ResearchSource,
  RunEventDetails,
  VerificationResult,
} from "@/runs/types";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// Better Auth core tables. Names and columns intentionally match its stable schema.
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt,
  updatedAt,
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt,
    updatedAt,
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("account_user_idx").on(table.userId),
    uniqueIndex("account_provider_unique").on(table.providerId, table.accountId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex("workspaces_slug_unique").on(table.slug)],
);

/**
 * A durable, one-time allowance keyed by the creator rather than a workspace.
 * The row survives deletion of the workspace so creating another workspace
 * cannot mint a second FREE AI trial.
 */
export const freeTrialGrants = pgTable(
  "free_trial_grants",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "restrict" }),
    grantedWorkspaceId: uuid("granted_workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 6 }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("free_trial_grants_workspace_unique").on(table.grantedWorkspaceId)],
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("OWNER"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("workspace_memberships_user_idx").on(table.userId, table.lastActiveAt),
  ],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    githubInstallationId: bigint("github_installation_id", { mode: "number" }).notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    repositorySelection: text("repository_selection").notNull().default("selected"),
    permissions: jsonb("permissions").$type<Record<string, string>>().notNull().default({}),
    installedBy: text("installed_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("github_installation_workspace_unique").on(
      table.workspaceId,
      table.githubInstallationId,
    ),
    index("github_installations_workspace_idx").on(table.workspaceId),
  ],
);

export const githubInstallStates = pgTable(
  "github_install_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateHash: text("state_hash").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [uniqueIndex("github_install_states_hash_unique").on(table.stateHash)],
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }).notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    isPrivate: boolean("is_private").notNull(),
    defaultBranch: text("default_branch").notNull(),
    htmlUrl: text("html_url").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    accessState: text("access_state").notNull().default("ACTIVE"),
    lastAnalyzedCommit: text("last_analyzed_commit"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("repositories_workspace_github_unique").on(
      table.workspaceId,
      table.githubRepositoryId,
    ),
    index("repositories_workspace_idx").on(table.workspaceId),
    index("repositories_installation_idx").on(table.installationId),
  ],
);

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    startingCommitSha: text("starting_commit_sha"),
    status: text("status").notNull().default("QUEUED"),
    stage: text("stage").notNull().default("QUEUED"),
    summary: text("summary"),
    detectedApis: jsonb("detected_apis").$type<DetectedApi[]>().notNull().default([]),
    research: jsonb("research").$type<ResearchSource[]>().notNull().default([]),
    plan: jsonb("plan").$type<ChangePlan | null>(),
    changedFiles: jsonb("changed_files").$type<ChangedFile[]>().notNull().default([]),
    verification: jsonb("verification").$type<VerificationResult | null>(),
    modelUsage: jsonb("model_usage").$type<ModelUsage[]>().notNull().default([]),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }).notNull(),
    actualCostUsd: numeric("actual_cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    repairAttempts: integer("repair_attempts").notNull().default(0),
    repairState: text("repair_state").notNull().default("NOT_STARTED"),
    inputQuestion: text("input_question"),
    inputAnswer: text("input_answer"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    githubBranch: text("github_branch"),
    githubCommitSha: text("github_commit_sha"),
    githubPrNumber: integer("github_pr_number"),
    githubPrUrl: text("github_pr_url"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    attemptCount: integer("attempt_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("ai_runs_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("ai_runs_repository_created_idx").on(table.repositoryId, table.createdAt),
    index("ai_runs_queue_idx").on(table.status, table.claimedAt),
    uniqueIndex("ai_runs_one_active_repository_unique")
      .on(table.repositoryId)
      .where(
        sql`${table.status} in ('PENDING_RESERVATION', 'QUEUED', 'READING_REPOSITORY', 'FINDING_APIS', 'RESEARCHING_APIS', 'PLANNING_CHANGES', 'UPDATING_CODE', 'VERIFYING', 'REPAIRING', 'CREATING_PR', 'NEEDS_INPUT')`,
      ),
  ],
);

export const aiRunEvents = pgTable(
  "ai_run_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid("run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    stage: text("stage").notNull(),
    kind: text("kind").notNull().default("INFO"),
    message: text("message").notNull(),
    details: jsonb("details").$type<RunEventDetails>().notNull().default({}),
    createdAt,
  },
  (table) => [
    uniqueIndex("ai_run_events_sequence_unique").on(table.runId, table.sequence),
    index("ai_run_events_run_idx").on(table.runId),
  ],
);

export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    plan: text("plan").notNull().default("FREE"),
    subscriptionStatus: text("subscription_status").notNull().default("NONE"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    currency: text("currency"),
    unitAmount: integer("unit_amount"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    paymentMethodBrand: text("payment_method_brand"),
    paymentMethodLast4: text("payment_method_last4"),
    aiBudgetUsd: numeric("ai_budget_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("billing_accounts_workspace_unique").on(table.workspaceId),
    uniqueIndex("billing_accounts_customer_unique").on(table.stripeCustomerId),
  ],
);

export const costReservations = pgTable(
  "cost_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    amountUsd: numeric("amount_usd", { precision: 12, scale: 6 }).notNull(),
    settledAmountUsd: numeric("settled_amount_usd", { precision: 12, scale: 6 }),
    status: text("status").notNull().default("RESERVED"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("cost_reservations_run_unique").on(table.runId),
    index("cost_reservations_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

export const verificationJobs = pgTable(
  "verification_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull().default("QUEUED"),
    sourceCommitSha: text("source_commit_sha").notNull(),
    payload: jsonb("payload").$type<ChangedFilePayload[] | null>(),
    agentResult: jsonb("agent_result").$type<AgentResult | null>(),
    ecosystem: text("ecosystem").notNull(),
    installCommand: text("install_command"),
    commands: jsonb("commands").$type<string[]>().notNull().default([]),
    result: jsonb("result").$type<VerificationResult | null>(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    runnerId: text("runner_id"),
    sandboxId: text("sandbox_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    createdAt,
    updatedAt,
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("verification_jobs_run_attempt_unique").on(table.runId, table.attempt),
    index("verification_jobs_queue_idx").on(table.status, table.claimedAt),
  ],
);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workerHeartbeats = pgTable("worker_heartbeats", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  version: text("version").notNull(),
  metadata: jsonb("metadata")
    .$type<Record<string, string | number | boolean>>()
    .notNull()
    .default({}),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceRelations = relations(workspaces, ({ many, one }) => ({
  memberships: many(workspaceMemberships),
  repositories: many(repositories),
  installations: many(githubInstallations),
  runs: many(aiRuns),
  billingAccount: one(billingAccounts),
}));

export const membershipRelations = relations(workspaceMemberships, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMemberships.workspaceId],
    references: [workspaces.id],
  }),
  user: one(user, { fields: [workspaceMemberships.userId], references: [user.id] }),
}));

export const repositoryRelations = relations(repositories, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [repositories.workspaceId], references: [workspaces.id] }),
  installation: one(githubInstallations, {
    fields: [repositories.installationId],
    references: [githubInstallations.id],
  }),
  runs: many(aiRuns),
}));

export const runRelations = relations(aiRuns, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [aiRuns.workspaceId], references: [workspaces.id] }),
  repository: one(repositories, {
    fields: [aiRuns.repositoryId],
    references: [repositories.id],
  }),
  events: many(aiRunEvents),
  verificationJobs: many(verificationJobs),
  reservation: one(costReservations),
}));

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  memberships: many(workspaceMemberships),
}));
