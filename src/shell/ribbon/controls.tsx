// Ribbon controls (docs/architecture.md section 8.1): buttons in three sizes (large: 32 px icon with
// the label under it; medium: 16 px icon and label; small: icon only), toggles, split buttons,
// drop-down menus, galleries, editable combos, spinners and color splits. Every control renders
// data-control-id, aria-label, aria-pressed/aria-expanded and a rich tooltip, and runs through
// ShellController.activate, the same path the bridge's ui.activate takes.

import type {ReactNode, RefObject} from 'react';
import {createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import type {SpecControl, SpecMenuEntry} from '../../generated/spec-types';
import {toCommandError} from '../../../core/kernel/errors.mjs';
import {useEngine} from '../engine/EngineProvider';
import {useControlState} from '../engine/useCommand';
import {Icon, Glyph, hasIcon, fallbackGlyph} from '../icons/Icon';
import {Flyout, VirtualList, useFonts, type Placement} from '../common/Flyout';
import {ColorPalette} from '../common/ColorPalette';
import {displayLabel, splitLabel, isControl, isFontCombo, isSizeCombo, FONT_SIZES, placeholderKind, concreteArgs} from '../model';
import type {Size} from './fit';
import {SHOW_PENDING, platform} from '../env';
import {ShapeGallery, isShapePicker} from './ShapeGallery';
import {TableGridPicker, isTableGridPicker} from './TableGridPicker';
import {TileArt, type TileArtData} from './TileArt';
import {TileMenu, type TileEntry} from './TileMenu';

/** True inside the hidden measurement pass: controls draw without reading state or opening anything. */
export const MeasureContext = createContext(false);
export const useMeasuring = () => useContext(MeasureContext);
/** Where a control's drop-down opens (below in the ribbon; an app chrome's vertical bars open them to the right). */
export const FlyoutPlacement = createContext<Placement | undefined>(undefined);

export function shortcutText(s: string | null | undefined): string | null {
  if (!s) return null;
  const first = s.split(/\s+\/\s+|\s+or\s+/)[0].replace(/\s*\([^)]*\)/g, '').trim();
  if (!first) return null;
  return platform() === 'mac' ? first.replace(/\bMod\b|\bCtrl\b/g, '⌘').replace(/\bAlt\b/g, '⌥').replace(/\bShift\b/g, '⇧').replace(/\+/g, '') : first.replace(/\bMod\b/g, 'Ctrl');
}

/** A font name that is not an installed font (Keep source fonts) is shown in the interface font, not the browser's serif. */
const UI_FONT = 'var(--ark-font, system-ui, sans-serif)';
const isColorish = (c: SpecControl) => c.type === 'color' || c.type === 'palette'
  || (c.type === 'split' && (c.items ?? []).some(k => isControl(k) && (k.type === 'palette' || k.type === 'color')));
const hasMenu = (c: SpecControl) => (c.items ?? []).some(isControl);

/** Shared props and handlers for a control. */
function useControl(c: SpecControl) {
  const {controller} = useEngine();
  const measuring = useMeasuring();
  const st = useControlState(c, measuring);
  // A control that shows its value beside its name (Word's "Style: APA"); measured with a typical value.
  // A toggle Word renames while it is on (Split, then Remove Split).
  const named = typeof c.checkedLabel === 'string' && !measuring && st.checked ? c.checkedLabel : displayLabel(c);
  const label = c.valueLabel ? `${named}: ${measuring ? 'Turabian' : typeof st.value === 'string' ? st.value : ''}` : named;
  const desc = st.pending ? `Not translated yet: ${c.command ?? c.dialog ?? c.id}` : !st.enabled && st.reason ? st.reason : controller.command(c.command)?.description ?? null;
  const tip = {'data-tip': label, 'data-tip-keys': shortcutText(c.shortcut) ?? undefined, 'data-tip-desc': desc ?? undefined, 'data-pending': st.pending ? 'true' : undefined};
  const common = {'data-control-id': c.id, 'data-keytip-id': c.id, 'aria-label': label, ...tip};
  const open = !measuring && controller.getState().menu === c.id;
  const placement = useContext(FlyoutPlacement);
  const activate = (value?: unknown) => {
    if (measuring || st.pending || !st.enabled) return;
    controller.activate(c.id, value === undefined ? {} : {value}).catch(e => controller.notify(toCommandError(e).message, 'error'));
  };
  const toggleMenu = () => { if (!measuring) controller.setMenu(open ? null : c.id); };
  const closeMenu = () => { if (controller.getState().menu === c.id) controller.setMenu(null); };
  const disabled = st.pending || !st.enabled;
  return {controller, st, label, common, open, activate, toggleMenu, closeMenu, disabled, measuring, placement};
}

