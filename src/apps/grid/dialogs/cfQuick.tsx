// The Highlight Cells Rules and Top/Bottom Rules boxes as Excel draws them: a sentence ("Format cells that
// are GREATER THAN:"), the value (or two, or a period, or a rank), and "with" the format to give the cells,
// whose last choice is Custom Format... (the conditional Format Cells).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (`cond_format`: value, value2, text, period,
// preset) at 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's wording per box.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {quickText} from '../../../../core/grid/dialogs/cfQuick.mjs';
import {valuesFromDxf, dxfFromValues} from '../../../../core/grid/dialogs/cfFormatCells.mjs';
import {FORMAT_PRESETS, TIME_PERIODS} from '../../../../core/grid/lib/cond-format-dialog.mjs';
import {F, Cell, opts, type SetValue} from './cfKit';

const PRESETS = [...opts(FORMAT_PRESETS), {value: 'custom', label: 'Custom Format…'}];

/** "with": the six formats and Custom Format... (which gathers the format in the conditional Format Cells). */
function WithBox({d, set}: {d: DialogState; set: SetValue}) {
  const {controller} = useEngine();
  const choose = (v: unknown) => {
    if (v !== 'custom') { set('dxf', null); set('preset', v); return; }
    controller.collectDialog('dialog.cfFormatCells', valuesFromDxf(d.values.dxf)).then(vals => {
      if (!vals) return;
      const dxf = dxfFromValues(vals);
      set('dxf', Object.keys(dxf).length ? dxf : null);
      set('preset', 'custom');
    }).catch(e => controller.notify(toCommandError(e).message, 'error'));
  };
  return <Cell id="preset" label="with" kind="select" options={PRESETS} value={d.values.preset} onChange={choose}/>;
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const v = d.values;
  const {lead} = quickText(v as never);
  const between = v.operator === 'between';
  return <div className="gd-fields cf-root">
    <p className="cf-lead">{lead}</p>
    {v.ruleType === 'cells' && v.cellsKind === 'cellValue' ? <div className="cf-row">
      <F d={d} set={setValue} id="value" kind="text" label={between ? 'Minimum' : 'Value'}/>
      {between ? <><span className="cf-word">and</span><F d={d} set={setValue} id="value2" kind="text" label="Maximum"/></> : null}
    </div> : null}
    {v.ruleType === 'cells' && v.cellsKind === 'text' ? <div className="cf-row"><F d={d} set={setValue} id="text" kind="text" label="Text"/></div> : null}
    {v.ruleType === 'cells' && v.cellsKind === 'dates' ? <div className="cf-row"><F d={d} set={setValue} id="period" kind="select" label="Date" options={opts(TIME_PERIODS)}/></div> : null}
    {v.ruleType === 'duplicates' ? <div className="cf-row">
      <F d={d} set={setValue} id="dupKind" kind="select" label="Values" options={opts([['duplicate', 'duplicate'], ['unique', 'unique']])} extra={{}}/>
      <span className="cf-word">values</span>
    </div> : null}
    {v.ruleType === 'rank' ? <div className="cf-row">
      <div className="sf is-narrow"><F d={d} set={setValue} id="rank" kind="number" label="Rank" extra={{min: 1, max: v.rankPercent ? 100 : 1000, step: 1}}/></div>
      <span className="cf-word">{v.rankPercent ? '% of the selected cells' : 'items'}</span>
    </div> : null}
    {v.ruleType === 'average' ? <div className="cf-row">
      <F d={d} set={setValue} id="avgDir" kind="select" label="Average" options={opts([['above', 'above'], ['below', 'below']])}/>
      <span className="cf-word">average for the selected range</span>
    </div> : null}
    <div className="cf-row"><WithBox d={d} set={setValue}/></div>
  </div>;
}

export default {Body};
