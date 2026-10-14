/**
 * Report delivery schedules (spec 26, phase 2) — the pure, client-safe core: the
 * cadence shape, `computeNextRun` (when a schedule next fires), a human summary,
 * and input validation. No DB, no server imports — the saved-report dialog renders
 * from this and the server stores/evaluates it (`src/db/report-schedules.ts`).
 *
 * Times are wall-clock in the server's local zone (H2Tecs is on-prem, one timezone),
 * so `computeNextRun` works in local time via the Date accessors.
 */

export type Cadence = "daily" | "weekly" | "monthly";

export interface ScheduleInput {
  cadence: Cadence;
  hour: number; // 0–23
  minute: number; // 0–59
  weekday?: number | null; // 0–6 (0 = Sunday), for weekly
  dayOfMonth?: number | null; // 1–31 (clamped to the month), for monthly
  recipients: string[];
  format: "csv" | "xlsx";
}

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** The next fire time at/after `from` for a cadence, in local wall-clock time. */
export function computeNextRun(
  input: Pick<ScheduleInput, "cadence" | "hour" | "minute" | "weekday" | "dayOfMonth">,
  from: Date = new Date(),
): Date {
  const { hour, minute } = input;

  if (input.cadence === "daily") {
    const next = new Date(from);
    next.setHours(hour, minute, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }

  if (input.cadence === "weekly") {
    const wd = clampInt(input.weekday ?? 0, 0, 6);
    const next = new Date(from);
    next.setHours(hour, minute, 0, 0);
    let add = (wd - next.getDay() + 7) % 7;
    if (add === 0 && next <= from) add = 7;
    next.setDate(next.getDate() + add);
    return next;
  }

  // monthly: the chosen day clamped to each month's length, advancing until future.
  const dom = clampInt(input.dayOfMonth ?? 1, 1, 31);
  let year = from.getFullYear();
  let month = from.getMonth();
  for (let i = 0; i < 48; i++) {
    const day = Math.min(dom, daysInMonth(year, month));
    const cand = new Date(year, month, day, hour, minute, 0, 0);
    if (cand > from) return cand;
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  // Unreachable in practice; return something sane.
  const fallback = new Date(from);
  fallback.setHours(hour, minute, 0, 0);
  return fallback;
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** "Daily at 09:00" / "Weekly on Mondays at 09:00" / "Monthly on the 1st at 09:00". */
export function describeSchedule(
  input: Pick<ScheduleInput, "cadence" | "hour" | "minute" | "weekday" | "dayOfMonth">,
): string {
  const at = `at ${pad2(input.hour)}:${pad2(input.minute)}`;
  if (input.cadence === "daily") return `Daily ${at}`;
  if (input.cadence === "weekly") {
    const wd = WEEKDAYS[clampInt(input.weekday ?? 0, 0, 6)];
    return `Weekly on ${wd}s ${at}`;
  }
  return `Monthly on the ${ordinal(clampInt(input.dayOfMonth ?? 1, 1, 31))} ${at}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate a schedule from the client. Returns a normalized input or an error. */
export function validateScheduleInput(
  raw: unknown,
): { ok: true; input: ScheduleInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Invalid schedule." };
  }
  const r = raw as Record<string, unknown>;

  const cadence = r.cadence;
  if (cadence !== "daily" && cadence !== "weekly" && cadence !== "monthly") {
    return { ok: false, error: "Choose a cadence." };
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

  let dayOfMonth: number | null = null;
  if (cadence === "monthly") {
    const d = Number(r.dayOfMonth);
    if (!Number.isInteger(d) || d < 1 || d > 31) {
      return { ok: false, error: "Day of month must be 1–31." };
    }
    dayOfMonth = d;
  }

  const recipientsRaw = Array.isArray(r.recipients) ? r.recipients : [];
  const recipients = Array.from(
    new Set(
      recipientsRaw
        .map((e) => (typeof e === "string" ? e.trim().toLowerCase() : ""))
        .filter(Boolean),
    ),
  );
  if (recipients.length === 0) {
    return { ok: false, error: "Add at least one recipient email." };
  }
  const bad = recipients.find((e) => !EMAIL_RE.test(e));
  if (bad) return { ok: false, error: `"${bad}" is not a valid email.` };

  const format = r.format === "xlsx" ? "xlsx" : "csv";

  return {
    ok: true,
    input: { cadence, hour, minute, weekday, dayOfMonth, recipients, format },
  };
}
