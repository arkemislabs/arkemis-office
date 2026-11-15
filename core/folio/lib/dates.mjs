// PDF dates (ISO 32000-2 §7.9.4) and annotation ids for the Meta of an edit.
//
// Translated from printcraft crates/engine/src/dates.rs (pdf_date: `D:YYYYMMDDHHmmSS±HH'mm'`)
// and crates/engine/src/clock.rs (the caller supplies the date and the /NM id so edits stay
// deterministic) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

const pad = (v, n = 2) => String(Math.trunc(Math.abs(v))).padStart(n, '0');

/** A PDF date for the instant `ms` (epoch milliseconds) in local time with its offset. */
export function pdfDate(ms, offsetMinutes = -new Date(ms).getTimezoneOffset()) {
  const local = new Date(ms + offsetMinutes * 60000);
  const sign = offsetMinutes > 0 ? '+' : offsetMinutes < 0 ? '-' : 'Z';
  const tz = sign === 'Z' ? 'Z' : `${sign}${pad(offsetMinutes / 60)}'${pad(offsetMinutes % 60)}'`;
  return `D:${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}${tz}`;
}

/** Epoch milliseconds of a PDF date string, or null. */
export function parsePdfDate(s) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(String(s ?? '').trim());
  if (!m) return null;
  const [y, mo = 1, d = 1, h = 0, mi = 0, se = 0] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(v => (v === undefined ? undefined : Number(v)));
  let ms = Date.UTC(y, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, se ?? 0);
  if (m[7] === '+' || m[7] === '-') {
    const off = (Number(m[8] ?? 0) * 60 + Number(m[9] ?? 0)) * (m[7] === '+' ? 1 : -1);
    ms -= off * 60000;
  }
  return Number.isFinite(ms) ? ms : null;
}

/** A new annotation /NM: printcraft writes a UUID; the host's uid() keeps tests deterministic. */
export function annotId(host) {
  const raw = typeof host?.uid === 'function' ? host.uid() : globalThis.crypto.randomUUID();
  return String(raw);
}
