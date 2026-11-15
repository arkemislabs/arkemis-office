// Developer › Templates › Document Template › Attach… (the window's side of U:quill/developer).
//
// Translated from wordcraft crates/ui-egui/src/app/commands.rs (`ui.attachTemplate`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The system Open dialog shows Word templates and documents (.dotx, .dotm, .docx); only the chosen file's name
// and bytes come back (studio:pick-document), and tools.attachTemplate records the name and, when the document
// updates its styles automatically, copies the template's styles in.

import {defineCommands} from '../../../../core/kernel/command.mjs';
import {s} from '../../../../core/kernel/schema.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';

export default defineCommands({
  family: 'tools',
  app: 'quill',
  upstream: {repo: 'wordcraft' as const, commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/ui-egui/src/app/commands.rs']},
  commands: [
    {
      id: 'ui.attachTemplate', label: 'Attach Template', risk: 'edit',
      description: 'Document Template › Attach…: the system Open dialog for a Word template (.dotx, .dotm, .docx); the document records it as its template, and takes its styles when it updates them automatically.',
      params: s.object({}),
      state: (ctx: any) => (ctx.doc ? {enabled: true} : {enabled: false, reason: 'No document is open'}),
      async run(ctx: any) {
        const studio = (globalThis as any).window?.studio ?? (globalThis as any).studio;
        if (typeof studio?.pickDocument !== 'function') throw new CommandError('unavailable', 'The Open dialog is not available here');
        const picked = await studio.pickDocument({purpose: 'template'});
        if (!picked) return {canceled: true};
        return ctx.run('tools.attachTemplate', {path: String(picked.name), data: String(picked.data), update: !!ctx.doc?.settings?.linkStyles});
      },
    },
  ],
});
