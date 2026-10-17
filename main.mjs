// Every calculation below is a message to a browser Worker, never an HTTP API.
const worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});
const pending=new Map();let sequence=0,workerFailure='';
worker.onmessage=({data})=>{
  if(data.progress){
    const p=data.progress,en=document.documentElement.lang==='en',box=document.getElementById('report-progress');if(!box)return;
    box.hidden=false;
    box.textContent=p.stage==='model'?(en?`Reading report model ${p.name} (${(p.bytes/1048576).toFixed(0)} MiB)…`:`正在读取报告模型 ${p.name}（${(p.bytes/1048576).toFixed(0)} MiB）…`):
      p.stage==='graph'?(en?`Extracting report evidence: sentence ${p.sentence}/${p.sentences}…`:`正在提取报告证据：第 ${p.sentence}/${p.sentences} 句…`):
      p.stage==='clinical'?(en?`Encoding ${p.horizon}-day report: ${p.report}/${p.reports}, chunk ${p.chunk}/${p.chunks}…`:`正在编码${p.horizon}天报告：第 ${p.report}/${p.reports} 份，第 ${p.chunk}/${p.chunks} 块…`):
      (en?'Report analysis complete.':'报告分析完成。');return;
  }
  const request=pending.get(data.id);if(!request)return;pending.delete(data.id);data.error?request.reject(Error(data.error)):request.resolve(data.value);
};
worker.onerror=e=>{workerFailure=e.message||'Browser Worker failed to initialize.';for(const r of pending.values())r.reject(Error(workerFailure));pending.clear();};
const call=(path,payload)=>new Promise((resolve,reject)=>{if(workerFailure)return reject(Error(workerFailure));const id=++sequence;pending.set(id,{resolve,reject});worker.postMessage({id,path,payload});});
window.browserRequest=async(path,payload,blob=false)=>{
  if(path.startsWith('/api/export/')) {
    if(path.endsWith('/csv')){
      const rows=['horizon,day,death_cumulative_incidence,transplant_cumulative_incidence,event_free_probability'];
      for(const h of [28,90])for(let d=0;d<=h;d++){const r=payload.results[h];rows.push([h,d,r.death_curve[d],r.transplant_curve[d],r.event_free_curve[d]].join(','));}
      return new Blob(['\uFEFF'+rows.join('\r\n')],{type:'text/csv;charset=utf-8'});
    }
    return new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  }
  return call(path,payload);
};
await import('./app.js');
