// Tab stops: explicit, hanging-indent and default stops; positional tabs; pending right/centre/
// decimal tabs.
//
// Translated from wordcraft crates/layout/src/para/tabs.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c).

const stop = (pos, align = 'left', leader = 'none') => ({pos, align, leader});

/** Next tab stop after `x` (next_tab): explicit stops, the hanging-indent stop, then default stops. */
export function nextTab(x, tabs, defaultTab, hangingAt) {
  let best = null;
  for (const t of tabs) if (t.pos > x + 0.01 && (!best || t.pos < best.pos)) best = t;
  if (hangingAt !== null && hangingAt !== undefined && hangingAt > x + 0.01 && (!best || hangingAt < best.pos)) best = stop(hangingAt);
  if (best) return {pos: best.pos, align: best.align ?? 'left', leader: best.leader ?? 'none'};
  const d = defaultTab > 1 ? defaultTab : 36;
  // Left of the margin Word's arithmetic truncates toward zero (see upstream).
  const n = x < -0.01 ? Math.ceil((x - 0.01) / d) : Math.floor((x + 0.01) / d) + 1;
  return stop(Math.min(n * d, 1e6));
}

/** A positional tab's stop (ptab_stop). */
export function ptabStop(align, base, leader, width, [indL, indR]) {
  const [lo, hi] = base === 'indent' ? [indL, width - indR] : [0, width];
  if (align === 'center') return stop((lo + hi) / 2, 'center', leader ?? 'none');
  if (align === 'right') return stop(hi, 'right', leader ?? 'none');
  return stop(lo, 'left', leader ?? 'none');
}

/** Whether cluster `c` is a decimal separator (pl_text_at). */
export const plTextAt = c => c.dot;

/**
 * Finish a centre/right/decimal tab whose text ends at `x` (resolve_tab). `pending` is a holder
 * `{tab: [tj, stop, tx] | null}`; `xs` the line's x so far; returns the shift applied to x.
 */
export function resolveTab(pl, pending, xs, c0, x) {
  const p = pending.tab;
  if (!p) return 0;
  pending.tab = null;
  const [tj, st, tx] = p;
  const seg = x - tx - (pl.clusters[tj]?.adv ?? 0);
  let want;
  if (st.align === 'right' || st.align === 'decimal') want = st.pos - tx - seg;
  else if (st.align === 'center') want = st.pos - tx - seg / 2;
  else return 0;
  want = Math.max(0, want);
  const old = pl.clusters[tj]?.adv ?? 0;
  const delta = want - old;
  if (Math.abs(delta) > 0.001) {
    if (pl.clusters[tj]) pl.clusters[tj].adv = want;
    for (let i = tj + 1 - c0; i < xs.length; i++) if (i >= 0) xs[i] += delta;
    return delta;
  }
  return 0;
}
