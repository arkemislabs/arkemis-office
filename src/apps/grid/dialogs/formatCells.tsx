// Format Cells (Ctrl+1) as Excel lays it out: Number (Category list, Sample, the category's own
// settings and its description), Alignment (Text alignment, Text control, Orientation dial),
// Font (Font / Font style / Size lists, Underline, Color, Effects, Preview), Border (Line style
// and colour, Presets, the border box with its edge buttons), Fill (Background Color, Pattern
// Color and Style, Sample) and Protection; over the model in core/grid/dialogs/formatCells.mjs.
// Translated from gridcraft crates/ui-egui/src/dialogs/format_cells.rs and border_preview.rs at
// 146161b4b450a56e5e59a083ba0478582d1e602b, completed to Excel's dialog.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, type CSSProperties, type ReactNode} from 'react';
import formatCellsModel from '../../../../core/grid/dialogs/formatCells.mjs';
import {useEngine} from '../../../shell/engine/EngineProvider';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import type {SpecField} from '../../../generated/spec-types';
import {SelectField, NumberField, Checkbox, ListField, ColorField, TextField} from '../../../shell/fields';
import {ColorPalette} from '../../../shell/common/ColorPalette';
import {CATEGORIES, SYMBOLS, NEGATIVE_LABELS, CUSTOM_CODES, LINE_STYLES, PATTERNS} from '../../../../core/grid/dialogs/formatCells.mjs';
import './formatCells.css';

type Props = {dialog: DialogState; setValue: (field: string, value: unknown) => void};
type PageProps = {d: DialogState; set: (field: string, value: unknown) => void; pv?: any};
type Opt = {value: unknown; label: string};
const spec = (id: string, label: string, kind: string, options: readonly (Opt | string)[] = [], extra: Partial<SpecField> = {}): SpecField =>
  ({id, label, kind, options: options.map(o => (typeof o === 'string' ? {value: o, label: o} : o)), ...extra}) as SpecField;

/** One field of the library bound to a value of the dialog. */
function F({d, set, f, C, style}: {d: DialogState; set: PageProps['set']; f: SpecField; C: (p: any) => ReactNode; style?: CSSProperties}) {
  const error = d.errors.find(e => e.field === f.id)?.message ?? null;
  return <div style={style}><C field={f} value={d.values[f.id]} onChange={(v: unknown) => set(f.id, v)} error={error} disabled={d.busy}/></div>;
}
const Group = ({title, children, style}: {title: string; children: ReactNode; style?: CSSProperties}) =>
  <fieldset className="gd-section fc-group" style={style}><legend>{title}</legend>{children}</fieldset>;

function Tabs({d}: {d: DialogState}) {
  const {controller} = useEngine();
  return <div className="gd-tabs" role="tablist" aria-label="Format Cells pages">
    {d.spec.tabs.map((t, i) => <button key={i} type="button" role="tab" aria-selected={i === d.tab} className={i === d.tab ? 'is-active' : undefined}
      onClick={() => controller.setDialogTab(d.key, i)}
      onKeyDown={e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        controller.setDialogTab(d.key, (i + (e.key === 'ArrowRight' ? 1 : -1) + d.spec.tabs.length) % d.spec.tabs.length);
      }}>{t.name}</button>)}
  </div>;
}

const DESCRIPTIONS: Record<string, string> = {
  General: 'General format cells have no specific number format.',
  Number: 'Number is used for general display of numbers. Currency and Accounting offer specialized formatting for monetary value.',
  Currency: 'Currency formats are used for general monetary values. Use Accounting formats to align decimal points in a column.',
  Accounting: 'Accounting formats line up the currency symbols and decimal points in a column.',
  Date: 'Date formats display date and time serial numbers as date values.',
  Time: 'Time formats display date and time serial numbers as time values.',
  Percentage: 'Percentage formats multiply the cell value by 100 and display the result with a percent symbol.',
  Fraction: 'Fraction formats display the value as a fraction.',
  Scientific: 'Scientific formats display the value in exponential notation.',
  Text: 'Text format cells are treated as text even when a number is in the cell. The cell is displayed exactly as entered.',
  Special: 'Special formats are useful for tracking list and database values.',
  Custom: 'Type the number format code, using one of the existing codes as a starting point.',
};

