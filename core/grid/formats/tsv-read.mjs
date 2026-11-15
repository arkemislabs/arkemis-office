// Tab-separated text (.tsv) into a schema-2 workbook: as CSV with the tab as delimiter.
// Translated from gridcraft crates/engine/src/io.rs (open: FileKind::Tsv reads `delimiter: b'\t'`)
// at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// U:grid/formats-tsv. No DOM, no Node built-ins.

import {readCsv} from './csv-read.mjs';

export function read(bytes, opts = {}) {
  const content = readCsv(bytes, {delimiter: '\t', parseValues: opts.parseValues !== false});
  delete content.csvDelimiter;
  return content;
}
