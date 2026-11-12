// The quick-add parser (Phase 4, D-72 through D-87). A pure function of
// (input string, config, an injected `now` in milliseconds) — no clock
// reads, no I/O, no browser global (D-86). Same discipline public/urgency.js
// already holds, and for the same reason: it is what makes every ambiguity
// case in test/capture-parse.test.js assertable without freezing real time,
// and what keeps this module importable unchanged by both Safari and
// `node --test`.
//
// The parser returns what it consumed AND what it ignored (D-87) — never
// just a task. An ambiguous or unrecognised fragment is never guessed into
// a date (D-85): it stays in the title, verbatim, and the field it would
// have filled stays null. A misread date is the one capture error that does
// real damage — it silently moves a deadline, and the user finds out when
// it matters (D-73) — so this module would rather say nothing than guess.
//
// 04-01 shipped the sigil tokens (`!priority`, `#project`, `~effort`) and
// exactly one date form — a bare weekday, optionally followed by a clock
// time. 04-02 (this plan) fills in the rest of D-75's vocabulary — `next
// <weekday>`, month+day and numeric dates, relative spans (`in 2 weeks`),
// relative days (`today`/`tomorrow`/`tonight`), and a bare time alone —
// behind the SAME dispatch structure: Pass 2 offers each resolver a small
// forward window of unconsumed tokens (three is enough for every phrase
// D-75 names) and lets it claim as many as it matches, reporting one
// consumed span covering all of them. The `ParseResult` contract is
// unchanged; only the resolver list inside Pass 2 grew.

// Same values as config/task-model.json's `capture` block. Independent of
// lib/task-model.js's BUILTIN_CAPTURE by necessity — that module imports
// Node's filesystem and cannot be resolved by a browser with no bundler.
export const DEFAULT_CAPTURE = Object.freeze({
  defaultDueTime: '23:59',
  maxInputLength: 1000,
  maxTitleLength: 500,
});

// The vocabulary of `consumed[].kind`. Unchanged from 04-01 — 04-02 reuses
// 'date' (no explicit clock time attached; the hour/minute came from
// config.capture.defaultDueTime), 'datetime' (an explicit clock time was
// consumed alongside the date), and 'time' (a bare time with no date form
// attached, D-83) for every new resolver rather than inventing new kinds.
export const CAPTURE_TOKEN_KINDS = Object.freeze(['datetime', 'date', 'time', 'priority', 'project', 'effort']);

// Fixed in code, same as lib/task-model.js's EFFORT_KEYS/PRIORITIES — the
// vocabulary is not user-extensible, only the label/hours/leadDays per
// bucket are (config/task-model.json). Declared locally rather than
// imported for the same reason DEFAULT_CAPTURE is: no node:* resolution in
// a browser.
const EFFORT_KEYS = ['quick', 'short', 'medium', 'long', 'huge'];
const PRIORITIES = ['low', 'normal', 'high'];

// The built-in hours-per-bucket table, used only as a per-key fallback when
// `config.effort` is absent, half-written, or missing an entry — the same
// defence in depth every config-reading module in this project already
// applies (D-28). A caller with a real config always overrides this per key.
const DEFAULT_EFFORT_HOURS = { quick: 0.25, short: 1, medium: 3, long: 6, huge: 12 };

// mon..sun, full and short forms, case-insensitive. `hasOwnProperty` is
// checked (never a bare `WEEKDAY_INDEX[key]`) so a token spelled
// "__proto__" or "constructor" cannot read an inherited value off this
// plain object literal and be mistaken for a real weekday match.
const WEEKDAY_INDEX = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// jan..dec, full and common abbreviated forms, case-insensitive (a trailing
// "." is stripped before lookup — see monthIndex). Held as a fixed list in
// code, not in config: English month names are not something the user needs
// to tune, and a config-editable list invites a half-edited one that
// silently loses a month. Same hasOwnProperty discipline as WEEKDAY_INDEX
// (T-04-03).
const MONTH_INDEX = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

