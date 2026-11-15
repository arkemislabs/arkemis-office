// Picture Format › Adjust › Change Picture and Size › Crop (the window's side of U:quill/shapes).
//
// Translated from wordcraft crates/ui-egui/src/ribbon/picture.rs (`ui.changePicture`: the system Open dialog for an
// image, then `picture.change`; `ui.crop`: the on-page crop handles) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. The page view draws the handles (surface/CropHandles.tsx); the
// Format Picture pane has the exact offsets, the same fractions picture.crop sets.

import {defineCommands} from '../../../../core/kernel/command.mjs';
import {s} from '../../../../core/kernel/schema.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';

const hasPicture = (ctx: any) => {
  if (!ctx.doc) return {enabled: false, reason: 'No document is open'};
  return {enabled: true};
};

export default defineCommands({
  family: 'objects',
  app: 'quill',
  upstream: {repo: 'wordcraft' as const, commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/ui-egui/src/ribbon/picture.rs']},
  commands: [
    {
      id: 'ui.changePicture', label: 'Change Picture', risk: 'edit',
      description: 'Change Picture › From a File…: the system Open dialog for a picture; the selected picture shows it instead, in the same frame (picture.change).',
      params: s.object({}),
      state: hasPicture,
      async run(ctx: any) {
        const studio = (globalThis as any).window?.studio ?? (globalThis as any).studio;
        if (typeof studio?.pickImage !== 'function') throw new CommandError('unavailable', 'The Open dialog is not available here');
        const url = await studio.pickImage();
        if (!url) return {canceled: true};
        return ctx.run('picture.change', {data: String(url)});
      },
    },
    {
      id: 'ui.fillPicture', label: 'Picture Fill', risk: 'edit',
      description: 'Shape Fill › Picture…: the system Open dialog for a picture; the selected shape, text box or canvas is filled with it (shape.fillPicture). Not checked against upstream.',
      params: s.object({}),
      state: (ctx: any) => (ctx.doc ? {enabled: true} : {enabled: false, reason: 'No document is open'}),
      async run(ctx: any) {
        const studio = (globalThis as any).window?.studio ?? (globalThis as any).studio;
        if (typeof studio?.pickImage !== 'function') throw new CommandError('unavailable', 'The Open dialog is not available here');
        const url = await studio.pickImage();
        if (!url) return {canceled: true};
        return ctx.run('shape.fillPicture', {data: String(url)});
      },
    },
    {
      id: 'ui.pagePicture', label: 'Picture Page Background', risk: 'edit',
      description: 'Page Color › Picture…: the system Open dialog for a picture; it becomes the page background (design.pageFill). Not checked against upstream.',
      params: s.object({}),
      state: (ctx: any) => (ctx.doc ? {enabled: true} : {enabled: false, reason: 'No document is open'}),
      async run(ctx: any) {
        const studio = (globalThis as any).window?.studio ?? (globalThis as any).studio;
        if (typeof studio?.pickImage !== 'function') throw new CommandError('unavailable', 'The Open dialog is not available here');
        const url = await studio.pickImage();
        if (!url) return {canceled: true};
        return ctx.run('design.pageFill', {kind: 'picture', data: String(url)});
      },
    },
    {
      id: 'ui.crop', label: 'Crop', risk: 'read', effect: 'view',
      description: 'Crop (Picture Format › Size): crop mode, the selected picture with Word\'s crop handles on the page (view.cropMode); the Format Picture pane has the exact offsets.',
      params: s.object({}),
      state: hasPicture,
      run: (ctx: any) => ctx.run('view.cropMode', {}),
    },
  ],
});
