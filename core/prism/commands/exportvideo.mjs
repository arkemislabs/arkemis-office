// File > Export > Create a Video (Record › Export to Video): the slides as one video file, each slide held for its seconds.
// PowerPoint's behaviour, not checked against upstream (deckcraft's Export to Video writes an animated GIF, crates/engine gif_export.rs, which
// is not offered here). The video is recorded from a canvas the app draws itself, from the slide view's own picture of each slide
// (`ctx.host.renderVideo`, src/apps/prism/lib/videoExport.ts: a MediaRecorder on that canvas, WebM; MP4 only where WebM is not offered);
// nothing on the screen, no camera and no microphone is read. Transitions and animations are not played: the slides cut.
//
// `quality` is the video's size (`2160`, `1080`, `720` or `480` lines), `seconds` the time each slide is held, `useTimings` keeps a slide's own
// Advance Slide After time when it has one, hidden slides are left out. The file goes where the person picks in the Save dialog, or to `path`;
// with no way to write (the bridge, tests) the bytes come back as base64 `data`.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {UPSTREAM_COMMIT, bad, hasDoc} from '../lib/shape-common.mjs';
import {isSchema2} from '../model/doc.mjs';
import {writeOther, writeState} from '../../folio/lib/page-files.mjs';
import {documentName} from '../../common/commands/file.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/file.rs']};
export const QUALITIES = Object.freeze([['2160', 'Ultra HD (2160p)'], ['1080', 'Full HD (1080p)'], ['720', 'HD (720p)'], ['480', 'Standard (480p)']]);
const base64 = bytes => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

async function exportVideo(ctx, p) {
  const cmd = 'file.exportVideo';
  if (!isSchema2(ctx.doc)) throw bad(cmd, 'needs a presentation (schema 2)');
  const quality = p.quality ?? '720';
  if (!QUALITIES.some(q => q[0] === quality)) throw bad(cmd, '`quality` is 2160, 1080, 720 or 480');
  const record = ctx.host?.renderVideo;
  if (typeof record !== 'function') throw new CommandError('unavailable', `${cmd}: the video can only be recorded with the document open in a window`, {hint: 'documents.open'});
  const doc = ctx.doc;
  const size = doc.slideSize ?? {width: 960, height: 540};
  const width = Math.round((Number(quality) * size.width) / Math.max(size.height, 1));
  const seconds = p.seconds ?? 5;
  const use = p.useTimings !== false;
  const list = (Array.isArray(p.slides) ? p.slides : [...(doc.slides ?? []).keys()].filter(i => !doc.slides[i].hidden)).filter(i => doc.slides[i]);
  if (!list.length) throw bad(cmd, 'there are no slides to record');
  const holds = list.map(i => { const ms = doc.slides[i].transition?.advanceAfterMs; return use && Number.isFinite(ms) && ms > 0 ? Math.max(ms / 1000, 0.5) : seconds; });
  const out = await record(doc, {slides: list, seconds: holds, width, fps: p.fps});
  if (!out?.bytes?.length) throw new CommandError('failed', `${cmd}: nothing was recorded`);
  const info = {format: out.ext, mime: out.mime, bytes: out.bytes.length, slides: list.length, seconds: out.seconds, width: out.width, height: out.height};
  const wrote = await writeOther(ctx, p, out.bytes, {title: 'Export to Video', name: `${documentName(ctx)}.${out.ext}`,
    filters: [{name: out.ext === 'mp4' ? 'MPEG-4 Video (*.mp4)' : 'WebM Video (*.webm)', extensions: [out.ext]}]});
  if (wrote.canceled) return {canceled: true};
  return wrote.path ? {...info, path: wrote.path} : {...info, data: wrote.base64 ?? base64(out.bytes)};
}

export default defineCommands({
  family: 'exportvideo',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'file.exportVideo', label: 'Export to Video', risk: 'edit', effect: 'persist', undo: 'none', dialog: 'dialog.exportVideo',
      riskFor: (ctx, p) => (p.path ? 'irreversible' : 'edit'),
      summary: (ctx, p) => (p.path ? `Record "${documentName(ctx)}" as a video at ${p.path}` : `Record "${documentName(ctx)}" as a video`),
      state: ctx => { const st = hasDoc(ctx); return st.enabled ? writeState(ctx) : st; },
      description: '{path? (default: the Save dialog), quality?: 2160|1080|720|480 (default 720), seconds?: 1..300 each slide is held (default 5), useTimings?: bool (default true: a slide\'s own Advance Slide After time wins), slides?: [index] (default: the slides not hidden)} → {path, format: mp4|webm, slides, seconds, width, height} (no way to write: {data: base64, …}; Cancel: {canceled}). Recorded from a canvas the app draws itself; not checked against upstream.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), quality: s.optional(s.string({max: 8})), seconds: s.optional(s.number({min: 1, max: 300})), useTimings: s.optional(s.boolean()),
        slides: s.optional(s.array(s.integer({min: 0}), {max: 10000})), fps: s.optional(s.integer({min: 1, max: 30}))}),
      run: exportVideo},
  ],
});
