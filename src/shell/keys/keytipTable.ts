// Keytip letters and the keytip state machine (docs/architecture.md sections 8.6 and 11).
// Behaviour from wordcraft crates/ui-egui/src/keytips.rs at 3de6ff95af86c19d67030cd96dba15cd6a45a25e:
// Alt (or F10) shows badges over the tabs, a tab's letter shows its controls' badges, typing never
// reaches the document while keytips are active, Esc steps back one level, and numbered badges
// reach the Quick Access Toolbar. Letters come from the layout overlays when they give one; the
// rest are assigned here so that no keytip is a prefix of another. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// Pure: no DOM, no React, no imports of other TS files.

export interface KeytipItem { id: string; label: string; preferred?: string | null }

const VALID = /^[A-Z0-9]{1,3}$/;
const letters = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const initials = (s: string) => s.split(/[\s&/_.\-–—]+/).map(w => letters(w)[0]).filter(Boolean);

/**
 * Assign each item a keytip. Overlay letters win when valid and unique; the rest get the first
 * letter of their label when it is free, two letters (initial + another letter of the label) when
 * several items share an initial, and `Z1`, `Z2`, ... when nothing else is left. The result is
 * prefix-free: no keytip is the start of another, so typing one never waits for more letters.
 */
export function assignKeytips(items: KeytipItem[], reserved: Iterable<string> = []): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>([...reserved].map(s => s.toUpperCase()));
  const conflicts = (tip: string) => [...used].some(u => u === tip || u.startsWith(tip) || tip.startsWith(u));
  const take = (id: string, tip: string) => { out.set(id, tip); used.add(tip); };
  // 1. Overlay letters.
  for (const it of items) {
    const p = typeof it.preferred === 'string' ? it.preferred.trim().toUpperCase() : '';
    if (p && VALID.test(p) && !conflicts(p)) take(it.id, p);
  }
  const rest = items.filter(it => !out.has(it.id));
  // 2. Group the rest by their first letter.
  const byInitial = new Map<string, KeytipItem[]>();
  for (const it of rest) {
    const first = initials(it.label)[0] ?? letters(it.label)[0] ?? 'Z';
    if (!byInitial.has(first)) byInitial.set(first, []);
    byInitial.get(first)!.push(it);
  }
  const overflow: KeytipItem[] = [];
  for (const [first, group] of byInitial) {
    if (group.length === 1 && !conflicts(first)) { take(group[0].id, first); continue; }
    // Several items start with the same letter (or the single letter is taken): try another
    // single letter of the label first, then two letters with that initial as the prefix.
    for (const it of group) {
      const word = initials(it.label);
      const pool = [...new Set([...word.slice(1), ...letters(it.label).slice(1)])];
      const single = group.length === 1 ? pool.find(ch => !conflicts(ch)) : undefined;
      if (single) { take(it.id, single); continue; }
      const second = [...pool, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789'].find(ch => !conflicts(first + ch));
      if (second && ![...used].some(u => u === first)) take(it.id, first + second);
      else overflow.push(it);
    }
  }
  // 3. Overflow: Z1..Z9, ZA..ZZ (Office's Y/Z overflow badges).
  let n = 0;
  const seq = '123456789ABCDEFGHIJKLMNOPQRSTUVWXY';
  for (const it of overflow) {
    let tip = '';
    while (n < seq.length) { const cand = 'Z' + seq[n++]; if (!conflicts(cand)) { tip = cand; break; } }
    if (!tip) break;
    take(it.id, tip);
  }
  return out;
}

/** Whether a set of keytips is prefix-free (tests and the generator use it). */
export function prefixFree(tips: Iterable<string>): boolean {
  const list = [...tips];
  return list.every((a, i) => list.every((b, j) => i === j || !(b.startsWith(a))));
}

/** Quick Access Toolbar badges: 1..9, then 09, 08, ... as Word numbers them. */
export function qatKeytips(count: number): string[] {
  const out: string[] = [];
  const tail = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < count; i++) {
    if (i < 9) out.push(String(i + 1));
    else if (i < 18) out.push(`0${18 - i}`);
    else if (i - 18 < tail.length) out.push(`0${tail[i - 18]}`);
  }
  return out;
}

export type KeytipPhase = 'off' | 'tabs' | 'commands';
export interface KeytipState { phase: KeytipPhase; tab: string | null; typed: string }
export const KEYTIPS_OFF: KeytipState = Object.freeze({phase: 'off', tab: null, typed: ''}) as KeytipState;

export type KeytipResult =
  | {kind: 'none'}
  | {kind: 'wait'}
  | {kind: 'match'; id: string}
  | {kind: 'miss'};

/** Match typed letters against a keytip table: a full match, a prefix (wait for more) or a miss. */
export function matchKeytip(table: Map<string, string>, typed: string): KeytipResult {
  const t = typed.toUpperCase();
  if (!t) return {kind: 'none'};
  let prefix = false;
  for (const [id, tip] of table) {
    if (tip === t) return {kind: 'match', id};
    if (tip.startsWith(t)) prefix = true;
  }
  return prefix ? {kind: 'wait'} : {kind: 'miss'};
}
