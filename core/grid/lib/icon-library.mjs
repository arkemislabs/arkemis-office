// The Icons gallery of Insert > Illustrations: the names gridcraft offers (`icons::LIBRARY`, crates/
// ui-egui/src/icons.rs at 146161b4b450a56e5e59a083ba0478582d1e602b) with Arkemis's own drawings of
// them, as stroked SVG paths on a 24 x 24 grid (1.5 stroke, round caps), the way the app's icon set is.
// No DOM, no Node built-ins.

/** Every number of a path on the half-pixel grid the icon pipeline asks for (relative segments drift by less than a pixel). */
const snap = d => d.replace(/-?\d+(?:\.\d+)?/g, n => String(Math.round(Number(n) * 2) / 2));

const RAW = [
  ['check', 'M5 12.5l4.5 4.5L19 7.5'],
  ['close', 'M6 6l12 12M18 6L6 18'],
  ['plus', 'M12 5v14M5 12h14'],
  ['minus', 'M5 12h14'],
  ['chart', 'M4 20V4M4 20h16M8 20v-6M12 20V9M16 20v-9'],
  ['line chart', 'M4 20V4M4 20h16M7 15l4-4 3 3 5-6'],
  ['pie chart', 'M12 4a8 8 0 1 0 8 8h-8zM14.5 3.5a8 8 0 0 1 6 6h-6z'],
  ['scatter', 'M4 20V4M4 20h16M8 15h0M11 10h0M14 13h0M17 7h0M9 8h0'],
  ['table', 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14'],
  ['sum', 'M17 5H7l6 7-6 7h10'],
  ['filter', 'M4 5h16l-6 8v6l-4-2v-4z'],
  ['lock', 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  ['comment', 'M4 5h16v11H11l-4 4v-4H4z'],
  ['note', 'M6 4h12v16H6zM9 9h6M9 13h6'],
  ['picture', 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9h0'],
  ['book', 'M5 5a2 2 0 0 1 2-1h12v15H7a2 2 0 0 0-2 2zM5 19a2 2 0 0 1 2-2h12'],
  ['folder', 'M4 6h6l2 2h8v11H4z'],
  ['search', 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.5 16.5L21 21'],
  ['calculator', 'M6 3h12v18H6zM9 7h6M9 11h0M12 11h0M15 11h0M9 15h0M12 15h0M15 15h0'],
  ['link', 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  ['pen', 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3'],
  ['share', 'M17 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM7 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM9.2 10.7l5.6-3M9.2 13.3l5.6 3'],
  ['settings', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1'],
  ['home', 'M4 11l8-7 8 7M6 10v10h12V10M10 20v-6h4v6'],
  ['save', 'M5 4h12l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6'],
  ['theme', 'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2.5 1.5-2.5H17a4 4 0 0 0 4-4C21 7 17 3 12 3zM8 11h0M12 8h0M16 11h0'],
  ['shapes', 'M4 20l5-9 5 9zM14 4h6v6h-6zM17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6'],
  ['text', 'M5 5h14v14H5zM9 9h6M12 9v7'],
  ['trace', 'M5 18L19 6M19 6h-6M19 6v6M5 18h0'],
  ['validation', 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6zM9 12l2 2 4-4'],
];

export const ICON_LIBRARY = Object.freeze(RAW.map(([n, d]) => Object.freeze([n, snap(d)])));

export const ICON_NAMES = Object.freeze(ICON_LIBRARY.map(([n]) => n));

/** The drawing of an icon by name (case-insensitive), or null. */
export function iconPath(name) {
  const k = String(name).toLowerCase();
  return ICON_LIBRARY.find(([n]) => n === k)?.[1] ?? null;
}
