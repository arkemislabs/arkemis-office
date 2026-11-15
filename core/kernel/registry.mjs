// buildRegistry(modules) -> lookup / list / state (docs/architecture.md sections 4 and 6).
// The modules come from core/generated/<app>.commands.mjs (`modules` plus parallel `sources`).
// No DOM, no Node built-ins.

import {normalizeCommand} from './command.mjs';

/** Every id defined more than once across modules, with the files that define it. */
export function findDuplicates(modules, sources = []) {
  const where = new Map();
  modules.forEach((m, i) => {
    for (const c of m?.commands || []) {
      const file = sources[i] || `module #${i} (${m.family})`;
      if (!where.has(c.id)) where.set(c.id, []);
      where.get(c.id).push(file);
    }
  });
  return [...where].filter(([, files]) => files.length > 1).map(([id, files]) => ({id, files}));
}

const appliesTo = (m, app) => !app || m.app === '*' || m.app === app || (Array.isArray(m.app) && (m.app.includes(app) || m.app.includes('*')));

/**
 * @param {object[]} modules default exports of command family files (defineCommands results)
 * @param {{app?: string, sources?: string[]}} [opts]
 */
export function buildRegistry(modules, {app, sources = []} = {}) {
  const dups = findDuplicates(modules.filter(m => appliesTo(m, app)), sources.filter((_, i) => appliesTo(modules[i], app)));
  if (dups.length) {
    const d = dups[0];
    throw new Error(`Duplicate command id "${d.id}" defined in ${d.files.join(' and ')}`);
  }
  const byId = new Map();
  const families = new Map();
  modules.forEach((m, i) => {
    if (!appliesTo(m, app)) return;
    const source = sources[i] || null;
    const list = [];
    for (const c of m.commands) {
      const cmd = Object.freeze({...normalizeCommand(c), family: m.family, familyApp: m.app, upstream: m.upstream, source});
      byId.set(cmd.id, cmd);
      list.push(cmd);
    }
    families.set(`${m.app === '*' ? 'common' : app || m.app}:${m.family}`, Object.freeze({family: m.family, app: m.app, upstream: m.upstream, source, commands: list}));
  });
  const all = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze({
    app: app || null,
    get size() { return byId.size; },
    get(id) { return byId.get(id) || null; },
    has(id) { return byId.has(id); },
    ids() { return all.map(c => c.id); },
    families() { return [...families.values()]; },
    /** Commands matching a search (id, label or description, case-insensitive) and/or a family. */
    list({search, family} = {}) {
      const q = typeof search === 'string' ? search.trim().toLowerCase() : '';
      return all.filter(c => (!family || c.family === family)
        && (!q || c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q)));
    },
  });
}
