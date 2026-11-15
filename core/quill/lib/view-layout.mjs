// The layout a document view asks for (U:quill/view): which ViewMode, how wide the reflowed views
// run and how tall a reading column is, the reading line spacing and the outline state.
//
// Translated from wordcraft crates/engine/src/session/layout.rs (`layout_with`: Read Mode lays out
// at the reading column's width and height, Web Layout at the window's width, Draft and Outline at
// a fixed 800 pt column) and crates/engine/src/view.rs (DRAFT_WIDTH, default_read_width,
// default_read_height) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `metrics` are the window's (the page view measures them; never saved): {webWidth, readWidth,
// readHeight} in points. Headless, upstream's defaults apply.

import {outlineOf, layoutOutline} from './outline-view.mjs';

/** The text column of Draft and Outline, and of Web Layout without a window (DRAFT_WIDTH). */
export const DRAFT_WIDTH = 800;
/** A reading column without a window (default_read_width / default_read_height). */
export const READ_WIDTH = 300;
export const READ_HEIGHT = 500;
/** Immersive Reader: one column, its pages as tall as the layout allows (one long scroll). */
export const IMMERSIVE_HEIGHT = 20_000;

/** Views (ViewMode). */
export const MODES = Object.freeze(['print', 'web', 'draft', 'outline']);
/** Read Mode's column widths in points (read_column_width); null is Auto. */
export const COLUMN_WIDTHS = Object.freeze({auto: null, narrow: 180, medium: 240, wide: 350, page: 612});
export const READ_PAGE_COLORS = Object.freeze(['none', 'sepia', 'inverse']);
export const READ_LINE_SPACINGS = Object.freeze([1, 1.25, 1.5, 2]);
/** Immersive Reader's Text Spacing: wider lines (upstream's reading line spacing). */
export const TEXT_SPACING = 1.5;

/** The view state with upstream's defaults (ViewState::default) for what is read here. */
export function viewOf(v) {
  return {
    mode: MODES.includes(v?.mode) ? v.mode : 'print',
    readMode: !!v?.readMode,
    readColumnWidth: Number.isFinite(v?.readColumnWidth) ? v.readColumnWidth : null,
    readZoom: Number.isFinite(v?.readZoom) ? v.readZoom : 1,
    readLineSpacing: Number.isFinite(v?.readLineSpacing) ? v.readLineSpacing : null,
    readPageColor: READ_PAGE_COLORS.includes(v?.readPageColor) ? v.readPageColor : 'none',
    focusMode: !!v?.focusMode,
    immersive: !!v?.immersive,
    ruler: v?.ruler !== false,
    gridlines: !!v?.gridlines,
    // View › Dark Mode (the pages drawn dark), View › Full Screen (the window), Table Layout › View Gridlines (cell outlines on screen).
    darkMode: !!v?.darkMode,
    fullScreen: !!v?.fullScreen,
    tableGridlines: !!v?.tableGridlines,
    // Ctrl+F (edit.find) opens the pane through the edit family's own view state (view.quill.navPane).
    navPane: !!v?.navPane || !!v?.quill?.navPane,
    multiPage: !!v?.multiPage,
    singleColumn: !!v?.singleColumn,
    fit: v?.fit ?? null,
    pageMovement: v?.pageMovement === 'sideToSide' ? 'sideToSide' : 'vertical',
    split: !!v?.split,
    // View › Hide White Space (Print Layout's gaps between pages collapse); Immersive Reader's Line Focus (lines kept lit).
    hideWhiteSpace: !!v?.hideWhiteSpace,
    // Picture Format › Color › Set Transparent Color: the next click on a picture picks the colour.
    pickTransparent: !!v?.pickTransparent,
    // Wrap Text › Edit Wrap Points: the wrap polygon of the selected object is shown with a handle at each point.
    wrapPoints: !!v?.wrapPoints,
    lineFocus: [0, 1, 3, 5].includes(v?.lineFocus) ? v.lineFocus : 0,
  };
}

/** The layout the view lays out: print, web, draft, outline or read (Read Mode and Immersive Reader). */
export function layoutView(v) {
  const x = viewOf(v);
  return x.readMode || x.immersive ? 'read' : x.mode;
}

export function viewLayoutOptions(view, metrics = {}) {
  const mode = layoutView(view);
  const out = {view: mode};
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  if (mode === 'read') {
    out.webWidth = num(metrics.readWidth, READ_WIDTH);
    out.readHeight = view?.immersive ? IMMERSIVE_HEIGHT : num(metrics.readHeight, READ_HEIGHT);
    if (Number.isFinite(view?.readLineSpacing)) out.readLineSpacing = view.readLineSpacing;
  } else if (mode === 'web') out.webWidth = num(metrics.webWidth, DRAFT_WIDTH);
  else if (mode === 'draft' || mode === 'outline') out.webWidth = DRAFT_WIDTH;
  if (mode === 'outline') out.outline = layoutOutline(outlineOf(view));
  return out;
}
