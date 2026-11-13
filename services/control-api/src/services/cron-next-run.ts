/**
 * Next occurrence of a five-field cron expression (minute hour day-of-month month day-of-week),
 * in the server's local time, like the scheduler that runs the result.
 *
 * Supported per field: `*`, a number, a range `a-b`, a step (a `/n` suffix on `*`, a range or a
 * start value), and comma lists of those. Day-of-week is 0-7 with 0 and 7 both Sunday. When both
 * day fields are restricted a day matches if either does, as in cron(8). Names (`MON`, `JAN`)
 * and `@` shortcuts are not supported and are refused.
 */

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;

/** Four years: far enough to reach the next 29 February from any date. */
const SEARCH_LIMIT_DAYS = 4 * 366;

interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(?:(\*)|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return null;
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (step < 1) return null;
    const from = match[1] ? min : Number(match[2]);
    // `a/n` means "from a to the end, every n", as in Vixie cron.
    const to = match[1] ? max : match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? max : from;
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
}

function parseCron(expression: string): CronSchedule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((part, index) => parseField(part, FIELDS[index]!.min, FIELDS[index]!.max));
  if (sets.some((set) => set === null)) return null;
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = sets as Set<number>[];
  if (daysOfWeek!.has(7)) daysOfWeek!.add(0);
  return {
    minutes: minutes!, hours: hours!, daysOfMonth: daysOfMonth!, months: months!, daysOfWeek: daysOfWeek!,
    dayOfMonthRestricted: !parts[2]!.startsWith('*'),
    dayOfWeekRestricted: !parts[4]!.startsWith('*'),
  };
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.months.has(date.getMonth() + 1)) return false;
  const dayOfMonth = schedule.daysOfMonth.has(date.getDate());
  const dayOfWeek = schedule.daysOfWeek.has(date.getDay());
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return dayOfMonth || dayOfWeek;
  return dayOfMonth && dayOfWeek;
}

/** Whether `expression` is a five-field cron expression this module can schedule. */
export function isCronExpression(expression: string): boolean {
  return parseCron(expression) !== null;
}

/**
 * The first matching minute strictly after `after`, or null when the expression is not valid or
 * never occurs (for example 31 February).
 */
export function nextCronRun(expression: string, after: Date = new Date()): Date | null {
  const schedule = parseCron(expression);
  if (!schedule) return null;
  const minutes = [...schedule.minutes].sort((a, b) => a - b);
  const hours = [...schedule.hours].sort((a, b) => a - b);
  const day = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let offset = 0; offset <= SEARCH_LIMIT_DAYS; offset += 1, day.setDate(day.getDate() + 1)) {
    if (!dayMatches(schedule, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
        // A local time skipped by a daylight-saving change normalizes to another hour: not a match.
        if (candidate.getHours() !== hour || candidate.getMinutes() !== minute) continue;
        if (candidate.getTime() > after.getTime()) return candidate;
      }
    }
  }
  return null;
}
