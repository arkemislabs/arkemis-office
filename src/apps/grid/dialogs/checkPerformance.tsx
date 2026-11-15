// Check Performance as Excel shows it: the issues that slow the workbook down, each with what it found and, where it can be fixed, a Clean up
// button (review.cleanExcessFormatting). Not in gridcraft: not checked against upstream.

import {useEffect, useRef} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn} from './dataKit';

type Finding = {id: string; kind: string; sheet: string; count: number; title: string; detail: string; fix?: string};

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (f: string, v: unknown) => void}) {
  const {controller, session, docId} = useEngine();
  const findings = (d.values.findings ?? []) as Finding[];
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const refresh = async () => {
    const r: any = await session.execute(docId, 'review.checkPerformance', {}, {origin: 'ui'});
    if (live.current) setValue('findings', r?.result?.findings ?? []);
  };
  const clean = async (f: Finding) => {
    try { await controller.run(f.fix!, {sheet: f.sheet}, {origin: 'ui'}); await refresh(); } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  return <div className="gd-fields" data-check-performance>
    {findings.length ? <div className="sf-list" role="list" aria-label="Issues" style={{maxHeight: 260, overflowY: 'auto'}}>
      {findings.map(f => <div key={f.id} role="listitem" className="sf-list-item" style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 10, alignItems: 'center', height: 'auto', padding: '8px 10px'}}>
        <div><b style={{fontSize: 12.5}}>{f.title}</b><div style={{fontSize: 12, opacity: .75, marginTop: 2}}>{f.detail}</div></div>
        {f.fix ? <Btn onClick={() => void clean(f)}>Clean up</Btn> : null}
      </div>)}
    </div> : <p style={{margin: 0}}>No performance issues were found.</p>}
  </div>;
}

export default {Body};
