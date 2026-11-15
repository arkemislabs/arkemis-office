/*!
 * JavaScript translation/adaptation of GridCraft, commit
 * 146161b4b450a56e5e59a083ba0478582d1e602b:
 * crates/functions/src/criteria.rs: tokenize, lower_char, match_from, wildcard_find
 * crates/functions/src/text.rs: find_impl
 * https://github.com/storytold/gridcraft/tree/146161b4b450a56e5e59a083ba0478582d1e602b
 *
 * MIT License
 * Copyright (c) 2026 ArtCraft Team and the GridCraft contributors
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Adaptations: JS scalar arrays replace Rust chars; a shared 2^20 work budget
// throws #LIMIT! rather than silently reporting no match. Leading stars are
// retained: SEARCH("*b","abc") starts at 1, not at the literal b. No WASM.
const MAX_TEXT=32767,MAX_STEPS=1<<20;
const fail=code=>{throw new Error(code);};
const lowerChar=char=>Array.from(char.toLowerCase())[0]??char;
function tokenize(pattern){const chars=Array.from(pattern),tokens=[];for(let i=0;i<chars.length;i++){const char=chars[i];if(char==='~')tokens.push({char:lowerChar(chars[++i]??'~')});else if(char==='*')tokens.push({star:true});else if(char==='?')tokens.push({any:true});else tokens.push({char:lowerChar(char)});}return tokens;}
function spend(budget){if(--budget.remaining<0)fail('#LIMIT!');}
// Last-star iterative backtracking, translated from match_from; no regex or recursion.
function matchFrom(pattern,text,start,budget){let pi=0,ti=start,star=null;while(true){spend(budget);if(pi===pattern.length)return true;const token=pattern[pi],char=text[ti];if(token?.star){star={pi,ti};pi++;continue;}if(char!==undefined&&(token?.any||token?.char===char)){pi++;ti++;continue;}if(star&&star.ti<text.length){star.ti++;pi=star.pi+1;ti=star.ti;continue;}return false;}}
function wildcardFind(pattern,text,start,budget){const tokens=tokenize(pattern),chars=Array.from(text,lowerChar);if(!tokens.length)return start<=chars.length?start:null;
 // Preserve the original anchor optimization except leading stars, which may
 // consume text before the literal and therefore cannot move the match start.
 let anys=0;while(tokens[anys]?.any)anys++;const anchor=tokens[anys];
 for(let i=start;i<chars.length;i++){spend(budget);if(anchor?.char!==undefined){if(chars[i+anys]===undefined)break;if(chars[i+anys]!==anchor.char)continue;}if(matchFrom(tokens,chars,i,budget))return i;}return null;
}
export function spreadsheetFind(needle,haystack,start=1,wild=false){
 if(typeof needle!=='string'||typeof haystack!=='string'||needle.length>MAX_TEXT||haystack.length>MAX_TEXT||typeof start!=='number'||!Number.isFinite(start))fail('#VALUE!');
 const chars=Array.from(haystack);if(start<1||start>Math.max(chars.length,1))fail('#VALUE!');const from=Math.trunc(start)-1;if(!needle)return from+1;
 const budget={remaining:MAX_STEPS};let position=null;
 if(wild)position=wildcardFind(needle,haystack,from,budget);
 else{const target=Array.from(needle);for(let i=from;i+target.length<=chars.length;i++){let matches=true;for(let j=0;j<target.length;j++){spend(budget);if(chars[i+j]!==target[j]){matches=false;break;}}if(matches){position=i;break;}}}
 if(position===null)fail('#VALUE!');return position+1;
}