function accentOf(c: SpecControl, value: unknown, last?: string): string | null {
  if (!isColorish(c)) return null;
  if (typeof value === 'string' && /^#|^rgb/i.test(value)) return value;
  return last ?? (/highlight/i.test(c.id) ? '#FFFF00' : /fill|shading/i.test(c.id) ? '#FFC000' : /font-color|text/i.test(c.id) ? '#FF0000' : null);
}

/** The icon slot; a large control without an icon keeps its 32 px slot with a neutral mark in development. */
function IconSlot({c, size, accent}: {c: SpecControl; size: 16 | 32; accent?: string | null}) {
  if (hasIcon(c.icon)) return <Icon id={c.icon} size={size} accent={accent}/>;
  if (size === 32) {
    const letters = displayLabel(c).replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '·';
    return <span className="rb-mono" aria-hidden="true">{letters}{accent ? <i style={{background: accent}}/> : null}</span>;
  }
  if (accent) return <span className="rb-swatch-mark" aria-hidden="true" style={{background: accent}}/>;
  const glyph = fallbackGlyph(c.command);
  return glyph ? <Glyph name={glyph} size={15}/> : null;
}

// ---------------------------------------------------------------------------------------------
// The dispatcher

export function RibbonControl({c, size, width}: {c: SpecControl; size: Size; width?: number}) {
  const {controller} = useEngine();
  if (!controller.shows(c)) return null;
  if (c.kind === 'checkbox') return <CheckboxControl c={c}/>;
  switch (c.type) {
    case 'combo': return <ComboControl c={c} width={width}/>;
    case 'spinner': return <SpinnerControl c={c} width={width}/>;
    case 'label': return <span className="rb-label" data-control-id={c.id}>{displayLabel(c)}</span>;
    case 'gallery': return <MenuButton c={c} size={size} gallery/>;
    case 'group': return <span className="rb-inline-group" data-control-id={c.id}>{(c.items ?? []).filter(isControl).map(k => <RibbonControl key={k.id} c={k} size="small"/>)}</span>;
    default:
      if (isColorish(c)) return <ColorSplit c={c} size={size}/>;
      if (c.type === 'split' && hasMenu(c)) return <SplitButton c={c} size={size}/>;
      if (c.type === 'menu' || (c.type === 'split' && !c.command) || (!c.command && !c.dialog && hasMenu(c))) return <MenuButton c={c} size={size}/>;
      return <Button c={c} size={size}/>;
  }
}

// ---------------------------------------------------------------------------------------------
// Buttons and toggles

export function Button({c, size}: {c: SpecControl; size: Size}) {
  const x = useControl(c);
  const toggle = c.type === 'toggle';
  const pressed = toggle ? x.st.checked === 'mixed' ? 'mixed' as const : !!x.st.checked : undefined;
  const iconless = !hasIcon(c.icon) && !fallbackGlyph(c.command);
  // A pen button (Excel's Draw tab) carries its ink colour in the pen's tip.
  const penColor = (c.args as {color?: unknown} | null)?.color;
  const ink = toggle && typeof penColor === 'string' && /^#[0-9a-f]{6}$/i.test(penColor) ? penColor : null;
  const cls = `rb rb-${size}${pressed === true ? ' is-checked' : ''}${x.disabled ? ' is-disabled' : ''}${x.st.pending ? ' is-pending' : ''}${iconless ? ' is-iconless' : ''}`;
  return <button type="button" className={cls} {...x.common} aria-pressed={pressed} aria-disabled={x.disabled || undefined}
    onClick={() => x.activate()}>
    {size === 'large' ? <LargeFace c={c} label={x.label} accent={ink}/> : <><IconSlot c={c} size={16} accent={ink}/>{size === 'medium' || iconless ? <span className="rb-text">{x.label}</span> : null}</>}
  </button>;
}

/** Office's ribbon check box (View > Show > Ruler, Table Style Options > Header Row): a box and its label. */
export function CheckboxControl({c}: {c: SpecControl}) {
  const x = useControl(c);
  const checked = x.st.checked === 'mixed' ? 'mixed' as const : !!x.st.checked;
  return <button type="button" role="checkbox" className={`rb rb-check${x.disabled ? ' is-disabled' : ''}${x.st.pending ? ' is-pending' : ''}`} {...x.common}
    aria-checked={checked} aria-disabled={x.disabled || undefined} onClick={() => x.activate(!checked)}>
    <span className={`rb-check-box${checked === true ? ' is-on' : checked === 'mixed' ? ' is-mixed' : ''}`} aria-hidden="true">
      {checked === true ? <Glyph name="check" size={11}/> : null}
    </span>
    <span className="rb-text">{x.label}</span>
  </button>;
}

function LargeFace({c, label, caret = false, accent}: {c: SpecControl; label: string; caret?: boolean; accent?: string | null}) {
  const [a, b] = splitLabel(label);
  return <>
    <span className="rb-large-icon"><IconSlot c={c} size={32} accent={accent}/></span>
    <span className="rb-large-label"><span>{a}</span>{b !== null || caret ? <span>{b}{caret ? <Glyph name="chevron-down" size={9}/> : null}</span> : null}</span>
  </>;
}

// ---------------------------------------------------------------------------------------------
// Split buttons (primary part runs the command with args, the arrow opens the items)

export function SplitButton({c, size}: {c: SpecControl; size: Size}) {
  const x = useControl(c);
  const anchor = useRef<HTMLDivElement>(null);
  // A split whose command reports a check (the tool in use: Draw, Highlight) shows it on its main part.
  const checked = x.st.checked === true;
  const cls = `rb-split rb-split-${size}${checked ? ' is-checked' : ''}${x.disabled ? ' is-disabled' : ''}${x.st.pending ? ' is-pending' : ''}${x.open ? ' is-open' : ''}${!hasIcon(c.icon) ? ' is-iconless' : ''}`;
  return <div ref={anchor} className={cls} {...x.common} role="group">
    <button type="button" className="rb-split-main" aria-label={x.label} aria-disabled={x.disabled || undefined} aria-pressed={checked || undefined} onClick={() => x.activate()} data-tip={x.label}
      data-tip-keys={x.common['data-tip-keys']} data-tip-desc={x.common['data-tip-desc']} data-pending={x.common['data-pending']}>
      {size === 'large' ? <span className="rb-large-icon"><IconSlot c={c} size={32}/></span> : <><IconSlot c={c} size={16}/>{size === 'medium' || !hasIcon(c.icon) ? <span className="rb-text">{x.label}</span> : null}</>}
    </button>
    <button type="button" className="rb-split-arrow" aria-label={`${x.label} options`} aria-haspopup="menu" aria-expanded={x.open}
      onClick={x.toggleMenu} data-tip={x.label} data-pending={x.common['data-pending']}>
      {size === 'large' ? <span className="rb-large-label">{splitLabel(x.label).map((t, i) => t !== null ? <span key={i}>{t}{i === 1 || splitLabel(x.label)[1] === null ? <Glyph name="chevron-down" size={9}/> : null}</span> : null)}</span>
        : <Glyph name="chevron-down" size={9}/>}
    </button>
    {!x.measuring ? <Flyout anchor={anchor} open={x.open} onClose={x.closeMenu} label={x.label} placement={x.placement}><MenuList entries={c.items ?? []} onDone={x.closeMenu}/></Flyout> : null}
  </div>;
}

// ---------------------------------------------------------------------------------------------
// Drop-down menus and drop-down galleries

export function MenuButton({c, size, gallery = false}: {c: SpecControl; size: Size; gallery?: boolean}) {
  const x = useControl(c);
  const anchor = useRef<HTMLButtonElement>(null);
  const items = c.items ?? [];
  // A gallery that sits small in a stack (WordArt Styles) opens under its whole group, as a drop-down does, not over the rows below it.
  const under = useMemo(() => ({get current() { return gallery && size !== 'large' ? anchor.current?.closest<HTMLElement>('.rg') ?? anchor.current : anchor.current; }}) as RefObject<HTMLElement | null>, [gallery, size]);
  const cls = `rb rb-${size} rb-menu${x.open ? ' is-open' : ''}${x.disabled ? ' is-disabled' : ''}${x.st.pending ? ' is-pending' : ''}${!hasIcon(c.icon) ? ' is-iconless' : ''}`;
  return <>
    <button ref={anchor} type="button" className={cls} {...x.common} aria-haspopup="menu" aria-expanded={x.open} aria-disabled={x.disabled || undefined}
      onClick={() => { if (x.disabled) return; if (!items.some(isControl) && !gallery && (c.command || c.dialog)) x.activate(); else x.toggleMenu(); }}>
      {size === 'large' ? <LargeFace c={c} label={x.label} caret/> : <><IconSlot c={c} size={16}/>{size === 'medium' || !hasIcon(c.icon) ? <span className="rb-text">{x.label}</span> : null}<Glyph name="chevron-down" size={9}/></>}
    </button>
    {!x.measuring ? <Flyout anchor={under} open={x.open} onClose={x.closeMenu} label={x.label} placement={x.placement} className={gallery ? 'is-gallery' : undefined}>
      {isShapePicker(c) ? <ShapeGallery c={c} onDone={x.closeMenu}/> : <>
        {gallery ? <GalleryGrid c={c} onDone={x.closeMenu}/> : null}
        <MenuList entries={gallery ? galleryMenuEntries(c, x.st.value) : items} onDone={x.closeMenu}/>
      </>}
    </Flyout> : null}
  </>;
}

/** Menu entries: headers, separators, buttons, toggles (check marks), submenus and inline palettes. */
export function MenuList({entries, onDone}: {entries: SpecMenuEntry[]; onDone: () => void}) {
  const {controller} = useEngine();
  // A command whose state says `hidden` is left out where it does not apply (Excel's Show Details only on a PivotTable value cell).
  const visible = entries.filter(e => !isControl(e) || (controller.shows(e) && !(controller.controlState(e) as {hidden?: boolean}).hidden));
  const cleaned = visible.filter((e, i, a) => !('separator' in e) || (i > 0 && i < a.length - 1 && !('separator' in a[i - 1])));
  if (!cleaned.some(isControl)) return null;
  // Entries styled `tile` that follow each other sit in one row of icon tiles under their header (`section` on the first): OneNote's Paste Options.
  const isTile = (e: SpecMenuEntry | undefined): e is SpecControl => !!e && isControl(e) && e.style === 'tile';
  // One submenu open at a time: moving from Bullets to Numbering closed nothing (the row only closed its submenu when the pointer left every
  // menu, and the menu it moved within is one), so both stayed open, both rows lit, and Numbering's formats showed beside Bullets.
  const [openSub, setOpenSub] = useState<string | null>(null);
  const out: ReactNode[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const e = cleaned[i];
    if (isTile(e)) {
      const run: SpecControl[] = [];
      while (isTile(cleaned[i])) run.push(cleaned[i++] as SpecControl);
      i--;
      out.push(<div key={`t${run[0].id}`} role="group" aria-label={String(run[0].section ?? 'Options')}>
        {run[0].section ? <div className="shell-menu-header" role="presentation">{String(run[0].section)}</div> : null}
        <div className="shell-menu-tiles">{run.map(c => <MenuTile key={c.id} c={c} onDone={onDone}/>)}</div>
      </div>);
    } else if (isControl(e)) {
      const id = e.id;
      out.push(<MenuItem key={id} c={e} onDone={onDone} sub={openSub === id} setSub={open => setOpenSub(cur => (open ? id : cur === id ? null : cur))}
        onHover={() => setOpenSub(cur => (cur === id ? cur : null))}/>);
    }
    else if ('separator' in e) out.push(<div key={`s${i}`} className="shell-menu-sep" role="separator"/>);
    else out.push(<div key={`h${i}`} className="shell-menu-header" role="presentation">{String((e as {header: string}).header)}</div>);
  }
  return <div className="shell-menu" role="none">{out}</div>;
}

/** An icon tile of a menu (Paste Options): the control's icon over its short label, tooltip with the full name. */
function MenuTile({c, onDone}: {c: SpecControl; onDone: () => void}) {
  const {controller} = useEngine();
  const st = useControlState(c);
  const disabled = st.pending || !st.enabled;
  const label = displayLabel(c);
  const run = () => { if (disabled) return; onDone(); controller.activate(c.id).catch(e => controller.notify(toCommandError(e).message, 'error')); };
  return <div className={`shell-menu-tile${disabled ? ' is-disabled' : ''}`} role="menuitem" tabIndex={-1} data-control-id={c.id} aria-label={label} data-tip={label} aria-disabled={disabled || undefined}
    onClick={run} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } }}>
    <Icon id={c.icon} size={32}/>
    <span>{label.replace(/\s*Formatting$/, '')}</span>
  </div>;
}

