// A saved version of a page, read-only in the page area (History › Page Versions › a version):
// the page as it was, drawn with the page's own typography and ink, under a banner that names its
// date and author and offers Restore and Back to the current version. Nothing here edits.

import {useMemo} from 'react';
import {DOMSerializer} from '@tiptap/pm/model';
import {nodeOf, schema} from '../../../../core/slate/schema.mjs';
import {ruleDrawing} from '../../../../core/slate/model/styles.mjs';
import {toMathML} from '../../../../core/slate/lib/equation.mjs';
import {InkLayer} from './InkLayer';
import {TITLE_ORIGIN} from './PageCanvas';

const NOOP = () => {};

function Containers({body}: {body: unknown}) {
  const html = useMemo(() => {
    const doc = nodeOf(body);
    const ser = DOMSerializer.fromSchema(schema);
    const host = document.createElement('div');
    doc.forEach((c: any) => {
      const box = document.createElement('div');
      box.className = `slate-container${c.attrs.width ? '' : ' is-auto'}`;
      box.style.left = `${c.attrs.x}px`;
      box.style.top = `${c.attrs.y}px`;
      if (c.attrs.width) box.style.width = `${c.attrs.width}px`;
      const inner = document.createElement('div');
      inner.className = 'slate-container-body';
      inner.append(ser.serializeFragment(c.content));
      for (const eq of inner.querySelectorAll<HTMLElement>('[data-equation]')) { const m = toMathML(eq.dataset.linear ?? ''); if (m) { eq.className = 'slate-equation'; eq.innerHTML = m; } }
      box.append(inner);
      host.append(box);
    });
    return host.innerHTML;
  }, [body]);
  return <div className="slate-editor slate-version-body" dangerouslySetInnerHTML={{__html: html}}/>;
}

export function VersionView({version, hideAuthors, onRestore, onBack}: {version: any; hideAuthors: boolean; onRestore: () => void; onBack: () => void}) {
  const rule = ruleDrawing(version.rule);
  const d = new Date(version.saved);
  const date = Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString(undefined, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})} ${d.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})}`;
  return <div className="slate-version" data-version={version.id}>
    <div className="slate-version-banner" role="status">
      <span>This is a read-only version of the page from <b>{date}</b>{hideAuthors || !version.author ? '' : <> by <b>{version.author}</b></>}.</span>
      <button type="button" onClick={onRestore}>Restore Version</button>
      <button type="button" onClick={onBack}>Back to Current Page</button>
    </div>
    <div className="slate-page-scroll slate-version-scroll">
      <div className={`slate-page${rule ? ` has-rule is-${rule.kind}` : ''}`} style={{background: version.color ?? undefined, minWidth: '100%', minHeight: '100%'}}>
        {version.titleHidden ? null : <div className="slate-title-area" style={{left: TITLE_ORIGIN.x, top: TITLE_ORIGIN.y}}>
          <div className="slate-title" style={{minHeight: 36}}>{version.title}</div>
          <div className="slate-title-rule" aria-hidden="true"/>
        </div>}
        <Containers body={version.body}/>
        <InkLayer strokes={version.ink} tool={null} zoom={1} selected={new Set()} touchDraw ruler={null} replay={null} inkToShape={false}
          onStroke={NOOP} onErase={NOOP} onLasso={NOOP} onPick={NOOP} onMove={NOOP} onShape={NOOP} onRuler={NOOP}/>
      </div>
    </div>
  </div>;
}
