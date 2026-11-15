// Merge Styles as Excel draws it ("Merge styles from:" a list of workbooks), over the workbooks the application holds. Not in gridcraft
// (not checked against upstream).

import {useEffect, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, Rows, type SetValue} from './dataKit';

interface Peer { id: string; title: string; current: boolean }

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller, docId} = useEngine();
  const [peers, setPeers] = useState<Peer[] | null>(null);
  useEffect(() => {
    let alive = true;
    const host = (controller as any).session?.host ?? (controller as any).host;
    const ask = host?.peerStyles?.list ?? (window as any).studio?.peerStyles?.list;
    Promise.resolve(ask ? ask() : []).then((l: Peer[]) => { if (alive) setPeers((l ?? []).filter(p => p.id !== docId)); }).catch(() => { if (alive) setPeers([]); });
    return () => { alive = false; };
  }, [controller, docId]);
  const list = peers ?? [];
  const selected = list.findIndex(p => p.id === d.values.from);
  const err = d.errors.find(e => e.field === 'from')?.message ?? null;
  return <div className="gd-fields">
    <div className="sf" data-field-id="from" data-kind="list">
      <span className="sf-label">Merge styles from:</span>
      <Rows label="Workbooks" items={list.map(p => p.title)} selected={selected} height={150} empty={peers === null ? 'Looking for workbooks…' : 'There are no other workbooks.'}
        onPick={i => setValue('from', list[i]?.id ?? null)}/>
      {err ? <small className="sf-error" role="alert">{err}</small> : null}
    </div>
    <Fld d={d} set={setValue} id="replace" kind="checkbox" label="Replace styles that have the same name"/>
  </div>;
}

export default {Body};