/** A menu row. Its submenu's open state belongs to the list (`sub`, `setSub`), so opening one closes the others; `onHover` closes a
 * sibling's submenu when the pointer moves onto a row without one. */
function MenuItem({c, onDone, sub, setSub, onHover}: {c: SpecControl; onDone: () => void; sub: boolean; setSub: (open: boolean) => void; onHover: () => void}) {
  const {controller} = useEngine();
  const st = useControlState(c);
  const asked = useSyncExternalStore(controller.subscribe, () => controller.getState().menuSub === c.id);
  useEffect(() => { if (asked) { setSub(true); controller.setMenu(controller.getState().menu, null); } }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = useRef<HTMLDivElement>(null);
  const label = displayLabel(c);
  const disabled = st.pending || !st.enabled;
  if (isTableGridPicker(c)) return <TableGridPicker c={c} onDone={onDone}/>;
  if (c.type === 'palette' || c.type === 'color') {
    const parent = controller.model?.parent.get(c.id);
    const owner = parent ? controller.model?.controls.get(parent) : null;
    return <div className={`shell-menu-palette${st.pending ? ' is-pending' : ''}`} data-control-id={c.id}>
      <ColorPalette value={typeof st.value === 'string' ? st.value : null} automatic={/highlight|fill|shading|background|page-color/i.test(c.id) ? 'No Color' : 'Automatic'}
        onPick={hex => { onDone(); controller.activate(st.pending && owner ? owner.id : c.id, {value: hex ?? 'auto'}).catch(e => controller.notify(toCommandError(e).message, 'error')); }}
        onMore={() => { onDone(); moreColors(controller, owner?.id ?? c.id, typeof st.value === 'string' ? st.value : null); }}/>
    </div>;
  }
  const children = (c.items ?? []).filter(isControl);
  // A shape picker in a submenu (Crop > Crop to Shape): the flyout is the Shapes gallery, each tile running the control with that shape.
  const shapeMenu = isShapePicker(c) && !children.length;
  // A gallery in a submenu (Shape Effects › Preset, 3-D Rotation, Shape Fill › Texture): its tiles come from the command's state and open beside the row.
  const galleryMenu = c.type === 'gallery' && !children.length && !shapeMenu && Array.isArray(st.value) && st.value.length > 0;
  const hasSub = children.length > 0 || shapeMenu || galleryMenu;
  const role = c.type === 'toggle' ? 'menuitemcheckbox' : 'menuitem';
  const run = () => {
    if (disabled) return;
    if (shapeMenu || galleryMenu || (children.length && !c.command)) { setSub(true); return; }
    onDone();
    controller.activate(c.id).catch(e => controller.notify(toCommandError(e).message, 'error'));
  };
  // A list the command's state fills (Insert Citation's sources): one entry per item, each runs the control with its value.
  if (c.dynamic) {
    const list = Array.isArray(st.value) ? st.value as {id?: unknown; label?: unknown; value?: unknown}[] : [];
    // `tiles`: the entries are pictures in a grid under group headings (Conditional Formatting's Data Bars, Color Scales, Icon Sets).
    const tiles = Number((c as {tiles?: unknown}).tiles);
    if (tiles > 0) return <TileMenu controlId={c.id} entries={list as TileEntry[]} columns={tiles} disabled={disabled}
      onPick={value => { if (disabled) return; onDone(); controller.activate(c.id, {value}).catch(e => controller.notify(toCommandError(e).message, 'error')); }}/>;
    return <>{list.map((it, i) => <div key={String(it.id ?? i)} className={`shell-menu-item${disabled ? ' is-disabled' : ''}${c.style === 'strong' ? ' is-strong' : ''}`} role="menuitem" tabIndex={-1}
      data-control-id={c.id} data-item={String(it.id ?? i)} onClick={() => { if (disabled) return; onDone(); controller.activate(c.id, {value: it.value}).catch(e => controller.notify(toCommandError(e).message, 'error')); }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDone(); controller.activate(c.id, {value: it.value}).catch(err => controller.notify(toCommandError(err).message, 'error')); } }}>
      <span className="shell-menu-check">{(it as {checked?: unknown}).checked ? <Glyph name="check" size={12}/> : typeof (it as {checked?: unknown}).checked === 'boolean' ? null : hasIcon(c.icon) ? <Icon id={c.icon} size={16}/> : null}</span>
      {(it as {art?: TileArtData}).art ? <span className="shell-menu-art"><TileArt art={(it as {art: TileArtData}).art}/></span> : null}
      <span className="shell-menu-label">{String(it.label ?? it.value ?? '')}</span>
    </div>)}</>;
  }
  // A gallery entry drawn as a picture of what it inserts (Word's Built-In Table of Contents and Bibliography).
  if (c.thumb && typeof c.thumb === 'object') {
    return <div className={`shell-menu-item shell-menu-thumb${disabled ? ' is-disabled' : ''}`} role="menuitem" tabIndex={-1} data-control-id={c.id} aria-label={label}
      onClick={run} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } }}>
      <span className="shell-menu-thumb-label">{label}</span>
      <MenuThumb thumb={c.thumb as Thumb}/>
    </div>;
  }
  return <div ref={ref} className={`shell-menu-item${disabled ? ' is-disabled' : ''}${st.pending ? ' is-pending' : ''}${sub ? ' is-open' : ''}`} role={role} tabIndex={-1}
    aria-checked={c.type === 'toggle' ? !!st.checked : undefined} aria-disabled={disabled || undefined} aria-haspopup={hasSub ? 'menu' : undefined}
    aria-expanded={hasSub ? sub : undefined} data-control-id={c.id} data-tip={st.pending ? label : undefined}
    data-tip-desc={st.pending ? `Not translated yet: ${c.command ?? c.dialog ?? c.id}` : undefined} data-pending={st.pending ? 'true' : undefined}
    onClick={run} onMouseEnter={() => (hasSub ? setSub(true) : onHover())} onMouseLeave={e => { if (!(e.relatedTarget as Element)?.closest?.('.shell-flyout')) setSub(false); }}
    onKeyDown={e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); }
      else if (e.key === 'ArrowRight' && hasSub) { e.preventDefault(); setSub(true); }
    }}>
    <span className="shell-menu-check">{c.type === 'toggle' && st.checked ? <Glyph name="check" size={12}/> : hasIcon(c.icon) ? <Icon id={c.icon} size={16}/> : <MenuSample c={c}/>}</span>
    <span className="shell-menu-label">{label}</span>
    <span className="shell-menu-keys">{shortcutText(c.shortcut)}</span>
    {hasSub ? <span className="shell-menu-sub"><Glyph name="chevron-right" size={10}/></span> : null}
    {hasSub ? <Flyout anchor={ref} open={sub} onClose={() => setSub(false)} placement="right" label={label} initialFocus={false}>
      <div onKeyDown={e => { if (e.key === 'ArrowLeft') { e.stopPropagation(); setSub(false); ref.current?.focus(); } }}>{shapeMenu ? <ShapeGallery c={c} onDone={onDone}/> : galleryMenu ? <GalleryGrid c={c} onDone={onDone} columns={c.id.includes('texture') ? 6 : 5}/> : <MenuList entries={c.items ?? []} onDone={onDone}/>}</div>
    </Flyout> : null}
  </div>;
}

