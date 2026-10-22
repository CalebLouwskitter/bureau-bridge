import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionDateFor,
  easterSunday,
  isBusinessDay,
  nextBusinessDay,
  southAfricanPublicHolidays,
} from "../src/business-calendar.ts";

test("Easter Sunday and derived Good Friday / Family Day cross-checked for 2025, 2026 and 2027", () => {
  // Hand-verified via the anonymous Gregorian algorithm:
  // 2025: Easter Sunday 20 Apr -> Good Friday 18 Apr, Family Day 21 Apr
  // 2026: Easter Sunday 5 Apr  -> Good Friday 3 Apr,  Family Day 6 Apr
  // 2027: Easter Sunday 28 Mar -> Good Friday 26 Mar, Family Day 29 Mar
  assert.equal(easterSunday(2025), "2025-04-20");
  assert.equal(easterSunday(2026), "2026-04-05");
  assert.equal(easterSunday(2027), "2027-03-28");

  const holidays2025 = southAfricanPublicHolidays(2025);
  assert.ok(holidays2025.has("2025-04-18"), "2025 Good Friday");
  assert.ok(holidays2025.has("2025-04-21"), "2025 Family Day");
  assert.equal(isBusinessDay("2025-04-18"), false);
  assert.equal(isBusinessDay("2025-04-21"), false);

  const holidays2026 = southAfricanPublicHolidays(2026);
  assert.ok(holidays2026.has("2026-04-03"), "2026 Good Friday");
  assert.ok(holidays2026.has("2026-04-06"), "2026 Family Day");
  assert.equal(isBusinessDay("2026-04-03"), false);
  assert.equal(isBusinessDay("2026-04-06"), false);

  const holidays2027 = southAfricanPublicHolidays(2027);
  assert.ok(holidays2027.has("2027-03-26"), "2027 Good Friday");
  assert.ok(holidays2027.has("2027-03-29"), "2027 Family Day");
  assert.equal(isBusinessDay("2027-03-26"), false);
  assert.equal(isBusinessDay("2027-03-29"), false);

  // Thursday before Good Friday advances across the Easter weekend to Tuesday
  assert.equal(nextBusinessDay("2025-04-17"), "2025-04-22");
  assert.equal(nextBusinessDay("2026-04-02"), "2026-04-07");
  assert.equal(nextBusinessDay("2027-03-25"), "2027-03-30");
});

test("Public Holidays Act Sunday-to-Monday shifts", () => {
  // 2025: Freedom Day 27 Apr is Sunday -> Monday 28 Apr is a public holiday
  const holidays2025 = southAfricanPublicHolidays(2025);
  assert.ok(holidays2025.has("2025-04-27"), "Freedom Day Sunday");
  assert.ok(holidays2025.has("2025-04-28"), "Freedom Day Monday observed");
  assert.equal(isBusinessDay("2025-04-27"), false);
  assert.equal(isBusinessDay("2025-04-28"), false);
  assert.equal(nextBusinessDay("2025-04-25"), "2025-04-29");

  // 2026: National Women's Day 9 Aug is Sunday -> Monday 10 Aug is a public holiday
  const holidays2026 = southAfricanPublicHolidays(2026);
  assert.ok(holidays2026.has("2026-08-09"), "Women's Day Sunday");
  assert.ok(holidays2026.has("2026-08-10"), "Women's Day Monday observed");
  assert.equal(isBusinessDay("2026-08-09"), false);
  assert.equal(isBusinessDay("2026-08-10"), false);
  assert.equal(nextBusinessDay("2026-08-07"), "2026-08-11");

  // 2027: Human Rights Day 21 Mar is Sunday -> Monday 22 Mar is observed
  // and Day of Goodwill 26 Dec is Sunday -> Monday 27 Dec is observed
  const holidays2027 = southAfricanPublicHolidays(2027);
  assert.ok(holidays2027.has("2027-03-21"), "Human Rights Day Sunday");
  assert.ok(holidays2027.has("2027-03-22"), "Human Rights Day Monday observed");
  assert.equal(isBusinessDay("2027-03-22"), false);
  assert.ok(holidays2027.has("2027-12-26"), "Day of Goodwill Sunday");
  assert.ok(holidays2027.has("2027-12-27"), "Day of Goodwill Monday observed");
  assert.equal(isBusinessDay("2027-12-27"), false);
});

test("weekends are never business days and roll to Monday", () => {
  // 2026-10-23 is Friday, 2026-10-24 is Saturday, 2026-10-25 is Sunday, 2026-10-26 is Monday
  assert.equal(isBusinessDay("2026-10-23"), true);
  assert.equal(isBusinessDay("2026-10-24"), false);
  assert.equal(isBusinessDay("2026-10-25"), false);
  assert.equal(isBusinessDay("2026-10-26"), true);

  assert.equal(nextBusinessDay("2026-10-23"), "2026-10-26");
  assert.equal(nextBusinessDay("2026-10-24"), "2026-10-26");
  assert.equal(nextBusinessDay("2026-10-25"), "2026-10-26");
});

