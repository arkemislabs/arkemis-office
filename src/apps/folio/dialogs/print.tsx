// Print to PDF: the preview. Acrobat's Print dialog shows the page; ours writes the sheets of the Pages to Print and Page Sizing & Handling settings as a PDF, so the preview shows
// the sheet those settings make, with the real pages drawn on it where they will go (core/folio/lib/print-job.mjs sheetPlan, the geometry buildSheets draws), one sheet at a time.

import {useEffect, useState} from 'react';
import {acquire, release, type PdfSource} from '../surface/pdf';
import {Thumb} from '../surface/SidePanel';

type Cell = {page: number | null; rect: [number, number, number, number]};
type Plan = {problem?: string; base64?: string; content?: any; pages?: number; total?: number; sheets?: {size: [number, number]; cells: Cell[]}[]};

const SIDE = 250;

function Preview({preview}: {values: Record<string, unknown>; preview: unknown}) {
  const p = preview as Plan | null;
  const [at, setAt] = useState(0);
  const [source, setSource] = useState<PdfSource | null>(null);
  const base64 = p?.base64 ?? null;
  useEffect(() => {
    if (!base64) { setSource(null); return; }
    const s = acquire(base64);
    setSource(s);
    return () => release(s);
  }, [base64]);
  if (!p) return null;
  if (p.problem || !p.sheets?.length) return <div className="folio-print-preview"><span className="sf-label" role="status">{p.problem ?? 'Nothing to print.'}</span></div>;
  const index = Math.min(at, p.sheets.length - 1);
  const sheet = p.sheets[index];
  const [W, H] = sheet.size;
  const k = SIDE / Math.max(W, H);
  const total = p.total ?? p.sheets.length;
  return <div className="folio-print-preview" style={{display: 'grid', gap: 8, justifyItems: 'center'}}>
    <div role="img" aria-label={`Sheet ${index + 1} of ${total}`} style={{position: 'relative', width: W * k, height: H * k, background: '#fff', boxShadow: '0 1px 5px rgba(0,0,0,.35)', flex: 'none'}}>
      {sheet.cells.map((c, i) => {
        const [x, y, w, h] = c.rect;
        const box = {position: 'absolute' as const, left: x * k, top: y * k, width: w * k, height: h * k};
        if (c.page === null) return <div key={i} style={{...box, border: '1px dashed #bbb'}} title="Blank"/>;
        const page = p.content?.pages?.[c.page];
        return <div key={i} style={{...box, outline: '1px solid rgba(0,0,0,.12)'}}>{page ? <Thumb content={p.content} page={page} source={source} width={Math.max(2, w * k)} height={Math.max(2, h * k)}/> : null}</div>;
      })}
    </div>
    <div style={{display: 'flex', gap: 6, alignItems: 'center', fontSize: 12}}>
      <button type="button" className="sf-button" aria-label="Previous sheet" disabled={index <= 0} onClick={() => setAt(index - 1)}>‹</button>
      <span className="sf-label">Sheet {index + 1} of {total}</span>
      <button type="button" className="sf-button" aria-label="Next sheet" disabled={index >= p.sheets.length - 1} onClick={() => setAt(index + 1)}>›</button>
    </div>
    <span className="sf-label">{p.pages} {p.pages === 1 ? 'page' : 'pages'} to print</span>
  </div>;
}

export default {Preview};