/** A page drawn small: the part of it a gallery entry fills (header, footer, margin, in the text, the cover, a text box) and the text in it. */
type PageThumb = {part: 'header' | 'footer' | 'margin' | 'inline' | 'cover' | 'textbox'; cells?: ['left' | 'center' | 'right', string][]};
type Thumb = {title?: string; lines?: [number, string, string][]; leader?: string; page?: PageThumb};

/** Header, Footer, Page Number, Cover Page and Text Box galleries: the entry as a strip of the page it inserts into, as Word draws them. */
function PageStrip({page}: {page: PageThumb}) {
  const w = 236;
  const body = (y0: number, n: number) => Array.from({length: n}, (_, i) => <rect key={i} x={20} y={y0 + i * 7} width={i === n - 1 ? 110 : 196} height={2.4} rx={1.2} fill="#c9ccd4"/>);
  const cell = (x: 'left' | 'center' | 'right', text: string, y: number, key: number) => <text key={key} x={x === 'left' ? 20 : x === 'right' ? w - 20 : w / 2} y={y} fontSize={9} fontFamily="Segoe UI, sans-serif"
    textAnchor={x === 'left' ? 'start' : x === 'right' ? 'end' : 'middle'} fill={text.startsWith('[') ? '#1f4e8c' : '#222'}>{text}</text>;
  if (page.part === 'cover') {
    return <svg className="shell-menu-thumb-art" viewBox="0 0 120 150" width={120} height={150} aria-hidden="true" focusable="false">
      <rect x={0.5} y={0.5} width={119} height={149} rx={2} fill="#fff" stroke="var(--shell-border, #d0d0d6)"/>
      <rect x={0} y={26} width={120} height={4} fill="#156082"/>
      <text x={14} y={64} fontSize={13} fontWeight={700} fontFamily="Segoe UI, sans-serif" fill="#156082">{page.cells?.[0]?.[1] ?? '[Document title]'}</text>
      <rect x={14} y={72} width={66} height={2.4} fill="#c9ccd4"/><rect x={14} y={80} width={48} height={2.4} fill="#c9ccd4"/>
      <text x={14} y={128} fontSize={7.5} fontFamily="Segoe UI, sans-serif" fill="#555">[Author]  ·  [Date]</text>
    </svg>;
  }
  if (page.part === 'textbox') {
    return <svg className="shell-menu-thumb-art" viewBox="0 0 120 76" width={120} height={76} aria-hidden="true" focusable="false">
      <rect x={0.5} y={0.5} width={119} height={75} rx={2} fill="#fff" stroke="var(--shell-border, #d0d0d6)"/>
      <rect x={20} y={14} width={80} height={48} fill="#fff" stroke="#222" strokeWidth={0.8}/>
      {[24, 31, 38].map(y => <rect key={y} x={26} y={y} width={68} height={2.4} rx={1.2} fill="#c9ccd4"/>)}
    </svg>;
  }
  const h = 64;
  const cells = page.cells ?? [];
  return <svg className="shell-menu-thumb-art" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
    <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={2} fill="#fff" stroke="var(--shell-border, #d0d0d6)"/>
    {page.part === 'header' ? <>{cells.map(([x, text], i) => cell(x, text, 20, i))}<line x1={20} x2={w - 20} y1={27} y2={27} stroke="#9aa3b2" strokeWidth={0.8}/>{body(36, 3)}</> : null}
    {page.part === 'footer' ? <>{body(8, 3)}<line x1={20} x2={w - 20} y1={37} y2={37} stroke="#9aa3b2" strokeWidth={0.8}/>{cells.map(([x, text], i) => cell(x, text, 52, i))}</> : null}
    {page.part === 'margin' ? <>{body(10, 5)}<text x={w - 8} y={30} fontSize={10} fontWeight={600} textAnchor="end" fontFamily="Segoe UI, sans-serif" fill="#1f4e8c">{cells[0]?.[1] ?? '1'}</text></> : null}
    {page.part === 'inline' ? <>{body(10, 2)}<text x={20} y={37} fontSize={9} fontFamily="Segoe UI, sans-serif" fill="#222">Text <tspan fontWeight={700} fill="#1f4e8c">{cells[0]?.[1] ?? '1'}</tspan> text</text>{body(44, 2)}</> : null}
  </svg>;
}

