// The four corner handles of Enhance camera image on a page (printcraft crates/ui-egui/src/tools/camera_ui.rs `page_input`, `paint` at 8f16855,
// MIT, see assets/third-party-licenses/artcraft-reference.txt): the quadrilateral with what will be cut away dimmed, and a handle on each corner
// to drag onto the edge of the photographed document (kept inside the page, 12 px to pick one up). The corners are `view.camera.corners` and are
// written through camera.corners when a drag ends; once the page is enhanced the layer is gone (the bar's buttons take over).

import {useRef, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {viewSize} from '../../../../core/folio/lib/geom.mjs';
import type {PageGeom} from './PageView';

const BLUE = '#1473e6';
const GRAB = 12;

export function CameraLayer({api, page, geom}: {api: any; page: any; geom: PageGeom}) {
  const {session, docId} = useEngine();
  useSessionTick();
  const host = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{i: number; to: [number, number]} | null>(null);
  const view: any = (() => { try { return session.get(docId).view ?? {}; } catch { return {}; } })();
  const cam = view.camera;
  if (!cam || cam.page !== page.id || view.cameraDone) return null;
  const {width, height} = viewSize(page);
  const s = geom.scale;
  const corners: number[][] = cam.corners.map((c: number[], i: number) => (drag && drag.i === i ? drag.to : c));
  const pts = corners.map(c => `${c[0] * s},${c[1] * s}`).join(' ');
  const at = (e: {clientX: number; clientY: number}): [number, number] => {
    const b = host.current!.getBoundingClientRect();
    return [Math.min(Math.max((e.clientX - b.left) / s, 0), width), Math.min(Math.max((e.clientY - b.top) / s, 0), height)];
  };
  // The page outside the quadrilateral is dimmed: the page's rectangle with the quadrilateral cut out (even-odd).
  const dim = `M0,0 H${width * s} V${height * s} H0 Z M${pts.split(' ').map(p => p).join(' L')} Z`;
  return <svg ref={host} className="folio-camera" width={geom.width} height={geom.height} data-camera-page={page.id}
    style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
    <path d={dim} fill="rgba(0,0,0,0.28)" fillRule="evenodd" pointerEvents="none"/>
    <polygon points={pts} fill="none" stroke={BLUE} strokeWidth={1.5} pointerEvents="none"/>
    {corners.map((c, i) => <circle key={i} cx={c[0] * s} cy={c[1] * s} r={6} fill="#fff" stroke={BLUE} strokeWidth={2} data-corner={i}
      style={{cursor: drag?.i === i ? 'grabbing' : 'grab', pointerEvents: 'all'}}>
      <title>{`Corner ${i + 1}`}</title>
    </circle>)}
    {/* Wider invisible targets: a corner is picked up within GRAB pixels. */}
    {corners.map((c, i) => <circle key={`g${i}`} cx={c[0] * s} cy={c[1] * s} r={GRAB} fill="transparent" style={{pointerEvents: 'all', cursor: drag?.i === i ? 'grabbing' : 'grab'}}
      onPointerDown={e => { if (!api.allowed) return; e.stopPropagation(); e.preventDefault(); (e.currentTarget as Element).setPointerCapture(e.pointerId); setDrag({i, to: at(e)}); }}
      onPointerMove={e => { if (drag && drag.i === i) setDrag({i, to: at(e)}); }}
      onPointerUp={e => {
        if (!drag || drag.i !== i) return;
        e.stopPropagation();
        const next = cam.corners.map((p: number[], k: number) => (k === i ? at(e) : p));
        setDrag(null);
        void api.exec('camera.corners', {page: page.id, corners: next});
      }}/>)}
  </svg>;
}
