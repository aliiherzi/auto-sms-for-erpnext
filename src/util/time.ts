/**
 * Date helpers that work on plain 'YYYY-MM-DD' strings in a given time zone.
 * ERPNext stores dates the same way, so comparing strings is safe.
 */

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Today's date ('YYYY-MM-DD') in the given time zone. */
export function todayInTz(tz: string, now: Date = new Date()): string {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function toUtcDate(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12));
}

function fromUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  const date = toUtcDate(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtcDate(date);
}

export function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

export function yearStart(ymd: string): string {
  return `${ymd.slice(0, 4)}-01-01`;
}

/** Monday of the week containing ymd. */
export function weekStart(ymd: string): string {
  const date = toUtcDate(ymd);
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dow);
  return fromUtcDate(date);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcDate(b).getTime() - toUtcDate(a).getTime()) / 86_400_000);
}

export function isYmd(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const DATE_FORMATS = ['DD-MM-YYYY', 'DD/MM/YYYY', 'MM-DD-YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** Formats an ERPNext date ('YYYY-MM-DD', optionally followed by a time) for messages. */
export function formatDate(value: string | null | undefined, format: DateFormat): string {
  if (!value) return '';
  const ymd = String(value).slice(0, 10);
  if (!isYmd(ymd)) return String(value);
  const [y, m, d] = ymd.split('-');
  switch (format) {
    case 'DD/MM/YYYY':
      return `${d}/${m}/${y}`;
    case 'MM-DD-YYYY':
      return `${m}-${d}-${y}`;
    case 'MM/DD/YYYY':
      return `${m}/${d}/${y}`;
    case 'YYYY-MM-DD':
      return ymd;
    case 'DD MMM YYYY':
      return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
    case 'DD-MM-YYYY':
    default:
      return `${d}-${m}-${y}`;
  }
}

/** e.g. "Wed, 04-11-2026" */
export function formatDayLabel(ymd: string, format: DateFormat): string {
  return `${WEEKDAYS[toUtcDate(ymd).getUTCDay()]}, ${formatDate(ymd, format)}`;
}

export function monthLabel(ymd: string): string {
  return `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
}