// "in <count> <unit>" — the relative-span form (D-75). Only `day(s)` and
// `week(s)` are recognised; any other unit ("fortnights") is a genuinely
// date-shaped fragment the resolver could not settle, not a guess (D-85).
const RELATIVE_UNIT_DAYS = { day: 1, days: 1, week: 7, weeks: 7 };

// today/tonight both anchor to today's calendar date; tomorrow to the next.
// `tonight` deliberately uses the same `defaultDueTime` as every other
// dateless form rather than a separate "evening hour" — D-84 already names
// one configurable default for "a date with no time," and a second
// evening-specific config value would be an unrequested config surface for
// one word. Documented here so a future reader does not "fix" it by adding
// one.
const RELATIVE_DAY_OFFSET = { today: 0, tonight: 0, tomorrow: 1 };

// A hand-rolled parser is a classic place for catastrophic backtracking
// (T-04-01). Every pattern below is anchored (`^...$`) and contains at most
// one quantified group per alternative — never a quantified group that
// itself repeats — so no pattern here can exhibit exponential backtracking
// regardless of input.
const DEFAULT_DUE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CLOCK_24H_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const CLOCK_12H_PATTERN = /^(1[0-2]|0?[1-9])(?::([0-5]\d))?(am|pm)$/i;
const HOURS_SUFFIX_PATTERN = /^(\d+(?:\.\d+)?)h$/;
const MINUTES_SUFFIX_PATTERN = /^(\d+(?:\.\d+)?)m$/;
// A day-of-month token, with an optional ordinal suffix ("3", "3rd") — used
// by both month-then-day ("sept 3rd") and day-then-month ("3rd sept").
const DAY_TOKEN_PATTERN = /^(\d{1,2})(?:st|nd|rd|th)?$/i;
// Month-first numeric date: "9/3", "9/3/26", "9/3/2026" (D-75, T-04-10).
// Never day-first — that decision is enforced where this pattern is used,
// not in the pattern itself.
const NUMERIC_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;

// A cap on tokens scanned (T-04-01), independent of `maxInputLength` — a
// config hand-edited to raise maxInputLength must not also remove the token
// cap. In practice the default maxInputLength (1000 characters) already
// bounds token count well below this; this is defence in depth, not the
// primary guard.
const MAX_TOKENS = 2000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 1 && value <= 100000;
}

/**
 * The browser-side per-key mirror of lib/task-model.js's server-side
 * `capture` validation (T-04-09) — the same defence in depth
 * `normalizeUrgencyConfig` already applies to `urgency`, so a half-written
 * config reaching the page through GET /api/config still yields finite,
 * usable values. Never throws.
 */
export function normalizeCaptureConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    defaultDueTime: typeof src.defaultDueTime === 'string' && DEFAULT_DUE_TIME_PATTERN.test(src.defaultDueTime)
      ? src.defaultDueTime
      : DEFAULT_CAPTURE.defaultDueTime,
    maxInputLength: isPositiveInteger(src.maxInputLength) ? src.maxInputLength : DEFAULT_CAPTURE.maxInputLength,
    maxTitleLength: isPositiveInteger(src.maxTitleLength) ? src.maxTitleLength : DEFAULT_CAPTURE.maxTitleLength,
  };
}

/** The effective `capture` config for this call — DEFAULT_CAPTURE when `config` carries no usable block at all (an unreachable or older GET /api/config must never break capture). */
function getCaptureConfig(config) {
  if (isPlainObject(config) && isPlainObject(config.capture)) {
    return normalizeCaptureConfig(config.capture);
  }
  return { ...DEFAULT_CAPTURE };
}

/** `config.effort[key].hours` for every bucket, falling back per key to DEFAULT_EFFORT_HOURS — never reads a dynamic/hostile key, only the five fixed EFFORT_KEYS names. */
function getEffortHoursTable(config) {
  const src = isPlainObject(config) && isPlainObject(config.effort) ? config.effort : {};
  const table = {};
  for (const key of EFFORT_KEYS) {
    const entry = src[key];
    table[key] = entry && isFiniteNumber(entry.hours) && entry.hours > 0 ? entry.hours : DEFAULT_EFFORT_HOURS[key];
  }
  return table;
}

