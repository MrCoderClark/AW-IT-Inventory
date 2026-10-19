/**
 * Script-run schedules (spec 32 v2) — client-safe cadence helpers.
 * Reuses report-schedule's computeNextRun / describe for daily|weekly only.
 */

import {
  computeNextRun,
  describeSchedule,
  WEEKDAYS,
} from "./report-schedule";

export { computeNextRun, describeSchedule, WEEKDAYS };

export type ScriptCadence = "daily" | "weekly";

export type ScriptScheduleInput = {
  cadence: ScriptCadence;
  hour: number;
  minute: number;
  weekday?: number | null;
};

export function validateScriptScheduleInput(
  raw: unknown,
): { ok: true; input: ScriptScheduleInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Invalid schedule." };
  }
  const r = raw as Record<string, unknown>;

  const cadence = r.cadence;
  if (cadence !== "daily" && cadence !== "weekly") {
    return { ok: false, error: "Choose daily or weekly." };
  }

  const hour = Number(r.hour);
  const minute = Number(r.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return { ok: false, error: "Hour must be 0–23." };
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { ok: false, error: "Minute must be 0–59." };
  }

  let weekday: number | null = null;
  if (cadence === "weekly") {
    const w = Number(r.weekday);
    if (!Number.isInteger(w) || w < 0 || w > 6) {
      return { ok: false, error: "Pick a day of the week." };
    }
    weekday = w;
  }

  return { ok: true, input: { cadence, hour, minute, weekday } };
}

export function validateTargetSpec(
  raw: unknown,
):
  | { ok: true; spec: { mode: "tags"; tags: string[] } }
  | { ok: true; spec: { mode: "location"; locationId: string } }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Choose targets." };
  }
  const r = raw as Record<string, unknown>;
  if (r.mode === "tags") {
    const tags = Array.isArray(r.tags)
      ? Array.from(
          new Set(
            r.tags
              .map((t) => (typeof t === "string" ? t.trim() : ""))
              .filter(Boolean),
          ),
        )
      : [];
    if (tags.length === 0) {
      return { ok: false, error: "Select at least one computer." };
    }
    return { ok: true, spec: { mode: "tags", tags } };
  }
  if (r.mode === "location") {
    const locationId =
      typeof r.locationId === "string" ? r.locationId.trim() : "";
    if (!locationId) {
      return { ok: false, error: "Pick a location." };
    }
    return { ok: true, spec: { mode: "location", locationId } };
  }
  return { ok: false, error: "Choose tags or a location." };
}
