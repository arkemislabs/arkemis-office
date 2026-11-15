// The worksheet function library: every translated category registers here.
// Translated from gridcraft crates/functions/src/lib.rs (registry order: math, stat, ets, text,
// date, lookup, dynamic, financial, info, engineering, database) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Categories not translated yet (their functions are not registered, so they evaluate to #NAME?
// and are not offered by autocomplete): engineering, database (D*), most of
// financial (depreciation, securities, day counts), the probability distributions beyond the
// normal one, GROUPBY/PIVOTBY.

import './math.mjs';
import './stat.mjs';
import './ets.mjs';
import './text.mjs';
import './date.mjs';
import './lookup.mjs';
import './dynamic.mjs';
import './financial.mjs';
import './info.mjs';

export {lookup, call, all, isScalarArg, accepts, val, ref} from './registry.mjs';
export {aggregateValues, aggregateValuesK} from './stat.mjs';
