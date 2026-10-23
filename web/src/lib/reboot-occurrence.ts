import { DateTime } from "luxon";

export type RebootCadence = "daily" | "weekly";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function nextRebootOccurrence(input: {
  cadence: RebootCadence;
  weekdays: number[] | null;
  localTime: string;
  timezone: string;
  now?: Date;
}): Date {
  const m = TIME_RE.exec(input.localTime);
  if (!m) throw new Error(`Invalid localTime: ${input.localTime}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const zone = input.timezone;
  if (!DateTime.now().setZone(zone).isValid) {
    throw new Error(`Invalid timezone: ${zone}`);
  }
  const now = DateTime.fromJSDate(input.now ?? new Date(), { zone: "utc" });

  if (input.cadence === "weekly") {
    const days = [...new Set(input.weekdays ?? [])].filter(
      (d) => d >= 1 && d <= 7,
    );
    if (!days.length) throw new Error("weekly cadence requires weekdays");
    let best: DateTime | null = null;
    for (let add = 0; add <= 14; add++) {
      const day = now.setZone(zone).startOf("day").plus({ days: add });
      const isoWeekday = day.weekday; // 1=Mon..7=Sun
      if (!days.includes(isoWeekday)) continue;
      let candidate = day.set({
        hour,
        minute,
        second: 0,
        millisecond: 0,
      });
      if (!candidate.isValid) {
        candidate = day.plus({ hours: hour + 1 }).startOf("hour"); // spring gap fallback
      }
      if (candidate.toUTC() <= now) continue;
      if (!best || candidate < best) best = candidate;
    }
    if (!best) throw new Error("could not find next weekly occurrence");
    return best.toUTC().toJSDate();
  }

  // daily
  for (let add = 0; add <= 2; add++) {
    const day = now.setZone(zone).startOf("day").plus({ days: add });
    let candidate = day.set({ hour, minute, second: 0, millisecond: 0 });
    if (!candidate.isValid) {
      candidate = day.plus({ hours: hour + 1 }).startOf("hour");
    }
    if (candidate.toUTC() > now) return candidate.toUTC().toJSDate();
  }
  throw new Error("could not find next daily occurrence");
}
