import {richStatistics} from '../../core/rich-statistics.mjs';
/** Literal search over contiguous text runs preserves positions across formatting marks. */
export function findTextMatches(doc,query,caseSensitive=false){
 if(!query)return [];
 const matches=[];let text='',start=0,end=0;
 const flush=()=>{const flags=caseSensitive?'gu':'giu';const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),flags);for(const match of text.matchAll(pattern))matches.push({from:start+match.index,to:start+match.index+match[0].length});text='';};
 doc.descendants((node,pos)=>{if(!node.isText)return;if(text&&pos!==end)flush();if(!text)start=pos;text+=node.text;end=pos+node.nodeSize;});flush();return matches;
}
export function pageGeometry(page={}){
 let [width,height]=page.size==='Letter'?[215.9,279.4]:[210,297];if(page.orientation==='landscape')[width,height]=[height,width];
 return {width,height,margin:({normal:25.4,narrow:12.7,wide:38.1})[page.margins]??25.4};
}
export function documentStatistics(doc,options={}){
 const stats=richStatistics(doc,options);
 return {words:stats.words,characters:stats.charactersWithSpaces,charactersWithoutSpaces:stats.characters,paragraphs:stats.paragraphs,readingMinutes:Math.ceil(stats.words/200)};
}
