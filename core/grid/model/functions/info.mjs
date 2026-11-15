// Information, logical and web functions.
// Translated from gridcraft crates/functions/src/info.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The cube functions (CUBEMEMBER...) are not registered.

import {CellError, ERR, GArray, compareText, toBool, toNumber} from '../../lib/value.mjs';
import {f, register, VAR, S, A, MAX_CELLS, has, scalar, text, ok} from './registry.mjs';

const first = a => (a[0] ? scalar(a[0]) : null);
const isEmpty = v => v === null || v === undefined;
function parity(a) {
  const v = first(a);
  if (typeof v === 'boolean') throw ERR.Value;
  const n = ok(toNumber(v));
  if (Math.abs(n) > 9.007_199_254_740_992e15) throw ERR.Num;
  return Math.abs(Math.trunc(n)) % 2;
}
function typeOf(v) {
  if (isEmpty(v) || typeof v === 'number') return 1;
  if (typeof v === 'string') return 2;
  if (typeof v === 'boolean') return 4;
  if (v instanceof CellError) return 16;
  return 64;
}
function typeFn(a) {
  const x = a[0];
  if (!x) throw ERR.Value;
  const v = x.value;
  if (v instanceof GArray && x.fromRef && v.rows === 1 && v.cols === 1) return typeOf(v.data[0]);
  return typeOf(v);
}
function nOf(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof CellError) throw v;
  return 0;
}
function nFn(a) {
  const x = a[0];
  if (x && x.value instanceof GArray && !x.fromRef) {
    const arr = x.value;
    return GArray.new(arr.rows, arr.cols, arr.data.map(v => { try { return nOf(v); } catch (e) { if (e instanceof CellError) return e; throw e; } })) ?? ERR.Calc;
  }
  return nOf(first(a));
}
/**
 * INFO("osversion"): the operating system's version as Excel writes it, "Windows (64-bit) NT 10.00" or
 * "Macintosh (Intel) 14.5". It comes from the host the code runs in: Electron's system version, the Windows or
 * macOS version in the user agent, else the platform name (no Node built-ins are imported).
 */
