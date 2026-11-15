// Quill's editing surface: Word's Print Layout page view (docs/architecture.md 16.1; F:quill).
//
//   ┌──┬──────────────────────────────────────────────┐   horizontal ruler (caret page, indents)
//   │  │           ┌──────────────┐                    │
//   │▕ │           │  page 1      │  ┊ comment balloon │   pages on the dark canvas, centred,
//   │▕ │           │  (canvas     │                    │   side by side when zoomed out; each a
//   │  │           │   tiles)     │                    │   strip of <canvas> tiles painting the
//   │  │           └──────────────┘                    │   layout's display list at the device
//   │  │           ┌──────────────┐                    │   pixel ratio; DOM overlays for the
//   │  │           │  page 2      │                    │   selection, caret, IME preedit, object
//   vertical ruler                                        handles and comment balloons.
//
// Translated from wordcraft crates/ui-egui/src/canvas.rs (`show`, `paint_pages`, `prepare_view`,
// `update_caret_scroll`, `handle_primary_pointer`), canvas/input.rs (`mouse`, `handle_primary_press`,
// `handle_completed_click`, drag-select auto-scroll), canvas/pages.rs (page tiles), canvas/cursor.rs
// (`caret_screen`, `pos_from_screen`), canvas/navigation.rs, canvas/balloons.rs (the margin
// balloons: anchor, stacking, dashed leader), caret_glide.rs (BLINK_SECS, GLIDE_SECS),
// chrome.rs `status_bar` (Page X of Y, word count) and a11y.rs (the accessible mirror) at ArtCraft
// commit aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Every edit goes through the kernel (text.*, caret.*, select.* ui-commands), so a key, a click,
// the ribbon and the bridge share one undo stack. Review (U:quill/review): tracked changes are drawn
// per Display for Review (author colours and the Track Changes Options marks, change bars, the
// Original and No Markup views), comment ranges are highlighted, and the markup area holds comment
// threads (edited in place, Reply, Resolve, Delete), "Deleted:" and "Formatted:" balloons; the
// right-click menu of tracked text and of a comment balloon. View (U:quill/view): the five views
// (Print Layout; Web Layout's sheet as wide as the window; Draft and Outline on one long sheet,
// Draft's page breaks as dotted lines, Outline's symbols that select and expand a heading; Read
// Mode's columns turned with the arrows, its toolbar in place of the ribbon, Esc back), Focus (the
// page alone on black, Esc leaves), Immersive Reader's reading column, Side to Side, Gridlines,
// Split (two panes on the document, a draggable split bar), Synchronous Scrolling between windows
// viewed side by side, and the Navigation pane following the view (canvas.rs update_viewport,
// canvas/reading.rs, keys/canvas.rs read_mode_events, chrome.rs Screen and screen_bar,
// canvas/pages.rs drawing_grid). Not here yet (hidden, not imitated): Hide White Space,
// header/footer editing (insert.editHeader), dragging object handles (objects.*), link following,
// column (Alt+drag) selection, gallery live preview.

import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent} from 'react';
import {createPortal} from 'react-dom';
import type {SurfaceProps} from '../../../shell/AppHost';
import {CommandError, toCommandError} from '../../../../core/kernel/errors.mjs';
import {isSchema1, migrateFile} from '../../../../core/quill/migrate.mjs';
import {isQuill2} from '../../../../core/quill/model/content.mjs';
import {Document} from '../../../../core/quill/model/document.mjs';
import {objectAt as objectAtOffset} from '../../../../core/quill/model/para.mjs';
import {selectionPositions} from '../../../../core/quill/address.mjs';
import {CropHandles} from './CropHandles';
import {EditPoints, type PointsView} from './EditPoints';
import {isEdited, editableOf} from '../../../../core/quill/lib/shape-points.mjs';
import {pageDisplay, getDefaultShaper, outlineSymbolAt, layout as runLayout, pageRange} from '../../../../core/quill/layout/index.mjs';
import {viewOf as viewStateOf, layoutView} from '../../../../core/quill/lib/view-layout.mjs';
import {reviewLook, authorOrder, revisionColor} from '../../../../core/quill/layout/display.mjs';
import {reviewPresentation} from '../../../../core/quill/lib/review-markup.mjs';
import {deletionBalloons, formatChanges, changeAt} from '../../../../core/quill/lib/review-changes.mjs';
import {commentRange} from '../../../../core/quill/lib/review-comments.mjs';
import {caretInToc} from '../../../../core/quill/lib/references-toc.mjs';
import {spelling, watchSession} from '../../../../core/common/lib/spelling.mjs';
import {paraIssues, prepare as prepareProof, defaultLanguage as proofLanguage, sessionOf as proofSession} from '../../../../core/quill/lib/review-spelling.mjs';
import {selectedFields} from '../../../../core/quill/commands/fields.mjs';
import {useShellState} from '../../../shell/engine/useCommand';
import {createCanvasShaper} from '../../../../core/quill/layout/shaper-canvas.mjs';
import {resolvePara} from '../../../../core/quill/model/styles.mjs';
import {countWords} from '../../../../core/quill/model/text.mjs';
import * as G from './geometry.mjs';
import {layoutOf, viewOf, subscribe, useCanvasShaper, dropView, setReviewPrefs, layoutOptions, setMetrics} from './live.mjs';
import {paintPage, mediaUrl} from './paint.mjs';
import {paintWatermark} from './watermark.mjs';
import {DrawLayer, type Live} from './DrawLayer';
import {WrapPoints} from './WrapPoints';
import {wrapPolygonUnit} from '../../../../core/quill/model/wrap.mjs';
import {drawModeOf, gesture, isPen, visibleItems, lassoBounds, inkOrders} from './draw-input.mjs';
import {build as buildA11y, pageWindow} from './a11y.mjs';
import {HRuler, VRuler} from './Rulers';
import {TextInput, type Preedit, type Pos} from './ime';
import './surface.css';

type Rect = {x: number; y: number; w: number; h: number};
type Sel = {anchor: Pos; focus: Pos};
const OBJ = '\uFFFC';
const DRAWINGS = new Set(['image', 'graphic', 'shape', 'group']);

const samePos = (a: Pos, b: Pos) => a.story === b.story && a.off === b.off && a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i]);
const posKey = (p: Pos | null | undefined) => (p ? `${p.story}/${p.path.join('.')}/${p.off}` : '');

/** Display lists per laid-out page (a page object is new whenever it was laid out again), per marks and review look. */
const displays = new WeakMap<object, Map<string, any[]>>();
function displayOf(page: any, marks: boolean, look: any = null, lookKey = ''): any[] {
  let m = displays.get(page);
  if (!m) { m = new Map(); displays.set(page, m); }
  const k = `${marks ? 'm' : '-'}|${lookKey}`;
  let d = m.get(k);
  if (!d) { d = pageDisplay(page, {marks, review: look, tableGridlines: lookKey.endsWith('|g'), proof: look?.proof}); m.set(k, d); if (m.size > 8) m.delete(m.keys().next().value as string); }
  return d;
}
const ids = new WeakMap<object, number>();
let nextIdent = 1;
const identOf = (o: any) => { if (!o || typeof o !== 'object') return 0; let v = ids.get(o); if (!v) { v = nextIdent++; ids.set(o, v); } return v; };

/** The panes Review's commands show through the document view: view key → pane id. */
const REVIEW_PANES: [string, string][] = [['editorPane', 'pane.editor'], ['commentsPane', 'pane.comments'], ['reviewingPane', 'pane.reviewing'], ['restrictPane', 'pane.restrictEditing'], ['thesaurusPane', 'pane.thesaurus'],
  ['navPane', 'pane.navigation'], ['altTextPane', 'pane.altText'], ['formatShapePane', 'pane.formatShape'], ['smartArtPane', 'pane.smartArtText'], ['selectionPane', 'pane.selection'], ['accessibilityPane', 'pane.accessibility']];
const PANE_COMMANDS: Record<string, [string, Record<string, unknown>]> = {
  editorPane: ['review.spelling', {open: false}], commentsPane: ['view.commentsPane', {value: false}], reviewingPane: ['review.changes', {open: false}], restrictPane: ['review.restrict', {open: false}], thesaurusPane: ['review.thesaurus', {open: false}],
  navPane: ['view.navigationPane', {value: false}],
  altTextPane: ['view.altTextPane', {value: false}], formatShapePane: ['view.formatShapePane', {value: false}], smartArtPane: ['smartArt.textPane', {value: false}], selectionPane: ['arrange.selectionPane', {value: false}],
  accessibilityPane: ['view.accessibilityPane', {value: false}],
};
/** Read Mode's paper (render SEPIA_PAPER) and the reading colours (U:quill/view). */
const SEPIA_PAPER = [0xE2, 0xD9, 0xD0];
/** The drawing grid's smallest on-screen step and default spacing (canvas/pages.rs DRAWING_GRID_MIN_PX, doc DEFAULT_GRID). */
const GRID_MIN_PX = 4, DEFAULT_GRID = 9;
/** A window size change reflows Web Layout and Read Mode once it has settled this long (reading.rs RESIZE_SETTLE). */
const RESIZE_SETTLE_MS = 160;

/** The drawing grid's step at a scale (drawing_grid_step): doubled until it is at least 4 px apart. */
export function gridStep(spacing: number, scale: number): number {
  let step = Number.isFinite(spacing) && spacing > 0 ? spacing : DEFAULT_GRID;
  if (!(Number.isFinite(scale) && scale > 0)) return step;
  for (let i = 0; i < 16 && step * scale < GRID_MIN_PX; i++) step *= 2;
  return step;
}

/** Print Layout's page breaks for Draft (U:quill/view): where each printed page starts, and whether a page or section break put it there. */
const printBreaks = new WeakMap<object, {pos: Pos; kind: 'auto' | 'page' | 'section'}[]>();
function draftBreaks(content: any, d: any): {pos: Pos; kind: 'auto' | 'page' | 'section'}[] {
  let v = printBreaks.get(content);
  if (v) return v;
  v = [];
  try {
    const lay: any = runLayout(content, {view: 'print'});
    for (let n = 2; n <= lay.pages.length && v.length < 2000; n++) {
      const r: any = pageRange(lay, n);
      if (!r?.from) continue;
      const prevPath = r.from.off === 0 && r.from.path.length === 1 && r.from.path[0] > 0 ? [r.from.path[0] - 1] : null;
      const prev = prevPath ? d.para('body', prevPath) : null;
      const kind = prev?.section ? 'section' : prev && /$/.test(prev.text) ? 'page' : r.from.off > 0 && //.test(d.para('body', r.from.path)?.text.slice(0, r.from.off) ?? '') ? 'page' : 'auto';
      v.push({pos: r.from as Pos, kind});
    }
  } catch { /* no breaks drawn */ }
  printBreaks.set(content, v);
  return v;
}

/** Decoded images of content.media, shared by every tile. */
const imageCache = new Map<string, HTMLImageElement>();
function useImages(media: Record<string, string> | undefined) {
  const [version, setVersion] = useState(0);
  const get = useCallback((key: string) => {
    const data = media?.[key];
    if (!data) return null;
    const ck = `${key}:${data.length}:${data.slice(0, 32)}`;
    let img = imageCache.get(ck);
    if (!img) {
      img = new Image();
      img.onload = () => setVersion(v => v + 1);
      img.src = mediaUrl(key, data);
      imageCache.set(ck, img);
      if (imageCache.size > 512) imageCache.delete(imageCache.keys().next().value as string);
    }
    return img.complete && img.naturalWidth ? img : null;
  }, [media]);
  return {get, version};
}

function useDoc(session: SurfaceProps['controller']['session'], docId: string) {
  useSyncExternalStore(session.subscribe, () => (session as any).tick);
  try { return session.get(docId); } catch { return null; }
}

/** The text between two positions of one story (for the selected word count). */
function selectedText(d: any, a: Pos, b: Pos): string {
  if (a.story !== b.story) return '';
  const out: string[] = [];
  for (const path of d.pathsBetween(a, b)) {
    const p = d.para(a.story, path);
    if (!p) continue;
    const same = (x: Pos) => x.path.length === path.length && x.path.every((v: number, i: number) => v === path[i]);
    const from = same(a) ? a.off : 0, to = same(b) ? b.off : p.text.length;
    out.push(p.text.slice(from, to).split(OBJ).join(''));
  }
  return out.join('\n');
}

/** Comment anchors (commentStart objects) in the body: [{id, pos}]. */
function commentAnchors(d: any): {id: number; pos: Pos}[] {
  const out: {id: number; pos: Pos}[] = [];
  for (const path of d.paraPaths('body')) {
    const p = d.para('body', path);
    if (!p?.objects?.length) continue;
    let k = 0;
    for (let i = 0; i < p.text.length; i++) {
      if (p.text[i] !== OBJ) continue;
      const o = p.objects[k++];
      if (o?.type === 'commentStart') out.push({id: o.id, pos: {story: 'body', path, off: i}});
    }
  }
  return out;
}

function partText(content: any, part: number): string {
  const blocks = content?.parts?.[part]?.blocks ?? [];
  return blocks.filter((b: any) => b.kind === 'para').map((b: any) => b.text.split(OBJ).join('')).join('\n');
}

/**
 * The Canvas2D shaper measured at 32 times the size and scaled back: at a few CSS pixels a font's
 * advances come back hinted (rounded), while the page draws the same text at the zoomed size with
 * unrounded advances, so runs drew shorter than they were laid out and left gaps before the next
 * run. Measuring large gives the font's design advances, which is what the page draws.
 */
const MEASURE_SCALE = 32;
function precise(base: any) {
  const big = (f: any) => ({...f, size: f.size * MEASURE_SCALE});
  return {
    key: 'canvas-precise',
    metrics(f: any) { const m = base.metrics(big(f)); return {ascent: m.ascent / MEASURE_SCALE, descent: m.descent / MEASURE_SCALE}; },
    advance(text: string, f: any) { return base.advance(text, big(f)) / MEASURE_SCALE; },
  };
}