test("cut-off boundary: 14:59 vs 15:00 Johannesburg local time", () => {
  // Johannesburg is UTC+2 all year round.
  // 14:59 local is 12:59 UTC; 15:00 local is 13:00 UTC.
  // On Wednesday 2026-10-21:
  const beforeCutoff = new Date("2026-10-21T12:59:59.999Z");
  assert.equal(
    actionDateFor(beforeCutoff, { cutOff: "15:00" }),
    "2026-10-21",
    "14:59:59 local is before cut-off -> today",
  );

  const atCutoff = new Date("2026-10-21T13:00:00.000Z");
  assert.equal(
    actionDateFor(atCutoff, { cutOff: "15:00" }),
    "2026-10-22",
    "15:00:00 local has reached cut-off -> next business day",
  );

  const afterCutoff = new Date("2026-10-21T13:00:01.000Z");
  assert.equal(
    actionDateFor(afterCutoff, { cutOff: "15:00" }),
    "2026-10-22",
    "15:00:01 local is past cut-off -> next business day",
  );

  // On Friday 2026-10-23, cut-off rolls to Monday 2026-10-26:
  const fridayBefore = new Date("2026-10-23T12:59:00.000Z");
  assert.equal(actionDateFor(fridayBefore, { cutOff: "15:00" }), "2026-10-23");

  const fridayAtCutoff = new Date("2026-10-23T13:00:00.000Z");
  assert.equal(
    actionDateFor(fridayAtCutoff, { cutOff: "15:00" }),
    "2026-10-26",
    "Friday at cut-off rolls over weekend to Monday",
  );
});

test("year end: 24 Dec -> 29 Dec chains across Christmas and Goodwill", () => {
  // In 2025:
  // 24 Dec: Wednesday (business day)
  // 25 Dec: Thursday (Christmas Day, public holiday)
  // 26 Dec: Friday (Day of Goodwill, public holiday)
  // 27 Dec: Saturday (weekend)
  // 28 Dec: Sunday (weekend)
  // 29 Dec: Monday (business day)
  assert.equal(
    nextBusinessDay("2025-12-24"),
    "2025-12-29",
    "Next business day after 24 Dec 2025 is 29 Dec",
  );

  // Wednesday 24 Dec 2025 before 15:00 local (12:59 UTC)
  assert.equal(
    actionDateFor(new Date("2025-12-24T12:59:00Z")),
    "2025-12-24",
  );

  // Wednesday 24 Dec 2025 at 15:00 local (13:00 UTC) rolls across all holidays/weekends to 29 Dec
  assert.equal(
    actionDateFor(new Date("2025-12-24T13:00:00Z")),
    "2025-12-29",
  );

  // Submissions on 25 Dec, 26 Dec, 27 Dec or 28 Dec all land on 29 Dec
  assert.equal(actionDateFor(new Date("2025-12-25T08:00:00Z")), "2025-12-29");
  assert.equal(actionDateFor(new Date("2025-12-26T08:00:00Z")), "2025-12-29");
  assert.equal(actionDateFor(new Date("2025-12-27T08:00:00Z")), "2025-12-29");
  assert.equal(actionDateFor(new Date("2025-12-28T08:00:00Z")), "2025-12-29");
});

test("UTC vs local midnight in Africa/Johannesburg", () => {
  // Africa/Johannesburg is UTC+2.
  // Local midnight (00:00:00 on Thursday 2026-10-22) is 22:00:00 UTC on Wednesday 2026-10-21.
  const localMidnight = new Date("2026-10-21T22:00:00.000Z");
  assert.equal(
    actionDateFor(localMidnight),
    "2026-10-22",
    "Local midnight starts Thursday in Johannesburg",
  );

  // One second before local midnight is 23:59:59 on Wednesday 2026-10-21 (after 15:00 cut-off)
  const beforeLocalMidnight = new Date("2026-10-21T21:59:59.000Z");
  assert.equal(
    actionDateFor(beforeLocalMidnight),
    "2026-10-22",
    "Late Wednesday evening local rolls to Thursday",
  );

  // UTC midnight (00:00:00 UTC on Thursday 2026-10-22) is 02:00:00 local on Thursday 2026-10-22
  const utcMidnight = new Date("2026-10-22T00:00:00.000Z");
  assert.equal(
    actionDateFor(utcMidnight),
    "2026-10-22",
    "UTC midnight is already 02:00 local on Thursday",
  );

  // Sunday night UTC crossing into Monday local:
  // 2026-10-25T21:59:00Z is 23:59 Sunday local -> next business day is Monday 2026-10-26
  assert.equal(
    actionDateFor(new Date("2026-10-25T21:59:00Z")),
    "2026-10-26",
  );
  // 2026-10-25T22:00:00Z is 00:00 Monday local -> Monday business day before cut-off -> 2026-10-26
  assert.equal(
    actionDateFor(new Date("2026-10-25T22:00:00Z")),
    "2026-10-26",
  );
});

test("extraHolidays: proclaimed one-off public holidays are honored without hard-coding", () => {
  // Proclaimed special holiday: e.g. national election day 2024-05-29 (Wednesday)
  const extra = ["2024-05-29"];
  assert.equal(isBusinessDay("2024-05-29"), true, "Without extraHolidays");
  assert.equal(isBusinessDay("2024-05-29", extra), false, "With extraHolidays");
  assert.equal(nextBusinessDay("2024-05-28", extra), "2024-05-30");

  // Tuesday 28 May 2024 at 16:00 local (14:00 UTC) rolls past the proclaimed holiday to 30 May
  assert.equal(
    actionDateFor(new Date("2024-05-28T14:00:00Z"), { extraHolidays: extra }),
    "2024-05-30",
  );
});
