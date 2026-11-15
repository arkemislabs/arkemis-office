// The Accessibility Checker panel (spec pane `accessibility`; printcraft crates/ui-egui/src/workflows/a11y_ui.rs `panel` at 8f16855): the counts, Check again and the
// report, the comparison with the last check, then each category with its rules: a status icon, the rule name and status; a rule with problems opens its list (a click
// goes to the page, or to the tag); Fix (Language, Title and Tab order), Skip rule and Explain sit on each rule (upstream has them in its right-click menu).
// Reads the last check from the document's view state (a11y.check writes it).

import {useState, type ReactElement} from 'react';
import {Icon} from '../../../shell/icons/Icon';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import './fields.css';
import './accessibility.css';

type Finding = {page: number | null; object: string | null; message: string};
type Result = {rule: string; status: 'passed' | 'failed' | 'manual' | 'skipped'; findings: Finding[]};
type Info = {id: string; category: string; name: string; description: string; explanation: string; manual: boolean};

const CATEGORIES = ['Document', 'Page Content', 'Forms', 'Alternate Text', 'Tables', 'Lists', 'Headings'];
const LABEL = {passed: 'Passed', failed: 'Failed', manual: 'Needs manual check', skipped: 'Skipped'} as const;
const ICON = {passed: 'check-circle-2', failed: 'x-mark', manual: 'circle-help', skipped: 'circle'} as const;
const FIXABLE = ['primary-language', 'title', 'tab-order'];

export default function AccessibilityPane(_: PaneProps): ReactElement {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const doc: any = (() => { try { return session.get(docId); } catch { return null; } })();
  const st = doc?.view?.a11y ?? null;
  const [info, setInfo] = useState<Info[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [explain, setExplain] = useState<string | null>(null);
  if (!info) { void controller.run('a11y.rules', {}, {origin: 'ui'}).then((r: any) => setInfo(r?.result?.rules ?? [])).catch(() => setInfo([])); }
  const run = (command: string, params: Record<string, unknown> = {}) => void controller.run(command, params, {origin: 'ui'}).catch(() => {});
  const toggle = (set: Set<string>, k: string, put: (s: Set<string>) => void) => { const n = new Set(set); if (!n.delete(k)) n.add(k); put(n); };
  const go = (f: Finding) => {
    if (f.object) run('a11y.tags', {open: true});
    if (f.page !== null) run('surface.scroll', {page: f.page + 1});
  };
  const report = st?.report as {results: Result[]} | undefined;
  if (!report) {
    return <div className="ff-pane ax-pane" data-testid="accessibility-pane">
      <div className="ax-empty"><Icon id="accessibility" size={32}/><p>This document hasn't been checked yet.</p>
        <button type="button" className="ff-action" onClick={() => run('a11y.check')}>Check for accessibility</button></div>
    </div>;
  }
  const count = (s: Result['status']) => report.results.filter(r => r.status === s).length;
  const failed = count('failed'), manual = count('manual'), skipped = count('skipped');
  const headline = failed === 0 && manual === 0 && skipped === 0 ? 'No issues found' : failed === 1 ? '1 issue' : failed > 1 ? `${failed} issues` : manual > 0 ? `Needs manual check: ${manual}` : `Skipped: ${skipped}`;
  const prev = st.previous as {results: Result[]} | null;
  return <div className="ff-pane ax-pane" data-testid="accessibility-pane">
    <div className="ff-head"><span className="ff-count" data-testid="ax-headline">{headline}</span><span className="ff-spacer"/>
      <button type="button" className="ff-action" data-tip="Show the accessibility report" onClick={() => run('a11y.report')}><Icon id="file-text" size={16}/>Report</button>
      <button type="button" className="ff-action" onClick={() => run('a11y.check', {rules: st.options?.rules, pages: st.options?.pages ?? undefined})}><Icon id="refresh-cw" size={16}/>Check again</button></div>
    {failed > 0 && manual > 0 ? <small className="ax-note">Needs manual check: {manual}</small> : null}
    <small className="ax-note ax-caution">A passed rule only says that rule found nothing. {manual + skipped > 0 ? `${manual + skipped} rules were not verified (${manual} need a person, ${skipped} skipped).` : ''} The checker cannot say a document is accessible.</small>
    {prev ? <div className="ax-compare" data-testid="ax-compare"><b>Compare</b>
      {(['passed', 'failed', 'manual', 'skipped'] as const).map(s => <div key={s}>{LABEL[s]}: {prev.results.filter(r => r.status === s).length} → {count(s)}</div>)}
      {report.results.map(cur => { const p = prev.results.find(r => r.rule === cur.rule); return p && (p.status !== cur.status || p.findings.length !== cur.findings.length)
        ? <div key={cur.rule}>{info?.find(i => i.id === cur.rule)?.name ?? cur.rule}: {LABEL[p.status]} ({p.findings.length}) → {LABEL[cur.status]} ({cur.findings.length})</div> : null; })}
    </div> : null}
    <div className="ff-list ax-list" role="tree" aria-label="Accessibility Checker results">
      {CATEGORIES.map(c => {
        const rules = report.results.filter(r => info?.find(i => i.id === r.rule)?.category === c);
        const issues = rules.filter(r => r.status === 'failed').length;
        const open = !collapsed.has(c);
        return <div key={c} role="none">
          <div className={`ax-cat${issues ? ' has-issues' : ''}`} role="treeitem" aria-expanded={open} data-category={c} onClick={() => toggle(collapsed, c, setCollapsed)}>
            <Icon id={open ? 'chevron-down' : 'chevron-right'} size={16}/>{c}{issues ? ` (${issues === 1 ? '1 issue' : `${issues} issues`})` : ''}</div>
          {open ? rules.map(r => {
            const i = info?.find(x => x.id === r.rule);
            const isOpen = expanded.has(r.rule);
            return <div key={r.rule} role="none" className="ax-rule-wrap">
              <div className={`ax-rule is-${r.status}`} role="treeitem" aria-expanded={r.findings.length ? isOpen : undefined} data-rule={r.rule} data-status={r.status}
                onClick={() => { if (r.findings.length) toggle(expanded, r.rule, setExpanded); }}>
                <Icon id={ICON[r.status]} size={16}/><span className="ax-name">{i?.name ?? r.rule} - {LABEL[r.status]}</span>
                <span className="ax-actions" onClick={e => e.stopPropagation()}>
                  {FIXABLE.includes(r.rule) && r.status === 'failed' ? <button type="button" className="ff-action" data-tip="Fix" onClick={() => run('a11y.fix', {rule: r.rule})}>Fix</button> : null}
                  {r.status !== 'skipped' ? <button type="button" className="ff-action" data-tip="Skip this rule" onClick={() => run('a11y.skip', {rule: r.rule})}>Skip</button> : null}
                  <button type="button" className="ff-action" data-tip="Explain" onClick={() => setExplain(explain === r.rule ? null : r.rule)}>Explain</button>
                </span>
              </div>
              {explain === r.rule && i ? <div className="ax-explain">{i.explanation}</div> : null}
              {isOpen ? <div className="ax-findings" role="group">{r.findings.map((f, k) => <div key={k} className={`ax-finding${f.page !== null || f.object ? ' is-link' : ''}`}
                data-tip={f.object ? 'Tags' : f.page !== null ? 'Go to the page' : undefined} onClick={() => go(f)}>{f.message}</div>)}</div> : null}
            </div>;
          }) : null}
        </div>;
      })}
    </div>
  </div>;
}