/**
 * `~<bucket-key>` matches a bucket name directly; `~<number>h` or
 * `~<number>m` converts to hours and picks the bucket whose `hours` value
 * in `config` is nearest, a tie going to the larger bucket (D-78). Deriving
 * from the config's own hours column — rather than a second table — means a
 * user editing the effort table also moves what `~3h` means, with no code
 * change.
 *
 * Deliberately does NOT treat a bare number with no unit as hours: which
 * unit the user meant (hours? minutes? something else entirely) is exactly
 * the kind of fragment D-85 exists to leave alone rather than guess.
 *
 * Returns an effort key, or null when the fragment does not resolve.
 */
export function resolveEffortToken(text, config) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  const lower = text.toLowerCase();
  if (EFFORT_KEYS.includes(lower)) {
    return lower;
  }

  let hours = null;
  const hoursMatch = HOURS_SUFFIX_PATTERN.exec(lower);
  if (hoursMatch) {
    hours = Number(hoursMatch[1]);
  } else {
    const minutesMatch = MINUTES_SUFFIX_PATTERN.exec(lower);
    if (minutesMatch) {
      hours = Number(minutesMatch[1]) / 60;
    }
  }
  if (hours === null || !Number.isFinite(hours) || hours <= 0) {
    return null;
  }

  const table = getEffortHoursTable(config);
  let bestKey = null;
  let bestDiff = Infinity;
  for (const key of EFFORT_KEYS) {
    const diff = Math.abs(table[key] - hours);
    if (diff < bestDiff || (diff === bestDiff && bestKey !== null && table[key] > table[bestKey])) {
      bestDiff = diff;
      bestKey = key;
    }
  }
  return bestKey;
}

/**
 * `!<word>` matches a priority name case-insensitively against the three
 * levels D-76 names. Returns a priority key, or null when the fragment does
 * not resolve.
 */
function resolvePriorityToken(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const lower = text.toLowerCase();
  return PRIORITIES.includes(lower) ? lower : null;
}

/**
 * `5pm`, `5:30pm`, `17:00`, `noon`, `midnight` -> `{ hour, minute }`; null
 * for anything else (T-04-01: both regex patterns are anchored with a
 * single quantified group, never nested, so neither can backtrack
 * catastrophically; `noon`/`midnight` are plain literal comparisons, not
 * patterns, so they add no backtracking surface at all).
 */
