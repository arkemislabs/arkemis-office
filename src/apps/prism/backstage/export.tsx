// File > Export in Prism: Create PDF Document (slides, notes pages or handouts with Slides Per Page, hidden slides or not; the PDF is
// written to the file the person picks in the system Save dialog) and Change File Type (every format Save As writes, PDF included).
// Translated from deckcraft crates/ui-egui/src/backstage/print.rs (the Export page: Create PDF, Create Handouts, Change File Type).

import {useState} from 'react';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {FILE_TYPES, saveType} from '../../../../core/common/commands/file.mjs';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {studioFiles} from '../../../shell/chrome/FileLifecycle';
import type {BackstagePageProps} from '../../../shell/backstage/Backstage';

type Any = any;
const PER_PAGE = [1, 2, 3, 4, 6, 9];

export default function PrismExportPage({node, close}: BackstagePageProps) {
  const {controller, session, docId} = useEngine();
  const run = (command: string, args: Record<string, unknown>) => controller.run(command, args).catch((e: unknown) => { controller.notify(toCommandError(e).message, 'error'); return null; });
  const types = (FILE_TYPES as Any).prism.save as Any[];
  const [what, setWhat] = useState<'slides' | 'notes' | 'handouts'>('slides');
  const [perPage, setPerPage] = useState<number>(() => { try { return (session.get(docId) as Any)?.view?.handoutPerPage ?? 6; } catch { return 6; } });
  const [hidden, setHidden] = useState(false);
  const [format, setFormat] = useState<string>(types[0]?.format ?? 'pptx');
  const canPdf = controller.hasCommand('file.exportPdf') && !!studioFiles();
  const canSave = controller.hasCommand('file.saveAs') && !!studioFiles();
  const createPdf = async () => {
    const r: Any = await run('file.exportPdf', {layout: what, ...(what === 'handouts' ? {perPage} : {}), includeHidden: hidden});
    const out = r?.result ?? r;
    if (out?.path) { controller.notify(`Saved ${out.path}`, 'info'); close(); }
  };
  return <section className="bs-section" data-page="export">
    <h1>{node.label}</h1>
    <h2 className="bs-subhead">Create PDF Document</h2>
    <div className="bs-print-settings" style={{display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 420}}>
      <label style={{display: 'flex', flexDirection: 'column', gap: 4}}>Publish what
        <select value={what} onChange={e => setWhat(e.target.value as typeof what)} data-field-id="layout">
          <option value="slides">Slides</option><option value="notes">Notes Pages</option><option value="handouts">Handouts</option>
        </select></label>
      {what === 'handouts' ? <label style={{display: 'flex', flexDirection: 'column', gap: 4}}>Slides per page
        <select value={perPage} onChange={e => setPerPage(Number(e.target.value))} data-field-id="perPage">
          {PER_PAGE.map(n => <option key={n} value={n}>{n}</option>)}
        </select></label> : null}
      <label style={{display: 'flex', alignItems: 'center', gap: 8}}><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} data-field-id="includeHidden"/>Include hidden slides</label>
      <div><button type="button" className="gd-button gd-primary bs-big" disabled={!canPdf} onClick={() => { void createPdf(); }} data-action="create-pdf">Create PDF</button></div>
    </div>
    <h2 className="bs-subhead">Change File Type</h2>
    <div className="bs-export">
      <div className="bs-formats" role="listbox" aria-label="File type">
        {types.map(t => <button key={t.format} type="button" role="option" aria-selected={format === t.format} className={`bs-format${format === t.format ? ' is-active' : ''}`}
          onClick={() => setFormat(t.format)}><span className="bs-format-ext">{t.exts[0].toUpperCase()}</span><span><strong>{t.label}</strong><small>{t.exts.map((e: string) => '*.' + e).join('; ')}</small></span></button>)}
      </div>
      <div className="bs-export-side">
        <p className="bs-muted">{(saveType('prism', format) as Any)?.bind ? 'The document is saved as the new file.' : 'A copy is saved in this format; the document stays as it is.'}</p>
        <button type="button" className="gd-button gd-primary bs-big" disabled={!canSave} onClick={() => { void run('file.saveAs', {format}); }}>Save As</button>
      </div>
    </div>
  </section>;
}
