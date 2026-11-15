import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
export async function writeExportAtomically(destination,data){
 const target=path.resolve(destination),temporary=path.join(path.dirname(target),'.arkemis-export-'+crypto.randomUUID()+'.tmp');let handle;
 try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,target);}
 finally{if(handle)await handle.close();await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
