import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type D1Result<T = Record<string, unknown>> = { results?: T[]; success?: boolean };
export type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<D1Result>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};
export type D1Database = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

export function getDb() {
  const workerEnv = env as unknown as { DB?: Parameters<typeof drizzle>[0] };
  if (!workerEnv.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(workerEnv.DB, { schema });
}

export function getD1(): D1Database {
  const workerEnv = env as unknown as { DB?: D1Database };
  if (!workerEnv.DB) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  return workerEnv.DB;
}

export async function ensureRunStore(database: D1Database) {
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY NOT NULL,
      owner_id TEXT NOT NULL,
      run_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      artifact_name TEXT NOT NULL,
      artifact_version TEXT NOT NULL,
      provider TEXT,
      summary_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      evidence_ciphertext TEXT,
      evidence_iv TEXT,
      evidence_key_version TEXT,
      artifact_json TEXT,
      evidence_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL DEFAULT ''
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS idx_automation_runs_owner_created ON automation_runs(owner_id, created_at DESC)"),
    database.prepare(`CREATE TABLE IF NOT EXISTS artifact_reviews (
      id TEXT PRIMARY KEY NOT NULL,
      owner_id TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      artifact_name TEXT NOT NULL,
      artifact_version TEXT NOT NULL,
      state TEXT NOT NULL,
      artifact_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS idx_artifact_reviews_owner_state ON artifact_reviews(owner_id, state)"),
  ]);

  // Local Miniflare databases can predate the checked-in migration. Keep the
  // runtime bootstrap additive so an existing demo database remains usable.
  const columns = await database.prepare("PRAGMA table_info(automation_runs)").all<{ name: string }>();
  const names = new Set((columns.results ?? []).map((column) => column.name));
  const additions: D1Statement[] = [];
  if (!names.has("evidence_hash")) additions.push(database.prepare("ALTER TABLE automation_runs ADD evidence_hash TEXT NOT NULL DEFAULT ''"));
  if (!names.has("expires_at")) additions.push(database.prepare("ALTER TABLE automation_runs ADD expires_at TEXT NOT NULL DEFAULT ''"));
  if (!names.has("evidence_ciphertext")) additions.push(database.prepare("ALTER TABLE automation_runs ADD evidence_ciphertext TEXT"));
  if (!names.has("evidence_iv")) additions.push(database.prepare("ALTER TABLE automation_runs ADD evidence_iv TEXT"));
  if (!names.has("evidence_key_version")) additions.push(database.prepare("ALTER TABLE automation_runs ADD evidence_key_version TEXT"));
  if (additions.length > 0) await database.batch(additions);
}
