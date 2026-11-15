import fs from 'node:fs';
import ts from 'typescript';

// Source inventory complements the desktop test, which checks the rendered ribbon.
// Dynamic text and controls outside a ribbon are reported, never silently assigned
// a generic icon. This does not execute or rewrite any editor source.
const sourceFile=(file)=>ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const aliases=new Map();
const registry=sourceFile('src/editors/RibbonIcon.tsx');
function visitRegistry(node){
 if(ts.isCallExpression(node)&&node.expression.getText(registry)==='register'){
  const [icon,names]=node.arguments;
  if(ts.isStringLiteral(icon)&&ts.isArrayLiteralExpression(names))for(const name of names.elements)if(ts.isStringLiteral(name))aliases.set(name.text.toLowerCase(),icon.text);
 }
 ts.forEachChild(node,visitRegistry);
}
visitRegistry(registry);
const normalize=s=>s.replace(/\s*\([^)]*\)\s*/g,' ').replace(/[.…]+$/,'').replace(/\s+/g,' ').trim().toLowerCase();
const entries=[];
for(const file of ['RichEditor.tsx','GridEditor.tsx','PrismEditor.tsx','Ribbon.tsx','Toolbar.tsx','../OfficeCommands.tsx']){
 const source=sourceFile('src/editors/'+file);
 function visit(node){
  if(ts.isJsxElement(node)){
   const tag=node.openingElement.tagName.getText(source);
   if(['button','Tool','summary'].includes(tag)){
    const attr=key=>{const prop=node.openingElement.attributes.properties.find(p=>p.name?.getText(source)===key);return prop?.initializer&&ts.isStringLiteral(prop.initializer)?prop.initializer.text:'';};
    const label=attr('label')||attr('aria-label')||attr('title')||node.children.filter(ts.isJsxText).map(x=>x.text.trim()).join(' ').trim();
    let existingIcon=false;
    function inspectIcon(child){if((ts.isJsxSelfClosingElement(child)&&/^[A-Z]|^svg$/.test(child.tagName.getText(source)))||(ts.isJsxElement(child)&&child.openingElement.tagName.getText(source)==='svg'))existingIcon=true;ts.forEachChild(child,inspectIcon);}
    node.children.forEach(inspectIcon);
    entries.push({file,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,label:label||'(dynamic)',status:existingIcon?'existing SVG':aliases.has(normalize(label))?'mapped SVG':label?'unmapped / inspect scope':'dynamic / desktop check',icon:aliases.get(normalize(label))});
   }
  }
  ts.forEachChild(node,visit);
 }
 visit(source);
}
console.log(JSON.stringify({registeredCommands:aliases.size,counts:entries.reduce((counts,item)=>(counts[item.status]=(counts[item.status]??0)+1,counts),{}),entries},null,2));
