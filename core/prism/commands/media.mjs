// Audio and video on the slide (Playback and Video Format tabs): Play, Pause, Stop and Seek are requests
// the surface carries out with its player (`view.mediaRequest`), the player reports back through
// media.report (`view.media`), which media.info returns with the shape's options, and Poster Frame
// keeps a picture to show before the clip plays. Nothing plays by itself in the editor.
// Translated from deckcraft crates/engine/src/cmd/media.rs (`target`, `request`, `info`, `poster_frame`)
// at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The poster is the frame the player shows (the surface hands its PNG as `data`), a picture from the
// system Open dialog (`pick`), or none (`reset`); deckcraft decodes the frame itself.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {UPSTREAM_COMMIT, bad, targets, currentSlide, editShapes, addMedia, mediaBytes, contentType} from '../lib/shape-common.mjs';
import {findShape, mediaById} from '../model/presentation.mjs';
import {isSchema2} from '../model/doc.mjs';
import {hasDoc} from '../lib/text-session.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/media.rs']};
const ID = s.union([s.string({min: 1, max: 64}), s.integer({min: 0})]);
const idP = s.optional(ID);

/** The media shape a command acts on: `id` / `ids` / the selection, else the only media shape on the current slide. */
export function mediaTarget(ctx, p, cmd) {
  const sl = currentSlide(ctx, cmd);
  const asked = p.id !== undefined || p.ids !== undefined;
  let ids = [];
  try { ids = targets(ctx, p, cmd); } catch { ids = []; }
  const media = ids.map(id => findShape(sl.shapes, id)).find(x => x?.kind?.type === 'media');
  if (media) return media;
  if (ids.length && asked) throw bad(cmd, 'not a media shape');
  const all = (sl.shapes ?? []).filter(x => x.kind?.type === 'media');
  if (all.length === 1) return all[0];
  throw bad(cmd, all.length ? 'select an audio or video, or pass `id`' : 'no audio or video on this slide');
}

const status = (ctx, id) => ctx.view?.media?.[id] ?? null;
const ms = (p, k) => (typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0 ? Math.floor(p[k]) : undefined);

function request(ctx, p, cmd, action, at) {
  if (!isSchema2(ctx.doc)) throw bad(cmd, 'needs a presentation (schema 2)');
  const m = mediaTarget(ctx, p, cmd);
  ctx.setView({mediaRequest: {action, id: m.id, ...(at !== undefined ? {ms: at} : {}), n: (ctx.view?.mediaRequest?.n ?? 0) + 1}});
  return {id: m.id};
}
const playState = ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  try { const m = mediaTarget(ctx, {}, 'media.toggle'); return {enabled: true, checked: !!status(ctx, m.id)?.playing}; } catch (e) { return {enabled: false, reason: String(e.message ?? e).replace(/^media\.[a-zA-Z]+: /, '')}; }
};
const ready = cmd => ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  try { mediaTarget(ctx, {}, cmd); return {enabled: true}; } catch (e) { return {enabled: false, reason: String(e.message ?? e).replace(/^media\.[a-zA-Z]+: /, '')}; }
};

async function posterFrame(ctx, p) {
  const cmd = 'media.posterFrame';
  const m = mediaTarget(ctx, p, cmd);
  if (!m.kind.video) throw bad(cmd, 'only videos have poster frames');
  if (p.reset === true) {
    editShapes(ctx, {ids: [m.id]}, cmd, sh => { sh.kind.poster = null; });
    return {id: m.id, poster: null};
  }
  let q = p;
  if (p.data === undefined && p.pick === true) {
    // The UI path (Poster Frame › Image from File…): the system Open dialog gathers the picture; Cancel changes nothing.
    if (ctx.origin === 'bridge' || typeof ctx.host?.pickImage !== 'function') throw bad(cmd, 'give `data` (a PNG as base64)');
    const url = await ctx.host.pickImage();
    if (!url) return null;
    q = {data: String(url), name: p.name ?? 'poster.png'};
  }
  if (q.data === undefined) {
    // Current Frame: the surface's player holds the frame; it answers with its picture.
    if (ctx.origin === 'bridge') throw bad(cmd, 'give `data` (a PNG as base64), `pick` or `reset`');
    ctx.setView({mediaRequest: {action: 'poster', id: m.id, n: (ctx.view?.mediaRequest?.n ?? 0) + 1}});
    return {id: m.id, requested: true};
  }
  const {name, bytes} = await mediaBytes(ctx, {data: q.data, name: q.name ?? `poster${m.id}.png`}, cmd);
  if (!contentType(name, bytes).startsWith('image/')) throw bad(cmd, `${name} is not a picture`);
  const poster = addMedia(ctx, cmd, name, contentType(name, bytes), bytes);
  editShapes(ctx, {ids: [m.id]}, cmd, sh => { sh.kind.poster = poster; });
  return {id: m.id, ...(ms(p, 'ms') !== undefined ? {ms: ms(p, 'ms')} : {})};
}

