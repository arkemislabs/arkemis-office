// New Formatting Rule as Excel lays it out: "Select a Rule Type" (six types) over "Edit the Rule Description",
// which changes with the type: Format Style (2- and 3-color scales with Minimum / Midpoint / Maximum type, value
// and color; data bars; icon sets with each icon's rule), the cell tests, top or bottom ranked values, above or
// below average, unique or duplicate values and a formula; then the format's preview and Format....
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (`cond_format` fields) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, completed to Excel's dialog. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {iconShapes} from '../../../../core/grid/lib/cf-icons.mjs';
import {
  RULE_TYPES, FORMAT_STYLES, VALUE_TYPES, ICON_VALUE_TYPES, CELL_KINDS, OPERATORS, TEXT_OPS, AVERAGES, TIME_PERIODS, ICON_SETS,
} from '../../../../core/grid/lib/cond-format-dialog.mjs';
import {iconCount} from '../../../../core/grid/lib/cf-icons.mjs';
import {Rows} from './dataKit';
import {F, Cell, FormatBox, ScaleBar, opts, type SetValue} from './cfKit';

const VALUE_OPTS = opts(VALUE_TYPES);

function IconPic({set, index, size = 16}: {set: string; index: number; size?: number}) {
  const shapes = iconShapes(set, index) as {d: string; fill?: string; stroke?: string; sw?: number}[];
  return <svg className="cf-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
    {shapes.map((s, i) => <path key={i} d={s.d} fill={s.fill ?? 'none'} stroke={s.stroke} strokeWidth={s.sw} strokeLinecap="round" strokeLinejoin="round"/>)}
  </svg>;
}

function ScaleDescription({d, set}: {d: DialogState; set: SetValue}) {
  const v = d.values;
  const style = String(v.formatStyle);
  const three = style === '3color';
  return <>
    <div className="cf-row">
      <F d={d} set={set} id="formatStyle" kind="select" label="Format Style:" options={opts(FORMAT_STYLES)}/>
    </div>
    {style === '2color' || three ? <>
      <div className={three ? 'cf-three' : 'cf-two'}>
        <span/>
        <span className="cf-head">Minimum</span>{three ? <span className="cf-head">Midpoint</span> : null}<span className="cf-head">Maximum</span>
      </div>
      {(['Type', 'Value', 'Color'] as const).map(row => <div key={row} className={three ? 'cf-three' : 'cf-two'}>
        <span className="cf-rowlabel">{row}:</span>
        {(['min', 'mid', 'max'] as const).filter(p => three || p !== 'mid').map(p => {
          const type = String(v[`${p}Type`]);
          if (row === 'Type') return <F key={p} d={d} set={set} id={`${p}Type`} kind="select" options={VALUE_OPTS}/>;
          if (row === 'Value') return <F key={p} d={d} set={set} id={`${p}Value`} kind="text" disabled={type === 'min' || type === 'max'}/>;
          return <F key={p} d={d} set={set} id={`${p}Color`} kind="color"/>;
        })}
      </div>)}
      <ScaleBar colors={three ? [String(v.minColor), String(v.midColor), String(v.maxColor)] : [String(v.minColor), String(v.maxColor)]}/>
    </> : null}
    {style === 'dataBar' ? <>
      <div className="cf-two">
        <span/><span className="cf-head">Minimum</span><span className="cf-head">Maximum</span>
        <span className="cf-rowlabel">Type:</span>
        <F d={d} set={set} id="barMinType" kind="select" options={VALUE_OPTS}/><F d={d} set={set} id="barMaxType" kind="select" options={VALUE_OPTS}/>
        <span className="cf-rowlabel">Value:</span>
        <F d={d} set={set} id="barMinValue" kind="text" disabled={v.barMinType === 'min' || v.barMinType === 'max'}/>
        <F d={d} set={set} id="barMaxValue" kind="text" disabled={v.barMaxType === 'min' || v.barMaxType === 'max'}/>
      </div>
      <p className="cf-desc-title">Bar Appearance:</p>
      <div className="cf-row">
        <F d={d} set={set} id="barFill" kind="select" label="Fill" options={opts([['gradient', 'Gradient Fill'], ['solid', 'Solid Fill']])}/>
        <F d={d} set={set} id="barColor" kind="color" label="Color"/>
      </div>
      <F d={d} set={set} id="barOnly" kind="checkbox" label="Show Bar Only"/>
      <div className="cf-bar-preview" data-field-id="preview" role="img" aria-label="Data bar preview">
        <i style={{background: v.barFill === 'solid' ? String(v.barColor) : `linear-gradient(to right, ${String(v.barColor)}, ${String(v.barColor)}33)`}}/>
      </div>
    </> : null}
    {style === 'iconSet' ? <IconDescription d={d} set={set}/> : null}
  </>;
}

