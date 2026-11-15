// The Tags panel (spec pane `tags`; printcraft crates/ui-egui/src/tools/tags_ui.rs at 8f16855): the document's structure tree, each element by its tag with its
// title and page; a click selects it and goes to its page. The selected tag's properties (type, title, alternate text, actual text, language, a table's summary, a header
// cell's scope) are edited here; Move up and Move down change the reading order, Mark as artifact takes a leaf tag out of the structure. Reads through tags.list and writes
// through tags.set, tags.move and tags.artifact.

import {useMemo, useState, type ReactElement} from 'react';
import {Icon} from '../../../shell/icons/Icon';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {useRead} from './_read';
import './fields.css';
import './accessibility.css';

type Tag = {object: string; parent: string | null; depth: number; kind: string; title: string | null; actualText: string | null; alt: string | null; language: string | null;
  summary: string | null; scope: string | null; page: number | null};
type Node = Tag & {children: Node[]};

function build(list: Tag[]): Node[] {
  const byId = new Map<string, Node>(list.map(t => [t.object, {...t, children: []}]));
  const roots: Node[] = [];
  for (const n of byId.values()) { const p = n.parent ? byId.get(n.parent) : null; (p ? p.children : roots).push(n); }
  return roots;
}

const PROPS: {id: 'type' | 'title' | 'alternate_text' | 'actual_text' | 'language' | 'summary' | 'scope'; label: string; from: (t: Tag) => string | null}[] = [
  {id: 'type', label: 'Type', from: t => t.kind}, {id: 'title', label: 'Title', from: t => t.title}, {id: 'alternate_text', label: 'Alternate text', from: t => t.alt},
  {id: 'actual_text', label: 'Actual text', from: t => t.actualText}, {id: 'language', label: 'Language', from: t => t.language},
  {id: 'summary', label: 'Summary', from: t => t.summary}, {id: 'scope', label: 'Scope', from: t => t.scope}];

/** A drawn icon for the kind of tag, so the tree reads by type (headings, paragraphs, lists, tables, figures, links); other kinds keep the folder or tag. */
const KIND_ICON: Record<string, string> = {Document: 'file-text', Sect: 'folder', Part: 'folder', Art: 'folder', Div: 'layout', P: 'paragraph', Span: 'type', H: 'heading', H1: 'heading', H2: 'heading', H3: 'heading',
  H4: 'heading', H5: 'heading', H6: 'heading', L: 'list', LI: 'list-ordered', Lbl: 'hash', LBody: 'paragraph', Table: 'table', TR: 'columns', TH: 'heading', TD: 'layout', Figure: 'image', Link: 'link',
  Caption: 'type', BlockQuote: 'paragraph', Quote: 'paragraph', Note: 'bookmark'};

function Row({node, depth, sel, pick, all}: {node: Node; depth: number; sel: string | null; pick: (n: Node) => void; all: boolean | null}) {
  const [open, setOpen] = useState(depth < 1);
  const has = node.children.length > 0;
  const shown = all === null ? open : all;
  return <div role="none" className="tg-node">
    <div className={`tg-row${sel === node.object ? ' is-selected' : ''}`} role="treeitem" aria-level={depth + 1} aria-selected={sel === node.object} aria-expanded={has ? shown : undefined} data-tag={node.kind}
      data-object={node.object} style={{paddingLeft: 4 + depth * 16}} onClick={() => { pick(node); if (has) setOpen(!shown); }}>
      <span className="tg-twisty">{has ? <Icon id={shown ? 'chevron-down' : 'chevron-right'} size={16}/> : null}</span>
      <span className="tg-tag"><Icon id={KIND_ICON[node.kind] ?? (has ? 'folder' : 'tag')} size={16}/>{node.kind}</span>
      {node.title || node.alt ? <span className="tg-title" title={node.title ?? node.alt ?? ''}>{node.title ?? node.alt}</span> : <span className="tg-title is-none"/>}
      {node.page !== null ? <span className="tg-page">Page {node.page + 1}</span> : null}
    </div>
    {has && shown ? <div role="group" className="tg-children" style={{marginLeft: 11 + depth * 16}}>{node.children.map(c => <Row key={c.object} node={c} depth={depth + 1} sel={sel} pick={pick} all={all}/>)}</div> : null}
  </div>;
}

