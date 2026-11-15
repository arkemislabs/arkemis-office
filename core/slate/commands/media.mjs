// Record Audio, Record Video and the Audio & Video playback tab (U:slate/media).
//
// Slate has no ArtCraft upstream: ids and args are docs/spec/slate.json `insert.recordAudio`,
// `insert.recordVideo` and `media.*`; behaviour is OneNote's:
//   * Record Audio / Record Video start a recording at the caret: a recording object is embedded
//     on the page at once (its time counts up) and the page shows that a recording is running.
//     Stop (one click) ends it and the sound or picture is kept in the object, saved in the notebook
//     with the page. A recording starts only from a person's click and only ever from the
//     microphone or camera, never the screen: the host's media service (src/shell/engine/mediaService.ts)
//     asks the system and refuses without a click (docs/spec/patches/slate/audio-video.json);
//   * notes typed while recording are linked to their moment (`audio: {media, t}` on the paragraph,
//     core/slate/model/canvas.mjs): playing from a note jumps the recording to when it was typed;
//     See Playback lights the note being played;
//   * Play, Pause, Stop and the rewind and fast-forward buttons work on the selected recording (or the
//     one playing), Pause and Play also pause and resume a running recording.
// The host service `media` is {record(kind) -> {stop, pause, resume, cancel}, play, pause, stop,
// seek, position}; tests pass a stub (no microphone, no camera).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, schema} from '../schema.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {blockIndex} from '../model/page.mjs';
import {pageDoc} from '../model/canvas.mjs';
import {bid, insertInline, pageReady} from '../lib/insert-point.mjs';
import {editPage} from '../lib/format-text.mjs';
import {recordOptions} from './rest-panes.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/media.*', 'docs/spec/slate.json#commands/insert.recordAudio']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
const view = ctx => ctx.view ?? {};
const NO_SERVICE = 'Recording and playback need the desktop app\'s microphone and camera service';

/** The running recorders' handles, per notebook (never in the document). */
const recorders = new Map();
const keyOf = ctx => ctx.doc.notebook.id;
const service = ctx => { const m = ctx.host?.media; return m && typeof m.record === 'function' ? m : null; };
const seconds = n => Math.round(n * 10) / 10;

/** The recording objects of a page: [{id, node, pos}]. */
function recordingsOn(ctx, pageId) {
  const out = [];
  pageDoc(ctx, pageId).descendants((node, pos) => { if (node.type.name === 'media') out.push({id: node.attrs.id, node, pos}); return true; });
  return out;
}
/** The recording object a command means: `mediaId`, else the selected object, else the one playing, else the page's only or first one with sound. */
function targetOf(ctx, mediaId) {
  const loc = currentLocation(ctx.doc, ctx.selection);
  need(loc.pageId, 'disabled', 'No page is open');
  const all = recordingsOn(ctx, loc.pageId);
  const r = ctx.selection?.ranges?.[ctx.selection.primary ?? 0];
  const picked = mediaId ?? /\/media:([^/]+)$/.exec(r?.focus ?? '')?.[1] ?? view(ctx).playback?.id ?? all.find(x => x.node.attrs.src)?.id;
  const hit = all.find(x => x.id === decodeURIComponent(String(picked ?? '')));
  need(hit, 'not_found', picked ? `No recording ${picked} on this page` : 'This page has no recording', {address: `/pg:${loc.pageId}`});
  return {...hit, pageId: loc.pageId};
}
const running = ctx => view(ctx).recording ?? null;

async function start(ctx, kind) {
  need(isNotebook(ctx.doc), 'disabled', 'No notebook is open');
  need(!running(ctx), 'disabled', 'A recording is already running; stop it first');
  const media = service(ctx);
  need(media, 'unavailable', NO_SERVICE);
  const handle = await media.record(kind, recordOptions(ctx.prefs));
  const now = ctx.host.now();
  const node = schema.nodes.media.create({id: bid(ctx), kind, src: '', name: `${kind === 'audio' ? 'Audio' : 'Video'} recording ${new Date(now).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})}`, duration: null, recorded: new Date(now).toISOString(), mime: null});
  let placed;
  try { placed = insertInline(ctx, () => [node]); } catch (e) { try { handle.cancel?.(); } catch { /* closing */ } throw e; }
  recorders.set(keyOf(ctx), handle);
  ctx.setView({recording: {id: node.attrs.id, kind, page: placed.pageId, start: now, paused: false, pausedFor: 0}});
  ctx.setSelection({ranges: [{anchor: `/pg:${placed.pageId}/media:${node.attrs.id}`, focus: `/pg:${placed.pageId}/media:${node.attrs.id}`}], primary: 0});
  return {recording: true, kind, object: `/pg:${placed.pageId}/media:${node.attrs.id}`};
}

