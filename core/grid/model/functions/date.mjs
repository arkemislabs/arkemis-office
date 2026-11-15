// Date and time functions.
// Translated from gridcraft crates/functions/src/date.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {CellError, ERR, toNumber} from '../../lib/value.mjs';
import {datetimeFromSerial, daysInMonth, isLeap, serialFromYmd, serialInSystem, D1904} from '../../lib/date.mjs';
import {parseInput} from '../../lib/parse.mjs';
import {f, register, S, arg, asArray, has, num, numVal, optBool, optNum, scalar, text, toInt, ok} from './registry.mjs';

const MAX_SERIAL = 2_958_465;
const ND = [true, true, false], NDI = [true, true, true, false];
const mod = (a, b) => ((a % b) + b) % b;
const fdiv = (a, b) => Math.floor(a / b);

function serialArg(a, i, sys) {
  const n = ok(toNumber(scalar(arg(a, i)), sys));
  if (!(n >= 0 && n < MAX_SERIAL + 1)) throw ERR.Num;
  return n;
}
const dayArg = (a, i, sys) => Math.floor(serialArg(a, i, sys));
function dt(sys, serial) { const d = datetimeFromSerial(sys, serial); if (!d) throw ERR.Num; return d; }
function ymdSerial(sys, y, m, d) { const s = serialFromYmd(sys, y, m, d); if (s === null) throw ERR.Num; return s; }
const weekday0 = (sys, serial) => (sys === D1904 ? mod(serial + 5, 7) : mod(serial + 6, 7));

