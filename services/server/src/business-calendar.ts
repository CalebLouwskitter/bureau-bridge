const TIME_ZONE = "Africa/Johannesburg";

const FIXED_HOLIDAYS: ReadonlyArray<readonly [month: number, day: number]> = [
  [1, 1], // New Year's Day
  [3, 21], // Human Rights Day
  [4, 27], // Freedom Day
  [5, 1], // Workers' Day
  [6, 16], // Youth Day
  [8, 9], // National Women's Day
  [9, 24], // Heritage Day
  [12, 16], // Day of Reconciliation
  [12, 25], // Christmas Day
  [12, 26], // Day of Goodwill
];

export interface ActionDateOptions {
  cutOff?: string;
  extraHolidays?: readonly string[];
}

export type HolidayList = string[] & { has(date: string): boolean };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toDateString(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function addDays(dateString: string, days: number): string {
  const [y, m, d] = dateString.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return toDateString(
    dt.getUTCFullYear(),
    dt.getUTCMonth() + 1,
    dt.getUTCDate(),
  );
}

export function dayOfWeek(dateString: string): number {
  const [y, m, d] = dateString.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Computes Easter Sunday for a given Gregorian year using the anonymous Gregorian algorithm
 * (Meeus/Jones/Butcher algorithm).
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const L = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * L) / 451);
  const month = Math.floor((h + L - 7 * m + 114) / 31);
  const day = ((h + L - 7 * m + 114) % 31) + 1;
  return toDateString(year, month, day);
}

export interface JohannesburgDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  dateString: string;
}

export function getJohannesburgDateTime(
  input: Date | string,
): JohannesburgDateTime {
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [year, month, day] = input.split("-").map(Number);
    return {
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
      dateString: input,
    };
  }

  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date: ${input}`);
  }

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  );

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const millisecond = Number(parts.fractionalSecond ?? 0);
  const dateString = `${parts.year}-${parts.month}-${parts.day}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    dateString,
  };
}

/**
 * Returns South African public holidays for a given year under the Public Holidays Act 36 of 1994.
 *
 * Fixed-date holidays:
 * - New Year's Day (1 Jan)
 * - Human Rights Day (21 Mar)
 * - Freedom Day (27 Apr)
 * - Workers' Day (1 May)
 * - Youth Day (16 Jun)
 * - National Women's Day (9 Aug)
 * - Heritage Day (24 Sep)
 * - Day of Reconciliation (16 Dec)
 * - Christmas Day (25 Dec)
 * - Day of Goodwill (26 Dec)
 *
 * Variable-date holidays derived from Easter Sunday (anonymous Gregorian algorithm):
 * - Good Friday (2 days before Easter Sunday)
 * - Family Day / Easter Monday (1 day after Easter Sunday)
 *
 * Section 2(1) of the Act: whenever any public holiday falls on a Sunday, the following Monday
 * shall be a public holiday.
 *
 * Proclaimed one-off holidays can be passed via `extraHolidays`.
 */
export function southAfricanPublicHolidays(
  year: number,
  extraHolidays: readonly string[] = [],
): HolidayList {
  const set = new Set<string>();

  // 1. Fixed-date holidays and Sunday-to-Monday shifts
  for (const [month, day] of FIXED_HOLIDAYS) {
    const dateStr = toDateString(year, month, day);
    set.add(dateStr);
    if (dayOfWeek(dateStr) === 0) {
      set.add(addDays(dateStr, 1));
    }
  }

  // 2. Easter-derived holidays (Good Friday and Family Day)
  const easter = easterSunday(year);
  set.add(addDays(easter, -2)); // Good Friday (always Friday)
  set.add(addDays(easter, 1)); // Family Day / Easter Monday (always Monday)

  // 3. Proclaimed / extra holidays for this year
  const yearPrefix = `${year}-`;
  for (const extra of extraHolidays) {
    if (extra.startsWith(yearPrefix)) {
      set.add(extra);
    }
  }

  const list = Array.from(set).sort();
  Object.defineProperty(list, "has", {
    value: (date: string) => set.has(date),
    enumerable: false,
    writable: false,
    configurable: true,
  });

  return list as HolidayList;
}

type ExtraHolidaysArg =
  | readonly string[]
  | { extraHolidays?: readonly string[] };

function extractExtraHolidays(
  arg?: ExtraHolidaysArg,
): readonly string[] | undefined {
  if (!arg) return undefined;
  if (Array.isArray(arg)) return arg;
  return "extraHolidays" in arg ? arg.extraHolidays : undefined;
}

/**
 * Returns true if the given date is a business day (Monday to Friday, not a public holiday).
 */
export function isBusinessDay(
  date: Date | string,
  extraHolidaysOrOptions?: ExtraHolidaysArg,
): boolean {
  const extraHolidays = extractExtraHolidays(extraHolidaysOrOptions);
  const { dateString, year } = getJohannesburgDateTime(date);
  const dow = dayOfWeek(dateString);
  if (dow === 0 || dow === 6) {
    return false;
  }
  const holidays = southAfricanPublicHolidays(year, extraHolidays);
  return !holidays.has(dateString);
}

/**
 * Returns the next business day (in YYYY-MM-DD format) strictly after the given date.
 */
export function nextBusinessDay(
  date: Date | string,
  extraHolidaysOrOptions?: ExtraHolidaysArg,
): string {
  const { dateString } = getJohannesburgDateTime(date);
  let candidate = addDays(dateString, 1);
  while (!isBusinessDay(candidate, extraHolidaysOrOptions)) {
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

/**
 * Returns the EFT action date in Johannesburg time:
 * The Johannesburg-local date if it's a business day before the cut-off, otherwise the next business day.
 */
export function actionDateFor(
  now: Date | string = new Date(),
  options: ActionDateOptions = {},
): string {
  const cutOff = options.cutOff ?? "15:00";
  const dt = getJohannesburgDateTime(now);
  const isBiz = isBusinessDay(dt.dateString, options.extraHolidays);

  const [cutHour, cutMinute = 0] = cutOff.split(":").map(Number);
  const localMs =
    ((dt.hour * 60 + dt.minute) * 60 + dt.second) * 1000 + dt.millisecond;
  const cutOffMs = (cutHour * 60 + cutMinute) * 60 * 1000;
  const isBeforeCutOff = localMs < cutOffMs;

  if (isBiz && isBeforeCutOff) {
    return dt.dateString;
  }
  return nextBusinessDay(dt.dateString, options.extraHolidays);
}
