export function dragPdfOverlay(overlay,page,start,end,mode='move'){
 if(![start?.x,start?.y,end?.x,end?.y,overlay?.x,overlay?.y,overlay?.width,overlay?.height,page?.width,page?.height].every(value=>typeof value==='number'&&Number.isFinite(value)))throw new Error('Invalid annotation coordinate.');
 if(!['move','resize'].includes(mode))throw new Error('Invalid annotation drag mode.');
 const clamp=(value,min,max)=>Math.max(min,Math.min(max,value)),dx=end.x-start.x,dy=end.y-start.y;
 if(mode==='move')return {x:clamp(overlay.x+dx,0,page.width-overlay.width),y:clamp(overlay.y+dy,0,page.height-overlay.height),width:overlay.width,height:overlay.height};
 return {x:overlay.x,y:overlay.y,width:clamp(overlay.width+dx,Math.min(8,page.width-overlay.x),page.width-overlay.x),height:clamp(overlay.height+dy,Math.min(8,page.height-overlay.y),page.height-overlay.y)};
}
