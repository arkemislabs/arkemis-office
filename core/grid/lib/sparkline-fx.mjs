// What the Sparkline tab sets beyond type, colour and markers: the points shown (High, Low, Negative, First, Last), their
// colours, the 36 sparkline styles, the vertical axis options and groups.
// gridcraft keeps a sparkline as {cell, source, kind, color, markers} (crates/model/src/features.rs `Sparkline`): the rest is
// built from what Excel does (x14:sparklineGroup: displayHidden, minAxisType, maxAxisType, manualMin, manualMax, displayXAxis,
// rightToLeft, dateAxis and the colour elements), not checked against upstream. U:grid/sparkline. No DOM, no Node built-ins.
//
// Stored on a sparkline: `flags` {high, low, negative, first, last} (true), `colors` {negative, markers, high, low, first, last}
// (a colour: '#RRGGBB' or {theme, tint}), `style` (0 to 35, the gallery tile last applied), `axis` {min: 'auto' | 'same' | number,
// max: 'auto' | 'same' | number, show, rtl} and `group` (an id the group's members share).

export const POINTS = Object.freeze(['high', 'low', 'negative', 'first', 'last']);
export const POINT_LABELS = Object.freeze({high: 'High Point', low: 'Low Point', negative: 'Negative Points', first: 'First Point', last: 'Last Point', markers: 'Markers'});
export const COLOR_KEYS = Object.freeze(['negative', 'markers', 'high', 'low', 'first', 'last']);

const ACCENTS = [['Accent 1', 4], ['Accent 2', 5], ['Accent 3', 6], ['Accent 4', 7], ['Accent 5', 8], ['Accent 6', 9]];
const t = (theme, tint = 0) => ({theme, tint});
const RED = '#D64F45';

/**
 * The 36 styles of the Sparkline Styles gallery (six rows of six): Accent 1 to 6 as they are, darker by 25% and by 50%, lighter
 * by 40%, then Colorful and Dark in six variants. Each is {label, series, negative, markers, first, last, high, low}.
 */
export const SPARK_STYLES = Object.freeze((() => {
  const out = [];
  const make = (label, series, rest = {}) => out.push(Object.freeze({label, series, negative: RED, markers: series, first: RED, last: RED, high: RED, low: RED, ...rest}));
  const variants = [['', 0, 0], [', Darker 25%', -0.25, 0], [', Darker 50%', -0.5, 0], [', Lighter 40%', 0.4, 0]];
  for (const [name, theme] of ACCENTS) for (const [suffix, tint] of variants.slice(0, 4)) {
    if (out.length >= 24) break;
    make(`Sparkline Style ${name}${suffix}`, t(theme, tint), {negative: t(theme === 5 ? 6 : 5, 0), markers: t(theme, tint)});
  }
  for (let i = 0; i < 6; i++) {
    const [, theme] = ACCENTS[i];
    make(`Sparkline Style Colorful #${i + 1}`, t(theme, 0), {negative: t(ACCENTS[(i + 3) % 6][1], 0), markers: t(ACCENTS[(i + 1) % 6][1], 0), first: t(ACCENTS[(i + 2) % 6][1], 0), last: t(ACCENTS[(i + 4) % 6][1], 0), high: t(ACCENTS[(i + 5) % 6][1], 0), low: t(ACCENTS[(i + 3) % 6][1], 0)});
  }
  const darks = ['#323232', '#3C3C50', '#324632', '#503232', '#32465A', '#463C32'];
  darks.forEach((d, i) => make(`Sparkline Style Dark #${i + 1}`, d, {negative: '#D00000', markers: d, first: ACCENTS[i][1] ? t(ACCENTS[i][1], 0) : d, last: t(ACCENTS[i][1], 0), high: t(ACCENTS[(i + 1) % 6][1], 0), low: t(ACCENTS[(i + 2) % 6][1], 0)}));
  return out;
})());

export const sparkGroupMembers = (list, sp) => (sp.group ? list.filter(x => x.group === sp.group) : [sp]);

/** A sparkline's flags and colours with the defaults left out, `style` applied: what `renderSparkline` takes as `opts` (colours resolved by `rgb`). */
/** @param {any} sp @param {(c: any) => number[] | null} rgb @param {number[] | null} [sameRange] */
export function sparkOptions(sp, rgb, sameRange = null) {
  const colors = {};
  for (const k of COLOR_KEYS) if (sp.colors?.[k] !== undefined) colors[k] = rgb(sp.colors[k]);
  const ax = sp.axis ?? {};
  const num = (v, which) => (typeof v === 'number' && Number.isFinite(v) ? v : v === 'same' && sameRange ? sameRange[which] : null);
  return {flags: sp.flags ?? {}, colors, axis: {min: num(ax.min, 0), max: num(ax.max, 1), show: ax.show === true, rtl: ax.rtl === true}};
}
