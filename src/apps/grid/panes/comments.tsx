// The Comments pane (Review > Show Comments): the comment threads of the active sheet, each a card with the cell
// (a click selects it), the author, the text, the replies, a Reply box and Resolve or Reopen and Delete.
// Translated from gridcraft crates/ui-egui/src/panes.rs `comments` at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {fromKernelSelection} from '../../../../core/grid/model/workbook.mjs';
import {parseCell} from '../../../../core/grid/lib/addr.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import './comments.css';

type Any = any;

function Card({cell, c, sheet, run}: {cell: string; c: Any; sheet: string; run: (id: string, p?: Record<string, unknown>) => Promise<unknown>}) {
  const [reply, setReply] = useState('');
  const send = () => { if (!reply.trim()) return; void run('review.replyComment', {cell, sheet, text: reply}); setReply(''); };
  return <div className={`gc-card${c.resolved ? ' is-resolved' : ''}`} data-comment={cell}>
    <div className="gc-head">
      <button type="button" className="gc-cell" onClick={() => void run('selection.set', {range: cell, sheet})}>{cell}</button>
      <span className="gc-author">{c.author}</span>
      {c.resolved ? <span className="gc-badge">Resolved</span> : null}
    </div>
    <p className="gc-text">{c.text}</p>
    {(c.replies ?? []).map((r: Any, i: number) => <p key={i} className="gc-reply">{'↳'} {Array.isArray(r) ? `${r[0]}: ${r[1]}` : `${r.author}: ${r.text}`}</p>)}
    <div className="gc-actions">
      <input className="gc-input" value={reply} placeholder="Reply…" aria-label="Reply" onChange={e => setReply(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(); }}/>
      <button type="button" className="sf-button gc-small" onClick={send}>Send</button>
      <button type="button" className="sf-button gc-small" onClick={() => void run('review.resolveComment', {cell, sheet, resolved: !c.resolved})}>{c.resolved ? 'Reopen' : 'Resolve'}</button>
      <button type="button" className="sf-button gc-small" onClick={() => void run('review.deleteComment', {cell, sheet})}>Delete</button>
    </div>
  </div>;
}

export default function CommentsPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const model = useMemo(() => {
    try {
      const d: Any = session.get(docId);
      const content = d.file.content;
      const sheet = content.sheets[fromKernelSelection(content, d.selection).sheet];
      const entries = Object.entries(sheet.comments ?? {}).filter(([k]) => parseCell(k)).sort(([a], [b]) => {
        const x = parseCell(a)!, y = parseCell(b)!;
        return x.row - y.row || x.col - y.col;
      });
      return {sheet: sheet.name as string, entries};
    } catch { return null; }
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, params, {origin: 'ui'}).catch(fail);
  return <div className="gc">
    {!model || !model.entries.length ? <small className="gc-empty">No comments on this sheet yet. Select a cell and choose New Comment.</small>
      : model.entries.map(([cell, c]) => <Card key={`${model.sheet}!${cell}`} cell={cell} c={c} sheet={model.sheet} run={run}/>)}
  </div>;
}
