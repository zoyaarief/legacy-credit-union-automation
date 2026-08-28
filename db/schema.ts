import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
