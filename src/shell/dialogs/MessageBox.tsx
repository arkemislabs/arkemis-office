// Office's message boxes (docs/architecture.md section 9.4) in the glass chrome: a message, an
// optional detail, and the buttons in the order Office shows them (Yes, No / OK, Cancel), the
// default one primary. Keyboard: Enter presses the focused (else the default) button, Esc the
// cancel one, Left/Right and Tab move between buttons, and each button's underlined letter
// (Do&n't Save, &Yes, &No) presses it. openMessageBox(request) resolves with the button's index,
// like Electron's dialog.showMessageBox; the file lifecycle asks through main first, so test mode
// can script the answer (electron/main.cjs test.dialogs).

import {useEffect, useRef, useSyncExternalStore} from 'react';
import type {MessageBoxRequest} from '../../types';
import {GlassDialog} from './GlassDialog';
import './MessageBox.css';

interface Pending { id: number; request: MessageBoxRequest; resolve: (index: number) => void }
let boxes: Pending[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const publish = (next: Pending[]) => { boxes = next; for (const l of [...listeners]) l(); };

/** Show a message box; resolves with the pressed button's index (Esc and the close box give cancelId). */
export function openMessageBox(request: MessageBoxRequest): Promise<number> {
  return new Promise(resolve => publish([...boxes, {id: ++seq, request, resolve}]));
}

function answer(box: Pending, index: number) {
  publish(boxes.filter(b => b !== box));
  box.resolve(index);
}

/** The letter Office underlines: "Don't Save" -> n, others their first letter. */
export function accelerator(label: string): string {
  if (/^don['’]t\s/i.test(label)) return 'n';
  return label.trim().charAt(0).toLowerCase();
}

function Label({text}: {text: string}) {
  const key = accelerator(text);
  const at = /^don['’]t\s/i.test(text) ? text.toLowerCase().indexOf('n') : 0;
  if (!key || at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<u>{text.charAt(at)}</u>{text.slice(at + 1)}</>;
}

export function MessageBoxHost() {
  const list = useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => boxes);
  const top = list[list.length - 1];
  if (!top) return null;
  return <MessageBoxView key={top.id} box={top}/>;
}

function MessageBoxView({box}: {box: Pending}) {
  const {request} = box;
  const buttons = request.buttons.length ? request.buttons : ['OK'];
  const defaultId = Number.isInteger(request.defaultId) ? request.defaultId! : 0;
  const cancelId = Number.isInteger(request.cancelId) ? request.cancelId! : buttons.length - 1;
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => { row.current?.querySelectorAll<HTMLButtonElement>('button')[defaultId]?.focus({preventScroll: true}); }, [defaultId]);
  const press = (i: number) => answer(box, i);
  return <GlassDialog title={request.title || document.title || 'Arkemis'} width={440} className="is-message mb" dialogId="message-box"
    onCancel={() => press(cancelId)}>
    <div className="mb-body" role="alertdialog" aria-describedby="mb-text"
      onKeyDown={e => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const items = [...(row.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = items[(Math.max(0, at) + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
          next?.focus();
          return;
        }
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); press(at >= 0 ? at : defaultId); return; }
        if (e.key.length === 1) {
          const i = buttons.findIndex(b => accelerator(b) === e.key.toLowerCase());
          if (i >= 0) { e.preventDefault(); press(i); }
        }
      }}>
      <div className="mb-text" id="mb-text">
        <p className="mb-message">{request.message}</p>
        {request.detail ? request.detail.split('\n').map((line, i) => <p key={i} className="mb-detail">{line}</p>) : null}
      </div>
      <div className="mb-buttons" ref={row}>
        {buttons.map((label, i) => <button key={label + i} type="button" className={`gd-button${i === defaultId ? ' gd-primary' : ''}`}
          data-button-index={i} onClick={() => press(i)}><Label text={label}/></button>)}
      </div>
    </div>
  </GlassDialog>;
}
