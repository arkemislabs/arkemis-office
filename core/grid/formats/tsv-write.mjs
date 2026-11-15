// The active sheet as tab-separated text (.tsv): csv-write's rules with the tab as delimiter.
// Translated from gridcraft crates/engine/src/io.rs (save: FileKind::Tsv writes `csv(wb, sh, b'\t')`)
// at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// U:grid/formats-tsv. No DOM, no Node built-ins.

import {writeDelimited} from './csv-write.mjs';
import {activeSheetIndex} from '../model/sheet.mjs';

export function write(file) {
  const content = file.content ?? file;
  return new TextEncoder().encode(writeDelimited(content, activeSheetIndex(content), '\t'));
}
