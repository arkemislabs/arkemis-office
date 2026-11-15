// Export to Video: the slides as one video, recorded from a canvas the app draws itself. Each slide is the slide view's own SVG drawn to a
// canvas (show/raster.ts, the picture the editor and the show draw); a MediaRecorder on that canvas's stream holds each slide for its
// seconds, so the file is as long as the show is (WebM; MP4 only where WebM is not offered). Nothing on the screen, no camera and no
// microphone is read: the only picture is the one this module draws. Transitions and animations are not played (the slides cut).

import {rasterize} from '../show/raster';

type Any = any;

export interface VideoRequest {
  /** Slide indices in play order. */
  slides: number[];
  /** Seconds each of those slides is held (same length as `slides`). */
  seconds: number[];
  /** Pixel width of the video; the height follows the slide's shape. */
  width: number;
  fps?: number;
}

export interface VideoResult { bytes: Uint8Array; mime: string; ext: 'mp4' | 'webm'; frames: number; seconds: number; width: number; height: number }

// WebM first: it is the format this browser's recorder always has an encoder for; MP4 is taken only when WebM is not offered.
const TYPES: [string, 'mp4' | 'webm'][] = [['video/webm;codecs=vp8', 'webm'], ['video/webm;codecs=vp9', 'webm'], ['video/webm', 'webm'], ['video/mp4;codecs=avc1.42E01E', 'mp4'], ['video/mp4', 'mp4']];
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The video of `slides` of a presentation, or throws when this browser has no recorder. */
export async function renderVideo(content: Any, req: VideoRequest): Promise<VideoResult> {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !('captureStream' in HTMLCanvasElement.prototype)) throw new Error('This build cannot record video');
  const size = content.slideSize ?? {width: 960, height: 540};
  const width = Math.max(2, Math.round(req.width / 2) * 2);
  const height = Math.max(2, Math.round((width * size.height) / Math.max(size.width, 1) / 2) * 2);
  const fps = Math.min(Math.max(req.fps ?? 12, 1), 30);
  const picked = TYPES.find(([t]) => MediaRecorder.isTypeSupported(t));
  if (!picked) throw new Error('This build has no video format to record');
  const frames: HTMLCanvasElement[] = [];
  const holds: number[] = [];
  for (let k = 0; k < req.slides.length; k++) {
    const slide = content.slides?.[req.slides[k]];
    if (!slide) continue;
    frames.push(await rasterize(content, slide, 'all', width, height));
    holds.push(Math.max(req.seconds[k] ?? req.seconds[0] ?? 5, 0.5));
  }
  if (!frames.length) throw new Error('There are no slides to record');
  const stage = document.createElement('canvas');
  stage.width = width; stage.height = height;
  const g = stage.getContext('2d')!;
  const draw = (c: HTMLCanvasElement) => { g.fillStyle = '#fff'; g.fillRect(0, 0, width, height); g.drawImage(c, 0, 0, width, height); };
  draw(frames[0]);
  // Frames are handed to the recorder by hand, one per tick, so a window that is not being painted still records: as WebCodecs VideoFrames of the
  // canvas through a track generator where the browser has one, else as the canvas's own capture stream.
  const W = window as Any;
  const generator = typeof W.MediaStreamTrackGenerator === 'function' && typeof W.VideoFrame === 'function' ? new W.MediaStreamTrackGenerator({kind: 'video'}) : null;
  const writer = generator ? generator.writable.getWriter() : null;
  const stream: MediaStream = generator ? new MediaStream([generator]) : stage.captureStream(0);
  const track = (generator ?? stream.getVideoTracks()[0]) as Any;
  const t0 = performance.now();
  const push = async () => {
    if (writer) { const f = new W.VideoFrame(stage, {timestamp: Math.round((performance.now() - t0) * 1000)}); try { await writer.write(f); } finally { f.close(); } } else if (typeof track?.requestFrame === 'function') track.requestFrame();
  };
  const recorder = new MediaRecorder(stream, {mimeType: picked[0], videoBitsPerSecond: width >= 1280 ? 8_000_000 : 4_000_000});
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  let failure = '';
  recorder.onerror = (e: Any) => { failure = String(e?.error?.message ?? e?.message ?? 'error'); };
  const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
  recorder.start(500);
  await push();
  let total = 0, count = 0;
  for (let k = 0; k < frames.length; k++) {
    const until = performance.now() + holds[k] * 1000;
    // The canvas is drawn again every frame so the recorder has a frame to take each tick.
    while (performance.now() < until) { draw(frames[k]); await push(); count++; await sleep(Math.min(1000 / fps, Math.max(until - performance.now(), 1))); }
    total += holds[k];
  }
  // The encoder takes a moment to start: until it has handed over its first data (a second or so) the last slide stays on, so a short show still records.
  const patience = performance.now() + 4000;
  while (!chunks.length && performance.now() < patience) { draw(frames[frames.length - 1]); await push(); await sleep(1000 / fps); }
  try { recorder.requestData(); } catch { /* inactive */ }
  recorder.stop();
  await stopped;
  try { await writer?.close(); } catch { /* already closed */ }
  stream.getTracks().forEach(t => t.stop());
  const blob = new Blob(chunks, {type: picked[0].split(';')[0]});
  if (!blob.size) throw new Error('The recorder wrote nothing' + (failure ? ': ' + failure : ''));
  return {bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, ext: picked[1], frames: count, seconds: total, width, height};
}