export function parseClockTime(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const lower = text.toLowerCase();
  if (lower === 'noon') {
    return { hour: 12, minute: 0 };
  }
  if (lower === 'midnight') {
    return { hour: 0, minute: 0 };
  }

  const h24 = CLOCK_24H_PATTERN.exec(text);
  if (h24) {
    return { hour: Number(h24[1]), minute: Number(h24[2]) };
  }

  const h12 = CLOCK_12H_PATTERN.exec(text);
  if (h12) {
    let hour = Number(h12[1]);
    const minute = h12[2] ? Number(h12[2]) : 0;
    const suffix = h12[3].toLowerCase();
    if (suffix === 'pm' && hour !== 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  return null;
}

/** `capture.defaultDueTime` ("HH:MM") -> `{ hour, minute }`. Always valid by construction (getCaptureConfig/normalizeCaptureConfig already enforce the shape); the fallback below is defence in depth only. */
function parseDefaultDueTime(value) {
  const m = DEFAULT_DUE_TIME_PATTERN.exec(value);
  if (!m) {
    return { hour: 23, minute: 59 };
  }
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** A token, lowercased, against WEEKDAY_INDEX — using hasOwnProperty so "__proto__"/"constructor" can never read an inherited value off the plain object literal (T-04-03). Returns 0 (Sunday) .. 6 (Saturday), or null. */
function weekdayIndex(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const key = text.toLowerCase();
  return Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, key) ? WEEKDAY_INDEX[key] : null;
}

/** A token against MONTH_INDEX, case-insensitively, with an optional trailing "." stripped first ("sept." -> "sept"). Same hasOwnProperty discipline as weekdayIndex (T-04-03). Returns 1 (January) .. 12 (December), or null. */
function monthIndex(text) {
  if (typeof text !== 'string') {
    return null;
  }
  let key = text.toLowerCase();
  if (key.endsWith('.')) {
    key = key.slice(0, -1);
  }
  return Object.prototype.hasOwnProperty.call(MONTH_INDEX, key) ? MONTH_INDEX[key] : null;
}

/**
 * Constructs a local date from explicit calendar fields and reads it back
 * through the local getters to confirm the fields survived unchanged — the
 * same rollover guard public/format.js's localInputToIso uses against a JS
 * Date silently sliding an impossible calendar date (Sept 31, Feb 30)
 * forward into a different one. Returns null when the date is impossible;
 * never guesses a nearby valid date instead (D-85).
 */
function buildValidLocalDate(year, month, day, hour, minute) {
  const candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    Number.isNaN(candidate.getTime()) ||
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }
  return candidate;
}

/**
 * The next future occurrence of local weekday `targetDow` at `hour:minute`
 * (D-81): includes today when today IS that weekday and the stated time has
 * not yet passed; otherwise rolls forward to next week. Built with the
 * local-time Date constructor and read with local getters throughout — UTC
 * arithmetic anywhere here is the bug D-80 exists to prevent.
 */
function resolveWeekdayDate(nowMs, targetDow, hour, minute) {
  const now = new Date(nowMs);
  const nowDow = now.getDay();
  const diffDays = (targetDow - nowDow + 7) % 7;

  let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffDays, hour, minute, 0, 0);
  if (diffDays === 0 && candidate.getTime() <= nowMs) {
    candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, hour, minute, 0, 0);
  }
  return candidate;
}

/**
 * `next <weekday>` (D-82): the occurrence in the FOLLOWING week, never
 * today, regardless of the time attached. Unlike resolveWeekdayDate, this
 * never checks whether the stated time has already passed — "next"
 * overrides D-81's equal-is-not-future nuance entirely; the only question
 * is whether today itself is that weekday, in which case the diff is forced
 * from 0 to 7.
 */
function resolveNextWeekdayDate(nowMs, targetDow, hour, minute) {
  const now = new Date(nowMs);
  const nowDow = now.getDay();
  let diffDays = (targetDow - nowDow + 7) % 7;
  if (diffDays === 0) {
    diffDays = 7;
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffDays, hour, minute, 0, 0);
}

/**
 * A local calendar date reached by adding `offsetDays` whole calendar days
 * to `now`'s local date — used for today/tomorrow/tonight (offset 0 or 1)
 * and for the relative-span form ("in 2 weeks", offset 14). Adds to the
 * local day-of-month field and lets the Date constructor resolve the
 * correct instant, never to milliseconds — a day is not always 86,400,000ms
 * long, and assuming so is the D-80 failure this file exists to avoid
 * (proven by the DST-crossing test).
 */
function resolveOffsetDays(nowMs, offsetDays, hour, minute) {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, hour, minute, 0, 0);
}

/**
 * A bare time with no date attached (D-83): today if `hour:minute` has not
 * yet passed, otherwise tomorrow. Equal-to-now is not future, same rule as
 * D-81's weekday-plus-time form.
 */
function resolveBareTime(nowMs, hour, minute) {
  const now = new Date(nowMs);
  let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() <= nowMs) {
    candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute, 0, 0);
  }
  return candidate;
}

/**
 * The next future occurrence of calendar date `month`/`day` (D-75's
 * month+day and year-less numeric forms): this year if that date, at
 * `hour:minute`, is still ahead; next year if it has already passed or is
 * impossible this year (e.g. Feb 29 on a non-leap year). Returns null when
 * the date is impossible in both candidate years (Sept 31, Feb 30) — never
 * slides it into a neighbouring valid date (D-85).
 */