function NumberPage({d, set, pv}: PageProps) {
  const v = d.values;
  const cat = String(v.category ?? 'General');
  const decimals = <F d={d} set={set} f={spec('decimalPlaces', 'Decimal places:', 'number', [], {min: 0, max: 30, step: 1})} C={NumberField}/>;
  const negs = ((pv?.negatives ?? NEGATIVE_LABELS.map((label, value) => ({value, label, red: value % 2 === 1}))) as {value: number; label: string; red: boolean}[]);
  const negatives = () => <div className="sf" data-field-id="negativeNumbers" data-kind="list">
    <span className="sf-label">Negative numbers:</span>
    <div className="sf-list fc-negatives" role="listbox" tabIndex={0}>
      {negs.map(o => <div key={o.value} role="option" aria-selected={Number(v.negativeNumbers) === o.value}
        className={`sf-list-item${Number(v.negativeNumbers) === o.value ? ' is-selected' : ''}`} style={o.red ? {color: '#ff6b6b'} : undefined}
        onClick={() => set('negativeNumbers', o.value)}>{o.label}</div>)}
    </div>
  </div>;
  const symbol = <F d={d} set={set} f={spec('symbol', 'Symbol:', 'select', SYMBOLS)} C={SelectField}/>;
  const types = <F d={d} set={set} C={ListField} f={spec('type', 'Type:', 'list', (pv?.types ?? []) as Opt[])}/>;
  return <div className="fc-number">
    <F d={d} set={set} C={ListField} f={spec('category', 'Category:', 'list', CATEGORIES)} style={{width: 150}}/>
    <div className="fc-number-right">
      <Group title="Sample"><div className="fc-sample" data-field-id="sample" style={{color: pv?.number?.color ?? undefined}}>{pv?.number?.text ?? ''}</div></Group>
      {cat === 'Number' ? <>{decimals}<F d={d} set={set} f={spec('useSeparator', 'Use 1000 Separator (,)', 'checkbox')} C={Checkbox}/>{negatives()}</> : null}
      {cat === 'Currency' ? <>{decimals}{symbol}{negatives()}</> : null}
      {cat === 'Accounting' ? <>{decimals}{symbol}</> : null}
      {cat === 'Percentage' || cat === 'Scientific' ? decimals : null}
      {cat === 'Date' || cat === 'Time' || cat === 'Fraction' || cat === 'Special' ? types : null}
      {cat === 'Custom' ? <>
        <F d={d} set={set} f={spec('code', 'Type:', 'text')} C={TextField}/>
        <F d={d} set={set} C={ListField} f={spec('code', '', 'list', CUSTOM_CODES)}/>
      </> : null}
      <p className="fc-note">{DESCRIPTIONS[cat] ?? ''}</p>
    </div>
  </div>;
}

const H_ALIGN: Opt[] = [['general', 'General'], ['left', 'Left (Indent)'], ['center', 'Center'], ['right', 'Right (Indent)'], ['fill', 'Fill'], ['justify', 'Justify'],
  ['centerAcross', 'Center Across Selection'], ['distributed', 'Distributed (Indent)']].map(([value, label]) => ({value, label}));
const V_ALIGN: Opt[] = [['top', 'Top'], ['center', 'Center'], ['bottom', 'Bottom'], ['justify', 'Justify'], ['distributed', 'Distributed']].map(([value, label]) => ({value, label}));

