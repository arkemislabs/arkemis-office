import './common/lib/pdf-guard.mjs';
import {readPdfBookmarks} from './pdf-outline-tree.mjs';
import {PDFDocument,PDFDict,PDFArray,PDFNumber,PDFHexString,PDFName} from 'pdf-lib';
import {fromBER} from 'asn1js';
import {ContentInfo,SignedData,Certificate,CryptoEngine} from 'pkijs';
import {readPdfLabelRanges} from './pdf-label-tree.mjs';
import {pdfBytes,validatePdfContent} from './pdf-model.mjs';

// Offline integrity only. No network retrieval, trust anchors, OCSP, CRLs or
// timestamp validation. Identity strings below come from an untrusted cert.
const MAX_SIGNATURES=32,MAX_CMS=512*1024,MAX_CERT=64*1024;
const DATA='1.2.840.113549.1.7.1',SIGNED_DATA='1.2.840.113549.1.7.2';
const digests={'1.3.14.3.2.26':'SHA-1','2.16.840.1.101.3.4.2.1':'SHA-256','2.16.840.1.101.3.4.2.2':'SHA-384','2.16.840.1.101.3.4.2.3':'SHA-512'};
const name=key=>PDFName.of(key),fail=message=>{throw new Error(message);};
const ascii=bytes=>new TextDecoder('latin1').decode(bytes);
const buffer=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
function dictionaries(document){
 const found=[],seen=new Set();let count=0;
 const walk=(object,depth=0)=>{if(!object||seen.has(object))return;seen.add(object);if(++count>100000||depth>60)fail('PDF signature inspection exceeds document limits.');
  if(object instanceof PDFDict){if(object.has(name('ByteRange'))||object.get(name('Type'))===name('Sig')){found.push(object);if(found.length>MAX_SIGNATURES)fail('PDF supports inspecting at most 32 signatures.');}for(const value of object.values())if(value instanceof PDFDict||value instanceof PDFArray)walk(value,depth+1);}
  else if(object instanceof PDFArray)for(const value of object.asArray())if(value instanceof PDFDict||value instanceof PDFArray)walk(value,depth+1);
 };
 for(const [,object] of document.context.enumerateIndirectObjects())walk(object);return found;
}
function signedBytes(dict,bytes){
 const range=dict.lookupMaybe(name('ByteRange'),PDFArray),contents=dict.lookupMaybe(name('Contents'),PDFHexString);
 if(!range||range.size()!==4||!contents)fail('Signature requires a four-number ByteRange and hexadecimal Contents.');
 const values=range.asArray().map(item=>item instanceof PDFNumber?item.asNumber():NaN),[zero,start,end,length]=values;
 if(values.some(value=>!Number.isSafeInteger(value)||value<0)||zero!==0||start<1||end<=start||end>bytes.length||length>bytes.length-end||length<1)fail('Signature ByteRange is invalid.');
 if(end-start>MAX_CMS*2+8192)fail('Signature contents exceed the supported size limit.');
 const gap=ascii(bytes.subarray(start,end));if(!/^<[0-9a-f\s]+>$/i.test(gap))fail('Signature ByteRange must exclude only its Contents value.');
 const hex=gap.slice(1,-1).replace(/\s/g,'');if(hex.length%2||hex.length>MAX_CMS*2)fail('Signature contents exceed the supported size or encoding limits.');
 const cms=contents.asBytes();if(cms.length!==hex.length/2||cms.some((value,index)=>value!==parseInt(hex.slice(index*2,index*2+2),16)))fail('Excluded signature Contents do not match the active signature dictionary.');
 const data=new Uint8Array(start+length);data.set(bytes.subarray(0,start));data.set(bytes.subarray(end,end+length),start);
 return {cms,data,coversSource:end+length===bytes.length,byteRange:values};
}
function dn(name){return name.typesAndValues.map(attribute=>`${({'2.5.4.3':'CN','2.5.4.10':'O','2.5.4.11':'OU','2.5.4.6':'C'})[attribute.type]??attribute.type}=${String(attribute.value.valueBlock.value??'').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,256)}`).join(', ').slice(0,2048);}
function certificateInfo(cert){if(!(cert instanceof Certificate))return {};return {signer:dn(cert.subject),issuer:dn(cert.issuer),notBefore:cert.notBefore.value.toISOString(),notAfter:cert.notAfter.value.toISOString(),certificateDateValid:Date.now()>=cert.notBefore.value.getTime()&&Date.now()<=cert.notAfter.value.getTime()};}
function parseCms(bytes){
 const parsed=fromBER(bytes,{maxDepth:40,maxNodes:10000,maxContentLength:MAX_CMS,parseEmbedded:false});
 if(parsed.offset<0||bytes.subarray(parsed.offset).some(value=>value!==0))fail('Invalid or unsupported CMS signature encoding.');
 const info=new ContentInfo({schema:parsed.result});if(info.contentType!==SIGNED_DATA)fail('Signature contents are not CMS SignedData.');
 const cms=new SignedData({schema:info.content});
 if(cms.encapContentInfo.eContentType!==DATA||cms.encapContentInfo.eContent)fail('Only detached document signatures are supported.');
 if(cms.signerInfos.length!==1)fail('Only CMS signatures containing exactly one signer are supported.');
 if(!cms.certificates?.length||cms.certificates.length>16)fail('Signature must contain between one and 16 certificates.');
 for(const cert of cms.certificates)if(!(cert instanceof Certificate)||cert.toSchema().toBER().byteLength>MAX_CERT)fail('Unsupported or oversized embedded certificate.');
 const signer=cms.signerInfos[0],digestAlgorithm=digests[signer.digestAlgorithm.algorithmId];if(!digestAlgorithm)fail('Unsupported signature digest algorithm.');
 if(!cms.digestAlgorithms.some(algorithm=>algorithm.algorithmId===signer.digestAlgorithm.algorithmId))fail('CMS digest algorithms are inconsistent.');
 if(signer.signedAttrs){for(const oid of ['1.2.840.113549.1.9.3','1.2.840.113549.1.9.4']){const matches=signer.signedAttrs.attributes.filter(attribute=>attribute.type===oid);if(matches.length!==1||matches[0].values.length!==1)fail('Missing or ambiguous CMS signed attributes.');if(oid.endsWith('.3')&&matches[0].values[0].valueBlock.toString()!==DATA)fail('CMS signed content type is not document data.');}}
 return {cms,digestAlgorithm};
}
/** Verify embedded detached signatures over original source bytes, never appearances. */
export async function inspectPdfSignatures(content){
 validatePdfContent(content);if(!content.pages.length)return [];
 const bytes=pdfBytes(content.sourceBase64),document=await PDFDocument.load(bytes,{updateMetadata:false});
 const pendingEdits=(content.bookmarks!==undefined&&JSON.stringify(content.bookmarks)!==JSON.stringify(readPdfBookmarks(document,content.pages)))||(content.pageLabels!==undefined&&JSON.stringify(content.pageLabels)!==JSON.stringify(readPdfLabelRanges(document)))||content.pages.length!==document.getPageCount()||content.pages.some((page,index)=>page.sourceIndex!==index||page.rotation!==0||page.overlays.length>0);
 const crypto=globalThis.crypto;if(!crypto?.subtle)fail('Cryptographic verification is unavailable in this runtime.');
 const engine=new CryptoEngine({name:'Folio offline verifier',crypto}),results=[];
 for(const [index,dict] of dictionaries(document).entries()){
  const result={index,subFilter:dict.get(name('SubFilter'))?.decodeText?.()??'',supported:false,integrity:'unknown',cryptographicallyValid:null,currentRevisionCovered:false,trust:'not-verified',revocation:'not-checked',timestamp:'not-verified',pendingEdits};
  results.push(result);
  if(!['adbe.pkcs7.detached','ETSI.CAdES.detached'].includes(result.subFilter)){result.reason='This PDF signature format is not supported for cryptographic verification.';continue;}
  let signed;
  try{signed=signedBytes(dict,bytes);result.byteRange=signed.byteRange;}catch(error){result.integrity='invalid';result.cryptographicallyValid=false;result.reason=error.message;continue;}
  let parsed;
  try{parsed=parseCms(signed.cms);result.digestAlgorithm=parsed.digestAlgorithm;result.weakDigest=parsed.digestAlgorithm==='SHA-1';}catch(error){result.reason=error.message;continue;}
  result.supported=true;
  try{
   const verified=await parsed.cms.verify({signer:0,data:buffer(signed.data),checkChain:false,extendedMode:true},engine);
   Object.assign(result,certificateInfo(verified.signerCertificate));result.cryptographicallyValid=verified.signatureVerified===true;result.integrity=result.cryptographicallyValid?'valid':'invalid';
   result.currentRevisionCovered=result.cryptographicallyValid&&signed.coversSource&&!pendingEdits;
   result.reason=!result.cryptographicallyValid?'Signature verification failed: the signed bytes or signature do not match.':!signed.coversSource?'The signature is valid for an earlier file revision, not the complete current file.':pendingEdits?'The source signature is valid, but pending page edits are not signed.':'Signed bytes match the embedded certificate. Certificate trust, revocation and signing time have not been verified.';
  }catch(error){Object.assign(result,certificateInfo(error.signerCertificate));if(error.signatureVerified===false||/digest.*match/i.test(error.message)){result.integrity='invalid';result.cryptographicallyValid=false;result.reason='Signature verification failed: the signed bytes or signature do not match.';}else{result.supported=false;result.reason='The embedded signature could not be verified with the supported cryptographic algorithms and certificate data.';}}
 }
 return results;
}
