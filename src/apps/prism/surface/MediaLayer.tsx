// The player for the audio and video on a slide: a <video> or <audio> element over each clip's frame.
// In the editor nothing plays until Play (Playback and Video Format, Alt+P) asks for it through
// `view.mediaRequest`; in Slide Show a clip with Start Automatically plays when its slide appears.
// The clip's trim (start and end), fades, volume and loop are applied as it plays; the player reports
// play, pause and end back (media.report) and answers Poster Frame's request with the frame it shows.
// Media comes only from the pickMedia dialog; the element reads the clip's own bytes (a blob URL),
// never the network or the screen. Follows deckcraft crates/ui-egui/src/media.rs and show/media.rs
// (trim, fade and volume while playing) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useMemo, useRef, useState} from 'react';
import {base64Decode} from '../../../../core/prism/lib/shape-common.mjs';
import {mediaById} from '../../../../core/prism/model/presentation.mjs';
import {fadedVolume} from '../../../../core/prism/lib/media-play.mjs';

type Any = any;
export interface MediaRequest { action: string; id: string; ms?: number; n: number }
export interface MediaLayerProps {
  content: Any;
  slide: Any;
  /** Pixels per slide point. */
  scale: number;
  mode: 'edit' | 'show';
  /** The latest request (editor only). */
  request?: MediaRequest | null;
  /** The player's state changed (editor only). */
  onReport?: (r: {id: string; playing: boolean; positionMs: number; durationMs: number}) => void;
  /** The current frame as a PNG data URL, for Poster Frame (editor only). */
  onFrame?: (id: string, dataUrl: string) => void;
}

function useBlobUrl(content: Any, mediaId: string): string | null {
  const m = mediaById(content, mediaId);
  const data: string | undefined = m?.data;
  const type: string = m?.contentType ?? 'application/octet-stream';
  const url = useMemo(() => {
    if (!data) return null;
    const bytes = base64Decode(data);
    return bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], {type})) : null;
  }, [data, type]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

function Clip({sh, content, scale, mode, request, onReport, onFrame, auto}: {sh: Any; content: Any; scale: number; mode: 'edit' | 'show'; request?: MediaRequest | null;
  onReport?: MediaLayerProps['onReport']; onFrame?: MediaLayerProps['onFrame']; auto: boolean}) {
  const k = sh.kind;
  const url = useBlobUrl(content, k.media);
  const el = useRef<HTMLVideoElement | null>(null);
  const [shown, setShown] = useState(false);
  const last = useRef(0);
  const raf = useRef(0);
  const start = Math.max(k.trimStartMs ?? 0, 0) / 1000, endT = (k.trimEndMs ?? 0) > 0 ? k.trimEndMs / 1000 : 0;
  const x = sh.xfrm ?? {x: 0, y: 0, w: 0, h: 0};

  const report = (playing: boolean) => {
    const e = el.current;
    if (e && onReport) onReport({id: sh.id, playing, positionMs: Math.round(e.currentTime * 1000), durationMs: Math.round((Number.isFinite(e.duration) ? e.duration : 0) * 1000)});
  };
  const limit = () => { const e = el.current; return e ? (endT > 0 ? Math.min(endT, Number.isFinite(e.duration) ? e.duration : endT) : Number.isFinite(e.duration) ? e.duration : 0) : 0; };
  // Fades and the trimmed end, checked every frame while playing.
  const tick = () => {
    const e = el.current;
    if (!e || e.paused) return;
    const lim = limit();
    if (lim > 0 && e.currentTime >= lim - 0.02) {
      if (k.loopPlay) e.currentTime = start;
      else {
        e.pause();
        if (k.rewind) { e.currentTime = start; setShown(false); }
        report(false);
        return;
      }
    }
    e.volume = fadedVolume(k.volume ?? 1, (e.currentTime - start) * 1000, lim > 0 ? (lim - start) * 1000 : 0, k.fadeInMs ?? 0, k.fadeOutMs ?? 0);
    raf.current = requestAnimationFrame(tick);
  };
  const play = (from?: number) => {
    const e = el.current;
    if (!e) return;
    const lim = limit();
    let at = from !== undefined ? from / 1000 : e.currentTime;
    if (at < start || (lim > 0 && at >= lim - 0.05)) at = start;
    e.currentTime = at;
    e.volume = fadedVolume(k.volume ?? 1, (at - start) * 1000, lim > 0 ? (lim - start) * 1000 : 0, k.fadeInMs ?? 0, k.fadeOutMs ?? 0);
    setShown(true);
    void e.play().then(() => { report(true); cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(tick); }).catch(() => report(false));
  };
  const pause = () => { const e = el.current; if (e) { e.pause(); cancelAnimationFrame(raf.current); report(false); } };
  const stop = () => { const e = el.current; if (e) { e.pause(); cancelAnimationFrame(raf.current); e.currentTime = start; setShown(false); report(false); } };

  // Requests (the editor) and autoplay (Slide Show).
  useEffect(() => {
    if (!request || request.id !== sh.id || request.n === last.current) return;
    last.current = request.n;
    const e = el.current;
    if (!e) return;
    if (request.action === 'play') play(request.ms);
    else if (request.action === 'pause') pause();
    else if (request.action === 'toggle') { if (e.paused) play(); else pause(); }
    else if (request.action === 'stop') stop();
    else if (request.action === 'seek') { e.currentTime = Math.max((request.ms ?? 0) / 1000, 0); if (k.video) setShown(true); report(!e.paused); }
    else if (request.action === 'poster' && k.video && onFrame && e.videoWidth > 0) {
      const c = document.createElement('canvas');
      c.width = e.videoWidth; c.height = e.videoHeight;
      c.getContext('2d')?.drawImage(e, 0, 0);
      onFrame(sh.id, c.toDataURL('image/png'));
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode === 'show' && auto && url) { const t = window.setTimeout(() => play(), 50); return () => window.clearTimeout(t); } return undefined; }, [mode, auto, url]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { cancelAnimationFrame(raf.current); el.current?.pause(); }, []);

  if (!url) return null;
  const common = {ref: el as Any, src: url, preload: 'metadata' as const, loop: false, onEnded: () => { if (k.rewind && el.current) el.current.currentTime = start; setShown(false); report(false); },
    onLoadedMetadata: () => { if (el.current && start > 0) el.current.currentTime = start; }};
  // The element is drawn once it has played (so the poster shows before), over the clip's frame.
  return k.video
    ? <video {...common} playsInline data-clip={sh.id} style={{position: 'absolute', left: x.x * scale, top: x.y * scale, width: x.w * scale, height: x.h * scale, objectFit: 'contain', background: '#000', pointerEvents: 'none',
      opacity: shown ? 1 : 0, transform: x.rot ? `rotate(${x.rot}deg)` : undefined}}/>
    : <audio {...common} data-clip={sh.id} style={{display: 'none'}}/>;
}

/** The players of every clip on `slide`, over the slide drawn at `scale`. */
export function MediaLayer({content, slide, scale, mode, request = null, onReport, onFrame}: MediaLayerProps) {
  const clips = (slide?.shapes ?? []).filter((s: Any) => s.kind?.type === 'media' && !s.hidden);
  if (!clips.length) return null;
  return <div className="prism-media-layer" style={{position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden'}}>
    {clips.map((s: Any) => <Clip key={`${s.id}:${s.kind.media}`} sh={s} content={content} scale={scale} mode={mode} request={request} onReport={onReport} onFrame={onFrame} auto={!!s.kind.autoplay}/>)}
  </div>;
}
