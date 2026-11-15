// Customize Ribbon (tabs, custom groups, Quick Access Toolbar) for every app.
// Translated from wordcraft crates/engine/src/cmd/tools/actions.rs (customize_ribbon) and
// crates/engine/src/ribbon.rs at aadb077e072b7de05f724e359d8db82e151f125c. Without params it only
// reports the layout (the UI opens dialog.customizeRibbon; programmatic calls never open dialogs).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {RibbonLayout, LayoutError} from '../lib/ribbon-layout.mjs';

const name = s.string({min: 1, max: 200});
const by = s.integer({min: -1000, max: 1000, description: 'places to move, e.g. -1 or 1'});

export function layoutFor(ctx) {
  const info = ctx.appInfo || {tabs: [], contextualTabs: [], qat: []};
  const has = id => ctx.registry.has(id);
  const l = RibbonLayout.fromValue(info, ctx.prefs.ribbon || {});
  l.retainKnown(has);
  return l;
}

export default defineCommands({
  family: 'tools',
  app: '*',
  upstream: {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c',
    files: ['crates/engine/src/cmd/tools/actions.rs', 'crates/engine/src/ribbon.rs']},
  commands: [
    {
      id: 'tools.customizeRibbon', label: 'Customize Ribbon', risk: 'edit', effect: 'prefs', undo: 'none', scope: 'app',
      dialog: 'dialog.customizeRibbon', repeatable: false,
      description: 'Read and change the ribbon tabs, custom groups and the Quick Access Toolbar. Only custom tabs and groups can be renamed or removed; built-in tabs can be hidden and moved.',
      params: s.object({
        hide: s.optional(name), show: s.optional(name),
        newTab: s.optional(s.object({name: s.optional(name), after: s.optional(name)})),
        newGroup: s.optional(s.object({tab: name, name: s.optional(name)})),
        add: s.optional(s.object({tab: name, group: name, command: name, after: s.optional(name)})),
        remove: s.optional(s.object({tab: name, group: s.optional(name), command: s.optional(name)})),
        rename: s.optional(s.object({tab: name, group: s.optional(name), to: name})),
        move: s.optional(s.object({tab: name, group: s.optional(name), command: s.optional(name), by})),
        qatAdd: s.optional(name), qatRemove: s.optional(name),
        qatMove: s.optional(s.object({command: name, by})),
        reset: s.optional(s.union([s.literal(true), s.enum(['ribbon', 'qat'])])),
        layout: s.optional(s.any()),
      }),
      run(ctx, v) {
        const has = id => ctx.registry.has(id);
        let l = layoutFor(ctx);
        const out = {};
        let asked = false;
        try {
          if (v.layout !== undefined) { asked = true; l = RibbonLayout.fromValue(l.info, v.layout); l.retainKnown(has); }
          if (v.reset !== undefined) {
            asked = true;
            if (v.reset === true) l = new RibbonLayout(l.info);
            else if (v.reset === 'ribbon') l.resetRibbon();
            else l.resetQat();
          }
          if (v.hide !== undefined) { asked = true; l.setHidden(v.hide, true); }
          if (v.show !== undefined) { asked = true; l.setHidden(v.show, false); }
          if (v.newTab) { asked = true; out.tab = l.newTab(v.newTab.name, v.newTab.after); }
          if (v.newGroup) { asked = true; out.group = l.newGroup(v.newGroup.tab, v.newGroup.name); }
          if (v.add) { asked = true; out.added = l.add(has, v.add.tab, v.add.group, v.add.command, v.add.after); }
          if (v.remove) { asked = true; l.remove(v.remove.tab, v.remove.group, v.remove.command); }
          if (v.rename) { asked = true; out.name = l.rename(v.rename.tab, v.rename.group, v.rename.to); }
          if (v.move) { asked = true; l.moveBy(v.move.tab, v.move.group, v.move.command, v.move.by); }
          if (v.qatAdd !== undefined) { asked = true; out.added = l.qatAdd(has, v.qatAdd); }
          if (v.qatRemove !== undefined) { asked = true; out.removed = l.qatRemove(v.qatRemove); }
          if (v.qatMove) { asked = true; l.qatMove(v.qatMove.command, v.qatMove.by); }
        } catch (e) {
          if (e instanceof LayoutError) throw new CommandError('invalid_params', e.message);
          throw e;
        }
        if (asked) ctx.updatePrefs({ribbon: l.toValue()});
        return {...out, tabs: l.tabsValue(), qat: l.qat()};
      },
    },
  ],
});
