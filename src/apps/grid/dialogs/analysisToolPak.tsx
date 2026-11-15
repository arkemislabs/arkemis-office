// Data Analysis as Excel draws it, in two boxes: first the Data Analysis list (Analysis Tools), then the
// chosen tool's own dialog (Input Range, Grouped By, Labels, Alpha, the tool's options, Output options:
// Output Range or New Worksheet Ply). OK on the list opens the tool's box (the model's validation asks the
// body to move on); OK there runs the tool. When the output range already holds data the command's refusal
// turns into Excel's prompt: Replace or Cancel.
// Translated from gridcraft crates/ui-egui/src/dialogs/analysis.rs (the tool list, `toolpak_fields`, the
// overwrite confirm) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {TOOL_LIST, TOOL_FORMS, isOverwriteError} from '../../../../core/grid/dialogs/analysisToolPak.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, Rows, type SetValue} from './dataKit';
import './analysis.css';

type Form = Record<string, unknown>;

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return <fieldset className="analysis-sec"><legend className="sf-label">{title}</legend>{children}</fieldset>;
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller} = useEngine();
  const v = d.values;
  const step = v.step === 'tool' ? 'tool' : 'pick';
  // OK on the list has nothing to run: validation says so with a problem on `step`, and the box moves on.
  const advance = d.errors.some(e => e.field === 'step');
  useEffect(() => { if (advance && step === 'pick') setValue('step', 'tool'); }, [advance, step]); // eslint-disable-line react-hooks/exhaustive-deps
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');

  if (step === 'pick') {
    const index = Math.max(0, TOOL_LIST.findIndex((t: {value: string}) => t.value === v.tool));
    return <div className="gd-fields analysis-pick">
      <div className="sf" data-field-id="tool" data-kind="list">
        <span className="sf-label">Analysis Tools:</span>
        <Rows label="Analysis Tools" id="tool" height={250} selected={index} items={TOOL_LIST.map((t: {label: string}) => t.label)}
          onPick={i => setValue('tool', TOOL_LIST[i].value)}
          onDouble={i => { setValue('tool', TOOL_LIST[i].value); setValue('step', 'tool'); }}/>
      </div>
    </div>;
  }

  const tool = String(v.tool ?? '');
  const form: Form = (TOOL_FORMS as Record<string, Form>)[tool] ?? {};
  const toRange = v.outputTo === 'range';
  const overwrite = isOverwriteError(d.message);
  const replace = () => { setValue('overwrite', true); void controller.submitDialog(d.key).catch(fail); };
  const keep = () => setValue('overwrite', false);
  const F = (id: string, label: string, kind: 'text' | 'checkbox' | 'radio' | 'select', extra: {options?: {value: unknown; label: string}[]; disabled?: boolean} = {}) =>
    <Fld d={d} set={setValue} id={id} kind={kind} label={label} {...extra}/>;
  const pct = (on: string, field: string, label: string) => <div className="analysis-pct">
    {F(on, label, 'checkbox')}
    <div className="analysis-pct-box">{F(field, '', 'text', {disabled: v[on] !== true})}<span>%</span></div>
  </div>;
  const nth = (on: string, field: string, label: string) => <div className="analysis-pct">
    {F(on, label, 'checkbox')}
    <div className="analysis-pct-box">{F(field, '', 'text', {disabled: v[on] !== true})}</div>
  </div>;

  return <div className="gd-fields analysis-form" data-tool={tool}>
    {overwrite ? <div className="analysis-overwrite" role="alertdialog" aria-label="Replace existing data">
      <span>There is already data in the output range. Do you want to replace it?</span>
      <button type="button" className="gd-button gd-primary" onClick={replace}>Replace</button>
      <button type="button" className="gd-button" onClick={keep}>Cancel</button>
    </div> : null}
    <Section title="Input">
      {form.input === 'range' ? F('range', 'Input Range:', 'text') : null}
      {form.input === 'regression' ? <>{F('inputY', 'Input Y Range:', 'text')}{F('inputX', 'Input X Range:', 'text')}</> : null}
      {form.input === 'two' ? <>{F('range1', 'Variable 1 Range:', 'text')}{F('range2', 'Variable 2 Range:', 'text')}</> : null}
      {form.bins ? F('bins', 'Bin Range:', 'text') : null}
      {form.difference ? F('hypothesizedDifference', 'Hypothesized Mean Difference:', 'text') : null}
      {form.damping ? F('damping', 'Damping factor:', 'text') : null}
      {form.interval ? F('interval', 'Interval:', 'text') : null}
      {form.grouped ? F('groupedBy', 'Grouped By:', 'radio', {options: [{value: 'columns', label: 'Columns'}, {value: 'rows', label: 'Rows'}]}) : null}
      {form.labels ? F('labels', String(form.labels), 'checkbox') : null}
      {form.regression ? F('constantZero', 'Constant is Zero', 'checkbox') : null}
      {form.regression ? pct('confidenceOn', 'confidence', 'Confidence Level:') : null}
      {form.alpha ? F('alpha', 'Alpha:', 'text') : null}
    </Section>
    <Section title="Output options">
      {F('outputTo', '', 'radio', {options: [{value: 'range', label: 'Output Range:'}, {value: 'newSheet', label: 'New Worksheet Ply:'}]})}
      <div className="data-two">
        {F('output', 'Output Range:', 'text', {disabled: !toRange})}
        {F('newSheet', 'New Worksheet Ply:', 'text', {disabled: toRange})}
      </div>
    </Section>
    {form.descriptive ? <Section title="Statistics">
      {F('summary', 'Summary statistics', 'checkbox')}
      {pct('confidenceOn', 'confidence', 'Confidence Level for Mean:')}
      {nth('kthLargestOn', 'kthLargest', 'Kth Largest:')}
      {nth('kthSmallestOn', 'kthSmallest', 'Kth Smallest:')}
    </Section> : null}
    {form.histogram ? <Section title="Histogram">
      {F('pareto', 'Pareto (sorted histogram)', 'checkbox')}
      {F('cumulative', 'Cumulative Percentage', 'checkbox')}
    </Section> : null}
    {form.regression ? <>
      <Section title="Residuals">{F('residuals', 'Residuals', 'checkbox')}{F('standardizedResiduals', 'Standardized Residuals', 'checkbox')}</Section>
      <Section title="Normal Probability">{F('normalProbability', 'Normal Probability', 'checkbox')}</Section>
    </> : null}
    {form.standardErrors ? F('standardErrors', 'Standard Errors', 'checkbox') : null}
  </div>;
}

export default {Body};