function resolveMonthDayOccurrence(nowMs, month, day, hour, minute) {
  const now = new Date(nowMs);
  const year = now.getFullYear();
  const thisYear = buildValidLocalDate(year, month, day, hour, minute);
  if (thisYear !== null && thisYear.getTime() > nowMs) {
    return thisYear;
  }
  return buildValidLocalDate(year + 1, month, day, hour, minute);
}

/** Whitespace-delimited runs with their offsets into `input`, capped at `maxTokens` (T-04-01). A plain `/\S+/g` scan — no nested quantifiers, no backtracking risk regardless of input shape. */
function tokenize(input, maxTokens) {
  const tokens = [];
  const re = /\S+/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    if (tokens.length >= maxTokens) {
      break;
    }
  }
  return tokens;
}

/** Remove every `consumed` span from `input` and collapse whitespace — the title (D-79). `ignored` spans are never touched (D-85). */
function buildTitle(input, consumed) {
  const sorted = [...consumed].sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  for (const span of sorted) {
    result += input.slice(cursor, span.start);
    cursor = span.end;
  }
  result += input.slice(cursor);
  return result.replace(/\s+/g, ' ').trim();
}

function refuse(message) {
  return {
    ok: false,
    invalid: message,
    title: '',
    fields: { dueAt: null, effort: null, priority: null, project: null },
    consumed: [],
    ignored: [],
  };
}

// ---------------------------------------------------------------------------
// Pass 2 date resolvers — each is offered the token at `idx` (and, through
// `tokens`, a look-ahead window) and either declines (returns null), flags a
// genuinely date-shaped fragment it could not settle (`invalidSpan`, D-85),
// or claims a run of tokens ending at `baseEndIdx` and hands back a
// `compute(nowMs, hour, minute)` callback that resolves the final instant
// once a trailing time token (or the config default) is known. Keeping the
// "claim the date, resolve the time after" split lets every resolver here
// share the exact same trailing-time-or-default step Pass 2 already applies,
// rather than each reimplementing it (T-04-01: no resolver here does more
// than a handful of anchored, single-quantifier regex tests per token, so
// the whole dispatch stays linear in the number of tokens).
// ---------------------------------------------------------------------------

/** `next <weekday>` (D-82). */
function matchNextWeekday(tokens, idx, consumedTokenIdx) {
  if (tokens[idx].text.toLowerCase() !== 'next') {
    return null;
  }
  const weekdayIdx = idx + 1;
  if (weekdayIdx >= tokens.length || consumedTokenIdx.has(weekdayIdx)) {
    return null;
  }
  const dow = weekdayIndex(tokens[weekdayIdx].text);
  if (dow === null) {
    return null;
  }
  return { baseEndIdx: weekdayIdx, compute: (nowMs, hour, minute) => resolveNextWeekdayDate(nowMs, dow, hour, minute) };
}

/** `in <count> <day|days|week|weeks>`, `in a week` (D-75's relative span). */
function matchRelativeSpan(tokens, idx, consumedTokenIdx) {
  if (tokens[idx].text.toLowerCase() !== 'in') {
    return null;
  }
  const countIdx = idx + 1;
  if (countIdx >= tokens.length || consumedTokenIdx.has(countIdx)) {
    return null;
  }
  const countText = tokens[countIdx].text.toLowerCase();
  let count = null;
  if (countText === 'a' || countText === 'an') {
    count = 1;
  } else if (/^\d{1,3}$/.test(countText)) {
    count = Number(countText);
  } else {
    return null; // "in" alone is not date-shaped enough to flag as ignored.
  }

  const unitIdx = countIdx + 1;
  if (unitIdx >= tokens.length || consumedTokenIdx.has(unitIdx)) {
    return null;
  }
  const unitText = tokens[unitIdx].text.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(RELATIVE_UNIT_DAYS, unitText)) {
    return {
      invalidSpan: { start: tokens[idx].start, end: tokens[unitIdx].end },
      reason: 'unrecognised-date-unit',
    };
  }

  const offsetDays = count * RELATIVE_UNIT_DAYS[unitText];
  return { baseEndIdx: unitIdx, compute: (nowMs, hour, minute) => resolveOffsetDays(nowMs, offsetDays, hour, minute) };
}

