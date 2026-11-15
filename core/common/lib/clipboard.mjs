// Clipboard core shared by every app's cut/copy/paste commands.
//
// Copy writes plain text and HTML to the system clipboard through the Host and keeps the rich,
// app-internal payload in the session (`session.clipboard`, plus the 24-item Office Clipboard
// ring `session.clipboardItems`). Paste prefers the internal payload while the system clipboard
// still holds the text that copy wrote; anything else is external content.
//
// Apps own their payload format (`kind` + `data`); this module only moves it around.

const MAX_TEXT = 10_000_000;

/**
 * Put content on the clipboard. Call from a command's run(); the session stores the internal
 * payload when the command commits.
 * @param {import('../../kernel/command.mjs').Ctx} ctx
 * @param {{text?: string, html?: string, kind?: string, data?: unknown, label?: string}} entry
 */
export async function writeClipboard(ctx, {text = '', html = '', kind = null, data = null, label} = {}) {
  const t = String(text ?? '');
  if (t.length > MAX_TEXT) throw new Error('The selection is too large to copy');
  await ctx.host.clipboardWrite({text: t, html: String(html ?? '')});
  ctx.setClipboard({app: ctx.app, kind, data, text: t, html: String(html ?? ''), label: label ?? preview(t)});
}

/**
 * Read what paste should insert: `{source: 'internal', kind, data, text, html}` when the system
 * clipboard still holds what this app copied, else `{source: 'external', text, html, picture?}`.
 * A picture copied elsewhere since (`picture`, a data URL) is never taken for this app's copy: both have
 * empty text, so a shape copied here and then a screenshot taken would have pasted the shape again.
 */
export async function readClipboard(ctx) {
  const sys = (await ctx.host.clipboardRead()) || {text: '', html: ''};
  const internal = ctx.clipboard;
  if (internal && internal.app === ctx.app && !sys.picture && normalize(internal.text) === normalize(sys.text ?? '')) {
    return {source: 'internal', kind: internal.kind, data: internal.data, text: internal.text, html: internal.html};
  }
  return {source: 'external', text: String(sys.text ?? ''), html: String(sys.html ?? ''), ...(typeof sys.picture === 'string' && sys.picture ? {picture: sys.picture} : {})};
}

/** One entry of the Office Clipboard ring by index (0 = newest), or null. */
export function clipboardItem(ctx, index) {
  const items = ctx.clipboardItems || [];
  return Number.isInteger(index) && index >= 0 && index < items.length ? items[index] : null;
}

/** Ring entries for the Clipboard pane: label, kind and age. */
export function clipboardList(ctx) {
  return (ctx.clipboardItems || []).map((e, index) => ({index, label: e.label, kind: e.kind, app: e.app, time: e.time}));
}

// Line endings differ between what we wrote and what the OS hands back.
const normalize = s => String(s).replace(/\r\n?/g, '\n');
const preview = t => { const one = t.replace(/\s+/g, ' ').trim(); return one.length > 80 ? one.slice(0, 79) + '…' : one; };