// --------------------------------------------------------------------------------------------

export default function QuillSurface({controller, docId, register}: SurfaceProps) {
  const session = controller.session;
  const doc: any = useDoc(session, docId);
  const content: any = doc?.file.content ?? null;
  const docView: any = doc?.view ?? {zoom: 100, fit: null};
  const ready = isQuill2(content);
  // The view (U:quill/view): which layout, which screen, and the reading presentation.
  const vs = viewStateOf(docView);
  const lmode = layoutView(docView);
  const reading = vs.readMode, immersive = vs.immersive, focusMode = vs.focusMode;
  const sheet = lmode === 'web' || lmode === 'draft' || lmode === 'outline';
  useCanvasShaper(() => precise(createCanvasShaper()));
  const live = viewOf(docId);
  const liveVersion = useSyncExternalStore(useCallback(f => subscribe(docId, f), [docId]), () => live.version);
  useEffect(() => () => dropView(docId), [docId]);

  // Schema 1 → 2 on opening (core/quill/migrate.mjs), before anything is edited.
  useEffect(() => {
    if (!doc || !isSchema1(content) || doc.dirty) return;
    try { session.reload(docId, migrateFile(doc.file) as any); } catch (e) { controller.notify(`This document could not be converted: ${toCommandError(e).message}`, 'error'); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  // Display for Review and the Track Changes Options (U:quill/review): what the layout leaves out and how revisions are drawn.
  const prefs: any = (session as any).prefs ?? {};
  setReviewPrefs(prefs);
  const presKey = `${docView.markup ?? ''}|${JSON.stringify(prefs.markup ?? null)}`;
  const pres = useMemo(() => reviewPresentation(docView, prefs), [presKey]);
  const optKey = JSON.stringify(layoutOptions(docView, live.metrics));
  const lay: any = useMemo(() => (ready ? layoutOf(docId, content, docView) : null), [ready, docId, content, optKey, presKey]);
  const d: any = useMemo(() => (ready ? new Document(content) : null), [ready, content]);
  const look0 = useMemo(() => (ready && d ? reviewLook(content, {...pres.look, paraMark: (story: any, path: number[]) => {
    const p = d.para(story, path);
    if (!p) return null;
    const m = p.mark ?? {};
    return {ins: m.ins !== undefined && m.ins !== null, del: m.del !== undefined && m.del !== null, fmt: !!m.fmtChange, props: !!p.props?.fmtChange};
  }}) : null), [ready, d, presKey]);
  const shell = useShellState();
  // The Review panes follow the document view (view.commentsPane, review.changes, review.restrict,
  // review.thesaurus); a pane closed with its own button turns its view flag off again.
  const paneSeen = useRef<Record<string, boolean>>({});
  // Ctrl+F opens the Navigation pane through the edit family's view state too (view.quill.navPane).
  const paneView: Record<string, unknown> = {...docView, navPane: vs.navPane};
  useEffect(() => {
    for (const [key, pane] of REVIEW_PANES) {
      const want = !!paneView[key];
      if (paneSeen.current[key] === want) continue;
      paneSeen.current[key] = want;
      try { if (controller.paneImplemented(pane) || !want) controller.setPane(pane, want); } catch { /* the pane is not translated */ }
    }
  }, [docView.editorPane, docView.commentsPane, docView.reviewingPane, docView.restrictPane, docView.thesaurusPane, docView.altTextPane, docView.formatShapePane, docView.smartArtPane, docView.selectionPane, docView.accessibilityPane, vs.navPane, controller]);
  useEffect(() => {
    for (const [key, pane] of REVIEW_PANES) {
      const open = shell.panes.some(p => p.id === pane && p.open);
      if (paneView[key] && paneSeen.current[key] && !open && shell.panes.some(p => p.id === pane)) {
        paneSeen.current[key] = false;
        const [id, params] = PANE_COMMANDS[key];
        void session.execute(docId, id, params, {origin: 'ui'}).catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell.panes]);
  const [activeComment, setActiveComment] = useState<number | null>(null);
  useEffect(() => { if (Number.isInteger(docView.activeComment)) setActiveComment(docView.activeComment); }, [docView.activeComment]);
  const pages: any[] = lay?.pages ?? [];

  // The selection as positions.
  const sel: Sel | null = useMemo(() => {
    if (!ready || !doc) return null;
    try {
      const all = selectionPositions(content, doc.selection);
      const r = all[doc.selection?.primary ?? 0] ?? all[0];
      if (r) return {anchor: r.anchor, focus: r.focus};
      const start = d.startOf('body');
      return {anchor: start, focus: start};
    } catch { return null; }
  }, [ready, content, doc?.selection, d]);

  // Spelling squiggles (U:quill/spelling): the misspelt words of the paragraphs drawn, from the shared service's cache. Words not looked up yet
  // are queued and the page draws again when the answers are in (`proofVersion`); only the pages on screen are ever asked about.
  const sp = spelling();
  const proofVersion = useSyncExternalStore(useCallback(f => sp.subscribe(f), [sp]), () => sp.version);
  useEffect(() => { sp.setUserWords(prefs.userDictionary); }, [sp, prefs.userDictionary]);
  useEffect(() => { watchSession(session); }, [session]);
  const proofOn = ready && prefs.checkSpelling !== false && !!d;
  // The word being typed has no squiggle until the caret leaves it (the caret sits where the last typing left it).
  const typingAt = (() => {
    const burst = (docView as any)?.quill?.burstSel;
    if (!proofOn || !sel || !burst || !samePos(sel.anchor, sel.focus)) return null;
    const key = JSON.stringify({anchor: {story: sel.anchor.story, path: sel.anchor.path, off: sel.anchor.off}, focus: {story: sel.focus.story, path: sel.focus.path, off: sel.focus.off}});
    return key === burst ? sel.focus : null;
  })();
  const typingKey = typingAt ? `${typingAt.story}/${typingAt.path.join('.')}/${typingAt.off}` : '';
  const proof = useMemo(() => {
    if (!proofOn) return null;
    const memo = new Map<string, any[]>();
    const proofKey = proofSession({host: (session as any).host, docId}), defaultLang = proofLanguage(content);
    return (story: any, path: number[]) => {
      const k = `${story}/${path.join('.')}`;
      let v = memo.get(k);
      if (!v) {
        const p = d.para(story, path);
        v = p ? paraIssues(p, sp, {session: proofKey, defaultLang}) : [];
        if (typingAt && typingAt.story === story && typingAt.path.join('.') === path.join('.')) v = v.filter((t: any) => !(t.start <= typingAt.off && typingAt.off <= t.end));
        memo.set(k, v);
      }
      return v;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proofOn, d, sp, proofVersion, typingKey, docId]);
  const look = useMemo(() => (look0 ? {...look0, proof} : null), [look0, proof]);
  const lookKey = `${presKey}|${identOf(content?.revisions)}|${identOf(content?.body)}|s${proofOn ? proofVersion : 'x'}.${typingKey}${vs.tableGridlines ? '|g' : ''}`;

  // Scroll area size and position.
  const scroller = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({w: 0, h: 0, top: 0, left: 0});
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setBox(b => ({...b, w: el.clientWidth, h: el.clientHeight, top: el.scrollTop, left: el.scrollLeft}));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);
  const onScroll = () => { const el = scroller.current; if (el) setBox(b => (b.top === el.scrollTop && b.left === el.scrollLeft ? b : {...b, top: el.scrollTop, left: el.scrollLeft})); };

  const hasComments = ready && Object.keys(content?.comments ?? {}).length > 0;
  const cards = useMemo(() => (ready && d ? reviewCards(content, d, pres) : []), [ready, d, presKey]);
  // The markup area is Print Layout's (Word draws no balloons in Draft, Outline, Read Mode or Web Layout's sheet edge).
  const markup = pres.markupArea && cards.length && lmode === 'print' ? G.MARKUP_WIDTH : 0;
  const commentMarks = useMemo(() => {
    const by = new Map<number, {id: number; r: Rect}[]>();
    if (!lay || !d || !hasComments || !pres.balloons.comments) return by;
    for (const id of Object.keys(content.comments).map(Number)) {
      if (content.comments[id]?.parent !== null && content.comments[id]?.parent !== undefined) continue;
      const range = commentRange(d, id);
      if (!range || range[0].story !== 'body') continue;
      for (const [pi, r] of lay.selectionRects(range[0], range[1], live.pageHint)) {
        let v = by.get(pi);
        if (!v) { v = []; by.set(pi, v); }
        if (v.length < 2000) v.push({id, r});
      }
    }
    return by;
  }, [lay, d, hasComments, presKey]);
  // Content controls (Developer): Design Mode outlines each one with its title; otherwise the control holding the caret is outlined.
  const designMode = !!docView.designMode;
  const hereKey = d && sel ? (() => { try { const r = d.controlAt(d.clamp(sel.focus)); return r ? `${r.start.path.join('.')}:${r.start.off}` : ''; } catch { return ''; } })() : '';
  const controlMarks = useMemo(() => {
    const by = new Map<number, {r: Rect; title: string | null; active: boolean}[]>();
    if (!lay || !d || (!designMode && !hereKey)) return by;
    let ranges: any[] = [];
    try { ranges = d.controlRanges('body').filter((r: any) => Number.isInteger(r.start.off) && Number.isInteger(r.end.off)); } catch { ranges = []; }
    for (const r of ranges.slice(0, 500)) {
      const active = `${r.start.path.join('.')}:${r.start.off}` === hereKey;
      if (!designMode && !active) continue;
      const end = {...r.end, off: r.end.off + 1};
      let first = true;
      for (const [pi, rc] of lay.selectionRects(r.start, end, live.pageHint)) {
        let v = by.get(pi);
        if (!v) { v = []; by.set(pi, v); }
        if (v.length < 2000) v.push({r: rc, title: null, active});
        first = false;
      }
    }
    return by;
  }, [lay, d, designMode, hereKey]);
  const geoView = {...docView, ...vs};
  const geo = useMemo(() => G.geometry(pages, geoView, {w: box.w || 800, h: box.h || 600}, markup),
    [pages, docView.zoom, docView.fit, docView.multiPage, docView.singleColumn, vs.mode, reading, immersive, vs.readZoom, vs.pageMovement, vs.hideWhiteSpace, box.w, box.h, markup]);

  // The window's sizes the reflowed views lay out at (canvas.rs update_viewport): Web Layout wraps
  // to the work area, Read Mode's columns fill the window, Immersive Reader keeps one column; at
  // once on entry or a zoom, after a resize has settled otherwise.
  const metricsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metricsMode = useRef('');
  useLayoutEffect(() => {
    if (!box.w || !box.h) return;
    const want: Record<string, number> = {};
    if (reading) {
      const [w, h] = G.readingSize({w: box.w, h: box.h}, vs.readZoom * G.PX_PER_PT, vs.readColumnWidth ?? undefined);
      want.readWidth = w; want.readHeight = h;
    } else if (immersive) {
      const s = vs.readZoom * G.PX_PER_PT;
      want.readWidth = Math.max(144, Math.min(vs.readColumnWidth ?? 350, (box.w - 2 * G.GAP - 36) / s));
    } else if (lmode === 'web') want.webWidth = G.webLayoutWidth(box.w - 2, (docView.zoom ?? 100) / 100 * G.PX_PER_PT);
    else return;
    const key = `${lmode}|${reading}|${immersive}|${vs.readZoom}|${vs.readColumnWidth}|${docView.zoom}`;
    const entering = metricsMode.current !== key;
    metricsMode.current = key;
    if (metricsTimer.current) clearTimeout(metricsTimer.current);
    if (entering) setMetrics(docId, want);
    else metricsTimer.current = setTimeout(() => setMetrics(docId, want), RESIZE_SETTLE_MS);
  }, [box.w, box.h, lmode, reading, immersive, vs.readZoom, vs.readColumnWidth, docView.zoom, docId]);
  useEffect(() => () => { if (metricsTimer.current) clearTimeout(metricsTimer.current); }, []);

  // Caret and selection geometry.
  const caret = useMemo(() => (lay && sel ? lay.caret(sel.focus, live.pageHint) : null), [lay, sel, liveVersion]);
  const collapsed = !sel || samePos(sel.anchor, sel.focus);
  const selRects = useMemo(() => {
    const by = new Map<number, Rect[]>();
    if (!lay || !sel || collapsed) return by;
    for (const [pi, r] of lay.selectionRects(sel.anchor, sel.focus, live.pageHint)) {
      let v = by.get(pi);
      if (!v) { v = []; by.set(pi, v); }
      if (v.length < 4000) v.push(r);
    }
    return by;
  }, [lay, sel, collapsed]);
  const objectSel = useMemo(() => {
    if (!lay || !sel || !d || collapsed) return null;
    const [a, b] = [sel.anchor, sel.focus].sort((x, y) => (x.off - y.off));
    if (a.story !== b.story || !samePos({...a, off: 0}, {...b, off: 0}) || b.off !== a.off + 1) return null;
    const para = d.paraAt(a);
    if (para?.text[a.off] !== OBJ) return null;
    let k = 0;
    for (let i = 0; i < a.off; i++) if (para.text[i] === OBJ) k++;
    const o = para.objects?.[k];
    if (!o || !DRAWINGS.has(o.type)) return null;
    for (let pi = 0; pi < pages.length; pi++) {
      for (const it of pages[pi].items) {
        if ((it.kind === 'object' || it.kind === 'image') && it.off === a.off && it.story === a.story && it.path?.length === a.path.length && it.path.every((v: number, i: number) => v === a.path[i])) {
          return {page: pi, rect: it.rect as Rect, rot: it.rot ?? 0, type: o.type as string, crop: ((o as any).crop ?? [0, 0, 0, 0]) as number[], obj: o as any};
        }
      }
    }
    const c = lay.caret(a, live.pageHint);
    return c ? {page: c.page, rect: {x: c.x, y: c.top, w: o.w ?? 0, h: o.h ?? c.height}, rot: 0, type: o.type as string, crop: ((o as any).crop ?? [0, 0, 0, 0]) as number[], obj: o as any} : null;
  }, [lay, sel, d, collapsed, pages]);
  // Edit Wrap Points: the wrap polygon of the selected picture or shape, with its handles.
  const wrapPts = useMemo(() => {
    const poly = docView.wrapPoints && objectSel && (objectSel.type === 'image' || objectSel.type === 'shape') ? (objectSel as any).obj?.float?.wrapPolygon : null;
    return poly?.points?.length >= 3 ? {page: objectSel!.page, rect: objectSel!.rect, rot: objectSel!.rot, unit: wrapPolygonUnit(poly) as [number, number][]} : null;
  }, [docView.wrapPoints, objectSel]);
  // The equation the selection is on (Insert › Equation, a double-click): where it is drawn, for the in-place editor.
  const eqSel = useMemo(() => {
    if (!lay || !sel || !d || collapsed) return null;
    const [a, b] = [sel.anchor, sel.focus].sort((x, y) => (x.off - y.off));
    if (a.story !== b.story || !samePos({...a, off: 0}, {...b, off: 0}) || b.off !== a.off + 1) return null;
    const para = d.paraAt(a);
    if (para?.text[a.off] !== OBJ) return null;
    let k = 0;
    for (let i = 0; i < a.off; i++) if (para.text[i] === OBJ) k++;
    const o = para.objects?.[k];
    if (o?.type !== 'equation') return null;
    for (let pi = 0; pi < pages.length; pi++) {
      for (const it of pages[pi].items) {
        if (it.kind === 'math' && it.off === a.off && it.story === a.story && it.path?.length === a.path.length && it.path.every((v: number, i: number) => v === a.path[i])) return {page: pi, rect: it.rect as Rect, linear: String(o.linear ?? '')};
      }
    }
    return null;
  }, [lay, sel, d, collapsed, pages]);
  // The other objects picked with Shift+click: each a range of the selection of its own, drawn as a frame.
  const otherObjs = useMemo(() => {
    const out: {page: number; rect: Rect; rot: number}[] = [];
    if (!lay || !d || !ready || !doc?.selection) return out;
    try {
      const all = selectionPositions(content, doc.selection);
      const primary = doc.selection.primary ?? 0;
      all.forEach((r: any, i: number) => {
        if (i === primary || r.anchor.story !== r.focus.story) return;
        const a = r.anchor, b = r.focus;
        const [lo, hi] = a.off <= b.off ? [a, b] : [b, a];
        if (hi.off !== lo.off + 1) return;
        for (let pi = 0; pi < pages.length; pi++) {
          const it = pages[pi].items.find((x: any) => x.kind === 'object' && x.off === lo.off && x.story === lo.story && x.path?.length === lo.path.length && x.path.every((v: number, k: number) => v === lo.path[k]));
          if (it) { out.push({page: pi, rect: it.rect as Rect, rot: it.rot ?? 0}); break; }
        }
      });
    } catch { /* no other objects */ }
    return out;
  }, [lay, d, ready, content, doc?.selection, pages]);

  // Crop mode ends when something other than a picture is selected (Word: a click away).
  useEffect(() => {
    if (docView.cropping && objectSel?.type !== 'image') void session.execute(docId, 'view.cropMode', {value: false}, {origin: 'ui'}).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docView.cropping, objectSel?.type]);

  // Edit Points (Shape Format › Edit Shape): the selected shape's outline as path data, with its vertices and handles on the page; it
  // ends when something other than that shape is selected (Word: a click away).
  const pointsShape = useMemo(() => {
    if (!docView.editPoints || objectSel?.type !== 'shape' || !isEdited((objectSel as any).obj)) return null;
    return {page: objectSel.page, sh: editableOf((objectSel as any).obj, objectSel.rect), state: docView.editPoints as PointsView};
  }, [docView.editPoints, objectSel]);
  useEffect(() => {
    if (docView.editPoints && !pointsShape) void session.execute(docId, 'shape.editPoints', {on: false}, {origin: 'ui'}).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docView.editPoints, !!pointsShape]);

  // Which page is in view (status bar, rulers).
  const caretBand = caret && geo.rects[caret.page] ? (() => {
    const r = geo.rects[caret.page];
    const s = G.pageScale(r, pages[caret.page], geo.scale);
    return {page: caret.page, top: r.y + caret.top * s, bottom: r.y + (caret.top + caret.height) * s};
  })() : null;
  const viewed = G.viewedPage(caretBand, geo.rects, box.top, box.h);
  useEffect(() => { live.viewedPage = viewed; }, [viewed, live]);

  // Focus.
  const [focused, setFocused] = useState(false);
  const [preedit, setPreedit] = useState<Preedit | null>(null);
  const lastMove = useRef<'key' | 'click' | 'other'>('other');

  const exec = useCallback(async (id: string, params: Record<string, unknown> = {}, quiet = false) => {
    try {
      return await session.execute(docId, id, params, {origin: 'ui'});
    } catch (e) {
      if (!quiet) controller.notify(toCommandError(e).message, 'error');
      return null;
    }
  }, [session, docId, controller]);

  // Text input (EditContext, or a hidden textarea).
  const readOnly = useRef(false);
  readOnly.current = reading;
  const input = useRef<TextInput | null>(null);
  const caretClient = useRef<() => DOMRect | null>(() => null);
  const readSel = useRef<() => {doc: any; anchor: Pos; focus: Pos} | null>(() => null);
  readSel.current = () => (d && sel ? {doc: d, anchor: sel.anchor, focus: sel.focus} : null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const t = new TextInput(el, {
      read: () => readSel.current(),
      // Read Mode is for reading and selecting, not typing (keys/canvas.rs read_mode_events).
      run: async (id, params) => { if (readOnly.current && !/^(caret|select)\.|^edit\.copy$/.test(id)) return null; lastMove.current = 'key'; return exec(id, params); },
      preedit: p => setPreedit(p),
      caretRect: () => caretClient.current(),
    });
    input.current = t;
    return () => { t.dispose(); input.current = null; };
  }, [exec, ready]);
  useEffect(() => { input.current?.sync(); }, [d, sel]);

  // Keys KeyRouter has no binding for: Shift with the caret keys extends; Ctrl/Alt variants.
  const keyCommand = useCallback((key: string, mods: {shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean}): [string, Record<string, unknown>] | null => {
    const word = mods.ctrl || mods.alt;
    const map: Record<string, string> = word
      ? {ArrowLeft: 'caret.wordLeft', ArrowRight: 'caret.wordRight', ArrowUp: 'caret.paraUp', ArrowDown: 'caret.paraDown', Home: 'caret.docStart', End: 'caret.docEnd'}
      : {ArrowLeft: 'caret.left', ArrowRight: 'caret.right', ArrowUp: 'caret.up', ArrowDown: 'caret.down', Home: 'caret.home', End: 'caret.end', PageUp: 'caret.pageUp', PageDown: 'caret.pageDown'};
    const id = map[key];
    if (!id) return null;
    if (mods.alt && (key === 'Home' || key === 'End')) return null;
    return [id, mods.shift ? {extend: true} : {}];
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || input.current?.isComposing() || e.nativeEvent.isComposing) return;
    if (reading) {
      // Read Mode: the arrows and Page Up / Page Down turn the page (read_mode_events).
      const dir = ['ArrowRight', 'PageDown', 'ArrowDown'].includes(e.key) ? 1 : ['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key) ? -1 : 0;
      if (dir && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); turnPage(dir); }
      return;
    }
    // Edit Points: Delete takes out the point that is picked (not the shape).
    if ((e.key === 'Delete' || e.key === 'Backspace') && pointsShape && docView.editPoints?.vertex && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      void exec('shape.deletePoint', {}, true);
      return;
    }
    const c = keyCommand(e.key, {shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey});
    if (!c) return;
    e.preventDefault();
    lastMove.current = 'key';
    void exec(c[0], c[1], true);
  };

  // The Draw tab (U:quill/draw): with a pen, the eraser or the lasso picked, dragging on the page draws, erases or selects ink
  // instead of selecting text. The same gesture (page + points) is what the bridge's ui.pointer {action: 'stroke'} runs.
  const drawMode = drawModeOf(docView);
  const drawOn = ready && !reading && drawMode !== 'select';
  const [liveInk, setLiveInk] = useState<Live | null>(null);
  const inkGesture = useRef<{page: number; pts: [number, number][]} | null>(null);
  // Table Layout > Draw: with the pen on, a dragged rectangle draws a table and a dragged line splits cells (table.draw); with the eraser on, a click removes the border under it (table.eraser).
  const tablePen = (docView.tableDraw === 'draw' || docView.tableDraw === 'erase' || docView.tableDraw === 'sample') && ready && !reading ? (docView.tableDraw as string) : null;
  const penGesture = useRef<{page: number; x0: number; y0: number; x1: number; y1: number} | null>(null);
  const [penRect, setPenRect] = useState<{page: number; rect: {x: number; y: number; w: number; h: number}} | null>(null);
  const [replayMax, setReplayMax] = useState<number | null>(null);
  const lassoSel = docView.draw?.lasso && docView.draw.lasso.version === doc?.version ? docView.draw.lasso : null;
  const lassoBox = useMemo(() => {
    if (!lassoSel || !lay) return null;
    const rect = lassoBounds(lay, lassoSel.page, lassoSel.items);
    return rect ? {page: lassoSel.page as number, rect} : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lay, doc?.version, docView.draw?.lasso]);
  const runGesture = useCallback(async (mode: string, page: number, pts: [number, number][]) => {
    const cmds = gesture(mode, page, pts, lassoSel && lassoBox ? {page: lassoSel.page, rect: lassoBox.rect} : null) as [string, Record<string, unknown>][];
    let last: any = null;
    for (const [id, p] of cmds) last = await exec(id, p, true);
    return {mode, commands: cmds.length, result: last?.result ?? null};
  }, [exec, lassoSel, lassoBox]);
  const livePen = (kind: Live['kind']): Live | null => {
    const pen = docView.draw?.[drawMode] ?? {color: [0, 0, 0], width: 1.5};
    return {page: inkGesture.current?.page ?? 0, pts: inkGesture.current?.pts ?? [], kind, color: pen.color ?? [0, 0, 0], width: pen.width ?? 1.5, alpha: drawMode === 'highlighter' ? 0.5 : drawMode === 'pencil' ? 0.85 : 1};
  };
  // Ink Replay plays the strokes back in the order they were drawn, then turns itself off (draw.replay).
  const replaying = !!docView.draw?.replay;
  useEffect(() => {
    if (!replaying || !content) { setReplayMax(null); return; }
    const orders: number[] = inkOrders(content);
    if (!orders.length) { void exec('draw.replay', {value: false}, true); return; }
    let i = 0;
    setReplayMax(-1);
    const timer = setInterval(() => {
      if (i < orders.length) { setReplayMax(orders[i]); i++; } else { clearInterval(timer); setReplayMax(null); void exec('draw.replay', {value: false}, true); }
    }, 260);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaying]);

  // Pointer: click, drag, double/triple-click, Shift+click, selection bar (input.rs).
  const press = useRef<{time: number; x: number; y: number; n: number} | null>(null);
  const drag = useRef<{unit: string | null; start: Pos | null; end: Pos | null; active: boolean; px: number; py: number; raf: number; t: number} | null>(null);
  const toContent = (clientX: number, clientY: number) => {
    const el = contentRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x: clientX - r.left, y: clientY - r.top};
  };
  const hitAt = (x: number, y: number) => {
    if (!lay) return null;
    const at = G.pageAt(geo.rects, pages, geo.scale, x, y);
    if (!at) return null;
    return {...at, pos: lay.hit(at.page, at.x, at.y, sel?.focus.story ?? 'body') as Pos | null};
  };

  const pressAt = useCallback(async (x: number, y: number, mods: {shift?: boolean; ctrl?: boolean; alt?: boolean}, now: number) => {
    if (!lay) return;
    const clicks = G.pressCount(press.current, now, x, y);
    press.current = {time: now, x, y, n: clicks};
    lastMove.current = 'click';
    const at = G.pageAt(geo.rects, pages, geo.scale, x, y);
    if (!at) return;
    live.pageHint = at.page;
    // Set Transparent Color: this click picks the colour that becomes transparent (picture.pickTransparent); on anything but a picture it only ends the mode.
    if (docView.pickTransparent) {
      const hit = lay.objectAt(at.page, at.x, at.y);
      try {
        if (hit && hit.story === 'body') {
          await exec('select.range', {anchor: {story: hit.story, path: hit.path, off: hit.off}, focus: {story: hit.story, path: hit.path, off: hit.off + 1}}, true);
          await exec('picture.setTransparentColor', {at: [(at.x - hit.rect.x) / Math.max(hit.rect.w, 1), (at.y - hit.rect.y) / Math.max(hit.rect.h, 1)]}, true);
        }
      } catch { /* not a picture: nothing changes */ }
      await exec('picture.pickTransparent', {value: false}, true);
      drag.current = null;
      return;
    }
    // Outline view: a click on a heading's symbol selects it and what is under it; a double-click
    // expands or collapses all of it (canvas/input.rs, outline.selectSubtree / outline.toggle).
    if (lmode === 'outline' && !mods.shift) {
      const blk = outlineSymbolAt(lay, at.page, at.x, at.y);
      if (blk !== null) {
        await exec(clicks >= 2 ? 'outline.toggle' : 'outline.selectSubtree', {block: blk}, true);
        drag.current = null;
        return;
      }
    }
    // The selection bar (left margin beside body text): line, paragraph, document.
    if (!mods.alt) {
      const line = lay.selectionBarAt(at.page, at.x, at.y) as Pos | null;
      if (line) {
        if (mods.shift && sel) {
          await exec('select.dragUnit', {unit: 'line', start: sel.anchor, end: sel.anchor, pos: line}, true);
          drag.current = {unit: 'line', start: sel.anchor, end: sel.anchor, active: true, px: x, py: y, raf: 0, t: now};
          return;
        }
        const unit = mods.ctrl || clicks >= 3 ? 'document' : clicks === 2 ? 'paragraph' : 'line';
        await exec('caret.set', {pos: line}, true);
        const r: any = await exec(unit === 'document' ? 'select.all' : unit === 'paragraph' ? 'select.paragraph' : 'select.line', unit === 'document' ? {whole: true} : {}, true);
        const s = r?.selection ? selectionPositions(session.get(docId).file.content, r.selection)[0] : null;
        drag.current = {unit, start: s ? s.anchor : line, end: s ? s.focus : line, active: true, px: x, py: y, raf: 0, t: now};
        return;
      }
    }
    // A double-click on an equation opens the Edit Equation box (Word edits an equation in place; here it is edited as its text).
    if (clicks >= 2 && !mods.shift && !mods.alt && !mods.ctrl) {
      const hit = lay.objectAt(at.page, at.x, at.y);
      if (hit && hit.story === (sel?.focus.story ?? 'body')) {
        try {
          const dd: any = new Document(session.get(docId).file.content);
          const para = dd.para(hit.story, hit.path);
          if ((para ? objectAtOffset(para, hit.off) : null)?.type === 'equation') {
            await exec('select.range', {anchor: {story: hit.story, path: hit.path, off: hit.off}, focus: {story: hit.story, path: hit.path, off: hit.off + 1}}, true);
            drag.current = null;
            setEqEditing(true);
            return;
          }
        } catch { /* not an equation: the double-click selects a word */ }
      }
    }
    // Shift or Ctrl+click on a picture or shape adds it to the selected objects, or takes it out again (select.addObject).
    if ((mods.shift || mods.ctrl) && !mods.alt && clicks === 1) {
      const o = lay.objectAt(at.page, at.x, at.y);
      if (o && o.story === 'body') {
        try { await exec('select.addObject', {pos: {story: o.story, path: o.path, off: o.off}}, true); drag.current = null; return; } catch { /* not an object a selection can hold: a plain click */ }
      }
    }
    const pos = lay.hit(at.page, at.x, at.y, sel?.focus.story ?? 'body') as Pos | null;
    if (!pos) return;
    await exec('caret.set', {pos, extend: !!mods.shift}, true);
    // A click on a content control's check box checks or clears it (Developer › Toggle Check Box).
    if (!mods.shift && !mods.ctrl && !mods.alt && clicks === 1) {
      try {
        const dd: any = new Document(session.get(docId).file.content);
        const cr = dd.controlAt(dd.clamp(pos));
        if (cr && Number.isInteger(cr.start.off) && cr.control.kind?.type === 'checkBox') { await exec('developer.toggleCheckBox', {at: pos}, true); drag.current = null; return; }
      } catch { /* not a Quill 2 document: a plain click */ }
    }
    const unit = mods.shift ? null : clicks === 3 ? 'paragraph' : clicks === 2 ? 'word' : clicks === 1 && mods.ctrl ? 'sentence' : null;
    if (unit) {
      const r: any = await exec(`select.${unit}`, {}, true);
      const s = r?.selection ? selectionPositions(session.get(docId).file.content, r.selection)[0] : null;
      const [a, b] = s ? [s.anchor, s.focus] : [pos, pos];
      drag.current = {unit, start: a, end: b, active: true, px: x, py: y, raf: 0, t: now};
    } else drag.current = {unit: null, start: null, end: null, active: true, px: x, py: y, raf: 0, t: now};
    // Also hit-test objects: a click on a picture or shape selects it (its anchor character).
    const obj = lay.objectAt(at.page, at.x, at.y);
    if (obj && !mods.shift && !unit && obj.story === pos.story) {
      await exec('select.range', {anchor: {story: obj.story, path: obj.path, off: obj.off}, focus: {story: obj.story, path: obj.path, off: obj.off + 1}}, true);
      drag.current = null;
    }
  }, [lay, geo, pages, sel, exec, live, session, docId, lmode, docView.pickTransparent]);

  const moveTo = useCallback(async (x: number, y: number) => {
    const dr = drag.current;
    if (!dr?.active || !lay) return;
    dr.px = x; dr.py = y;
    const h = hitAt(x, y);
    if (!h?.pos) return;
    if (dr.unit && dr.start && dr.end) await exec('select.dragUnit', {unit: dr.unit, start: dr.start, end: dr.end, pos: h.pos}, true);
    else await exec('caret.set', {pos: h.pos, extend: true}, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lay, geo, pages, exec]);

  const release = useCallback(() => {
    const dr = drag.current;
    if (dr?.raf) cancelAnimationFrame(dr.raf);
    drag.current = null;
  }, []);

  // Drag-select auto-scroll at the viewport's edges (input.rs edge_scroll).
  const autoScroll = useCallback((clientX: number, clientY: number) => {
    const el = scroller.current, dr = drag.current;
    if (!el || !dr?.active) return;
    const step = (t: number) => {
      const cur = drag.current;
      if (!cur?.active) return;
      const r = el.getBoundingClientRect();
      const dt = Math.min((t - cur.t) / 1000, G.EDGE_MAX_DT);
      cur.t = t;
      const dy = G.edgeScroll(clientY, r.top, r.bottom, dt), dx = G.edgeScroll(clientX, r.left, r.right, dt);
      if (dy || dx) {
        el.scrollTop -= dy;
        el.scrollLeft -= dx;
        const p = toContent(clientX, clientY);
        if (p) void moveTo(p.x, p.y);
      }
      cur.raf = requestAnimationFrame(step);
    };
    if (dr.raf) cancelAnimationFrame(dr.raf);
    dr.t = performance.now();
    dr.raf = requestAnimationFrame(step);
  }, [moveTo]);

  const onPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0 || !lay) return;
    const p = toContent(e.clientX, e.clientY);
    if (!p) return;
    if (tablePen) {
      const at = G.pageAt(geo.rects, pages, geo.scale, p.x, p.y);
      if (!at) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      if (tablePen === 'erase') { void exec('table.eraser', {page: at.page, x: at.x, y: at.y}, true); return; }
      if (tablePen === 'sample') { void exec('table.borderSample', {page: at.page, x: at.x, y: at.y}, true); return; }
      penGesture.current = {page: at.page, x0: at.x, y0: at.y, x1: at.x, y1: at.y};
      setPenRect({page: at.page, rect: {x: at.x, y: at.y, w: 0, h: 0}});
      return;
    }
    if (drawOn) {
      const at = G.pageAt(geo.rects, pages, geo.scale, p.x, p.y);
      if (!at) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      inkGesture.current = {page: at.page, pts: [[at.x, at.y]]};
      if (drawMode === 'eraser') void exec('draw.erase', {page: at.page, x: at.x, y: at.y}, true);
      setLiveInk(livePen(isPen(drawMode) ? 'stroke' : drawMode === 'eraser' ? 'erase' : 'lasso'));
      return;
    }
    e.preventDefault();
    input.current?.focusTarget().focus({preventScroll: true});
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    void pressAt(p.x, p.y, {shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey}, e.timeStamp || performance.now());
  };
  const onPointerMove = (e: RPointerEvent) => {
    const pg = penGesture.current;
    if (pg) {
      const q = toContent(e.clientX, e.clientY);
      const at = q ? G.pageAt(geo.rects, pages, geo.scale, q.x, q.y) : null;
      if (at && at.page === pg.page) {
        pg.x1 = at.x; pg.y1 = at.y;
        setPenRect({page: pg.page, rect: {x: Math.min(pg.x0, at.x), y: Math.min(pg.y0, at.y), w: Math.abs(at.x - pg.x0), h: Math.abs(at.y - pg.y0)}});
      }
      return;
    }
    const g = inkGesture.current;
    if (g) {
      const q = toContent(e.clientX, e.clientY);
      const at = q ? G.pageAt(geo.rects, pages, geo.scale, q.x, q.y) : null;
      if (at && at.page === g.page) {
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(at.x - last[0], at.y - last[1]) >= 0.6) {
          g.pts.push([at.x, at.y]);
          if (drawMode === 'eraser') void exec('draw.erase', {page: g.page, x: at.x, y: at.y}, true);
          setLiveInk(livePen(isPen(drawMode) ? 'stroke' : drawMode === 'eraser' ? 'erase' : 'lasso'));
        }
      }
      return;
    }
    if (!drag.current?.active) return;
    const p = toContent(e.clientX, e.clientY);
    if (p) void moveTo(p.x, p.y);
    autoScroll(e.clientX, e.clientY);
  };
  const onPointerUp = (e: RPointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    const pg = penGesture.current;
    if (pg) {
      penGesture.current = null;
      setPenRect(null);
      if (Math.abs(pg.x1 - pg.x0) > 1 || Math.abs(pg.y1 - pg.y0) > 1) void exec('table.draw', {page: pg.page, x0: pg.x0, y0: pg.y0, x1: pg.x1, y1: pg.y1}, true);
      return;
    }
    const g = inkGesture.current;
    if (g) {
      inkGesture.current = null;
      setLiveInk(null);
      if (drawMode !== 'eraser') void runGesture(drawMode, g.page, g.pts);
      return;
    }
    release();
    lastMove.current = 'other';
  };

  // Keep the caret in view after keys and typing (canvas.rs update_caret_scroll).
  const caretKey = posKey(sel?.focus);
  useLayoutEffect(() => {
    // A click or drag keeps the view where it is (the drag auto-scrolls itself); keys, typing,
    // ribbon commands and the bridge bring the caret into view.
    if (lastMove.current === 'click' || !caretBand) return;
    const el = scroller.current;
    if (!el) return;
    const margin = 24;
    if (caretBand.top < el.scrollTop + margin) el.scrollTop = Math.max(0, caretBand.top - margin);
    else if (caretBand.bottom > el.scrollTop + el.clientHeight - margin) el.scrollTop = caretBand.bottom - el.clientHeight + margin;
    const r = geo.rects[caretBand.page];
    if (r && caret) {
      const cx = r.x + caret.x * G.pageScale(r, pages[caretBand.page], geo.scale);
      if (cx < el.scrollLeft + margin) el.scrollLeft = Math.max(0, cx - margin);
      else if (cx > el.scrollLeft + el.clientWidth - margin) el.scrollLeft = cx - el.clientWidth + margin;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caretKey, lay]);

  // The markup area never sits cut off at the right edge (Word keeps the page and its balloons in
  // view): when it appears, the active comment changes or the view narrows, scroll across so the
  // markup area's right edge shows, keeping as much of the page's left side as fits.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !markup || !geo.rects.length) return;
    const r = geo.rects[Math.min(caretBand?.page ?? live.pageHint ?? 0, geo.rects.length - 1)] ?? geo.rects[0];
    const right = r.x + r.w + markup * geo.scale + 8;
    if (right > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.min(Math.max(0, right - el.clientWidth), Math.max(0, el.scrollWidth - el.clientWidth));
      setBox(b => ({...b, left: el.scrollLeft}));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markup, activeComment, geo.scale, geo.size.w, box.w]);

  // Zoom keeps the caret (or the top page) in place (canvas.rs anchored scroll).
  const lastScale = useRef(geo.scale);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || lastScale.current === geo.scale) return;
    const ratio = geo.scale / lastScale.current;
    lastScale.current = geo.scale;
    if (caretBand && caretBand.top >= 0) el.scrollTop = Math.max(0, caretBand.top - el.clientHeight / 3);
    else el.scrollTop = el.scrollTop * ratio;
    setBox(b => ({...b, top: el.scrollTop, left: el.scrollLeft}));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo.scale]);

  // Text width: the text column fills the window, so the page's margins sit off to the sides.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || docView.fit !== 'textWidth' || lmode !== 'print') return;
    const i = Math.min(caretBand?.page ?? 0, geo.rects.length - 1);
    const r = geo.rects[i], page = pages[i];
    if (!r || !page?.body) return;
    el.scrollLeft = Math.max(0, r.x + page.body.x * G.pageScale(r, page, geo.scale) - G.GAP - 10);
    setBox(b => ({...b, left: el.scrollLeft}));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docView.fit, geo.scale, lmode]);

  // The caret's client rect (IME candidate window).
  caretClient.current = () => {
    const el = contentRef.current;
    if (!el || !caret || !geo.rects[caret.page]) return null;
    const r = geo.rects[caret.page];
    const s = G.pageScale(r, pages[caret.page], geo.scale);
    const c = el.getBoundingClientRect();
    return new DOMRect(c.left + r.x + caret.x * s, c.top + r.y + caret.top * s, 1, caret.height * s);
  };

  const images = useImages(content?.media);

  // Word counts (cached per content: counting a long document is linear).
  const words = useMemo(() => (d ? d.wordCount() : 0), [d]);
  const selectedWords = useMemo(() => (d && sel && !collapsed && !objectSel ? countWords(selectedText(d, ...([sel.anchor, sel.focus].sort((a, b) => (a.path.join('.') < b.path.join('.') ? -1 : a.path.join('.') > b.path.join('.') ? 1 : a.off - b.off)) as [Pos, Pos]))) : null), [d, sel, collapsed, objectSel]);

  // Surface handle: focus, page renders, and the bridge's pointer/type/key input (same handlers).
  const handleRef = useRef<any>({});
  handleRef.current = {
    focus: () => input.current?.focusTarget().focus({preventScroll: true}),
    // In a fit mode (One Page, Page Width, Multiple Pages) the percent shown is the scale the page is drawn at, as Word's status bar shows it.
    zoom: () => Math.round(geo.scale / G.PX_PER_PT * 100),
    render: async (target: any, scale = 1) => {
      if (!lay) return null;
      const n = typeof target === 'number' ? target : Number(target?.page ?? 1);
      const page = pages[n - 1];
      if (!page) throw new CommandError('not_found', `No page ${n}`);
      const s = Math.max(0.1, Math.min(Number(scale) || 1, 4)) * G.PX_PER_PT;
      const c = document.createElement('canvas');
      c.width = Math.ceil(page.w * s); c.height = Math.ceil(page.h * s);
      const ctx = c.getContext('2d')!;
      const paper = content.settings?.pageColor;
      ctx.fillStyle = Array.isArray(paper) ? `rgb(${paper[0]}, ${paper[1]}, ${paper[2]})` : '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      const shaper: any = getDefaultShaper();
      paintWatermark(ctx, page, content.settings?.watermark ?? null, {scale: s, images: images.get});
      paintPage(ctx, visibleItems(displayOf(page, false, look, lookKey), !!docView.hideInk, replayMax), {scale: s, images: images.get, advance: (g: string, f: any) => shaper.advance(g, f)});
      return c.toDataURL('image/png');
    },
    pointer: async (p: any) => {
      // {action: 'stroke', path: [[x, y], …] or [{x, y, …}, …] (page points), page? (0-based, default the first), target?}: the one ink action every app's
      // bridge takes (OneNote's `stroke` / `path`): what dragging along that path does with the Draw tool picked. With no Draw tool (Select) it is a drag from the
      // path's first point to its last. 'draw' with `points` is the old name, kept as a deprecated alias.
      if (p.action === 'stroke' || p.action === 'draw') {
        const raw = Array.isArray(p.path) ? p.path : p.points;
        const page = p.page === undefined ? 0 : p.page;
        const path = Array.isArray(raw) ? raw.map((q: any): [number, number] => (Array.isArray(q) ? [q[0], q[1]] : q && typeof q === 'object' ? [q.x, q.y] : [NaN, NaN])) : null;
        if (!Number.isInteger(page) || page < 0 || !path?.length || !path.every((q: number[]) => Number.isFinite(q[0]) && Number.isFinite(q[1]))) {
          throw new CommandError('invalid_params', 'stroke needs path ([[x, y], …] or [{x, y}, …] in page points) and page (0-based)');
        }
        const mode = drawModeOf(session.get(docId).view);
        if (mode !== 'select') return runGesture(mode, page, path);
        p = {action: 'drag', page, x: path[0][0], y: path[0][1], to: {page, x: path[path.length - 1][0], y: path[path.length - 1][1]}, modifiers: p.modifiers};
      }
      // {action: 'click'|'doubleClick'|'tripleClick'|'drag', page (0-based), x, y (points), to?: {page, x, y}, modifiers?: string[]}
      const mods = Object.fromEntries((p.modifiers ?? []).map((k: string) => [String(k).toLowerCase(), true]));
      const toPx = (q: any) => {
        const r = geo.rects[q.page ?? 0];
        if (!r || !Number.isFinite(q.x) || !Number.isFinite(q.y)) throw new CommandError('invalid_params', 'page, x and y (points) are required');
        const s = G.pageScale(r, pages[q.page ?? 0], geo.scale);
        return {x: r.x + q.x * s, y: r.y + q.y * s};
      };
      const a = toPx(p);
      const n = p.action === 'tripleClick' ? 3 : p.action === 'doubleClick' ? 2 : 1;
      let t = performance.now() - 10_000;
      press.current = null;
      for (let i = 0; i < n; i++) { await pressAt(a.x, a.y, {shift: !!mods.shift, ctrl: !!mods.ctrl, alt: !!mods.alt}, t); t += 50; if (i + 1 < n) release(); }
      if (p.action === 'drag' && p.to) { const b = toPx(p.to); await moveTo(b.x, b.y); }
      release();
      lastMove.current = 'other';
      const st = session.get(docId);
      return {selection: st.selection};
    },
    type: async (text: string) => {
      // Read Mode takes no typing (read_mode_events).
      if (reading) return {typed: 0};
      let n = 0;
      lastMove.current = 'key';
      for (const ch of String(text)) {
        if (ch === '\n' || ch === '\r') await session.execute(docId, 'text.newParagraph', {}, {origin: 'ui'});
        else if (ch === '\t') await session.execute(docId, 'text.tab', {}, {origin: 'ui'});
        else if (ch === '\b') await session.execute(docId, 'text.backspace', {}, {origin: 'ui'});
        else await session.execute(docId, 'text.insert', {text: ch}, {origin: 'ui'});
        n++;
      }
      return {typed: n};
    },
    key: async (chord: string) => {
      const parts = String(chord).split('+').map(s => s.trim());
      const key0 = parts.pop() ?? '';
      const mods = Object.fromEntries(parts.map(m => [m.toLowerCase().replace('control', 'ctrl').replace('mod', 'ctrl'), true]));
      // Focus and Read Mode take Esc, Read Mode the page-turn keys (the same as the window's own keys).
      const plainKey = !mods.ctrl && !mods.alt && !mods.meta && !mods.shift;
      if (plainKey && /^(escape|esc)$/i.test(key0) && vs.fullScreen && !focusMode && !reading) {
        await exec('view.fullScreen', {value: false});
        return {handled: true, command: 'view.fullScreen'};
      }
      if (plainKey && /^(escape|esc)$/i.test(key0) && (focusMode || reading)) {
        await exec(focusMode ? 'view.focus' : 'view.printLayout', focusMode ? {value: false} : {});
        return {handled: true, command: focusMode ? 'view.focus' : 'view.printLayout'};
      }
      if (reading) {
        const dir = /^(right|arrowright|pagedown|down|arrowdown)$/i.test(key0) ? 1 : /^(left|arrowleft|pageup|up|arrowup)$/i.test(key0) ? -1 : 0;
        if (dir && plainKey) { turnRef.current(dir); return {handled: true, command: 'view.turnPage'}; }
        return {handled: true, command: null};
      }
      const named: Record<string, string> = {left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown'};
      const c = keyCommand(named[key0.toLowerCase()] ?? key0, mods);
      if (!c) return {handled: false};
      lastMove.current = 'key';
      await session.execute(docId, c[0], c[1], {origin: 'ui'});
      return {handled: true, command: c[0]};
    },
  };
  // Right-click (Word): a click outside the selection moves the caret there first; tracked text
  // gets Accept / Reject Insertion, Deletion or Formatting Change; anything else the shell's menu for the selection.
  handleRef.current.selFocus = sel?.focus ?? null;
  handleRef.current.tracking = !!content?.settings?.trackChanges || !!docView.trackMine;
  // A misspelt word under the pointer or the caret: its suggestions are looked up before the right-click menu opens (the menu's state reads them).
  handleRef.current.prepareSpellMenu = async (at: Pos | null | undefined) => {
    if (!d || !at || !proofOn) return;
    try {
      const p = d.para(at.story, at.path);
      if (!p) return;
      const o = {session: proofSession({host: (session as any).host, docId}), defaultLang: proofLanguage(content)};
      await prepareProof(d, at.story, [at.path], sp, o);
      const hit = paraIssues(p, sp, o).find((t: any) => t.start <= at.off && at.off <= t.end);
      if (hit) await sp.suggest(hit.text, 6);
    } catch { /* the menu opens without suggestions */ }
  };
  handleRef.current.contextMenu = async (cx: number, cy: number) => {
    const p = toContent(cx, cy);
    if (!p || !lay) return null;
    const h = hitAt(p.x, p.y);
    if (!h?.pos) return null;
    const inside = sel && !collapsed && (() => {
      const [a, b] = [sel.anchor, sel.focus].sort((x, y) => (x.path.join('.') < y.path.join('.') ? -1 : x.path.join('.') > y.path.join('.') ? 1 : x.off - y.off));
      const k = (q: Pos) => [q.path.join('.'), q.off] as const;
      const [pa, oa] = k(a), [pb, ob] = k(b), [ph, oh] = k(h.pos!);
      return (ph > pa || (ph === pa && oh >= oa)) && (ph < pb || (ph === pb && oh <= ob));
    })();
    if (!inside) { lastMove.current = 'click'; await exec('caret.set', {pos: h.pos}, true); }
    const at = inside ? sel!.focus : h.pos;
    await handleRef.current.prepareSpellMenu(at);
    const kind = d ? changeAt(d, at) : null;
    if (kind === 'insert' || kind === 'moveTo') return 'trackedInsertion';
    if (kind === 'delete' || kind === 'moveFrom') return 'trackedDeletion';
    if (kind === 'format') return 'trackedFormatting';
    // Word: a table of contents gets Update Field for the whole table; any other field Update Field / Edit Field / Toggle Field Codes.
    if (d && caretInToc(d, at)) return 'tableOfContents';
    if (d && selectedFields(d, inside ? sel! : {anchor: at, focus: at}).length) return 'field';
    return null;
  };
  useEffect(() => register({
    focus: () => handleRef.current.focus(),
    render: (t: unknown, s?: number) => handleRef.current.render(t, s),
    ...({contextMenu: (x: number, y: number) => handleRef.current.contextMenu(x, y),
      contextPrepare: (target: string) => (target === 'selection' ? handleRef.current.prepareSpellMenu(handleRef.current.selFocus) : undefined)} as any),
    // The status bar's Track Changes: On (chrome.rs status_bar), only while changes are tracked.
    status: () => ({'status.trackChanges': handleRef.current.tracking ? 'On' : false}),
    zoom: () => handleRef.current.zoom(),
    ...({pointer: (p: unknown) => handleRef.current.pointer(p), type: (t: string) => handleRef.current.type(t), key: (k: string) => handleRef.current.key(k),
      keys: (k: string, mods?: string[]) => handleRef.current.key([...(mods ?? []), k].join('+'))} as any),
  }), [register]);

  // ---- View: Read Mode's page turns, Focus, Esc, Synchronous Scrolling (U:quill/view) -------------

  // Turn one reading column left or right (turn_read_page), easing to the column's edge.
  const readTarget = useRef<number | null>(null);
  const turnPage = useCallback((dir: number) => {
    const el = scroller.current;
    if (!el || !geo.rects.length) return;
    const step = G.readStep(geo.rects);
    if (!(step > 0)) return;
    const cur = readTarget.current ?? Math.round(el.scrollLeft / step);
    const next = Math.max(0, Math.min(geo.rects.length - 1, cur + (dir < 0 ? -1 : 1)));
    readTarget.current = next;
    el.scrollTo({left: next * step, behavior: 'smooth'});
    setTimeout(() => { if (readTarget.current === next) readTarget.current = null; }, 400);
  }, [geo]);
  const turnRef = useRef(turnPage);
  turnRef.current = turnPage;
  // One wheel notch turns one column in Read Mode (read_wheel_turns); touchpads add up to a turn.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !reading) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const d = e.deltaX + e.deltaY;
      if (e.deltaMode !== 0) { turnRef.current(Math.sign(d)); acc = 0; return; }
      acc = Math.max(-300, Math.min(300, acc + d));
      if (Math.abs(acc) >= 55) { turnRef.current(Math.sign(acc)); acc = 0; }
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    return () => el.removeEventListener('wheel', onWheel);
  }, [reading, ready]);
  // Entering Read Mode starts at the caret's column; leaving it brings the caret back into view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (reading && caret && geo.rects[caret.page]) { el.scrollLeft = geo.rects[caret.page].x - G.GAP; el.scrollTop = 0; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading, lay === null]);

  // Esc leaves Focus first, then Read Mode (Screen::exit_command, read_mode_events); in Read Mode
  // the document takes no typing, pasting or editing keys.
  const escRef = useRef({focusMode, reading});
  escRef.current = {focusMode, reading};
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const {focusMode: f, reading: r} = escRef.current;
      if (!f && !r) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.shell-dialog, .shell-flyout, .shell-backstage, input:not([type=range]), textarea, select')) return;
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        void exec(f ? 'view.focus' : 'view.printLayout', f ? {value: false} : {});
        return;
      }
      if (r && t?.closest?.('.quill-surface')) {
        const mod = e.ctrlKey || e.metaKey;
        const k = e.key.toLowerCase();
        const allowed = (mod && ['c', 'a', 'f', 'p', 's', 'o', 'n', 'w'].includes(k)) || /^(Arrow|Page|Home|End|Tab|F\d)/.test(e.key) || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt';
        if (!allowed) { e.preventDefault(); e.stopImmediatePropagation(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [exec]);
  // Focus takes the whole screen like Word (the window full screen, never in test runs); the
  // shell hides its title bar, ribbon, status bar and panes, and Read Mode its ribbon.
  const [peek, setPeek] = useState(false);
  // The in-place equation editor: on after a double-click on an equation, Insert › Equation and Edit Equation (view.equationEdit counts them).
  const [eqEditing, setEqEditing] = useState(false);
  useEffect(() => { if (docView.equationEdit) setEqEditing(true); }, [docView.equationEdit]);
  useEffect(() => { if (!eqSel) setEqEditing(false); }, [eqSel]);
  useEffect(() => {
    const shellEl = root.current?.closest('.shell') as HTMLElement | null;
    if (!shellEl) return;
    const screen = focusMode ? 'focus' : reading ? 'read' : '';
    if (screen) shellEl.dataset.quillScreen = screen; else delete shellEl.dataset.quillScreen;
    if (focusMode && peek) shellEl.dataset.quillPeek = ''; else delete shellEl.dataset.quillPeek;
    return () => { delete shellEl.dataset.quillScreen; delete shellEl.dataset.quillPeek; };
  }, [focusMode, reading, peek, ready]);
  useEffect(() => { if (!focusMode) setPeek(false); }, [focusMode]);
  useEffect(() => {
    const w = (window as any).studio?.windows;
    if (!w?.fullScreen) return;
    void w.fullScreen(focusMode || vs.fullScreen).catch(() => {});
  }, [focusMode, vs.fullScreen]);

  // Synchronous Scrolling (View › Window): while two windows are side by side, each one's scroll
  // position goes to the other (as a fraction of the document, as Word keeps the same place).
  const syncing = useRef(false);
  useEffect(() => {
    const w = (window as any).studio?.windows;
    if (!w?.onScroll) return;
    return w.onScroll((m: {top: number; left: number}) => {
      const el = scroller.current;
      if (!el || !w.state?.()?.syncScroll) return;
      syncing.current = true;
      el.scrollTop = m.top * Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollLeft = m.left * Math.max(0, el.scrollWidth - el.clientWidth);
      setTimeout(() => { syncing.current = false; }, 60);
    });
  }, [ready]);
  const sendScroll = () => {
    const w = (window as any).studio?.windows, el = scroller.current;
    if (!w?.scroll || !el || syncing.current || !w.state?.()?.syncScroll) return;
    w.scroll({top: el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight), left: el.scrollLeft / Math.max(1, el.scrollWidth - el.clientWidth)});
  };

  // Split (View › Window): a second pane on the same document below the first, the bar between them dragged to resize.
  const splitAt = Math.max(0.1, Math.min(0.9, Number(docView.splitAt) || 0.5));
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragSplit = (e: RPointerEvent) => {
    const el = bodyRef.current;
    if (!el) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const r = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => { const at = (ev.clientY - r.top) / Math.max(r.height, 1); (e.currentTarget as HTMLElement).style.setProperty('--at', String(at)); el.style.setProperty('--split', String(Math.max(0.1, Math.min(0.9, at)))); };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const at = (ev.clientY - r.top) / Math.max(r.height, 1);
      // Dragged to an edge: Remove Split (Word).
      if (at < 0.06 || at > 0.94) void exec('view.split', {value: false}); else void exec('view.split', {at: Math.max(0.1, Math.min(0.9, at))});
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // The lower pane of a split window: its own scroll position over the same pages.
  const scroller2 = useRef<HTMLDivElement>(null);
  const content2 = useRef<HTMLDivElement>(null);
  const [box2, setBox2] = useState({h: 0, top: 0, left: 0});
  useLayoutEffect(() => {
    const el = scroller2.current;
    if (!el || !vs.split) return;
    const measure = () => setBox2({h: el.clientHeight, top: el.scrollTop, left: el.scrollLeft});
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vs.split, ready]);
  const onScroll2 = () => { const el = scroller2.current; if (el) setBox2(b => (b.top === el.scrollTop && b.left === el.scrollLeft ? b : {...b, top: el.scrollTop, left: el.scrollLeft})); };
  const toContent2 = (clientX: number, clientY: number) => { const r = content2.current?.getBoundingClientRect(); return r ? {x: clientX - r.left, y: clientY - r.top} : null; };
  const onPointerDown2 = (e: RPointerEvent) => {
    if (e.button !== 0 || !lay) return;
    const p = toContent2(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    lastMove.current = 'click';
    input.current?.focusTarget().focus({preventScroll: true});
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    void pressAt(p.x, p.y, {shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey}, e.timeStamp || performance.now());
  };
  const onPointerMove2 = (e: RPointerEvent) => { if (!drag.current?.active) return; const p = toContent2(e.clientX, e.clientY); if (p) void moveTo(p.x, p.y); };

  // Draft: where Print Layout's pages break, drawn as dotted lines across the sheet.
  const breaks = useMemo(() => {
    const by = new Map<number, {y: number; kind: string}[]>();
    if (lmode !== 'draft' || !lay || !d) return by;
    for (const b of draftBreaks(content, d)) {
      const c = lay.caret(b.pos, 0);
      if (!c) continue;
      const v = by.get(c.page) ?? [];
      v.push({y: c.top, kind: b.kind});
      by.set(c.page, v);
    }
    return by;
  }, [lmode, lay, d, content]);

  // ---- render --------------------------------------------------------------------------------

  if (!doc) return null;
  if (!ready) return <div className="quill-surface quill-busy" role="status">{isSchema1(content) ? 'Converting the document…' : 'This document cannot be shown.'}</div>;

  // Rulers: Print Layout has both; Web Layout and Draft the horizontal one; Outline, Read Mode,
  // Immersive Reader and Focus none (as Word).
  const hRuler = vs.ruler && !reading && !immersive && !focusMode && lmode !== 'outline';
  const vRuler = hRuler && lmode === 'print';
  const horizontal = reading || (lmode === 'print' && vs.pageMovement === 'sideToSide');
  const visibleIn = (top: number, height: number, left: number) => (horizontal
    ? geo.rects.map((r, i) => (r.x + r.w >= left - box.w && r.x <= left + 2 * box.w ? i : -1)).filter(i => i >= 0)
    : G.visiblePages(geo.rects, top, height, height));
  const visible = visibleIn(box.top, box.h, box.left);
  const rulerPage = pages[Math.min(live.pageHint, pages.length - 1)] ?? null;
  const rulerRect = geo.rects[Math.min(live.pageHint, pages.length - 1)] ?? null;
  const rulerScale = rulerRect && rulerPage ? G.pageScale(rulerRect, rulerPage, geo.scale) : geo.scale;
  const caretPara = sel && d ? d.paraAt(sel.focus) : null;
  const rp = caretPara ? resolvePara(content.styles, caretPara.props) : null;
  const marks = !!docView.marks;
  // Read Mode and Immersive Reader draw on the reading paper: white (the document's page colour is
  // not shown), sepia, or inverse (light text on dark).
  const readPaper = reading || immersive;
  const paper = readPaper ? (vs.readPageColor === 'sepia' ? SEPIA_PAPER : null) : content.settings?.pageColor ?? null;
  const gridH = gridStep(Number(content.settings?.gridH ?? DEFAULT_GRID), geo.scale), gridV = gridStep(Number(content.settings?.gridV ?? DEFAULT_GRID), geo.scale);

  // Immersive Reader's Line Focus: the lines round the caret (or the top of the text) stay lit, the rest of the page dims. Points on the page, as the caret's.
  const lineBandFor = (i: number, s: number) => {
    const n = immersive ? vs.lineFocus : 0;
    if (!n) return null;
    if (caret && caret.page === i) {
      const pitch = Math.max(caret.height * 1.15, 6);
      const lead = ((n - 1) / 2) * pitch;
      return {top: Math.max(caret.top - lead - (pitch - caret.height) / 2, 0) * s, bottom: (caret.top + caret.height + lead + (pitch - caret.height) / 2) * s};
    }
    return caret ? {top: 0, bottom: 0} : i === 0 ? {top: 0, bottom: n * 18 * s} : {top: 0, bottom: 0};
  };

  const pageEls = (top: number, height: number, left: number, pane: 'main' | 'lower') => {
    const lo2 = top - height, hi2 = top + 2 * height;
    const shown = pane === 'main' ? visible : visibleIn(top, height, left);
    return shown.map(i => {
      const r = geo.rects[i], page = pages[i];
      const s = G.pageScale(r, page, geo.scale);
      return <PageBox key={i} index={i} rect={r} page={page} scale={s} lo={horizontal ? -Infinity : lo2} hi={horizontal ? Infinity : hi2} marks={marks} images={images} look={look} lookKey={lookKey}
        commentMarks={commentMarks.get(i) ?? null} controlMarks={controlMarks.get(i) ?? null} activeComment={activeComment} markupWidth={markup * s}
        pageColor={paper} pagePicture={readPaper ? null : content.settings?.pagePicture ?? null} watermark={readPaper ? null : content.settings?.watermark ?? null}
        // A selected picture, shape or chart shows its frame and handles only, as Word draws it: no text-selection wash over it.
        sel={objectSel ? null : (selRects.get(i) ?? null)} focused={focused}
        caret={collapsed && caret && caret.page === i && focused && !preedit && !reading ? caret : null} caretKey={caretKey} glide={lastMove.current === 'key'}
        preedit={preedit && caret && caret.page === i ? {p: preedit, caret} : null}
        eq={eqEditing && eqSel && eqSel.page === i ? {rect: eqSel.rect, linear: eqSel.linear, onCommit: (linear: string) => { void exec('equation.edit', {linear}, true); }, onDone: () => { setEqEditing(false); void exec('equation.exit', {}, true); }} : null}
        object={objectSel && objectSel.page === i ? objectSel : null} others={otherObjs.filter(x => x.page === i)}
        cropping={!!docView.cropping && objectSel?.type === 'image'} onCrop={(prm: Record<string, unknown>) => void exec('picture.crop', prm, true)}
        points={pointsShape && pointsShape.page === i ? pointsShape : null} onPoints={(c: string, prm: Record<string, unknown>) => exec(c, prm, true)}
        wrapPts={wrapPts && wrapPts.page === i ? wrapPts : null} onWrap={(c: string, prm: Record<string, unknown>) => exec(c, prm, true)}
        sheet={sheet} breaks={breaks.get(i) ?? null} hideInk={!!docView.hideInk} replayMax={replayMax} lineBand={lineBandFor(i, s)}
        drawLive={liveInk && liveInk.page === i ? liveInk : null} lassoBox={penRect && penRect.page === i ? penRect.rect : lassoBox && lassoBox.page === i ? lassoBox.rect : null}
        grid={vs.gridlines && lmode === 'print' && !readPaper ? {h: gridH, v: gridV} : null}
        balloons={markup && pane === 'main' ? <Balloons cards={cards} content={content} lay={lay} page={i} scale={s} rect={r} pageHint={live.pageHint} active={activeComment}
          exec={exec} setActive={setActiveComment} canEdit={controller.hasCommand('review.editComment')}
          onPick={pos => { lastMove.current = 'click'; void exec('caret.set', {pos}, true); }}/> : null}/>;
    });
  };
  const theme = String((session.prefs as any)?.interfaceTheme ?? 'system');
  const viewClass = `quill-surface theme-${['light', 'dark'].includes(theme) ? theme : 'system'}${vs.hideWhiteSpace && lmode === 'print' && !reading && !immersive ? ' is-hide-ws' : ''} is-${reading ? 'read' : immersive ? 'immersive' : lmode}${focusMode ? ' is-focus' : ''}${readPaper ? ` paper-${vs.readPageColor}` : vs.darkMode ? ' paper-inverse' : ''}${vs.split ? ' is-split' : ''}${drawOn ? ' is-drawing' : ''}${tablePen ? ' is-table-pen' : ''}`;
  const pageNo = (() => {
    if (!reading || !geo.rects.length) return null;
    const step = G.readStep(geo.rects);
    const first = step > 0 ? Math.round(box.left / step) : 0;
    const across = step > 0 ? Math.max(1, Math.floor((box.w + G.GAP) / step)) : 1;
    return {first: Math.min(first, pages.length - 1), across, total: pages.length};
  })();

  return <div className={viewClass} ref={root} data-quill-surface="" data-view={reading ? 'read' : immersive ? 'immersive' : lmode}>
    {reading ? <ReadToolbar vs={vs} exec={exec} navOpen={vs.navPane}/> : null}
    {focusMode ? <div className="quill-focus-bar" data-chrome-bar="">
      <button type="button" className={`quill-focus-more${peek ? ' is-on' : ''}`} aria-label="Show the ribbon" aria-pressed={peek} data-tip="Show the ribbon"
        onClick={() => setPeek(p => !p)}><svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor"/></svg></button>
    </div> : null}
    {hRuler ? <div className="quill-ruler-row">
      <div className="quill-ruler-corner" aria-hidden="true" style={vRuler ? undefined : {width: 0}}/>
      <HRuler width={Math.max(box.w, 1)} x0={(rulerRect?.x ?? 0) - box.left} scale={rulerScale} page={rulerPage} unit={String((session.prefs as any)?.units ?? 'in')}
        para={rp ? {indentLeft: rp.indentLeft, indentRight: rp.indentRight, indentFirst: rp.indentFirst, bidi: rp.bidi} : null} column={null}/>
    </div> : null}
    <div className="quill-body" ref={bodyRef} style={{'--split': String(splitAt)} as React.CSSProperties}>
      {vRuler ? <VRuler height={Math.max(box.h, 1)} y0={(rulerRect?.y ?? 0) - box.top} scale={rulerScale} page={rulerPage} unit={String((session.prefs as any)?.units ?? 'in')}/> : null}
      <div className="quill-panes">
        <div className={`quill-scroll${focused ? ' is-focused' : ''}${docView.pickTransparent ? ' is-pick' : ''}${horizontal ? ' is-horizontal' : ''}`} ref={scroller} tabIndex={0} role="textbox" aria-multiline="true"
          aria-readonly={reading || undefined} aria-label={`${doc.file.title}: document`} onScroll={() => { onScroll(); sendScroll(); }} onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
          <div className="quill-content" ref={contentRef} style={{width: geo.size.w, height: geo.size.h}}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            {pageEls(box.top, box.h, box.left, 'main')}
          </div>
        </div>
        {vs.split ? <>
          <div className="quill-split-bar" role="separator" aria-orientation="horizontal" aria-label="Split bar: drag to resize, double-click to remove the split" tabIndex={0}
            data-split-at={splitAt} onPointerDown={dragSplit} onDoubleClick={() => void exec('view.split', {value: false})}/>
          <div className={`quill-scroll is-lower${horizontal ? ' is-horizontal' : ''}`} ref={scroller2} onScroll={onScroll2} aria-label={`${doc.file.title}: second pane`}>
            <div className="quill-content" ref={content2} style={{width: geo.size.w, height: geo.size.h}}
              onPointerDown={onPointerDown2} onPointerMove={onPointerMove2} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
              {pageEls(box2.top, box2.h || box.h, box2.left, 'lower')}
            </div>
          </div>
        </> : null}
      </div>
      {reading && pageNo ? <>
        <button type="button" className="quill-read-turn is-prev" aria-label="Previous screen" disabled={pageNo.first <= 0} onClick={() => turnPage(-1)}>
          <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true"><path d="M14.5 6L8.5 12L14.5 18" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"/></svg></button>
        <button type="button" className="quill-read-turn is-next" aria-label="Next screen" disabled={pageNo.first + pageNo.across >= pageNo.total} onClick={() => turnPage(1)}>
          <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true"><path d="M9.5 6L15.5 12L9.5 18" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      </> : null}
    </div>
    <Mirror d={d} lay={lay} rects={geo.rects} top={box.top} height={box.h} title={doc.file.title}/>
    <StatusItems root={root} page={reading && pageNo ? pageNo.first + 1 : viewed + 1} pages={pages.length} words={words} selected={selectedWords} controller={controller}
      reading={reading ? pageNo : null}/>
  </div>;
}

/**
 * Read Mode's bar in place of the ribbon (ribbon/tabs.rs reading_toolbar, with Word's View menu
 * names): Column Width, Text Size, Line Spacing, Page Color, Navigation Pane and Edit Document.
 */
function ReadToolbar({vs, exec, navOpen}: {vs: any; exec: (id: string, p?: Record<string, unknown>, quiet?: boolean) => Promise<any>; navOpen: boolean}) {
  const widths: [string, string, number | null][] = [['auto', 'Auto', null], ['narrow', 'Narrow', 180], ['medium', 'Medium', 240], ['wide', 'Wide', 350], ['page', 'Page', 612]];
  const width = widths.find(w => w[2] === vs.readColumnWidth)?.[1] ?? 'Auto';
  const pct = Math.round(vs.readZoom * 100);
  const spacing = vs.readLineSpacing === null ? 'Document' : `${vs.readLineSpacing}×`;
  const color = ({none: 'None', sepia: 'Sepia', inverse: 'Inverse'} as Record<string, string>)[vs.readPageColor] ?? 'None';
  const spacings: [string | number, string][] = [['document', 'Document'], [1, '1×'], [1.25, '1.25×'], [1.5, '1.5×'], [2, '2×']];
  return <div className="quill-read-bar" role="toolbar" aria-label="Read Mode" data-chrome-bar="">
    <strong>Read Mode</strong>
    <ReadMenu label="Column Width" value={width} items={widths.map(([v, l]) => ({label: l, on: l === width, run: () => exec('view.readColumnWidth', {value: v})}))}/>
    <ReadMenu label="Text Size" value={`${pct}%`} items={[75, 90, 100, 110, 125, 150].map(n => ({label: `${n}%`, on: n === pct, run: () => exec('view.readTextSize', {value: n})}))}/>
    <ReadMenu label="Line Spacing" value={spacing} items={spacings.map(([v, l]) => ({label: l, on: l === spacing, run: () => exec('view.readLineSpacing', {value: v})}))}/>
    <ReadMenu label="Page Color" value={color} items={[['none', 'None'], ['sepia', 'Sepia'], ['inverse', 'Inverse']].map(([v, l]) => ({label: l, on: l === color, run: () => exec('view.readPageColor', {value: v})}))}/>
    <button type="button" className="quill-read-btn" aria-pressed={navOpen} onClick={() => void exec('view.navigationPane', {value: !navOpen})}>Navigation Pane</button>
    <span className="quill-read-gap"/>
    <button type="button" className="quill-read-btn is-primary" onClick={() => void exec('view.printLayout')}>Edit Document</button>
  </div>;
}

function ReadMenu({label, value, items}: {label: string; value: string; items: {label: string; on: boolean; run: () => void}[]}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  return <div className="quill-read-menu" ref={ref}>
    <button type="button" className="quill-read-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>{label}: {value}
      <svg viewBox="0 0 10 10" width={8} height={8} aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round"/></svg></button>
    {open ? <div className="quill-read-list" role="menu" aria-label={label}>
      {items.map(it => <button key={it.label} type="button" role="menuitemradio" aria-checked={it.on} onClick={() => { setOpen(false); it.run(); }}>{it.label}</button>)}
    </div> : null}
  </div>;
}

// --------------------------------------------------------------------------------------------

function Tile({page, top, height, width, scale, marks, images, pageColor, pagePicture = null, watermark, look, lookKey, hideInk, replayMax}: {pagePicture?: {media: string; fillType?: string} | null; page: any; top: number; height: number; width: number; scale: number; marks: boolean;
  images: {get: (k: string) => HTMLImageElement | null; version: number}; pageColor: number[] | null; watermark: any; look: any; lookKey: string; hideInk: boolean; replayMax: number | null}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.max(1, Math.round(height * dpr));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pageColor ? `rgb(${pageColor[0]}, ${pageColor[1]}, ${pageColor[2]})` : '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const s = scale * dpr;
    const originY = top / scale;
    // Page Color > Fill Effects: a picture, gradient, texture or pattern behind the page (stretched over it, or tiled at 96 dpi).
    const bg = pagePicture ? images.get(pagePicture.media) : null;
    if (bg && (bg.naturalWidth || bg.width)) {
      const bw = bg.naturalWidth || (bg.width as number), bh = bg.naturalHeight || (bg.height as number);
      if (pagePicture?.fillType === 'tile') {
        const tw = bw * 0.75, th = bh * 0.75;
        for (let y = Math.floor(originY / th) * th; y < originY + height / scale; y += th) for (let x = 0; x < page.w; x += tw) ctx.drawImage(bg, x * s, (y - originY) * s, tw * s, th * s);
      } else ctx.drawImage(bg, 0, -originY * s, page.w * s, page.h * s);
    }
    const shaper: any = getDefaultShaper();
    // The watermark goes behind the page's text and objects (render.rs draws it before the items).
    paintWatermark(ctx, page, watermark, {scale: s, originY, images: images.get});
    paintPage(ctx, visibleItems(displayOf(page, marks, look, lookKey), hideInk, replayMax), {scale: s, originY, images: images.get, clipTop: originY - 4, clipBottom: originY + height / scale + 4,
      advance: (g: string, f: any) => shaper.advance(g, f)});
  }, [page, top, height, width, scale, marks, images.version, images.get, pageColor, pagePicture, watermark, lookKey, hideInk, replayMax]);
  return <canvas ref={ref} className="quill-tile" style={{top, width, height}}/>;
}

function PageBox({index, rect, page, scale, lo, hi, marks, images, pageColor, pagePicture = null, watermark, sel, focused, caret, caretKey, glide, preedit, eq = null, object, others = [], cropping = false, onCrop, points = null, onPoints, balloons, look, lookKey,
  commentMarks, controlMarks = null, activeComment, markupWidth, sheet = false, breaks = null, grid = null, hideInk = false, replayMax = null, drawLive = null, lassoBox = null, lineBand = null, wrapPts = null, onWrap}: {
  pagePicture?: {media: string; fillType?: string} | null;
  wrapPts?: {rect: Rect; rot: number; unit: [number, number][]} | null; onWrap?: (c: string, p: Record<string, unknown>) => Promise<unknown> | void;
  lineBand?: {top: number; bottom: number} | null;
  index: number; rect: Rect; page: any; scale: number; lo: number; hi: number; marks: boolean; images: any; pageColor: number[] | null; watermark: any;
  sel: Rect[] | null; focused: boolean; caret: any; caretKey: string; glide: boolean; preedit: {p: Preedit; caret: any} | null;
  eq?: {rect: Rect; linear: string; onCommit: (linear: string) => void; onDone: () => void} | null;
  object: {rect: Rect; rot: number; type?: string; crop?: number[]} | null; others?: {rect: Rect; rot: number}[]; cropping?: boolean; onCrop?: (p: Record<string, unknown>) => void; points?: {sh: any; state: PointsView} | null; onPoints?: (c: string, p: Record<string, unknown>) => Promise<unknown> | void; balloons: React.ReactNode; look: any; lookKey: string;
  commentMarks: {id: number; r: Rect}[] | null; controlMarks?: {r: Rect; title: string | null; active: boolean}[] | null; activeComment: number | null; markupWidth: number;
  sheet?: boolean; breaks?: {y: number; kind: string}[] | null; grid?: {h: number; v: number} | null; hideInk?: boolean; replayMax?: number | null;
  drawLive?: Live | null; lassoBox?: {x: number; y: number; w: number; h: number} | null;
}) {
  const tiles = G.visibleTiles(rect, lo, hi) as [number, number, number][];
  const cut = (rect as any).ct || (rect as any).cb ? `inset(${(rect as any).ct ?? 0}px 0 ${(rect as any).cb ?? 0}px 0)` : undefined;
  return <div className={`quill-page${sheet ? ' is-sheet' : ''}${cut ? ' is-cut' : ''}`} data-page={index + 1} style={{left: rect.x, top: rect.y, width: rect.w, height: rect.h, clipPath: cut}}>
    {wrapPts && onWrap ? <WrapPoints unit={wrapPts.unit} rect={wrapPts.rect} rot={wrapPts.rot} scale={scale} width={rect.w} height={rect.h} exec={onWrap}/> : null}
    {lineBand ? <div className="quill-line-focus" aria-hidden="true"><i style={{top: 0, height: lineBand.top}}/><i style={{top: lineBand.bottom, bottom: 0}}/></div> : null}
    {markupWidth > 0 ? <div className="quill-markup-area" aria-hidden="true" style={{left: rect.w, width: markupWidth, height: rect.h}}/> : null}
    {tiles.map(([k, top, h]) => <Tile key={k} page={page} top={top} height={h} width={rect.w} scale={scale} marks={marks} images={images} pageColor={pageColor} pagePicture={pagePicture} watermark={watermark}
      look={look} lookKey={lookKey} hideInk={hideInk} replayMax={replayMax}/>)}
    {grid ? <Gridlines body={page.body} step={grid} scale={scale}/> : null}
    {breaks?.length ? <div className="quill-draft-breaks" aria-hidden="true">
      {breaks.map((b, i) => <div key={i} className={`quill-draft-break is-${b.kind}`} style={{top: Math.max(b.y * scale - 3, 0)}}>
        {b.kind === 'page' ? <span>Page Break</span> : b.kind === 'section' ? <span>Section Break (Next Page)</span> : null}
      </div>)}
    </div> : null}
    {commentMarks?.length ? <div className="quill-comment-marks" aria-hidden="true">
      {commentMarks.map(({id, r}, i) => <i key={i} className={id === activeComment ? 'is-active' : ''} style={{left: r.x * scale, top: r.y * scale, width: Math.max(r.w * scale, 1), height: r.h * scale}}/>)}
    </div> : null}
    {controlMarks?.length ? <div className="quill-control-marks" aria-hidden="true">
      {controlMarks.map(({r, title, active}, i) => <i key={i} className={active ? 'is-active' : ''} style={{left: r.x * scale, top: r.y * scale, width: Math.max(r.w * scale, 2), height: r.h * scale}}>{title ? <b>{title}</b> : null}</i>)}
    </div> : null}
    {drawLive || lassoBox ? <DrawLayer live={drawLive} box={lassoBox} scale={scale} width={rect.w} height={rect.h}/> : null}
    {sel ? <div className={`quill-selection${focused ? '' : ' is-inactive'}`} aria-hidden="true">
      {sel.map((r, i) => <i key={i} style={{left: r.x * scale, top: r.y * scale, width: Math.max(r.w * scale, 1), height: r.h * scale}}/>)}
    </div> : null}
    {caret ? <i key={caretKey} className={`quill-caret${glide ? ' is-gliding' : ''}`} aria-hidden="true"
      style={{transform: `translate(${caret.x * scale}px, ${caret.top * scale}px)`, height: Math.max(caret.height * scale, 2)}}/> : null}
    {preedit ? <span className="quill-preedit" aria-live="polite"
      style={{left: preedit.caret.x * scale, top: preedit.caret.top * scale, height: preedit.caret.height * scale, fontSize: Math.max(preedit.caret.height * scale * 0.78, 8)}}>
      {preedit.p.segments.length ? preedit.p.segments.map((sg, i) => <u key={i} className={sg.thick ? 'is-thick' : ''}>{preedit.p.text.slice(Math.max(sg.start, 0), Math.max(sg.end, 0))}</u>)
        : <u>{preedit.p.text}</u>}
    </span> : null}
    {others.map((o, k) => <div key={`o${k}`} className="quill-object-frame is-picked" aria-hidden="true"
      style={{left: o.rect.x * scale, top: o.rect.y * scale, width: o.rect.w * scale, height: o.rect.h * scale, transform: o.rot ? `rotate(${o.rot}deg)` : undefined}}>
      {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => <b key={h} className={`h-${h}`}/>)}
    </div>)}
    {object && cropping && onCrop ? <CropHandles hit={{rect: object.rect, rot: object.rot, crop: object.crop ?? [0, 0, 0, 0]}} scale={scale} onCommit={onCrop as any}/> : null}
    {points && onPoints ? <EditPoints sh={points.sh} state={points.state} scale={scale} width={rect.w / scale} height={rect.h / scale} exec={onPoints}/> : null}
    {object && !(cropping && onCrop) && !points ? <div className="quill-object-frame" aria-hidden="true"
      style={{left: object.rect.x * scale, top: object.rect.y * scale, width: object.rect.w * scale, height: object.rect.h * scale, transform: object.rot ? `rotate(${object.rot}deg)` : undefined}}>
      {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => <b key={h} className={`h-${h}`}/>)}
      <b className="h-rot"/>
    </div> : null}
    {eq ? <EquationEditor eq={eq} scale={scale}/> : null}
    {balloons}
  </div>;
}