/** `<month name> <day>[ordinal]` — "sept 3", "september 3rd". */
function matchMonthNameDay(tokens, idx, consumedTokenIdx) {
  const month = monthIndex(tokens[idx].text);
  if (month === null) {
    return null;
  }
  const dayIdx = idx + 1;
  if (dayIdx >= tokens.length || consumedTokenIdx.has(dayIdx)) {
    return null;
  }
  const dayMatch = DAY_TOKEN_PATTERN.exec(tokens[dayIdx].text);
  if (!dayMatch) {
    return null;
  }
  const day = Number(dayMatch[1]);
  if (day < 1 || day > 31) {
    return { invalidSpan: { start: tokens[idx].start, end: tokens[dayIdx].end }, reason: 'invalid-date' };
  }
  return {
    baseEndIdx: dayIdx,
    compute: (nowMs, hour, minute) => resolveMonthDayOccurrence(nowMs, month, day, hour, minute),
  };
}

/** `<day>[ordinal] <month name>` — "3 sept", "3rd sept". */
function matchDayMonthName(tokens, idx, consumedTokenIdx) {
  const dayMatch = DAY_TOKEN_PATTERN.exec(tokens[idx].text);
  if (!dayMatch) {
    return null;
  }
  const monthIdx = idx + 1;
  if (monthIdx >= tokens.length || consumedTokenIdx.has(monthIdx)) {
    return null;
  }
  const month = monthIndex(tokens[monthIdx].text);
  if (month === null) {
    return null;
  }
  const day = Number(dayMatch[1]);
  if (day < 1 || day > 31) {
    return { invalidSpan: { start: tokens[idx].start, end: tokens[monthIdx].end }, reason: 'invalid-date' };
  }
  return {
    baseEndIdx: monthIdx,
    compute: (nowMs, hour, minute) => resolveMonthDayOccurrence(nowMs, month, day, hour, minute),
  };
}

/** `9/3`, `9/3/26`, `9/3/2026` — month first, always (T-04-10). A first component above 12 is a genuinely date-shaped fragment that fails to resolve, never reinterpreted day-first. */
function matchNumericDate(tokens, idx) {
  const m = NUMERIC_DATE_PATTERN.exec(tokens[idx].text);
  if (!m) {
    return null;
  }
  const month = Number(m[1]);
  const day = Number(m[2]);
  const start = tokens[idx].start;
  const end = tokens[idx].end;

  if (month < 1 || month > 12) {
    // This is the exact defect D-85/T-04-10 exist to prevent: a numeric
    // form whose first component cannot be a month never becomes a
    // day-first guess. It fails to resolve and is flagged, full stop.
    return { invalidSpan: { start, end }, reason: 'invalid-date' };
  }
  if (day < 1 || day > 31) {
    return { invalidSpan: { start, end }, reason: 'invalid-date' };
  }

  let year = null;
  if (m[3]) {
    year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  }

  return {
    baseEndIdx: idx,
    compute: (nowMs, hour, minute) => (year !== null
      ? buildValidLocalDate(year, month, day, hour, minute)
      : resolveMonthDayOccurrence(nowMs, month, day, hour, minute)),
  };
}

/** `today`, `tomorrow`, `tonight`. */
function matchRelativeDayWord(tokens, idx) {
  const key = tokens[idx].text.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(RELATIVE_DAY_OFFSET, key)) {
    return null;
  }
  const offsetDays = RELATIVE_DAY_OFFSET[key];
  return { baseEndIdx: idx, compute: (nowMs, hour, minute) => resolveOffsetDays(nowMs, offsetDays, hour, minute) };
}

