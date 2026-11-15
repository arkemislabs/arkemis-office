// Review › Accessibility › Check Accessibility and its pane.
//
// Translated from wordcraft crates/engine/src/cmd/tools/inspect.rs (`accessibility`), cmd/accessibility.rs (the checker, in
// core/quill/lib/accessibility-check.mjs) and cmd/view.rs (`view.accessibilityPane`) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `file.accessibility` is upstream's pure command: it returns the findings (`{ok, issues}`) and changes nothing. Here the ribbon button also
// shows the Accessibility pane (upstream's Review tab shows it with `view.accessibilityPane`); the pane lists the findings by kind, each a jump to
// the place and maybe a fix (an `action` command run with the caret there or the object selected).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import * as T from '../lib/table-session.mjs';
import {checkAccessibility} from '../lib/accessibility-check.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/engine/src/cmd/accessibility.rs', 'crates/engine/src/cmd/tools/inspect.rs', 'crates/engine/src/cmd/view.rs']};
const NONE = s.object({});

export default defineCommands({
  family: 'accessibility',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'file.accessibility', label: 'Check Accessibility', risk: 'read', effect: 'view', state: T.ready,
      description: 'Check Accessibility (Review › Accessibility): what makes the body hard to use with a screen reader or hard to read, as issues {kind: error|warning|tip, rule, issue, where, pos?, select?, fix?, action?} (missing alternative text, floating objects, skipped heading levels, "click here" links, empty paragraphs in a row, low contrast, tables without alternative text or a header row, empty or merged cells, no document title); shows the Accessibility pane.',
      params: NONE,
      run(ctx) {
        const issues = checkAccessibility(ctx.model.open(ctx));
        ctx.setView({accessibilityPane: true});
        return {ok: issues.length === 0, issues};
      }},
    {id: 'view.accessibilityPane', label: 'Accessibility Pane', risk: 'read', effect: 'view',
      state: ctx => { const r = T.ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.accessibilityPane} : r; },
      description: 'Accessibility (Review › Accessibility): shows or hides the Accessibility pane (`value` sets it).',
      params: s.object({value: s.optional(s.boolean())}),
      run(ctx, p) { const on = p.value ?? !ctx.view?.accessibilityPane; ctx.setView({accessibilityPane: on}); return {value: on}; }},
  ],
});