export function osVersion() {
  const proc = globalThis.process;
  const ua = String(globalThis.navigator?.userAgent ?? '');
  const platform = proc?.platform ?? (/Windows/.test(ua) ? 'win32' : /Mac OS X|Macintosh/.test(ua) ? 'darwin' : /Linux|X11/.test(ua) ? 'linux' : '');
  const arch = proc?.arch ?? (/Win64|x64|WOW64|x86_64|arm64|aarch64/i.test(ua) ? 'x64' : 'ia32');
  const sys = typeof proc?.getSystemVersion === 'function' ? String(proc.getSystemVersion()) : '';
  if (platform === 'win32') {
    const m = /^(\d+)\.(\d+)/.exec(sys) ?? /Windows NT (\d+)\.(\d+)/.exec(ua);
    // Windows 10 and 11 both report NT 10.0.
    const [maj, min] = m ? [Number(m[1]), Number(m[2])] : [10, 0];
    return `Windows (${arch === 'ia32' || arch === 'arm' ? '32' : '64'}-bit) NT ${maj}.${String(min).padStart(2, '0')}`;
  }
  if (platform === 'darwin') {
    const m = /^(\d+)\.(\d+)/.exec(sys) ?? /Mac OS X (\d+)[._](\d+)/.exec(ua);
    return `Macintosh (${arch === 'arm64' ? 'ARM' : 'Intel'}) ${m ? `${m[1]}.${m[2]}` : '10.15'}`;
  }
  return sys ? `${platform === 'linux' ? 'Linux' : platform} ${sys}` : platform === 'linux' ? 'Linux' : 'Unix';
}
function info(a) {
  switch (text(a, 0).toLowerCase()) {
    case 'directory': return '/';
    case 'numfile': return 1;
    case 'origin': return '$A:$A$1';
    case 'osversion': return osVersion();
    case 'recalc': return 'Automatic';
    case 'release': return '16.0';
    case 'system': return 'pcdos';
    default: throw ERR.Value;
  }
}
function logicals(a) {
  const out = [];
  for (const x of a) {
    const v = x.value;
    if (v instanceof GArray) {
      for (const y of v.data) {
        if (typeof y === 'number') out.push(y !== 0);
        else if (typeof y === 'boolean') out.push(y);
        else if (y instanceof CellError) throw y;
      }
    } else if (v instanceof CellError) throw v;
    else if (typeof v === 'number') out.push(v !== 0);
    else if (typeof v === 'boolean') out.push(v);
    else if (x.fromRef) continue;
    else out.push(ok(toBool(v)));
  }
  if (!out.length) throw ERR.Value;
  return out;
}
const emptyToZero = v => (isEmpty(v) ? 0 : v);
function drive(a, drivers, fn) {
  const any = a.some((x, i) => drivers(i) && x.value instanceof GArray);
  if (!any) return emptyToZero(fn(a.map(x => x.value)));
  let rows = 1, cols = 1;
  for (const x of a) if (x.value instanceof GArray) { rows = Math.max(rows, x.value.rows); cols = Math.max(cols, x.value.cols); }
  if (rows * cols > MAX_CELLS) throw ERR.Num;
  const data = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const vals = a.map(x => (x.value instanceof GArray ? x.value.getBroadcast(r, c) : x.value));
    let out;
    try { out = fn(vals); } catch (e) { if (e instanceof CellError) out = e; else throw e; }
    data.push(out instanceof GArray ? (out.data[0] ?? null) : out);
  }
  return GArray.new(rows, cols, data) ?? ERR.Calc;
}
function switchEqual(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return compareText(a, b) === 0;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  if (isEmpty(a) && isEmpty(b)) return true;
  if (isEmpty(a) && typeof b === 'number') return b === 0;
  if (typeof a === 'number' && isEmpty(b)) return a === 0;
  if (isEmpty(a) && typeof b === 'string') return b === '';
  if (typeof a === 'string' && isEmpty(b)) return a === '';
  return false;
}
function switchFn(a) {
  return drive(a, i => i === 0, v => {
    const [expr, ...rest] = v;
    if (expr instanceof CellError) throw expr;
    for (let i = 0; i < rest.length; i += 2) {
      if (i + 1 >= rest.length) return rest[i];
      if (rest[i] instanceof CellError) throw rest[i];
      if (switchEqual(expr, rest[i])) return rest[i + 1];
    }
    throw ERR.NA;
  });
}
function encodeurl(a) {
  let out = '';
  for (const b of new TextEncoder().encode(text(a, 0))) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-_.~]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
function hyperlink(a) {
  if (has(a, 1)) return emptyToZero(scalar(a[1]));
  const link = first(a);
  if (link instanceof CellError) throw link;
  return link;
}

