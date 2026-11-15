// The Editor pane (Review › Proofing › Spelling & Grammar, F7; Home › Editor): the misspelt word the check stopped on, in its
// sentence, with Word's choices: the suggestions, Change, Change All, Ignore Once, Ignore All and Add to Dictionary; each one moves on
// to the next word. Reads view.spellingIssue (set by review.spelling) and writes through commands only. Spelling only: the app has no
// grammar engine (core/quill/commands/proofing.mjs).

import {useEffect, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {spelling, sessionKey} from '../../../../core/common/lib/spelling.mjs';

type Issue = {done?: boolean; text?: string; suggestions?: string[]; context?: {before: string; after: string}} | null;

export default function EditorPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const view = (() => { try { return (session.get(docId) as any).view ?? {}; } catch { return {}; } })();
  const issue: Issue = view.spellingIssue ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const word = issue && !issue.done ? issue.text ?? '' : '';
  const suggestions = issue && !issue.done ? issue.suggestions ?? [] : [];
  useEffect(() => { setPicked(suggestions[0] ?? null); }, [word, suggestions.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opened without a word to show (the pane was opened by hand): look for the first one.
  useEffect(() => { if (!issue) void controller.run('review.spelling', {}, {origin: 'ui'}).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const next = (id: string, params: Record<string, unknown> = {}) => async () => {
    setBusy(true);
    try {
      await controller.run(id, params, {origin: 'ui'});
      await controller.run('review.spelling', {}, {origin: 'ui'});
    } catch (e) { controller.notify(toCommandError(e).message, 'error'); } finally { setBusy(false); }
  };
  const recheck = async () => {
    try { await controller.run('review.recheck', {}, {origin: 'ui'}); await controller.run('review.spelling', {}, {origin: 'ui'}); } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };

  return <div className="quill-editor-pane" data-editor-pane style={{display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0}}>
    <b style={{fontSize: 13}}>Spelling</b>
    {!issue ? <small style={{color: '#b9bac1'}}>Checking…</small> : null}
    {issue?.done ? <div data-editor-done style={{display: 'flex', flexDirection: 'column', gap: 8}}>
      <span>Spelling check is complete. No more misspelt words.</span>
      {spelling().hasIgnored(sessionKey((session as any).host, docId)) ? <small style={{color: '#b9bac1'}}>Words you chose to ignore are not marked. Recheck Document brings them back.</small> : null}
      <button type="button" className="sf-button" onClick={recheck}>Recheck Document</button>
    </div> : null}
    {issue && !issue.done ? <>
      <div data-editor-context style={{border: '1px solid #3a3b42', borderRadius: 6, padding: '8px 10px', lineHeight: 1.45, overflowWrap: 'anywhere'}}>
        <span>{issue.context?.before}</span>
        <mark data-editor-word style={{background: 'none', color: '#ff6b6b', textDecoration: 'underline wavy #e02020', textUnderlineOffset: 3}}>{word}</mark>
        <span>{issue.context?.after}</span>
      </div>
      <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
        <button type="button" className="sf-button" disabled={busy} onClick={next('review.ignoreOnce')}>Ignore Once</button>
        <button type="button" className="sf-button" disabled={busy} onClick={next('review.ignoreAll')}>Ignore All</button>
        <button type="button" className="sf-button" disabled={busy} onClick={next('review.addToDictionary')}>Add to Dictionary</button>
      </div>
      <b style={{fontSize: 12.5}}>Suggestions</b>
      {suggestions.length ? <div role="listbox" aria-label="Suggestions" style={{flex: 1, minHeight: 60, overflow: 'auto'}}>
        {suggestions.map(w => <div key={w} role="option" aria-selected={picked === w} data-suggestion={w} className={`sf-list-item${picked === w ? ' is-selected' : ''}`} style={{cursor: 'default'}}
          onClick={() => setPicked(w)} onDoubleClick={() => { setPicked(w); void next('review.applySuggestion', {text: w})(); }}>{w}</div>)}
      </div> : <small style={{color: '#b9bac1'}}>No spelling suggestions.</small>}
      <div style={{display: 'flex', gap: 6}}>
        <button type="button" className="sf-button" disabled={busy || !picked} onClick={next('review.applySuggestion', {text: picked ?? ''})}>Change</button>
        <button type="button" className="sf-button" disabled={busy || !picked} onClick={next('review.changeAll', {text: picked ?? ''})}>Change All</button>
      </div>
      <button type="button" className="sf-button" onClick={recheck} style={{alignSelf: 'flex-start'}}>Recheck Document</button>
    </> : null}
  </div>;
}
