// Deterministic exports from editable SVG sources for Windows and preview only.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{try{
 const root=path.join(__dirname,'../assets/brand/products');
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
 await win.loadURL('data:text/html,<html></html>');
 const names=['suite','quill','grid','prism','slate','folio'],items=[];
 for(const name of names){
  const svg=await fs.readFile(path.join(root,name+'.svg'),'utf8'),src='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
  const sizes=[16,24,32,48,64,128,256],images=[];
  for(const size of sizes){const data=await win.webContents.executeJavaScript(`(async()=>{const im=new Image();im.src=${JSON.stringify(src)};await im.decode();const c=document.createElement('canvas');c.width=c.height=${size};c.getContext('2d').drawImage(im,0,0,${size},${size});return c.toDataURL('image/png').split(',')[1]})()`);images.push(Buffer.from(data,'base64'));}
  const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
  sizes.forEach((size,i)=>{const p=6+i*16;header[p]=header[p+1]=size===256?0:size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(images[i].length,p+8);header.writeUInt32LE(offset,p+12);offset+=images[i].length;});
  await fs.writeFile(path.join(root,name+'.ico'),Buffer.concat([header,...images]));
  await fs.writeFile(path.join(root,name+'.png'),images.at(-1));await fs.writeFile(path.join(root,name+'-small.png'),images.at(-2));items.push({name,src});
 }
 const preview=await win.webContents.executeJavaScript(`(async()=>{const items=${JSON.stringify(items)},c=document.createElement('canvas');c.width=items.length*240;c.height=390;const g=c.getContext('2d');g.fillStyle='#121319';g.fillRect(0,0,c.width,390);g.textAlign='center';for(let i=0;i<items.length;i++){const im=new Image();im.src=items[i].src;await im.decode();g.drawImage(im,24+i*240,24,192,192);g.fillStyle='#f0f0f4';g.font='19px Segoe UI';g.fillText('Arkemis '+items[i].name[0].toUpperCase()+items[i].name.slice(1),120+i*240,260);g.drawImage(im,78+i*240,295,32,32);g.drawImage(im,130+i*240,287,48,48);}return c.toDataURL('image/png').split(',')[1]})()`);
 await fs.writeFile(path.join(root,'preview.png'),Buffer.from(preview,'base64'));
 await fs.writeFile(path.join(root,'preview.html'),'<!doctype html><title>Arkemis vector identity</title><style>body{margin:0;background:#121319}img{width:100%}</style><img src="preview.png" alt="Hand-authored Arkemis SVG family">');
 console.log('Exported five SVG logos to seven-size ICOs and preview.');win.destroy();app.exit(0);
 }catch(e){console.error(e);app.exit(1)}});
