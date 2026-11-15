import fs from 'node:fs/promises';
import path from 'node:path';

// Called with an already-open editor by the exclusive desktop verification run.
// It never opens an Electron process, changes document content, or builds assets.
export async function previewRibbonIcons(page,{directory,product='editor'}={}){
 if(directory)await fs.mkdir(directory,{recursive:true});
 const ribbon=page.locator('.office-ribbon');
 const names=await ribbon.getByRole('tab').allTextContents();
 const selected=await ribbon.getByRole('tab',{selected:true}).textContent();
 const results=[];
 for(const name of names){
  await ribbon.getByRole('tab',{name,exact:true}).click();
  const controls=await ribbon.locator('[role="tabpanel"] button,[role="tabpanel"] summary').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>({
   label:node.getAttribute('aria-label')||node.getAttribute('title')||node.textContent.trim(),
   icons:node.querySelectorAll('svg').length,
   semantic:node.querySelector('[data-ribbon-icon]')?.getAttribute('data-ribbon-icon')??null,
   // Theme gallery buttons are a visual preview of the slide, not text commands.
   preview:node.matches('.prism-theme'),
   disabled:node.disabled??false,
  })));
  results.push({tab:name,controls,missing:controls.filter(control=>!control.icons&&!control.preview)});
  if(directory)await ribbon.screenshot({path:path.join(directory,`${product}-${name.replace(/[^a-z0-9]+/gi,'-')}.png`)});
 }
 if(selected)await ribbon.getByRole('tab',{name:selected,exact:true}).click();
 if(directory)await fs.writeFile(path.join(directory,`${product}-icons.json`),JSON.stringify(results,null,2));
 return results;
}