/** A bare weekday (D-81) — 04-01's original resolver, unchanged, now one entry in the dispatch list rather than the only one. */
function matchBareWeekday(tokens, idx) {
  const dow = weekdayIndex(tokens[idx].text);
  if (dow === null) {
    return null;
  }
  return { baseEndIdx: idx, compute: (nowMs, hour, minute) => resolveWeekdayDate(nowMs, dow, hour, minute) };
}

/** A bare time with no date attached (D-83) — `5pm`, `17:00`, `noon`. Tried last, and only reaches a token none of the date-shaped resolvers above claimed. */
function matchBareTime(tokens, idx) {
  const time = parseClockTime(tokens[idx].text);
  if (time === null) {
    return null;
  }
  return { baseEndIdx: idx, timeOnly: true, time };
}

// Order mostly does not matter — each resolver's trigger word or shape is
// disjoint from the others (only a distinct leading token/pattern reaches
// each one) — except that matchNextWeekday must be tried before a bare
// weekday could ever be reached standalone at the SAME index, which the
// sequential idx scan already guarantees: "next" is always visited before
// the weekday token that follows it, so a successful next-weekday match
// consumes both tokens before the scan ever reaches the weekday alone. This
// is exactly what fixes the "next friday" partial-match defect (D-82):
// without a next-weekday resolver, "friday" would be reached on its own by
// matchBareWeekday and "next" would be orphaned into the title.
const DATE_RESOLVERS = [
  matchNextWeekday,
  matchRelativeSpan,
  matchMonthNameDay,
  matchDayMonthName,
  matchNumericDate,
  matchRelativeDayWord,
  matchBareWeekday,
  matchBareTime,
];

/**
 * Parse one typed capture line into a ParseResult (the frozen contract
 * 04-02 and 04-03 both build on):
 *
 *   {
 *     ok, invalid, title,
 *     fields: { dueAt, effort, priority, project },
 *     consumed: [{ kind, text, start, end, value }],
 *     ignored:  [{ text, start, end, reason }],
 *   }
 *
 * Pure: reads no clock (every instant comes from `nowMs`), performs no I/O,
 * touches no browser global (D-86). Never throws — a non-string `input`, or
 * a missing/malformed `config`, resolves against DEFAULT_CAPTURE rather
 * than throwing.
 */
