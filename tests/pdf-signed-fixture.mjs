
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pki from 'pkijs';
import {PDFDocument,PDFName,PDFHexString} from 'pdf-lib';
import {createPdfContent} from '../core/pdf-document.mjs';
import {inspectPdfSignatures} from '../core/pdf-signatures.mjs';
const cryptoEngine=new pki.CryptoEngine({name:'test',crypto:webcrypto});
let signingKeys;
async function keys(){return signingKeys??= (async()=>{const pair=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',hash:'SHA-256',modulusLength:2048,publicExponent:new Uint8Array([1,0,1])},false,['sign','verify']);const cert=new pki.Certificate();cert.version=2;cert.serialNumber=new asn1js.Integer({value:7});const name=new pki.AttributeTypeAndValue({type:'2.5.4.3',value:new asn1js.Utf8String({value:'Local TEST signer — not trusted'})});cert.subject.typesAndValues.push(name);cert.issuer.typesAndValues.push(name);cert.notBefore.value=new Date('2020-01-01Z');cert.notAfter.value=new Date('2040-01-01Z');await cert.subjectPublicKeyInfo.importKey(pair.publicKey,cryptoEngine);await cert.sign(pair.privateKey,'SHA-256',cryptoEngine);return {pair,cert};})();}
export async function signedFixture(){
 const doc=await PDFDocument.create();doc.addPage([400,200]);const placeholder='0'.repeat(16384),signature=doc.context.register(doc.context.obj({Type:'Sig',Filter:'Adobe.PPKLite',SubFilter:'adbe.pkcs7.detached',ByteRange:[0,1111111111,2222222222,3333333333],Contents:PDFHexString.of(placeholder)}));const field=doc.context.register(doc.context.obj({FT:'Sig',T:PDFHexString.fromText('Test signature'),V:signature}));doc.catalog.set(PDFName.of('AcroForm'),doc.context.obj({Fields:[field]}));
 let raw=Buffer.from(await doc.save({useObjectStreams:false})),source=raw.toString('latin1'),start=source.indexOf('<'+placeholder+'>'),end=start+placeholder.length+2;assert(start>0);const range=[0,start,end,raw.length-end],match=/\/ByteRange\s*\[[^\]]+\]/.exec(source),replacement=('/ByteRange [ '+range.join(' ')+' ]').padEnd(match[0].length,' ');assert.equal(replacement.length,match[0].length);raw.write(replacement,match.index,'latin1');
 const detached=Buffer.concat([raw.subarray(0,start),raw.subarray(end)]),{pair,cert}=await keys(),digest=await webcrypto.subtle.digest('SHA-256',detached);
 const cms=new pki.SignedData({version:1,encapContentInfo:new pki.EncapsulatedContentInfo({eContentType:'1.2.840.113549.1.7.1'}),certificates:[cert],signerInfos:[new pki.SignerInfo({version:1,sid:new pki.IssuerAndSerialNumber({issuer:cert.issuer,serialNumber:cert.serialNumber}),signedAttrs:new pki.SignedAndUnsignedAttributes({type:0,attributes:[new pki.Attribute({type:'1.2.840.113549.1.9.3',values:[new asn1js.ObjectIdentifier({value:'1.2.840.113549.1.7.1'})]}),new pki.Attribute({type:'1.2.840.113549.1.9.4',values:[new asn1js.OctetString({valueHex:digest})]})]})})]});await cms.sign(pair.privateKey,0,'SHA-256',detached.buffer.slice(detached.byteOffset,detached.byteOffset+detached.byteLength),cryptoEngine);const signed=new pki.ContentInfo({contentType:'1.2.840.113549.1.7.2',content:cms.toSchema(true)}).toSchema().toBER();raw.write(Buffer.from(signed).toString('hex').padEnd(placeholder.length,'0'),start+1,'latin1');return {bytes:raw,start,end,signedLength:signed.byteLength};
}
