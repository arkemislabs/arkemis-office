// The Comments panel (spec pane `comments`): the count, search, "Add a comment", the filter
// (type, author, status, colour, check mark) and sort (page, author, date, type, colour), the More
// menu (hide all, summarize, export, import, flatten), and one card per comment with its replies,
// status badge, check mark, lock, reply box and the card menu (Edit, Set status, check mark, Copy
// text, Properties…, Make Current Properties Default, Delete).
//
// Translated from printcraft crates/ui-egui/src/panels/comments_panel.rs (show, card, avatar,
// header_controls) at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt). It reads through comment.list's model
// (core/folio/lib/comment-panel.mjs) and writes through commands only.

import {useMemo, useState, type ReactElement} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {Glyph, Icon} from '../../../shell/icons/Icon';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {commentThreads, initials, SORTS, STATUSES} from '../../../../core/folio/lib/comment-panel.mjs';
import {prettyDate} from '../../../../core/folio/lib/comment-pdf.mjs';
import './comments.css';

type Any = any;
/** Panel glyphs the shell's set lacks (filter, lock), drawn the shell's way: 14 px, 1.3 stroke. */
const PaneGlyph = ({d}: {d: string}) => <svg className="shell-glyph" viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" focusable="false">
  <path d={d} fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round"/></svg>;
const addr = (content: Any, c: Any) => `/pg:${encodeURIComponent(content.pages[c.page].id)}/annot:${encodeURIComponent(c.id)}`;
const css = (c: number[] | null) => (Array.isArray(c) ? `rgb(${c.map(v => Math.round(v * 255)).join(',')})` : 'var(--sh-text-3)');

