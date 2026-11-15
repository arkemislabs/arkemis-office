// Proofing language and the Thesaurus (Review > Language, Review > Thesaurus; U:slate/review).
// Slate has no ArtCraft upstream. Everything here works offline: the thesaurus is a built-in list of
// everyday English words (written for this app; no dictionary is downloaded) and the proofing
// language is a mark on the text (lang="…", spellcheck off for "Do not check spelling or grammar")
// that the page editor passes on to the browser's own checker.
//
// Spelling & Grammar (F7) is not offered: a spelling engine needs a dictionary, the app ships none
// and the system's checker has no offline dictionary here (docs/spec/patches/slate/review.json).

/** The languages of the Language dialog (docs/spec dialog.language), name and BCP 47 tag. */
export const LANGUAGES = Object.freeze([
  ['English (United States)', 'en-US'], ['English (United Kingdom)', 'en-GB'], ['French (France)', 'fr-FR'], ['German (Germany)', 'de-DE'],
  ['Spanish (Spain)', 'es-ES'], ['Spanish (Mexico)', 'es-MX'], ['Italian (Italy)', 'it-IT'], ['Portuguese (Brazil)', 'pt-BR'],
  ['Dutch (Netherlands)', 'nl-NL'], ['Japanese', 'ja-JP'], ['Chinese (Simplified)', 'zh-CN'], ['Chinese (Traditional)', 'zh-TW'],
  ['Korean', 'ko-KR'], ['Arabic', 'ar-SA'], ['Hebrew', 'he-IL'], ['Hindi', 'hi-IN'], ['Russian', 'ru-RU'], ['Polish', 'pl-PL'],
  ['Swedish', 'sv-SE'], ['Turkish', 'tr-TR'],
]);
export const LANGUAGE_NAMES = Object.freeze(LANGUAGES.map(l => l[0]));
export const DEFAULT_LANGUAGE = 'English (United States)';

/** {name, code} for a language name or tag (case-insensitive), or null. */
export function languageOf(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  const hit = LANGUAGES.find(([n, c]) => n.toLowerCase() === v || c.toLowerCase() === v);
  return hit ? {name: hit[0], code: hit[1]} : null;
}
export const nameOfCode = code => LANGUAGES.find(l => l[1] === code)?.[0] ?? null;

// ---------------------------------------------------------------------------------------------
// Thesaurus: head word -> synonyms. Any listed synonym also finds its group (and the head).

