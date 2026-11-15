// The Navigation pane (View › Show › Navigation Pane, Ctrl+F): a search box, then Word's three tabs.
// Headings: the document's headings as an outline (numbered headings start with their number),
// collapsible, the one the caret is under highlighted; a click goes there, and dragging a heading
// moves it with everything under it (outline.moveSection, one undo step). Pages: a thumbnail of
// every page, the one in view highlighted; a click goes to that page. Results: every match of the
// search with the text around it; a click selects it.
//
// Translated from wordcraft crates/ui-egui/src/panes/nav.rs (`nav`, `visible_headings`,
// `nav_headings`, `nav_heading`) at aadb077e072b7de05f724e359d8db82e151f125c; the page
// thumbnails and the drag of a heading are Word's (upstream lists "Page n" and has no drag).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {Document} from '../../../../core/quill/model/document.mjs';
import {isQuill2} from '../../../../core/quill/model/content.mjs';
import {headingLevel} from '../../../../core/quill/lib/para-lists.mjs';
import {pageDisplay, getDefaultShaper} from '../../../../core/quill/layout/index.mjs';
import {layoutOf, viewOf as liveOf, subscribe} from '../surface/live.mjs';
import {paintPage} from '../surface/paint.mjs';
import {Icon} from '../../../shell/icons/Icon';

type Tab = 'headings' | 'pages' | 'results';
type Heading = {block: number; level: number; text: string};
type Match = {start: {story: unknown; path: number[]; off: number; address?: string}; end: {story: unknown; path: number[]; off: number; address?: string}};
const OBJ = '￼';
const EMPTY = 'Create an interactive outline of your document.\n\nIt\'s a great way to keep track of where you are or quickly move your content around.\n\nTo get started, go to the Home tab and apply Heading styles to the headings in your document.';

/** The body's headings in order (nav_headings): level 1–9, text with its list number, TOC entries left out. */
export function navHeadings(content: any, lay: any): Heading[] {
  const d = new Document(content);
  const labels = new Map<number, string>();
  for (const p of lay?.pages ?? []) for (const it of p.items) if (it.kind === 'lines' && it.story === 'body' && it.l0 === 0 && it.path.length === 1 && it.para?.label?.text) labels.set(it.path[0], it.para.label.text);
  const bl: any = d.container('body', [0]);
  const out: Heading[] = [];
  for (let i = 0; i < bl.len(); i++) {
    const p: any = bl.get(i);
    if (p?.kind !== 'para') continue;
    const level = headingLevel(d.styles, p.props);
    if (level === null) continue;
    const txt = p.text.split(OBJ).join('').replace(/[\t\n\f\u000E]/g, ' ').trim();
    if (!txt || String(p.props?.style ?? '').startsWith('TOC')) continue;
    const label = labels.get(i);
    out.push({block: i, level, text: label && label.trim() && !/^[•○■□▪◆➢✓–★◦●]/u.test(label) ? `${label.trim()} ${txt}` : txt});
  }
  return out;
}

/** Which headings show (visible_headings): those under a collapsed heading are hidden. */
export function visibleHeadings(levels: number[], collapsed: boolean[]): boolean[] {
  let hideBelow: number | null = null;
  return levels.map((lv, i) => {
    if (hideBelow !== null && lv > hideBelow) return false;
    hideBelow = collapsed[i] ? lv : null;
    return true;
  });
}

