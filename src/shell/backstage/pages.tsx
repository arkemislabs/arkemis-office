// The shell's common backstage pages. Apps override any of them with
// src/apps/<app>/backstage/<pageId>.tsx.
//
// The file pages follow Office and ArtCraft's backstage (wordcraft crates/ui-egui/src/backstage.rs,
// deckcraft crates/ui-egui/src/backstage/files.rs, gridcraft crates/ui-egui/src/backstage.rs at the
// commits named in core/common/commands/file.mjs): Home (New + Recent), New, Open (Recent with
// pinned files, missing files marked, Remove from list; Browse = the system Open dialog; Recover
// Unsaved Documents), Info (the file's name and location, properties), Save As / Save a Copy
// (Browse = the system Save dialog), Export (Change File Type), Print (printer, copies, pages,
// orientation, paper, preview; Print prints through the window's print job).

import {useEffect, useMemo, useState} from 'react';
import {toCommandError} from '../../../core/kernel/errors.mjs';
import {FILE_TYPES, canCreate, saveType} from '../../../core/common/commands/file.mjs';
import type {SpecBackstageNode} from '../../generated/spec-types';
import type {PrinterInfo, RecentFile, UnsavedDocument} from '../../types';
import {useEngine} from '../engine/EngineProvider';
import {useSessionTick} from '../engine/useCommand';
import {Glyph} from '../icons/Icon';
import {SHOW_PENDING} from '../env';
import {studioFiles, useFileBinding} from '../chrome/FileLifecycle';
import type {BackstagePageProps} from './Backstage';
import './files.css';

function useRun() {
  const {controller} = useEngine();
  return (command: string, args: Record<string, unknown> | null = null) => controller.run(command, args).catch(e => { controller.notify(toCommandError(e).message, 'error'); return null; });
}

function Card({title, body, action, onClick, pending, icon}: {title: string; body?: string; action?: string; onClick?: () => void; pending?: boolean; icon?: string}) {
  return <div className={`bs-card${pending ? ' is-pending' : ''}`}>
    {icon ? <span className="bs-card-mark" aria-hidden="true">{icon}</span> : null}
    <div className="bs-card-text"><strong>{title}</strong>{body ? <p>{body}</p> : null}</div>
    {action ? <button type="button" className="gd-button" disabled={pending} onClick={onClick} data-tip={pending ? title : undefined}
      data-tip-desc={pending ? 'Not translated yet' : undefined}>{action}</button> : null}
  </div>;
}

const NOUN: Record<string, string> = {quill: 'Document', grid: 'Workbook', prism: 'Presentation', folio: 'PDF', slate: 'Notebook'};
const typeName = (kind: string, format: string | null | undefined) => (format ? saveType(kind, format)?.label ?? format.toUpperCase() : null);

