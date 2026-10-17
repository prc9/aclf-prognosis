import {BrowserEngine} from './inference.mjs';
import {prepare,hybrid} from './features.mjs';
import {ReportPipeline} from './reports.mjs';
let state='loading',failure='',schema,norm={},spec,engine=new BrowserEngine();
const reportsEngine=new ReportPipeline(progress=>self.postMessage({progress}));
let queue=Promise.resolve();
const json=async path=>{const r=await fetch(new URL(path,import.meta.url));if(!r.ok)throw Error('Unable to load '+path);return r.json();};
const initialized=(async()=>{
  try{
    schema=await json('./assets/schema.json');spec=await json('./assets/explanation.json');
    for(const h of [28,90])norm[h]=await json(`./assets/normalization-${h}.json`);
    await engine.load();await reportsEngine.init();state='ready';
  }catch(e){state='error';failure=String(e.message||e);throw e;}
})();
initialized.catch(()=>{});
const clone=x=>JSON.parse(JSON.stringify(x));
const digest=async payload=>{
  const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  const bytes=new TextEncoder().encode(JSON.stringify(stable(payload)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
};
async function prediction(payload){
  const begin=performance.now(),results={};let last;
  const first=prepare(payload,norm[28],schema),reports=await reportsEngine.analyze(first.case.reports);
  for(const h of [28,90]){
    const p=prepare(payload,norm[h],schema);last=p;
    const {result}=await engine.run(h,p,reports[h]);
    results[h]={...result,model_sha256:engine.manifest.models[h].source_sha256,onnx_sha256:engine.manifest.models[h].onnx_sha256};
  }
  const keys=new Set(last.case.events.map(e=>e.feature));
  const dynamic=schema.raw_names.slice(0,18),supplement=schema.fields.filter(f=>f.lab).map(f=>f.key),warnings=[];
  if(keys.size<10)warnings.push('sparse_measurements');
  if(!dynamic.some(k=>last.case.events.filter(e=>e.feature===k).length>1))warnings.push('single_measurement');
  return {version:'ACLF-browser-reports-v1',input_sha256:await digest(payload),generated_at:new Date().toISOString(),
    case_id:payload.case_id||'',prediction_time:payload.prediction_time,synthetic:payload.synthetic===true,
    mode:first.case.reports.length?'state_change_report':'state_change_without_report',model_status:'browser_migration_trial',execution:'visitor_browser_wasm',milliseconds:performance.now()-begin,
    definition:'Cumulative incidence of death after T0 and before liver transplantation; not all-cause mortality.',results,warnings,
    report_models:Object.fromEntries(Object.entries(reportsEngine.manifest.models).map(([k,v])=>[k,v.sha256])),
    input_summary:{measurements:last.case.events.length,dynamic_observed:dynamic.filter(k=>keys.has(k)).length,supplement_observed:supplement.filter(k=>keys.has(k)).length,reports:first.case.reports.length,observation_hours:last.record.duration}};
}

const references={};
async function reference(h){
  if(references[h])return references[h];
  const records=spec.reference_cases.map(p=>prepare(p,norm[h],schema).record),risks=[];
  for(const p of spec.reference_cases)risks.push((await engine.run(h,prepare(p,norm[h],schema))).result.death);
  return references[h]={records,risks};
}
async function explain(payload,h){
  if(![28,90].includes(h))throw Error('解释期限只能为28天或90天。');
  const started=performance.now(),p=prepare(payload,norm[h],schema),ref=await reference(h),gs=spec.groups;
  const reportBundles=await reportsEngine.analyze(p.case.reports),bundle=reportBundles[h];
  const risk=(await engine.run(h,p,bundle)).result.death,all=[];
  for(let k=0;k<4;k++){
    const paths=[spec.paths[h][k],[...spec.paths[h][k]].reverse()],both=[];
    for(const order of paths){
      const coalition=gs.map(()=>false),phi=gs.map(()=>0);
      let previous=(await engine.run(h,hybrid(p.record,ref.records[k],coalition,gs),coalition[54]?bundle:undefined)).result.death;
      if(Math.abs(previous-ref.risks[k])>2e-5)throw Error('解释参考端点不一致。');
      for(const j of order){
        coalition[j]=true;
        const next=(await engine.run(h,hybrid(p.record,ref.records[k],coalition,gs),coalition[54]?bundle:undefined)).result.death;
        phi[j]=next-previous;previous=next;
      }
      if(Math.abs(previous-risk)>2e-5)throw Error('解释病例端点不一致。');
      both.push(phi);
    }
    all.push(gs.map((_,i)=>(both[0][i]+both[1][i])/2));
  }
  const values=gs.map((_,i)=>all.reduce((sum,a)=>sum+a[i],0)/4),base=ref.risks.reduce((a,b)=>a+b,0)/4;
  const error=Math.abs(base+values.reduce((a,b)=>a+b,0)-risk);
  if(error>2e-5||(!p.case.reports.length&&Math.abs(values[54])>1e-7))throw Error('解释加和或无报告贡献检查失败。');
  const features=gs.map((g,i)=>{
    const key=i<18?schema.raw_names[i]:i>=29&&i<49?schema.fields.find(f=>f.lab===schema.lab_names[i-29])?.key:null;
    const evidence=i===54?p.case.reports.map(r=>({text:r.text,available_at:r.available_at})):key?payload.measurements.filter(m=>m.feature===key).map(m=>({...m})):[];
    let observed=evidence.length?evidence.map(m=>`${m.value} ${m.unit}`).join(' / '):'未测量';
    if(i===18)observed=String(payload.age);
    if(i>=19&&i<=21)observed=payload.supports?.[schema.raw_names[i]]===1?'有阳性记录':'未知／未观察到';
    if(i>=22&&i<=28){const e=p.record.events[i].at(-1),s=norm[h].stats[schema.raw_names[i]];observed=e?String(Math.round(e[1]*s.std+s.mean)):'未知／未观察到';}
    if(i===49)observed=payload.prior_definite?'有既往编码':'未找到既往编码';
    if(i===50)observed=payload.prior_ascites_or_he_code?'有既往编码':'未找到既往编码';
    if(i===51)observed=`${(p.case.t0-p.case.admission)/3600000}小时`;
    if(i===52)observed=`${p.case.gap}小时`;
    if(i===53)observed=`${p.record.duration}小时`;
    if(i===54)observed=p.case.reports.length?`${p.case.reports.length}份报告`:'无报告输入';
    const mean=values[i],se=Math.sqrt(all.reduce((s,a)=>s+(a[i]-mean)**2,0)/3)/2;
    return {key:g.key,name:g.name,kind:g.kind,observed,evidence,contribution_pp:mean*100,sampling_se_pp:se*100};
  });
  return {version:'ACLF-browser-reports-explanation-v1',case_id:payload.case_id||'',synthetic:payload.synthetic===true,horizon:h,
    input_sha256:await digest(payload),model_sha256:engine.manifest.models[h].source_sha256,generated_at:new Date().toISOString(),
    prediction_time:payload.prediction_time,risk,reference_risk:base,contribution_sum_pp:values.reduce((a,b)=>a+b,0)*100,reconstruction_error_pp:error*100,features,milliseconds:performance.now()-started,
    report_evidence:bundle?.evidence||[],
    method:{name:'分组排列Shapley',groups:55,backgrounds:4,paths:8,seed:spec.seed,mode:p.case.reports.length?'state_change_report':'state_change_without_report',background:'Four artificial illustrative references without reports; no training patients'},
    definition:'T0后、肝移植前死亡的累积发生风险；肝移植为竞争事件。'};
}
async function handle(path,payload){
  if(path==='/api/health')return {state,message:failure};
  await initialized;
  if(path==='/api/runtime-info')return {report_cache:reportsEngine.stats};
  if(path==='/api/predict')return prediction(payload);
  if(path==='/api/explain')return explain(payload.case,payload.horizon);
  throw Error('Unsupported local calculation.');
}
self.onmessage=({data})=>{
  // Serialize inference; health requests never wait behind an explanation.
  const respond=async()=>{try{self.postMessage({id:data.id,value:await handle(data.path,data.payload)});}catch(e){self.postMessage({id:data.id,error:String(e.message||e)});}};
  if(data.path==='/api/health')respond();else queue=queue.then(respond,respond);
};