export default function NavigationPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [tab, setTab] = useState<Tab>('headings');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Match[]>([]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [drag, setDrag] = useState<{from: number; over: number | null} | null>(null);
  const live = liveOf(docId);
  const [liveTick, setLiveTick] = useState(0);
  useEffect(() => subscribe(docId, () => setLiveTick(t => t + 1)), [docId]);
  const doc: any = (() => { try { return session.get(docId); } catch { return null; } })();
  const content = doc?.file.content;
  const ready = isQuill2(content);
  const lay: any = useMemo(() => (ready ? layoutOf(docId, content, doc.view) : null), [ready, content, tick, liveTick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => session.execute(docId, id, params, {origin: 'ui'}).catch(e => { fail(e); return null; });

  const headings = useMemo(() => (ready ? navHeadings(content, lay) : []), [ready, content, lay]);
  const caretBlock = (() => {
    const sel = doc?.selection?.ranges?.[doc.selection.primary ?? 0];
    const m = /\/body\/b:([^/]+)/.exec(String(sel?.focus ?? ''));
    if (!m || !ready) return -1;
    const bl: any = new Document(content).container('body', [0]);
    for (let i = 0; i < bl.len(); i++) if (bl.get(i)?.id === m[1]) return i;
    return -1;
  })();
  const current = (() => { let c = -1; headings.forEach((h, i) => { if (h.block <= caretBlock) c = i; }); return c; })();
  const levels = headings.map(h => h.level);
  const hasKids = headings.map((h, i) => (headings[i + 1]?.level ?? 0) > h.level);
  const shown = visibleHeadings(levels, headings.map((h, i) => hasKids[i] && collapsed.has(h.block)));

  // Search: every match, listed under Results (nav.rs: edit.find with the text).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = (q: string) => {
    setQuery(q);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (!q) { setResults([]); return; }
      setTab('results');
      const r: any = await run('edit.find', {text: q});
      setResults(Array.isArray(r?.result?.matches) ? r.result.matches : []);
    }, 180);
  };

  // The tab the view asks for (view.navigationPane {tab}), and a search run elsewhere (Ctrl+F's
  // edit.find, Find and Replace) shown in Results, as Word's pane does.
  const askedTab = doc?.view?.navTab as Tab | undefined;
  useEffect(() => { if (askedTab) setTab(askedTab); }, [askedTab]);
  const lastQuery = String(doc?.view?.quill?.find?.query ?? '');
  useEffect(() => { if (lastQuery && lastQuery !== query) search(lastQuery);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastQuery]);

  const goHeading = (h: Heading) => { void run('caret.set', {pos: {story: 'body', path: [h.block], off: 0}}).then(() => controller.focusSurface()); };
  const drop = (to: number) => {
    const from = drag?.from;
    setDrag(null);
    if (from === undefined || from === to) return;
    void run('outline.moveSection', {from, to});
  };
  const endOfDoc = (() => { try { return (new Document(content).container('body', [0]) as any).len(); } catch { return 0; } })();

  return <div className="quill-nav-pane" data-nav-tab={tab}>
    <label className="quill-nav-search">
      <Icon id="find" size={16}/>
      <input type="search" aria-label="Search document" placeholder="Search document" value={query} onChange={e => search(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { search(''); setTab('headings'); } }}/>
    </label>
    <div className="quill-nav-tabs" role="tablist" aria-label="Navigation">
      {([['headings', 'Headings'], ['pages', 'Pages'], ['results', 'Results']] as [Tab, string][]).map(([k, l]) =>
        <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>{l}</button>)}
    </div>
    <div className="quill-nav-body" role="tabpanel" aria-label={tab}>
      {tab === 'headings' ? (headings.length
        ? <div role="tree" aria-label="Headings" className="quill-nav-tree">
          {headings.map((h, i) => shown[i] ? <div key={h.block} role="treeitem" aria-level={h.level} aria-selected={i === current} aria-expanded={hasKids[i] ? !collapsed.has(h.block) : undefined}
            className={`quill-nav-heading${i === current ? ' is-current' : ''}${drag?.over === h.block ? ' is-drop' : ''}${drag?.from === h.block ? ' is-dragging' : ''}`}
            data-block={h.block} style={{paddingLeft: 4 + (h.level - 1) * 14}} draggable
            onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(h.block)); setDrag({from: h.block, over: null}); }}
            onDragOver={e => { if (!drag) return; e.preventDefault(); if (drag.over !== h.block) setDrag({...drag, over: h.block}); }}
            onDragEnd={() => setDrag(null)}
            onDrop={e => { e.preventDefault(); drop(h.block); }}
            onClick={() => goHeading(h)}>
            <button type="button" className="quill-nav-twisty" tabIndex={-1} aria-label={collapsed.has(h.block) ? 'Expand' : 'Collapse'} disabled={!hasKids[i]}
              onClick={e => { e.stopPropagation(); setCollapsed(c => { const n = new Set(c); if (!n.delete(h.block)) n.add(h.block); return n; }); }}>
              {hasKids[i] ? <svg viewBox="0 0 10 10" width={10} height={10} aria-hidden="true">{collapsed.has(h.block)
                ? <path d="M3 1.5L7.5 5L3 8.5Z" fill="currentColor"/> : <path d="M1.5 3L8.5 3L5 7.5Z" fill="currentColor"/>}</svg> : null}
            </button>
            <span className={h.level === 1 ? 'is-top' : ''}>{h.text}</span>
          </div> : null)}
          <div className={`quill-nav-end${drag?.over === endOfDoc ? ' is-drop' : ''}`} onDragOver={e => { if (!drag) return; e.preventDefault(); if (drag.over !== endOfDoc) setDrag({...drag, over: endOfDoc}); }}
            onDrop={e => { e.preventDefault(); drop(endOfDoc); }}/>
        </div>
        : <p className="quill-nav-empty">{EMPTY}</p>)
        : tab === 'pages' ? <Thumbnails lay={lay} current={live.viewedPage ?? live.pageHint} pageColor={content?.settings?.pageColor ?? null}
          onPick={n => { void run('edit.goto', {page: n + 1}).then(() => controller.focusSurface()); }}/>
        : <Results query={query} results={results} content={content} onPick={m => { void run('select.range', {anchor: m.start, focus: m.end}).then(() => controller.focusSurface()); }}/>}
    </div>
  </div>;
}

