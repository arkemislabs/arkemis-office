// Spelling in OneNote (U:slate/spelling): the misspelt words of a page's notes, read with the shared spelling service
// (core/common/lib/spelling.mjs): US English, the bundled en_US dictionary; the user dictionary and the ignore lists are the service's.
// The squiggles under the words (the page editor's decorations), the Spelling pane and the right-click menu all read the same issues.
//
// Slate has no ArtCraft upstream: behaviour is OneNote's (Review > Spelling checks the notes of the page: text in tables too; text marked
// "Do not check spelling or grammar" (Review > Language) or in another language, and links, are left alone). Not checked against upstream.
// No DOM, no Node built-ins.

import {isCheckedLanguage, wordsOf} from '../../common/lib/spelling.mjs';

const textOf = node => node.textBetween(0, node.content.size, ' ', ' ');

/** Ranges [from, to] (offsets in the block's content) left unchecked: marked "do not check", in a language the dictionary does not cover, and links. */
function unchecked(node) {
  const out = [];
  node.forEach((child, offset) => {
    if (child.marks.some(m => (m.type.name === 'language' && (m.attrs.noCheck || !isCheckedLanguage(m.attrs.lang))) || m.type.name === 'link')) out.push([offset, offset + child.nodeSize]);
  });
  return out;
}

/** Ignore Once's key for a word: the page, the block, where in it and which word. */
export const issueKey = (page, block, start, word) => `${page}|${block}|${start}|${String(word).toLowerCase()}`;

/**
 * The misspelt words of one text block, as offsets into its content: [{start, end, word, key}] (`key` names the occurrence; Ignore Once and the
 * session's Ignore All have already left theirs out). Words not looked up yet count as correct (the service queues them).
 */
export function blockIssues(node, sp, o = {}) {
  if (!node.isTextblock || !node.content.size) return [];
  const text = textOf(node);
  if (!text.trim() || text.length > 100_000) return [];
  const skips = unchecked(node);
  const skip = skips.length ? (a, b) => skips.some(([x, y]) => x < b && a < y) : undefined;
  const out = [];
  for (const t of sp.misspellings(text, {session: o.session, skip})) {
    const key = issueKey(o.page ?? '', node.attrs?.id ?? '', t.start, t.text);
    if (o.session !== undefined && sp.isIgnoredOnce(o.session, key)) continue;
    out.push({start: t.start, end: t.end, word: t.text, key});
  }
  return out;
}

/**
 * The misspelt words of a page: [{page, block, start, end, from, to, word, key, lang}], `from` and `to` positions in the page body (valid until
 * the page is edited), in reading order. `doc` is the page's ProseMirror document.
 */
export function pageIssues(doc, pageId, sp, o = {}) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    for (const t of blockIssues(node, sp, {...o, page: pageId})) {
      out.push({page: pageId, block: node.attrs?.id ?? '', start: t.start, end: t.end, from: pos + 1 + t.start, to: pos + 1 + t.end, word: t.word, key: t.key, lang: 'en-US'});
    }
    return false;
  });
  return out;
}

/** Every word of the page looked up, then `pageIssues`; the first `limit` issues also have the dictionary's suggestions. */
export async function pageIssuesAll(doc, pageId, sp, o = {}) {
  const words = [];
  doc.descendants(node => {
    if (!node.isTextblock) return true;
    const text = node.content.size ? textOf(node) : '';
    const skips = text ? unchecked(node) : [];
    for (const t of wordsOf(text)) if (!skips.some(([x, y]) => x < t.end && t.start < y)) words.push(t.text);
    return false;
  });
  await sp.prepare(words);
  const found = pageIssues(doc, pageId, sp, o);
  const n = o.suggest ?? 50;
  const out = [];
  for (const it of found) out.push({...it, suggestions: out.length < n ? await sp.suggest(it.word, 6) : []});
  return out;
}
