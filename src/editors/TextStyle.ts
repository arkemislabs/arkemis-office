import {Mark,mergeAttributes} from '@tiptap/react';
import {fallbackFonts,fontFamilyCSS} from '../../core/font-catalog.mjs';
export const fontFamilies=fallbackFonts as string[];
export const TextStyle=Mark.create({
 name:'textStyle',
 addAttributes(){return {
  fontFamily:{default:null,parseHTML:e=>e.style.fontFamily?.replaceAll('"','')||null},
  fontSize:{default:null,parseHTML:e=>e.style.fontSize?parseFloat(e.style.fontSize):null},
  color:{default:null,parseHTML:e=>e.style.color||null},
  backgroundColor:{default:null,parseHTML:e=>e.style.backgroundColor||null},
  verticalAlign:{default:null,parseHTML:e=>['sub','super'].includes(e.style.verticalAlign)?e.style.verticalAlign:null},
 };},
 parseHTML(){return [{tag:'span[style]'}];},
 renderHTML({HTMLAttributes}){
  const {fontFamily,fontSize,color,backgroundColor,verticalAlign,...rest}=HTMLAttributes;const style=[];
  const family=fontFamilyCSS(fontFamily);if(family)style.push('font-family:'+family);
  if(Number(fontSize)>=6&&Number(fontSize)<=192)style.push('font-size:'+Number(fontSize)+'pt');
  if(typeof color==='string'&&/^(#[\da-f]{3,8}|rgb\([\d ,]+\))$/i.test(color))style.push('color:'+color);
  if(typeof backgroundColor==='string'&&/^(#[\da-f]{3,8}|rgb\([\d ,]+\))$/i.test(backgroundColor))style.push('background-color:'+backgroundColor);
  if(['sub','super'].includes(verticalAlign))style.push('vertical-align:'+verticalAlign);
  return ['span',mergeAttributes(rest,{style:style.join(';')}),0];
 },
});