/** The picture of a gallery entry: its title as a heading, then its lines (indent level, text, page) with the leader; or a page strip. */
function MenuThumb({thumb}: {thumb: Thumb}) {
  if (thumb.page) return <PageStrip page={thumb.page}/>;
  const w = 236, row = 13, top = thumb.title ? 22 : 6;
  const lines = thumb.lines ?? [];
  const h = top + row * lines.length + 6;
  return <svg className="shell-menu-thumb-art" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
    <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={2} fill="#fff" stroke="var(--shell-border, #d0d0d6)"/>
    {thumb.title ? <text x={10} y={16} fontSize={11.5} fontWeight={600} fill="#1f4e8c" fontFamily="Segoe UI, sans-serif">{thumb.title}</text> : null}
    {lines.map(([level, text, page], i) => {
      const y = top + row * i + 9;
      const x = 10 + 10 * level;
      const tw = text.length * 4.25;
      return <g key={i} fontSize={8.5} fill="#222" fontFamily="Segoe UI, sans-serif">
        <text x={x} y={y}>{text}</text>
        {page ? <text x={w - 10} y={y} textAnchor="end">{page}</text> : null}
        {page && thumb.leader && w - 18 > x + tw + 6 ? <line x1={x + tw + 4} x2={w - 18} y1={y - 0.5} y2={y - 0.5} stroke="#777" strokeWidth={1} strokeDasharray="0.01 2.6" strokeLinecap="round"/> : null}
      </g>;
    })}
  </svg>;
}

const DASHES: Record<string, string> = {
  solid: '', 'round dot': '0.1 2.6', 'square dot': '1.4 1.4', dash: '4 2.5', 'dash dot': '4 2 1 2', 'long dash': '7 2.5', 'long dash dot': '7 2 1.5 2', 'long dash dot dot': '7 2 1.5 2 1.5 2',
};
/**
 * What Office draws in a value menu instead of an icon: the line at that weight, the dash pattern
 * or the bullet character. Null for anything else.
 */
export function menuSample(c: SpecControl): {kind: 'weight'; px: number} | {kind: 'dash'; array: string} | {kind: 'glyph'; text: string} | {kind: 'pen'; style: string} | null {
  // Word's table Line Style: each pen drawn as the line it makes (single, double, triple, dotted, dashed, dot-dash, thick, wave).
  const pen = c.command === 'table.pen' ? (c.args as {style?: unknown} | null)?.style : null;
  if (typeof pen === 'string' && pen !== 'none') return {kind: 'pen', style: pen};
  const label = displayLabel(c).trim();
  const pt = /^(\d+(?:\.\d+)?)\s*pt$/.exec(label);
  if (pt && /weight|width|thick|outline|border|line/i.test(c.id)) return {kind: 'weight', px: Math.max(0.5, Math.min(8, Number(pt[1]) * 1.33))};
  const dash = label.toLowerCase();
  if (Object.hasOwn(DASHES, dash) && /dash/i.test(c.id)) return {kind: 'dash', array: DASHES[dash]};
  const glyph = /^([•○■□▪◆➢✓–★◦●])(?:\s+Bullet)?$/u.exec(label);
  if (glyph) return {kind: 'glyph', text: glyph[1]};
  return null;
}
/** Picture Color (Muted, Gray, Vivid, Grayscale, Sepia, Washout and Color Tone's temperatures): a small picture drawn as the entry would recolour it. */
function recolorFilter(c: SpecControl): string | null {
  const a = (c.args ?? {}) as {mode?: string; saturation?: number; temperature?: number};
  if (c.command === 'picture.colorTone' && typeof a.temperature === 'number') {
    const w = Math.max(-1, Math.min(1, (a.temperature - 6500) / 5000));
    return w >= 0 ? `sepia(${(w * 0.7).toFixed(2)}) saturate(${(1 + w * 0.3).toFixed(2)})` : `hue-rotate(${(w * 28).toFixed(0)}deg) saturate(1.1) brightness(${(1 + w * 0.1).toFixed(2)})`;
  }
  if (c.command !== 'picture.color') return null;
  if (a.mode === 'saturation') return `saturate(${((a.saturation ?? 100) / 100).toFixed(2)})`;
  return ({grayscale: 'grayscale(1)', sepia: 'sepia(1)', washout: 'contrast(0.4) brightness(1.7)', blackAndWhite: 'grayscale(1) contrast(5)'} as Record<string, string>)[a.mode ?? ''] ?? null;
}

