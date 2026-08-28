import type { D1Database } from "@/db";
import { INVOCATION_RATE_LIMIT, rateLimitWindow } from "./core";

export async function consumeInvocationQuota(database: D1Database, ownerId: string, now = Date.now()) {
  const { windowStart, resetAt } = rateLimitWindow(now);
  const id = `${ownerId}:${windowStart}`;
  await database.prepare("DELETE FROM invocation_rate_limits WHERE window_start < ?").bind(String(windowStart - 3_600_000)).run();
  const response = await database.prepare(`INSERT INTO invocation_rate_limits (id, owner_id, window_start, issued_count, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET issued_count = issued_count + 1, updated_at = excluded.updated_at
    RETURNING issued_count`)
    .bind(id, ownerId, String(windowStart), new Date(now).toISOString())
    .all<{ issued_count: number }>();
  const count = Number(response.results?.[0]?.issued_count ?? INVOCATION_RATE_LIMIT + 1);
  return { allowed: count <= INVOCATION_RATE_LIMIT, remaining: Math.max(0, INVOCATION_RATE_LIMIT - count), limit: INVOCATION_RATE_LIMIT, resetAt };
}

export async function recordOperationalEvent(
  database: D1Database,
  ownerId: string,
  eventType: "ticket_issued" | "ticket_verified" | "ticket_rejected" | "ticket_rate_limited" | "agent_run_stored" | "evidence_rotated",
  outcome: "ok" | "rejected" | "error",
  metadata: Record<string, unknown> = {},
  latencyMs = 0,
) {
  await database.prepare(`INSERT INTO operational_events (id, owner_id, event_type, outcome, latency_ms, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), ownerId, eventType, outcome, Math.max(0, Math.round(latencyMs)), JSON.stringify(metadata), new Date().toISOString())
    .run();
}
