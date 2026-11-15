// The Thesaurus pane (Review > Thesaurus): look a word up; clicking a synonym puts it in place of the
// selected word while editing text, otherwise looks that synonym up in turn. The word starts as the
// selected word or the word at the caret.
// Translated from deckcraft crates/ui-egui/src/panels/thesaurus.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {textSelection} from '../../../../core/prism/model/doc.mjs';
import {bodyText} from '../../../../core/prism/model/text.mjs';
import {lookup} from '../../../../core/prism/lib/thesaurus.mjs';
import './review.css';

type Any = any;

/** The selected text when it lies in one line, else the word at the caret. */
function wordUnderCaret(content: Any, selection: Any): string {
  const ts = textSelection(content, selection);
  if (!ts) return '';
  const sl = content.slides.find((s: Any) => s.id === ts.slide);
  const body = ts.notes ? sl?.notes : sl ? (function find(list: Any[]): Any { for (const x of list ?? []) { if (x.id === ts.shape) return x.text; const r = x.kind?.children ? find(x.kind.children) : null; if (r) return r; } return null; })(sl.shapes) : null;
  if (!body) return '';
  const text = bodyText(body);
  let [a, b] = [Math.min(ts.anchor, ts.caret), Math.max(ts.anchor, ts.caret)];
  if (a === b) {
    const w = /[\p{L}\p{N}'’-]/u;
    while (a > 0 && w.test(text[a - 1])) a -= 1;
    while (b < text.length && w.test(text[b])) b += 1;
  }
  const word = text.slice(a, b).trim();
  return word.includes('\n') ? '' : word;
}

export default function ThesaurusPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [query, setQuery] = useState('');
  const sel = useMemo(() => {
    try { const d: Any = session.get(docId); return {word: wordUnderCaret(d.file.content, d.selection), editing: !!textSelection(d.file.content, d.selection)}; } catch { return {word: '', editing: false}; }
  }, [session, docId, tick]);
  // Selecting a word on the slide looks it up.
  useEffect(() => { if (sel.word) setQuery(sel.word); }, [sel.word]);
  const senses: Any[] = query.trim() ? lookup(query) : [];
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  return <div className="rv">
    <input className="rv-input rv-search" value={query} placeholder="Search for a word" aria-label="Search for a word" onChange={e => setQuery(e.target.value)}/>
    {!query.trim() ? <small className="rv-empty">Select a word on the slide, or type one above.</small>
      : !senses.length ? <small className="rv-empty">No synonyms for “{query.trim()}”.</small>
        : senses.map((s, i) => <section key={i} className="rv-sense">
          <h4>{s.word}</h4>
          {s.synonyms.map((syn: string) => <button key={syn} type="button" className="rv-syn" title={sel.editing ? 'Insert' : 'Look up'} data-synonym={syn}
            onClick={() => { if (sel.editing) void controller.run('review.replaceWord', {with: syn}, {origin: 'ui'}).catch(fail); setQuery(syn); }}>{syn}</button>)}
        </section>)}
  </div>;
}