const GROUPS = {
  good: 'fine excellent decent pleasant superb sound worthy', bad: 'poor awful terrible faulty inferior harmful unpleasant', big: 'large huge vast sizable enormous major substantial',
  small: 'little tiny minor compact slight modest petite', fast: 'quick rapid swift speedy brisk hasty', slow: 'unhurried gradual leisurely sluggish plodding',
  happy: 'glad cheerful content joyful pleased delighted', sad: 'unhappy sorrowful gloomy downcast miserable', angry: 'furious cross irate annoyed enraged upset',
  important: 'significant key vital essential major crucial critical', easy: 'simple effortless straightforward painless uncomplicated', hard: 'difficult tough demanding arduous challenging',
  show: 'display reveal present demonstrate exhibit', make: 'create build produce craft form construct', use: 'employ apply utilize operate exercise',
  help: 'assist aid support serve back', start: 'begin launch open initiate commence', end: 'finish close conclude stop complete', say: 'state tell remark mention declare',
  think: 'believe consider reckon suppose assume', new: 'fresh novel recent modern latest', old: 'aged former ancient vintage elderly', beautiful: 'lovely attractive gorgeous stunning pretty',
  ugly: 'unsightly hideous unattractive plain', idea: 'concept notion thought plan theory', change: 'alter modify adjust shift vary', great: 'excellent superb terrific outstanding remarkable',
  very: 'extremely highly truly really especially', work: 'labor effort job task employment', walk: 'stroll stride wander march amble', run: 'dash sprint race jog hurry',
  look: 'glance gaze stare peek observe', see: 'notice spot observe view witness', get: 'obtain acquire gain receive fetch', give: 'offer provide grant hand supply',
  take: 'grab seize accept capture remove', go: 'travel move proceed leave depart', come: 'arrive approach appear reach', want: 'desire wish crave need',
  need: 'require demand lack want', like: 'enjoy admire appreciate favor', love: 'adore cherish treasure', hate: 'detest loathe despise dislike',
  keep: 'retain hold save preserve maintain', find: 'discover locate uncover detect', ask: 'inquire question request query', answer: 'reply respond response solution',
  tell: 'inform notify advise relate', talk: 'speak chat converse discuss', write: 'compose draft record note', read: 'study scan peruse browse',
  learn: 'study master absorb discover', teach: 'instruct educate train coach', try: 'attempt endeavor strive test', buy: 'purchase acquire obtain',
  sell: 'market trade vend retail', pay: 'compensate reward settle remit', cost: 'price charge expense fee', money: 'cash funds currency capital',
  begin: 'start commence initiate open', stop: 'halt cease end pause quit', finish: 'complete end conclude wrap', win: 'triumph succeed prevail conquer',
  lose: 'misplace forfeit miss drop', increase: 'grow rise expand raise boost', decrease: 'reduce lower shrink drop cut', grow: 'expand develop increase mature',
  build: 'construct assemble erect make', break: 'smash shatter crack snap', fix: 'repair mend correct restore', clean: 'spotless tidy pure neat',
  dirty: 'filthy grimy soiled messy', hot: 'warm heated boiling scorching', cold: 'chilly cool freezing icy', bright: 'brilliant vivid shining radiant',
  dark: 'dim gloomy shadowy dusky', loud: 'noisy deafening booming thunderous', quiet: 'silent hushed calm still', strong: 'powerful sturdy robust mighty firm',
  weak: 'feeble frail fragile flimsy', smart: 'clever intelligent bright wise sharp', stupid: 'foolish silly dull unwise', funny: 'amusing humorous comical witty',
  strange: 'odd peculiar unusual weird curious', normal: 'usual typical ordinary regular standard', real: 'genuine actual authentic true', fake: 'false counterfeit bogus forged',
  true: 'accurate correct factual right', wrong: 'incorrect mistaken false inaccurate', right: 'correct proper accurate fitting', rich: 'wealthy affluent prosperous',
  poor: 'needy impoverished destitute broke', brave: 'courageous bold fearless heroic', afraid: 'scared frightened fearful anxious', tired: 'weary exhausted drained sleepy',
  eager: 'keen enthusiastic avid willing', calm: 'peaceful serene relaxed tranquil', careful: 'cautious thorough prudent attentive', careless: 'sloppy negligent reckless',
  clear: 'obvious plain evident transparent', common: 'usual frequent familiar ordinary', rare: 'scarce uncommon unusual', complete: 'whole entire full finished',
  different: 'distinct unlike separate varied', same: 'identical alike equal matching', difficult: 'hard tough demanding complicated', simple: 'easy plain basic straightforward',
  enough: 'sufficient adequate ample', whole: 'entire complete full total', part: 'piece portion section share', group: 'team set collection band cluster',
  team: 'crew squad group staff', plan: 'scheme strategy design outline', goal: 'aim target objective purpose', problem: 'issue difficulty trouble puzzle',
  question: 'query inquiry doubt', reason: 'cause motive grounds explanation', result: 'outcome effect consequence product', way: 'method manner route approach',
  place: 'location spot position site', thing: 'object item article matter', person: 'individual human someone', friend: 'companion ally buddy colleague',
  house: 'home residence dwelling', city: 'town metropolis municipality', road: 'street path route highway', picture: 'image photo illustration drawing',
  story: 'tale account narrative report', note: 'memo record remark message', page: 'sheet leaf', text: 'words content wording', word: 'term expression',
  meeting: 'gathering session conference assembly', project: 'undertaking task venture assignment', report: 'account statement summary record',
  list: 'catalog inventory roster index', check: 'verify examine inspect confirm', choose: 'select pick decide elect', decide: 'determine resolve settle choose',
  explain: 'describe clarify illustrate define', describe: 'portray depict explain outline', discuss: 'debate argue consider talk', suggest: 'propose recommend advise offer',
  allow: 'permit let authorize enable', prevent: 'stop avoid block hinder', remove: 'delete erase eliminate discard', add: 'append include attach insert',
  join: 'connect link unite combine', separate: 'divide split part detach', send: 'dispatch mail transmit forward', receive: 'get accept obtain collect',
  carry: 'bear transport haul convey', hold: 'grasp clutch grip keep', throw: 'toss hurl fling pitch', pull: 'drag tug draw haul', push: 'shove press thrust nudge',
  hit: 'strike punch slap smack', cut: 'slice chop trim carve', close: 'shut seal fasten', fill: 'stuff load pack crowd', empty: 'vacant blank hollow bare',
  full: 'packed crowded stuffed loaded', ready: 'prepared set willing', quick: 'fast rapid prompt swift', late: 'tardy overdue delayed', early: 'premature initial prompt',
  often: 'frequently regularly commonly', always: 'forever constantly invariably', never: 'not ever at no time', maybe: 'perhaps possibly perchance',
  also: 'additionally besides moreover too', but: 'however yet although though', so: 'therefore thus hence consequently', because: 'since as for given',
  about: 'regarding concerning approximately around', almost: 'nearly virtually practically', only: 'merely just solely simply', really: 'truly genuinely actually indeed',
  improve: 'enhance upgrade refine boost advance', reduce: 'lessen cut lower shrink diminish', create: 'make produce generate design invent', share: 'distribute divide split spread',
  community: 'group society collective neighborhood', shared: 'common joint communal mutual', safe: 'secure protected harmless', danger: 'risk hazard threat peril',
  gift: 'present donation offering', famous: 'renowned celebrated noted well-known', lucky: 'fortunate blessed favored',
};

