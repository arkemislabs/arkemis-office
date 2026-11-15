// Find and Replace drawn as upstream and Word arrange it: tabs Find / Replace / Go To; Find what
// (and Replace with) on their own rows; Match case, Whole words, Use wildcards; ▸ Search Options
// opening Match prefix / suffix, Ignore punctuation / white-space, Regular expressions and the
// Special ▾ menu; the tab's own buttons (Reading Highlight, Replace All, Replace, Find Next;
// Previous, Next / Go To) on the right, the message line under the fields. The values and the
// buttons are core/quill/dialogs/find.mjs, so the bridge (ui.dialog.set / ui.dialog.submit {field})
// and a person drive the same dialog.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`find_dialog`) and dialogs/find.rs
// (`special_menu`, `goto_body`) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {specialItems} from '../../../../core/quill/dialogs/find.mjs';
import './find.css';

const TABS = ['Find', 'Replace', 'Go To'];
const TAB_OF: Record<string, number> = {find: 0, replace: 1, goto: 2};

function Check({id, label, value, disabled, set}: {id: string; label: string; value: unknown; disabled?: boolean; set: (f: string, v: unknown) => void}) {
  return <div className="sf sf-check" data-field-id={id} data-kind="checkbox">
    <label className={disabled ? 'is-disabled' : undefined}>
      <input type="checkbox" checked={value === true} disabled={disabled} onChange={e => set(id, e.target.checked)}/>
      <span className="sf-check-box" aria-hidden="true"/>
      <span>{label}</span>
    </label>
  </div>;
}