function IconDescription({d, set}: {d: DialogState; set: SetValue}) {
  const v = d.values;
  const name = String(v.iconSet);
  const k = iconCount(name);
  const rules = (v.iconRules as {type: string; value: string; gte: boolean}[]) ?? [];
  const change = (i: number, patch: Partial<{type: string; value: string; gte: boolean}>) => set('iconRules', rules.map((r, j) => (j === i ? {...r, ...patch} : r)));
  const suffix = (r?: {type: string}) => (r?.type === 'percent' ? '%' : '');
  return <>
    <div className="cf-row">
      <F d={d} set={set} id="iconSet" kind="select" label="Icon Style:" options={ICON_SETS.map(([value, , label]) => ({value, label}))}/>
    </div>
    <div className="cf-row">
      <F d={d} set={set} id="iconReverse" kind="checkbox" label="Reverse Icon Order"/>
      <F d={d} set={set} id="iconOnly" kind="checkbox" label="Show Icon Only"/>
    </div>
    <p className="cf-desc-title">Display each icon according to these rules:</p>
    {Array.from({length: k}, (_, row) => {
      const icon = d.values.iconReverse === true ? row : k - 1 - row;
      const r = rules[row];
      const err = d.errors.find(e => e.field === `iconRules.${row}`)?.message ?? null;
      return <div key={row} className="cf-icon-rule" data-icon-rule={row}>
        <IconPic set={name} index={icon}/>
        <span className="cf-word">{row === 0 ? 'when value is' : row === k - 1 ? `when < ${rules[row - 1]?.value ?? ''}${suffix(rules[row - 1])}` : `when < ${rules[row - 1]?.value ?? ''}${suffix(rules[row - 1])} and`}</span>
        {r ? <>
          <Cell id={`iconRules.${row}.gte`} kind="select" options={opts([['true', '>='], ['false', '>']])} value={String(r.gte !== false)} onChange={x => change(row, {gte: x === 'true'})}/>
          <Cell id={`iconRules.${row}.value`} kind="text" value={r.value} error={err} onChange={x => change(row, {value: String(x ?? '')})} disabled={false}/>
          <Cell id={`iconRules.${row}.type`} kind="select" options={opts(ICON_VALUE_TYPES)} value={r.type} onChange={x => change(row, {type: String(x)})}/>
        </> : <><span/><span/><span/></>}
      </div>;
    })}
  </>;
}

function CellsDescription({d, set}: {d: DialogState; set: SetValue}) {
  const v = d.values;
  const kind = String(v.cellsKind);
  const between = v.operator === 'between' || v.operator === 'notBetween';
  return <>
    <p className="cf-desc-title">Format only cells with:</p>
    <div className="cf-row">
      <F d={d} set={set} id="cellsKind" kind="select" label="" options={opts(CELL_KINDS)}/>
      {kind === 'cellValue' ? <>
        <F d={d} set={set} id="operator" kind="select" label="" options={opts(OPERATORS)}/>
        <F d={d} set={set} id="value" kind="text" label=""/>
        {between ? <><span className="cf-word">and</span><F d={d} set={set} id="value2" kind="text" label=""/></> : null}
      </> : null}
      {kind === 'text' ? <>
        <F d={d} set={set} id="textOp" kind="select" label="" options={opts(TEXT_OPS)}/>
        <F d={d} set={set} id="text" kind="text" label=""/>
      </> : null}
      {kind === 'dates' ? <F d={d} set={set} id="period" kind="select" label="" options={opts(TIME_PERIODS)}/> : null}
    </div>
  </>;
}

function Description({d, set}: {d: DialogState; set: SetValue}) {
  const v = d.values;
  switch (v.ruleType) {
    case 'scale': return <ScaleDescription d={d} set={set}/>;
    case 'cells': return <CellsDescription d={d} set={set}/>;
    case 'rank': return <>
      <p className="cf-desc-title">Format values that rank in the:</p>
      <div className="cf-row">
        <F d={d} set={set} id="rankDir" kind="select" label="" options={opts([['top', 'Top'], ['bottom', 'Bottom']])}/>
        <div className="sf is-narrow"><F d={d} set={set} id="rank" kind="number" label="" extra={{min: 1, max: v.rankPercent ? 100 : 1000, step: 1}}/></div>
        <F d={d} set={set} id="rankPercent" kind="checkbox" label="% of the selected range"/>
      </div>
    </>;
    case 'average': return <>
      <p className="cf-desc-title">Format values that are:</p>
      <div className="cf-row">
        <F d={d} set={set} id="avgDir" kind="select" label="" options={opts(AVERAGES)}/>
        <span className="cf-word">the average for the selected range</span>
      </div>
    </>;
    case 'duplicates': return <>
      <p className="cf-desc-title">Format all:</p>
      <div className="cf-row">
        <F d={d} set={set} id="dupKind" kind="select" label="" options={opts([['duplicate', 'duplicate'], ['unique', 'unique']])}/>
        <span className="cf-word">values in the selected range</span>
      </div>
    </>;
    default: return <>
      <p className="cf-desc-title">Format values where this formula is true:</p>
      <div className="cf-row"><F d={d} set={set} id="formula" kind="text" label=""/></div>
    </>;
  }
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const v = d.values;
  const idx = Math.max(0, RULE_TYPES.findIndex(([id]) => id === v.ruleType));
  const formatted = v.ruleType !== 'scale';
  return <div className="gd-fields cf-root">
    <div className="sf" data-field-id="ruleType" data-kind="list">
      <span className="sf-label">Select a Rule Type:</span>
      <Rows label="Rule types" id="ruleType" height={126} selected={idx} items={RULE_TYPES.map(([, label]) => label)}
        onPick={i => setValue('ruleType', RULE_TYPES[i][0])}/>
    </div>
    <fieldset className="gd-section cf-desc" data-field-id="description">
      <legend>Edit the Rule Description:</legend>
      <Description d={d} set={setValue}/>
      {formatted ? <FormatBox d={d} set={setValue}/> : null}
    </fieldset>
  </div>;
}

export default {Body};
