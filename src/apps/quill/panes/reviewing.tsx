// The Reviewing Pane (Review › Tracking › Reviewing Pane): the revision summary (how many
// insertions, deletions, moves, formatting changes and comments) and every change and comment in
// document order, each with its author; clicking one selects it in the document. Reads
// review.changes and review.comments; writes nothing but the selection. Translated from wordcraft
// crates/ui-egui/src/ribbon/review.rs:78 (review.changes, the change list `list_changes`) with
// Word's summary line at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {Document} from '../../../../core/quill/model/document.mjs';
import {isQuill2} from '../../../../core/quill/model/content.mjs';
import {addressOf} from '../../../../core/quill/address.mjs';
import {listComments} from '../../../../core/quill/lib/review-comments.mjs';
import {listChanges} from '../../../../core/quill/lib/review-changes.mjs';

type Change = {kind: string; start: string; end: string; text: string; author: string | null; date: string | null; description?: string};
type Comment = {id: number; author: string; text: string; anchor: string | null; parent: number | null};

const KIND: Record<string, string> = {insert: 'Inserted', delete: 'Deleted', format: 'Formatted', moveFrom: 'Moved from', moveTo: 'Moved to'};

export default function ReviewingPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  // What review.changes and review.comments list, read straight from the document.
  const [changes, comments] = useMemo(() => {
    try {
      const doc = (session.get(docId) as any).file.content;
      if (!isQuill2(doc)) return [[], []] as [Change[], Comment[]];
      const d = new Document(doc);
      const addr = (p: any) => addressOf(doc, p);
      return [listChanges({d}, addr) as Change[], listComments(d, addr) as Comment[]] as [Change[], Comment[]];
    } catch { return [[], []] as [Change[], Comment[]]; }
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const count = (k: string) => changes.filter(c => c.kind === k).length;
  const total = changes.length + comments.length;
  const summary = [[count('insert'), 'insertion'], [count('delete'), 'deletion'], [count('moveFrom') + count('moveTo'), 'move'], [count('format'), 'formatting'], [comments.length, 'comment']] as [number, string][];
  return <div className="quill-reviewing-pane" style={{display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0}}>
    <div data-reviewing-summary={total}>
      <b style={{fontSize: 13}}>{total} {total === 1 ? 'revision' : 'revisions'}</b>
      <div style={{color: '#8f9098', fontSize: 11.5, marginTop: 2}}>{summary.map(([n, w]) => `${n} ${w === 'formatting' ? w : n === 1 ? w : `${w}s`}`).join(' · ')}</div>
    </div>
    <hr style={{width: '100%', border: 0, borderTop: '1px solid rgba(255,255,255,.1)', margin: '2px 0'}}/>
    <div role="list" aria-label="Changes" style={{flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4}}>
      {changes.map((c, i) => <button key={`c${i}`} type="button" role="listitem" className="sf-list-item" data-change-kind={c.kind}
        style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, textAlign: 'left'}}
        onClick={() => { void controller.run('select.range', {anchor: c.start, focus: c.end}, {origin: 'dialog'}).catch(fail); }}>
        <span style={{fontSize: 11.5}}><b>{c.author ?? 'Author'}</b> {c.description ?? KIND[c.kind] ?? c.kind}</span>
        {c.text ? <span style={{color: '#c9cad0', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>{c.text.slice(0, 300)}</span> : null}
      </button>)}
      {comments.map(c => <button key={`m${c.id}`} type="button" role="listitem" className="sf-list-item" data-comment-id={c.id}
        style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, textAlign: 'left', marginLeft: c.parent !== null ? 14 : 0}}
        disabled={!c.anchor} onClick={() => { if (c.anchor) void controller.run('caret.set', {pos: c.anchor}, {origin: 'dialog'}).catch(fail); }}>
        <span style={{fontSize: 11.5}}><b>{c.author || 'Author'}</b> {c.parent !== null ? 'Reply' : 'Commented'}</span>
        <span style={{color: '#c9cad0', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>{c.text.slice(0, 300)}</span>
      </button>)}
    </div>
  </div>;
}