/**
 * Word's in-place equation: the equation's own text (the linear format, as Word's Linear button shows it) typed where the equation stands,
 * typeset again as it is typed (Equation tab stays); Enter or Esc leaves the equation.
 */
function EquationEditor({eq, scale}: {eq: {rect: Rect; linear: string; onCommit: (linear: string) => void; onDone: () => void}; scale: number}) {
  const [text, setText] = useState(eq.linear);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(eq.linear);
  const flush = (v: string) => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } if (v !== last.current) { last.current = v; eq.onCommit(v); } };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const r = eq.rect;
  const size = Math.max(11, Math.min(r.h * scale * 0.55, 22));
  return <input className="quill-eq-editor" aria-label="Equation" autoFocus spellCheck={false} placeholder="Type equation here." value={text}
    style={{left: r.x * scale - 4, top: r.y * scale - 3, width: Math.min(Math.max(r.w * scale + 8, 150, [...text].length * size * 0.62 + 28), 640), height: Math.max(r.h * scale + 6, size * 1.9), fontSize: size}}
    onChange={e => { const v = e.target.value; setText(v); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => flush(v), 300); }}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); flush(text); eq.onDone(); } }}
    onBlur={() => { flush(text); eq.onDone(); }}/>;
}

/** View › Gridlines: the drawing grid over the page's text area (canvas.rs draw_page_gridlines, pages.rs drawing_grid). */
function Gridlines({body, step, scale}: {body: {x: number; y: number; w: number; h: number}; step: {h: number; v: number}; scale: number}) {
  if (!body || !(body.w > 0) || !(body.h > 0)) return null;
  const axis = (len: number, st: number) => { const out: number[] = []; for (let k = 0; k < 2000; k++) { const p = k * st; if (p > len + 0.01) break; out.push(p); } return out; };
  const xs = axis(body.w, step.h), ys = axis(body.h, step.v);
  const w = body.w * scale, h = body.h * scale;
  return <svg className="quill-gridlines" aria-hidden="true" style={{left: body.x * scale, top: body.y * scale, width: w + 1, height: h + 1}} width={w + 1} height={h + 1}>
    {xs.map((x, i) => <line key={`x${i}`} x1={x * scale + 0.5} x2={x * scale + 0.5} y1={0} y2={h}/>)}
    {ys.map((y, i) => <line key={`y${i}`} x1={0} x2={w} y1={y * scale + 0.5} y2={y * scale + 0.5}/>)}
  </svg>;
}