function date(a, c) {
  const y = toInt(num(a, 0)), m = toInt(num(a, 1)), d = toInt(num(a, 2));
  if (!(y >= 0 && y < 10000) || Math.abs(m) > 1_000_000 || Math.abs(d) > 100_000_000) throw ERR.Num;
  return ymdSerial(c.dateSystem(), y, m, d);
}
function time(a) {
  const h = Math.trunc(num(a, 0)), m = Math.trunc(num(a, 1)), s = Math.trunc(num(a, 2));
  if (h > 32767 || m > 32767 || s > 32767) throw ERR.Num;
  const total = h * 3600 + m * 60 + s;
  if (total < 0) throw ERR.Num;
  return numVal(mod(total, 86400) / 86400);
}
const part = (a, c, fn) => { const sys = c.dateSystem(); return numVal(fn(dt(sys, Math.floor(serialArg(a, 0, sys))))); };
function daySeconds(a, sys) {
  const s = serialArg(a, 0, sys);
  const secs = Math.round((s - Math.floor(s)) * 86400);
  return secs >= 86400 ? 0 : secs;
}
function weekday(a, c) {
  const sys = c.dateSystem(), s = dayArg(a, 0, sys), t = toInt(optNum(a, 1, 1)), wd = weekday0(sys, s);
  if (t === 1 || t === 17) return wd + 1;
  if (t === 2 || t === 11) return ((wd + 6) % 7) + 1;
  if (t === 3) return (wd + 6) % 7;
  if (t >= 12 && t <= 16) return ((wd + 7 - (t - 10)) % 7) + 1;
  throw ERR.Num;
}
function isoweek(sys, s) {
  const isoWd = ((weekday0(sys, s) + 6) % 7) + 1;
  const thursday = s - isoWd + 4;
  const first = sys === D1904 ? 0 : 1;
  const jan1 = thursday < first ? first - 365 : ymdSerial(sys, dt(sys, thursday).year, 1, 1);
  return fdiv(thursday - jan1, 7) + 1;
}
function weeknum(a, c) {
  const sys = c.dateSystem(), s = dayArg(a, 0, sys), t = toInt(optNum(a, 1, 1));
  let start;
  if (t === 1 || t === 17) start = 0;
  else if (t === 2 || t === 11) start = 1;
  else if (t >= 12 && t <= 16) start = t - 10;
  else if (t === 21) return isoweek(sys, s);
  else throw ERR.Num;
  const y = dt(sys, s).year;
  const jan1 = serialFromYmd(sys, y, 1, 1) ?? Math.min(s, 1);
  const offset = (weekday0(sys, jan1) + 7 - start) % 7;
  return fdiv(s - jan1 + offset, 7) + 1;
}
function monthsArg(a, i) { const m = toInt(num(a, i)); if (Math.abs(m) > 200_000) throw ERR.Num; return m; }
function shiftMonths(a, c, end) {
  const sys = c.dateSystem(), d = dt(sys, dayArg(a, 0, sys)), m = monthsArg(a, 1);
  const total = d.year * 12 + d.month - 1 + m;
  const y = fdiv(total, 12), mo = mod(total, 12) + 1;
  if (!(y >= 1900 && y <= 9999)) throw ERR.Num;
  return ymdSerial(sys, y, mo, end ? daysInMonth(y, mo) : Math.min(d.day, daysInMonth(y, mo)));
}
function datedif(a, c) {
  const sys = c.dateSystem(), s = dayArg(a, 0, sys), e = dayArg(a, 1, sys), unit = text(a, 2).toUpperCase();
  if (s > e) throw ERR.Num;
  const d1 = dt(sys, s), d2 = dt(sys, e);
  const months = (d2.year - d1.year) * 12 + d2.month - d1.month - (d2.day < d1.day ? 1 : 0);
  switch (unit) {
    case 'D': return e - s;
    case 'M': return months;
    case 'Y': return Math.trunc(months / 12);
    case 'YM': return months % 12;
    case 'MD': {
      if (d2.day >= d1.day) return d2.day - d1.day;
      const [py, pm] = d2.month === 1 ? [d2.year - 1, 12] : [d2.year, d2.month - 1];
      return daysInMonth(py, pm) - d1.day + d2.day;
    }
    case 'YD': {
      const later = d1.month > d2.month || (d1.month === d2.month && d1.day > d2.day);
      const y = later ? d2.year - 1 : d2.year;
      const dd = Math.min(d1.day, Math.max(1, daysInMonth(y, d1.month)));
      return e - ymdSerial(sys, y, d1.month, dd);
    }
    default: throw ERR.Num;
  }
}
function parsedText(a, c) {
  const v = scalar(arg(a, 0));
  if (typeof v !== 'string') throw v instanceof CellError ? v : ERR.Value;
  const p = parseInput(v, c.dateSystem());
  if (typeof p.value === 'number' && p.format && /[dyh]/.test(p.format)) return [p.value, p.format];
  throw ERR.Value;
}
const lastOfFeb = d => d.month === 2 && d.day === daysInMonth(d.year, 2);
function days360Core(d1, d2, european) {
  let p = d1.day, q = d2.day;
  if (european) { p = Math.min(p, 30); q = Math.min(q, 30); }
  else { if (p === 31 || lastOfFeb(d1)) p = 30; if (q === 31 && p >= 30) q = 30; }
  return (d2.year - d1.year) * 360 + (d2.month - d1.month) * 30 + q - p;
}
function weekendMask(x) {
  if (!x) return [true, false, false, false, false, false, true];
  const v = scalar(x);
  if ((v === null || v === undefined) && !x.fromRef) return [true, false, false, false, false, false, true];
  if (typeof v === 'string') {
    if (!/^[01]{7}$/.test(v)) throw ERR.Value;
    const m = new Array(7).fill(false);
    [...v].forEach((ch, i) => { m[(i + 1) % 7] = ch === '1'; });
    return m;
  }
  if (v instanceof CellError) throw v;
  const k = toInt(ok(toNumber(v)));
  const m = new Array(7).fill(false);
  if (k >= 1 && k <= 7) { m[(k + 5) % 7] = true; m[(k + 6) % 7] = true; }
  else if (k >= 11 && k <= 17) m[k - 11] = true;
  else throw ERR.Num;
  return m;
}
function holidays(x, sys) {
  const out = [];
  if (x) for (const v of asArray(x.value).data) {
    if (v === null || v === undefined) continue;
    if (v instanceof CellError) throw v;
    const n = ok(toNumber(v, sys));
    if (!(n >= 0 && n < MAX_SERIAL + 1)) throw ERR.Num;
    out.push(Math.floor(n));
  }
  return [...new Set(out)].sort((p, q) => p - q);
}
function countWorkdays(sys, lo, hi, mask) {
  const perWeek = mask.filter(w => !w).length;
  const total = hi - lo + 1, weeks = Math.trunc(total / 7);
  let n = weeks * perWeek;
  for (let d = lo + weeks * 7; d <= hi; d++) if (!mask[weekday0(sys, d)]) n++;
  return n;
}
function networkdaysCore(a, c, mask, hol) {
  const sys = c.dateSystem(), s = dayArg(a, 0, sys), e = dayArg(a, 1, sys), hs = holidays(hol, sys);
  const [lo, hi, sign] = s <= e ? [s, e, 1] : [e, s, -1];
  let n = countWorkdays(sys, lo, hi, mask);
  n -= hs.filter(h => h >= lo && h <= hi && !mask[weekday0(sys, h)]).length;
  return numVal(n * sign);
}
function advance(sys, start, n, dir, mask, perWeek) {
  const weeks = Math.trunc((n - 1) / perWeek);
  let cur = start + dir * 7 * weeks, rem = n - weeks * perWeek;
  while (rem > 0) { cur += dir; if (!mask[weekday0(sys, cur)]) rem--; }
  return cur;
}
function workdayCore(a, c, mask, hol) {
  const sys = c.dateSystem(), start = dayArg(a, 0, sys);
  const d = Math.trunc(num(a, 1));
  if (Math.abs(d) > 1e7) throw ERR.Num;
  const hs = holidays(hol, sys);
  const perWeek = mask.filter(w => !w).length;
  if (!perWeek) throw ERR.Value;
  if (d === 0) return start;
  const dir = Math.sign(d);
  let cur = start, rem = Math.abs(d);
  while (rem > 0) {
    const next = advance(sys, cur, rem, dir, mask, perWeek);
    const [lo, hi] = dir > 0 ? [cur + 1, next] : [next, cur - 1];
    rem = hs.filter(h => h >= lo && h <= hi && !mask[weekday0(sys, h)]).length;
    cur = next;
    if (!(cur >= 0 && cur <= MAX_SERIAL)) throw ERR.Num;
  }
  return cur;
}
const feb29Between = (sys, s, e, d1, d2) => {
  for (let y = d1.year; y <= d2.year; y++) if (isLeap(y)) { const fx = serialFromYmd(sys, y, 2, 29); if (fx !== null && fx >= s && fx <= e) return true; }
  return false;
};
export function yearfracCore(sys, s0, e0, basis) {
  const [s, e] = s0 <= e0 ? [s0, e0] : [e0, s0];
  const d1 = dt(sys, s), d2 = dt(sys, e), days = e - s;
  switch (basis) {
    case 0: {
      let p = d1.day, q = d2.day;
      if (lastOfFeb(d1) && lastOfFeb(d2)) q = 30;
      if (lastOfFeb(d1) || p === 31) p = 30;
      if (p === 30 && q === 31) q = 30;
      return ((d2.year - d1.year) * 360 + (d2.month - d1.month) * 30 + q - p) / 360;
    }
    case 1: {
      const within = d1.year === d2.year || (d2.year === d1.year + 1 && (d1.month > d2.month || (d1.month === d2.month && d1.day >= d2.day)));
      if (within) {
        const yl = (d1.year === d2.year && isLeap(d1.year)) || feb29Between(sys, s, e, d1, d2) || (d2.month === 2 && d2.day === 29) ? 366 : 365;
        return days / yl;
      }
      const years = d2.year - d1.year + 1;
      const span = (serialFromYmd(sys, d2.year + 1, 1, 1) ?? e + 1) - (serialFromYmd(sys, d1.year, 1, 1) ?? s);
      return days / (span / years);
    }
    case 2: return days / 360;
    case 3: return days / 365;
    case 4: return days360Core(d1, d2, true) / 360;
    default: throw ERR.Num;
  }
}

