// The renderer's media service (host.media; U:slate/media): recording from the microphone or camera
// with MediaRecorder, and playing recordings through the audio and video elements the page draws.
//
// Safeguards (docs/spec/patches/slate/audio-video.json):
//   * a recording starts only from a person's click: without an active user gesture (a real click or key
//     in this window) `record` refuses, so a script or the bridge cannot open the microphone;
//   * only the microphone (and for video the camera) is ever asked for, never the screen: getDisplayMedia
//     is not used here and the main process denies it;
//   * Electron's permission handler (electron/main.cjs) grants `media` only to this app's own window;
//   * the devices are released the moment a recording stops or is cancelled; a recording ends by itself
//     at about 20 MB (what a page can hold).
// In test mode (ARKEMIS_STUDIO_TEST) the source is a synthetic stream (an oscillator, a canvas): the same
// MediaRecorder path runs, but no microphone or camera is ever opened and no gesture is needed.

export interface RecordResult { data: string; mime: string; duration: number }
export interface RecorderHandle { stop(): Promise<RecordResult>; pause(): Promise<void>; resume(): Promise<void>; cancel(): void }
export interface MediaService {
  record(kind: 'audio' | 'video', options?: {audioInput?: string | null; videoInput?: string | null; audioBitsPerSecond?: number; width?: number; height?: number}): Promise<RecorderHandle>;
  play(id: string, o: {src: string; kind: string; from?: number}): Promise<void>;
  pause(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  seek(id: string, t: number, o?: {src?: string; kind?: string}): Promise<void>;
  position(id: string): Promise<{t: number; duration: number | null; playing: boolean} | null>;
  /** Called with the recording's id when it has played to its end. */
  onEnded: ((id: string) => void) | null;
}

const MAX_BYTES = 20 * 1024 * 1024;
const elements = new Map<string, HTMLMediaElement>();
let service: MediaService | null = null;

/** The page's audio or video element of a recording (the node view registers it). */
export function registerMediaElement(id: string, el: HTMLMediaElement) {
  elements.set(id, el);
  el.addEventListener('ended', () => { try { getMediaService().onEnded?.(id); } catch { /* none */ } });
}
export function unregisterMediaElement(id: string, el: HTMLMediaElement) { if (elements.get(id) === el) elements.delete(id); }

const testMode = () => (globalThis as any).studio?.testMode === true;

function syntheticStream(kind: 'audio' | 'video'): MediaStream {
  const AC = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  const ctx = new AC();
  void ctx.resume?.().catch?.(() => {});
  const osc = ctx.createOscillator(), gain = ctx.createGain(), dest = ctx.createMediaStreamDestination();
  gain.gain.value = 0.0001;
  osc.connect(gain); gain.connect(dest); osc.start();
  const stream: MediaStream = dest.stream;
  if (kind === 'video') {
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 90;
    const g = canvas.getContext('2d')!;
    let n = 0;
    const timer = setInterval(() => { g.fillStyle = `hsl(${(n += 12) % 360} 60% 45%)`; g.fillRect(0, 0, 160, 90); }, 100);
    const video = (canvas as any).captureStream(10) as MediaStream;
    for (const t of video.getVideoTracks()) { stream.addTrack(t); t.addEventListener('ended', () => clearInterval(timer)); }
    stream.addEventListener?.('removetrack', () => clearInterval(timer));
    const stop = stream.getTracks.bind(stream);
    (stream as any).__stopSynthetic = () => { clearInterval(timer); try { osc.stop(); void ctx.close(); } catch { /* closed */ } stop().forEach(t => t.stop()); };
  } else (stream as any).__stopSynthetic = () => { try { osc.stop(); void ctx.close(); } catch { /* closed */ } stream.getTracks().forEach(t => t.stop()); };
  return stream;
}

const release = (stream: MediaStream) => { try { (stream as any).__stopSynthetic ? (stream as any).__stopSynthetic() : stream.getTracks().forEach(t => t.stop()); } catch { /* released */ } };

const blobData = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error ?? new Error('The recording could not be read'));
  r.readAsDataURL(blob);
});

/** Whether the browser can open the recording it just made (an encoder that never got a sample leaves a header with nothing to play). */
const playable = (url: string, kind: 'audio' | 'video') => new Promise<boolean>(resolve => {
  const el = document.createElement(kind);
  const done = (ok: boolean) => { el.removeAttribute('src'); resolve(ok); };
  el.addEventListener('loadedmetadata', () => done(true));
  el.addEventListener('error', () => done(false));
  setTimeout(() => done(false), 3000);
  el.preload = 'metadata'; el.src = url;
});

