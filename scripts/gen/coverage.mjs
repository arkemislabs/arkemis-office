// Coverage and manifest (docs/architecture.md section 6.1 step 8): core/generated/manifest.json
// for the automation layer, artifacts/coverage/<app>.json for the people filling the
// registry in, and artifacts/coverage/icons.json for icon ownership.
import {toJSONSchema, validate} from '../../core/kernel/schema.mjs';
import {normalizeCommand} from '../../core/kernel/command.mjs';
import {walkControls} from './spec.mjs';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ids of the commands an app registers in the renderer (src/apps/<app>/ui-commands/*.ts: the ones that need the live
 * page view). They are read from the source, so a control that names one counts as implemented, as it is at run time.
 */
export function uiCommandIds(root, app) {
  const dir = path.join(root, 'src/apps', app, 'ui-commands');
  const out = new Set();
  let files = [];
  try { files = fs.readdirSync(dir).filter(n => n.endsWith('.ts') && !n.startsWith('_')); } catch { return out; }
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/^\s*id:\s*([^\n]*)$/gm)) for (const q of m[1].matchAll(/'([a-z][\w]*(?:\.[\w]+)+)'/g)) out.add(q[1]);
  }
  return out;
}

const PLACEHOLDER = /^<[^>]*>$|^\{[^}]*\}$/;
/** Spec args with runtime placeholders ("<pt>", "{n}") dropped: only the fixed parts are checked. */
export function fixedArgs(args) {
  if (!args || typeof args !== 'object') return {};
  return Object.fromEntries(Object.entries(args).filter(([, v]) => !(typeof v === 'string' && PLACEHOLDER.test(v))));
}

/** Every control's args validate (partially) against its registered command's params. */
export function checkControlArgs(app, model, commandsById, report) {
  if (!model) return [];
  const bad = [];
  const check = (c, where) => {
    if (!c.command || !c.args) return;
    const cmd = commandsById.get(c.command);
    if (!cmd) return;
    const r = validate(cmd.params, fixedArgs(c.args), {partial: true});
    if (!r.ok) {
      const msg = r.errors.map(e => `${e.path || '/'} ${e.message}`).join('; ');
      bad.push({control: c.id, command: c.command, errors: r.errors});
      report.error(`${model.specFile}#${c.id}`, `args ${JSON.stringify(c.args)} do not fit ${c.command} params (${msg}) [${where}]`);
    }
  };
  walkControls(model.tabs, (c, {tab}) => check(c, `tab ${tab.id}`));
  for (const c of model.qat) check(c, 'quick access toolbar');
  return bad;
}

/** Control status: implemented when its command is registered (or, for dialog-only controls, the dialog has a model). */
export function controlStatus(model, commandsById, dialogIds) {
  const implemented = [], pending = [];
  const status = new Map();
  const decide = c => {
    if (c.command) return commandsById.has(c.command);
    if (c.dialog) return dialogIds.has(c.dialog);
    if (c.launcher) return true;
    return (c.items || []).some(k => k.id && status.get(k.id));
  };
  const visit = c => {
    if (!c || c.separator || c.header) return;
    for (const k of c.items || []) visit(k);
    const ok = decide(c);
    status.set(c.id, ok);
    if (ok) implemented.push(c.id); else pending.push({id: c.id, command: c.command ?? null, dialog: c.dialog ?? null});
  };
  for (const tab of model.tabs) for (const g of tab.groups) for (const c of g.controls) visit(c);
  for (const c of model.qat) visit(c);
  return {implemented, pending, status};
}

