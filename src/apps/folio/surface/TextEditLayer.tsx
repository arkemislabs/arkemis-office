// The edit layer of one page. With Edit text & images picked, the page's paragraphs, pictures and added items show boxes: a click opens a paragraph (or an
// added text) for typing, in a box of its own width, font size and colour, with a blinking caret; leaving it or Ctrl+Enter writes the words back, Escape drops them.
// A drag moves a paragraph or an item, a corner handle resizes a picture or an added item, and a handle on a paragraph's left or right edge rewraps it to a new
// width. With Add text picked, a click on the page puts a box there and a drag draws one; typing fills it. Format text and the Image controls act on what is open.
//
// Translated from printcraft crates/ui-egui/src/tools/edit_text_ui.rs (paragraph boxes outlined on hover and while open, a click opens the paragraph under the
// pointer and applies the open one first (#2022), the editor shows `editor_text`, Edit::EditTextBlock, a drag moves it (Grip::Move) and the handles on its left and
// right edges rewrap it from `reflow_text` with the new width (Grip::Left, Grip::Right: only on an upright page)), tools/content_ui.rs (a click puts a 200 point box
// at the click, a drag draws one, added items are selected, moved, resized by their corners and retyped, an emptied item is deleted) and canvas.rs (the caret) at
// 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt). Everything is written through commands (edit.blocks, edit.select_block, edit.text_replace,
// edit.text_move, edit.images, edit.image_*, edit.added*, edit.text).