export function InfoPage({node}: BackstagePageProps) {
  const {controller, session, docId, kind} = useEngine();
  useSessionTick();
  const binding = useFileBinding();
  const run = useRun();
  const doc = session.get(docId);
  const f = doc.file as any;
  const props = (f.properties ?? {}) as Record<string, string>;
  const date = (s?: string) => (s ? new Date(s).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) : '—');
  const children = (node.children ?? []).filter(k => k.label !== 'Item' && controller.backstageShows(k));
  const recover = controller.hasCommand('file.recover') && !!studioFiles();
  return <section className="bs-section">
    <h1>Info</h1>
    <div className="bs-info">
      <div className="bs-info-main">
        <h2 className="bs-doc-title">{binding?.name ?? f.title}</h2>
        <p className="bs-muted bs-path" title={binding?.path ?? undefined}>{binding ? binding.path ?? 'This document has not been saved yet' : `${NOUN[kind] ?? 'Document'}`}</p>
        <div className="bs-cards">
          {children.map(k => <Card key={k.id} title={k.label} pending={!!k.command && !controller.hasCommand(k.command)} action={k.command || k.dialog ? 'Open' : undefined}
            onClick={() => { void controller.activateBackstage(k).catch(e => controller.notify(toCommandError(e).message, 'error')); }}/>)}
          {recover ? <Card title="Manage Document" body="Recover unsaved documents: new documents closed without saving, and work open when the app stopped." action="Recover Unsaved Documents"
            onClick={() => { void run('file.recover'); }}/> : null}
        </div>
      </div>
      <aside className="bs-props" aria-label="Properties">
        <h3>Properties</h3>
        <dl>
          <dt>Title</dt><dd>{props.title || '—'}</dd>
          <dt>Author</dt><dd>{props.author || '—'}</dd>
          <dt>Subject</dt><dd>{props.subject || '—'}</dd>
          {binding ? <><dt>Location</dt><dd>{binding.path ? binding.path.replace(/[\\/][^\\/]*$/, '') : '—'}</dd>
            <dt>File type</dt><dd>{typeName(kind, binding.format) ?? '—'}</dd></> : null}
          <dt>Created</dt><dd>{date(f.createdAt)}</dd>
          <dt>Last modified</dt><dd>{date(f.updatedAt)}</dd>
        </dl>
      </aside>
    </div>
  </section>;
}

/** File › Save As and File › Save a Copy: Browse opens the system Save dialog, with the app's file types. */
function SaveDialogPage({node, mode}: BackstagePageProps & {mode: 'saveAs' | 'copy'}) {
  const {controller, kind} = useEngine();
  const binding = useFileBinding();
  const run = useRun();
  const command = mode === 'copy' ? 'file.saveCopy' : controller.hasCommand('file.saveAs') ? 'file.saveAs' : 'file.save_as';
  const can = controller.hasCommand(command) && !!studioFiles() && kind !== 'slate';
  const folder = binding?.path ? binding.path.replace(/[\\/][^\\/]*$/, '') : null;
  return <section className="bs-section">
    <h1>{node.label}</h1>
    <div className="bs-places" role="list">
      <div className="bs-place is-current" role="listitem">
        <span className="bs-place-text"><strong>This PC</strong><small title={folder ?? undefined}>{folder ?? 'Documents'}</small></span>
      </div>
      <button type="button" className="bs-place" disabled={!can && !SHOW_PENDING} onClick={() => { void run(command); }} data-backstage-action="browse">
        <span className="bs-place-text"><strong>Browse</strong><small>{mode === 'copy' ? 'Save a copy; this file stays open as it is' : 'Choose a folder, a name and a file type'}</small></span>
      </button>
    </div>
  </section>;
}
export const SaveAsPage = (p: BackstagePageProps) => <SaveDialogPage {...p} mode="saveAs"/>;
export const SaveCopyPage = (p: BackstagePageProps) => <SaveDialogPage {...p} mode="copy"/>;

/** File › Export › Change File Type: the formats this app writes; Save As opens the system dialog with that type first. */
export function ExportPage({node}: BackstagePageProps) {
  const {controller, kind} = useEngine();
  const run = useRun();
  const types = FILE_TYPES[kind as keyof typeof FILE_TYPES]?.save ?? [];
  const command = controller.hasCommand('file.saveAs') ? 'file.saveAs' : 'file.save_as';
  const can = controller.hasCommand(command) && !!studioFiles() && kind !== 'slate';
  const [format, setFormat] = useState(types[0]?.format ?? '');
  return <section className="bs-section">
    <h1>{node.label}</h1>
    <h2 className="bs-subhead">Change File Type</h2>
    <div className="bs-export">
      <div className="bs-formats" role="listbox" aria-label="File type">
        {types.map(t => <button key={t.format} type="button" role="option" aria-selected={format === t.format} className={`bs-format${format === t.format ? ' is-active' : ''}`}
          onClick={() => setFormat(t.format)}><span className="bs-format-ext">{t.exts[0].toUpperCase()}</span><span><strong>{t.label}</strong><small>{t.exts.map(e => '*.' + e).join('; ')}</small></span></button>)}
      </div>
      <div className="bs-export-side">
        <p className="bs-muted">{saveType(kind, format)?.bind ? 'The document is saved as the new file.' : 'A copy is saved in this format; the document stays as it is.'}</p>
        <button type="button" className="gd-button gd-primary bs-big" disabled={!can && !SHOW_PENDING} onClick={() => { void run(command, {format}); }}>Save As</button>
      </div>
    </div>
  </section>;
}