type Card = {key: string; kind: 'comment' | 'deleted' | 'formatted'; at: Pos; author: string; text: string; date?: string; id?: number; resolved?: boolean;
  replies?: {id: number; author: string; text: string; date: string}[]};

/** The markup area's cards in document order (balloons.rs collect_items): comment threads, deletions and formatting per Display for Review. */
function reviewCards(content: any, d: any, pres: any): Card[] {
  const out: Card[] = [];
  if (pres.balloons.comments && Object.keys(content.comments ?? {}).length) {
    const threads = new Map<number, number[]>();
    const root = (id: number) => { let r = id; const seen = new Set<number>(); while (content.comments[r]?.parent !== null && content.comments[r]?.parent !== undefined && content.comments[content.comments[r].parent] && !seen.has(r)) { seen.add(r); r = content.comments[r].parent; } return r; };
    for (const k of Object.keys(content.comments).map(Number).sort((a, b) => a - b)) { const r = root(k); if (r !== k) { const v = threads.get(r) ?? []; if (v.length < 100) v.push(k); threads.set(r, v); } }
    for (const a of commentAnchors(d)) {
      const c = content.comments[a.id];
      if (!c || (c.parent !== null && c.parent !== undefined)) continue;
      out.push({key: `c${a.id}`, kind: 'comment', at: a.pos, id: a.id, author: c.author || 'Author', date: c.date ?? '', text: partText(content, c.part), resolved: !!c.resolved,
        replies: (threads.get(a.id) ?? []).map(r => ({id: r, author: content.comments[r]?.author || 'Author', date: content.comments[r]?.date ?? '', text: partText(content, content.comments[r]?.part)}))});
    }
  }
  if (pres.balloons.deletions) for (const [i, x] of deletionBalloons({d}).entries()) out.push({key: `d${i}`, kind: 'deleted', at: x.at, author: x.author || 'Author', text: `Deleted: ${x.text}`});
  if (pres.balloons.formatting) for (const [i, x] of formatChanges({d}).entries()) out.push({key: `f${i}`, kind: 'formatted', at: x.at, author: x.author || 'Author', text: x.description});
  return out;
}

