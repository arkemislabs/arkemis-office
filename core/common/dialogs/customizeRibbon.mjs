// Customize Ribbon dialog model (Ribbon and Quick Access Toolbar pages; submit: tools.customizeRibbon).
// Upstream: wordcraft crates/ui-egui/src/dialogs/dialogs_ribbon.rs. The upstream dialog applies
// each button at once; here every button maps to one tools.customizeRibbon call, and Close
// re-applies the whole layout (a no-op when nothing changed).
//
// Values: {tabs, qat, search, command (chosen in the command list), tab, group (chosen in the
// tabs tree), qatCommand (chosen in the QAT list), page: 'ribbon' | 'qat', name (rename box)}.

import {defineDialog} from '../../kernel/dialog.mjs';
import {layoutFor} from '../commands/tools.mjs';

const call = params => ({command: 'tools.customizeRibbon', params});

export default defineDialog({
  id: 'dialog.customizeRibbon',
  title: 'Customize Ribbon',
  command: 'tools.customizeRibbon',
  init(ctx) {
    const l = layoutFor(ctx);
    return {tabs: l.tabsValue(), qat: l.qat(), search: '', command: null, tab: null, group: null, qatCommand: null, page: 'ribbon', name: ''};
  },
  validate: () => [],
  buttons: {
    add: (ctx, v) => (v.page === 'qat'
      ? (v.command ? call({qatAdd: v.command}) : null)
      : (v.command && v.tab && v.group ? call({add: {tab: v.tab, group: v.group, command: v.command}}) : null)),
    remove: (ctx, v) => (v.page === 'qat'
      ? (v.qatCommand ? call({qatRemove: v.qatCommand}) : null)
      : (v.tab ? call({remove: {tab: v.tab, ...(v.group ? {group: v.group} : {}), ...(v.command ? {command: v.command} : {})}}) : null)),
    up: (ctx, v) => (v.page === 'qat'
      ? (v.qatCommand ? call({qatMove: {command: v.qatCommand, by: -1}}) : null)
      : (v.tab ? call({move: {tab: v.tab, ...(v.group ? {group: v.group} : {}), by: -1}}) : null)),
    down: (ctx, v) => (v.page === 'qat'
      ? (v.qatCommand ? call({qatMove: {command: v.qatCommand, by: 1}}) : null)
      : (v.tab ? call({move: {tab: v.tab, ...(v.group ? {group: v.group} : {}), by: 1}}) : null)),
    newTab: (ctx, v) => call({newTab: v.tab ? {after: v.tab} : {}}),
    newGroup: (ctx, v) => (v.tab ? call({newGroup: {tab: v.tab}}) : null),
    rename: (ctx, v) => (v.tab && String(v.name ?? '').trim() ? call({rename: {tab: v.tab, ...(v.group ? {group: v.group} : {}), to: String(v.name).trim()}}) : null),
    reset: (ctx, v) => call({reset: v.page === 'qat' ? 'qat' : 'ribbon'}),
  },
  toCommand: values => call({layout: {tabs: values.tabs, qat: values.qat}}),
});