/** Recent files (deckcraft recent_list): pinned first, missing files marked, Pin and Remove from list. */
function RecentList({limit, compact = false}: {limit?: number; compact?: boolean}) {
  const {controller, kind} = useEngine();
  const files = studioFiles();
  const run = useRun();
  const [list, setList] = useState<RecentFile[] | null>(null);
  const [q, setQ] = useState('');
  const reload = () => { files?.recent(kind as any).then(setList).catch(() => setList([])); };
  useEffect(reload, [files, kind]);
  if (!files) return null;
  if (!list) return <p className="bs-muted">Loading…</p>;
  if (!list.length) return <p className="bs-muted">{`${NOUN[kind] ?? 'Document'}s you open show up here. Use Browse to find one.`}</p>;
  const shown = list.filter(r => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const groups: [string, RecentFile[]][] = [['Pinned', shown.filter(r => r.pinned)], ['Recent', shown.filter(r => !r.pinned)]];
  const act = (fn: () => Promise<unknown>) => { void fn().then(reload, e => controller.notify(toCommandError(e).message, 'error')); };
  return <div className="bs-recent">
    {!compact ? <label className="bs-recent-search"><Glyph name="search" size={12}/><input aria-label="Search recent files" placeholder="Search" value={q} onChange={e => setQ(e.target.value)}/></label> : null}
    {groups.filter(([, rows]) => rows.length).map(([label, rows]) => <div key={label} className="bs-recent-group">
      <h3>{label}</h3>
      <ul role="list">
        {rows.slice(0, limit).map(r => <li key={r.path} className={`bs-recent-row${r.missing ? ' is-missing' : ''}`} title={r.missing ? `${r.path} — this file can't be found` : r.path}>
          <button type="button" className="bs-recent-open" onClick={() => { void run('file.open', {path: r.path}).then(x => { if (x) controller.closeBackstage(); }); }}>
            <span className="bs-format-ext">{(r.path.split('.').pop() ?? '').toUpperCase().slice(0, 4)}</span>
            <span className="bs-recent-text"><strong>{r.name}</strong><small>{r.folder}</small></span>
            {r.missing ? <em className="bs-recent-missing">(missing)</em> : null}
          </button>
          <button type="button" className={`bs-recent-pin${r.pinned ? ' is-pinned' : ''}`} aria-pressed={r.pinned} aria-label={r.pinned ? `Unpin ${r.name} from list` : `Pin ${r.name} to list`}
            data-tip={r.pinned ? 'Unpin from list' : 'Pin to list'} onClick={() => act(() => files.pin(r.path, !r.pinned))}><Glyph name="pin" size={12}/></button>
          <button type="button" className="bs-recent-remove" aria-label={`Remove ${r.name} from list`} data-tip="Remove from list"
            onClick={() => act(() => files.forget(r.path))}><Glyph name="close" size={11}/></button>
        </li>)}
      </ul>
    </div>)}
  </div>;
}

/** Recover Unsaved Documents: open one (it comes back unsaved) or delete it. */
function UnsavedList() {
  const {controller, kind} = useEngine();
  const files = studioFiles();
  const [list, setList] = useState<UnsavedDocument[] | null>(null);
  const reload = () => { files?.unsaved(kind as any).then(setList).catch(() => setList([])); };
  useEffect(reload, [files, kind]);
  if (!files) return null;
  if (!list) return <p className="bs-muted">Loading…</p>;
  if (!list.length) return <p className="bs-muted">There are no unsaved documents to recover.</p>;
  const why = {library: 'Kept by an earlier version of the app', closed: 'Closed without saving', crash: 'Open when the app stopped'} as const;
  return <ul className="bs-recent bs-unsaved" role="list">
    {list.map(d => <li key={d.doc} className="bs-recent-row">
      <span className="bs-recent-text"><strong>{d.name}</strong><small>{why[d.reason]} · {new Date(d.updatedAt).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})}{d.path ? ` · ${d.path}` : ''}</small></span>
      <button type="button" className="gd-button" onClick={() => { void files.recover(d.doc).then(() => { controller.closeBackstage(); reload(); }, e => controller.notify(toCommandError(e).message, 'error')); }}>Open</button>
      <button type="button" className="gd-button is-quiet" onClick={() => { void files.discardUnsaved(d.doc).then(reload, e => controller.notify(toCommandError(e).message, 'error')); }}>Delete</button>
    </li>)}
  </ul>;
}

