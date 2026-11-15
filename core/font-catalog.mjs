export const fallbackFonts=['Arial','Calibri','Aptos','Georgia','Times New Roman','Verdana','Consolas'];
const valid=name=>typeof name==='string'&&name.trim().length>0&&name.length<=200&&!/[\x00-\x1f\x7f]/.test(name);
export function normalizeFontFamilies(values){return [...new Set((Array.isArray(values)?values:[values]).filter(valid).map(s=>s.trim()))].sort((a,b)=>a.localeCompare(b));}
export function fontFamilyCSS(name){return valid(name)?'"'+name.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"':null;}
