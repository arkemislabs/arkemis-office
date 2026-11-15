// The Accessibility pane (Review › Accessibility › Check Accessibility): the checker's findings for the document as it is now, grouped as Errors,
// Warnings and Tips; a finding jumps to its place (select.range / caret.set) and may offer a fix (the issue's `action`, run there).
//
// Translated from wordcraft crates/ui-egui/src/a11y_pane.rs (`accessibility`, `go_to`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {Document} from '../../../../core/quill/model/document.mjs';
import {checkAccessibility} from '../../../../core/quill/lib/accessibility-check.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';

type Issue = {kind: 'error' | 'warning' | 'tip'; rule?: string; issue: string; fix?: string; pos?: any; select?: any; action?: {label: string; command: string; params?: Record<string, unknown>}};
const GROUPS: [Issue['kind'], string][] = [['error', 'Errors'], ['warning', 'Warnings'], ['tip', 'Tips']];

export default function AccessibilityPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const file = (() => { try { return session.get(docId) as any; } catch { return null; } })();
  const content = file?.file?.content;
  const issues: Issue[] = useMemo(() => { try { return content ? (checkAccessibility(new Document(content)) as Issue[]) : []; } catch { return []; } }, [content]);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const go = async (i: Issue) => {
    try {
      if (i.select) await controller.run('select.range', i.select, {origin: 'bridge-ui'});
      else if (i.pos) await controller.run('caret.set', {pos: i.pos}, {origin: 'bridge-ui'});
    } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  const fix = async (i: Issue) => {
    if (!i.action) return;
    await go(i);
    try { await controller.run(i.action.command, i.action.params ?? {}, {origin: 'bridge-ui'}); } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  if (!issues.length) return <div className="quill-a11y-pane" style={{fontSize: 12.5, color: '#b9bac1'}}>No accessibility issues found.</div>;
  return <div className="quill-a11y-pane" style={{display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, minHeight: 0, overflow: 'auto', height: '100%'}}>
    {GROUPS.map(([kind, title]) => {
      const group = issues.filter(i => i.kind === kind);
      if (!group.length) return null;
      return <section key={kind} aria-label={`${title} (${group.length})`}>
        <button type="button" className="sf-button" aria-expanded={!closed[kind]} onClick={() => setClosed(c => ({...c, [kind]: !c[kind]}))} style={{fontWeight: 600, width: '100%', textAlign: 'left'}}>
          {title} ({group.length})
        </button>
        {closed[kind] ? null : group.map((i, k) => <div key={k} className="sf-list-item" style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '5px 4px'}}>
          <button type="button" onClick={() => void go(i)} style={{background: 'none', border: 0, color: 'inherit', textAlign: 'left', padding: 0, cursor: 'pointer', font: 'inherit'}}>{i.issue}</button>
          {i.fix ? <small style={{color: '#b9bac1'}}>{i.fix}</small> : null}
          {i.action ? <button type="button" className="sf-button" onClick={() => void fix(i)}>{i.action.label}</button> : null}
        </div>)}
      </section>;
    })}
  </div>;
}