export function RecoverPage({node}: BackstagePageProps) {
  return <section className="bs-section"><h1>{node.label === 'Recover' ? 'Recover Unsaved Documents' : node.label}</h1><UnsavedList/></section>;
}

export function OpenPage({node}: BackstagePageProps) {
  const {controller, kind} = useEngine();
  const run = useRun();
  const [place, setPlace] = useState<'recent' | 'recover'>('recent');
  const can = controller.hasCommand('file.open') && !!studioFiles();
  if (!can && !SHOW_PENDING) return <GenericPage node={node} close={() => {}}/>;
  return <section className="bs-section">
    <h1>{node.label}</h1>
    <div className="bs-open">
      <nav className="bs-places" aria-label="Places">
        <button type="button" className={`bs-place${place === 'recent' ? ' is-current' : ''}`} aria-current={place === 'recent' ? 'page' : undefined} onClick={() => setPlace('recent')}>
          <span className="bs-place-text"><strong>Recent</strong></span></button>
        <button type="button" className="bs-place" data-backstage-action="browse" onClick={() => { void run('file.open').then(r => { if (r && (r.result as any)?.opened) controller.closeBackstage(); }); }}>
          <span className="bs-place-text"><strong>Browse</strong><small>{`Open a ${(NOUN[kind] ?? 'document').toLowerCase()} from this PC`}</small></span></button>
        {controller.hasCommand('file.recover') && kind !== 'slate' ? <button type="button" className={`bs-place${place === 'recover' ? ' is-current' : ''}`} onClick={() => setPlace('recover')}>
          <span className="bs-place-text"><strong>Recover Unsaved Documents</strong></span></button> : null}
      </nav>
      <div className="bs-open-list">{place === 'recent' ? <RecentList/> : <UnsavedList/>}</div>
    </div>
  </section>;
}

/** File › Home: New (a blank document) and the recent files, as Office's Home page. */
export function HomePage({node}: BackstagePageProps) {
  const {kind} = useEngine();
  return <section className="bs-section">
    <h1>{node.label === 'Home' ? greeting() : node.label}</h1>
    {canCreate(kind) ? <><h2 className="bs-subhead">New</h2><BlankTile/></> : null}
    <h2 className="bs-subhead">Recent</h2>
    <RecentList limit={12} compact/>
  </section>;
}
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

function BlankTile() {
  const {controller, kind} = useEngine();
  const run = useRun();
  const can = controller.hasCommand('file.new') && canCreate(kind) && !!studioFiles();
  if (!can && !SHOW_PENDING) return null;
  const label = kind === 'grid' ? 'Blank workbook' : kind === 'prism' ? 'Blank Presentation' : 'Blank document';
  return <div className="bs-templates">
    <button type="button" className={`bs-template${can ? '' : ' is-pending'}`} disabled={!can} onClick={() => { void run('file.new'); controller.closeBackstage(); }}>
      <span className={`bs-template-thumb is-${kind}`}/><span>{label}</span></button>
  </div>;
}

