// Shared fixture for the U:quill/format unit's tests (format, para, para/styles, lists, font):
// a schema-2 Quill session built from plain text, addressing paragraphs by their block ids.

import {createTestSession} from '../../core/kernel/testing.mjs';
import {contentFromText} from '../../core/quill/model/content.mjs';
import {Document, BODY} from '../../core/quill/model/document.mjs';
import * as P from '../../core/quill/model/para.mjs';
import {layout} from '../../core/quill/layout/index.mjs';

/** A session over `text` (one paragraph per line); `edit(content)` may change the content first. */
export async function quill(text, edit, session = {}) {
  let content = contentFromText(text);
  if (edit) content = edit(content) ?? content;
  const t = await createTestSession('quill', {content, ...session});
  const h = {
    t,
    /** Block id of the n-th top-level body block. */
    id: n => blocks(t)[n].id,
    para: n => blocks(t)[n],
    texts: () => blocks(t).map(b => b.text),
    /** Select [from, to) in paragraph `n` (to defaults to a caret), or across paragraphs with [n, off] pairs. */
    sel(n, from, to = from) {
      const at = (k, off) => `/body/b:${blocks(t)[k].id}/t:${off}`;
      const [a, f] = Array.isArray(n) ? [at(n[0], n[1]), at(from[0], from[1])] : [at(n, from), at(n, to)];
      t.session.setSelection(t.docId, {ranges: [{anchor: a, focus: f}], primary: 0});
    },
    /** Runs of paragraph n as [text, props] pairs. */
    runs: n => P.runRanges(blocks(t)[n]).map(([a, b, c]) => [blocks(t)[n].text.slice(a, b), c]),
    props: n => blocks(t)[n].props ?? {},
    doc: () => new Document(t.content),
    exec: (id, params) => t.exec(id, params),
    state: (id, params) => t.state(id, params),
    /** Each body paragraph's list label as laid out (null: none). */
    labels() {
      const l = layout(t.content, {view: 'print'});
      return l.pages.flatMap(p => p.items).filter(i => i.kind === 'lines' && i.l0 === 0 && i.story === BODY).map(i => i.para.label?.text ?? null);
    },
  };
  return h;
}

export const blocks = t => t.content.body.chunks.flat();
