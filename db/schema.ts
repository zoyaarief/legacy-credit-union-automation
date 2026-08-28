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
    artifactJson: text("artifact_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_automation_runs_owner_created").on(table.ownerId, table.createdAt)],
);
