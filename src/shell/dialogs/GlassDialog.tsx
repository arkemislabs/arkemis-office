// The one dialog chrome (docs/architecture.md section 9.2): a liquid-glass panel (glass-dialogs.css
// tokens: blurred translucent surface, 1 px inner highlight, soft shadow), a title bar with the
// title and close, draggable by its title, sized from the geometry overlay, modal with a focus
// trap, focus restore, aria-modal and aria-labelledby. Enter = OK, Esc = Cancel.

import {useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {Glyph} from '../icons/Icon';

const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"]),[role=listbox],[role=slider]';

export interface GlassDialogProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onCancel: () => void;
  onOk?: () => void;
  width?: number;
  height?: number;
  /** 'modal' (centered, backdrop), 'sheet' (full-window sheet over the work area). */
  variant?: 'modal' | 'sheet';
  /** A lower dialog in the stack: dimmed, inert, no trap. */
  inactive?: boolean;
  className?: string;
  dialogKey?: string;
  dialogId?: string;
  icon?: ReactNode;
}

export function GlassDialog({title, children, footer, onCancel, onOk, width, height, variant = 'modal', inactive = false, className, dialogKey, dialogId, icon}: GlassDialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({x: 0, y: 0});
  const drag = useRef<{x: number; y: number; ox: number; oy: number} | null>(null);

  // Focus: first field (or the primary button) on open, back to where it was on close.
  useLayoutEffect(() => {
    if (inactive) return;
    const before = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('.gd-body ' + FOCUSABLE) ?? el?.querySelector<HTMLElement>('.gd-primary');
    first?.focus({preventScroll: true});
    return () => { if (before && document.contains(before)) before.focus({preventScroll: true}); };
  }, [inactive]);

  // Keep the dialog on screen when the window shrinks.
  useEffect(() => {
    const fit = () => setOffset(o => {
      const r = panel.current?.getBoundingClientRect();
      if (!r) return o;
      const dx = r.right > innerWidth - 8 ? innerWidth - 8 - r.right : r.left < 8 ? 8 - r.left : 0;
      const dy = r.bottom > innerHeight - 8 ? innerHeight - 8 - r.bottom : r.top < 8 ? 8 - r.top : 0;
      return dx || dy ? {x: o.x + dx, y: o.y + dy} : o;
    });
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const style: CSSProperties = variant === 'sheet' ? {} : {width: width ? `min(${width}px, calc(100vw - 40px))` : undefined, minHeight: height ? `min(${height}px, calc(100vh - 40px))` : undefined,
    transform: offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px)` : undefined};

  return <div className={`gd-backdrop${variant === 'sheet' ? ' is-sheet' : ''}${inactive ? ' is-inactive' : ''}`} data-dialog-key={dialogKey}
    onPointerDown={e => { if (e.target === e.currentTarget && !inactive) e.preventDefault(); }}>
    <div ref={panel} className={`gd${variant === 'sheet' ? ' gd-sheet' : ''}${className ? ' ' + className : ''}`} role="dialog" aria-modal={!inactive} aria-labelledby={titleId}
      data-dialog-id={dialogId} style={style} inert={inactive || undefined}
      onKeyDown={e => {
        if (inactive) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
        if (e.key === 'Enter' && onOk && !e.shiftKey && !e.altKey) {
          const t = e.target as HTMLElement;
          if (t.closest('textarea,button,[role=listbox],[role=option],a,.shell-flyout') || t.getAttribute('aria-expanded') === 'true') return;
          e.preventDefault(); onOk(); return;
        }
        if (e.key === 'Tab') {
          const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(x => x.offsetParent !== null);
          if (!items.length) return;
          const i = items.indexOf(document.activeElement as HTMLElement);
          if (e.shiftKey && (i <= 0)) { e.preventDefault(); items[items.length - 1].focus(); }
          else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
        }
      }}>
      <header className="gd-title" onPointerDown={e => {
        if (variant === 'sheet' || (e.target as Element).closest('button')) return;
        drag.current = {x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y};
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }} onPointerMove={e => { const d = drag.current; if (d) setOffset({x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y}); }}
        onPointerUp={() => { drag.current = null; }}>
        {icon}
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="gd-close" aria-label="Close" onClick={onCancel}><Glyph name="close" size={12}/></button>
      </header>
      <div className="gd-content">{children}</div>
      {footer ? <footer className="gd-footer">{footer}</footer> : null}
    </div>
  </div>;
}