const norm = w => String(w ?? '').trim().toLowerCase().replace(/[^\p{L}'-]/gu, '');

const index = (() => {
  const heads = new Map();           // word -> Set of group ids
  const groups = [];                 // [{head, words}]
  for (const [head, list] of Object.entries(GROUPS)) {
    const words = list.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const h = head.replace(/_+$/, '');
    const g = {head: h, words: words.filter(w => w !== h)};
    groups.push(g);
    for (const w of [h, ...g.words]) { if (!heads.has(w)) heads.set(w, new Set()); heads.get(w).add(g); }
  }
  return heads;
})();

/** A word's base forms to try: itself, then without a common ending. */
function forms(word) {
  const w = norm(word);
  const out = [w];
  for (const [re, add] of [[/ies$/, 'y'], [/ily$/, 'y'], [/ied$/, 'y'], [/(es|ed)$/, ''], [/(s|d)$/, ''], [/ing$/, ''], [/ing$/, 'e'], [/ly$/, ''], [/(er|est)$/, ''], [/(er|est)$/, 'e']]) {
    if (re.test(w)) out.push(w.replace(re, add));
  }
  return [...new Set(out.filter(x => x.length > 1))];
}

/**
 * Synonyms of a word: {word, found, meanings: [{head, synonyms}]}. Each group the word belongs to is
 * a meaning; the word itself is left out. `found` is false for a word the list does not know.
 */
export function synonymsOf(word) {
  const w = norm(word);
  for (const f of forms(w)) {
    const groups = index.get(f);
    if (!groups) continue;
    const meanings = [];
    for (const g of groups) {
      const synonyms = [g.head, ...g.words].filter(x => x !== f);
      if (synonyms.length) meanings.push({head: g.head, synonyms});
    }
    if (meanings.length) return {word: w, found: true, base: f, meanings};
  }
  return {word: w, found: false, base: w, meanings: []};
}

/** The replacement in the case of the word it replaces (Title and UPPER kept). */
export function matchCase(original, replacement) {
  if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase()) return replacement.toUpperCase();
  if (original[0] && original[0] !== original[0].toLowerCase() && original[0] === original[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}