/** A short silent WAV, for an audio recording the encoder produced no bytes for (it was stopped at once). */
function silentWav(seconds: number): string {
  const rate = 8000, n = Math.max(1, Math.round(rate * seconds)), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  let s = ''; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(s)}`;
}

type RecordOptions = {audioInput?: string | null; videoInput?: string | null; audioBitsPerSecond?: number; width?: number; height?: number};
async function record(kind: 'audio' | 'video', options: RecordOptions = {}): Promise<RecorderHandle> {
  const test = testMode();
  if (!test && !(navigator as any).userActivation?.isActive) throw new Error('A recording starts only from your click on Record Audio or Record Video');
  let stream: MediaStream;
  try {
    stream = test ? syntheticStream(kind) : await navigator.mediaDevices.getUserMedia({audio: options.audioInput ? {deviceId: {exact: options.audioInput}} : true, ...(kind === 'video' ? {video: {...(options.videoInput ? {deviceId: {exact: options.videoInput}} : {}), ...(options.width ? {width: {ideal: options.width}, height: {ideal: options.height}} : {})}} : {})});
  } catch (e: any) {
    throw new Error(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? `The ${kind === 'video' ? 'camera or microphone' : 'microphone'} was not allowed` : e?.name === 'NotFoundError' ? `No ${kind === 'video' ? 'camera' : 'microphone'} was found` : `The ${kind === 'video' ? 'camera' : 'microphone'} could not be opened: ${e?.message ?? e}`);
  }
  const wanted = kind === 'video' ? ['video/webm;codecs=vp8,opus', 'video/webm'] : ['audio/webm;codecs=opus', 'audio/webm'];
  const mimeType = wanted.find(m => MediaRecorder.isTypeSupported(m));
  const chunks: Blob[] = [];
  let bytes = 0, done: Promise<void> | null = null, startedAt = performance.now(), pausedAt: number | null = null, pausedFor = 0;
  const rec = new MediaRecorder(stream, {...(mimeType ? {mimeType} : {}), ...(options.audioBitsPerSecond ? {audioBitsPerSecond: options.audioBitsPerSecond} : {})});
  rec.ondataavailable = e => {
    if (!e.data.size) return;
    chunks.push(e.data); bytes += e.data.size;
    if (bytes >= MAX_BYTES && rec.state !== 'inactive') rec.stop();
  };
  const finished = new Promise<void>(resolve => { rec.onstop = () => resolve(); });
  rec.start(1000);
  startedAt = performance.now();
  const elapsed = () => ((pausedAt ?? performance.now()) - startedAt - pausedFor) / 1000;
  return {
    async stop() {
      const duration = Math.round(elapsed() * 10) / 10;
      if (rec.state !== 'inactive') rec.stop();
      done ??= finished;
      await done;
      release(stream);
      const blob = new Blob(chunks, {type: rec.mimeType || mimeType || (kind === 'video' ? 'video/webm' : 'audio/webm')});
      const data = blob.size ? await blobData(blob) : '';
      if (kind === 'audio' && (!data || !(await playable(data, 'audio')))) return {data: silentWav(Math.max(duration, 0.1)), mime: 'audio/wav', duration};
      return {data, mime: (blob.type || mimeType || 'audio/webm').split(';')[0], duration};
    },
    async pause() { if (rec.state === 'recording') { rec.pause(); pausedAt = performance.now(); } },
    async resume() { if (rec.state === 'paused') { rec.resume(); if (pausedAt !== null) pausedFor += performance.now() - pausedAt; pausedAt = null; } },
    cancel() { try { if (rec.state !== 'inactive') { rec.ondataavailable = null; rec.stop(); } } finally { release(stream); } },
  };
}

const loose = new Map<string, HTMLMediaElement>();
const elementFor = (id: string, kind?: string): HTMLMediaElement => {
  const page = elements.get(id);
  if (page) return page;
  let el = loose.get(id);
  if (!el) { el = document.createElement(kind === 'video' ? 'video' : 'audio'); loose.set(id, el); el.addEventListener('ended', () => getMediaService().onEnded?.(id)); }
  return el;
};
async function load(el: HTMLMediaElement, src?: string) {
  if (!src || el.dataset.loaded === String(src.length) + src.slice(-24)) return;
  el.src = src; el.dataset.loaded = String(src.length) + src.slice(-24);
  if (el.readyState < 1) await new Promise<void>(resolve => { const done = () => { el.removeEventListener('loadedmetadata', done); el.removeEventListener('error', done); resolve(); }; el.addEventListener('loadedmetadata', done); el.addEventListener('error', done); setTimeout(done, 4000); });
}

export function getMediaService(): MediaService {
  service ??= {
    record,
    async play(id, o) { const el = elementFor(id, o.kind); await load(el, o.src); if (o.from !== undefined) el.currentTime = o.from; await el.play(); },
    async pause(id) { elementFor(id).pause(); },
    async stop(id) { const el = elementFor(id); el.pause(); el.currentTime = 0; },
    async seek(id, t, o) { const el = elementFor(id, o?.kind); await load(el, o?.src); el.currentTime = t; },
    async position(id) { const el = elements.get(id) ?? loose.get(id); return el ? {t: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : null, playing: !el.paused} : null; },
    onEnded: null,
  };
  return service;
}
