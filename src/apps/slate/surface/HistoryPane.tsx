// The History results pane (OneNote's docked Search Results for History; docs/spec/slate.json panes
// recent-edits, find-by-author, recycle-bin; U:slate/history): beside the page, drawn from
// `view.pane` and the notebook itself, so it is always what the notebook holds now.
//
//   recent    Recent Edits: the pages edited in the chosen range, newest first, with the section and when;
//   authors   Find by Author: the pages under the author who last edited them (names hidden by Hide Authors);
//   versions  Page Versions: the saved versions of the page, each to view, restore or delete;
//   recycle   Notebook Recycle Bin: deleted pages, sections and groups for 60 days, each to restore;
//   thesaurus Review > Thesaurus: the meanings and synonyms of a word; a synonym replaces the word at the caret.
//
// Every action is a History command run through the shell (one undo entry, the bridge sees it too).

import {useState, type ReactNode} from 'react';
import type {ShellController} from '../../../shell/engine/ShellController';
import {RANGES, RANGE_LABELS, allPages, byAuthor, historyOn, recentEdits, sectionsInScope, versionsOf} from '../../../../core/slate/lib/history.mjs';
import {RECYCLE_DAYS, binOf} from '../../../../core/slate/lib/pages-recycle.mjs';
import {currentLocation} from '../../../../core/slate/model/notebook.mjs';
import {entryName} from '../../../../core/slate/commands/history.mjs';
import {synonymsOf} from '../../../../core/slate/lib/proofing.mjs';

export interface Pane { kind: 'recent' | 'authors' | 'versions' | 'recycle' | 'thesaurus' | 'spelling'; range?: string; scope?: string; author?: string; page?: string; word?: string }

const LABELS: Record<string, string> = RANGE_LABELS;
const SCOPES: [string, string][] = [['section', 'This Section'], ['group', 'This Section Group'], ['notebook', 'This Notebook']];

const when = (iso: string | null | undefined) => {
  const d = new Date(iso ?? '');
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'})} ${d.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})}`;
};