import {useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';
import {cssFont} from '../../../../core/folio/lib/content-paint.mjs';
import {resized, handlePos} from '../../../../core/folio/lib/pageview.mjs';
import {pageRotation, viewSize} from '../../../../core/folio/lib/geom.mjs';
import type {PageGeom} from './PageView';

type Any = any;

export const EDIT_TOOL = 'edit.text_edit';
export const ADD_TOOL = 'edit.add_text';
export const LINK_TOOL = 'edit.add_link';
const CORNERS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const ACCENT = '#1473e6';
const DRAG_PX = 4;
const EDGE_REACH = 6;
const NEW_WIDTH = 200;
const CARET_SOLID_MS = 900;

interface Open { kind: 'block' | 'added' | 'new'; key?: Any; obj?: number; rect: number[]; original: string; text: string; block: Any }
type Gesture =
  | {t: 'block'; index: number; from: [number, number]; to: [number, number]; moved: boolean}
  | {t: 'obj'; index: number; handle: [number, number] | null; from: [number, number]; to: [number, number]; moved: boolean}
  | {t: 'edge'; index: number; side: 'l' | 'r'; from: [number, number]; to: [number, number]}
  | {t: 'new'; from: [number, number]; to: [number, number]}
  | {t: 'none'; from: [number, number]; to: [number, number]};

const round = (v: number) => Math.round(v * 1000) / 1000;

export function TextEditLayer({api, page, geom}: {api: Any; page: Any; geom: PageGeom}) {
  const host = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const adding = api.tool === ADD_TOOL;
  const linking = api.tool === LINK_TOOL;
  const [links, setLinks] = useState<Any[]>([]);
  const [pickedLink, setPickedLink] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Any[]>([]);
  const [objs, setObjs] = useState<Any[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const openRef = useRef<Open | null>(null);
  openRef.current = open;
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gref = useRef<Gesture | null>(null);
  gref.current = gesture;
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const [caret, setCaret] = useState<{x: number; y: number; h: number; solid: boolean} | null>(null);
  const solidTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scale = geom.scale;
  const rev = `${api.content.sourceBase64?.length}:${api.content.sourceBase64?.slice(-64)}`;
  const upright = pageRotation(page) === 0;

  const fetchBlocks = useCallback(async (): Promise<Any[]> => {
    const r: Any = await api.exec('edit.blocks', {page: page.id});
    const list = Array.isArray(r?.blocks) ? r.blocks : [];
    setBlocks(list);
    return list;
  }, [api, page.id]);
  /** Pictures first, added items after them (on top): `src` says which commands act on one. */
  const fetchObjs = useCallback(async (): Promise<Any[]> => {
    const [im, ad]: Any[] = await Promise.all([api.exec('edit.images', {page: page.id}), api.exec('edit.added', {page: page.id})]);
    const list = [...(im?.images ?? []).map((i: Any) => ({...i, src: 'image', kind: 'image'})), ...(ad?.items ?? []).map((i: Any) => ({...i, src: 'added'}))];
    setObjs(list);
    return list;
  }, [api, page.id]);
  const fetchLinks = useCallback(async () => {
    const r: Any = await api.exec('edit.links', {page: page.id});
    setLinks(Array.isArray(r?.links) ? r.links : []);
  }, [api, page.id]);
  useEffect(() => { if (linking) void fetchLinks(); }, [rev, linking]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchBlocks(); void fetchObjs().then(l => setPicked(cur => (cur !== null && l[cur] ? cur : null))); }, [rev, page.sourceIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  const toView = (e: {clientX: number; clientY: number}): [number, number] => {
    const b = host.current!.getBoundingClientRect();
    return [(e.clientX - b.left) / scale, (e.clientY - b.top) / scale];
  };
  const px = (r: number[]) => ({left: r[0] * scale, top: r[1] * scale, width: (r[2] - r[0]) * scale, height: (r[3] - r[1]) * scale});
  const inside = (r: number[], v: [number, number], pad = 1) => v[0] >= r[0] - pad && v[0] <= r[2] + pad && v[1] >= r[1] - pad && v[1] <= r[3] + pad;
  const hit = (list: Any[], v: [number, number]) => {
    let best = -1, area = Infinity;
    list.forEach((b, i) => { if (inside(b.rect, v)) { const a = (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]); if (a <= area) { best = i; area = a; } } });
    return best;
  };
  const objAt = (list: Any[], v: [number, number]) => { for (let i = list.length - 1; i >= 0; i--) if (inside(list[i].rect, v, 0)) return i; return -1; };

  /** Write the typed words back (nothing changes when they are the ones the box had; an emptied added item goes). */
  const commit = useCallback((o: Open | null): Promise<unknown> => {
    if (!o || o.text === o.original) return Promise.resolve();
    const run = (async () => {
      let r: Any;
      if (o.kind === 'block') r = await api.exec('edit.text_replace', {page: page.id, key: o.key, text: o.text});
      else if (o.kind === 'added') r = await api.exec('edit.added_change', {page: page.id, obj: o.obj, change: o.text.trim() ? 'text' : 'delete', ...(o.text.trim() ? {text: o.text} : {})});
      else if (o.text.trim()) r = await api.exec('edit.text', {page: page.id, rect: o.rect, text: o.text});
      if (r?.notice) api.notify(r.notice);
    })();
    pending.current = run;
    return run;
  }, [api, page.id]);

  // The tool put down, or another file revision: the editor closes (what was typed is written first).
  useEffect(() => () => { void commit(openRef.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The caret: drawn, blinking, at the text cursor of the open box (a mirror of the box measures where the text up to it ends).
  const placeCaret = useCallback((solid: boolean) => {
    const el = area.current, layer = host.current;
    if (!el || !layer) { setCaret(null); return; }
    const mirror = document.createElement('div');
    const cs = getComputedStyle(el);
    for (const k of ['font', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'borderTopWidth', 'borderLeftWidth', 'borderRightWidth', 'borderBottomWidth', 'boxSizing', 'whiteSpace', 'overflowWrap', 'wordBreak'] as const) mirror.style[k] = cs[k];
    Object.assign(mirror.style, {position: 'absolute', visibility: 'hidden', left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, width: `${el.offsetWidth}px`, height: 'auto'});
    const at = el.selectionEnd ?? el.value.length;
    mirror.textContent = el.value.slice(0, at);
    const mark = document.createElement('span');
    mark.textContent = '​';
    mirror.appendChild(mark);
    layer.appendChild(mirror);
    const next = {x: mark.offsetLeft + el.offsetLeft - el.scrollLeft, y: mark.offsetTop + el.offsetTop - el.scrollTop, h: parseFloat(cs.lineHeight) || mark.offsetHeight, solid};
    layer.removeChild(mirror);
    setCaret(next);
    if (solidTimer.current) clearTimeout(solidTimer.current);
    if (solid) solidTimer.current = setTimeout(() => setCaret(c => (c ? {...c, solid: false} : c)), CARET_SOLID_MS);
  }, []);
  useLayoutEffect(() => { if (open) placeCaret(true); else setCaret(null); }, [open?.text, open?.rect, scale]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const on = () => { if (document.activeElement === area.current) placeCaret(true); };
    document.addEventListener('selectionchange', on);
    return () => document.removeEventListener('selectionchange', on);
  }, [open?.kind, open?.obj, placeCaret]); // eslint-disable-line react-hooks/exhaustive-deps

  // A box just opened: focus, the caret after its last word.
  useEffect(() => {
    const el = area.current;
    if (open && el) { el.focus({preventScroll: true}); el.setSelectionRange(el.value.length, el.value.length); placeCaret(true); }
  }, [open?.kind, open?.obj, open?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && area.current) {
      const el = area.current;
      el.style.height = 'auto';
      el.style.height = `${Math.max(el.scrollHeight, (open.rect[3] - open.rect[1]) * scale)}px`;
    }
  }, [open?.kind, open?.obj, open?.key, open?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = async (list: Any[], i: number) => {
    const o = list[i];
    setPicked(i);
    if (o.src === 'image') await api.exec('edit.image_select', {page: page.id, key: o.key});
    else await api.exec('edit.added_select', {page: page.id, obj: o.obj});
  };
  const putDown = () => { setPicked(null); void api.exec('edit.select_block', {}); void api.exec('edit.image_select', {}); void api.exec('edit.added_select', {}); };

  const styleOfAdded = (o: Any) => ({rect: o.rect, size: o.size ?? 12, font: o.family ? `${o.family}${o.bold ? '-Bold' : ''}${o.italic ? '-Italic' : ''}` : 'Helvetica', color: o.color ?? '#000000', rows: 1});

  async function openAt(v: [number, number]) {
    await pending.current;
    const [list, os] = await Promise.all([fetchBlocks(), fetchObjs()]);
    const i = adding ? -1 : hit(list, v);
    if (i >= 0) {
      if (!list[i].editable) { if (list[i].refusal) api.notify(list[i].refusal); setOpen(null); putDown(); return; }
      const b = list[i];
      setPicked(null);
      await api.exec('edit.select_block', {page: page.id, key: b.key});
      setOpen({kind: 'block', key: b.key, rect: b.rect, original: b.reflowText, text: b.reflowText, block: b});
      return;
    }
    const j = objAt(os, v);
    if (j >= 0) {
      await select(os, j);
      const o = os[j];
      if (o.src === 'added' && o.kind === 'text') setOpen({kind: 'added', obj: o.obj, rect: o.rect, original: o.text, text: o.text, block: styleOfAdded(o)});
      else setOpen(null);
      return;
    }
    setOpen(null);
    putDown();
  }

  /** The left or right edge of a paragraph box under `v` (an upright page and paragraph only). */
  const edgeAt = (b: Any, v: [number, number]): 'l' | 'r' | null => {
    if (!upright || Math.abs(b.rotation ?? 0) > 0.01) return null;
    const r = b.rect;
    if (v[1] < r[1] - EDGE_REACH / scale || v[1] > r[3] + EDGE_REACH / scale) return null;
    const reach = EDGE_REACH / scale, inner = Math.min(reach, (r[2] - r[0]) / 4);
    const [dl, dr] = [v[0] - r[0], r[2] - v[0]];
    const l = dl >= -reach && dl <= inner, rr = dr >= -reach && dr <= inner;
    if (l && rr) return dl <= dr ? 'l' : 'r';
    return rr ? 'r' : l ? 'l' : null;
  };
  const linkAt = (v: [number, number]) => { for (let i = links.length - 1; i >= 0; i--) if (inside(links[i].rect, v, 2)) return i; return -1; };
  const handleAt = (v: [number, number]): [number, number] | null => {
    if (picked === null || !objs[picked]) return null;
    for (const h of CORNERS) { const q = handlePos(objs[picked].rect, h); if (Math.hypot((q[0] - v[0]) * scale, (q[1] - v[1]) * scale) <= 7) return h; }
    return null;
  };

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    (host.current?.closest('.folio-surface') as HTMLElement | null)?.focus({preventScroll: true});
    const v = toView(e);
    const capture = () => { try { host.current?.setPointerCapture(e.pointerId); } catch { /* a pointer the system does not track */ } };
    if (linking) { capture(); setGesture(linkAt(v) < 0 ? {t: 'new', from: v, to: v} : {t: 'none', from: v, to: v}); return; }
    const h = handleAt(v);
    if (h && picked !== null) { capture(); setGesture({t: 'obj', index: picked, handle: h, from: v, to: v, moved: false}); return; }
    const bi = adding ? -1 : hit(blocks, v);
    if (bi >= 0 && blocks[bi].editable && openRef.current?.key?.text !== blocks[bi].key.text) {
      const side = edgeAt(blocks[bi], v);
      capture();
      if (side && api.allowed) setGesture({t: 'edge', index: bi, side, from: v, to: v});
      else if (api.allowed) setGesture({t: 'block', index: bi, from: v, to: v, moved: false});
      else setGesture({t: 'none', from: v, to: v});
      return;
    }
    const oi = bi < 0 ? objAt(objs, v) : -1;
    if (oi >= 0) { capture(); setGesture({t: 'obj', index: oi, handle: null, from: v, to: v, moved: false}); return; }
    capture();
    setGesture(adding && bi < 0 ? {t: 'new', from: v, to: v} : {t: 'none', from: v, to: v});
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const v = toView(e);
    const g = gref.current;
    if (g) {
      const moved = Math.hypot((v[0] - g.from[0]) * scale, (v[1] - g.from[1]) * scale) >= DRAG_PX;
      setGesture(g.t === 'block' || g.t === 'obj' ? {...g, to: v, moved: g.moved || moved} : {...g, to: v});
      return;
    }
    const i = adding ? -1 : hit(blocks, v);
    setHover(i >= 0 ? i : null);
  }
  async function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gref.current;
    setGesture(null);
    try { host.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!g) return;
    const v = toView(e);
    const dragged = Math.hypot((v[0] - g.from[0]) * scale, (v[1] - g.from[1]) * scale) >= DRAG_PX;
    const [dx, dy] = [round(v[0] - g.from[0]), round(v[1] - g.from[1])];
    const settle = async () => { await commit(openRef.current); setOpen(null); };
    if (g.t === 'edge') {
      if (!dragged) { await settle(); setPicked(null); await openAt(v); return; }
      // The paragraph rewraps to the width its edge was dragged to (reflow_text keeps typed breaks and rejoins wraps); the left edge moves it too.
      const b = blocks[g.index];
      const width = Math.max((b.userRect[2] - b.userRect[0]) + (g.side === 'r' ? dx : -dx), 12);
      await settle();
      const r: Any = await api.exec('edit.text_replace', {page: page.id, key: b.key, text: b.reflowText, width: round(width), ...(g.side === 'l' ? {offset: [dx, 0]} : {})});
      if (r?.notice) api.notify(r.notice);
      return;
    }
    if (linking) {
      const li = linkAt(v);
      if (g.t === 'new' && dragged && Math.abs(v[0] - g.from[0]) * scale >= 4 && Math.abs(v[1] - g.from[1]) * scale >= 4) {
        setPickedLink(null);
        api.openLink(page.id, [Math.min(g.from[0], v[0]), Math.min(g.from[1], v[1]), Math.max(g.from[0], v[0]), Math.max(g.from[1], v[1])].map(round));
      } else if (li >= 0) { setPickedLink(links[li].id); await api.exec('edit.link_select', {page: page.id, id: links[li].id}); }
      else { setPickedLink(null); await api.exec('edit.link_select', {}); }
      return;
    }
    if (g.t === 'new') {
      await settle();
      putDown();
      // A click: a 200 point box with its top left at the click (to the page's edge); a drag: the box drawn.
      const pw = viewSize(page).width;
      const rect = dragged ? [Math.min(g.from[0], v[0]), Math.min(g.from[1], v[1]), Math.max(g.from[0], v[0]), Math.max(g.from[1], v[1])] : [g.from[0], g.from[1], Math.min(g.from[0] + NEW_WIDTH, pw), g.from[1] + 14.4];
      setOpen({kind: 'new', rect, original: '', text: '', block: {rect, size: 12, font: 'Helvetica', color: '#000000', rows: 1}});
      return;
    }
    if (g.t === 'obj') {
      const o = objs[g.index];
      await settle();
      if (o && dragged) {
        setPicked(g.index);
        const keep = o.src === 'added' && o.kind === 'image';
        const target = o.src === 'image' ? {page: page.id, key: o.key} : {page: page.id, obj: o.obj};
        const command = o.src === 'image' ? 'edit.image_change' : 'edit.added_change';
        if (g.handle) {
          const ratio = keep ? (o.rect[2] - o.rect[0]) / Math.max(o.rect[3] - o.rect[1], 1e-6) : null;
          const r = resized(o.rect, g.handle, v[0] - g.from[0], v[1] - g.from[1], ratio as any);
          if ((r[2] - r[0]) * scale >= 4 && (r[3] - r[1]) * scale >= 4) await api.exec(command, {...target, change: 'resize', rect: r.map(round)});
        } else await api.exec(command, {...target, change: 'move', offset: [dx, dy]});
        return;
      }
      if (o) {
        await select(objs, g.index);
        if (o.src === 'added' && o.kind === 'text') setOpen({kind: 'added', obj: o.obj, rect: o.rect, original: o.text, text: o.text, block: styleOfAdded(o)});
      }
      return;
    }
    if (g.t === 'block') {
      const blk = blocks[g.index];
      if (dragged) {
        await settle();
        const r: Any = await api.exec('edit.text_move', {page: page.id, key: blk.key, offset: [dx, dy]});
        if (r?.notice) api.notify(r.notice);
        return;
      }
    }
    const was = openRef.current;
    if (was) { await commit(was); setOpen(null); }
    setPicked(null);
    await openAt(v);
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); setOpen(null); putDown(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const o = openRef.current; setOpen(null); void commit(o); }
  };

  const b = open?.block;
  const lead = b ? (b.rows > 1 ? Math.max((b.rect[3] - b.rect[1] - b.size * 1.15) / (b.rows - 1), b.size) : b.size * 1.2) : 0;
  const preview = (r: number[], g: Gesture | null, mode: 'block' | 'obj'): number[] => {
    if (!g || g.t !== mode || !('moved' in g) || !g.moved) return r;
    if (mode === 'obj' && (g as Any).handle) return resized(r, (g as Any).handle, g.to[0] - g.from[0], g.to[1] - g.from[1], null);
    return [r[0] + g.to[0] - g.from[0], r[1] + g.to[1] - g.from[1], r[2] + g.to[0] - g.from[0], r[3] + g.to[1] - g.from[1]];
  };
  const edgeRect = (r: number[], side: 'l' | 'r', dx: number) => (side === 'l' ? [Math.min(r[0] + dx, r[2] - 12), r[1], r[2], r[3]] : [r[0], r[1], Math.max(r[2] + dx, r[0] + 12), r[3]]);
  const handleBoxes = (r: number[]) => [r[0], r[2]].map(x => { const hh = Math.min(Math.max((r[3] - r[1]) * 0.5, 14 / scale), 28 / scale); const cy = (r[1] + r[3]) / 2; return [x - 3.5 / scale, cy - hh / 2, x + 3.5 / scale, cy + hh / 2]; });

  return <div ref={host} className="folio-edit-layer" data-edit-layer={page.id} data-adding={adding ? 'true' : undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
    onPointerLeave={() => setHover(null)} style={{cursor: adding || linking ? 'crosshair' : hover !== null && blocks[hover]?.editable ? 'text' : 'default'}}>
    {linking ? links.map(l => <i key={l.id} className={`folio-edit-link${pickedLink === l.id ? ' is-picked' : ''}`} data-link={l.id} title={l.uri ?? undefined} style={px(l.rect)}/>) : null}
    {adding || linking ? null : blocks.map((blk, i) => {
      if (open?.kind === 'block' && open.key?.text === blk.key.text) return null;
      const g = gesture;
      const r = g?.t === 'edge' && g.index === i ? edgeRect(blk.rect, g.side, g.to[0] - g.from[0]) : g?.t === 'block' && g.index === i && g.moved ? preview(blk.rect, g, 'block') : blk.rect;
      const moving = !!g && ((g.t === 'block' && g.index === i && g.moved) || (g.t === 'edge' && g.index === i));
      return <i key={i} className={`folio-edit-box${hover === i ? ' is-hover' : ''}${blk.editable ? '' : ' is-locked'}${moving ? ' is-moving' : ''}`} data-block={i} data-editable={blk.editable ? 'true' : 'false'}
        title={blk.editable ? undefined : blk.refusal ?? undefined} style={px(r)}>
        {hover === i && blk.editable && !open && upright && !moving ? handleBoxes([0, 0, r[2] - r[0], r[3] - r[1]]).map((h, k) => <u key={k} className="folio-edge-handle" data-edge={k === 0 ? 'l' : 'r'} style={px(h)}/>) : null}
        {moving && g?.t === 'edge' ? handleBoxes([0, 0, r[2] - r[0], r[3] - r[1]]).map((h, k) => <u key={k} className="folio-edge-handle" style={px(h)}/>) : null}
      </i>;
    })}
    {linking ? null : objs.map((o, i) => {
      if (open?.kind === 'added' && open.obj === o.obj && o.src === 'added') return null;
      const g = gesture?.t === 'obj' && gesture.index === i ? gesture : null;
      const rr = g?.moved && !g.handle ? [o.rect[0] + g.to[0] - g.from[0], o.rect[1] + g.to[1] - g.from[1], o.rect[2] + g.to[0] - g.from[0], o.rect[3] + g.to[1] - g.from[1]] : g?.moved && g.handle ? resized(o.rect, g.handle, g.to[0] - g.from[0], g.to[1] - g.from[1], o.src === 'added' && o.kind === 'image' ? (o.rect[2] - o.rect[0]) / Math.max(o.rect[3] - o.rect[1], 1e-6) : (null as any)) : o.rect;
      return <i key={`o${o.src}${i}`} className={`folio-edit-image${picked === i ? ' is-picked' : ''}${g?.moved ? ' is-moving' : ''}${o.src === 'added' ? ' is-added' : ''}`} data-image={i} data-src={o.src} style={px(rr)}>
        {picked === i ? CORNERS.map(h => { const q = handlePos([0, 0, rr[2] - rr[0], rr[3] - rr[1]], h); return <u key={h.join()} style={{left: q[0] * scale, top: q[1] * scale}}/>; }) : null}
      </i>;
    })}
    {gesture?.t === 'new' ? <i className="folio-edit-box is-moving" style={px([Math.min(gesture.from[0], gesture.to[0]), Math.min(gesture.from[1], gesture.to[1]), Math.max(gesture.from[0], gesture.to[0]), Math.max(gesture.from[1], gesture.to[1])])}/> : null}
    {open && b ? <textarea ref={area} className="folio-edit-input" data-edit-input={page.id} data-kind={open.kind} value={open.text} spellCheck={false}
      onChange={e => setOpen({...open, text: e.target.value})} onKeyDown={onKeyDown} onKeyUp={() => placeCaret(true)} onClick={() => placeCaret(true)}
      onBlur={() => { const o = openRef.current; if (o) { setOpen(null); void commit(o); } }}
      style={{left: open.rect[0] * scale - 2, top: open.rect[1] * scale - 2, width: Math.max((open.rect[2] - open.rect[0]) * scale + 6, 40), minHeight: (open.rect[3] - open.rect[1]) * scale + 4,
        font: cssFont(b.font, b.size * scale), lineHeight: `${lead * scale}px`, color: b.color, borderColor: ACCENT, caretColor: 'transparent'}}/> : null}
    {open && caret ? <i className={`folio-edit-caret${caret.solid ? ' is-solid' : ''}`} data-caret="true" style={{left: caret.x, top: caret.y, height: caret.h, background: b?.color ?? '#000'}}/> : null}
  </div>;
}