export function parseCapture(input, config, nowMs) {
  const capture = getCaptureConfig(config);

  if (typeof input !== 'string') {
    return refuse('Type something to capture.');
  }
  if (input.length > capture.maxInputLength) {
    return refuse(`That line is too long to capture — keep it under ${capture.maxInputLength} characters.`);
  }

  const tokens = tokenize(input, MAX_TOKENS);
  const consumed = [];
  const ignored = [];
  const consumedTokenIdx = new Set();

  let priority = null;
  let project = null;
  let effort = null;

  // Pass 1 — the three sigil tokens. Each is a single whitespace-delimited
  // token; later matches of the same kind overwrite earlier ones (all are
  // still consumed and removed from the title either way), so the title
  // never carries a fragment the confirm step also shows as a resolved
  // field.
  tokens.forEach((tok, idx) => {
    const t = tok.text;
    if (t.length <= 1) {
      return;
    }

    if (t[0] === '!') {
      const resolved = resolvePriorityToken(t.slice(1));
      if (resolved !== null) {
        priority = resolved;
        consumed.push({ kind: 'priority', text: t, start: tok.start, end: tok.end, value: resolved });
        consumedTokenIdx.add(idx);
      } else {
        ignored.push({ text: t, start: tok.start, end: tok.end, reason: 'unknown-priority' });
      }
      return;
    }

    if (t[0] === '#') {
      // Free-form (D-77) — always resolves. Assigned to the named `project`
      // property only, never as a computed key (T-04-03): a token whose
      // text is a dangerous property name becomes a plain string value
      // here, nothing more.
      project = t.slice(1);
      consumed.push({ kind: 'project', text: t, start: tok.start, end: tok.end, value: project });
      consumedTokenIdx.add(idx);
      return;
    }

    if (t[0] === '~') {
      const resolved = resolveEffortToken(t.slice(1), config);
      if (resolved !== null) {
        effort = resolved;
        consumed.push({ kind: 'effort', text: t, start: tok.start, end: tok.end, value: resolved });
        consumedTokenIdx.add(idx);
      } else {
        ignored.push({ text: t, start: tok.start, end: tok.end, reason: 'unknown-effort' });
      }
      return;
    }
  });

  // Pass 2 — exactly one date, resolved by the first DATE_RESOLVERS entry
  // that claims a run of tokens starting at the current index. Ordinary
  // words that merely LOOK date-adjacent ("week 3", "TBD", "end of term")
  // never reach a claim at all — they simply are not any resolver's
  // trigger shape, so they are never flagged ignored either; only a sigil
  // that opened and failed, or a genuinely date-shaped fragment a resolver
  // recognised but could not resolve (an impossible calendar date, an
  // unrecognised relative-span unit), earns an `ignored` entry (D-85,
  // D-87).
  let dueAt = null;
  outer:
  for (let idx = 0; idx < tokens.length; idx++) {
    if (consumedTokenIdx.has(idx)) {
      continue;
    }

    for (const matcher of DATE_RESOLVERS) {
      const result = matcher(tokens, idx, consumedTokenIdx);
      if (result === null) {
        continue;
      }

      if (result.invalidSpan) {
        const { start, end } = result.invalidSpan;
        ignored.push({ text: input.slice(start, end), start, end, reason: result.reason });
        break; // this index is settled (as a failure); move to the next.
      }

      if (result.timeOnly) {
        const candidate = resolveBareTime(nowMs, result.time.hour, result.time.minute);
        const start = tokens[idx].start;
        const end = tokens[result.baseEndIdx].end;
        dueAt = candidate.toISOString();
        consumed.push({ kind: 'time', text: input.slice(start, end), start, end, value: dueAt });
        consumedTokenIdx.add(idx);
        break outer; // exactly one date resolved per input.
      }

      // A date-shaped match — look for a trailing clock time in the very
      // next unconsumed token (the same "claim the date, then the time"
      // step every date resolver above shares); fall back to the
      // configured default when none is attached (D-84).
      let endIdx = result.baseEndIdx;
      let time = null;
      const trailingIdx = endIdx + 1;
      if (trailingIdx < tokens.length && !consumedTokenIdx.has(trailingIdx)) {
        time = parseClockTime(tokens[trailingIdx].text);
        if (time !== null) {
          endIdx = trailingIdx;
        }
      }

      const { hour, minute } = time ?? parseDefaultDueTime(capture.defaultDueTime);
      const candidate = result.compute(nowMs, hour, minute);
      const start = tokens[idx].start;
      const end = tokens[endIdx].end;

      if (candidate === null) {
        // A genuinely date-shaped fragment (recognised month/day or
        // numeric form) that resolves to an impossible calendar date —
        // never guessed into a nearby valid one (D-85). The trailing time
        // token, if any, is NOT claimed here: the match failed, so nothing
        // about it was actually consumed.
        ignored.push({ text: input.slice(start, tokens[result.baseEndIdx].end), start, end: tokens[result.baseEndIdx].end, reason: 'invalid-date' });
        break;
      }

      const kind = time !== null ? 'datetime' : 'date';
      dueAt = candidate.toISOString();
      consumed.push({ kind, text: input.slice(start, end), start, end, value: dueAt });
      for (let i = idx; i <= endIdx; i++) {
        consumedTokenIdx.add(i);
      }
      break outer; // exactly one date resolved per input.
    }
  }

  const title = buildTitle(input, consumed);
  if (title.length > capture.maxTitleLength) {
    return refuse(`That title is too long — keep it under ${capture.maxTitleLength} characters.`);
  }

  return {
    ok: true,
    invalid: null,
    title,
    fields: { dueAt, effort, priority, project },
    consumed,
    ignored,
  };
}
