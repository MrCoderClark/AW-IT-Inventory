import "server-only";

import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

import type { AuditStatus } from "@/lib/computer-audit-actions";

import { updateAuditEventStatus, upsertAuditEvent } from "./computer-audit";
import { db } from "./index";
import {
  assets,
  computerDetails,
  remoteSessionEvents,
  remoteSessions,
} from "./schema";

/**
 * Remote Actions — interactive terminal sessions (spec 24). An on-demand, audited
 * PowerShell-remoting session to a managed computer, using the same outbound-only,
 * atomic-claim / fenced / reaper machinery as the scan and printer-install queues
 * (`db/scan.ts`, `db/printer-install.ts`): the web owns the session, the collector
 * worker claims it and relays a live terminal. Everything here is server-only.
 *
 * One append-only log (`remote_session_events`) is the relay buffer, the audit
 * trail, and the SSE/long-poll resume cursor at once (AC-7). `seq` is monotonic per
 * session; appends are serialized by a per-session advisory lock so two writers
 * (the owner's input, the worker's output) never collide on a seq. This module is
 * the single writer of session state and events; it carries no credentials (AC-10).
 */

/** A claimed/active session with no activity past this is reaped (AC-3). */
export const REMOTE_SESSION_STUCK_TIMEOUT_MS = Number(
  process.env.REMOTE_SESSION_STUCK_TIMEOUT_MS ?? 2 * 60 * 1000,
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REMOTE_AUDIT_TABLE = "remote_sessions";

function remoteTerminal(
  status: "closed" | "failed" | "canceled",
): { status: AuditStatus; summary: string } {
  if (status === "closed") {
    return { status: "succeeded", summary: "Remote session ended" };
  }
  if (status === "failed") {
    return { status: "failed", summary: "Remote session failed" };
  }
  return { status: "canceled", summary: "Remote session canceled" };
}

async function auditRemoteTerminal(
  sessionId: string,
  status: "closed" | "failed" | "canceled",
): Promise<void> {
  const terminal = remoteTerminal(status);
  await updateAuditEventStatus({
    sourceTable: REMOTE_AUDIT_TABLE,
    sourceId: sessionId,
    status: terminal.status,
    summary: terminal.summary,
  });
}

/** postgres.js surfaces a unique-constraint violation as SQLSTATE 23505. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505"
  );
}

export type RemoteSessionStatus =
  | "pending"
  | "claimed"
  | "active"
  | "closing"
  | "closed"
  | "failed"
  | "canceled";

export type ClaimFence = { workerId: string; claimedAt: string };
export type StatusOutcome = "ok" | "notfound" | "stale";

export type ClaimedRemoteSession = {
  id: string;
  assetTag: string | null;
  targetIp: string;
  shell: "powershell";
  workerId: string;
  claimedAt: string; // ISO; echoed back as the claim fence
};

export type CreateSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "not-found" | "not-computer" | "no-ip" | "already-open" };

export type SessionEvent = {
  seq: number;
  direction: "input" | "output" | "system";
  channel: "stdout" | "stderr" | "status" | null;
  data: string;
  createdAt: string;
};

/* ---------------- Create / read (cookie side) ---------------- */

/**
 * Open a new session targeting a computer (by tag). The target must be a Computer
 * asset with a resolvable IP (AC-2); the `remote_sessions_open_uq` partial unique
 * index enforces at most one open session per computer (AC-9) — a lost race turns
 * into a clean `already-open`. Callers gate on `remote:shell` first.
 */
export async function createRemoteSession(opts: {
  assetTag: string;
  requestedBy: string;
}): Promise<CreateSessionResult> {
  const [row] = await db
    .select({
      assetId: assets.id,
      type: assets.type,
      ip: computerDetails.ipAddress,
    })
    .from(assets)
    .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
    .where(eq(assets.tag, opts.assetTag))
    .limit(1);

  if (!row) return { ok: false, reason: "not-found" };
  if (row.type !== "Computer") return { ok: false, reason: "not-computer" };
  if (!row.ip) return { ok: false, reason: "no-ip" };

  try {
    const [created] = await db
      .insert(remoteSessions)
      .values({
        assetId: row.assetId,
        targetIp: row.ip,
        requestedBy: opts.requestedBy,
      })
      .returning({ id: remoteSessions.id });
    await upsertAuditEvent({
      sourceTable: REMOTE_AUDIT_TABLE,
      sourceId: created.id,
      assetId: row.assetId,
      action: "remote_session",
      operator: opts.requestedBy,
      source: "admin_console",
      summary: "Opened remote session",
      details: { targetIp: row.ip, shell: "powershell" },
      status: "pending",
    });
    return { ok: true, sessionId: created.id };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "already-open" };
    throw err;
  }
}

