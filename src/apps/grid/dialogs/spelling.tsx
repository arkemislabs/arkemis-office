// Spelling as Excel draws it: "Not in Dictionary:" with the text of the cell the check stopped on (the word in red), Suggestions, and the
// buttons Ignore Once, Ignore All, Add to Dictionary, Change, Change All and Undo Last, with the dictionary language underneath.
// Behaviour from gridcraft crates/ui-egui/src/dialogs/spelling.rs (the misspelt word and its cell; Ignore, Add to Dictionary, Change and
// Change All run review.addToDictionary and review.changeSpelling) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. The list is read again from review.spelling after every action; nothing here
// changes a cell except through commands. The box is editable as Excel's is: Change then puts the edited text in the cell.

import {useCallback, useEffect, useRef, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {spelling, sessionKey} from '../../../../core/common/lib/spelling.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Rows} from './dataKit';
import './spelling.css';

type Issue = {sheet: string; cell: string; row: number; col: number; start: number; end: number; word: string; text: string; key: string; wrapped: boolean; suggestions: string[]};

function Body(_: {dialog: DialogState; setValue: (f: string, v: unknown) => void}) {
  const {controller, session, docId} = useEngine();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [edited, setEdited] = useState<string | null>(null);
  // What Undo Last takes back: a change of the cells (Undo), or an Ignore Once, Ignore All or Add to Dictionary.
  const [last, setLast] = useState<{kind: 'change'} | {kind: 'ignoreOnce'; key: string} | {kind: 'ignoreAll' | 'add'; word: string} | null>(null);
  const undoable = last !== null;
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const went = useRef<string | null>(null);
  const fail = useCallback((e: unknown) => controller.notify(toCommandError(e).message, 'error'), [controller]);

  const load = useCallback(async () => {
    try {
      const r: any = await session.execute(docId, 'review.spelling', {}, {origin: 'ui'});
      setIssues(Array.isArray(r?.result?.issues) ? r.result.issues : []);
    } catch (e) { fail(e); setIssues([]); }
  }, [session, docId, fail]);
  useEffect(() => { void load(); }, [load]);

  const current = issues && issues.length ? issues[0] : null;
  useEffect(() => {
    setEdited(null);
    setPick(0);
    setSuggestions(current?.suggestions ?? []);
    if (!current) return;
    // Suggestions the first answer did not carry, then go to the cell.
    if (!current.suggestions.length) void Promise.resolve(session.execute(docId, 'review.spellingSuggest', {word: current.word}, {origin: 'ui'})).then((r: any) => setSuggestions(Array.isArray(r?.result) ? r.result : [])).catch(() => {});
    if (went.current !== current.key) { went.current = current.key; void controller.run('edit.goTo', {reference: `${current.sheet.includes(' ') ? `'${current.sheet}'` : current.sheet}!${current.cell}`}, {origin: 'ui'}).catch(() => {}); }
  }, [current?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (id: string, params: Record<string, unknown>, then?: () => void) => async () => {
    setBusy(true);
    try { await controller.run(id, params, {origin: 'ui'}); then?.(); await load(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const text = edited ?? current?.text ?? '';
  const chosen = suggestions[pick] ?? null;
  const change = (all: boolean) => {
    if (!current) return undefined;
    if (!all && edited !== null && edited !== current.text) return act('range.setValues', {range: current.cell, values: [[edited]]}, () => setLast({kind: 'change'}))();
    return chosen ? act('review.changeSpelling', {cell: current.cell, word: current.word, to: chosen, ...(all ? {all: true} : {start: current.start})}, () => setLast({kind: 'change'}))() : undefined;
  };
  const undo = async () => {
    setBusy(true);
    try {
      if (last?.kind === 'change') await controller.run('edit.undo', {}, {origin: 'ui'});
      else if (last) await controller.run('review.undoSpelling', last.kind === 'ignoreOnce' ? {action: 'ignoreOnce', key: last.key} : {action: last.kind, word: last.word}, {origin: 'ui'});
      setLast(null); went.current = null; await load();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const ignored = spelling().hasIgnored(sessionKey((session as any).host, docId));

  if (issues === null) return <div className="gd-fields"><small>Checking{'…'}</small></div>;
  if (!current) {
    return <div className="gd-fields spell-done" data-spelling-done>
      <p style={{margin: 0}}>The spelling check is complete for the entire sheet.</p>
      {ignored ? <small className="sf-note">Words you chose to ignore are not marked.</small> : null}
      <div className="gd-buttons"><Btn disabled={!undoable || busy} onClick={() => void undo()}>Undo Last</Btn></div>
    </div>;
  }
  const before = text.slice(0, current.start), word = text.slice(current.start, current.end), after = text.slice(current.end);
  const showMarked = edited === null && word === current.word;
  return <div className="gd-fields spell" data-spelling>
    <div className="spell-main">
      <div className="spell-col">
        <span className="sf-label">Not in Dictionary:</span>
        {showMarked
          ? <div className="spell-text" data-spelling-word role="textbox" aria-readonly="true" tabIndex={0}>{before}<span className="spell-bad">{word}</span>{after}</div>
          : <textarea className="spell-text" aria-label="Not in Dictionary" value={text} onChange={e => setEdited(e.target.value)}/>}
        {showMarked ? <button type="button" className="spell-edit" onClick={() => setEdited(current.text)} aria-label="Edit the text">Edit the text</button> : null}
        <span className="sf-label">Suggestions:</span>
        <Rows label="Suggestions" items={suggestions} selected={pick} onPick={setPick} onDouble={i => { setPick(i); void change(false); }} height={104} empty="(No Suggestions)"/>
      </div>
      <div className="gd-buttons spell-buttons" role="group" aria-label="Spelling actions">
        <Btn disabled={busy} onClick={act('review.ignoreOnce', {key: current.key}, () => setLast({kind: 'ignoreOnce', key: current.key}))}>Ignore Once</Btn>
        <Btn disabled={busy} onClick={act('review.ignoreAll', {word: current.word}, () => setLast({kind: 'ignoreAll', word: current.word}))}>Ignore All</Btn>
        <Btn disabled={busy} onClick={act('review.addToDictionary', {word: current.word}, () => setLast({kind: 'add', word: current.word}))}>Add to Dictionary</Btn>
        <span className="spell-gap" aria-hidden="true"/>
        <Btn disabled={busy || (!chosen && edited === null)} onClick={() => void change(false)}>Change</Btn>
        <Btn disabled={busy || !chosen} onClick={() => void change(true)}>Change All</Btn>
        <span className="spell-gap" aria-hidden="true"/>
        <Btn disabled={busy || !undoable} onClick={() => void undo()}>Undo Last</Btn>
      </div>
    </div>
    <div className="spell-foot">
      <label className="spell-lang"><span>Dictionary language:</span>
        <select aria-label="Dictionary language" defaultValue="en-US"><option value="en-US">English (United States)</option></select></label>
      <small className="sf-note">{current.sheet}!{current.cell}{current.wrapped ? ' - continuing from the beginning of the sheet' : ''}</small>
    </div>
  </div>;
}

export default {Body};
