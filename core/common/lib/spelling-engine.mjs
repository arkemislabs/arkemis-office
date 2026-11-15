// The dictionary engine behind the spelling service (spelling.mjs): nspell (MIT, a JavaScript
// Hunspell) over the en_US Hunspell dictionary of dictionary-en (SCOWL, MIT AND BSD) that ships with
// the app. It runs in the spelling worker (src/workers/spelling.ts) and, where a worker can't start
// (the unit tests, a window without Workers), in the calling thread; loading takes about 0.7 s,
// which is why the worker is the normal home. The licences are in assets/third-party-licenses/
// (nspell-2.1.5.txt, dictionary-en-4.0.0.txt). The dictionary files are served as
// dist/dictionaries/en-US.aff and en-US.dic (scripts/build.mjs) and read from dictionary-en under Node.

import nspell from 'nspell';

/** The dictionaries the app ships, by language tag (the files in dist/dictionaries/). */
export const DICTIONARIES = Object.freeze({'en-US': {aff: 'en-US.aff', dic: 'en-US.dic'}});

const text = async res => {
  if (!res.ok) throw new Error(`dictionary file ${res.url} could not be read (${res.status})`);
  return new TextDecoder('utf-8').decode(await res.arrayBuffer());
};

/** The affix and word files of `lang` as text: fetched next to the page or worker in a window, read from dictionary-en under Node. */
export async function loadDictionary(lang = 'en-US') {
  const files = DICTIONARIES[lang];
  if (!files) throw new Error(`no ${lang} dictionary ships with the app`);
  if (typeof fetch === 'function' && typeof document !== 'undefined' || typeof WorkerGlobalScope !== 'undefined') {
    const [aff, dic] = await Promise.all([fetch(`./dictionaries/${files.aff}`).then(text), fetch(`./dictionaries/${files.dic}`).then(text)]);
    return {aff, dic};
  }
  // Under Node (tests): the package's own files. The specifiers are variables so a browser bundle doesn't try to include them.
  const fsName = 'node:fs/promises', urlName = 'node:url', pathName = 'node:path';
  const [fs, url, path] = await Promise.all([import(fsName), import(urlName), import(pathName)]);
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  // A packaged app's main process is one bundle: it names the app root, where dist/dictionaries ships.
  const appRoot = typeof globalThis.__arkemisAppRoot === 'string' ? globalThis.__arkemisAppRoot : null;
  for (const base of [path.resolve(here, '../../../node_modules/dictionary-en'), path.resolve(here, '../../../dist/dictionaries'), ...(appRoot ? [path.join(appRoot, 'dist/dictionaries')] : [])]) {
    try {
      const names = base.endsWith('dictionary-en') ? ['index.aff', 'index.dic'] : [files.aff, files.dic];
      return {aff: await fs.readFile(path.join(base, names[0]), 'utf8'), dic: await fs.readFile(path.join(base, names[1]), 'utf8')};
    } catch { /* try the next place */ }
  }
  throw new Error(`the ${lang} dictionary files were not found`);
}

/** A checker over dictionary text: {correct(word), suggest(word, n)}. */
export function createEngine({aff, dic}) {
  const sp = nspell(aff, dic);
  return {
    correct: word => sp.correct(word),
    suggest: (word, n = 8) => sp.suggest(word).slice(0, Math.max(0, n)),
  };
}

/** Load `lang` and build its engine. */
export async function openEngine(lang = 'en-US') { return createEngine(await loadDictionary(lang)); }
