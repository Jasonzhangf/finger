const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

interface CronFieldRange {
  min: number;
  max: number;
}

const MINUTE_RANGE: CronFieldRange = { min: 0, max: 59 };
const HOUR_RANGE: CronFieldRange = { min: 0, max: 23 };
const DAY_RANGE: CronFieldRange = { min: 1, max: 31 };
const MONTH_RANGE: CronFieldRange = { min: 1, max: 12 };
const WEEKDAY_RANGE: CronFieldRange = { min: 0, max: 6 };

interface CronMatcher {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
}

interface ZonedTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const zonedPartsFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function validateTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (normalized.length === 0) {
    throw new Error('timezone cannot be empty');
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date());
  } catch {
    throw new Error(`invalid timezone \`${timezone}\``);
  }
  return normalized;
}

export function computeNextCronFireAt(
  expression: string,
  timezone: string,
  after: Date,
  maxSearchMinutes = 366 * 24 * 60,
): Date {
  const tz = validateTimezone(timezone);
  const matcher = parseCronMatcher(expression);
  const baseTime = Math.floor(after.getTime() / 60_000) * 60_000;

  for (let minuteOffset = 1; minuteOffset <= maxSearchMinutes; minuteOffset += 1) {
    const candidate = new Date(baseTime + minuteOffset * 60_000);
    const parts = getZonedTimeParts(candidate, tz);
    if (matchesCron(parts, matcher)) {
      return candidate;
    }
  }

  throw new Error('cron expression has no future run');
}

function matchesCron(parts: ZonedTimeParts, matcher: CronMatcher): boolean {
  return (
    matcher.minute.has(parts.minute) &&
    matcher.hour.has(parts.hour) &&
    matcher.day.has(parts.day) &&
    matcher.month.has(parts.month) &&
    matcher.weekday.has(parts.weekday)
  );
}

function parseCronMatcher(expression: string): CronMatcher {
  const fields = expression
    .trim()
    .split(/\s+/)
    .filter((field) => field.length > 0);
  if (fields.length !== 5) {
    throw new Error(`invalid cron expression: expected 5 fields, got ${fields.length}`);
  }

  return {
    minute: parseCronField(fields[0], MINUTE_RANGE),
    hour: parseCronField(fields[1], HOUR_RANGE),
    day: parseCronField(fields[2], DAY_RANGE),
    month: parseCronField(fields[3], MONTH_RANGE),
    weekday: parseCronField(fields[4], WEEKDAY_RANGE, true),
  };
}

function parseCronField(rawField: string, range: CronFieldRange, allowWeekdayAliases = false): Set<number> {
  const output = new Set<number>();
  const segments = rawField.split(',');

  for (const segment of segments) {
    const normalized = segment.trim().toLowerCase();
    if (normalized.length === 0) {
      throw new Error('invalid cron expression: empty field segment');
    }

    const [base, stepPart] = normalized.split('/');
    if (stepPart !== undefined && stepPart.trim().length === 0) {
      throw new Error(`invalid cron expression step: ${segment}`);
    }

    const step = stepPart === undefined ? 1 : parseStep(stepPart);
    const [start, end] = parseBaseRange(base, range, allowWeekdayAliases);

    for (let value = start; value <= end; value += step) {
      output.add(value);
    }
  }

  if (output.size === 0) {
    throw new Error(`invalid cron field: ${rawField}`);
  }
  return output;
}

function parseBaseRange(
  base: string,
  range: CronFieldRange,
  allowWeekdayAliases: boolean,
): [number, number] {
  if (base === '*') {
    return [range.min, range.max];
  }
  if (base.includes('-')) {
    const [left, right] = base.split('-', 2);
    const start = parseNumericToken(left, range, allowWeekdayAliases);
    const end = parseNumericToken(right, range, allowWeekdayAliases);
    if (end < start) {
      throw new Error(`invalid cron range: ${base}`);
    }
    return [start, end];
  }
  const single = parseNumericToken(base, range, allowWeekdayAliases);
  return [single, single];
}

function parseNumericToken(token: string, range: CronFieldRange, allowWeekdayAliases: boolean): number {
  const normalized = token.trim().toLowerCase();
  if (allowWeekdayAliases && WEEKDAY_ALIASES[normalized] !== undefined) {
    return WEEKDAY_ALIASES[normalized];
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid cron token: ${token}`);
  }

  const value = normalized === '7' && allowWeekdayAliases ? 0 : parsed;
  if (value < range.min || value > range.max) {
    throw new Error(`cron token out of range: ${token}`);
  }
  return value;
}

function parseStep(rawStep: string): number {
  const step = Number.parseInt(rawStep.trim(), 10);
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`invalid cron step: ${rawStep}`);
  }
  return step;
}

function getZonedTimeParts(date: Date, timezone: string): ZonedTimeParts {
  const formatter = getZonedPartsFormatter(timezone);
  const parts = formatter.formatToParts(date);

  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday = -1;

  for (const part of parts) {
    if (part.type === 'year') year = Number.parseInt(part.value, 10);
    if (part.type === 'month') month = Number.parseInt(part.value, 10);
    if (part.type === 'day') day = Number.parseInt(part.value, 10);
    if (part.type === 'hour') hour = Number.parseInt(part.value, 10);
    if (part.type === 'minute') minute = Number.parseInt(part.value, 10);
    if (part.type === 'weekday') weekday = weekdayNameToNumber(part.value);
  }

  if (year <= 0 || month <= 0 || day <= 0 || hour < 0 || minute < 0 || weekday < 0) {
    throw new Error(`failed to compute zoned time for timezone ${timezone}`);
  }

  return { year, month, day, hour, minute, weekday };
}

function getZonedPartsFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = zonedPartsFormatterCache.get(timezone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  zonedPartsFormatterCache.set(timezone, formatter);
  return formatter;
}

function weekdayNameToNumber(weekday: string): number {
  const normalized = weekday.trim().slice(0, 3).toLowerCase();
  const value = WEEKDAY_ALIASES[normalized];
  if (value === undefined) {
    throw new Error(`invalid weekday value: ${weekday}`);
  }
  return value;
}
