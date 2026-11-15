// A ribbon group (docs/architecture.md section 8.1): its controls arranged exactly as the layout
// overlay declares (Large, Stack, Rows, Gallery primitives; no automatic flow), the label at the
// bottom with the optional launcher in its corner, and the collapsed form: one drop-down button
// that opens the whole group (wordcraft ribbon_fit.rs COLLAPSED).

import {useRef} from 'react';
import {useEngine} from '../engine/EngineProvider';
import {useShellState} from '../engine/useCommand';
import {Glyph, Icon, hasIcon} from '../icons/Icon';
import {Flyout} from '../common/Flyout';
import {RibbonControl, InlineGallery, useMeasuring} from './controls';
import {layoutAt, FULL, type Level} from './fit';
import {isControl, displayLabel, splitLabel} from '../model';
import type {RibbonGroup as Group} from '../model';
import {SHOW_PENDING} from '../env';

export function RibbonGroupView({group, level, inFlyout = false}: {group: Group; level: Level; inFlyout?: boolean}) {
  const {controller} = useEngine();
  const measuring = useMeasuring();
  const control = (id: string) => controller.model?.controls.get(id) ?? null;
  const keep = (id: string) => { const c = control(id); return !!c && controller.shows(c); };
  const items = layoutAt(group.layout, level, keep, id => hasIcon(control(id)?.icon));
  const launcher = group.launcher && (controller.launcherImplemented(group) || SHOW_PENDING) ? group.launcher : null;
  const launcherPending = !!launcher && !controller.launcherImplemented(group);
  const pending = !group.controls.some(c => isControl(c) && controller.isImplemented(c));
  return <div className={`rg${pending ? ' is-pending' : ''}${inFlyout ? ' in-flyout' : ''}`} role="group" aria-label={group.label} data-group-id={group.id} data-level={level}>
    <div className="rg-body">
      {items.map((it, i) => {
        if (it.kind === 'separator') return <span key={`s${i}`} className="rg-sep" role="separator"/>;
        if (it.kind === 'large') { const c = control(it.id)!; return <RibbonControl key={c.id} c={c} size="large"/>; }
        if (it.kind === 'gallery') {
          const c = control(it.id)!;
          return it.inline ? <InlineGallery key={c.id} c={c} columns={it.columns}/> : <div key={c.id} className="rb-col" data-count={1}><RibbonControl c={c} size={level >= 2 && hasIcon(c.icon) ? 'small' : 'medium'}/></div>;
        }
        if (it.kind === 'column') {
          return <div key={`c${i}`} className={`rb-col${it.header ? ' has-header' : ''}`} data-count={it.items.length}>
            {it.header ? <span className="rb-col-header" role="presentation">{it.header}</span> : null}
            {it.items.map(x => { const c = control(x.id)!; return <RibbonControl key={c.id} c={c} size={x.size} width={group.widths?.[c.id]}/>; })}
          </div>;
        }
        return <div key={`r${i}`} className="rb-rows" data-rows={it.rows.length}>
          {it.rows.map((row, j) => <div key={j} className="rb-row">
            {row.map(x => { const c = control(x.id)!; return <RibbonControl key={c.id} c={c} size={x.size} width={group.widths?.[c.id]}/>; })}
          </div>)}
        </div>;
      })}
    </div>
    <div className="rg-label">
      <span>{group.label}</span>
      {launcher ? <button type="button" className={`rg-launcher${launcherPending ? ' is-pending' : ''}`} aria-label={`${group.label} settings`}
        data-tip={`${group.label} settings`} data-tip-desc={launcherPending ? `Not translated yet: ${launcher.dialog ?? launcher.pane ?? launcher.command}` : (launcher.dialog ? 'Show the dialog' : launcher.pane ? 'Show the pane' : undefined)}
        data-pending={launcherPending ? 'true' : undefined} data-keytip-id={`#launcher:${group.key}`}
        onClick={() => { if (!measuring) void controller.launch(group.key); }}><Glyph name="launcher" size={10}/></button> : null}
    </div>
  </div>;
}

/** A group folded into one button; its drop-down shows the whole group as designed. */
export function CollapsedGroup({group}: {group: Group}) {
  const {controller} = useEngine();
  const state = useShellState();
  const measuring = useMeasuring();
  const anchor = useRef<HTMLButtonElement>(null);
  const open = !measuring && state.groupMenu === group.key;
  const first = group.controls.find(c => isControl(c) && hasIcon(c.icon));
  const icon = group.collapsedIcon && hasIcon(group.collapsedIcon) ? group.collapsedIcon : first && isControl(first) ? first.icon : null;
  const pending = !group.controls.some(c => isControl(c) && controller.isImplemented(c));
  return <div className={`rg rg-collapsed${pending ? ' is-pending' : ''}`} role="group" aria-label={group.label} data-group-id={group.id} data-level={3}>
    <button ref={anchor} type="button" className={`rb rb-large rb-menu${open ? ' is-open' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-label={group.label}
      data-tip={group.label} data-keytip-id={`#group:${group.key}`} onClick={() => { if (!measuring) controller.setGroupMenu(open ? null : group.key); }}>
      <span className="rb-large-icon">{icon ? <Icon id={icon} size={32}/> : <span className="rb-mono" aria-hidden="true">{displayLabel({label: group.label}).slice(0, 2)}</span>}</span>
      {/* Office wraps a long group name onto two lines under the icon, the caret after the second (splitLabel). */}
      <span className="rb-large-label">{(() => { const [a, b] = splitLabel(group.label); return b === null
        ? <span>{a}<Glyph name="chevron-down" size={9}/></span>
        : <><span>{a}</span><span>{b}<Glyph name="chevron-down" size={9}/></span></>; })()}</span>
    </button>
    <div className="rg-label rg-label-empty"/>
    {!measuring ? <Flyout anchor={anchor} open={open} onClose={() => controller.setGroupMenu(null)} role="dialog" label={group.label} className="is-group" initialFocus>
      <RibbonGroupView group={group} level={FULL} inFlyout/>
    </Flyout> : null}
  </div>;
}
