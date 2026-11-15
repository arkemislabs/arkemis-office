// Manual Hyphenation view (Layout › Hyphenation › Manual…): the word with a hyphen button at every place it may break (the chosen one is
// the hyphen that will go in), Yes and No; when no word is left it says Manual hyphenation is complete. Over core/quill/dialogs/manualHyphenation.mjs.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {BodyProps} from './font';
import './manualHyphenation.css';

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller} = useEngine();
  const v = d.values as {word?: string; points?: number[]; choice?: number; done?: boolean};
  const word = [...String(v.word ?? '')];
  const points = (v.points ?? []).slice().sort((a, b) => a - b);
  const press = (id: string) => { void controller.pressField(d.key, id).catch((e: unknown) => controller.notify(toCommandError(e).message, 'error')); };
  if (v.done) return <div className="gd-fields" data-dialog-page="Manual Hyphenation"><p className="sf sf-static" role="status">Manual hyphenation is complete.</p></div>;
  let from = 0;
  const parts: React.ReactNode[] = [];
  points.forEach((pt, i) => {
    parts.push(<span key={`w${i}`}>{word.slice(from, pt).join('')}</span>);
    parts.push(<button key={`h${i}`} type="button" aria-pressed={v.choice === pt} className={`mh-hyphen${v.choice === pt ? ' is-on' : ''}`} data-point={pt} onClick={() => set('choice', pt)}>-</button>);
    from = pt;
  });
  parts.push(<span key="last">{word.slice(from).join('')}</span>);
  return <div className="gd-fields" data-dialog-page="Manual Hyphenation" data-field-id="word">
    <div className="sf-label">Hyphenate at:</div>
    <div style={{fontSize: 18, display: 'flex', alignItems: 'center', margin: '8px 0 14px'}} aria-label="Word with its break points">{parts}</div>
    <div style={{display: 'flex', gap: 8}}>
      <button type="button" className="sf-button" data-field-id="yes" onClick={() => press('yes')}>Yes</button>
      <button type="button" className="sf-button" data-field-id="no" onClick={() => press('no')}>No</button>
    </div>
  </div>;
}

export default {Body};