const startState = kind => ctx => {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  const r = running(ctx);
  if (r) return {enabled: false, checked: r.kind === kind, reason: 'A recording is running; stop it first'};
  const st = pageReady(ctx);
  if (!st.enabled) return st;
  return service(ctx) ? {enabled: true, checked: false} : {enabled: false, reason: NO_SERVICE};
};

export default defineCommands({
  family: 'media',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'insert.recordAudio', label: 'Record Audio', risk: 'edit', repeatable: false, clearsHistory: false,
      description: 'Start recording from the microphone at the caret: a recording object is embedded and notes typed meanwhile are linked to their moment. Starts only from a person\'s click; Stop ends it (media.stop).',
      params: s.object({}),
      state: startState('audio'),
      run: ctx => start(ctx, 'audio'),
    },
    {
      id: 'insert.recordVideo', label: 'Record Video', risk: 'edit', repeatable: false,
      description: 'Start recording from the camera (and microphone) at the caret: a recording object is embedded and notes typed meanwhile are linked to their moment. Starts only from a person\'s click; Stop ends it (media.stop).',
      params: s.object({}),
      state: startState('video'),
      run: ctx => start(ctx, 'video'),
    },
    {
      id: 'media.stop', label: 'Stop', shortcut: 'Mod+Alt+S', risk: 'edit', repeatable: false,
      description: 'Stop the recording that is running (its sound or picture is kept in the recording object on the page), else stop playback and return to the start.',
      params: s.object({}),
      state(ctx) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        return running(ctx) || view(ctx).playback ? {enabled: true} : {enabled: false, reason: 'Nothing is recording or playing'};
      },
      async run(ctx) {
        const r = running(ctx);
        if (r) {
          const handle = recorders.get(keyOf(ctx));
          need(handle, 'failed', 'The recording is no longer running');
          recorders.delete(keyOf(ctx));
          let res;
          try { res = await handle.stop(); } catch (e) { ctx.setView({recording: null}); throw new CommandError('failed', `The recording could not be saved: ${e?.message ?? e}`); }
          const duration = seconds(Number.isFinite(res.duration) ? res.duration : (ctx.host.now() - r.start - (r.pausedFor ?? 0)) / 1000);
          const page = ctx.doc.pages[r.page];
          const hit = page ? recordingsOn(ctx, r.page).find(x => x.id === r.id) : null;
          ctx.setView({recording: null});
          if (!hit) return {stopped: 'recording', duration, kept: false};
          need(res.data && res.data.length <= 28_000_000, 'too_large', 'The recording is larger than a page can hold (about 20 MB) and was not kept');
          editPage(ctx, r.page, tr => {
            tr.setNodeAttribute(hit.pos, 'src', res.data);
            tr.setNodeAttribute(hit.pos, 'mime', res.mime ?? null);
            tr.setNodeAttribute(hit.pos, 'duration', duration);
          }, pageDoc(ctx, r.page));
          return {stopped: 'recording', duration, kept: true, object: `/pg:${r.page}/media:${r.id}`};
        }
        const pb = view(ctx).playback;
        need(pb, 'disabled', 'Nothing is recording or playing');
        await service(ctx)?.stop?.(pb.id);
        ctx.setView({playback: null});
        return {stopped: 'playback'};
      },
    },
    {
      id: 'media.pause', label: 'Pause', risk: 'read', effect: 'view',
      description: 'Pause the recording that is running (media.play resumes it) or pause playback.',
      params: s.object({}),
      state(ctx) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        const r = running(ctx), pb = view(ctx).playback;
        if (r) return {enabled: !r.paused, checked: !!r.paused, ...(r.paused ? {reason: 'Already paused'} : {})};
        if (pb) return {enabled: pb.playing === true, checked: pb.playing === false, ...(pb.playing ? {} : {reason: 'Already paused'})};
        return {enabled: false, reason: 'Nothing is recording or playing'};
      },
      async run(ctx) {
        const r = running(ctx);
        if (r) {
          await recorders.get(keyOf(ctx))?.pause?.();
          ctx.setView({recording: {...r, paused: true, pausedAt: ctx.host.now()}});
          return {paused: 'recording'};
        }
        const pb = view(ctx).playback;
        need(pb, 'disabled', 'Nothing is recording or playing');
        await service(ctx)?.pause?.(pb.id);
        ctx.setView({playback: {...pb, playing: false}});
        return {paused: 'playback'};
      },
    },
    {
      id: 'media.play', label: 'Play', shortcut: 'Mod+Alt+P', risk: 'read', effect: 'view',
      description: 'Play the selected recording (mediaId names another); fromParagraph, the block id of a note typed during a recording, plays it from the moment the note was typed. Resumes a paused recording or playback.',
      params: s.object({mediaId: s.optional(s.string({min: 1, max: 80})), fromParagraph: s.optional(s.string({min: 1, max: 80}))}),
      state(ctx, p) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        const r = running(ctx), pb = view(ctx).playback;
        if (r) return {enabled: !!r.paused, checked: !r.paused, ...(r.paused ? {} : {reason: 'Recording'})};
        if (pb?.playing && !p?.fromParagraph && !p?.mediaId) return {enabled: false, checked: true, reason: 'Playing'};
        const loc = currentLocation(ctx.doc, ctx.selection);
        if (!loc.pageId || !ctx.doc.pages[loc.pageId]) return {enabled: false, reason: 'No page is open'};
        if (!service(ctx)) return {enabled: false, reason: NO_SERVICE};
        return recordingsOn(ctx, loc.pageId).some(x => x.node.attrs.src) ? {enabled: true, checked: false} : {enabled: false, reason: 'This page has no recording to play'};
      },
      async run(ctx, p) {
        const r = running(ctx);
        if (r) {
          need(r.paused, 'disabled', 'The recording is already running');
          await recorders.get(keyOf(ctx))?.resume?.();
          ctx.setView({recording: {...r, paused: false, pausedFor: (r.pausedFor ?? 0) + (ctx.host.now() - (r.pausedAt ?? ctx.host.now())), pausedAt: undefined}});
          return {resumed: 'recording'};
        }
        const media = service(ctx);
        need(media, 'unavailable', NO_SERVICE);
        let from = null, mediaId = p.mediaId;
        if (p.fromParagraph) {
          const loc = currentLocation(ctx.doc, ctx.selection);
          const para = blockIndex(pageDoc(ctx, loc.pageId)).get(p.fromParagraph)?.node;
          need(para?.attrs.audio, 'not_found', `Note ${p.fromParagraph} was not typed during a recording`);
          from = para.attrs.audio.t; mediaId = para.attrs.audio.media;
        }
        const pb = view(ctx).playback;
        const t = targetOf(ctx, mediaId ?? (!p.fromParagraph && pb && !pb.playing ? pb.id : undefined));
        need(t.node.attrs.src, 'disabled', 'That recording is still being made');
        await media.play(t.id, {src: t.node.attrs.src, kind: t.node.attrs.kind, ...(from !== null ? {from} : pb?.id === t.id && !p.fromParagraph ? {} : {from: 0})});
        ctx.setView({playback: {id: t.id, playing: true}});
        return {playing: `/pg:${t.pageId}/media:${t.id}`, ...(from !== null ? {from} : {})};
      },
    },
    {
      id: 'media.seek', label: 'Rewind or Fast Forward', risk: 'read', effect: 'view',
      description: 'Move the recording being played (or the selected one) by `seconds`, negative to rewind (the buttons use 10 seconds and 10 minutes); it stays playing or paused as it was.',
      params: s.object({seconds: s.number({min: -86400, max: 86400})}),
      state(ctx) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        if (!service(ctx)) return {enabled: false, reason: NO_SERVICE};
        if (view(ctx).playback) return {enabled: true};
        const loc = currentLocation(ctx.doc, ctx.selection);
        return loc.pageId && ctx.doc.pages[loc.pageId] && recordingsOn(ctx, loc.pageId).some(x => x.node.attrs.src) ? {enabled: true} : {enabled: false, reason: 'This page has no recording to play'};
      },
      async run(ctx, p) {
        const media = service(ctx);
        need(media, 'unavailable', NO_SERVICE);
        const t = targetOf(ctx, view(ctx).playback?.id);
        const pos = (await media.position?.(t.id))?.t ?? 0;
        const to = seconds(Math.min(t.node.attrs.duration ?? Infinity, Math.max(0, pos + p.seconds)));
        await media.seek(t.id, to, {src: t.node.attrs.src, kind: t.node.attrs.kind});
        if (!view(ctx).playback) ctx.setView({playback: {id: t.id, playing: false}});
        return {at: to, duration: t.node.attrs.duration};
      },
    },
    {
      id: 'media.seePlayback', label: 'See Playback', risk: 'read', effect: 'view',
      description: 'Light the note being played as the recording plays (notes typed during the recording, at their moment); again turns it off.',
      params: s.object({value: s.optional(s.boolean())}),
      state: ctx => (isNotebook(ctx.doc) ? {enabled: true, checked: view(ctx).seePlayback === true} : {enabled: false, reason: 'No notebook is open'}),
      run(ctx, p) { const on = p.value ?? view(ctx).seePlayback !== true; ctx.setView({seePlayback: on}); return {value: on}; },
    },
  ],
});
