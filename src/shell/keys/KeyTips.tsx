// Keytip badges (docs/architecture.md section 8.6): Alt shows a letter over each tab and the QAT
// (numbers), a tab's letter shows its controls' letters. The letters and the state machine live
// in keytips.ts and ShellController; this layer only draws them over the elements carrying the
// matching data-keytip-id.

import {useLayoutEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {useEngine} from '../engine/EngineProvider';
import {useShellState} from '../engine/useCommand';

interface Badge { id: string; tip: string; x: number; y: number }

export function KeyTips() {
  const {controller} = useEngine();
  const state = useShellState();
  const [badges, setBadges] = useState<Badge[]>([]);
  useLayoutEffect(() => {
    if (state.keytips.phase === 'off') { setBadges([]); return; }
    const place = () => {
      const table = controller.keytipTable();
      const out: Badge[] = [];
      for (const [id, tip] of table) {
        if (!tip.startsWith(state.keytips.typed)) continue;
        const el = document.querySelector<HTMLElement>(`[data-keytip-id="${CSS.escape(id)}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        const large = el.classList.contains('rb-large') || el.classList.contains('rb-split-large') || el.getAttribute('role') === 'tab' || el.classList.contains('sr-file');
        out.push({id, tip, x: large || id.startsWith('#qat:') ? r.left + r.width / 2 : r.left + 14, y: large ? r.bottom - 4 : r.top + r.height / 2 + 9});
      }
      setBadges(out);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [state.keytips, state.tab, state.levels, controller]);
  if (!badges.length) return null;
  return createPortal(<div className="shell-keytips" aria-hidden="true">
    {badges.map(b => <span key={b.id} className="shell-keytip" style={{left: b.x, top: b.y}}>
      <b>{b.tip.slice(0, state.keytips.typed.length)}</b>{b.tip.slice(state.keytips.typed.length)}</span>)}
  </div>, document.body);
}
