// Conditional Formatting Rules Manager as Excel lays it out: "Show formatting rules for" (Current Selection,
// This Worksheet, each other sheet), the toolbar (New Rule..., Edit Rule..., Delete Rule, Move Up, Move Down) and
// the list of rules in the order they apply with their Format, the cells each Applies to (editable) and Stop If True.
// Translated from gridcraft crates/ui-egui/src/dialogs/cond_format_rules.rs and crates/engine/src/cmd/insert/cond_format.rs
// (`manage_cf`) at 146161b4b450a56e5e59a083ba0478582d1e602b, completed to Excel's manager.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {Glyph} from '../../../shell/icons/Icon';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {parseRange, intersects, a1} from '../../../../core/grid/lib/addr.mjs';
import {buildRule, describeRule} from '../../../../core/grid/lib/cond-format.mjs';
import {valuesFromRule, specFromValues} from '../../../../core/grid/lib/cond-format-dialog.mjs';
import {iconRow} from '../../../../core/grid/lib/cf-icons.mjs';
import {Btn} from './dataKit';
import {Cell, dxfCss, opts, type SetValue} from './cfKit';

interface Entry { id: string; ranges: string; stopIfTrue: boolean; rule: any; spec?: unknown }

const parseAreas = (text: string) => String(text).split(',').map(x => parseRange(x.trim().replace(/\$/g, ''))).filter(Boolean) as {start: {row: number; col: number}; end: {row: number; col: number}}[];

