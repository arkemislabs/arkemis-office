// The panes of Search, Check Accessibility and Help (U:slate/rest), drawn from `view.pane` beside the page with the same chrome as
// the History panes. Each reads the notebook as it is now (so a fix shows at once) and acts only through commands.
//
//   search         Review > Search, Ctrl+E: the pages that hold the words, in the page, section, group or notebook;
//   accessibility  Review > Check Accessibility: errors, warnings and tips of the page, each to go to (a picture's alternative text is typed here);
//   help           Help, Show Training and What's New: topics, lessons and release notes kept in the app.

import {useState, type ReactNode} from 'react';
import type {ShellController} from '../../../shell/engine/ShellController';
import {currentLocation} from '../../../../core/slate/model/notebook.mjs';
import {searchNotebook, SEARCH_SCOPES} from '../../../../core/slate/lib/search.mjs';
import {checkPage, countByLevel, LEVELS} from '../../../../core/slate/lib/accessibility.mjs';
import {HELP_TOPICS, TRAINING, WHATS_NEW, searchHelp} from '../../../../core/slate/lib/help.mjs';

export interface RestPane { kind: 'search' | 'accessibility' | 'help'; query?: string; scope?: string; page?: string; tab?: string; topic?: string | null }

const SCOPE_LABELS: Record<string, string> = {page: 'This Page', section: 'This Section', group: 'This Section Group', notebook: 'This Notebook'};
const PATHS: Record<string, string> = {
  close: 'M4 4l8 8M12 4l-8 8', search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.4 10.4 14 14', page: 'M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4',
  error: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8',
  warning: 'M8 2.2 14.4 13.4H1.6zM8 6.4v3.2M8 11.2v.4', tip: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 7.2v3.6M8 5v.4',
  book: 'M3 2.5h8a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2zM3 11.5a2 2 0 0 1 2-2h8',
};
function Icon({name}: {name: string}) {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function Shell({title, kind, controller, tools, children}: {title: string; kind: string; controller: ShellController; tools?: ReactNode; children: ReactNode}) {
  return <aside className="slate-pane" aria-label={title} data-pane={kind}>
    <header><h2>{title}</h2><button type="button" className="slate-pane-act" aria-label="Close" title="Close" onClick={() => { void controller.run('history.closePane', {}, {origin: 'ui'}); }}><Icon name="close"/></button></header>
    {tools ? <div className="slate-pane-tools">{tools}</div> : null}
    <div className="slate-pane-body">{children}</div>
  </aside>;
}

export function SearchPane({content, pane, controller, onOpen}: {content: any; pane: RestPane; controller: ShellController; onOpen: (pageId: string) => void}) {
  const loc = currentLocation(content, controller.session.get(controller.docId).selection);
  const scope = SEARCH_SCOPES.includes(pane.scope ?? '') ? pane.scope! : 'notebook';
  const query = pane.query ?? '';
  const [text, setText] = useState(query);
  const [seen, setSeen] = useState(query);
  if (seen !== query) { setSeen(query); setText(query); }
  const result = searchNotebook(content, query, {sectionId: loc.sectionId, pageId: loc.pageId, scope});
  const run = (q: string, s: string) => { void controller.run('search.all', {query: q, scope: s}, {origin: 'ui'}); };
  const tools = <>
    <form className="slate-pane-search" onSubmit={e => { e.preventDefault(); run(text, scope); }}>
      <input type="search" aria-label="Search" placeholder="Search" value={text} onChange={e => setText(e.target.value)} autoFocus={!query}/>
      <button type="submit" className="slate-pane-act" aria-label="Search" title="Search"><Icon name="search"/></button>
    </form>
    <select className="slate-pane-select" aria-label="Search scope" value={scope} onChange={e => run(text || query, e.target.value)}>
      {SEARCH_SCOPES.map((s: string) => <option key={s} value={s}>{SCOPE_LABELS[s]}</option>)}</select>
  </>;
  return <Shell title="Search" kind="search" controller={controller} tools={tools}>
    {!query.trim() ? <p className="slate-pane-empty">Type the words to find, or select them on the page and choose Search.</p>
      : result.results.length ? <div role="list" aria-label="Search results">
        <p className="slate-pane-note">{result.total} {result.total === 1 ? 'page' : 'pages'} for "{result.query}" in {SCOPE_LABELS[scope].toLowerCase()}.{result.total > result.results.length ? ` The first ${result.results.length} are shown.` : ''}</p>
        {result.results.map((r: any) => <button key={r.page} type="button" className="slate-pane-row" data-page={r.page} onClick={() => onOpen(r.page)}>
          <Icon name="page"/><span className="slate-pane-main"><b>{r.title}</b><small>{r.section} · {r.snippet}</small></span></button>)}
      </div> : <p className="slate-pane-empty">Nothing found for "{result.query}" in {SCOPE_LABELS[scope].toLowerCase()}.</p>}
    {result.lockedSkipped ? <p className="slate-pane-note">{result.lockedSkipped} locked {result.lockedSkipped === 1 ? 'section was' : 'sections were'} not searched. Unlock {result.lockedSkipped === 1 ? 'it' : 'them'} to include {result.lockedSkipped === 1 ? 'it' : 'them'}.</p> : null}
  </Shell>;
}

const LEVEL_LABEL: Record<string, [string, string]> = {error: ['Errors', 'error'], warning: ['Warnings', 'warning'], tip: ['Tips', 'tip']};

export function AccessibilityPane({content, pane, controller}: {content: any; pane: RestPane; controller: ShellController}) {
  const pageId = pane.page && content.pages[pane.page] ? pane.page : currentLocation(content, controller.session.get(controller.docId).selection).pageId;
  const page = pageId ? content.pages[pageId] : null;
  const issues: any[] = page ? checkPage(page) : [];
  const counts: Record<string, number> = countByLevel(issues);
  const [open, setOpen] = useState<string | null>(null);
  const [alt, setAlt] = useState('');
  const run = (id: string, params: Record<string, unknown>) => { void controller.run(id, params, {origin: 'ui'}); };
  const keyOf = (i: any) => `${i.rule}|${i.address}`;
  const pick = (i: any) => { setOpen(keyOf(i)); setAlt(''); run('review.accessibilitySelect', {address: i.address}); };
  return <Shell title="Accessibility" kind="accessibility" controller={controller}>
    <p className="slate-pane-note" data-a11y-summary>{issues.length ? `${counts.error} errors, ${counts.warning} warnings, ${counts.tip} tips` : 'No accessibility issues found on this page.'}</p>
    {LEVELS.map((level: string) => {
      const list = issues.filter(i => i.level === level);
      if (!list.length) return null;
      return <section key={level} className="slate-pane-group" data-level={level}>
        <h3><Icon name={LEVEL_LABEL[level][1]}/>{LEVEL_LABEL[level][0]}<span>{list.length}</span></h3>
        {list.map(i => <div key={keyOf(i)} className={`slate-pane-issue${open === keyOf(i) ? ' is-open' : ''}`} data-rule={i.rule}>
          <button type="button" className="slate-pane-row" onClick={() => pick(i)} aria-expanded={open === keyOf(i)}>
            <span className="slate-pane-main"><b>{i.title}</b><small>{i.name}</small></span></button>
          {open === keyOf(i) ? <div className="slate-pane-why">
            <p>{i.message}</p>
            {i.rule === 'missing-alt' ? <form onSubmit={e => { e.preventDefault(); const id = /\/media:(.+)$/.exec(i.address)?.[1]; if (id && alt.trim()) run('review.setAltText', {id: decodeURIComponent(id), page: pageId, alt: alt.trim()}); }}>
              <input aria-label="Alternative text" placeholder="Describe the picture" value={alt} onChange={e => setAlt(e.target.value)}/>
              <button type="submit" className="slate-pane-chip" disabled={!alt.trim()}>Add</button></form> : null}
          </div> : null}
        </div>)}
      </section>;
    })}
  </Shell>;
}

export function HelpPane({pane, controller}: {pane: RestPane; controller: ShellController}) {
  const tab = pane.tab === 'training' || pane.tab === 'new' ? pane.tab : 'topics';
  const [text, setText] = useState(pane.query ?? '');
  const [open, setOpen] = useState<string | null>(pane.topic ?? null);
  const [seen, setSeen] = useState(`${pane.query ?? ''}|${pane.topic ?? ''}`);
  const now = `${pane.query ?? ''}|${pane.topic ?? ''}`;
  if (seen !== now) { setSeen(now); setText(pane.query ?? ''); setOpen(pane.topic ?? null); }
  const run = (id: string, params: Record<string, unknown> = {}) => { void controller.run(id, params, {origin: 'ui'}); };
  const topics = searchHelp(text) as typeof HELP_TOPICS;
  const tabs = <div className="slate-pane-tabs" role="tablist">
    {([['topics', 'Help', 'help.show'], ['training', 'Training', 'help.training'], ['new', "What's New", 'help.whatsNew']] as const).map(([id, label, cmd]) =>
      <button key={id} type="button" role="tab" aria-selected={tab === id} className={`slate-pane-chip${tab === id ? ' is-on' : ''}`} onClick={() => run(cmd)}>{label}</button>)}
  </div>;
  return <Shell title="Help" kind="help" controller={controller} tools={tabs}>
    {tab === 'topics' ? <>
      <form className="slate-pane-search" onSubmit={e => e.preventDefault()}>
        <input type="search" aria-label="Search Help" placeholder="Search Help" value={text} onChange={e => setText(e.target.value)}/>
      </form>
      {topics.length ? topics.map(t => <div key={t.id} className={`slate-pane-topic${open === t.id ? ' is-open' : ''}`} data-topic={t.id}>
        <button type="button" className="slate-pane-row" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}><Icon name="book"/><span className="slate-pane-main"><b>{t.title}</b></span></button>
        {open === t.id ? <div className="slate-pane-why">{t.body.map((p, i) => <p key={i}>{p}</p>)}</div> : null}
      </div>) : <p className="slate-pane-empty">No Help topic has those words.</p>}
    </> : null}
    {tab === 'training' ? TRAINING.map((l: any) => <section key={l.id} className="slate-pane-topic is-open" data-lesson={l.id}>
      <h3 className="slate-pane-lesson">{l.title}<span>{l.minutes} min</span></h3>
      <ol className="slate-pane-steps">{l.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol></section>) : null}
    {tab === 'new' ? WHATS_NEW.map((n: any) => <section key={n.title} className="slate-pane-topic is-open" data-new={n.title}><h3 className="slate-pane-lesson">{n.title}</h3><p className="slate-pane-whynew">{n.body}</p></section>) : null}
  </Shell>;
}
