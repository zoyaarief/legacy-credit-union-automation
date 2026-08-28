import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const automationRuns = sqliteTable(
  "automation_runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    runKind: text("run_kind").notNull(),
    status: text("status").notNull(),
    artifactName: text("artifact_name").notNull(),
    artifactVersion: text("artifact_version").notNull(),
    provider: text("provider"),
    summaryJson: text("summary_json").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    evidenceCiphertext: text("evidence_ciphertext"),
    evidenceIv: text("evidence_iv"),
    evidenceKeyVersion: text("evidence_key_version"),
    artifactJson: text("artifact_json"),
    evidenceHash: text("evidence_hash").notNull().default(""),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull().default(""),
  },
  (table) => [index("idx_automation_runs_owner_created").on(table.ownerId, table.createdAt)],
);

export const artifactReviews = sqliteTable(
  "artifact_reviews",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    artifactHash: text("artifact_hash").notNull(),
    artifactName: text("artifact_name").notNull(),
    artifactVersion: text("artifact_version").notNull(),
    state: text("state").notNull(),
    artifactJson: text("artifact_json").notNull(),
    createdAt: text("created_at").notNull(),
    reviewedAt: text("reviewed_at"),
  },
  (table) => [index("idx_artifact_reviews_owner_state").on(table.ownerId, table.state)],
);

export const invocationRateLimits = sqliteTable(
  "invocation_rate_limits",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    windowStart: text("window_start").notNull(),
    issuedCount: integer("issued_count").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_invocation_rate_limits_owner_window").on(table.ownerId, table.windowStart)],
);

export const operationalEvents = sqliteTable(
  "operational_events",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    eventType: text("event_type").notNull(),
    outcome: text("outcome").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    metadataJson: text("metadata_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_operational_events_owner_created").on(table.ownerId, table.createdAt)],
);

export const automationJobs = sqliteTable(
  "automation_jobs",
  {
    id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), status: text("status").notNull(),
    capabilityName: text("capability_name").notNull(), capabilityVersion: text("capability_version").notNull(),
    variantId: text("variant_id").notNull(), artifactHash: text("artifact_hash").notNull(),
    inputCiphertext: text("input_ciphertext").notNull(), inputIv: text("input_iv").notNull(), inputKeyVersion: text("input_key_version").notNull(),
    resultJson: text("result_json"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
    claimedAt: text("claimed_at"), leaseExpiresAt: text("lease_expires_at"), completedAt: text("completed_at"),
  },
  (table) => [index("idx_automation_jobs_owner_status_created").on(table.ownerId, table.status, table.createdAt)],
);
export const userRoles = sqliteTable("user_roles", { subjectId: text("subject_id").primaryKey(), role: text("role").notNull(), assignedBy: text("assigned_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const alertOutbox = sqliteTable("alert_outbox", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), alertCode: text("alert_code").notNull(), severity: text("severity").notNull(), status: text("status").notNull(), attempts: integer("attempts").notNull(), nextAttemptAt: text("next_attempt_at").notNull(), lastError: text("last_error"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_alert_outbox_status_next").on(table.status, table.nextAttemptAt)]);