function MenuSample({c}: {c: SpecControl}) {
  const rf = recolorFilter(c);
  if (rf) return <svg className="shell-menu-line is-recolor" viewBox="0 0 30 20" width={30} height={20} aria-hidden="true" focusable="false" style={{filter: rf, borderRadius: 2}}>
    <rect width={30} height={20} fill="#9ec5f0"/><circle cx={22} cy={6} r={3.2} fill="#f6b73c"/><path d="M0 20V13Q8 7 15 12T30 11V20Z" fill="#3d9a47"/><path d="M0 20V16Q10 12 18 16T30 15V20Z" fill="#2c7a38"/>
  </svg>;
  // A colour entry (Page Color, Section Color...) is drawn as its colour.
  const color = (c.args as {color?: unknown} | null)?.color;
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
    return <svg className="shell-menu-line" viewBox="0 0 20 12" width={20} height={12} aria-hidden="true" focusable="false"><rect x={2} y={1} width={16} height={10} rx={2} fill={color} stroke="rgba(128,128,128,.7)"/></svg>;
  }
  const s = menuSample(c);
  if (!s) return null;
  if (s.kind === 'glyph') return <span className="shell-menu-glyph" aria-hidden="true">{s.text}</span>;
  if (s.kind === 'pen') {
    const st = s.style, one = (y: number, w: number, dash?: string) => <line key={y} x1={1} y1={y} x2={19} y2={y} stroke="currentColor" strokeWidth={w} strokeDasharray={dash}/>;
    return <svg className="shell-menu-line is-pen" viewBox="0 0 20 12" width={20} height={12} aria-hidden="true" focusable="false">
      {st === 'double' ? [4, 8].map(y => one(y, 1)) : st === 'triple' ? [3, 6, 9].map(y => one(y, 0.9))
        : st === 'dotted' ? one(6, 1.6, '1 1.6') : st === 'dashed' ? one(6, 1.5, '4 2.5') : st === 'dotDash' ? one(6, 1.5, '4 2 1 2') : st === 'thick' ? one(6, 3.2)
        : st === 'wave' ? <path d="M1 6 Q3.5 2 6 6 T11 6 T16 6 T19 6" fill="none" stroke="currentColor" strokeWidth={1.2}/> : one(6, 1.5)}
    </svg>;
  }  return <svg className="shell-menu-line" viewBox="0 0 20 12" width={20} height={12} aria-hidden="true" focusable="false">
    <line x1={1} y1={6} x2={19} y2={6} stroke="currentColor" strokeWidth={s.kind === 'weight' ? s.px : 1.5}
      strokeDasharray={s.kind === 'dash' && s.array ? s.array : undefined} strokeLinecap={s.kind === 'dash' && s.array.startsWith('0.1') ? 'round' : 'butt'}/>
  </svg>;
}

// ---------------------------------------------------------------------------------------------
// Galleries

/** `selected`: the tile is the current choice (else it is when the control's value equals the item's); `group`: a heading in the drop-down; `inline: false`: only in the drop-down, not the ribbon strip; `accent` colours the icon's accent part (a pen's ink); `bar` draws a pen's thickness under its icon; `iconOnly` draws the tile without its label. */
export interface GalleryItem { id: string; label: string; value: unknown; icon?: string | null; accent?: string | null; bar?: number | null; mathml?: string; iconOnly?: boolean; selected?: boolean; group?: string; inline?: boolean; art?: TileArtData; /** Text drawn in the tile in place of the Aa sample and the label (Insert > Symbol draws the character). */ sample?: string }
/** Gallery tiles: dynamic items from the command's state (value: [{id,label,value}]), else the spec's options. */
/** The menu under a gallery's tiles: when the tiles come from the command's state, the spec's per-item entries are those tiles, not repeated. */
export function galleryMenuEntries(c: SpecControl, value: unknown): SpecMenuEntry[] {
  const items = c.items ?? [];
  return Array.isArray(value) && value.length ? items.filter(e => !(isControl(e) && e.command === c.command && e.args)) : items;
}
export function galleryItems(c: SpecControl, value: unknown): GalleryItem[] {
  if (Array.isArray(value)) return value.map((v: any, i) => ({id: String(v?.id ?? i), label: String(v?.label ?? v?.name ?? v?.id ?? v), value: v?.value ?? v?.id ?? v, icon: v?.icon ?? null,
    ...(typeof v?.sample === 'string' ? {sample: v.sample} : {}), ...(typeof v?.accent === 'string' ? {accent: v.accent} : {}), ...(v?.iconOnly === true ? {iconOnly: true} : {}), ...(typeof v?.bar === 'number' ? {bar: v.bar} : {}), ...(typeof v?.mathml === 'string' ? {mathml: v.mathml} : {}),
    ...(typeof v?.selected === 'boolean' ? {selected: v.selected} : {}), ...(typeof v?.group === 'string' ? {group: v.group} : {}), ...(v?.inline === false ? {inline: false} : {}), ...(v?.art && typeof v.art === 'object' ? {art: v.art} : {})}));
  return (c.options ?? []).filter(o => !/^<.*>$/.test(String(o.value))).map((o, i) => ({id: String(i), label: o.label, value: o.value}));
}

function GalleryGrid({c, onDone, columns: columns0 = 5}: {c: SpecControl; onDone: () => void; columns?: number}) {
  const {controller} = useEngine();
  const st = useControlState(c);
  const items = galleryItems(c, st.value);
  // Equations are wide: one to a row, as Excel lists them.
  const columns = items.some(it => it.mathml) ? 1 : columns0;
  if (!items.length) return SHOW_PENDING && st.pending ? <div className="rb-gallery-empty">Gallery items arrive with {c.command ?? 'its command'}</div> : null;
  const pick = (it: GalleryItem) => () => { onDone(); controller.activate(c.id, {value: it.value}).catch(e => controller.notify(toCommandError(e).message, 'error')); };
  const tile = (it: GalleryItem) => <GalleryTile key={it.id} c={c} item={it} selected={it.selected ?? st.value === it.value} onPick={pick(it)}/>;
  // Items with a group (Entrance, Emphasis, Exit, Motion Paths; Subtle, Exciting, Dynamic Content) come under its heading.
  if (items.some(it => it.group)) {
    const groups: [string, GalleryItem[]][] = [];
    for (const it of items) { const g = it.group ?? ''; const hit = groups.find(x => x[0] === g); if (hit) hit[1].push(it); else groups.push([g, [it]]); }
    return <div className="rb-gallery-groups" role="listbox" aria-label={displayLabel(c)}>
      {groups.map(([g, list]) => <section key={g} className="rb-gallery-group">
        {g ? <div className="shell-menu-header" role="presentation">{g}</div> : null}
        <div className="rb-gallery-grid" role="group" aria-label={g || displayLabel(c)} style={{gridTemplateColumns: `repeat(${columns}, 1fr)`}}>{list.map(tile)}</div>
      </section>)}
    </div>;
  }
  return <div className="rb-gallery-grid" role="listbox" aria-label={displayLabel(c)} style={{gridTemplateColumns: `repeat(${columns}, 1fr)`}}>
    {items.map(tile)}
  </div>;
}