/** The Pages tab: each page drawn small, its number under it; painted only once scrolled into view. */
function Thumbnails({lay, current, pageColor, onPick}: {lay: any; current: number; pageColor: number[] | null; onPick: (n: number) => void}) {
  const pages: any[] = lay?.pages ?? [];
  return <div className="quill-nav-pages" role="list" aria-label="Pages">
    {pages.map((p, i) => <button key={i} type="button" role="listitem" className={`quill-nav-thumb${i === current ? ' is-current' : ''}`} data-page={i + 1}
      aria-label={`Page ${p.number}`} aria-current={i === current ? 'page' : undefined} onClick={() => onPick(i)}>
      <Thumb page={p} pageColor={pageColor}/>
      <span>{p.number}</span>
    </button>)}
  </div>;
}

function Thumb({page, pageColor}: {page: any; pageColor: number[] | null}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  const w = 132, scale = w / Math.max(page.w, 1), h = Math.round(page.h * scale);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); } });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c || !seen) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = pageColor ? `rgb(${pageColor[0]}, ${pageColor[1]}, ${pageColor[2]})` : '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const shaper: any = getDefaultShaper();
    try { paintPage(ctx, pageDisplay(page, {marks: false}), {scale: scale * dpr, images: () => null, advance: (g: string, f: any) => shaper.advance(g, f)}); } catch { /* a thumbnail never breaks the pane */ }
  }, [page, seen, w, h, scale, pageColor]);
  return <canvas ref={ref} className="quill-nav-thumb-art" style={{width: w, height: h}} aria-hidden="true"/>;
}

/** The Results tab (nav.rs "results"): "N results", each match with the text around it, the match marked. */
function Results({query, results, content, onPick}: {query: string; results: Match[]; content: any; onPick: (m: Match) => void}) {
  const d = useMemo(() => (isQuill2(content) ? new Document(content) : null), [content]);
  if (!query) return <p className="quill-nav-empty">Search for text in your document.</p>;
  const para = (m: Match) => (d && m.start.story === 'body' ? (d.para('body', m.start.path) as any) : null);
  return <div role="list" aria-label="Results" className="quill-nav-results">
    <small className="quill-nav-count">{results.length === 1 ? '1 result' : `${results.length} results`}</small>
    {results.slice(0, 500).map((m, i) => {
      const p = para(m);
      const text = String(p?.text ?? '');
      const same = m.start.path.length === m.end.path.length && m.start.path.every((v, k) => v === m.end.path[k]);
      const a = m.start.off, b = same ? m.end.off : text.length;
      const pre = (a > 30 ? text.slice(a - 30, a).replace(/^\S*\s+/, '') : text.slice(0, a)).split(OBJ).join(''), hit = text.slice(a, b).split(OBJ).join(''), post = text.slice(b, Math.min(text.length, b + 40)).split(OBJ).join('');
      return <button key={i} type="button" role="listitem" className="quill-nav-result" onClick={() => onPick(m)}>
        {pre}<mark>{hit}</mark>{post}
      </button>;
    })}
  </div>;
}
