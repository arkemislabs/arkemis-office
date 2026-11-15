// Ribbon icons (docs/architecture.md section 12.3): one sanitized SVG per icon id, generated into
// src/generated/icons.ts from assets/icons/ribbon/<id>.svg. Sizes: 16 px for small and medium
// controls, 32 px for large ones (the `.32.svg` drawing when there is one). Color controls set
// `--icon-accent` from their state's value so the color bar shows the current color.

import type {CSSProperties} from 'react';
import {icons} from '../../generated/icons';

export const hasIcon = (id: string | null | undefined): boolean => !!id && Object.hasOwn(icons, id);

export interface IconProps { id: string | null | undefined; size?: 16 | 20 | 24 | 32; accent?: string | null; className?: string; title?: string }

export function Icon({id, size = 16, accent, className, title}: IconProps) {
  if (!id || !hasIcon(id)) return null;
  const markup = icons[id];
  const large = size >= 24 && !!markup.d32;
  const style = accent ? ({'--icon-accent': accent} as CSSProperties) : undefined;
  return <svg className={`shell-icon${className ? ' ' + className : ''}`} viewBox={large ? '0 0 32 32' : '0 0 24 24'} width={size} height={size}
    aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} aria-label={title} focusable="false" style={style}
    // The generator sanitized this markup (scripts/gen/icons.mjs: shapes only, no ids, events or links).
    dangerouslySetInnerHTML={{__html: large ? markup.d32! : markup.d24}}/>;
}

/** The shell's own interface glyphs (chevrons, launcher, close...), drawn inline: not ribbon icons. */
export function Glyph({name, size = 12}: {name: 'chevron-down' | 'chevron-up' | 'chevron-right' | 'chevron-left' | 'launcher' | 'close' | 'check'
  | 'search' | 'more' | 'pin' | 'back' | 'dock-left' | 'dock-right' | 'float' | 'scroll-up' | 'scroll-down' | 'expand' | 'ribbon'
  | 'save' | 'undo' | 'redo'; size?: number}) {
  const d: Record<string, string> = {
    'chevron-down': 'M3.5 5.25 7 8.75l3.5-3.5', 'chevron-up': 'M3.5 8.75 7 5.25l3.5 3.5', 'chevron-right': 'M5.25 3.5 8.75 7l-3.5 3.5',
    'chevron-left': 'M8.75 3.5 5.25 7l3.5 3.5', launcher: 'M3.5 3.5h4M3.5 3.5v4M5 9l5-5M10.5 6.5v4h-4', close: 'm4 4 6 6m0-6-6 6',
    check: 'm3.25 7.25 2.5 2.5 5-5.5', search: 'M6.25 10.25a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm2.9-1.1 2.6 2.6', more: 'M3 7h.01M7 7h.01M11 7h.01',
    pin: 'M5 2.5h4M5.5 2.5v3L4 7.5h6L8.5 5.5v-3M7 7.5v4', back: 'M8.5 3.5 5 7l3.5 3.5M5.5 7H12', 'dock-left': 'M2.5 3h9v8h-9zM5.5 3v8',
    'dock-right': 'M2.5 3h9v8h-9zM8.5 3v8', float: 'M2.5 4.5h7v6h-7zM5 2.5h6.5V8', 'scroll-up': 'M4.5 8 7 5.5 9.5 8', 'scroll-down': 'M4.5 6 7 8.5 9.5 6',
    expand: 'M4.5 5.5 7 8l2.5-2.5M3.5 10.5h7', ribbon: 'M2.5 4h9M2.5 7h9M2.5 10h5',
    save: 'M3 2.25h6.25l2.5 2.5v6.75a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V2.75a.5.5 0 0 1 .5-.5ZM4.5 2.25v2.5h4v-2.5M4.25 12V8.25h5.5V12',
    undo: 'M5 3.5 2.5 6 5 8.5M2.75 6h5.5a3 3 0 0 1 0 6H6.5', redo: 'M9 3.5 11.5 6 9 8.5M11.25 6h-5.5a3 3 0 0 0 0 6H7.5',
  };
  return <svg className="shell-glyph" viewBox="0 0 14 14" width={size} height={size} aria-hidden="true" focusable="false">
    <path d={d[name]} fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 2.2 : 1.3} strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

/** Interface glyphs for the few commands the title bar always shows, until their ribbon icons exist. */
const FALLBACK: Record<string, 'save' | 'undo' | 'redo'> = {'file.save': 'save', 'edit.undo': 'undo', 'edit.redo': 'redo'};
export const fallbackGlyph = (command: string | null | undefined) => (command ? FALLBACK[command] ?? null : null);