export function NewPage({node}: BackstagePageProps) {
  const {kind} = useEngine();
  if (!canCreate(kind)) return <GenericPage node={node} close={() => {}}/>;
  return <section className="bs-section"><h1>{node.label}</h1><BlankTile/></section>;
}

const PAPERS = ['Letter', 'Legal', 'A3', 'A4', 'A5', 'Tabloid'] as const;

/** File › Print: settings beside a preview; Print prints the document with them (file.print). */
export function PrintPage({node}: BackstagePageProps) {
  const {controller, docId} = useEngine();
  const run = useRun();
  const files = studioFiles();
  const binding = useFileBinding();
  const can = controller.hasCommand('file.print') && !!files;
  const [printers, setPrinters] = useState<PrinterInfo[] | null>(null);
  const [printer, setPrinter] = useState('');
  const [copies, setCopies] = useState(1);
  const [range, setRange] = useState<'all' | 'custom'>('all');
  const [pages, setPages] = useState('');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [paper, setPaper] = useState<(typeof PAPERS)[number]>('Letter');
  const [collate, setCollate] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!files) return;
    files.printers().then(list => { setPrinters(list); setPrinter((list.find(p => p.isDefault) ?? list[0])?.name ?? ''); }).catch(() => setPrinters([]));
  }, [files]);
  useEffect(() => {
    let alive = true;
    const render = controller.view?.render;
    if (typeof render === 'function') Promise.resolve(render.call(controller.view, 'page:1', 0.5)).then(url => { if (alive && typeof url === 'string') setPreview(url); }).catch(() => {});
    return () => { alive = false; };
  }, [controller, docId]);
  const settings = useMemo(() => ({...(printer ? {printer} : {}), copies, collate, pages: range === 'custom' && pages.trim() ? pages.trim() : 'all', orientation, paper}),
    [printer, copies, collate, range, pages, orientation, paper]);
  const select = (label: string, value: string, set: (v: string) => void, options: [string, string][], id: string) =>
    <label className="sf"><span className="sf-label">{label}</span><span className="sf-select"><select data-field-id={id} value={value} onChange={e => set(e.target.value)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><Glyph name="chevron-down" size={10}/></span></label>;
  return <section className="bs-section">
    <h1>{node.label}</h1>
    <div className="bs-print">
      <div className="bs-print-settings">
        <div className="bs-print-head">
          <button type="button" className="bs-print-btn" disabled={!can || (range === 'custom' && !pages.trim())} onClick={() => { void run('file.print', settings).then(r => { if (r && (r.result as any)?.printed) controller.closeBackstage(); }); }}>
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M7 9V3.5h10V9M7 17H4.5V10a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v7H17M7 14h10v6.5H7z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>
            <span>Print</span></button>
          <label className="sf"><span className="sf-label">Copies</span><input className="sf-text" data-field-id="copies" type="number" min={1} max={999} value={copies} onChange={e => setCopies(Math.min(999, Math.max(1, Math.floor(Number(e.target.value)) || 1)))}/></label>
        </div>
        <h3 className="bs-print-h">Printer</h3>
        {printers && printers.length ? select('Printer', printer, setPrinter, printers.map(p => [p.name, p.isDefault ? `${p.displayName} (default)` : p.displayName]), 'printer')
          : <p className="bs-muted">{printers ? 'No printers are installed.' : 'Looking for printers…'}</p>}
        <h3 className="bs-print-h">Settings</h3>
        {select('Pages', range, v => setRange(v as 'all' | 'custom'), [['all', 'Print All Pages'], ['custom', 'Custom Print']], 'range')}
        {range === 'custom' ? <label className="sf"><span className="sf-label">Pages</span><input className="sf-text" data-field-id="pages" placeholder="1-3, 5" value={pages} onChange={e => setPages(e.target.value)}/></label> : null}
        {select('Collation', collate ? 'on' : 'off', v => setCollate(v === 'on'), [['on', 'Collated  1,2,3  1,2,3  1,2,3'], ['off', 'Uncollated  1,1,1  2,2,2  3,3,3']], 'collate')}
        {select('Orientation', orientation, v => setOrientation(v as 'portrait' | 'landscape'), [['portrait', 'Portrait Orientation'], ['landscape', 'Landscape Orientation']], 'orientation')}
        {select('Paper', paper, v => setPaper(v as (typeof PAPERS)[number]), PAPERS.map(p => [p, p]), 'paper')}
        {controller.dialogImplemented('dialog.pageSetup') ? <button type="button" className="gd-button is-quiet" onClick={() => controller.openDialog('dialog.pageSetup')}>Page Setup…</button> : null}
      </div>
      <div className="bs-print-preview" aria-label="Print preview">
        <div className={`bs-paper is-${orientation}`}>{preview ? <img src={preview} alt=""/> : <span className="bs-paper-name">{binding?.name ?? ''}</span>}</div>
      </div>
    </div>
  </section>;
}

