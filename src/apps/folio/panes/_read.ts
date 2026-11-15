// Reading for the Layers, Attachments and Tags panes: run a read command when the document's source changes and hand back what it lists.
import {useEffect, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';

export function useRead<T = any>(command: string): {data: T | null; content: any; controller: ReturnType<typeof useEngine>['controller']} {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const doc: any = (() => { try { return session.get(docId); } catch { return null; } })();
  const content = doc?.file?.content ?? null;
  const rev = `${content?.sourceBase64?.length ?? 0}:${content?.sourceBase64?.slice(-48) ?? ''}`;
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    if (!content?.pages?.length) { setData(null); return; }
    controller.run(command, {}, {origin: 'ui'}).then((r: any) => { if (alive) setData(r?.result ?? null); }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, command, rev]);
  return {data, content, controller};
}
