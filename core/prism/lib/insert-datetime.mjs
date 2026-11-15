// Date and time fields (`a:fld type="datetime…"`): the text each field type shows for a moment.
// The field types and their formats follow ECMA-376 Part 1, §21.1.2.2.4 (`fld`): `datetime1` to
// `datetime13`, written as in PowerPoint's English (United States) Date and Time list. `datetime`
// and `datetimeFigureOut` show the language's short date. Numeric dates follow the run's language;
// formats with month or day names, or AM/PM, are only computed for English, so other languages
// keep the text the file was saved with.
// Translated from deckcraft crates/text/src/datetime.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:prism/insert. No DOM, no Node built-ins.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** `DateTime::new`. */
export const dateTime = (year, month, day, hour = 0, minute = 0, second = 0) => ({year, month, day, hour, minute, second});
/** `DateTime::now_local` from a millisecond clock (the host's `now()`), in the local time zone. */
export function fromMillis(ms) {
  const d = new Date(ms);
  return dateTime(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

const isInt = v => Number.isSafeInteger(v);
function isValid(t) {
  if (![t.year, t.month, t.day, t.hour, t.minute, t.second].every(isInt)) return false;
  if (t.year < 1 || t.year > 9999 || t.month < 1 || t.month > 12 || t.day < 1) return false;
  const days = new Date(Date.UTC(2000, t.month, 0)).getUTCDate();
  const leap = (t.year % 4 === 0 && t.year % 100 !== 0) || t.year % 400 === 0;
  const max = t.month === 2 ? (leap ? 29 : 28) : days;
  return t.day <= max && t.hour >= 0 && t.hour < 24 && t.minute >= 0 && t.minute < 60 && t.second >= 0 && t.second < 61;
}
/** Day of the week, 0 = Sunday (proleptic Gregorian). */
function weekday(t) {
  const d = new Date(Date.UTC(2000, t.month - 1, t.day));
  d.setUTCFullYear(t.year);
  return d.getUTCDay();
}

/** Is field `kind` a date/time field? */
export const isDateField = kind => String(kind).startsWith('datetime');
/** The date and time field types the Date and Time dialog offers, in its order. */
export const DATE_KINDS = Object.freeze(['datetime1', 'datetime2', 'datetime3', 'datetime4', 'datetime5', 'datetime6', 'datetime7', 'datetime8',
  'datetime9', 'datetime10', 'datetime11', 'datetime12', 'datetime13']);

const p2 = v => String(v).padStart(2, '0');

/**
 * `field_text`: the text date/time field `kind` shows at `now` in a run of language `lang` (BCP 47).
 * null when `kind` isn't a date/time type, `now` isn't a real date, or the format needs names in
 * a language other than English.
 */
export function fieldText(kind, lang, now) {
  if (!now || !isValid(now)) return null;
  const l = (typeof lang === 'string' && lang.trim() ? lang.trim() : 'en-US').toLowerCase();
  const english = l === 'en' || l.startsWith('en-');
  const month = MONTHS[now.month - 1];
  const mon = month.slice(0, 3);
  const day = DAYS[weekday(now)];
  const d = now.day, y = now.year;
  const yy = p2(((y % 100) + 100) % 100);
  const h12 = now.hour % 12 === 0 ? 12 : now.hour % 12;
  const ampm = now.hour < 12 ? 'AM' : 'PM';
  const mi = p2(now.minute), s = p2(now.second);
  const short = shortDate(l, now);
  const named = text => (english ? text : null);
  switch (kind) {
    case 'datetime': case 'datetimeFigureOut': case 'datetime1': return short;
    case 'datetime2': return named(`${day}, ${month} ${d}, ${y}`);
    case 'datetime3': return named(`${d} ${month} ${y}`);
    case 'datetime4': return named(`${month} ${d}, ${y}`);
    case 'datetime5': return named(`${d}-${mon}-${yy}`);
    case 'datetime6': return named(`${month} ${yy}`);
    case 'datetime7': return named(`${mon}-${yy}`);
    case 'datetime8': return named(`${short} ${h12}:${mi} ${ampm}`);
    case 'datetime9': return named(`${short} ${h12}:${mi}:${s} ${ampm}`);
    case 'datetime10': return `${now.hour}:${mi}`;
    case 'datetime11': return `${now.hour}:${mi}:${s}`;
    case 'datetime12': return named(`${h12}:${mi} ${ampm}`);
    case 'datetime13': return named(`${h12}:${mi}:${s} ${ampm}`);
    default: return null;
  }
}

/** The short (numeric) date of language `lang` (lower case), US order unless the language writes dates another way. */
function shortDate(lang, t) {
  const y = t.year, m = t.month, d = t.day;
  const primary = lang.split(/[-_]/)[0] ?? '';
  if (['en-gb', 'en-au', 'en-nz', 'en-ie', 'en-in'].includes(lang)) return `${p2(d)}/${p2(m)}/${y}`;
  if (['en-ca', 'fr-ca', 'en-za'].includes(lang)) return `${y}-${p2(m)}-${p2(d)}`;
  if (['fr', 'es', 'it', 'pt', 'el', 'ca', 'vi'].includes(primary)) return `${p2(d)}/${p2(m)}/${y}`;
  if (['de', 'ru', 'pl', 'cs', 'sk', 'tr', 'fi', 'nb', 'nn', 'no', 'da', 'uk', 'ro'].includes(primary)) return `${p2(d)}.${p2(m)}.${y}`;
  if (primary === 'nl') return `${d}-${m}-${y}`;
  if (primary === 'ja' || primary === 'zh') return `${y}/${m}/${d}`;
  if (['ko', 'sv', 'lt'].includes(primary)) return `${y}-${p2(m)}-${p2(d)}`;
  return `${m}/${d}/${y}`;
}
