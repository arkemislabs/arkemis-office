// The Thesaurus as Excel shows it for a cell: the word looked up, its meanings and their synonyms, and Replace, which puts the picked synonym in
// the active cell. Lookup runs review.thesaurus with the word typed; Replace is the dialog's OK (review.thesaurus {to}). The word list is built in
// and looked up offline (the same one the other apps' thesauruses use).

import {useEffect, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn} from './dataKit';
import './spelling.css';

type Sense = {word: string; synonyms: string[]};

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (f: string, v: unknown) => void}) {
  const {controller, session, docId} = useEngine();
  const word = String(d.values.word ?? '');
  const senses = (d.values.senses ?? []) as Sense[];
  const picked = String(d.values.picked ?? '');
  const [typed, setTyped] = useState(word);
  useEffect(() => setTyped(word), [word]);
  const look = async (w: string) => {
    try {
      const r: any = await session.execute(docId, 'review.thesaurus', {word: w}, {origin: 'ui'});
      setValue('word', w); setValue('senses', r?.result?.senses ?? []); setValue('picked', '');
    } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  const error = d.errors.find(e => e.field === 'picked')?.message ?? null;
  return <div className="gd-fields thes" data-thesaurus>
    <div className="thes-look">
      <input className="sf-input" aria-label="Looked up" value={typed} onChange={e => setTyped(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void look(typed.trim()); } }}/>
      <Btn onClick={() => void look(typed.trim())}>Look Up</Btn>
    </div>
    <div className="sf-list" role="listbox" aria-label="Synonyms" data-field-id="picked" style={{maxHeight: 220, overflowY: 'auto'}}>
      {senses.length ? senses.map((s, i) => <div key={i}>
        <div className="thes-head">{s.word}</div>
        {s.synonyms.map(x => <div key={x} role="option" aria-selected={picked === x} className={`sf-list-item${picked === x ? ' is-selected' : ''}`} onClick={() => setValue('picked', x)}>{x}</div>)}
      </div>) : <div className="sf-list-empty">{word ? `No synonyms found for "${word}".` : 'Select a cell with a word, or type one above.'}</div>}
    </div>
    {error && picked === '' ? <small className="sf-note">{error}</small> : null}
  </div>;
}

export default {Body};
