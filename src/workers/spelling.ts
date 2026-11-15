// The spelling worker: loads the bundled dictionary once and answers word checks and suggestions off the window's
// thread (core/common/lib/spelling.mjs starts it as new Worker('./spelling.js', {type: 'module'}); bundled by
// scripts/build.mjs from scripts/renderer-entries.mjs). It only ever reads words as data.
import {openEngine} from '../../core/common/lib/spelling-engine.mjs';

const scope: any = self;
const engines = new Map<string, Promise<{correct: (w: string) => boolean; suggest: (w: string, n?: number) => string[]}>>();
const engineOf = (lang: string) => { let e = engines.get(lang); if (!e) { e = openEngine(lang); engines.set(lang, e); } return e; };

scope.onmessage = async (e: MessageEvent) => {
  const {id, op, lang, words, word, n} = e.data ?? {};
  try {
    const engine = await engineOf(lang || 'en-US');
    let result: unknown = true;
    if (op === 'check') result = (words as string[]).map(w => engine.correct(w));
    else if (op === 'suggest') result = engine.suggest(String(word ?? ''), n ?? 8);
    scope.postMessage({id, ok: true, result});
  } catch (err: any) {
    scope.postMessage({id, ok: false, error: String(err?.message ?? err)});
  }
};