/** "Oct 30, 2026, 9:30 AM" from a revision or comment date. */
function when(iso?: string) {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'}) : '';
}

/**
 * The markup area beside the page (canvas/balloons.rs): each card next to its anchor as near as
 * the cards above allow, joined to it by a dashed leader. A comment card holds its replies; clicking
 * it makes it the active one, whose text is edited in place, with Reply, Resolve and Delete.
 */
function Balloons({cards, content, lay, page, scale, rect, pageHint, active, exec, setActive, canEdit, onPick}: {cards: Card[]; content: any; lay: any; page: number;
  scale: number; rect: Rect; pageHint: number; active: number | null; exec: (id: string, p?: Record<string, unknown>, quiet?: boolean) => Promise<any>;
  setActive: (id: number | null) => void; canEdit: boolean; onPick: (pos: Pos) => void}) {
  const [replying, setReplying] = useState<number | null>(null);
  const items = cards.map(c => ({c, at: lay.caret(c.at, pageHint)})).filter(x => x.at && x.at.page === page).sort((x, y) => x.at.top - y.at.top || x.at.x - y.at.x);
  if (!items.length) return null;
  // Comment cards in the comment authors' colours, revision cards in the revision authors' (as the text is drawn).
  const commenters = authorOrder(Object.values(content.comments ?? {}).map((c: any) => ({author: c.author ?? ''})));
  const revisers = authorOrder(content.revisions ?? []);
  const colorFor = (c: Card, a: string) => revisionColor((c.kind === 'comment' ? commenters : revisers).get(a) ?? 0);
  const rgb = (c: number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  const left = rect.w + 10;
  const width = G.MARKUP_WIDTH * scale - 20;
  const perLine = Math.max(width / 6.6, 10);
  let bottom = -Infinity;
  const placed = items.map(({c, at}) => {
    const isActive = c.kind === 'comment' && c.id === active;
    const textLines = (t: string) => Math.max(1, t.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0));
    let h = 22 + textLines(c.text) * 15;
    for (const r of c.replies ?? []) h += 24 + textLines(r.text) * 15;
    if (isActive) h += 34 + (replying === c.id ? 40 : 0);
    const y = Math.max(at.top * scale - 8, bottom + 6);
    bottom = y + h;
    return {c, at, y, h, isActive};
  });
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return <>
    <svg className="quill-balloon-leaders" width={rect.w + 12} height={rect.h} aria-hidden="true">
      {placed.map(({c, at, y}) => <polyline key={c.key} style={{stroke: rgb(colorFor(c, c.author))}}
        points={`${at.x * scale},${(at.top + at.height) * scale} ${rect.w},${(at.top + at.height) * scale} ${rect.w + 10},${y + 12}`}/>)}
    </svg>
    {placed.map(({c, y, isActive}) => <div key={c.key} role={c.kind === 'comment' ? 'group' : 'note'} aria-label={c.kind === 'comment' ? `Comment by ${c.author}` : c.text}
      className={`quill-balloon is-${c.kind}${c.resolved ? ' is-resolved' : ''}${isActive ? ' is-active' : ''}`}
      data-context={c.kind === 'comment' ? 'commentBalloon' : undefined} data-comment-id={c.id ?? undefined}
      style={{left, top: y, width, borderLeftColor: rgb(colorFor(c, c.author))}}
      onPointerDown={stop} onKeyDown={stop}
      onContextMenu={() => { if (c.kind === 'comment') { setActive(c.id ?? null); onPick(c.at); } }}
      onClick={() => { if (c.kind === 'comment') { setActive(c.id ?? null); onPick(c.at); } else onPick(c.at); }}>
      <header><b style={{color: rgb(colorFor(c, c.author))}}>{c.author}</b>{c.date ? <time>{when(c.date)}</time> : null}{c.resolved ? <em>Resolved</em> : null}</header>
      {isActive && canEdit ? <textarea className="quill-balloon-edit" aria-label="Comment text" defaultValue={c.text} key={`${c.id}:${c.text}`} rows={Math.max(1, c.text.split('\n').length)}
        placeholder="Add a comment" autoFocus={!c.text}
        onBlur={e => { const v = e.currentTarget.value; if (v !== c.text) void exec('review.editComment', {id: c.id, text: v}); }}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.currentTarget.value = c.text; e.currentTarget.blur(); } }}/>
        : <span>{c.text}</span>}
      {(c.replies ?? []).map(r => <div key={r.id} className="quill-reply" data-comment-id={r.id}>
        <header><b style={{color: rgb(colorFor(c, r.author))}}>{r.author}</b>{r.date ? <time>{when(r.date)}</time> : null}</header><span>{r.text}</span>
      </div>)}
      {isActive && replying === c.id ? <textarea className="quill-balloon-edit" aria-label="Reply" placeholder="Reply…" autoFocus rows={1}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Escape') setReplying(null);
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = e.currentTarget.value.trim(); setReplying(null); if (v) void exec('review.reply', {id: c.id, text: v}); }
        }}
        onBlur={e => { const v = e.currentTarget.value.trim(); setReplying(null); if (v) void exec('review.reply', {id: c.id, text: v}); }}/> : null}
      {isActive ? <footer className="quill-balloon-actions">
        <button type="button" onClick={e => { e.stopPropagation(); setReplying(c.id ?? null); }}>Reply</button>
        <button type="button" onClick={e => { e.stopPropagation(); void exec('review.resolveComment', {id: c.id}); }}>{c.resolved ? 'Reopen' : 'Resolve'}</button>
        <button type="button" onClick={e => { e.stopPropagation(); setActive(null); void exec('review.deleteComment', {id: c.id}); }}>Delete</button>
      </footer> : null}
    </div>)}
  </>;
}