export function manifestEntries(app, modules, model) {
  const ribbon = new Map();
  if (model) {
    walkControls(model.tabs, (c, {tab, group}) => {
      if (!c.command) return;
      if (!ribbon.has(c.command)) ribbon.set(c.command, []);
      ribbon.get(c.command).push(`${tab.id}/${group.id}/${c.id}`);
    });
    for (const c of model.qat) if (c.command) (ribbon.get(c.command) ?? ribbon.set(c.command, []).get(c.command)).push(`qat/${c.id}`);
  }
  const out = [];
  for (const m of modules) {
    for (const raw of m.module.commands) {
      const c = normalizeCommand(raw);
      out.push({
        id: c.id, app, family: m.family, common: m.module.app === '*', label: c.label, description: c.description ?? model?.commands?.[c.id]?.summary ?? null,
        risk: c.risk, escalates: typeof c.riskFor === 'function', needs: c.needs, scope: c.scope, effect: c.effect, undo: c.undo,
        params: toJSONSchema(c.params), ribbon: ribbon.get(c.id) ?? [], shortcut: c.shortcut ?? null, dialog: c.dialog ?? null,
        upstream: m.module.upstream, source: m.rel,
      });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function appCoverage(app, {model, modules, dialogs, icons, iconOwners, ownership, warnings, argProblems, uiIds = new Set()}) {
  const commandsById = new Map(modules.flatMap(m => m.module.commands.map(c => [c.id, c])));
  for (const id of uiIds) if (!commandsById.has(id)) commandsById.set(id, {id, ui: true});
  const dialogIds = new Set(dialogs.keys());
  const out = {app, spec: model?.specFile ?? null, registered: commandsById.size};
  if (!model) return {...out, legacy: true, warnings};
  const {implemented, pending} = controlStatus(model, commandsById, dialogIds);
  const specIds = Object.keys(model.commands);
  const notRegistered = specIds.filter(id => !commandsById.has(id))
    .map(id => ({id, family: model.commands[id].family, owner: ownership.commandOwner(app, id) ?? `F:${app}`}));
  const families = {};
  for (const c of Object.values(model.commands)) {
    const owner = ownership.commandOwner(app, c.id) ?? `U:${app}/${c.family}`;
    const key = owner === 'I' ? `common (${c.family})` : c.family;
    const f = (families[key] ||= {owner, specCommands: 0, registered: 0, fromSourceRef: c.familyFromSource});
    f.specCommands++;
    if (commandsById.has(c.id)) f.registered++;
  }
  const referencedIcons = new Set();
  walkControls(model.tabs, c => { if (c.icon) referencedIcons.add(c.icon); });
  for (const c of model.qat) if (c.icon) referencedIcons.add(c.icon);
  const iconsMissing = [...referencedIcons].filter(i => !icons[i]).sort().map(icon => ({icon, owner: iconOwners[icon]?.owner ?? 'I'}));
  const unplaced = [];
  for (const tab of model.tabs) for (const g of tab.groups) for (const item of g.layout) if (item.unplaced) unplaced.push(item.small);
  const dialogsWithoutModel = Object.values(model.dialogs).filter(d => !dialogIds.has(d.id))
    .map(d => ({id: d.id, command: d.command, owner: ownership.dialogOwner(app, d.id)}));
  return {
    ...out,
    counts: {
      controls: implemented.length + pending.length, implemented: implemented.length, pending: pending.length,
      specCommands: specIds.length, specCommandsRegistered: specIds.length - notRegistered.length,
      dialogs: Object.keys(model.dialogs).length, dialogsWithModel: Object.keys(model.dialogs).length - dialogsWithoutModel.length,
      icons: referencedIcons.size, iconsMissing: iconsMissing.length,
      tabs: model.tabs.length, tabsWithOverlay: model.tabs.filter(t => t.layoutSource !== 'default').length,
    },
    controls: {implemented, pending},
    specCommandsNotRegistered: notRegistered,
    registeredNotInSpec: [...commandsById.keys()].filter(id => !model.commands[id]).sort(),
    dialogsWithoutModel,
    iconsMissing,
    unplacedControls: unplaced,
    tabsWithoutOverlay: model.tabs.filter(t => t.layoutSource === 'default').map(t => t.id),
    families,
    argProblems,
    inputs: model.inputs,
    warnings,
  };
}
