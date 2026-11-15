// Mailings › Select Recipients › Use an Existing List… (the window's side of U:quill/mailings).
//
// Translated from wordcraft crates/ui-egui/src/app/commands.rs (`ui.openRecipientList`,
// `pick_recipient_list`, `load_recipients`) and dialogs/dispatch.rs (`select_table_dialog`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The system Open dialog shows recipient lists (CSV, TSV, text, Excel .xlsx/.xlsm and OpenDocument
// .ods workbooks); only the chosen file's bytes come back (studio:pick-document), and
// mailings.recipients reads them. A workbook with several sheets asks which one holds the
// recipients (Select Table: the sheets, and whether the first row holds the column headers).

import {defineCommands} from '../../../../core/kernel/command.mjs';
import {s} from '../../../../core/kernel/schema.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';

export default defineCommands({
  family: 'mailings',
  app: 'quill',
  upstream: {repo: 'wordcraft' as const, commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/ui-egui/src/app/commands.rs', 'crates/ui-egui/src/dialogs/dispatch.rs']},
  commands: [
    {
      id: 'ui.openRecipientList', label: 'Use an Existing List', risk: 'edit',
      description: 'Select Recipients › Use an Existing List…: the system Open dialog for a recipient list (CSV, TSV, text, .xlsx, .xlsm, .ods); the list becomes the merge\'s recipients.',
      params: s.object({}),
      state: (ctx: any) => (ctx.doc ? {enabled: true} : {enabled: false, reason: 'No document is open'}),
      async run(ctx: any) {
        const studio = (globalThis as any).window?.studio ?? (globalThis as any).studio;
        if (typeof studio?.pickDocument !== 'function') throw new CommandError('unavailable', 'The Open dialog is not available here');
        const picked = await studio.pickDocument({purpose: 'recipients'});
        if (!picked) return {canceled: true};
        const base = {path: String(picked.name), data: String(picked.data)};
        let r = await ctx.run('mailings.recipients', base);
        if (r?.chooseSheet) {
          if (typeof ctx.host?.openDialog !== 'function') throw new CommandError('unavailable', 'Choosing a sheet needs the window');
          const v = await ctx.host.openDialog('dialog.selectTable', {sheets: r.sheets, selected: 0, headers: true});
          if (!v) return {canceled: true};
          r = await ctx.run('mailings.recipients', {...base, sheet: Number(v.selected ?? 0) + 1, headers: v.headers !== false});
        }
        return r;
      },
    },
  ],
});
