// Param schemas and ribbon-state helpers shared by the Grid format and sheet families (U:grid/format,
// U:grid/sheet), as gridcraft's `cmd!` signatures write them ("{range?, on?}", "{sheet?, rows?}").
// Translated from gridcraft crates/engine/src/cmd.rs (`has_doc`, param helpers) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {s} from '../../kernel/schema.mjs';
import {hasDoc} from './edit-targets.mjs';

export const UPSTREAM_COMMIT = '146161b4b450a56e5e59a083ba0478582d1e602b';

export const RANGE = s.optional(s.string({min: 1, max: 4096,
  description: 'Range: /sh:<id>/A1:C9,D4, Sheet1!A1:C9, A1:C9, B:D or 3:5 (default: the selection)'}));
export const SHEET = s.optional(s.nullable(s.union([s.integer({min: 0}), s.string({min: 1, max: 300})],
  {description: 'Sheet: index, name or /sh:<id> (default: the one the range names, else the active sheet)'})));
export const ON = s.optional(s.boolean({description: 'true sets it, false clears it; omitted toggles from the active cell'}));
export const COLOR = s.union([s.string({min: 1, max: 40}), s.object({theme: s.integer({min: 0, max: 11}), tint: s.optional(s.number({min: -1, max: 1}))})],
  {description: '"#RRGGBB", "auto"/"none" or a theme colour {theme, tint}'});
export const ROWS = s.optional(s.string({min: 1, max: 4096, description: 'Rows: "2:5", "2:2,4:5", "Sheet2!2:5" or /sh:<id>/rows:2-5 (default: the selection)'}));
export const COLS = s.optional(s.string({min: 1, max: 4096, description: 'Columns: "B:D", "B:B,D:F", "Sheet2!B:D" or /sh:<id>/cols:B-D (default: the selection)'}));

/** gridcraft `has_doc` as a ribbon state. */
export const docState = ctx => hasDoc(ctx);
/** A state with a value, or the disabled one. */
export function withDoc(ctx, more) {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  try { return {enabled: true, ...more()}; } catch { return {enabled: true}; }
}