function Dial({d, set}: PageProps) {
  const vertical = d.values.verticalText === true;
  const deg = vertical ? 90 : Number(d.values.rotation ?? 0);
  const rad = deg * Math.PI / 180;
  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left - 10, y = r.top + r.height / 2 - e.clientY;
    const a = Math.round(Math.atan2(y, Math.max(x, 0.0001)) * 180 / Math.PI);
    set('verticalText', false);
    set('rotation', Math.max(-90, Math.min(90, a)));
  };
  return <div className="fc-orient">
    <button type="button" className={`fc-vertical${vertical ? ' is-on' : ''}`} aria-pressed={vertical} aria-label="Vertical text" onClick={() => set('verticalText', !vertical)}>
      {'Text'.split('').map((c, i) => <span key={i}>{c}</span>)}
    </button>
    <svg className="fc-dial" viewBox="0 0 100 120" width="100" height="120" role="slider" aria-label="Orientation" aria-valuemin={-90} aria-valuemax={90} aria-valuenow={deg} onClick={pick}>
      <path d="M10 10 A50 50 0 0 1 10 110" fill="none" stroke="currentColor" strokeOpacity=".25"/>
      {[-90, -45, 0, 45, 90].map(a => <circle key={a} cx={10 + 50 * Math.cos(a * Math.PI / 180)} cy={60 - 50 * Math.sin(a * Math.PI / 180)} r="2" fill="currentColor" opacity=".45"/>)}
      <line x1="10" y1="60" x2={10 + 46 * Math.cos(rad)} y2={60 - 46 * Math.sin(rad)} stroke="var(--ark-accent, #8ab4ff)" strokeWidth="2"/>
      <text x="16" y="56" fontSize="10" fill="currentColor" transform={`rotate(${-deg} 10 60)`}>Text</text>
    </svg>
    <F d={d} set={set} f={spec('rotation', 'Degrees', 'number', [], {min: -90, max: 90, step: 1})} C={NumberField} style={{width: 90}}/>
  </div>;
}

function AlignmentPage({d, set}: PageProps) {
  return <div className="fc-cols">
    <div className="fc-col">
      <Group title="Text alignment">
        <F d={d} set={set} f={spec('horizontal', 'Horizontal:', 'select', H_ALIGN)} C={SelectField}/>
        <F d={d} set={set} f={spec('indent', 'Indent:', 'number', [], {min: 0, max: 250, step: 1})} C={NumberField}/>
        <F d={d} set={set} f={spec('vertical', 'Vertical:', 'select', V_ALIGN)} C={SelectField}/>
      </Group>
      <Group title="Text control">
        <F d={d} set={set} f={spec('wrap', 'Wrap text', 'checkbox')} C={Checkbox}/>
        <F d={d} set={set} f={spec('shrink', 'Shrink to fit', 'checkbox')} C={Checkbox}/>
        <F d={d} set={set} f={spec('merge', 'Merge cells', 'checkbox')} C={Checkbox}/>
      </Group>
    </div>
    <Group title="Orientation" style={{width: 190}}><Dial d={d} set={set}/></Group>
  </div>;
}

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
const FONTS = ['Aptos', 'Aptos Narrow', 'Arial', 'Calibri', 'Cambria', 'Candara', 'Consolas', 'Courier New', 'Garamond', 'Georgia', 'Helvetica', 'Segoe UI', 'Tahoma',
  'Times New Roman', 'Trebuchet MS', 'Verdana'];
const UNDERLINES: Opt[] = [['none', 'None'], ['single', 'Single'], ['double', 'Double'], ['singleAccounting', 'Single Accounting'], ['doubleAccounting', 'Double Accounting']]
  .map(([value, label]) => ({value, label}));

