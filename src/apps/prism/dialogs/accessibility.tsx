// The Accessibility Checker as PowerPoint draws it: Inspection Results (Errors, Warnings, Tips, each with its count and
// its issues, "Slide N: issue - name", with Go to) over Additional Information (Why Fix, Fix recommended actions) for
// the chosen issue. The list is deckcraft's review.accessibility (crates/ui-egui/src/dialogs/body.rs
// `dlg_accessibility` at f893f6af7d36a5409fd804e81a34fd895cfefedf); the first issue is chosen when the checker opens.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useState} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import '../panes/review.css';

type Any = any;

/** PowerPoint's Errors, Warnings and Tips, with its Why Fix / How to Fix for each kind of issue. */
const KINDS: {match: RegExp; group: 'Errors' | 'Warnings' | 'Tips'; why: string; how: string}[] = [
  {match: /alternative text/i, group: 'Errors', why: 'Alternative text helps people who cannot see the object understand what it shows.', how: 'Select the object and give it alternative text (Shape Format > Alt Text), or mark it decorative.'},
  {match: /slide title/i, group: 'Errors', why: 'Slide titles let people using a screen reader find and move between slides.', how: 'Give the slide a title in its title placeholder.'},
  {match: /contrast/i, group: 'Warnings', why: 'Text with low contrast against its background is hard to read, especially for people with low vision.', how: 'Change the text colour or the fill behind it so the contrast is at least 3:1.'},
];
const kindOf = (issue: string) => KINDS.find(k => k.match.test(issue)) ?? {group: 'Tips' as const, why: 'This makes the presentation easier to use.', how: 'Review the object and adjust it.'};
const GROUPS = ['Errors', 'Warnings', 'Tips'] as const;
const EMPTY: Record<(typeof GROUPS)[number], string> = {Errors: 'No errors found.', Warnings: 'No warnings found.', Tips: 'No tips.'};

function Body(_: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [items, setItems] = useState<Any[] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve(session.execute(docId, 'review.accessibility', {}, {origin: 'ui'})).then((r: Any) => { if (live) setItems(Array.isArray(r?.result) ? r.result : []); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [session, docId, tick]);
  const [pickedRaw, setPicked] = useState<number | null>(null);
  // The first listed issue is chosen until another is.
  const order = (items ?? []).map((it, i) => ({it, i})).sort((a, b) => GROUPS.indexOf(kindOf(a.it.issue).group) - GROUPS.indexOf(kindOf(b.it.issue).group));
  const picked = pickedRaw !== null && items?.[pickedRaw] ? pickedRaw : order[0]?.i ?? null;
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const goTo = async (it: Any) => {
    try {
      await controller.run('slide.go', {index: it.slide}, {origin: 'ui'});
      if (it.shape !== undefined) await controller.run('edit.select', {ids: [it.shape]}, {origin: 'ui'});
    } catch (e) { fail(e); }
  };
  const info = picked !== null ? kindOf(items![picked].issue) : null;
  return <div className="rvd" data-dialog-page="Accessibility Checker" style={{minWidth: 0, width: '100%'}}>
    <div className="rvd-head">Inspection Results</div>
    <div className="rvd-list" role="list" aria-label="Accessibility issues" style={{maxHeight: 210, minHeight: 150}}>
      {GROUPS.map(g => {
        const rows = (items ?? []).map((it, i) => ({it, i})).filter(x => kindOf(x.it.issue).group === g);
        return <div key={g} role="group" aria-label={g} data-accessibility-group={g}>
          <div className="shell-menu-header" style={{padding: '6px 2px 2px'}}>{g} ({rows.length})</div>
          {rows.length ? rows.map(({it, i}) => <div key={i} className="rvd-row" role="listitem" data-accessibility-issue={i} aria-current={picked === i || undefined}
            style={picked === i ? {outline: '1.5px solid var(--sh-accent, #e8774e)'} : undefined} onClick={() => setPicked(i)}>
            <span>Slide {it.slide + 1}: {it.issue}{it.name ? ' — ' + it.name : ''}</span>
            <button type="button" className="sf-button" onClick={e => { e.stopPropagation(); setPicked(i); void goTo(it); }}>Go to</button>
          </div>) : <div className="rvd-note" style={{padding: '2px 8px 4px'}}>{EMPTY[g]}</div>}
        </div>;
      })}
    </div>
    <div className="rvd-head">Additional Information</div>
    <div className="rvd-info" data-accessibility-fix>
      <strong>Why Fix</strong>
      <p>{info ? info.why : 'Nothing to fix. People with disabilities should not have difficulty reading this presentation.'}</p>
      <strong>Fix recommended actions</strong>
      <p>{info ? info.how : 'Keep adding alternative text to pictures and titles to every slide as you build.'}</p>
    </div>
  </div>;
}

export default {Body};
