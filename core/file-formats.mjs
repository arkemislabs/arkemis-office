const exportsByKind={quill:['docx','html','txt'],slate:['docx','html','txt','md'],grid:['xlsx','csv'],prism:['pptx'],folio:['pdf']};
export function exportExtensions(kind){if(!Object.hasOwn(exportsByKind,kind))throw Error('Unknown application');return [...exportsByKind[kind]];}
export function extensionLabel(extension){if(!/^[a-z0-9]+$/.test(extension))throw Error('Invalid extension');return '.'+extension;}