export default function TagsPane(_: PaneProps): ReactElement {
  const {data, controller} = useRead<{tags: Tag[]}>('tags.list');
  const list = data?.tags ?? [];
  const tree = useMemo(() => build(list), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [all, setAll] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const current = list.find(t => t.object === selected) ?? null;
  const run = (command: string, params: Record<string, unknown>) => controller.run(command, params, {origin: 'ui'}).then(() => setError(null)).catch((e: any) => setError(String(e?.message ?? e)));
  const go = (page: number) => void controller.run('surface.scroll', {page: page + 1}, {origin: 'ui'}).catch(() => {});
  const pick = (n: Tag) => { setSelected(n.object); setDraft({}); setError(null); if (n.page !== null) go(n.page); };
  const siblings = current ? list.filter(t => t.parent === current.parent) : [];
  const at = current ? siblings.findIndex(t => t.object === current.object) : -1;
  const hasKids = current ? list.some(t => t.parent === current.object) : false;
  const apply = async () => {
    if (!current) return;
    for (const p of PROPS) {
      if (draft[p.id] === undefined || draft[p.id] === (p.from(current) ?? '')) continue;
      try { await controller.run('tags.set', {object: current.object, property: p.id, value: draft[p.id]}, {origin: 'ui'}); setError(null); } catch (e: any) { setError(String(e?.message ?? e)); return; }
    }
    setDraft({});
  };
  const editable = (id: string) => id !== 'summary' || current?.kind === 'Table' ? (id !== 'scope' || current?.kind === 'TH') : false;
  return <div className="ff-pane" data-testid="tags-pane">
    <div className="ff-head"><span className="ff-count">Tags</span><span className="ff-spacer"/>
      <button type="button" className="ff-action" onClick={() => setAll(true)}><Icon id="chevrons-down" size={16}/>Expand all</button>
      <button type="button" className="ff-action" onClick={() => setAll(false)}><Icon id="chevrons-up" size={16}/>Collapse all</button></div>
    <div className="ff-list tg-tree" role="tree" aria-label="Tags">
      {tree.map(t => <Row key={t.object} node={t} depth={0} sel={selected} pick={pick} all={all}/>)}
      {data && !list.length ? <div className="shell-pane-empty">This document has no tags.</div> : null}
    </div>
    {current ? <div className="tg-props" data-testid="tag-properties">
      <div className="ff-head"><span className="ff-count">{current.kind}</span><span className="ff-spacer"/>
        <button type="button" className="ff-action" disabled={at <= 0} data-tip="Move up" onClick={() => void run('tags.move', {object: current.object, anchor: siblings[at - 1].object, placement: 'before'})}><Icon id="move-up" size={16}/>Move up</button>
        <button type="button" className="ff-action" disabled={at < 0 || at >= siblings.length - 1} data-tip="Move down" onClick={() => void run('tags.move', {object: current.object, anchor: siblings[at + 1].object, placement: 'after'})}><Icon id="move-down" size={16}/>Move down</button></div>
      {PROPS.filter(p => editable(p.id)).map(p => <label key={p.id} className="tg-field"><span>{p.label}</span>
        {p.id === 'scope' ? <select value={draft[p.id] ?? current.scope ?? ''} onChange={e => setDraft({...draft, [p.id]: e.target.value})}><option value="">None</option><option>Row</option><option>Column</option><option>Both</option></select>
          : <input type="text" value={draft[p.id] ?? p.from(current) ?? ''} onChange={e => setDraft({...draft, [p.id]: e.target.value})}/>}</label>)}
      {error ? <small className="sf-error" role="alert">{error}</small> : null}
      <div className="ff-foot"><button type="button" className="ff-action" disabled={!Object.keys(draft).length} onClick={() => void apply()}>Apply</button>
        <button type="button" className="ff-action" disabled={hasKids} data-tip="Take this tag's content out of the structure" onClick={() => void run('tags.artifact', {object: current.object}).then(() => setSelected(null))}>Mark as artifact</button></div>
    </div> : null}
  </div>;
}
