// The expanded All tools view (printcraft crates/ui-egui/src/panels/all_tools_ui.rs at 8f16855): every tool under its
// category with a search field, filling the workspace; choosing a tile opens that tool's panel, Collapse (or Escape)
// goes back to the pages. A tool matches the search by its name or by the name of one of its items (the tile then lists
// the items it matched, two at most); with no query a tool that is not built yet says so.

import {useEffect} from 'react';
import type {RibbonGroup, RibbonTab} from '../../../shell/model';
import {isControl, displayLabel} from '../../../shell/model';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {Icon} from '../../../shell/icons/Icon';
import './tools-chrome.css';

/** catalog.rs TOOL_CATEGORIES: a heading of the expanded view, and the tools filed under it in display order. */
export const TOOL_CATEGORIES: ReadonlyArray<{label: string; groups: readonly string[]}> = [
  {label: 'Create & Edit', groups: ['create', 'edit', 'export', 'combine', 'organize', 'scan', 'compress']},
  {label: 'Review & Compare', groups: ['comment', 'stamp', 'compare', 'measure']},
  {label: 'Forms & Signatures', groups: ['fill_sign', 'form', 'certificate']},
  {label: 'Protect & Standardize', groups: ['protect', 'redact', 'accessibility', 'standards', 'print_production']},
  {label: 'Customize & Automate', groups: ['actions', 'javascript', 'search_index']},
];

/** catalog.rs: the icon tint of each tool family (Acrobat colour-codes them). */
const RED = '#e03e3e', PURPLE = '#8e4ee6', BLUE = '#3a6fe8', GREEN = '#2d9d5b', ORANGE = '#e88a1a', TEAL = '#149ca8', PINK = '#d63b8f';
export const TOOL_HUES: Record<string, string> = {
  export: BLUE, fill_sign: PURPLE, edit: PINK, create: RED, combine: BLUE, organize: GREEN, comment: ORANGE, scan: GREEN, protect: BLUE, redact: RED, compress: RED,
  form: PURPLE, stamp: PURPLE, certificate: TEAL, print_production: PURPLE, measure: PINK, compare: PINK, actions: PURPLE, accessibility: PURPLE, standards: RED,
  search_index: GREEN, javascript: BLUE,
};

/** Items a tile lists when the search found the tool by them. */
const MATCHES_SHOWN = 2;

/** The tool's own name, or the names of the items that match `query` (already trimmed and lower-cased); null when nothing does. */
export function toolMatches(group: RibbonGroup, query: string, labelOf: (c: any) => string, works: (c: any) => boolean = () => true): string[] | null {
  if (!query || group.label.toLowerCase().includes(query)) return [];
  const items: string[] = [];
  const walk = (list: readonly any[]) => {
    for (const c of list) {
      if (!isControl(c)) continue;
      if (!works(c)) continue;
      const label = labelOf(c);
      if (label && label.toLowerCase().includes(query)) items.push(label);
      if (c.items) walk(c.items);
    }
  };
  walk(group.controls);
  return items.length ? [...new Set(items)] : null;
}

export default function AllToolsPage({tab, query, onPick}: {tab: RibbonTab; query: string; onPick: (g: RibbonGroup) => void}) {
  const {controller} = useEngine();
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); void controller.run('view.tools_full', {open: false}, {origin: 'ui'}).catch(() => {}); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [controller]);
  const q = query.trim().toLowerCase();
  const byId = new Map(tab.groups.map(g => [g.id, g] as const));
  let any = false;
  const sections = TOOL_CATEGORIES.map(cat => {
    const found = cat.groups.map(id => byId.get(id)).filter((g): g is RibbonGroup => !!g && controller.groupShows(g))
      .map(g => ({g, items: toolMatches(g, q, displayLabel, c => controller.shows(c))})).filter((x): x is {g: RibbonGroup; items: string[]} => x.items !== null);
    if (found.length) any = true;
    return {cat, found};
  }).filter(s => s.found.length);
  return <div className="fa-alltools-page" role="region" aria-label="All tools" data-count={sections.reduce((n, s) => n + s.found.length, 0)}>
    <div className="fa-alltools-head">
      <h1>All tools</h1>
      <span className="fa-fill"/>
      <button type="button" className="fa-iconbtn" aria-label="Collapse all tools" data-tip="Collapse all tools" data-control-id="alltools.panel.collapse"
        onClick={() => void controller.activate('alltools.panel.collapse').catch(() => {})}><Icon id="minimize-2" size={20}/></button>
    </div>
    <input className="fa-alltools-search" type="search" placeholder="Search tools and commands…" aria-label="Search tools and commands" data-control-id="alltools.panel.search" value={query} autoFocus
      onChange={e => void controller.run('view.tools_search', {query: e.target.value}, {origin: 'ui'}).catch(() => {})}/>
    <div className="fa-alltools-scroll">
      {sections.map(({cat, found}) => <section key={cat.label} aria-label={cat.label}>
        <h2>{cat.label}</h2>
        <div className="fa-alltools-tiles">
          {found.map(({g, items}) => <button key={g.key} type="button" className="fa-alltools-tile" data-group-key={g.key} aria-label={g.label}
            title={items.length ? `${g.label}\n${items.join(' · ')}` : g.label} onClick={() => onPick(g)}>
            <span className="fa-alltools-icon" style={{color: TOOL_HUES[g.id]}}>{g.collapsedIcon ? <Icon id={g.collapsedIcon} size={32}/> : null}</span>
            <span className="fa-alltools-name">{g.label}</span>
            {items.length ? <small>{items.slice(0, MATCHES_SHOWN).join(' · ')}</small> : null}
          </button>)}
        </div>
      </section>)}
      {!any ? <p className="fa-empty">No tools match your search.</p> : null}
    </div>
  </div>;
}