register([
  f('DATE', 3, 3, 'DateTime', S, 'DATE(year, month, day)', 'Builds a date serial number from a year, month and day.', date),
  f('TIME', 3, 3, 'DateTime', S, 'TIME(hour, minute, second)', 'Builds a time (a fraction of a day) from hours, minutes and seconds.', time),
  f('YEAR', 1, 1, 'DateTime', S, 'YEAR(serial_number)', 'Returns the year of a date.', (a, c) => part(a, c, d => d.year)),
  f('MONTH', 1, 1, 'DateTime', S, 'MONTH(serial_number)', 'Returns the month (1-12) of a date.', (a, c) => part(a, c, d => d.month)),
  f('DAY', 1, 1, 'DateTime', S, 'DAY(serial_number)', 'Returns the day of the month of a date.', (a, c) => part(a, c, d => d.day)),
  f('HOUR', 1, 1, 'DateTime', S, 'HOUR(serial_number)', 'Returns the hour (0-23) of a time.', (a, c) => Math.floor(daySeconds(a, c.dateSystem()) / 3600)),
  f('MINUTE', 1, 1, 'DateTime', S, 'MINUTE(serial_number)', 'Returns the minute (0-59) of a time.', (a, c) => Math.floor(daySeconds(a, c.dateSystem()) / 60) % 60),
  f('SECOND', 1, 1, 'DateTime', S, 'SECOND(serial_number)', 'Returns the second (0-59) of a time.', (a, c) => daySeconds(a, c.dateSystem()) % 60),
  f('NOW', 0, 0, 'DateTime', S, 'NOW()', 'Returns the current date and time.', (a, c) => numVal(serialInSystem(c.dateSystem(), c.nowSerial())), {volatile: true}),
  f('TODAY', 0, 0, 'DateTime', S, 'TODAY()', 'Returns the current date.', (a, c) => numVal(Math.floor(serialInSystem(c.dateSystem(), c.nowSerial()))), {volatile: true}),
  f('WEEKDAY', 1, 2, 'DateTime', S, 'WEEKDAY(serial_number, [return_type])', 'Returns the day of the week of a date as a number.', weekday),
  f('WEEKNUM', 1, 2, 'DateTime', S, 'WEEKNUM(serial_number, [return_type])', 'Returns the week number of a date within its year.', weeknum),
  f('ISOWEEKNUM', 1, 1, 'DateTime', S, 'ISOWEEKNUM(date)', 'Returns the ISO 8601 week number of a date.', (a, c) => isoweek(c.dateSystem(), dayArg(a, 0, c.dateSystem()))),
  f('EDATE', 2, 2, 'DateTime', S, 'EDATE(start_date, months)', 'Returns the date a number of months before or after a date.', (a, c) => shiftMonths(a, c, false)),
  f('EOMONTH', 2, 2, 'DateTime', S, 'EOMONTH(start_date, months)', 'Returns the last day of the month a number of months away.', (a, c) => shiftMonths(a, c, true)),
  f('DATEDIF', 3, 3, 'DateTime', S, 'DATEDIF(start_date, end_date, unit)', 'Counts whole years, months or days between two dates. unit: Y, M, D, MD, YM or YD.', datedif),
  f('DATEVALUE', 1, 1, 'DateTime', S, 'DATEVALUE(date_text)', 'Converts a date written as text into a date serial number.', (a, c) => { const [n, fm] = parsedText(a, c); if (!/[dy]/.test(fm)) throw ERR.Value; return numVal(Math.floor(n)); }),
  f('TIMEVALUE', 1, 1, 'DateTime', S, 'TIMEVALUE(time_text)', 'Converts a time written as text into a fraction of a day.', (a, c) => { const [n] = parsedText(a, c); return numVal(n - Math.floor(n)); }),
  f('DAYS', 2, 2, 'DateTime', S, 'DAYS(end_date, start_date)', 'Returns the number of days between two dates.', (a, c) => dayArg(a, 0, c.dateSystem()) - dayArg(a, 1, c.dateSystem())),
  f('DAYS360', 2, 3, 'DateTime', S, 'DAYS360(start_date, end_date, [method])', 'Days between two dates on a 360-day year (twelve 30-day months).',
    (a, c) => { const sys = c.dateSystem(); return days360Core(dt(sys, dayArg(a, 0, sys)), dt(sys, dayArg(a, 1, sys)), optBool(a, 2, false)); }),
  f('NETWORKDAYS', 2, 3, 'DateTime', ND, 'NETWORKDAYS(start_date, end_date, [holidays])', 'Counts working days between two dates, Monday to Friday, minus holidays.', (a, c) => networkdaysCore(a, c, weekendMask(null), a[2])),
  f('NETWORKDAYS.INTL', 2, 4, 'DateTime', NDI, 'NETWORKDAYS.INTL(start_date, end_date, [weekend], [holidays])', 'Counts working days between two dates with a chosen weekend.', (a, c) => networkdaysCore(a, c, weekendMask(a[2]), a[3])),
  f('WORKDAY', 2, 3, 'DateTime', ND, 'WORKDAY(start_date, days, [holidays])', 'Returns the date a number of working days away.', (a, c) => workdayCore(a, c, weekendMask(null), a[2])),
  f('WORKDAY.INTL', 2, 4, 'DateTime', NDI, 'WORKDAY.INTL(start_date, days, [weekend], [holidays])', 'Returns the date a number of working days away with a chosen weekend.', (a, c) => workdayCore(a, c, weekendMask(a[2]), a[3])),
  f('YEARFRAC', 2, 3, 'DateTime', S, 'YEARFRAC(start_date, end_date, [basis])', 'Fraction of a year between two dates on a day-count basis.',
    (a, c) => { const sys = c.dateSystem(); return numVal(yearfracCore(sys, dayArg(a, 0, sys), dayArg(a, 1, sys), has(a, 2) ? toInt(num(a, 2)) : 0)); }),
]);