function FontPage({d, set}: PageProps) {
  const v = d.values;
  // The list holds each font once: a workbook's font spelled another way (calibri, Calibri ) is the entry already there.
  const fonts = useMemo(() => (FONTS.some(f => f.toLowerCase() === String(v.font).trim().toLowerCase()) || !String(v.font ?? '').trim() ? FONTS : [String(v.font), ...FONTS]), [v.font]);
  const cf = d.id === 'dialog.cfFormatCells';
  const u = String(v.underline ?? 'none');
  const css: CSSProperties = {
    fontFamily: `"${String(v.font ?? '').replace(/"/g, '')}", var(--ark-font)`, fontSize: Math.max(8, Math.min(40, (Number(v.size) || 11) * 1.33)),
    fontWeight: v.bold ? 700 : 400, fontStyle: v.italic ? 'italic' : undefined,
    textDecorationLine: [u !== 'none' ? 'underline' : '', v.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
    textDecorationStyle: /double/i.test(u) ? 'double' : undefined,
    color: typeof v.color === 'string' && /^#/.test(v.color) ? v.color : undefined,
    verticalAlign: v.vert === 'superscript' ? 'super' : v.vert === 'subscript' ? 'sub' : undefined,
  };
  return <div className="fc-font">
    <div className="fc-font-row">
      {cf ? null : <div className="fc-font-list">
        <F d={d} set={set} f={spec('font', 'Font:', 'text')} C={TextField}/>
        <F d={d} set={set} f={spec('font', '', 'list', fonts)} C={ListField}/>
      </div>}
      <div className="fc-font-list" style={{width: 130}}>
        <F d={d} set={set} f={spec('fontStyle', 'Font style:', 'list', ['Regular', 'Italic', 'Bold', 'Bold Italic'])} C={ListField}/>
      </div>
      {cf ? null : <div className="fc-font-list" style={{width: 90}}>
        <F d={d} set={set} f={spec('size', 'Size:', 'number', [], {min: 1, max: 409, step: 0.5})} C={NumberField}/>
        <F d={d} set={set} f={spec('size', '', 'list', FONT_SIZES.map(n => ({value: n, label: String(n)})))} C={ListField}/>
      </div>}
    </div>
    <div className="fc-font-row">
      <F d={d} set={set} f={spec('underline', 'Underline:', 'select', UNDERLINES)} C={SelectField} style={{flex: 1}}/>
      <F d={d} set={set} f={spec('color', 'Color:', 'color', ['Automatic'])} C={ColorField} style={{flex: 1}}/>
      {cf ? <div style={{alignSelf: 'end'}}><button type="button" className="gd-button" onClick={() => { set('bold', false); set('italic', false); set('underline', 'none'); set('color', 'auto'); set('strike', false); }}>Clear</button></div>
        : <F d={d} set={set} f={spec('normalFont', 'Normal font', 'checkbox')} C={Checkbox} style={{alignSelf: 'end'}}/>}
    </div>
    <div className="fc-font-row">
      <Group title="Effects" style={{flex: 1}}>
        <F d={d} set={set} f={spec('strike', 'Strikethrough', 'checkbox')} C={Checkbox}/>
        {cf ? null : <div className="sf sf-check"><label><input type="checkbox" checked={v.vert === 'superscript'} onChange={e => set('vert', e.target.checked ? 'superscript' : 'baseline')}/>
          <span className="sf-check-box" aria-hidden="true"/><span>Superscript</span></label></div>}
        {cf ? null : <div className="sf sf-check"><label><input type="checkbox" checked={v.vert === 'subscript'} onChange={e => set('vert', e.target.checked ? 'subscript' : 'baseline')}/>
          <span className="sf-check-box" aria-hidden="true"/><span>Subscript</span></label></div>}
      </Group>
      <Group title="Preview" style={{flex: 1.4}}>
        <div className="fc-fontpreview" data-field-id="preview" role="img" aria-label="Font preview"><span style={css}>AaBbCcYyZz</span></div>
      </Group>
    </div>
    <p className="fc-note">{v.font === 'Calibri' || v.font === 'Aptos' ? 'This is a TrueType font. The same font will be used on both your printer and your screen.' : ''}</p>
  </div>;
}

const DASH: Record<string, string> = {hair: '1 1', dotted: '1 2', dashDotDot: '6 2 1 2 1 2', dashDot: '6 2 1 2', dashed: '4 2', mediumDashDotDot: '6 2 1 2 1 2',
  slantDashDot: '6 2 2 2', mediumDashDot: '6 2 1 2', mediumDashed: '6 3'};
const WIDTH: Record<string, number> = {medium: 2, mediumDashed: 2, mediumDashDot: 2, mediumDashDotDot: 2, slantDashDot: 2, thick: 3};
function Stroke({style, color, x1, y1, x2, y2}: {style: string; color?: string; x1: number; y1: number; x2: number; y2: number}) {
  const c = color && /^#/.test(color) ? color : 'currentColor';
  if (style === 'double') {
    const dx = y1 === y2 ? 0 : 1.5, dy = y1 === y2 ? 1.5 : 0;
    return <g stroke={c} strokeWidth={1}><line x1={x1 - dx} y1={y1 - dy} x2={x2 - dx} y2={y2 - dy}/><line x1={x1 + dx} y1={y1 + dy} x2={x2 + dx} y2={y2 + dy}/></g>;
  }
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={WIDTH[style] ?? 1} strokeDasharray={DASH[style]}/>;
}

function BorderPage({d, set, pv}: PageProps) {
  const v = d.values;
  const multi = v.multi === true;
  const toggle = (edge: string) => {
    const cur = String(v[edge] ?? 'none');
    const line = String(v.lineStyle ?? 'thin');
    const on = cur === 'none' || cur !== line;
    set('edgeColors', {...(v.edgeColors as object ?? {}), [edge]: v.lineColor ?? 'auto'});
    set(edge, on && line !== 'none' ? line : 'none');
  };
  const b = (pv?.borders ?? {}) as Record<string, {style: string; color: string} | null>;
  const W = 200, H = 120, x0 = 20, y0 = 10, x1 = 180, y1 = 110, mx = 100, my = 60;
  const edgeBtn = (edge: string, label: string, glyph: ReactNode, disabled = false) =>
    <button type="button" className={`fc-edge${v[edge] && v[edge] !== 'none' ? ' is-on' : ''}`} aria-pressed={!!v[edge] && v[edge] !== 'none'} aria-label={label} title={label}
      disabled={disabled} onClick={() => toggle(edge)}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{glyph}</svg></button>;
  const box = <rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="currentColor" strokeOpacity=".3"/>;
  return <div className="fc-cols">
    <Group title="Line" style={{width: 170}}>
      <div className="fc-lines" role="listbox" aria-label="Style">
        {LINE_STYLES.map(s => <button key={s} type="button" role="option" aria-selected={v.lineStyle === s} className={`fc-line${v.lineStyle === s ? ' is-selected' : ''}`}
          onClick={() => set('lineStyle', s)} title={s}>
          {s === 'none' ? <span>None</span> : <svg viewBox="0 0 60 8" width="60" height="8" aria-hidden="true"><Stroke style={s} x1={2} y1={4} x2={58} y2={4}/></svg>}
        </button>)}
      </div>
      <F d={d} set={set} f={spec('lineColor', 'Color:', 'color', ['Automatic'])} C={ColorField}/>
    </Group>
    <div className="fc-col">
      <Group title="Presets">
        <div className="fc-presets">
          {[['none', 'None'], ['outline', 'Outline'], ['inside', 'Inside']].map(([id, label]) =>
            <button key={id} type="button" className="gd-button" disabled={id === 'inside' && !multi} onClick={() => set('presets', id)}>{label}</button>)}
        </div>
      </Group>
      <Group title="Border">
        <div className="fc-border">
          <div className="fc-edges-v">
            {edgeBtn('top', 'Top border', <>{box}<line x1="2" y1="2.5" x2="14" y2="2.5" stroke="currentColor" strokeWidth="1.5"/></>)}
            {edgeBtn('insideHorizontal', 'Inside horizontal border', <>{box}<line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.5"/></>, !multi)}
            {edgeBtn('bottom', 'Bottom border', <>{box}<line x1="2" y1="13.5" x2="14" y2="13.5" stroke="currentColor" strokeWidth="1.5"/></>)}
          </div>
          <svg className="fc-border-box" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Border preview" data-field-id="preview">
            {b.diagUp ? <Stroke style={b.diagUp.style} color={b.diagUp.color} x1={x0} y1={y1} x2={x1} y2={y0}/> : null}
            {b.diagDown ? <Stroke style={b.diagDown.style} color={b.diagDown.color} x1={x0} y1={y0} x2={x1} y2={y1}/> : null}
            {multi ? <><text x={(x0 + mx) / 2} y={(y0 + my) / 2 + 4} className="fc-text">Text</text><text x={(mx + x1) / 2} y={(y0 + my) / 2 + 4} className="fc-text">Text</text>
              <text x={(x0 + mx) / 2} y={(my + y1) / 2 + 4} className="fc-text">Text</text><text x={(mx + x1) / 2} y={(my + y1) / 2 + 4} className="fc-text">Text</text></>
              : <text x={mx} y={my + 4} className="fc-text">Text</text>}
            {[[x0 - 6, y0, x0, y0], [x1, y0, x1 + 6, y0], [x0 - 6, y1, x0, y1], [x1, y1, x1 + 6, y1], [x0, y0 - 6, x0, y0], [x1, y0 - 6, x1, y0], [x0, y1, x0, y1 + 6], [x1, y1, x1, y1 + 6]]
              .map(([a, c, e, f], i) => <line key={i} x1={a} y1={c} x2={e} y2={f} stroke="currentColor" strokeOpacity=".4"/>)}
            {b.top ? <Stroke style={b.top.style} color={b.top.color} x1={x0} y1={y0} x2={x1} y2={y0}/> : null}
            {b.bottom ? <Stroke style={b.bottom.style} color={b.bottom.color} x1={x0} y1={y1} x2={x1} y2={y1}/> : null}
            {b.left ? <Stroke style={b.left.style} color={b.left.color} x1={x0} y1={y0} x2={x0} y2={y1}/> : null}
            {b.right ? <Stroke style={b.right.style} color={b.right.color} x1={x1} y1={y0} x2={x1} y2={y1}/> : null}
            {multi && b.insideHorizontal ? <Stroke style={b.insideHorizontal.style} color={b.insideHorizontal.color} x1={x0} y1={my} x2={x1} y2={my}/> : null}
            {multi && b.insideVertical ? <Stroke style={b.insideVertical.style} color={b.insideVertical.color} x1={mx} y1={y0} x2={mx} y2={y1}/> : null}
          </svg>
        </div>
        <div className="fc-edges-h">
          {edgeBtn('diagUp', 'Diagonal up border', <>{box}<line x1="2.5" y1="13.5" x2="13.5" y2="2.5" stroke="currentColor" strokeWidth="1.5"/></>)}
          {edgeBtn('left', 'Left border', <>{box}<line x1="2.5" y1="2" x2="2.5" y2="14" stroke="currentColor" strokeWidth="1.5"/></>)}
          {edgeBtn('insideVertical', 'Inside vertical border', <>{box}<line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" strokeWidth="1.5"/></>, !multi)}
          {edgeBtn('right', 'Right border', <>{box}<line x1="13.5" y1="2" x2="13.5" y2="14" stroke="currentColor" strokeWidth="1.5"/></>)}
          {edgeBtn('diagDown', 'Diagonal down border', <>{box}<line x1="2.5" y1="2.5" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.5"/></>)}
        </div>
      </Group>
      <p className="fc-note">The selected border style can be applied by clicking the presets, preview diagram or the buttons above.</p>
      <div><button type="button" className="gd-button" onClick={() => set('presets', 'none')}>Clear</button></div>
    </div>
  </div>;
}

const PATTERN_LABELS: Record<string, string> = {none: 'None', solid: 'Solid', gray0625: '6.25% Gray', gray125: '12.5% Gray', lightGray: '25% Gray', mediumGray: '50% Gray',
  darkGray: '75% Gray', lightHorizontal: 'Thin Horizontal Stripe', lightVertical: 'Thin Vertical Stripe', lightDown: 'Thin Reverse Diagonal Stripe',
  lightUp: 'Thin Diagonal Stripe', lightGrid: 'Thin Horizontal Crosshatch', lightTrellis: 'Thin Diagonal Crosshatch', darkHorizontal: 'Horizontal Stripe',
  darkVertical: 'Vertical Stripe', darkDown: 'Reverse Diagonal Stripe', darkUp: 'Diagonal Stripe', darkGrid: 'Diagonal Crosshatch', darkTrellis: 'Thick Diagonal Crosshatch'};

function FillPage({d, set}: PageProps) {
  const v = d.values;
  const bg = typeof v.background === 'string' && /^#/.test(v.background) ? v.background : null;
  const pc = typeof v.patternColor === 'string' && /^#/.test(v.patternColor) ? v.patternColor : '#000000';
  const pattern = String(v.patternStyle ?? 'none');
  const stripes = pattern !== 'none' && pattern !== 'solid';
  const sampleCss: CSSProperties = {background: bg ?? 'transparent',
    backgroundImage: stripes ? `repeating-linear-gradient(${/Vertical/.test(pattern) ? 90 : /Down/.test(pattern) ? 45 : /Up/.test(pattern) ? 135 : 0}deg, ${pc} 0 1px, transparent 1px ${/dark/.test(pattern) ? 3 : 5}px)` : undefined};
  return <div className="fc-cols">
    <div className="fc-col">
      <div className="sf-label">Background Color:</div>
      <div className="fc-palette" data-field-id="background">
        <ColorPalette value={bg} automatic="No Color" onPick={hex => set('background', hex ?? 'none')}/>
      </div>
    </div>
    <div className="fc-col" style={{width: 210}}>
      <F d={d} set={set} f={spec('patternColor', 'Pattern Color:', 'color', ['Automatic'])} C={ColorField}/>
      <F d={d} set={set} f={spec('patternStyle', 'Pattern Style:', 'select', PATTERNS.filter(p => p !== 'solid').map(p => ({value: p, label: PATTERN_LABELS[p] ?? p})))} C={SelectField}/>
      <Group title="Sample"><div className="fc-fill-sample" data-field-id="sample" style={sampleCss}/></Group>
      <div><button type="button" className="gd-button" onClick={() => { set('background', 'none'); set('patternColor', 'auto'); set('patternStyle', 'none'); }}>Clear</button></div>
    </div>
  </div>;
}

function ProtectionPage({d, set}: PageProps) {
  return <div className="fc-col">
    <F d={d} set={set} f={spec('locked', 'Locked', 'checkbox')} C={Checkbox}/>
    <F d={d} set={set} f={spec('hidden', 'Hidden', 'checkbox')} C={Checkbox}/>
    <p className="fc-note">Locking cells or hiding formulas has no effect until you protect the worksheet (Review tab, Protect group, Protect Sheet button).</p>
  </div>;
}

function Body({dialog: d, setValue}: Props) {
  const {session, docId} = useEngine();
  const pv = useMemo(() => {
    try { return (formatCellsModel as any).preview(session.readContext(docId), d.values); } catch { return null; }
  }, [session, docId, d.values]);
  const page = d.spec.tabs[d.tab]?.name ?? 'Number';
  const props = {d, set: setValue, pv};
  return <div className="gd-fields fc-root">
    <Tabs d={d}/>
    <div className="fc-page" data-page={page}>
      {page === 'Number' ? <NumberPage {...props}/> : null}
      {page === 'Alignment' ? <AlignmentPage {...props}/> : null}
      {page === 'Font' ? <FontPage {...props}/> : null}
      {page === 'Border' ? <BorderPage {...props}/> : null}
      {page === 'Fill' ? <FillPage {...props}/> : null}
      {page === 'Protection' ? <ProtectionPage {...props}/> : null}
    </div>
  </div>;
}

export default {Body};
