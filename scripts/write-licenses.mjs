import fs from 'node:fs/promises';import path from 'node:path';
export async function writeLicenses(root,metafiles){
 const directories=new Set();
 for(const meta of metafiles)for(const input of Object.keys(meta.inputs)){const clean=input.replaceAll('\\','/'),at=clean.lastIndexOf('node_modules/');if(at<0)continue;const after=clean.slice(at+13).split('/'),count=after[0].startsWith('@')?2:1;directories.add(path.resolve(root,clean.slice(0,at+13)+after.slice(0,count).join('/')));}
 const target=path.join(root,'assets','third-party-licenses');await fs.mkdir(target,{recursive:true});const index=[];
 for(const directory of [...directories].sort()){let pkg;try{pkg=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));}catch{continue;}
  const names=(await fs.readdir(directory)).filter(n=>/^(licen[cs]e|copying|notice)([.-]|$)/i.test(n));const content=[];
  for(const name of names){const source=path.join(directory,name);if((await fs.stat(source)).isFile())content.push(name+'\n'+await fs.readFile(source,'utf8'));}
  const label=pkg.name+'@'+pkg.version;index.push({name:pkg.name,version:pkg.version,license:pkg.license??'See source notices',files:names});
  await fs.writeFile(path.join(target,label.replace(/[^a-zA-Z0-9_.-]/g,'_')+'.txt'),label+'\nLicense: '+JSON.stringify(pkg.license??null)+'\n\n'+content.join('\n\n'),'utf8');
 }
 await fs.writeFile(path.join(target,'index.json'),JSON.stringify(index,null,2));
}
