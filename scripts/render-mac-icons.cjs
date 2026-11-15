// macOS icons from the editable SVG logos (assets/brand/products/<name>.svg): one <name>.icns per app for the app
// bundle (Finder, Dock, Launchpad, the disk image) and a <name>-dock.png the running app sets as its Dock icon, so
// Arkemis Quill, Grid, Prism, Slate and PDF each show their own logo instead of Electron's. The logo sits on Apple's
// icon grid (824 of 1024 px, centred), like other Mac apps; the .icns holds PNGs from 16 to 1024 px.
//   node_modules/electron/dist/electron scripts/render-mac-icons.cjs
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path');
app.on('window-all-closed',()=>{});
// ICNS PNG slots: type code -> pixel size.
const SLOTS=[['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024],['ic11',32],['ic12',64],['ic13',256],['ic14',512]];
const icns=images=>{
 const chunks=SLOTS.map(([type,size])=>{const png=images.get(size),head=Buffer.alloc(8);head.write(type,0,'ascii');head.writeUInt32BE(png.length+8,4);return Buffer.concat([head,png]);});
 const body=Buffer.concat(chunks),head=Buffer.alloc(8);head.write('icns',0,'ascii');head.writeUInt32BE(body.length+8,4);return Buffer.concat([head,body]);
};
app.whenReady().then(async()=>{try{
 const root=path.join(__dirname,'../assets/brand/products');
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
 await win.loadURL('data:text/html,<html></html>');
 for(const name of ['suite','quill','grid','prism','slate','folio']){
  const svg=await fs.readFile(path.join(root,name+'.svg'),'utf8'),src='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
  const images=new Map();
  for(const size of [...new Set(SLOTS.map(s=>s[1]))]){
   const data=await win.webContents.executeJavaScript(`(async()=>{const im=new Image();im.src=${JSON.stringify(src)};await im.decode();const s=${size},c=document.createElement('canvas');c.width=c.height=s;const g=c.getContext('2d');g.imageSmoothingQuality='high';const d=s*824/1024,o=(s-d)/2;g.drawImage(im,o,o,d,d);return c.toDataURL('image/png').split(',')[1]})()`);
   images.set(size,Buffer.from(data,'base64'));
  }
  await fs.writeFile(path.join(root,name+'.icns'),icns(images));
  await fs.writeFile(path.join(root,name+'-dock.png'),images.get(512));
 }
 console.log('Rendered six macOS icons (.icns + Dock PNG).');win.destroy();app.exit(0);
}catch(e){console.error(e);app.exit(1)}});