export default defineCommands({
  family: 'media',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'media.play', label: 'Play', risk: 'read', effect: 'view', shortcut: 'Alt+P', state: ready('media.play'), description: '{id?, from?: ms}',
      params: s.object({id: idP, ids: s.optional(s.array(ID)), from: s.optional(s.number())}), run: (ctx, p) => request(ctx, p, 'media.play', 'play', ms(p, 'from'))},
    {id: 'media.pause', label: 'Pause', risk: 'read', effect: 'view', state: ready('media.pause'), description: '{id?}',
      params: s.object({id: idP, ids: s.optional(s.array(ID))}), run: (ctx, p) => request(ctx, p, 'media.pause', 'pause')},
    {id: 'media.toggle', label: 'Play/Pause', risk: 'read', effect: 'view', state: playState, description: '{id?}',
      params: s.object({id: idP, ids: s.optional(s.array(ID))}), run: (ctx, p) => request(ctx, p, 'media.toggle', 'toggle')},
    {id: 'media.stop', label: 'Stop', risk: 'read', effect: 'view', state: ready('media.stop'), description: '{id?}',
      params: s.object({id: idP, ids: s.optional(s.array(ID))}), run: (ctx, p) => request(ctx, p, 'media.stop', 'stop')},
    {id: 'media.seek', label: 'Seek', risk: 'read', effect: 'view', state: ready('media.seek'), description: '{id?, ms}',
      params: s.object({id: idP, ids: s.optional(s.array(ID)), ms: s.number()}),
      run(ctx, p) { const at = ms(p, 'ms'); if (at === undefined) throw bad('media.seek', 'missing `ms`'); return request(ctx, p, 'media.seek', 'seek', at); }},
    {id: 'media.report', label: 'Media State', risk: 'read', effect: 'view', journal: false, state: hasDoc,
      description: 'The player reports a clip: {id, playing, positionMs, durationMs?}. media.info returns it.',
      params: s.object({id: ID, playing: s.boolean(), positionMs: s.optional(s.number()), durationMs: s.optional(s.number())}),
      run(ctx, p) {
        const cur = ctx.view?.media ?? {};
        ctx.setView({media: {...cur, [p.id]: {playing: p.playing, positionMs: Math.round(p.positionMs ?? cur[p.id]?.positionMs ?? 0), ...(p.durationMs ? {durationMs: Math.round(p.durationMs)} : {})}}});
        return {};
      }},
    {id: 'media.info', label: 'Media Info', risk: 'read', effect: 'view', state: ready('media.info'),
      description: '{id?} → {id, name, contentType, bytes, durationMs, video, width, height, poster, options, status?}',
      params: s.object({id: idP, ids: s.optional(s.array(ID))}),
      run(ctx, p) {
        const m = mediaTarget(ctx, p, 'media.info'), k = m.kind, item = mediaById(ctx.doc, k.media);
        if (!item) throw bad('media.info', 'the media data is missing');
        const st = status(ctx, m.id);
        return {id: m.id, name: item.name, contentType: item.contentType, bytes: Math.floor(((item.data ?? '').length * 3) / 4), video: !!k.video, durationMs: st?.durationMs ?? k.durationMs ?? 0,
          width: k.width ?? 0, height: k.height ?? 0, poster: !!k.poster,
          options: {autoplay: !!k.autoplay, loop: !!k.loopPlay, rewind: !!k.rewind, acrossSlides: !!k.playAcrossSlides, hide: !!k.hideWhileNotPlaying, fullScreen: !!k.fullScreen, volume: k.volume ?? 1,
            trimStart: k.trimStartMs ?? 0, trimEnd: k.trimEndMs ?? 0, fadeIn: k.fadeInMs ?? 0, fadeOut: k.fadeOutMs ?? 0},
          ...(st ? {status: st} : {})};
      }},
    {id: 'media.posterFrame', label: 'Poster Frame', risk: 'edit', state: ready('media.posterFrame'),
      description: '{id?, data?: PNG as base64 (the frame), pick?: bool (the system Open dialog), reset?: bool (no poster), ms?} — without data, pick or reset the player\'s current frame is requested',
      params: s.object({id: idP, ids: s.optional(s.array(ID)), data: s.optional(s.string()), name: s.optional(s.string({max: 255})), pick: s.optional(s.boolean()), reset: s.optional(s.boolean()), ms: s.optional(s.number())}),
      run: posterFrame},
  ],
});