export function OptionsPage({node}: BackstagePageProps) {
  const {controller} = useEngine();
  const id = node.dialog ?? ['dialog.options', 'dialog.wordOptions', 'dialog.excelOptions', 'dialog.preferences', 'dialog.powerpointOptions'].find(d => controller.dialogSpec(d));
  return <section className="bs-section"><h1>{node.label}</h1>
    <Card title="Options" body="Display, proofing, saving, language and advanced settings." action="Open Options…" pending={!id || !controller.dialogImplemented(id)}
      onClick={() => { if (id) { try { controller.openDialog(id); } catch (e) { controller.notify(toCommandError(e).message, 'error'); } } }}/>
    {controller.dialogImplemented('dialog.customizeRibbon') ? <Card title="Customize Ribbon" body="Choose the tabs, groups and Quick Access Toolbar commands." action="Customize…"
      onClick={() => { void controller.run('tools.customizeRibbon', null); }}/> : null}
  </section>;
}

export function AccountPage({node}: BackstagePageProps) {
  return <section className="bs-section"><h1>{node.label}</h1>
    <div className="bs-about"><img src="./brand/products/suite.svg" alt="" width={44} height={44}/>
      <div><strong>Arkemis Office</strong><p className="bs-muted">Local-first. Your files stay on this PC; no account is needed.</p></div></div>
  </section>;
}

/** Any other page: its actions as cards (pending ones hatched in development builds). */
export function GenericPage({node}: BackstagePageProps) {
  const {controller} = useEngine();
  const kids = (node.children ?? []).filter(k => controller.backstageShows(k) && !(k.label === 'Item' && !k.command && !k.dialog))
    .filter((k, i, all) => all.findIndex(x => x.command === k.command && x.dialog === k.dialog && x.label === k.label) === i);
  const label = (k: SpecBackstageNode) => (k.label === 'Item' ? controller.command(k.command)?.label ?? humanize(k.command ?? k.dialog ?? 'Item') : k.label);
  return <section className="bs-section"><h1>{node.label}</h1>
    {kids.length ? <div className="bs-cards">{kids.map((k, i) => <Card key={`${k.id}-${i}`} title={label(k)} pending={(!!k.command && !controller.hasCommand(k.command)) || (!!k.dialog && !controller.dialogImplemented(k.dialog))}
      action={k.command || k.dialog ? (k.kind === 'section' ? 'Show' : 'Open') : undefined}
      onClick={() => { void controller.activateBackstage(k).catch(e => controller.notify(toCommandError(e).message, 'error')); }}/>)}</div>
      : <p className="bs-muted">Nothing here yet.</p>}
  </section>;
}

/** "file.newFromTemplate" -> "New From Template" (spec children without a label of their own). */
function humanize(id: string): string {
  const last = id.replace(/^dialog\./, '').split('.').pop() ?? id;
  return last.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/(^|\s)\w/g, c => c.toUpperCase());
}