function GalleryTile({c, item, selected, onPick}: {c: SpecControl; item: GalleryItem; selected: boolean; onPick: () => void}) {
  const {controller} = useEngine();
  // A pen of the Draw tab's gallery: right-click offers Remove Pen (ribbon/draw.rs gallery_pen).
  const [menu, setMenu] = useState(false);
  const removable = !!item.bar && c.command === 'draw.usePen';
  return <button type="button" role="option" aria-selected={selected} className={`rb-tile${selected ? ' is-selected' : ''}${item.iconOnly ? ' is-icon-only' : ''}${item.bar ? ' is-pen' : ''}${item.art ? ' has-art' : ''}${item.mathml ? ' is-math' : ''}${item.mathml && (item.mathml.length > 420 || (item.mathml.match(/<mtr>/g)?.length ?? 0) >= 3) ? ' is-long' : ''}`} title={item.label} aria-label={item.label}
    data-item={item.id} onContextMenu={removable ? e => { e.preventDefault(); setMenu(m => !m); } : undefined} onBlur={() => setMenu(false)}
    onMouseEnter={() => controller.preview(c.command, {...(c.args ?? {}), ...(typeof item.value === 'object' && item.value ? item.value as object : {})})}
    onMouseLeave={() => controller.endPreview()} onClick={onPick}>
    {item.art ? <TileArt art={item.art}/> : item.mathml ? <span className="rb-tile-math" aria-hidden="true" dangerouslySetInnerHTML={{__html: item.mathml}}/> : item.icon && hasIcon(item.icon) ? <Icon id={item.icon} size={24} accent={item.accent}/> : <span className="rb-tile-sample">{item.sample ?? 'Aa'}</span>}
    {item.art || item.mathml ? null : item.bar ? <i className="rb-tile-bar" style={{background: item.accent ?? 'currentColor', height: item.bar}}/> : (item.sample === undefined ? <span className="rb-tile-label">{item.label}</span> : null)}
    {menu ? <span className="rb-tile-menu" role="menu"><span role="menuitem" className="rb-tile-menu-item" onClick={e => { e.stopPropagation(); setMenu(false); void controller.run('draw.removePen', {index: item.value as number}, {origin: 'ui'}); }}>Remove Pen</span></span> : null}
  </button>;
}

/** The in-ribbon gallery: a row of tiles with scroll arrows and a More button that opens every item. */
export function InlineGallery({c, columns}: {c: SpecControl; columns: number}) {
  const x = useControl(c);
  const anchor = useRef<HTMLDivElement>(null);
  const items = galleryItems(c, x.st.value).filter(it => it.inline !== false);
  const [row, setRow] = useState(0);
  const rows = Math.max(1, Math.ceil(items.length / columns));
  const shown = items.slice(row * columns, row * columns + columns);
  const placeholders = Math.max(0, columns - shown.length);
  return <div ref={anchor} className={`rb-gallery${x.st.pending ? ' is-pending' : ''}${x.disabled ? ' is-disabled' : ''}`} {...x.common} role="group">
    <div className="rb-gallery-tiles" role="listbox" aria-label={x.label} style={{gridTemplateColumns: `repeat(${columns}, 1fr)`}}>
      {shown.map(it => <GalleryTile key={it.id} c={c} item={it} selected={it.selected ?? x.st.value === it.value} onPick={() => x.activate(it.value)}/>)}
      {Array.from({length: placeholders}, (_, i) => (c.command === 'draw.usePen'
        // The Draw tab's pen gallery is empty until a pen is added: empty slots (a faint pen), never sample text.
        ? <span key={`p${i}`} className="rb-tile is-placeholder is-empty-pen" aria-hidden="true"><Icon id="pen" size={24}/></span>
        : <span key={`p${i}`} className="rb-tile is-placeholder" aria-hidden="true">
          {i === 0 && !shown.length ? <><span className="rb-tile-sample">Aa</span><span className="rb-tile-label">{x.label}</span></> : <span className="rb-tile-sample">Aa</span>}
        </span>))}
    </div>
    <div className="rb-gallery-scroll">
      <button type="button" aria-label="Previous row" disabled={row === 0} onClick={() => setRow(r => Math.max(0, r - 1))}><Glyph name="scroll-up" size={10}/></button>
      <button type="button" aria-label="Next row" disabled={row >= rows - 1} onClick={() => setRow(r => Math.min(rows - 1, r + 1))}><Glyph name="scroll-down" size={10}/></button>
      <button type="button" aria-label={`More ${x.label}`} aria-haspopup="menu" aria-expanded={x.open} onClick={x.toggleMenu}><Glyph name="expand" size={10}/></button>
    </div>
    {!x.measuring ? <Flyout anchor={anchor} open={x.open} onClose={x.closeMenu} label={x.label} className="is-gallery" matchWidth>
      <GalleryGrid c={c} onDone={x.closeMenu} columns={Math.max(columns, 5)}/>
      <MenuList entries={galleryMenuEntries(c, x.st.value)} onDone={x.closeMenu}/>
    </Flyout> : null}
  </div>;
}

// ---------------------------------------------------------------------------------------------
// Color splits

export function ColorSplit({c, size}: {c: SpecControl; size: Size}) {
  const x = useControl(c);
  const anchor = useRef<HTMLDivElement>(null);
  const accent = accentOf(c, x.st.value, x.controller.lastColors.get(c.id));
  // An app's own Colors dialog (Excel: More Colors… opens dialog.colors) is what the palette's More Colors… button opens, not a second entry.
  const moreDialog = (c.items ?? []).find(k => isControl(k) && k.dialog === 'dialog.colors' && !k.command && !!(k.args as {target?: unknown} | null)?.target && x.controller.dialogImplemented('dialog.colors'));
  const extras = (c.items ?? []).filter(k => k !== moreDialog && (!isControl(k) || (k.type !== 'palette' && k.type !== 'color')));
  const cls = `rb-split rb-split-${size} rb-color${x.disabled ? ' is-disabled' : ''}${x.st.pending ? ' is-pending' : ''}${x.open ? ' is-open' : ''}`;
  return <div ref={anchor} className={cls} {...x.common} role="group">
    <button type="button" className="rb-split-main" aria-label={x.label} aria-disabled={x.disabled || undefined} onClick={() => x.activate(accent ?? undefined)}
      data-tip={x.label} data-tip-desc={x.common['data-tip-desc']} data-pending={x.common['data-pending']}>
      {size === 'large' ? <span className="rb-large-icon"><IconSlot c={c} size={32} accent={accent}/></span>
        : <>{hasIcon(c.icon) ? <Icon id={c.icon} size={16} accent={accent}/> : <span className="rb-color-glyph" aria-hidden="true"><span>A</span><i style={{background: accent ?? 'transparent'}}/></span>}
          {size === 'medium' ? <span className="rb-text">{x.label}</span> : null}</>}
    </button>
    <button type="button" className="rb-split-arrow" aria-label={`${x.label} colors`} aria-haspopup="menu" aria-expanded={x.open} onClick={x.toggleMenu} data-tip={x.label}>
      {size === 'large' ? <span className="rb-large-label"><span>{x.label}<Glyph name="chevron-down" size={9}/></span></span> : <Glyph name="chevron-down" size={9}/>}
    </button>
    {!x.measuring ? <Flyout anchor={anchor} open={x.open} onClose={x.closeMenu} label={x.label} placement={x.placement}>
      <ColorPalette value={accent} automatic={/highlight|fill|shading|background|page-color/i.test(c.id) ? 'No Color' : 'Automatic'}
        onPick={hex => { x.closeMenu(); x.activate(hex ?? 'auto'); }}
        onMore={() => { x.closeMenu(); if (moreDialog && isControl(moreDialog)) { try { x.controller.openDialog('dialog.colors', {args: concreteArgs(moreDialog.args)}); } catch (e) { x.controller.notify(toCommandError(e).message, 'error'); } } else moreColors(x.controller, c.id, accent); }}/>
      <MenuList entries={extras} onDone={x.closeMenu}/>
    </Flyout> : null}
  </div>;
}

