// Translated counting rules from WordCraft 3de6ff95af86c19d67030cd96dba15cd6a45a25e:
// crates/doc/src/text_walk.rs::count_words/story_word_count_of and
// crates/engine/src/cmd/review/proofing.rs::word_count.
// MIT notice: assets/third-party-licenses/wordcraft-statistics.txt.
const whitespace=/\p{White_Space}/u;
export function countWords(text){
 if(typeof text!=='string'||text.length>10000000)throw new Error('Text statistics input is too large or invalid');
 return text.split(/[\p{White_Space}\uFFFC]+/u).filter(word=>/[\p{Alphabetic}\p{Number}]/u.test(word)).length;
}
export function richStatistics(doc,{selectionText}={}){
 const selected=selectionText!==undefined;let text='',labels=0,nodes=0,length=0;
 if(selected){if(typeof selectionText!=='string')throw new Error('Invalid selection text');text=selectionText;}
 else{
  const paragraphs=[];
  const visit=(node,depth=0)=>{
   if(depth>64)throw new Error('Document is too deep for statistics');if(++nodes>200000)throw new Error('Document has too many nodes for statistics');
   if(!node||typeof node!=='object')return;
   if(['paragraph','heading','codeBlock'].includes(node.type)){
    let value='';for(const child of node.content??[]){if(++nodes>200000)throw new Error('Document has too many nodes for statistics');const part=child.type==='text'?(child.text??''):child.type==='hardBreak'?'\n':'\uFFFC';if(typeof part!=='string')throw new Error('Invalid document text');length+=part.length;if(length>10000000)throw new Error('Document text is too large');value+=part;}paragraphs.push(value);return;
   }
   if(node.type==='orderedList')labels+=(node.content??[]).filter(child=>child.type==='listItem'&&child.content?.some(p=>p.type==='paragraph')).length;
   for(const child of node.content??[])visit(child,depth+1);
  };visit(doc);text=paragraphs.join('\n');
 }
 const words=countWords(text)+labels;let characters=0,charactersWithSpaces=0;for(const c of text){if(c!=='\r'&&c!=='\n')charactersWithSpaces++;if(!whitespace.test(c))characters++;}
 return {pages:null,words,characters,charactersWithSpaces,paragraphs:text.split('\n').filter(line=>line.split('').some(c=>!whitespace.test(c))).length,lines:null,includeTextBoxes:false,scope:selected?'selection':'document',unavailable:['pages','lines','textBoxesAndNotes']};
}