/** The accessible mirror (a11y.rs): visually hidden, read by screen readers. */
function Mirror({d, lay, rects, top, height, title}: {d: any; lay: any; rects: Rect[]; top: number; height: number; title: string}) {
  const win = pageWindow(rects, top, height || 600);
  const key = win ? `${win[0]}-${win[1]}` : '';
  const tree = useMemo(() => (d && lay && win ? buildA11y(d, lay, win) : null), [d, lay, key]);
  if (!tree) return null;
  const node = (id: string): React.ReactNode => {
    const n: any = tree.nodes.get(id);
    if (!n) return null;
    const kids = n.children.map(node);
    switch (n.role) {
      case 'heading': return <div key={id} role="heading" aria-level={n.level}>{kids}</div>;
      case 'listitem': return <li key={id} aria-level={n.level}>{kids}</li>;
      case 'list': return <ul key={id}>{kids}</ul>;
      case 'listmarker': return <span key={id} aria-hidden="false">{n.text} </span>;
      case 'table': return <table key={id} aria-rowcount={n.rows} aria-colcount={n.cols}><tbody>{kids}</tbody></table>;
      case 'row': return <tr key={id}>{kids}</tr>;
      case 'cell': return <td key={id}>{kids}</td>;
      case 'link': return <a key={id} href={n.href} tabIndex={-1}>{kids}</a>;
      case 'img': return <span key={id} role="img" aria-label={n.alt || 'Picture'}/>;
      case 'run': return <span key={id}>{n.text}</span>;
      default: return <p key={id}>{kids}</p>;
    }
  };
  return <div className="quill-a11y" role="document" aria-label={title}>{tree.top.map(node)}</div>;
}