export default function CommentsPane(_: PaneProps): ReactElement {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const doc: Any = (() => { try { return session.get(docId); } catch { return null; } })();
  const content: Any = doc?.file?.content ?? null;
  const view: Any = doc?.view ?? {};
  const [search, setSearch] = useState('');
  const [add, setAdd] = useState('');
  const [filter, setFilter] = useState<Record<string, string[]>>({});
  const [menu, setMenu] = useState<null | 'more' | 'filter' | string>(null);
  const [editing, setEditing] = useState<{id: string; text: string} | null>(null);
  const [replying, setReplying] = useState<Record<string, string>>({});
  const sort = view.commentSort ?? 'Page';
  const run = (id: string, args: Any = {}) => controller.run(id, args, {origin: 'ui'}).catch((e: Any) => controller.notify(String(e?.message ?? e), 'error'));
  const t = useMemo(() => (content?.pages ? commentThreads(content, {search, filter, sort}) : null), [content, search, filter, sort]);
  if (!content?.pages?.length) return <div className="shell-pane-empty">Open a PDF to see its comments.</div>;
  if (content.folio !== 2) return <div className="shell-pane-empty">Reading comments…</div>;
  const selected = doc?.selection?.ranges?.[0]?.anchor ?? '';
  const allowed = session.state(docId, 'comment.note', {}).enabled;
  const toggle = (k: string, v: string) => setFilter(f => { const cur = new Set(f[k] ?? []); if (cur.has(v)) cur.delete(v); else cur.add(v); return {...f, [k]: [...cur]}; });
  const filtering = Object.values(filter).some(v => v.length);
  let lastHeading: string | null = null;
  return <div className="fc-pane">
    <div className="fc-head">
      <span className="fc-count" data-testid="comment-count">{t?.count ?? 0}{t?.replyCount ? <small> · {t.replyCount} {t.replyCount === 1 ? 'reply' : 'replies'}</small> : null}</span>
      <span className="fc-spacer"/>
      <button type="button" className={`fc-icon${filtering ? ' is-on' : ''}`} aria-label="Filter comments" data-tip="Filter comments" onClick={() => setMenu(menu === 'filter' ? null : 'filter')}><PaneGlyph d="M2.5 3h9L8 7.25v3.5l-2 1v-4.5z"/></button>
      <button type="button" className="fc-icon" aria-label="More options" data-tip="More options" onClick={() => setMenu(menu === 'more' ? null : 'more')}><Glyph name="more" size={14}/></button>
    </div>
    {menu === 'more' ? <div className="fc-menu" role="menu">
      <div className="fc-menu-label">Sort by</div>
      {SORTS.map((s: string) => <button key={s} type="button" role="menuitemradio" aria-checked={sort === s} onClick={() => { void run('comment.list', {open: true, sort: s}); setMenu(null); }}>{s === 'Color' ? 'Colour' : s}</button>)}
      <hr/>
      <button type="button" role="menuitem" onClick={() => { void run('comment.hide_all'); setMenu(null); }}>{view.commentsHidden ? 'Show all comments' : 'Hide all comments'}</button>
      <button type="button" role="menuitem" onClick={() => { controller.openDialog('dialog.summarize-comments'); setMenu(null); }}>Create PDF comment summary…</button>
      <button type="button" role="menuitem" onClick={() => { void run('comment.export'); setMenu(null); }}>Export all to data file…</button>
      <button type="button" role="menuitem" onClick={() => { void run('comment.import'); setMenu(null); }}>Import comments…</button>
      <hr/>
      <button type="button" role="menuitem" disabled={!session.state(docId, 'comment.flatten', {}).enabled} onClick={() => { void run('comment.flatten'); setMenu(null); }}>Flatten comments</button>
    </div> : null}
    {menu === 'filter' && t ? <div className="fc-menu fc-filter" role="menu">
      <div className="fc-menu-label">Type</div>
      {t.types.map((v: string) => <label key={v}><input type="checkbox" checked={!(filter.types ?? []).includes(v)} onChange={() => toggle('types', v)}/>{v}</label>)}
      <div className="fc-menu-label">Author</div>
      {t.authors.map((v: string) => <label key={v || '-'}><input type="checkbox" checked={!(filter.authors ?? []).includes(v)} onChange={() => toggle('authors', v)}/>{v || 'Unknown author'}</label>)}
      <div className="fc-menu-label">Status</div>
      {STATUSES.map((v: string) => <label key={v}><input type="checkbox" checked={!(filter.statuses ?? []).includes(v)} onChange={() => toggle('statuses', v)}/>{v}</label>)}
      <div className="fc-menu-label">Color</div>
      {t.colors.map((v: string) => <label key={v || '-'}><input type="checkbox" checked={!(filter.colors ?? []).includes(v)} onChange={() => toggle('colors', v)}/><i className="fc-swatch" style={{background: v ? `#${v}` : 'transparent'}}/>{v ? `#${v}` : 'No colour'}</label>)}
      <div className="fc-menu-label">Checkmark</div>
      {['Checked', 'Unchecked'].map(v => <label key={v}><input type="checkbox" checked={!(filter.checks ?? []).includes(v)} onChange={() => toggle('checks', v)}/>{v}</label>)}
      {filtering ? <button type="button" onClick={() => setFilter({})}>Show all</button> : null}
    </div> : null}
    <input className="fc-search" type="search" placeholder="Search comments" aria-label="Search comments" value={search} onChange={e => setSearch(e.target.value)}/>
    {allowed ? <input className="fc-add" placeholder="Add a comment" aria-label="Add a comment" value={add} onChange={e => setAdd(e.target.value)}
      onKeyDown={e => {
        if (e.key !== 'Enter' || !add.trim()) return;
        // comments_panel.rs: a sticky note on the current page, near its top-right corner.
        const pi = Math.max(0, content.pages.findIndex((p: Any) => p.id === (view.pageId ?? content.activePageId)));
        const page = content.pages[pi];
        const w = (page.rotation ?? 0) % 180 ? page.height : page.width;
        void run('comment.note', {page: pi + 1, at: [w - 44, 24], text: add.trim()});
        setAdd('');
      }}/> : null}
    {!t?.count ? <div className="fc-empty"><Icon id="message-square-text" size={32}/><p>No comments yet.</p><small>Pick a tool in the quick bar, or type above.</small></div>
      : !t.roots.length ? <div className="fc-empty"><p>No comments match.</p></div> : null}
    <div className="fc-list" role="list">
      {t?.roots.map((r: Any) => {
        const c = r.comment, a = addr(content, c);
        const head = r.heading && r.heading !== lastHeading ? (lastHeading = r.heading) : null;
        const open = menu === c.id;
        const isSel = selected === a;
        return <div key={c.id} role="listitem">
          {head ? <div className="fc-group">{head}</div> : null}
          <article className={`fc-card${isSel ? ' is-selected' : ''}`} data-annotation={a}
            onClick={() => { session.setSelection(docId, {ranges: [{anchor: a, focus: a}], primary: 0}); void run('surface.scroll', {page: c.page + 1}).catch(() => {}); }}>
            <header>
              <span className="fc-avatar" style={{background: css(c.color)}}><Icon id={r.icon} size={16}/></span>
              <span className="fc-who"><b>{c.author || 'Unknown author'}</b><small>{r.kind} · {prettyDate(c.modified) ?? ''}</small></span>
              {r.status !== 'None' ? <span className={`fc-badge is-${r.status.toLowerCase()}`}>{r.status}</span> : null}
              {c.locked ? <span className="fc-lock" aria-label="Locked"><PaneGlyph d="M4 6.5h6v5H4zM5.25 6.5V5a1.75 1.75 0 0 1 3.5 0v1.5"/></span> : null}
              <button type="button" className={`fc-check${r.marked ? ' is-on' : ''}`} aria-label={r.marked ? 'Remove checkmark' : 'Mark with checkmark'} aria-pressed={r.marked}
                onClick={e => { e.stopPropagation(); void run('annot.mark', {annotation: a, marked: !r.marked}); }}><Glyph name="check" size={12}/></button>
              <button type="button" className="fc-icon" aria-label="More" onClick={e => { e.stopPropagation(); setMenu(open ? null : c.id); }}><Glyph name="more" size={13}/></button>
            </header>
            {editing && editing.id === c.id ? <div className="fc-edit" onClick={e => e.stopPropagation()}>
              <textarea value={editing.text} autoFocus onChange={e => setEditing({id: c.id, text: e.target.value})}/>
              <div><button type="button" onClick={() => setEditing(null)}>Cancel</button>
                <button type="button" className="is-primary" onClick={() => { void run('annot.set_contents', {annotation: a, text: editing.text}); setEditing(null); }}>Save</button></div>
            </div> : c.contents ? <p className="fc-text">{c.contents}</p> : null}
            {r.grouped.map((g: Any) => <p key={g.id} className="fc-text fc-replacement">{g.contents}</p>)}
            {r.replies.map((x: Any) => <div key={x.id} className="fc-reply"><span className="fc-avatar is-small">{initials(x.author)}</span>
              <span><b>{x.author || 'Reply'}</b> <small>{prettyDate(x.modified) ?? ''}</small><p>{x.contents}</p></span></div>)}
            {allowed ? <input className="fc-reply-box" placeholder="Add a reply" aria-label="Add a reply" value={replying[c.id] ?? ''} onClick={e => e.stopPropagation()}
              onChange={e => setReplying(m => ({...m, [c.id]: e.target.value}))}
              onKeyDown={e => { const v = (replying[c.id] ?? '').trim(); if (e.key === 'Enter' && v) { void run('annot.reply', {annotation: a, text: v}); setReplying(m => ({...m, [c.id]: ''})); } }}/> : null}
            {open ? <div className="fc-menu fc-card-menu" role="menu" onClick={e => e.stopPropagation()}>
              <button type="button" role="menuitem" disabled={c.locked} onClick={() => { setEditing({id: c.id, text: c.contents ?? ''}); setMenu(null); }}>Edit</button>
              <div className="fc-menu-label">Set status</div>
              {['None', 'Accepted', 'Cancelled', 'Completed', 'Rejected'].map(s => <button key={s} type="button" role="menuitem" onClick={() => { void run('annot.set_status', {annotation: a, status: s}); setMenu(null); }}>{s}</button>)}
              <hr/>
              <button type="button" role="menuitem" onClick={() => { void run('annot.mark', {annotation: a, marked: !r.marked}); setMenu(null); }}>{r.marked ? 'Remove checkmark' : 'Mark with checkmark'}</button>
              <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(c.contents ?? ''); setMenu(null); }}>Copy text</button>
              <button type="button" role="menuitem" onClick={() => { controller.openDialog('dialog.comment-properties', {init: {}}); setMenu(null); }}>Properties…</button>
              <button type="button" role="menuitem" disabled={!c.tool} onClick={() => { void run('comment.properties', {annotation: a, makeDefault: true}); setMenu(null); }}>Make Current Properties Default</button>
              <button type="button" role="menuitem" onClick={() => { void run('annot.lock', {annotation: a, locked: !c.locked}); setMenu(null); }}>{c.locked ? 'Unlock' : 'Lock'}</button>
              <hr/>
              <button type="button" role="menuitem" disabled={c.locked} onClick={() => { void run('annot.delete', {annotation: a}); setMenu(null); }}>Delete</button>
            </div> : null}
          </article>
        </div>;
      })}
    </div>
  </div>;
}
