import "server-only";

import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for live notifications (spec 19). Every creator
 * (`createNotification`) and the SSE stream route run in the same web server
 * process (route handlers, server actions, the ingest API, the worker-called
 * sweep are all one Node process under `next start`/NSSM), so a module-level
 * emitter reaches every open stream. The singleton is stashed on `globalThis` so
 * Next's dev HMR reuses one instance instead of leaking a new emitter per reload.
 *
 * Known limitation (spec 19, out of scope): this does NOT cross processes. A
 * multi-process web deployment would need a shared channel (Postgres
 * LISTEN/NOTIFY or Redis pub/sub). On-prem single-host deploys are unaffected.
 */

/** The payload pushed to a subscribed stream when a notification is created. */
export interface NotificationEvent {
  id: string;
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  href: string;
  assetId: string | null;
  createdAt: string; // ISO
}

const CHANNEL = "notification";

const globalForBus = globalThis as unknown as {
  __opusNotificationBus?: EventEmitter;
};

const bus =
  globalForBus.__opusNotificationBus ??
  (globalForBus.__opusNotificationBus = new EventEmitter());

// One listener per open admin SSE stream; the default cap of 10 would warn under
// normal use, so lift it (0 = unlimited).
bus.setMaxListeners(0);

/** Broadcast a freshly-created notification to every open stream. */
export function publishNotification(event: NotificationEvent): void {
  bus.emit(CHANNEL, event);
}

/** Subscribe to created notifications; returns an unsubscribe function the
   stream must call on disconnect so listeners never leak. */
export function subscribeNotifications(
  listener: (event: NotificationEvent) => void,
): () => void {
  bus.on(CHANNEL, listener);
  return () => {
    bus.off(CHANNEL, listener);
  };
}