// ---------------------------------------------------------------------------------------------
// Combos and spinners

export function ComboControl({c, width}: {c: SpecControl; width?: number}) {
  const x = useControl(c);
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const font = isFontCombo(c), size = isSizeCombo(c);
  const fonts = useFonts(font && !x.measuring);
  // A zoom or other percent value shows its unit ("100%"); what is typed is read back as the number.
  const percent = /^percent/.test(placeholderKind(c.args) ?? '') || /(^|\.)zoom(\.|-|$)/i.test(c.id);
  const current = x.st.value === undefined || x.st.value === null ? '' : percent && typeof x.st.value === 'number' ? `${x.st.value}%` : String(x.st.value);
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? current;
  const options = useMemo(() => font ? fonts : size ? FONT_SIZES.map(String) : (c.options ?? []).map(o => o.label).filter(l => !/^<.*>$/.test(l)), [font, size, fonts, c.options]);
  const w = width ?? (font ? 148 : size ? 50 : 104);
  const commit = (v: string) => { setText(null); if (v.trim() && v !== current) x.activate(v.trim()); };
  useEffect(() => { if (x.controller.getState().menu === `focus:${c.id}`) { input.current?.focus(); input.current?.select(); x.controller.setMenu(null); } });
  // A text box with no list (Mailings › Preview Results' record number: the spec's style 'textbox'): Enter goes to the typed value.
  const plain = c.style === 'textbox';
  // A combo may carry its name beside it (Animations › Start): `labelled`.
  return <>{c.labelled ? <span className="rb-spinner-label rb-combo-label">{x.label.replace(/:$/, '')}</span> : null}<div ref={anchor} className={`rb-combo${plain ? ' is-plain' : ''}${x.disabled ? ' is-disabled' : ''}${x.st.pending ? ' is-pending' : ''}`} style={{width: w}} data-control-id={c.id} data-keytip-id={c.id}
    data-tip={x.label} data-tip-desc={x.common['data-tip-desc']} data-pending={x.common['data-pending']}>
    <input ref={input} aria-label={x.label} role="combobox" aria-expanded={x.open} disabled={x.disabled} value={shown}
      placeholder={x.st.pending ? x.label : ''} style={font && shown ? {fontFamily: `"${shown}", ${UI_FONT}`} : undefined}
      onChange={e => setText(e.target.value)} onFocus={e => e.target.select()}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(shown); x.controller.focusSurface(); }
        else if (e.key === 'Escape') { e.preventDefault(); setText(null); x.controller.focusSurface(); }
        else if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); x.toggleMenu(); }
      }} onBlur={() => { if (text !== null && !x.open) commit(text); }}/>
    {plain ? null : <button type="button" tabIndex={-1} aria-label={`${x.label} list`} disabled={x.disabled} onClick={x.toggleMenu}><Glyph name="chevron-down" size={9}/></button>}
    {!x.measuring && !plain ? <Flyout anchor={anchor} open={x.open} onClose={x.closeMenu} label={x.label} role="listbox" matchWidth className="is-combo">
      <VirtualList items={options} row={font ? 28 : 24} height={font ? 360 : 300} label={x.label} scrollTo={options.indexOf(current)}
        render={o => <button type="button" role="option" aria-selected={o === current} className="shell-option" style={font ? {fontFamily: `"${o}", ${UI_FONT}`, fontSize: 14} : undefined}
          onClick={() => { x.closeMenu(); commit(o); }}>{o}</button>}/>
    </Flyout> : null}
  </div></>;
}

export function SpinnerControl({c, width}: {c: SpecControl; width?: number}) {
  const x = useControl(c);
  const kind = placeholderKind(c.args) ?? '';
  const unit = /^pt/.test(kind) ? 'pt' : /^deg/.test(kind) ? '°' : '';
  const value = typeof x.st.value === 'number' ? x.st.value : null;
  const [text, setText] = useState<string | null>(null);
  // A spec control may set `step`, `decimals` and `scale` (the state's value is in the shown unit; the command takes it times `scale`: seconds shown, milliseconds sent).
  const scale = typeof c.scale === 'number' && c.scale > 0 ? c.scale : 1;
  const step = typeof c.step === 'number' && c.step > 0 ? c.step : unit === 'pt' ? 6 : 1;
  const decimals = typeof c.decimals === 'number' ? c.decimals : null;
  const show = text ?? (value === null ? '' : `${decimals === null ? value : value.toFixed(decimals)}${unit === '°' ? '°' : unit ? ' ' + unit : ''}`);
  const commit = (v: number | string) => { setText(null); const n = typeof v === 'number' ? v : parseFloat(String(v)); if (Number.isFinite(n)) x.activate(scale === 1 ? n : Math.round(Math.max(n, 0) * scale)); };
  return <label className={`rb-spinner${x.disabled ? ' is-disabled' : ''}${x.st.pending ? ' is-pending' : ''}`} data-control-id={c.id} data-keytip-id={c.id}
    data-tip={x.label} data-tip-desc={x.common['data-tip-desc']} data-pending={x.common['data-pending']}>
    {c.noLabel ? null : <span className="rb-spinner-label">{x.label.replace(/:$/, '')}</span>}
    <span className="rb-spinner-box" style={{width: width ?? 76}}>
      <input aria-label={x.label} disabled={x.disabled} value={show} placeholder={x.st.pending ? '—' : ''} onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(show); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); commit((value ?? 0) + (e.key === 'ArrowUp' ? step : -step)); }
          else if (e.key === 'Escape') { setText(null); x.controller.focusSurface(); }
        }} onBlur={() => text !== null && commit(text)}/>
      <span className="rb-spinner-arrows">
        <button type="button" tabIndex={-1} aria-label={`Increase ${x.label}`} disabled={x.disabled} onClick={() => commit((value ?? 0) + step)}><Glyph name="scroll-up" size={9}/></button>
        <button type="button" tabIndex={-1} aria-label={`Decrease ${x.label}`} disabled={x.disabled} onClick={() => commit((value ?? 0) - step)}><Glyph name="scroll-down" size={9}/></button>
      </span>
    </span>
  </label>;
}

/** More Colors…: the shell's color dialog; OK applies the chosen color through the control. */
function moreColors(controller: ReturnType<typeof useEngine>['controller'], controlId: string, current: string | null) {
  controller.collectDialog('shell.moreColors', {color: current ?? '#4472C4'})
    .then(v => { if (v && typeof v.color === 'string') return controller.activate(controlId, {value: v.color}); return null; })
    .catch(e => controller.notify(toCommandError(e).message, 'error'));
}
