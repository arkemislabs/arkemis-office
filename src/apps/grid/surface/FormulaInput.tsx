// A formula text field with Excel's reference colouring: the in-cell editor and the formula bar
// share it. The text sits in a transparent textarea over a backdrop that paints each reference in
// its colour (gridcraft crates/ui-egui/src/grid/editor.rs and formula_bar.rs colour the same
// spans from `formula_refs`), with the function autocomplete list under the caret line.
// Upstream: gridcraft at 146161b4b450a56e5e59a083ba0478582d1e602b.

import {useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent} from 'react';
import {SHEET_REF_COLORS} from '../../../../core/grid/lib/editor.mjs';
import type {GridView} from './view';
import {lookupFunction} from '../../../../core/grid/model/index.mjs';

interface Props {
  view: GridView;
  className: string;
  style?: CSSProperties;
  /** The field this is (only one has the caret at a time). */
  where: 'cell' | 'bar';
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  autoFocus?: boolean;
  fontCss?: string;
}

export function FormulaInput({view, className, style, where, onKey, autoFocus, fontCss}: Props) {
  const ed = view.editor!;
  const ref = useRef<HTMLTextAreaElement>(null);
  const refs = view.editorRefs();
  // Backdrop pieces: plain text and coloured references.
  const pieces: {text: string; color?: string}[] = [];
  let at = 0;
  for (const r of refs) {
    if (r.start > at) pieces.push({text: ed.text.slice(at, r.start)});
    pieces.push({text: ed.text.slice(r.start, r.end), color: SHEET_REF_COLORS[r.color]});
    at = r.end;
  }
  pieces.push({text: ed.text.slice(at) + '​'});

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.value !== ed.text) el.value = ed.text;
    const owner = ed.fromFormulaBar ? 'bar' : 'cell';
    if (owner === where && (autoFocus || document.activeElement === el)) {
      if (document.activeElement !== el) el.focus({preventScroll: true});
      if (el.selectionStart !== ed.caret || el.selectionEnd !== ed.caret) el.setSelectionRange(ed.caret, ed.caret);
    }
  });

  const fn = (() => {
    const text = ed.text.slice(0, ed.caret);
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      const c = text[i];
      if (c === ')') depth++;
      else if (c === '(') {
        if (depth === 0) { const m = /([A-Za-z0-9._]+)$/.exec(text.slice(0, i)); return m ? lookupFunction(m[1]) : null; }
        depth--;
      }
    }
    return null;
  })() as any;

  return <div className={`grid-formula-input ${className}`} style={style}>
    <div className="grid-formula-backdrop" aria-hidden="true" style={fontCss ? {font: fontCss} : undefined}>
      {pieces.map((p, i) => (p.color ? <span key={i} style={{color: p.color}}>{p.text}</span> : <span key={i}>{p.text}</span>))}
    </div>
    <textarea
      ref={ref}
      className="grid-formula-text"
      style={fontCss ? {font: fontCss} : undefined}
      spellCheck={false}
      autoComplete="off"
      aria-label={where === 'bar' ? 'Formula Bar' : 'Cell editor'}
      defaultValue={ed.text}
      onFocus={() => { if ((where === 'bar') !== ed.fromFormulaBar && view.editor) { view.editor = {...view.editor, fromFormulaBar: where === 'bar', enterMode: where === 'bar' ? false : view.editor.enterMode}; view.changed(); } }}
      onChange={e => view.setEditText(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
      onSelect={e => { const el = e.currentTarget; if (el.selectionStart === el.selectionEnd && el.selectionStart !== view.editor?.caret) view.setCaret(el.selectionStart); }}
      onKeyDown={onKey}
    />
    {where === (ed.fromFormulaBar ? 'bar' : 'cell') && ed.autocomplete.length ? <ul className="grid-autocomplete" role="listbox" aria-label="Functions">
      {ed.autocomplete.map((n, i) => <li key={n} role="option" aria-selected={i === ed.acIndex} className={i === ed.acIndex ? 'is-on' : ''}
        onMouseDown={e => { e.preventDefault(); view.editor = {...view.editor!, acIndex: i}; view.acceptAutocomplete(); }}>
        <span>{n}</span>
        {i === ed.acIndex ? <small>{(lookupFunction(n) as any)?.description ?? ''}</small> : null}
      </li>)}
    </ul> : where === (ed.fromFormulaBar ? 'bar' : 'cell') && fn?.signature ? <div className="grid-arg-hint" role="tooltip">{fn.signature}</div> : null}
  </div>;
}