register([
  f('ISBLANK', 1, 1, 'Information', S, 'ISBLANK(value)', 'TRUE when the value refers to an empty cell.', a => isEmpty(first(a))),
  f('ISERR', 1, 1, 'Information', S, 'ISERR(value)', 'TRUE when the value is any error other than #N/A.', a => { const v = first(a); return v instanceof CellError && v !== ERR.NA; }),
  f('ISERROR', 1, 1, 'Information', S, 'ISERROR(value)', 'TRUE when the value is any error.', a => first(a) instanceof CellError),
  f('ISNA', 1, 1, 'Information', S, 'ISNA(value)', 'TRUE when the value is the #N/A error.', a => first(a) === ERR.NA),
  f('ISNUMBER', 1, 1, 'Information', S, 'ISNUMBER(value)', 'TRUE when the value is a number.', a => typeof first(a) === 'number'),
  f('ISTEXT', 1, 1, 'Information', S, 'ISTEXT(value)', 'TRUE when the value is text.', a => typeof first(a) === 'string'),
  f('ISNONTEXT', 1, 1, 'Information', S, 'ISNONTEXT(value)', 'TRUE when the value is anything other than text.', a => typeof first(a) !== 'string'),
  f('ISLOGICAL', 1, 1, 'Information', S, 'ISLOGICAL(value)', 'TRUE when the value is TRUE or FALSE.', a => typeof first(a) === 'boolean'),
  f('ISEVEN', 1, 1, 'Information', S, 'ISEVEN(number)', 'TRUE when the integer part of a number is even.', a => parity(a) === 0),
  f('ISODD', 1, 1, 'Information', S, 'ISODD(number)', 'TRUE when the integer part of a number is odd.', a => parity(a) === 1),
  f('TYPE', 1, 1, 'Information', A, 'TYPE(value)', 'Returns a code for the kind of value: 1 number, 2 text, 4 logical, 16 error, 64 array.', typeFn),
  f('ERROR.TYPE', 1, 1, 'Information', S, 'ERROR.TYPE(error_val)', 'Returns the number identifying an error value, or #N/A if it is not an error.', a => { const v = first(a); if (v instanceof CellError) return v.code; throw ERR.NA; }),
  f('NA', 0, 0, 'Information', S, 'NA()', 'Returns the #N/A error value.', () => { throw ERR.NA; }),
  f('N', 1, 1, 'Information', A, 'N(value)', 'Converts a value to a number: numbers stay, TRUE is 1, everything else is 0.', nFn),
  f('INFO', 1, 1, 'Information', S, 'INFO(type_text)', 'Returns information about the operating environment.', info),
  f('AND', 1, VAR, 'Logical', A, 'AND(logical1, [logical2], ...)', 'TRUE when every argument is TRUE.', a => logicals(a).every(Boolean)),
  f('OR', 1, VAR, 'Logical', A, 'OR(logical1, [logical2], ...)', 'TRUE when at least one argument is TRUE.', a => logicals(a).some(Boolean)),
  f('XOR', 1, VAR, 'Logical', A, 'XOR(logical1, [logical2], ...)', 'TRUE when an odd number of arguments are TRUE.', a => logicals(a).filter(Boolean).length % 2 === 1),
  f('NOT', 1, 1, 'Logical', S, 'NOT(logical)', 'Reverses a logical value.', a => !ok(toBool(first(a)))),
  f('TRUE', 0, 0, 'Logical', S, 'TRUE()', 'Returns the logical value TRUE.', () => true),
  f('FALSE', 0, 0, 'Logical', S, 'FALSE()', 'Returns the logical value FALSE.', () => false),
  f('IF', 2, 3, 'Logical', A, 'IF(logical_test, [value_if_true], [value_if_false])', 'Returns one value when a condition is TRUE and another when it is FALSE.',
    a => drive(a, i => i === 0, v => (ok(toBool(v[0] ?? null)) ? (v.length > 1 ? v[1] : true) : (v.length > 2 ? v[2] : false)))),
  f('IFS', 2, VAR, 'Logical', A, 'IFS(logical_test1, value_if_true1, ...)', 'Returns the value paired with the first condition that is TRUE.',
    a => { if (a.length % 2) throw ERR.NA; return drive(a, i => i % 2 === 0, v => { for (let i = 0; i + 1 < v.length; i += 2) if (ok(toBool(v[i]))) return v[i + 1]; throw ERR.NA; }); }),
  f('IFERROR', 2, 2, 'Logical', A, 'IFERROR(value, value_if_error)', 'Returns a fallback when the value is an error, otherwise the value.', a => drive(a, i => i === 0, v => (v[0] instanceof CellError ? (v[1] ?? null) : v[0]))),
  f('IFNA', 2, 2, 'Logical', A, 'IFNA(value, value_if_na)', 'Returns a fallback when the value is #N/A, otherwise the value.', a => drive(a, i => i === 0, v => (v[0] === ERR.NA ? (v[1] ?? null) : v[0]))),
  f('SWITCH', 3, VAR, 'Logical', A, 'SWITCH(expression, value1, result1, [default_or_value2, result2], ...)', 'Compares an expression with a list of values and returns the result paired with the first match.', switchFn),
  f('CHOOSE', 2, VAR, 'Lookup', A, 'CHOOSE(index_num, value1, [value2], ...)', 'Picks a value from the list by its position.',
    a => drive(a, i => i === 0, v => { const idx = Math.trunc(ok(toNumber(v[0] ?? null))); if (idx < 1 || idx >= v.length) throw ERR.Value; return v[idx]; })),
  f('HYPERLINK', 1, 2, 'Information', S, 'HYPERLINK(link_location, [friendly_name])', 'Creates a link; the cell shows the friendly name, or the link itself.', hyperlink),
  f('ENCODEURL', 1, 1, 'Web', S, 'ENCODEURL(text)', 'Percent-encodes text for use in a URL.', encodeurl),
]);
