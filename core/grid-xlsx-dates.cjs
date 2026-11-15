// Read original serials before ExcelJS coerces them to Date (which loses serial 60).
const {XMLParser}=require('fast-xml-parser');
const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:false});
const array=v=>v===undefined?[]:Array.isArray(v)?v:[v];
async function rawXlsxNumbers(buffer){
 const zip=await (await import('./common/lib/zip-guard.mjs')).verifyZipBytes(require('jszip'),buffer),read=async name=>{const f=zip.file(name);if(!f)return {};const s=await f.async('string');if(/<!DOCTYPE|<!ENTITY/i.test(s))throw new Error('XML declarations are not supported');return parser.parse(s);};
 const workbook=await read('xl/workbook.xml'),rels=await read('xl/_rels/workbook.xml.rels'),relationships=new Map(array(rels.Relationships?.Relationship).filter(r=>r['@_TargetMode']!=='External').map(r=>[r['@_Id'],r['@_Target']])),result=new Map();
 for(const sheet of array(workbook.workbook?.sheets?.sheet)){
  const target=relationships.get(sheet['@_r:id']);if(!target)continue;const path=require('node:path').posix.normalize(target.startsWith('/')?target.slice(1):'xl/'+target);if(!path.startsWith('xl/'))throw new Error('Invalid worksheet target');
  const xml=await read(path),values=new Map();for(const row of array(xml.worksheet?.sheetData?.row))for(const c of array(row.c))if((c['@_t']===undefined||c['@_t']==='n')&&c.v!==undefined){const v=typeof c.v==='object'?c.v['#text']:c.v;if(typeof v==='string'&&Number.isFinite(Number(v)))values.set(c['@_r'],v);}result.set(sheet['@_name'],values);
 }return result;
}
module.exports={rawXlsxNumbers};
// Modern function namespace is required in OOXML; quoted user text is untouched.
const futureFunctions=new Set(['SEQUENCE','TEXTSPLIT','ARRAYTOTEXT','TEXTBEFORE','TEXTAFTER']);
function mapFutureFunctions(formula,writing){return formula.split(/("(?:[^"]|"")*")/).map((part,i)=>i%2?part:part.replace(/\b(?:_xlfn\.)?([A-Z][A-Z0-9.]*)\s*(?=\()/gi,(token,name)=>futureFunctions.has(name.toUpperCase())?(writing?'_xlfn.':'')+name.toUpperCase():token)).join('');}
module.exports.mapFutureFunctions=mapFutureFunctions;
