export async function openFile(page){
 const tab=page.getByRole('tab',{name:'File',exact:true});
 if(await tab.count())await tab.click();else await page.getByRole('button',{name:'File',exact:true}).click();
}
export async function openSaveAs(page){
 await openFile(page);
 await page.getByRole('button',{name:'Save As',exact:true}).click();
}
export async function saveAs(page,extension){
 await openSaveAs(page);
 const dialog=page.getByRole('dialog',{name:'Save As',exact:true});
 await dialog.getByLabel('File type',{exact:true}).selectOption(extension.replace(/^\./,''));
 await dialog.getByRole('button',{name:'Save As…',exact:true}).click();
}
