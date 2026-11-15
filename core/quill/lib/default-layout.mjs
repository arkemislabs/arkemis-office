// Set as Default Layout (U:quill/rest): the wrapping a new picture, shape, text box or canvas starts with, kept in the person's settings
// (`prefs.defaultLayout`: {wrap, wrapText?, dist, distTop, distBottom}). Not checked against upstream (follows Word). No DOM, no Node built-ins.

import * as P from '../model/para.mjs';

const d = v => (Number.isFinite(v) ? Math.max(0, Math.min(1584, v)) : 0);

/** A new object's float: the default one, with the person's default layout laid over it. `S` is a session (or anything holding `ctx.prefs`). */
export function newFloat(S, base = P.defaultFloat()) {
  const l = S?.ctx?.prefs?.defaultLayout ?? S?.prefs?.defaultLayout;
  if (!l || typeof l !== 'object') return base;
  const out = {...base};
  if (P.WRAPS.includes(l.wrap)) out.wrap = l.wrap;
  if (P.WRAP_TEXTS.includes(l.wrapText)) out.wrapText = l.wrapText;
  out.dist = d(l.dist); out.distTop = d(l.distTop); out.distBottom = d(l.distBottom);
  return out;
}