/** What the rule draws, as the Format column shows it. */
function Sample({rule}: {rule: any}) {
  if (rule?.colorScale) {
    const cols = (rule.colorScale.colors as string[]).map(c => (typeof c === 'string' && c.startsWith('#') ? c : '#ffffff'));
    return <div className="cf-rule-sample" style={{background: `linear-gradient(to right, ${cols.join(', ')})`}}/>;
  }
  if (rule?.dataBar) return <div className="cf-rule-sample" style={{justifyContent: 'start'}}><i style={{display: 'block', height: 12, width: '70%', background: rule.dataBar.color ?? '#638EC6', marginLeft: 3}}/></div>;
  if (rule?.iconSet) {
    const row = iconRow(rule.iconSet.iconSet) as {d: string; fill?: string; stroke?: string; sw?: number}[][];
    return <div className="cf-rule-sample" style={{gap: 2, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
      {row.map((shapes, i) => <svg key={i} viewBox="0 0 16 16" width={12} height={12} aria-hidden="true">
        {shapes.map((s, j) => <path key={j} d={s.d} fill={s.fill ?? 'none'} stroke={s.stroke} strokeWidth={s.sw} strokeLinecap="round" strokeLinejoin="round"/>)}
      </svg>)}
    </div>;
  }
  const css = dxfCss(rule?.dxf);
  return <div className="cf-rule-sample" style={css ?? undefined}>{css ? 'AaBbCcYyZz' : 'No Format Set'}</div>;
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller} = useEngine();
  const v = d.values;
  const sheets = (v.sheets as {id: string; name: string}[]) ?? [];
  const all = (v.rules as Record<string, Entry[]>) ?? {};
  const showFor = String(v.showFor ?? 'selection');
  const sheetId = showFor.startsWith('sheet:') ? showFor.slice(6) : String(v.sheetId);
  const list = all[sheetId] ?? [];
  const sel = parseAreas(String(v.selection ?? ''));
  const shown = showFor === 'selection' ? list.filter(e => parseAreas(e.ranges).some(r => sel.some(s => intersects(r, s)))) : list;
  const selected = Math.min(Number(v.selected ?? 0), Math.max(shown.length - 1, 0));
  const current = shown[selected];
  const write = (next: Entry[]) => setValue('rules', {...all, [sheetId]: next});
  const notify = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const first = (ranges: string) => { const r = parseAreas(ranges)[0]; return r ? a1(r.start.row, r.start.col) : 'A1'; };

  const edit = (entry: Entry | null) => {
    const init = entry ? {...valuesFromRule(entry.rule), range: entry.ranges, editing: true, __title: 'Edit Formatting Rule'} : {range: v.selection, __title: 'New Formatting Rule'};
    controller.collectDialog('dialog.cfNewRule', init as Record<string, unknown>).then(vals => {
      if (!vals) return;
      try {
        const spec = specFromValues(vals as never);
        const ranges = entry ? entry.ranges : String(v.selection);
        const rule = buildRule(spec, first(ranges));
        if (entry) write(list.map(e => (e.id === entry.id ? {...e, rule, spec} : e)));
        else { write([{id: `new-${Date.now().toString(36)}`, ranges, stopIfTrue: false, rule, spec}, ...list]); setValue('selected', 0); }
      } catch (e) { notify(e); }
    }).catch(notify);
  };
  const remove = () => { if (current) { write(list.filter(e => e.id !== current.id)); setValue('selected', Math.max(0, selected - 1)); } };
  const move = (dir: -1 | 1) => {
    if (!current) return;
    const other = shown[selected + dir];
    if (!other) return;
    const next = [...list];
    const i = next.findIndex(e => e.id === current.id), j = next.findIndex(e => e.id === other.id);
    [next[i], next[j]] = [next[j], next[i]];
    write(next);
    setValue('selected', selected + dir);
  };
  const patch = (id: string, change: Partial<Entry>) => write(list.map(e => (e.id === id ? {...e, ...change} : e)));
  const problem = d.errors.find(e => e.field === 'rules')?.message ?? null;

  return <div className="gd-fields cf-manager">
    <div className="cf-manager-top">
      <Cell id="showFor" kind="select" label="Show formatting rules for:" value={showFor} onChange={x => { setValue('showFor', x); setValue('selected', 0); }}
        options={[{value: 'selection', label: 'Current Selection'}, {value: 'sheet', label: 'This Worksheet'}, ...sheets.filter(s => s.id !== v.sheetId).map(s => ({value: `sheet:${s.id}`, label: s.name}))]}/>
    </div>
    <div className="cf-manager-bar">
      <Btn onClick={() => edit(null)}>New Rule…</Btn>
      <Btn onClick={() => edit(current ?? null)} disabled={!current}>Edit Rule…</Btn>
      <Btn onClick={remove} disabled={!current}>Delete Rule</Btn>
      <span className="cf-spacer"/>
      <Btn icon label="Move Up" onClick={() => move(-1)} disabled={!current || selected === 0}><Glyph name="scroll-up" size={12}/></Btn>
      <Btn icon label="Move Down" onClick={() => move(1)} disabled={!current || selected >= shown.length - 1}><Glyph name="scroll-down" size={12}/></Btn>
    </div>
    <div className="cf-rules" role="listbox" aria-label="Rules (applied in order shown)" data-field-id="rules">
      <div className="cf-rule-head" role="presentation"><span>Rule (applied in order shown)</span><span>Format</span><span>Applies to</span><span>Stop If True</span></div>
      {shown.length ? shown.map((e, i) => <div key={e.id} role="option" aria-selected={i === selected} className={`cf-rule${i === selected ? ' is-selected' : ''}`} data-rule={e.id}
        onClick={() => setValue('selected', i)} onDoubleClick={() => edit(e)}>
        <span className="cf-rule-text" title={describeRule(e.rule)}>{describeRule(e.rule)}</span>
        <Sample rule={e.rule}/>
        <input className="cf-rule-applies" aria-label={`Applies to, rule ${i + 1}`} value={e.ranges} onFocus={() => setValue('selected', i)}
          onChange={ev => patch(e.id, {ranges: ev.target.value})}/>
        <span className="cf-rule-stop"><input type="checkbox" aria-label={`Stop If True, rule ${i + 1}`} checked={e.stopIfTrue} onChange={ev => patch(e.id, {stopIfTrue: ev.target.checked})}/></span>
      </div>) : <div className="cf-empty">{showFor === 'selection' ? 'No rules apply to the current selection.' : 'No rules are set on this sheet.'}</div>}
    </div>
    {problem ? <p className="cf-note" role="alert">{problem}</p> : null}
  </div>;
}

export default {Body};
void opts;
