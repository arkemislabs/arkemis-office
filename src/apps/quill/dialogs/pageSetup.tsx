// Page Setup dialog view (Layout › Page Setup launcher, Margins › Custom Margins…, Size › More Paper
// Sizes…): Word's Margins, Paper, Layout and Document Grid pages with the page preview, over the
// model in core/quill/dialogs/pageSetup.mjs. Layout from wordcraft crates/ui-egui/src/dialogs/
// dispatch.rs `page_setup_dialog` and page_setup.rs `page_paper_group` at
// aadb077e072b7de05f724e359d8db82e151f125c (MIT, see assets/third-party-licenses/artcraft-reference.txt),
// arranged in Word's tabs.

import {Field, Group, PageTabs, grid, usePreview, type BodyProps} from './font';
import {Icon} from '../../../shell/icons/Icon';

type Preview = {pageW: number; pageH: number; top: number; bottom: number; left: number; right: number; gutter: number; mirror: boolean;
  columns: number; valign?: string};

const n = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/** One page (or a facing pair with mirror margins) with its text area and lines of text. */
export function PagePreview({p, label = 'Preview'}: {p: Preview | null; label?: string}) {
  const pw = Math.max(0.1, n(p?.pageW, 8.5)), ph = Math.max(0.1, n(p?.pageH, 11));
  const box = 118;
  const k = box / Math.max(pw, ph);
  const W = pw * k, H = ph * k;
  const page = (x0: number, mirrored: boolean) => {
    const inside = n(p?.left) + n(p?.gutter), outside = n(p?.right);
    const l = (mirrored ? outside : inside) * k, r = (mirrored ? inside : outside) * k;
    const t = n(p?.top) * k, b = n(p?.bottom) * k;
    const tw = Math.max(2, W - l - r), th = Math.max(2, H - t - b);
    const cols = Math.max(1, Math.min(12, n(p?.columns, 1)));
    const gap = cols > 1 ? Math.min(6, tw * 0.08) : 0;
    const cw = (tw - gap * (cols - 1)) / cols;
    const rows = Math.max(1, Math.floor(th / 5));
    return <g key={x0} transform={`translate(${x0} 0)`}>
      <rect x={0.5} y={0.5} width={W} height={H} fill="#fff" stroke="#9a9ca3" strokeWidth={1}/>
      <rect x={0.5 + l} y={0.5 + t} width={tw} height={th} fill="none" stroke="#c4c6cc" strokeDasharray="2 2" strokeWidth={0.75}/>
      {Array.from({length: cols}, (_, c) => Array.from({length: rows}, (_, i) =>
        <rect key={`${c}-${i}`} x={0.5 + l + c * (cw + gap)} y={0.5 + t + 2 + i * 5} width={i === rows - 1 ? cw * 0.55 : cw} height={2} rx={0.6} fill="#8d9098"/>))}
    </g>;
  };
  const pair = !!p?.mirror;
  const total = pair ? W * 2 + 6 : W;
  return <div className="sf" data-field-id="preview" data-kind="preview">
    <span className="sf-label">{label}</span>
    <div role="img" aria-label="Page preview" style={{height: 150, display: 'grid', placeItems: 'center', borderRadius: 10, background: '#e6e7ea'}}>
      <svg width={total + 2} height={H + 2} viewBox={`0 0 ${total + 2} ${H + 2}`} aria-hidden="true">
        {page(0, false)}{pair ? page(W + 6, true) : null}
      </svg>
    </div>
  </div>;
}

/** Word's Orientation tiles: a page icon over each choice. */
function Orientation({d, set}: {d: BodyProps['dialog']; set: BodyProps['setValue']}) {
  const v = d.values.orientation;
  return <div className="sf" data-field-id="orientation" data-kind="radio">
    <div style={{display: 'flex', gap: 10}} role="radiogroup" aria-label="Orientation">
      {(['portrait', 'landscape'] as const).map(o => <button key={o} type="button" role="radio" aria-checked={v === o}
        className={`sf-button${v === o ? ' is-selected' : ''}`} style={{display: 'grid', justifyItems: 'center', gap: 4, padding: '8px 14px', minWidth: 92, height: 'auto',
          outline: v === o ? '2px solid var(--accent, #2f6fdf)' : undefined}} onClick={() => set('orientation', o)}>
        <Icon id={o === 'portrait' ? 'page-portrait' : 'page-landscape'} size={32}/>
        <span>{o === 'portrait' ? 'Portrait' : 'Landscape'}</span>
      </button>)}
    </div>
  </div>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d) as Preview | null;
  const page = d.spec.tabs[d.tab]?.name ?? 'Margins';
  const mirror = d.values.multiplePages === 'mirror';
  return <div className="gd-fields" data-dialog-page={page}>
    <PageTabs dialog={d}/>
    {page === 'Margins' ? <>
      <Group title="Margins">
        <div style={grid('repeat(2, minmax(0, 1fr))')}>
          <Field d={d} id="top" set={set}/><Field d={d} id="bottom" set={set}/>
          <div aria-label={mirror ? 'Inside' : 'Left'}><Field d={d} id="left" set={set}/></div>
          <div aria-label={mirror ? 'Outside' : 'Right'}><Field d={d} id="right" set={set}/></div>
          <Field d={d} id="gutter" set={set}/><div/>
        </div>
        {mirror ? <small className="sf-note">With mirror margins, Left is the inside margin and Right the outside one.</small> : null}
      </Group>
      <Group title="Orientation"><Orientation d={d} set={set}/></Group>
      <Group title="Pages"><div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}><Field d={d} id="multiplePages" set={set}/><div/></div></Group>
    </> : null}
    {page === 'Paper' ? <Group title="Paper size">
      <div style={grid('minmax(0, 1.4fr) minmax(0, 1fr)')}><Field d={d} id="paperSize" set={set}/><div/></div>
      <div style={grid('repeat(2, minmax(0, 1fr))', {marginTop: 10})}><Field d={d} id="width" set={set}/><Field d={d} id="height" set={set}/></div>
    </Group> : null}
    {page === 'Layout' ? <>
      <Group title="Headers and footers">
        <div style={{display: 'grid', gap: 7}}><Field d={d} id="oddEven" set={set}/><Field d={d} id="firstPage" set={set}/></div>
      </Group>
      <Group title="Page">
        <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}><Field d={d} id="verticalAlignment" set={set}/><div/></div>
      </Group>
      <div className="gd-buttons"><Field d={d} id="lineNumbers" set={set}/></div>
    </> : null}
    {page === 'Document Grid' ? <>
      <Group title="Text flow"><Field d={d} id="sectionDirection" set={set}/></Group>
      <Group title="Grid"><Field d={d} id="grid" set={set}/></Group>
      <div style={grid('repeat(2, minmax(0, 1fr))')}><Field d={d} id="charsPerLine" set={set}/><Field d={d} id="linesPerPage" set={set}/></div>
    </> : <PagePreview p={p}/>}
  </div>;
}

export default {Body};
