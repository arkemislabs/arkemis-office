// The Comments pane (Review › Show Comments, New Comment): New Comment, then a card per comment and
// reply in reading order — author, when, Resolved; the text edited in place (one undo step per
// edit); Go to, Reply, Resolve / Reopen, Delete. Reads review.comments, writes through the review
// commands only. Translated from wordcraft crates/ui-egui/src/panes/comments.rs (`comments`,
// `comment_editor`, `commit_comment`, `reply_editor`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {Document} from '../../../../core/quill/model/document.mjs';
import {isQuill2} from '../../../../core/quill/model/content.mjs';
import {addressOf} from '../../../../core/quill/address.mjs';
import {listComments} from '../../../../core/quill/lib/review-comments.mjs';

type Item = {id: number; author: string; date: string; resolved: boolean; parent: number | null; text: string; anchor: string | null};

const when = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : ''; };

// Word's pane reads like a thread: the text is shown, and a click turns it into a box to edit.
const SMALL = {height: 24, padding: '0 9px', fontSize: 12, borderRadius: 7} as const;
const TEXTBOX = {width: '100%', marginTop: 4, minHeight: 0, resize: 'none', fontSize: 13} as const;

export default function CommentsPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [replying, setReplying] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  // What review.comments lists, read straight from the document (a pane reads, it never runs a command per tick).
  const list = useMemo(() => {
    try {
      const doc = (session.get(docId) as any).file.content;
      return isQuill2(doc) ? listComments(new Document(doc), (p: any) => addressOf(doc, p)) as Item[] : [];
    } catch { return []; }
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => controller.run(id, params, {origin: 'dialog'}).catch(fail);
  // Read-only where comments can't change (a protected document), so nothing is typed in vain.
  const editable = (() => { try { return session.state(docId, 'review.editComment', {}).enabled !== false; } catch { return true; } })();
  return <div className="quill-comments-pane" style={{display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0}}>
    <button type="button" className="sf-button" style={{alignSelf: 'flex-start'}} data-pane-action="new-comment" onClick={() => run('review.newComment', {text: ''})}>New Comment</button>
    <hr style={{width: '100%', border: 0, borderTop: '1px solid rgba(255,255,255,.1)', margin: '2px 0'}}/>
    <div role="list" aria-label="Comments" style={{flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6}}>
      {!list.length ? <small style={{color: '#8f9098'}}>There are no comments in this document.</small> : null}
      {list.map(c => <div key={c.id} role="listitem" data-comment-id={c.id}
        style={{border: '1px solid rgba(255,255,255,.12)', borderRadius: 6, padding: 8, marginLeft: c.parent !== null ? 14 : 0, background: 'rgba(255,255,255,.04)', opacity: c.resolved ? 0.6 : 1}}>
        <div style={{display: 'flex', gap: 6, alignItems: 'baseline'}}>
          <b style={{fontSize: 12.5}}>{c.author || 'Author'}</b>
          <small style={{color: '#8f9098'}}>{when(c.date)}</small>
          {c.resolved ? <small style={{color: '#6fcf8a', marginLeft: 'auto'}}>Resolved</small> : null}
        </div>
        {editing === c.id ? <textarea className="sf-textarea" aria-label="Comment text" defaultValue={c.text} autoFocus rows={Math.max(2, c.text.split('\n').length)}
          placeholder="Add a comment" style={TEXTBOX}
          onBlur={e => { const v = e.currentTarget.value; setEditing(null); if (v !== c.text) void run('review.editComment', {id: c.id, text: v}); }}
          onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.value = c.text; e.currentTarget.blur(); } }}/>
          : <div aria-label="Comment text" title={editable ? 'Click to edit' : undefined} onClick={() => editable && setEditing(c.id)}
            style={{marginTop: 3, fontSize: 13, lineHeight: 1.4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', cursor: editable ? 'text' : 'default', color: c.text ? undefined : '#8f9098'}}>{c.text || 'Add a comment'}</div>}
        <div style={{display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6}}>
          <button type="button" className="sf-button" style={SMALL} disabled={!c.anchor} onClick={() => c.anchor && run('caret.set', {pos: c.anchor})}>Go to</button>
          <button type="button" className="sf-button" style={SMALL} onClick={() => setReplying(c.id)}>Reply</button>
          <button type="button" className="sf-button" style={SMALL} onClick={() => run('review.resolveComment', {id: c.id})}>{c.resolved ? 'Reopen' : 'Resolve'}</button>
          <button type="button" className="sf-button" style={SMALL} onClick={() => run('review.deleteComment', {id: c.id})}>Delete</button>
        </div>
        {replying === c.id ? <textarea className="sf-textarea" aria-label="Reply" placeholder="Write a reply" autoFocus rows={2} style={TEXTBOX}
          onKeyDown={e => {
            if (e.key === 'Escape') setReplying(null);
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = e.currentTarget.value.trim(); setReplying(null); if (v) void run('review.reply', {id: c.id, text: v}); }
          }}
          onBlur={e => { const v = e.currentTarget.value.trim(); setReplying(null); if (v) void run('review.reply', {id: c.id, text: v}); }}/> : null}
      </div>)}
    </div>
  </div>;
}
