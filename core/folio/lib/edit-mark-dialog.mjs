// What the Add Header and Footer, Add Watermark and Add Background dialogs share: the draft that
// stays between openings, Page Range Options, colours, the preview page and the step through it.
//
// Translated from printcraft crates/ui-egui/src/dialogs/marks_ui.rs (MarksDraft, PageRange,
// Subset, preview_page, shown_preview, step_preview) at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt). No DOM, no Node built-ins.

const SUBSETS = {'All pages in range': 'all', 'Even pages only': 'even', 'Odd pages only': 'odd'};
const SUBSET_LABEL = Object.fromEntries(Object.entries(SUBSETS).map(([k, v]) => [v, k]));

/** MarksDraft: one per app process, kept between openings like upstream's `app.marks_draft`. */
const drafts = new Map();
export const draftOf = kind => drafts.get(kind) ?? null;
export const keepDraft = (kind, values) => drafts.set(kind, {...values});
export const clearDrafts = () => drafts.clear();

/** PageRange::default: all pages; `to` shows the document's last page. */
export const rangeValues = count => ({scope: 'All pages', from: 1, to: Math.max(1, count), subset: 'All pages in range'});

/** PageRange::pages (0-based) for dialog values. */
export function rangeOf(v, count) {
  const all = v.scope !== 'Pages from';
  const a = all ? 1 : Math.max(1, Number(v.from) || 1), b = all ? count : Math.min(Number(v.to) || count, count);
  const subset = SUBSETS[v.subset] ?? 'all';
  const out = [];
  for (let p = a; p <= b; p++) if (subset === 'all' || (subset === 'even' ? p % 2 === 0 : p % 2 === 1)) out.push(p - 1);
  return out;
}
/** The command params for the range: from/to/subset, nothing for every page. */
export function rangeParams(v) {
  const subset = SUBSETS[v.subset] ?? 'all';
  const out = {};
  if (v.scope === 'Pages from') { out.from = Math.max(1, Math.round(Number(v.from) || 1)); out.to = Math.max(1, Math.round(Number(v.to) || 1)); }
  if (subset !== 'all') out.subset = subset;
  return out;
}
export const subsetLabel = s => SUBSET_LABEL[s] ?? 'All pages in range';

/** Colour field value ('#RRGGBB') ↔ RGB 0–1. */
export const hexOf = c => `#${c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
export function rgbOf(hex, fallback) {
  const h = String(hex ?? '').replace('#', '');
  return /^[0-9a-f]{6}$/i.test(h) ? [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) : fallback;
}

/** marks_ui.rs `preview_page`: the current page if the range selects it, else the first one it selects. */
export function previewPage(v, current, count) {
  const sel = rangeOf(v, count);
  return sel.includes(current) ? current : sel[0] ?? current;
}
/** marks_ui.rs `step_preview`: the next (or previous) page the range selects. */
export function stepPreview(v, shown, count, forward) {
  const sel = rangeOf(v, count);
  return (forward ? sel.find(p => p > shown) : [...sel].reverse().find(p => p < shown)) ?? null;
}

/** "Applies to 1 page" / "Applies to N pages". */
export const appliesTo = n => (n === 1 ? 'Applies to 1 page' : `Applies to ${n} pages`);

/** Range validation (OK needs a non-empty range). */
export function rangeProblems(v, count) {
  if (v.scope === 'Pages from') {
    const a = Number(v.from), b = Number(v.to);
    if (!Number.isInteger(a) || a < 1 || a > count) return [{field: 'from', message: `Type a page number from 1 to ${count}`}];
    if (!Number.isInteger(b) || b < 1 || b > count) return [{field: 'to', message: `Type a page number from 1 to ${count}`}];
  }
  return rangeOf(v, count).length ? [] : [{field: 'subset', message: 'The page range selects no pages'}];
}

/** The page the preview shows and its displayed size, from the dialog context. */
export function previewFrame(ctx, v) {
  const pages = ctx.doc?.pages ?? [];
  const count = pages.length;
  const current = Math.max(0, pages.findIndex(p => p.id === ctx.doc?.activePageId));
  const step = Number.isInteger(v.__preview) && v.__preview >= 0 && v.__preview < count ? v.__preview : null;
  const shown = step ?? previewPage(v, current, count);
  const pg = pages[shown];
  const rot = ((((pg?.sourceRotation ?? 0) + (pg?.rotation ?? 0)) % 360) + 360) % 360;
  const w = pg?.width ?? 612, h = pg?.height ?? 792;
  const size = rot % 180 === 0 ? [w, h] : [h, w];
  return {shown, count, size, pageId: pg?.id ?? null, back: stepPreview(v, shown, count, false), next: stepPreview(v, shown, count, true),
    applies: appliesTo(rangeOf(v, count).length), label: `Preview: page ${shown + 1} of ${count}`};
}
