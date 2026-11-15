// Contextual flags for Slate's contextual tabs (docs/architecture.md 7.2 and 8.6; F:slate).
//
// docs/spec/slate.json names three contextual tabs: Table Layout (`table`), Equation
// (`equation`) and Audio & Video (`media`). As in OneNote they show while the selection is inside
// a table, on an equation, or on an audio or video recording.
//
// No DOM, no Node built-ins.

import {isNotebook, nodeOf} from './schema.mjs';
import {blockIndex} from './model/page.mjs';

export const flags = Object.freeze(['table', 'equation', 'media']);

const NONE = Object.freeze({table: false, equation: false, media: false});

/** The block ids (innermost first) the selection's focus sits in, with the page doc. */
function focusChain(content, selection) {
  const r = selection?.ranges?.[selection.primary ?? 0];
  if (!r) return null;
  const m = /^\/pg:([^/]+)\/(b|c|media):([^/]+)/.exec(r.focus ?? r.anchor ?? '');
  if (!m) return null;
  const page = content.pages[decodeURIComponent(m[1])];
  if (!page) return null;
  const index = blockIndex(nodeOf(page.body));
  const chain = [];
  let id = decodeURIComponent(m[3]);
  for (let guard = 0; id && guard < 64; guard++) {
    const hit = index.get(id);
    if (!hit) break;
    chain.push(hit.node);
    id = hit.parent;
  }
  return chain;
}

export function evaluate(content, selection, _prefs, view) {
  if (!isNotebook(content)) return NONE;
  const chain = focusChain(content, selection);
  if (!chain?.length) return view?.recording ? {...NONE, media: true} : NONE;
  const own = chain[0];
  return {
    table: chain.some(n => n.type.name === 'table' || n.type.name === 'tableCell'),
    equation: own.type.name === 'equation',
    media: own.type.name === 'media' || !!view?.recording,
  };
}