/** One session row by id (ownership/status checks), or null for an unknown id. */
export async function getRemoteSession(id: string) {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select()
    .from(remoteSessions)
    .where(eq(remoteSessions.id, id))
    .limit(1);
  return row ?? null;
}

/** Recent sessions for a computer's history panel (newest first). */
export async function listRemoteSessionsForAsset(
  assetTag: string,
  limit = 20,
): Promise<
  {
    id: string;
    status: RemoteSessionStatus;
    requestedBy: string;
    startedAt: string | null;
    endedAt: string | null;
    createdAt: string;
  }[]
> {
  const rows = await db
    .select({
      id: remoteSessions.id,
      status: remoteSessions.status,
      requestedBy: remoteSessions.requestedBy,
      startedAt: remoteSessions.startedAt,
      endedAt: remoteSessions.endedAt,
      createdAt: remoteSessions.createdAt,
    })
    .from(remoteSessions)
    .innerJoin(assets, eq(assets.id, remoteSessions.assetId))
    .where(eq(assets.tag, assetTag))
    .orderBy(desc(remoteSessions.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    requestedBy: r.requestedBy,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * End a session by its owner (AC-6). A still-`pending` session (no worker yet) is
 * `canceled` outright; a live one is moved to `closing` for the worker to tear
 * down. Terminal states are a no-op `ok`. Enforces ownership (AC-5).
 */
export async function requestEndSession(
  sessionId: string,
  requestedBy: string,
): Promise<"ok" | "notfound" | "forbidden"> {
  const s = await getRemoteSession(sessionId);
  if (!s) return "notfound";
  if (s.requestedBy !== requestedBy) return "forbidden";

  const now = new Date();
  if (s.status === "pending") {
    const updated = await db
      .update(remoteSessions)
      .set({ status: "canceled", endedAt: now, updatedAt: now })
      .where(eq(remoteSessions.id, sessionId))
      .returning({ id: remoteSessions.id });
    if (updated.length) await auditRemoteTerminal(sessionId, "canceled");
  } else if (s.status === "claimed" || s.status === "active") {
    await db
      .update(remoteSessions)
      .set({ status: "closing", updatedAt: now })
      .where(eq(remoteSessions.id, sessionId));
  }
  return "ok";
}

/* ---------------- Claim / status (worker side) ---------------- */

/**
 * Reap stale sessions, then atomically claim the oldest pending one (mirrors
 * `claimNextInstallJob`). A single UPDATE gated by FOR UPDATE SKIP LOCKED so two
 * workers never take the same session (AC-3).
 */
export async function claimNextRemoteSession(
  workerId: string,
): Promise<ClaimedRemoteSession | null> {
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() - REMOTE_SESSION_STUCK_TIMEOUT_MS,
  ).toISOString();

  // Reaper: a claim that never connected → failed; a live session gone quiet →
  // closed (AC-3). Keyed on the freshest activity timestamp available.
  const timedOut = await db
    .update(remoteSessions)
    .set({
      status: "failed",
      error: "worker timed out before connecting",
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(remoteSessions.status, "claimed"),
        sql`coalesce(${remoteSessions.startedAt}, ${remoteSessions.claimedAt}) < ${cutoffIso}`,
      ),
    )
    .returning({ id: remoteSessions.id });
  for (const row of timedOut) {
    await auditRemoteTerminal(row.id, "failed");
  }
  const goneQuiet = await db
    .update(remoteSessions)
    .set({ status: "closed", endedAt: now, updatedAt: now })
    .where(
      and(
        inArray(remoteSessions.status, ["active", "closing"]),
        sql`coalesce(${remoteSessions.lastActivityAt}, ${remoteSessions.startedAt}, ${remoteSessions.claimedAt}) < ${cutoffIso}`,
      ),
    )
    .returning({ id: remoteSessions.id });
  for (const row of goneQuiet) {
    await auditRemoteTerminal(row.id, "closed");
  }

  const claimedAtIso = new Date().toISOString();
  const rows = (await db.execute(sql`
    UPDATE ${remoteSessions}
    SET status = 'claimed',
        worker_id = ${workerId},
        claimed_at = ${claimedAtIso},
        updated_at = ${claimedAtIso}
    WHERE id = (
      SELECT id FROM ${remoteSessions}
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  const id = rows[0]?.id;
  if (!id) return null;

  const [s] = await db
    .select({
      id: remoteSessions.id,
      assetTag: assets.tag,
      targetIp: remoteSessions.targetIp,
      shell: remoteSessions.shell,
      claimedAt: remoteSessions.claimedAt,
    })
    .from(remoteSessions)
    .leftJoin(assets, eq(assets.id, remoteSessions.assetId))
    .where(eq(remoteSessions.id, id))
    .limit(1);

  if (!s || !s.claimedAt) return null;
  return {
    id: s.id,
    assetTag: s.assetTag,
    targetIp: s.targetIp,
    shell: s.shell,
    workerId,
    claimedAt: s.claimedAt.toISOString(),
  };
}

/** True when the fence matches the session's current claim. */
function fenceMatches(
  s: { workerId: string | null; claimedAt: Date | null },
  fence: ClaimFence,
): boolean {
  return (
    s.workerId === fence.workerId &&
    (s.claimedAt ? s.claimedAt.toISOString() : null) === fence.claimedAt
  );
}

/** Move a claimed session to `active` once the runspace is open (fenced). */
export async function markSessionActive(
  sessionId: string,
  fence: ClaimFence,
): Promise<StatusOutcome> {
  const now = new Date();
  const updated = await db
    .update(remoteSessions)
    .set({ status: "active", startedAt: now, lastActivityAt: now, updatedAt: now })
    .where(
      and(
        eq(remoteSessions.id, sessionId),
        eq(remoteSessions.status, "claimed"),
        eq(remoteSessions.workerId, fence.workerId),
        eq(remoteSessions.claimedAt, new Date(fence.claimedAt)),
      ),
    )
    .returning({ id: remoteSessions.id });
  if (updated.length) return "ok";
  return (await getRemoteSession(sessionId)) ? "stale" : "notfound";
}

/** Worker heartbeat: bump activity (fenced) and report the current status so the
   worker learns about a `closing`/`canceled` request. */
export async function heartbeatSession(
  sessionId: string,
  fence: ClaimFence,
): Promise<{ outcome: StatusOutcome; status?: RemoteSessionStatus }> {
  const s = await getRemoteSession(sessionId);
  if (!s) return { outcome: "notfound" };
  if (!fenceMatches(s, fence)) return { outcome: "stale" };
  const now = new Date();
  await db
    .update(remoteSessions)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(eq(remoteSessions.id, sessionId));
  return { outcome: "ok", status: s.status };
}

/** Finalize a session from the worker (fenced): `closed` or `failed`. */
export async function finishSession(
  sessionId: string,
  fence: ClaimFence,
  status: "closed" | "failed",
  error?: string,
): Promise<StatusOutcome> {
  const now = new Date();
  const updated = await db
    .update(remoteSessions)
    .set({
      status,
      endedAt: now,
      updatedAt: now,
      ...(status === "failed" && error ? { error } : {}),
    })
    .where(
      and(
        eq(remoteSessions.id, sessionId),
        eq(remoteSessions.workerId, fence.workerId),
        eq(remoteSessions.claimedAt, new Date(fence.claimedAt)),
        inArray(remoteSessions.status, ["claimed", "active", "closing"]),
      ),
    )
    .returning({ id: remoteSessions.id });
  if (updated.length) {
    await auditRemoteTerminal(sessionId, status);
    return "ok";
  }
  return (await getRemoteSession(sessionId)) ? "stale" : "notfound";
}

/* ---------------- Event log (append + read) ---------------- */

/**
 * Append events to a session's log, serialized per session by an advisory lock so
 * the monotonic `seq` never collides between the owner's input and the worker's
 * output. Returns the last seq assigned.
 */
async function appendEvents(
  sessionId: string,
  rows: {
    direction: "input" | "output" | "system";
    channel: "stdout" | "stderr" | "status" | null;
    data: string;
  }[],
): Promise<number> {
  if (!rows.length) return 0;
  return db.transaction(async (tx) => {
    // Serialize appends for this session; released at transaction end.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);
    const [agg] = await tx
      .select({
        max: sql<number>`coalesce(max(${remoteSessionEvents.seq}), 0)`,
      })
      .from(remoteSessionEvents)
      .where(eq(remoteSessionEvents.sessionId, sessionId));
    const base = Number(agg?.max ?? 0);
    await tx.insert(remoteSessionEvents).values(
      rows.map((r, i) => ({
        sessionId,
        seq: base + 1 + i,
        direction: r.direction,
        channel: r.channel,
        data: r.data,
      })),
    );
    return base + rows.length;
  });
}

function touch(sessionId: string) {
  const now = new Date();
  return db
    .update(remoteSessions)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(eq(remoteSessions.id, sessionId));
}

/** Append one input line from the session owner (ownership + active checked). */
export async function appendInput(
  sessionId: string,
  requestedBy: string,
  text: string,
): Promise<
  | { outcome: "ok"; seq: number }
  | { outcome: "notfound" | "forbidden" | "not-active" }
> {
  const s = await getRemoteSession(sessionId);
  if (!s) return { outcome: "notfound" };
  if (s.requestedBy !== requestedBy) return { outcome: "forbidden" };
  if (s.status !== "active") return { outcome: "not-active" };
  const seq = await appendEvents(sessionId, [
    { direction: "input", channel: null, data: text },
  ]);
  await touch(sessionId);
  return { outcome: "ok", seq };
}

/** Append a batch of output/system events from the worker (fenced). */
export async function appendAgentEvents(
  sessionId: string,
  fence: ClaimFence,
  events: { channel: "stdout" | "stderr" | "status"; data: string }[],
): Promise<StatusOutcome> {
  const s = await getRemoteSession(sessionId);
  if (!s) return "notfound";
  if (!fenceMatches(s, fence)) return "stale";
  if (!["active", "closing"].includes(s.status)) return "stale";
  if (events.length) {
    await appendEvents(
      sessionId,
      events.map((e) => ({
        direction: e.channel === "status" ? ("system" as const) : ("output" as const),
        channel: e.channel,
        data: e.data,
      })),
    );
    await touch(sessionId);
  }
  return "ok";
}

/** Read events after a cursor, filtered by direction (SSE output, agent input). */
export async function readEventsAfter(
  sessionId: string,
  afterSeq: number,
  directions: ("input" | "output" | "system")[],
  limit = 500,
): Promise<SessionEvent[]> {
  if (!UUID_RE.test(sessionId) || !directions.length) return [];
  const rows = await db
    .select({
      seq: remoteSessionEvents.seq,
      direction: remoteSessionEvents.direction,
      channel: remoteSessionEvents.channel,
      data: remoteSessionEvents.data,
      createdAt: remoteSessionEvents.createdAt,
    })
    .from(remoteSessionEvents)
    .where(
      and(
        eq(remoteSessionEvents.sessionId, sessionId),
        gt(remoteSessionEvents.seq, afterSeq),
        inArray(remoteSessionEvents.direction, directions),
      ),
    )
    .orderBy(asc(remoteSessionEvents.seq))
    .limit(limit);

  return rows.map((r) => ({
    seq: Number(r.seq),
    direction: r.direction,
    channel: r.channel,
    data: r.data,
    createdAt: r.createdAt.toISOString(),
  }));
}

/* ---------------- Retention ---------------- */

/** Delete event rows older than the cutoff (daily retention prune, AC-7). */
export async function pruneRemoteSessionEvents(cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(remoteSessionEvents)
    .where(sql`${remoteSessionEvents.createdAt} < ${cutoff.toISOString()}`)
    .returning({ id: remoteSessionEvents.id });
  return deleted.length;
}
