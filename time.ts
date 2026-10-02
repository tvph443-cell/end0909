// Pure date helpers (no database), so the "each day ends at 00:00" rule can be tested on its own.

export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

/** Time zone that defines when a "day" ends. Override with the CHAT_TIMEZONE env var. */
export function chatTimeZone(): string {
  const tz = process.env.CHAT_TIMEZONE || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Calendar day (YYYY-MM-DD) of an instant in the given time zone. */
export function localDayKey(date: Date = new Date(), tz: string = chatTimeZone()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// How far the zone's wall clock is ahead of UTC at a given instant.
function offsetMs(date: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant of 00:00 local time, `days` calendar days after the day `from` falls on.
 * The day of sending counts as day 1, so a message sent at any time on Oct 1 with days = 30
 * is valid through Oct 30 and leaves the chat at 00:00 on Oct 31.
 */
export function midnightAfterDays(from: Date, days: number, tz: string = chatTimeZone()): Date {
  const [y, m, d] = localDayKey(from, tz).split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d + days); // the wanted wall-clock time, expressed as if it were UTC
  let result = wall - offsetMs(new Date(wall), tz);
  const corrected = wall - offsetMs(new Date(result), tz); // second pass handles a DST change between the two instants
  if (corrected !== result) result = corrected;
  return new Date(result);
}
