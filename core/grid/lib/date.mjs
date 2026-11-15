// Date serials in the 1900 and 1904 date systems.
// Translated from gridcraft crates/core/src/date.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The 1900 system keeps Excel's fictitious 29 February 1900 (serial 60). Upstream leans on chrono
// for the proleptic Gregorian calendar; here the same calendar is computed directly (exact for any
// integer day). Date systems are the numbers 1900 and 1904. No DOM, no Node built-ins.

export const D1900 = 1900;
export const D1904 = 1904;

const floorDiv = (a, b) => Math.floor(a / b);
const mod = (a, b) => ((a % b) + b) % b;

/** Whether y is a Gregorian leap year. */
export const isLeap = y => (mod(y, 4) === 0 && mod(y, 100) !== 0) || mod(y, 400) === 0;

/** Days in month m (1-12) of year y; 0 for a month outside 1..12. */
export function daysInMonth(y, m) {
  if (!(m >= 1 && m <= 12)) return 0;
  return m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
}
/** daysInMonth with the 1900 system's fictitious 29 February 1900. */
export const daysInMonthIn = (sys, y, m) => (sys === D1900 && y === 1900 && m === 2 ? 29 : daysInMonth(y, m));

/** Days since 1970-01-01 of y-m-d; 0 for an invalid date (as upstream's chrono fallback). */
export function daysFromCivil(y, m, d) {
  if (!(m >= 1 && m <= 12) || d < 1 || d > daysInMonth(y, m)) return 0;
  const yy = m <= 2 ? y - 1 : y;
  const era = floorDiv(yy, 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = floorDiv(153 * mp + 2, 5) + d - 1;
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Days since 1970-01-01 → [year, month, day]. */
export function civilFromDays(z) {
  z += 719468;
  const era = floorDiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100));
  const mp = floorDiv(5 * doy + 2, 153);
  const d = doy - floorDiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

let clock = () => Date.now();
/** Inject the clock (tests and deterministic recalculation); returns the previous one. */
export function setClock(fn) { const prev = clock; clock = typeof fn === 'function' ? fn : () => Date.now(); return prev; }
export const unixNowMs = () => clock();

export const serialFromUnixMs = ms => 25569 + ms / 86_400_000;
export const serialInSystem = (sys, serial1900) => (sys === D1904 ? serial1900 - 1462 : serial1900);

const UNIX_1899_12_30 = -25569;
const UNIX_1904_01_01 = -24107;

export const maxSerial = sys => (sys === D1904 ? 2_958_465 - 1462 : 2_958_465);

/**
 * Serial of year/month/day with Excel's rules: years 0..1899 add 1900, months and days roll over,
 * out-of-range results are null.
 */
export function serialFromYmd(sys, year, month, day) {
  if (![year, month, day].every(Number.isFinite)) return null;
  year = Math.trunc(year); month = Math.trunc(month); day = Math.trunc(day);
  let y = year >= 0 && year < 1900 ? year + 1900 : year;
  const m0 = month - 1;
  y += floorDiv(m0, 12);
  const m = mod(m0, 12) + 1;
  if ((sys === D1900 && !(y >= 1900 && y <= 9999)) || (sys === D1904 && !(y >= 1904 && y <= 9999))) return null;
  let first = daysFromCivil(y, m, 1);
  first = sys === D1900 ? first - UNIX_1899_12_30 - (y === 1900 && m <= 2 ? 1 : 0) : first - UNIX_1904_01_01;
  const serial = first + day - 1;
  if (!Number.isSafeInteger(serial) || serial < 0 || serial > maxSerial(sys)) return null;
  return serial;
}

/** Serial → {year, month, day, hour, minute, second, milli, weekday} or null. */
export function datetimeFromSerial(sys, serial) {
  if (!Number.isFinite(serial) || !(serial >= 0 && serial < maxSerial(sys) + 1)) return null;
  let day = Math.floor(serial);
  let fracMs = Math.round((serial - Math.floor(serial)) * 86_400_000);
  if (fracMs >= 86_400_000) {
    fracMs -= 86_400_000;
    day += 1;
    if (day > maxSerial(sys)) return null;
  }
  let y, m, d, weekday;
  if (sys === D1900) {
    weekday = (day + 6) % 7;
    if (day === 60) { y = 1900; m = 2; d = 29; }
    else if (day === 0) { y = 1900; m = 1; d = 0; }
    else { [y, m, d] = civilFromDays((day < 60 ? day + 1 : day) + UNIX_1899_12_30); }
  } else {
    const unix = day + UNIX_1904_01_01;
    [y, m, d] = civilFromDays(unix);
    weekday = mod(unix + 4, 7);
  }
  const secs = Math.floor(fracMs / 1000);
  return {year: y, month: m, day: d, hour: Math.floor(secs / 3600), minute: Math.floor(secs / 60) % 60, second: secs % 60,
    milli: fracMs % 1000, weekday};
}

export const timeFraction = (h, m, s) => (h * 3600 + m * 60 + s) / 86400;

export const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
export const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