function Body({dialog: d, setValue: set}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  const v = d.values;
  const tab = d.tab;
  const [specialOpen, setSpecialOpen] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  // The opener's tab (Home › Replace and Go To… pass {name}; edit.findReplace {tab}).
  useEffect(() => {
    const want = String((d.args as any)?.name ?? (d.args as any)?.tab ?? '');
    if (want in TAB_OF && TAB_OF[want] !== d.tab) controller.setDialogTab(d.key, TAB_OF[want]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (tab < 2) findRef.current?.focus(); }, [tab]);
  // The message line belongs to this dialog and its tab (find_dialog clears it on a tab change):
  // the engine's last status shows only after a button on this tab ran.
  //   (A button pressed over the bridge shows its message too: the status changed since the tab opened.)
  const [spoke, setSpoke] = useState<number | null>(null);
  const [base, setBase] = useState<unknown>(v.status);
  useEffect(() => { setSpoke(s => (s === tab ? s : null)); setBase(v.status); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const press = (id: string) => {
    setSpoke(tab);
    void controller.pressField(d.key, id).catch(e => controller.notify(toCommandError(e).message, 'error'));
  };
  const enter = (id: string) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    press(id);
  };
  const plain = !v.wildcards;
  const message = spoke === tab || v.status !== base ? d.message || (typeof v.status === 'string' ? v.status : '') : '';
  const button = (id: string, label: string, opts: {pressed?: boolean; primary?: boolean} = {}) =>
    <button key={id} type="button" className={`gd-button${opts.primary ? ' gd-primary' : ''}${opts.pressed ? ' is-pressed' : ''}`} data-field-id={id}
      aria-pressed={opts.pressed === undefined ? undefined : opts.pressed} disabled={d.busy} onClick={() => press(id)}>{label}</button>;

  let content: ReactNode;
  if (tab === 2) {
    const page = v.goToWhat !== 'bookmark';
    const pageStep = page && !String(v.pageNumber ?? '').trim();
    const marks = Array.isArray(v.bookmarks) ? v.bookmarks as string[] : [];
    content = <>
      <div className="qf-goto">
        <div className="sf" data-field-id="goToWhat">
          <span className="sf-label">Go to what:</span>
          <div className="sf-list" role="listbox" aria-label="Go to what">
            {[['page', 'Page'], ['bookmark', 'Bookmark']].map(([k, l]) => <div key={k} role="option" aria-selected={(v.goToWhat ?? 'page') === k}
              className={`sf-list-item${(v.goToWhat ?? 'page') === k ? ' is-selected' : ''}`} onClick={() => set('goToWhat', k)}>{l}</div>)}
          </div>
        </div>
        {page ? <div className="sf" data-field-id="pageNumber">
          <label className="sf-label" htmlFor="qf-page">Enter page number:</label>
          <input id="qf-page" className="sf-text" value={String(v.pageNumber ?? '')} autoFocus onChange={e => set('pageNumber', e.target.value)} onKeyDown={enter('goTo')}/>
          <small className="sf-note">Type +2 or -1 to move from the page you are on.</small>
        </div> : <div className="sf" data-field-id="bookmarkName">
          <label className="sf-label" htmlFor="qf-bm">Enter bookmark name:</label>
          <span className="sf-select"><select id="qf-bm" value={String(v.bookmarkName ?? '')} onChange={e => set('bookmarkName', e.target.value || null)} onKeyDown={enter('goTo')}>
            <option value=""/>
            {marks.map(b => <option key={b} value={b}>{b}</option>)}
          </select></span>
          {!marks.length ? <small className="sf-note">This document has no bookmarks.</small> : null}
        </div>}
      </div>
      <div className="qf-message" role="status">{message}</div>
      <div className="qf-buttons">
        {pageStep ? button('previous', 'Previous') : null}
        {button('goTo', pageStep ? 'Next' : 'Go To', {primary: true})}
      </div>
    </>;
  } else {
    const replace = tab === 1;
    const special = specialItems(v);
    content = <>
      <div className="qf-row" data-field-id="findWhat">
        <label className="sf-label" htmlFor="qf-find">Find what:</label>
        <input id="qf-find" ref={findRef} className="sf-text" value={String(v.findWhat ?? '')} onChange={e => set('findWhat', e.target.value)}
          onFocus={() => { if (v.toReplace) set('toReplace', false); }} onKeyDown={enter('findNext')}/>
      </div>
      {replace ? <div className="qf-row" data-field-id="replaceWith">
        <label className="sf-label" htmlFor="qf-replace">Replace with:</label>
        <input id="qf-replace" className="sf-text" value={String(v.replaceWith ?? '')} onChange={e => set('replaceWith', e.target.value)}
          onFocus={() => { if (!v.toReplace) set('toReplace', true); }} onKeyDown={enter('findNext')}/>
      </div> : null}
      <div className="qf-checks">
        <Check id="matchCase" label="Match case" value={v.matchCase} disabled={!plain} set={set}/>
        <Check id="wholeWords" label="Whole words" value={v.wholeWords} disabled={!plain} set={set}/>
        <Check id="wildcards" label="Use wildcards" value={v.wildcards} set={set}/>
      </div>
      <button type="button" className={`qf-more${v.more ? ' is-open' : ''}`} aria-expanded={!!v.more} data-field-id="more" onClick={() => set('more', !v.more)}>
        <span aria-hidden="true">{v.more ? '▾' : '▸'}</span> Search Options
      </button>
      {v.more ? <div className="qf-options">
        <div className="qf-checks">
          <Check id="prefix" label="Match prefix" value={v.prefix} disabled={!plain} set={set}/>
          <Check id="suffix" label="Match suffix" value={v.suffix} disabled={!plain} set={set}/>
        </div>
        <div className="qf-checks">
          <Check id="ignorePunct" label="Ignore punctuation characters" value={v.ignorePunct} disabled={!plain} set={set}/>
          <Check id="ignoreSpace" label="Ignore white-space characters" value={v.ignoreSpace} disabled={!plain} set={set}/>
        </div>
        <div className="qf-checks">
          <Check id="regex" label="Regular expressions" value={v.regex} set={set}/>
          <div className="qf-special" data-field-id="special">
            <button type="button" className="gd-button" aria-haspopup="menu" aria-expanded={specialOpen} onClick={() => setSpecialOpen(o => !o)}>Special ▾</button>
            {specialOpen ? <div className="qf-menu" role="menu">
              {special.map(([name, code]) => <button key={name + code} type="button" role="menuitem" onClick={() => { set('special', code); setSpecialOpen(false); }}>
                <span>{name}</span><kbd>{code}</kbd></button>)}
            </div> : null}
          </div>
        </div>
      </div> : null}
      <div className="qf-message" role="status">{message}</div>
      <div className="qf-buttons">
        {replace ? <>{button('replaceAll', 'Replace All')}{button('replace', 'Replace')}</> : button('readingHighlight', 'Reading Highlight', {pressed: !!v.highlight})}
        {button('findNext', 'Find Next', {primary: true})}
      </div>
    </>;
  }
  return <div className="qf" data-tab={TABS[tab]}>
    <div className="gd-tabs" role="tablist" aria-label="Find and Replace pages">
      {TABS.map((name, i) => <button key={name} type="button" role="tab" aria-selected={i === tab} className={i === tab ? 'is-active' : undefined}
        onClick={() => controller.setDialogTab(d.key, i)}>{name}</button>)}
    </div>
    {content}
  </div>;
}

export default {Body};
