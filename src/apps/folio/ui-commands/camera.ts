// Scan & OCR > Enhance > Camera image: Enhance page (the part of the page that needs the page as a picture).
//
// Translated from printcraft crates/engine/src/camera.rs (`enhance_camera_page_at`) at 8f16855 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt): the page is read as a picture (here by pdf.js, at 300 dpi, at most 40 million
// pixels; upstream reads it at its own picture's resolution up to 600 dpi), the corners are warped to an upright rectangle, given a look at a
// level, encoded (JPEG at quality 90; black and white is lossless PNG) and the page's content becomes that picture through Replace pages, so its
// comments, links and bookmarks stay: one undoable step ("Enhance camera image"). The page keeps the photo's physical size: one device pixel
// per `k` points. The pixel work is core/folio/lib/camera.mjs; the tool's state, its commands and its bar are core/folio/commands/camera.mjs.

import {PDFDocument} from 'pdf-lib';
import {defineCommands} from '../../../../core/kernel/command.mjs';
import {s} from '../../../../core/kernel/schema.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';
import {assembly} from '../../../../core/folio/lib/edit-needs.mjs';
import {viewSize, pageRotation} from '../../../../core/folio/lib/geom.mjs';
import {warp, applyLook, MAX_PIXELS, DEFAULT_LEVEL} from '../../../../core/folio/lib/camera.mjs';
import {acquire, release, raster} from '../surface/pdf';

const UPSTREAM = {repo: 'printcraft' as const, commit: '8f16855', files: ['crates/engine/src/camera.rs', 'crates/engine/src/camera_clean.rs']};
/** camera.rs DEFAULT_SCALE and QUALITY. */
const DEFAULT_SCALE = 300 / 72;
const QUALITY = 0.9;

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the straightened page could not be encoded'))), type, quality));

export default defineCommands({
  family: 'photo',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'camera.enhance', label: 'Enhance page', risk: 'edit', undo: 'auto', needs: 'view',
      description: 'Enhance page (Scan & OCR > Enhance camera image): straighten what the four corners enclose to a rectangle and give it the chosen look and clean-up level; the page\'s content becomes that picture (one undo step) and keeps its comments, links and bookmarks. `again: true` enhances an enhanced page again from the corners it was made from (the steps of the first enhancement have been undone).',
      params: s.object({again: s.optional(s.boolean())}),
      state: (ctx: any) => {
        const st = assembly(ctx);
        if (!st.enabled) return st;
        if (ctx.view?.tool !== 'ocr.enhance_camera') return {enabled: false, reason: 'pick Enhance camera image first'};
        return ctx.view?.camera ? (ctx.view?.cameraDone && !ctx.view?.cameraDone.restyle ? {enabled: false, reason: 'the page is enhanced: choose a look or Done'} : {enabled: true}) : {enabled: false, reason: 'place the corners first'};
      },
      async run(ctx: any, p: any) {
        const cam = ctx.view?.camera;
        if (!cam) throw new CommandError('disabled', 'place the corners first');
        const list: any[] = ctx.doc.pages;
        const pi = list.findIndex(x => x.id === cam.page);
        if (pi < 0) throw new CommandError('not_found', 'the page is gone');
        const page = list[pi];
        const {width, height} = viewSize(page);
        const scale = Math.max(0.01, Math.min(DEFAULT_SCALE, Math.sqrt(MAX_PIXELS / Math.max(1, width * height))));
        const source = acquire(ctx.doc.sourceBase64);
        let canvas: HTMLCanvasElement;
        try { canvas = await raster(source, page.sourceIndex, pageRotation(page), scale, new Set(), new AbortController().signal); } catch (e: any) {
          throw new CommandError('failed', `page ${pi + 1} could not be rendered: ${e?.message ?? e}`);
        } finally { release(source); }
        const shot = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
        const k = canvas.width / Math.max(width, 1e-3);
        let out;
        try { out = warp(shot.data, shot.width, shot.height, cam.corners.map(([x, y]: number[]) => [x * k, y * k])); } catch (e: any) { throw new CommandError('invalid_params', e.message); }
        const look: string = cam.look ?? 'colour', level: number = cam.level ?? DEFAULT_LEVEL;
        const pixels = applyLook(out.rgb, out.width, out.height, look, level);
        if (!pixels) throw new CommandError('failed', 'the straightened page could not be cleaned up');
        const bw = look === 'bw';
        const flat = document.createElement('canvas');
        flat.width = out.width; flat.height = out.height;
        const image = new ImageData(out.width, out.height);
        for (let i = 0; i < out.width * out.height; i++) {
          const r = pixels.kind === 'grey' ? pixels.data[i] : pixels.data[i * 3], g = pixels.kind === 'grey' ? pixels.data[i] : pixels.data[i * 3 + 1], b = pixels.kind === 'grey' ? pixels.data[i] : pixels.data[i * 3 + 2];
          image.data[i * 4] = r; image.data[i * 4 + 1] = g; image.data[i * 4 + 2] = b; image.data[i * 4 + 3] = 255;
        }
        flat.getContext('2d')!.putImageData(image, 0, 0);
        const blob = await toBlob(flat, bw ? 'image/png' : 'image/jpeg', bw ? undefined : QUALITY);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const pdf = await PDFDocument.create();
        const embedded = bw ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        // One device pixel per `k` points keeps the page's physical size.
        const pw = out.width / k, ph = out.height / k;
        pdf.addPage([pw, ph]).drawImage(embedded, {x: 0, y: 0, width: pw, height: ph});
        const base64 = await pdf.saveAsBase64();
        await ctx.run('page.replace', {base64, name: 'camera.pdf', from: pi + 1, to: pi + 1});
        ctx.setUndoLabel('Enhance camera image');
        ctx.setView({cameraDone: {page: page.id, corners: cam.corners, look, level, applied: [look, level], turns: 0, steps: 1, restyle: 0}});
        return {page: pi + 1, width: out.width, height: out.height, look, level, bytes: bytes.length, points: [Math.round(pw), Math.round(ph)]};
      },
    },
  ],
});
