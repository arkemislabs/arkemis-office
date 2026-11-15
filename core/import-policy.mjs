const formats={studio:['docx','xlsx','pptx','csv','txt','md','pdf'],quill:['docx','htm','html','txt','md'],slate:['docx','txt','md'],grid:['xlsx','csv'],prism:['pptx'],folio:['pdf']};
const names={quill:'Quill',grid:'Grid',prism:'Prism',slate:'Slate',folio:'PDF'};
export function importExtensions(product){if(!Object.hasOwn(formats,product))throw new Error('Unknown application');return [...formats[product]];}
export function prepareImport(file,product,format){
 if(format!=='ark'&&!importExtensions(product).includes(format))throw new Error('This file format is not supported by this application.');
 if(product==='studio'||file.kind===product)return file;
 if(product==='slate'&&file.kind==='quill'&&['docx','txt','md'].includes(format))return {...file,kind:'slate',content:{...file.content,tags:[]}};
 if(product==='quill'&&file.kind==='slate'&&['txt','md'].includes(format)){const {tags,notebook,section,...content}=file.content;return {...file,kind:'quill',content};}
 throw new Error(`Open this file in Arkemis ${names[file.kind]??'Studio'}. Its original application type is preserved.`);
}
