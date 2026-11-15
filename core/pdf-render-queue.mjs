export function createPdfRenderQueue(limit=2){
 if(!Number.isInteger(limit)||limit<1||limit>8)throw new Error('Invalid render concurrency.');
 const pending=[];let active=0;
 const pump=()=>{
  while(active<limit&&pending.length){
   const job=pending.shift();job.signal?.removeEventListener('abort',job.abort);
   if(job.signal?.aborted){job.reject(new DOMException('Rendering cancelled','AbortError'));continue;}
   active++;Promise.resolve().then(job.task).then(job.resolve,job.reject).finally(()=>{active--;pump();});
  }
 };
 return (task,{signal}={})=>new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new DOMException('Rendering cancelled','AbortError'));return;}
  const job={task,signal,resolve,reject,abort:()=>{const index=pending.indexOf(job);if(index>=0){pending.splice(index,1);reject(new DOMException('Rendering cancelled','AbortError'));}}};
  signal?.addEventListener('abort',job.abort,{once:true});pending.push(job);pump();
 });
}