function Icon({name}: {name: 'page' | 'section' | 'group' | 'close' | 'restore' | 'view' | 'delete' | 'person' | 'search'}) {
  const d: Record<string, string> = {
    page: 'M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4', section: 'M3 3h7l3 3v7H3zM3 6h10', group: 'M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z', close: 'M4 4l8 8M12 4l-8 8',
    restore: 'M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 3v3h3', view: 'M1.5 8s2.3-4.5 6.5-4.5S14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    delete: 'M3.5 4.5h9M6 4.5V3h4v1.5M5 4.5l.5 8h5l.5-8', search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.4 10.4 14 14', person: 'M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.5-2.5 2.6-3.5 5-3.5s4.5 1 5 3.5',
  };
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path d={d[name]} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function HistoryPane({content, pane, view, controller, now, onOpen}: {
  content: any; pane: Pane; view: any; controller: ShellController; now: number; onOpen: (pageId: string) => void;
}) {
  const run = (command: string, params: Record<string, unknown> = {}) => { void controller.run(command, params, {origin: 'ui'}); };
  const loc = currentLocation(content, controller.session.get(controller.docId).selection);
  const hide = view.hideAuthors === true;
  const scopeBox = (command: string, extra: Record<string, unknown>) => <select className="slate-pane-select" aria-label="Search scope" value={pane.scope ?? 'notebook'}
    onChange={e => run(command, {...extra, scope: e.target.value})}>{SCOPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  let title = '', body: ReactNode = null, tools: ReactNode = null;

  const pageRow = (p: {id: string; title: string; sectionName: string; modified: string; modifiedBy: string | null}) => <button key={p.id} type="button" className="slate-pane-row" data-page={p.id} onClick={() => onOpen(p.id)}>
    <Icon name="page"/><span className="slate-pane-main"><b>{p.title || 'Untitled page'}</b><small>{p.sectionName} · {when(p.modified)}{hide || !p.modifiedBy ? '' : ` · ${p.modifiedBy}`}</small></span></button>;

  if (pane.kind === 'recent') {
    const range = pane.range ?? '7d';
    title = `Recent Edits: ${LABELS[range] ?? range}`;
    const ids = sectionsInScope(content, loc.sectionId, pane.scope ?? 'notebook');
    const pages = recentEdits(content, range, now, {sectionIds: ids} as any);
    tools = <>
      <select className="slate-pane-select" aria-label="Range" value={range} onChange={e => run('history.recentEdits', {range: e.target.value, scope: pane.scope ?? 'notebook'})}>
        {RANGES.map((r: string) => <option key={r} value={r}>{LABELS[r]}</option>)}</select>
      {scopeBox('history.recentEdits', {range})}
    </>;
    body = pages.length ? <div role="list">{pages.map(pageRow)}</div> : <p className="slate-pane-empty">No pages were edited in this time.</p>;
  } else if (pane.kind === 'authors') {
    title = 'Find by Author';
    const groups = byAuthor(content, {sectionIds: sectionsInScope(content, loc.sectionId, pane.scope ?? 'notebook'), author: pane.author ?? null} as any);
    tools = scopeBox('history.findByAuthor', pane.author ? {author: pane.author} : {});
    body = groups.length ? <div role="list">{hide
      ? groups.flatMap(g => g.pages).map(pageRow)
      : groups.map(g => <section key={g.author} className="slate-pane-group"><h3><Icon name="person"/>{g.author}<span>{g.pages.length}</span></h3>{g.pages.map(pageRow)}</section>)}</div>
      : <p className="slate-pane-empty">No pages found.</p>;
  } else if (pane.kind === 'versions') {
    title = 'Page Versions';
    const page = content.pages[pane.page ?? loc.pageId ?? ''];
    const list = page ? versionsOf(content, page.id).slice().reverse() : [];
    const viewing = view.versionView?.version ?? null;
    body = !historyOn(content) ? <p className="slate-pane-empty">History is turned off for this notebook, so no versions are saved.</p> : <div role="list">
      <div className={`slate-pane-row is-current${viewing ? '' : ' is-viewing'}`}><Icon name="page"/><span className="slate-pane-main"><b>Current version</b><small>{when(page?.modified)}{hide || !page?.modifiedBy ? '' : ` · ${page.modifiedBy}`}</small></span>
        {viewing ? <button type="button" className="slate-pane-act" title="Back to the current version" aria-label="Back to the current version" onClick={() => run('history.viewVersion', {versionId: null})}><Icon name="restore"/></button> : null}</div>
      {list.length ? list.map((v: any) => <div key={v.id} className={`slate-pane-row${viewing === v.id ? ' is-viewing' : ''}`} data-version={v.id}>
        <Icon name="page"/><span className="slate-pane-main"><b>{when(v.saved)}</b><small>{hide || !v.author ? ' ' : v.author}</small></span>
        <button type="button" className="slate-pane-act" title="View this version" aria-label="View this version" onClick={() => run('history.viewVersion', {versionId: v.id})}><Icon name="view"/></button>
        <button type="button" className="slate-pane-act" title="Restore this version" aria-label="Restore this version" onClick={() => run('history.restoreVersion', {versionId: v.id})}><Icon name="restore"/></button>
        <button type="button" className="slate-pane-act" title="Delete this version" aria-label="Delete this version" onClick={() => run('history.deleteVersion', {versionId: v.id})}><Icon name="delete"/></button>
      </div>) : <p className="slate-pane-empty">This page has no saved versions yet. A version is saved when the page is edited after it has rested for 30 minutes.</p>}
    </div>;
  } else if (pane.kind === 'thesaurus') {
    title = 'Thesaurus';
    const found = synonymsOf(pane.word ?? '');
    tools = <ThesaurusSearch word={pane.word ?? ''} look={word => run('review.thesaurus', {word})}/>;
    body = !found.word ? <p className="slate-pane-empty">Select a word on the page, or type one above.</p>
      : !found.found ? <p className="slate-pane-empty">No synonyms found for "{found.word}".</p>
      : <div>{found.meanings.map(m => <section key={m.head} className="slate-pane-meaning" data-meaning={m.head}><h3>{m.head}</h3>
        <div>{m.synonyms.map((w: string) => <button key={w} type="button" className="slate-pane-chip" title={`Replace the word with ${w}`} onClick={() => run('review.thesaurus', {word: found.word, replace: w})}>{w}</button>)}</div></section>)}</div>;
  } else {
    title = 'Notebook Recycle Bin';
    const bin = binOf(content);
    body = <>
      <p className="slate-pane-note">Deleted pages and sections stay here for {RECYCLE_DAYS} days.</p>
      {bin.length ? <div role="list">{bin.map((e: any) => <div key={e.id} className="slate-pane-row" data-entry={e.id}>
        <Icon name={e.kind === 'page' ? 'page' : e.kind === 'section' ? 'section' : 'group'}/>
        <span className="slate-pane-main"><b>{entryName(e)}</b><small>{e.kind === 'page' ? `from ${e.from?.sectionName ?? 'a section'} · ` : ''}deleted {when(e.deleted)}</small></span>
        <button type="button" className="slate-pane-act" title="Restore" aria-label={`Restore ${entryName(e)}`} onClick={() => run('history.restoreItem', {entryId: e.id})}><Icon name="restore"/></button>
      </div>)}</div> : <p className="slate-pane-empty">The Recycle Bin is empty.</p>}
      {bin.length ? <button type="button" className="slate-pane-empty-bin" onClick={() => run('history.emptyRecycleBin')}><Icon name="delete"/>Empty Recycle Bin</button> : null}
    </>;
  }
  void allPages;
  return <aside className="slate-pane" aria-label={title} data-pane={pane.kind}>
    <header><h2>{title}</h2><button type="button" className="slate-pane-act" aria-label="Close" title="Close" onClick={() => run('history.closePane')}><Icon name="close"/></button></header>
    {tools ? <div className="slate-pane-tools">{tools}</div> : null}
    <div className="slate-pane-body">{body}</div>
  </aside>;
}

function ThesaurusSearch({word, look}: {word: string; look: (word: string) => void}) {
  const [text, setText] = useState(word);
  const [seen, setSeen] = useState(word);
  if (seen !== word) { setSeen(word); setText(word); }
  return <form className="slate-pane-search" onSubmit={e => { e.preventDefault(); if (text.trim()) look(text.trim()); }}>
    <input type="search" aria-label="Look up" placeholder="Look up a word" value={text} onChange={e => setText(e.target.value)}/>
    <button type="submit" className="slate-pane-act" aria-label="Look up" title="Look up"><Icon name="search"/></button>
  </form>;
}
