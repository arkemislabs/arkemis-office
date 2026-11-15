// Adapted from WordCraft 3de6ff95af86c19d67030cd96dba15cd6a45a25e,
// crates/engine/src/cmd/edit.rs and find_pattern.rs. MIT notice: wordcraft-search.txt.
// Literal search uses escaped patterns only; raw regex and wildcard grammars are not exposed.
import {Fragment} from '@tiptap/pm/model';
const codes={t:'\t',l:'\n','^':'^','+':'—','=':'–',s:'\u00a0','~':'\u2011','-':'\u00ad','%':'§',v:'¶'};
const word=c=>!!c&&/[\p{Alphabetic}\p{Number}\p{Mark}_\u200c\u200d]/u.test(c);
const before=(s,i)=>Array.from(s.slice(Math.max(0,i-2),i)).at(-1),after=(s,i)=>Array.from(s.slice(i,i+2))[0];
function decode(text,matched,replacement){return text.replace(/\^([\s\S])/gu,(all,c)=>{if(c==='p'||c==='b')throw new Error('Cross-paragraph codes are not supported; search within paragraphs.');if(c==='&'&&replacement)return matched;if(Object.hasOwn(codes,c))return codes[c];if('?#$wgc'.includes(c)||/[0-9u]/.test(c))throw new Error(`Unsupported special code ${all}`);return all;});}
export function expandSearchReplacement(text,matched,special=false){if(typeof text!=='string'||text.length>100000)throw new Error('Replacement is too long');return special?decode(text,matched,true):text;}
function normalize(text,options){let value='',map=[];for(let i=0;i<text.length;){const c=String.fromCodePoint(text.codePointAt(i)),end=i+c.length;const ignore=(options.ignorePunct&&/\p{P}/u.test(c))||(options.ignoreSpace&&/[ \t\u00a0]/u.test(c));if(!ignore){value+=c;for(let n=0;n<c.length;n++)map.push({start:i,end});}i=end;}return {value,map};}
export function searchRichText(doc,query,options={}){
 const allowed=new Set(['matchCase','wholeWord','prefix','suffix','ignorePunct','ignoreSpace','special','scope']);for(const key of Object.keys(options))if(!allowed.has(key))throw new Error(`Unsupported search option: ${key}`);
 if(typeof query!=='string'||Array.from(query).length>1024)throw new Error('Find text must be at most 1024 characters');if(!query)return [];
 if(options.scope&&(!Number.isInteger(options.scope.from)||!Number.isInteger(options.scope.to)||options.scope.from<0||options.scope.to>doc.content.size||options.scope.from>=options.scope.to))throw new Error('Select text before searching within the selection');
 const needle=normalize(options.special?decode(query,'',false):query,options).value;if(!needle)return [];
 const pattern=new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),options.matchCase?'gu':'giu');const matches=[];let total=0;
 doc.descendants((block,pos)=>{
  if(!block.isTextblock)return;
  let text='',start=pos+1;
  const flush=()=>{
   total+=text.length;if(total>2000000)throw new Error('Search supports up to 2 million text characters');const normalized=normalize(text,options);pattern.lastIndex=0;
   for(const match of normalized.value.matchAll(pattern)){
    const a=normalized.map[match.index]?.start,b=normalized.map[match.index+match[0].length-1]?.end;if(a===undefined||b===undefined)continue;
    const left=word(before(text,a))!==word(after(text,a)),right=word(before(text,b))!==word(after(text,b));
    if((options.wholeWord||options.prefix)&&!left)continue;if((options.wholeWord||options.suffix)&&!right)continue;
    const from=start+a,to=start+b;if(options.scope&&(from<options.scope.from||to>options.scope.to))continue;
    matches.push({from,to,text:text.slice(a,b),preview:text.slice(Math.max(0,a-28),Math.min(text.length,b+45))});if(matches.length>10000)throw new Error('More than 10,000 matches; narrow the search');
   }text='';
  };
  block.forEach((node,offset)=>{if(node.isText)text+=node.text;else if(node.type.name==='hardBreak')text+='\n';else{flush();start=pos+1+offset+node.nodeSize;}});flush();return false;
 });return matches;
}
export function chooseSearchMatch(matches,selection,direction=1){if(!matches.length)return null;return direction<0?(matches.findLast(m=>m.to<=selection.from)??matches.at(-1)):(matches.find(m=>m.from>=selection.to)??matches[0]);}
export function replaceRichMatches(state,matches,replacement,{special=false}={}){
 if(!matches.length)return null;const sorted=[...matches].sort((a,b)=>a.from-b.from);let end=-1,total=0;const operations=[];
 for(const match of sorted){if(!Number.isInteger(match.from)||!Number.isInteger(match.to)||match.from<0||match.to>state.doc.content.size||match.from>=match.to)throw new Error('Invalid match range');if(match.from<end)throw new Error('Replacement ranges overlap');end=match.to;
  if(state.doc.textBetween(match.from,match.to,'\n','\n')!==match.text)throw new Error('The document changed; search again');const text=expandSearchReplacement(replacement,match.text,special);total+=text.length;if(total>5000000)throw new Error('Replacement output is too large');const marks=state.doc.nodeAt(match.from)?.marks??state.doc.resolve(match.from).marks();const nodes=[];for(const [i,line]of text.split('\n').entries()){if(i){if(!state.schema.nodes.hardBreak)throw new Error('Line breaks are unavailable');nodes.push(state.schema.nodes.hardBreak.create());}if(line)nodes.push(state.schema.text(line,marks));}operations.push({...match,nodes});
 }
 const tr=state.tr;for(const op of operations.reverse())tr.replaceWith(op.from,op.to,Fragment.fromArray(op.nodes));return tr.scrollIntoView();
}