/** Page X of Y and the word count at the start of the status bar (chrome.rs status_bar). */
function StatusItems({root, page, pages, words, selected, controller, reading = null}: {root: React.RefObject<HTMLDivElement | null>; page: number; pages: number; words: number;
  selected: number | null; controller: SurfaceProps['controller']; reading?: {first: number; across: number; total: number} | null}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const items = root.current?.closest('.shell')?.querySelector('.shell-status-items');
    if (!items) return;
    const span = document.createElement('span');
    span.className = 'quill-status';
    items.prepend(span);
    setHost(span);
    return () => { span.remove(); };
  }, [root]);
  if (!host) return null;
  // Read Mode counts screens of columns, as Word's "Screens 1-2 of 6".
  const pageText = reading ? (reading.across > 1 && reading.first + 1 < reading.total
    ? `Screens ${reading.first + 1}-${Math.min(reading.first + reading.across, reading.total)} of ${reading.total}` : `Screen ${reading.first + 1} of ${reading.total}`)
    : `Page ${page} of ${pages}`;
  const wordText = selected === null ? `${words.toLocaleString()} words` : `${selected.toLocaleString()} of ${words.toLocaleString()} words`;
  const can = (id: string) => controller.dialogImplemented(id);
  const open = (id: string) => { try { controller.openDialog(id); } catch (e) { controller.notify(toCommandError(e).message, 'error'); } };
  return createPortal(<>
    {can('dialog.goto') ? <button type="button" className="shell-status-item" data-status-id="status.page" onClick={() => open('dialog.goto')}>{pageText}</button>
      : <span className="shell-status-item" data-status-id="status.page">{pageText}</span>}
    {can('dialog.wordCount') ? <button type="button" className="shell-status-item" data-status-id="status.words" onClick={() => open('dialog.wordCount')}>{wordText}</button>
      : <span className="shell-status-item" data-status-id="status.words">{wordText}</span>}
  </>, host);
}
