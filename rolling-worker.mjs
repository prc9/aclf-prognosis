import * as ort from './runtime/ort.wasm.min.mjs';
import {ReportPipeline} from './reports.mjs?v=20261025';
import {rollingFeatures,hazardCurves,iso,DAY} from './rolling-features.mjs?v=20261025';
import {informationGroups,syntheticReferences,groupedShapley} from './rolling-explanation.mjs?v=20261025';
ort.env.wasm.wasmPaths=new URL('./runtime/',import.meta.url).href;ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
const json=async p=>{const r=await fetch(new URL(p,import.meta.url),{cache:'no-cache'});if(!r.ok)throw Error('Model asset unavailable: '+p);return r.json();};
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
const digest=async x=>{const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;return sha(new TextEncoder().encode(JSON.stringify(stable(x))));};
const reports=new ReportPipeline(progress=>self.postMessage({progress}));let state='loading',failure='',metadata,schema,session;
const init=(async()=>{try{
 [metadata,schema]=await Promise.all([json('./assets/rolling/manifest.json'),json('./assets/schema.json')]);
 const r=await fetch(new URL('./assets/rolling/risk-reports.onnx',import.meta.url));if(!r.ok)throw Error('Current rolling model unavailable');const bytes=await r.arrayBuffer();
 if(await sha(bytes)!==metadata.onnx_sha256)throw Error('Current model hash mismatch');
 session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});await reports.init();state='ready';
}catch(e){state='error';failure=String(e.message||e);throw e;}})();init.catch(()=>{});

function reportInputs(prepared,reportBundle){
 const notes=reportBundle?.notes||new Float32Array(5*768),facts=new Float32Array(5*156),mask=reportBundle?.note_mask||new Uint8Array(5),ages=new Float32Array(5);
 if(reportBundle){
  for(let n=0;n<5;n++)for(let j=0;j<reportBundle.event_count;j++)if(reportBundle.event_mask[n*reportBundle.event_count+j]){
   const offset=(n*reportBundle.event_count+j)*41,e=reportBundle.events.subarray(offset,offset+41);let target=0;
   for(const [lo,hi]of [[12,16],[16,20],[20,25]])for(let c=0;c<12;c++)for(let a=lo;a<hi;a++){facts[n*156+target]=Math.max(facts[n*156+target],e[c]*e[a]);target++;}
  }
  prepared.selected_reports.forEach((r,i)=>ages[i]=(prepared.c.s-r.available)/DAY);
 }
 return {notes,facts,mask,ages};
}
const emptyReport=reportInputs(null,null),predictionCache=new Map(),explanationCache=new Map();
function boundedCache(cache,key,value){cache.set(key,value);while(cache.size>4)cache.delete(cache.keys().next().value);}
async function run(normalized,encoded=emptyReport){
 const {notes,facts,mask,ages}=encoded;
 const feeds={x:new ort.Tensor('float32',normalized,[1,466]),notes:new ort.Tensor('float32',notes,[1,5,768]),facts:new ort.Tensor('float32',facts,[1,5,156]),mask:new ort.Tensor('bool',mask,[1,5]),ages:new ort.Tensor('float32',ages,[1,5])};
 try{const out=await session.run(feeds);const data=Float32Array.from(out.logits.data);for(const x of Object.values(out))x.dispose();return hazardCurves(data);}finally{for(const x of Object.values(feeds))x.dispose();}
}
async function predict(payload,options){
 const inputSha=await digest(payload),cached=predictionCache.get(inputSha);if(cached)return cached.result;
 const p=rollingFeatures(payload,schema,metadata,options),visible=p.selected_reports;let bundle;
 if(visible.length){const graph=await reports.facts(visible);bundle={...graph,notes:await reports.encode(90,visible)};}
 const encoded=reportInputs(p,bundle),curves=await run(p.normalized,encoded),base=bundle?await run(p.normalized):curves,results={};
 for(const h of [28,90])results[h]={death_before_transplant:curves.death[h],liver_transplant:curves.transplant[h],event_free:curves.free[h],endpoint_time:iso(p.c.s+h*DAY),report_masked_death:base.death[h],report_effect_pp:(curves.death[h]-base.death[h])*100};
 const warnings=[];if(p.c.day>14)warnings.push('exploratory');if(!p.coverage.numeric_features_observed)warnings.push('noData');
 const result={version:metadata.version,model_sha256:metadata.source_sha256,onnx_sha256:metadata.onnx_sha256,contract:metadata.contract,
  input_sha256:inputSha,generated_at:new Date().toISOString(),case_id:payload.case_id||'',synthetic:payload.synthetic===true,
  baseline_time:payload.baseline_time,assessment_time:payload.assessment_time,days_since_T0:p.c.day,evaluation_scope:p.c.day>14?'exploratory':'primary',
  definition:'Cumulative incidence of death before first liver transplant within the next 28/90 days from this assessment.',
  results,curves,coverage:p.coverage,warnings,report_semantics_used:visible.length>0,report_semantics_supported:true,radgraph_facts_used:visible.length>0,
  evidence:[...p.visible.map(e=>({...e,window:'current'})),...(p.c.day>0?p.baseline_visible.map(e=>({...e,window:'baseline'})):[])].map(e=>{
   const row=e.feature==='urine_output_net_ml'?{feature:e.feature,value:e.value,unit:'mL',measured_at:iso(e.time),available_at:iso(e.available),source_items_aggregated:true}:payload.measurements[e.index];
   return {...row,window:e.window};
  }),
  reports_used:visible.map(r=>({text:r.text,measured_at:r.measured_at||r.available_at,available_at:r.available_at})),report_evidence:bundle?.evidence||[],
  execution:'visitor_browser_wasm',research_only:true,persistence:'In-memory case only; save to device by explicit export'};
 boundedCache(predictionCache,inputSha,{prepared:p,encoded,result});return result;
}
async function explain(payload){
 if(payload.model_sha256!==metadata.source_sha256)throw Error('The selected prediction belongs to a different model / 选中的预测来自不同模型');
 const inputSha=await digest(payload.case);
 if(inputSha!==payload.input_sha256)throw Error('Prediction inputs changed; regenerate the selected assessment / 资料已改变，请重新生成所选评估');
 if(explanationCache.has(inputSha))return explanationCache.get(inputSha);
 await predict(payload.case);const cached=predictionCache.get(inputSha),p=cached.prepared;
 const groups=informationGroups(schema,metadata),refs=syntheticReferences(payload.case,p,schema,metadata);
 const explanation=await groupedShapley(p,refs,groups,(x,report)=>run(x,report?cached.encoded:emptyReport),cached.result.curves,{progress:progress=>self.postMessage({progress:{stage:'explain',...progress}})});
 const enriched={...explanation,version:'rolling-grouped-shapley-v1',model_version:metadata.version,model_sha256:metadata.source_sha256,onnx_sha256:metadata.onnx_sha256,input_sha256:inputSha,
  case_id:payload.case.case_id||'',baseline_time:payload.case.baseline_time,assessment_time:payload.case.assessment_time,days_since_T0:p.c.day,generated_at:new Date().toISOString()};
 for(const h of [28,90]){
  enriched.horizons[h].endpoint_time=cached.result.results[h].endpoint_time;
  enriched.horizons[h].groups=enriched.horizons[h].groups.map(g=>{
   let evidence=[],observed=null;
   if(g.kind==='numeric')evidence=cached.result.evidence.filter(e=>e.feature===g.key);
   else if(g.kind==='baseline')observed=payload.case[g.key];
   else if(g.kind==='support'){
    evidence=(payload.case.support_records||[]).filter(r=>r.feature===g.key&&p.c.supports.some(s=>s.feature===r.feature&&s.start<=p.c.s&&s.end>=Math.max(p.c.admission,p.c.s-DAY)&&s.available<=p.c.s&&r.start_at===s.start_at&&r.end_at===s.end_at&&r.available_at===s.available_at));
    observed=+(evidence.length>0);
   }else {
    const encodedIds=new Set(p.selected_reports.map(r=>r.index));
    evidence=p.c.reports.filter(r=>r.time>=Math.max(p.c.admission,p.c.s-DAY)&&r.available<=p.c.s).map(r=>({text:r.text,measured_at:r.measured_at||r.available_at,available_at:r.available_at,encoded:encodedIds.has(r.index)}));
    observed=p.selected_reports.length;
   }
   return {...g,evidence,observed};
  });
 }
 boundedCache(explanationCache,inputSha,enriched);return enriched;
}
async function handle(path,payload){
 if(path==='health')return {state,message:failure};await init;
 if(path==='predict')return predict(payload);
 if(path==='explain')return explain(payload);
 if(path==='daily'){
  // Validate the current status once. Past in-admission snapshots use the
  // original assessment grid and independently filter every record by time.
  const current=rollingFeatures(payload,schema,metadata),snapshots=[];
  for(let day=0;day<=current.c.day;day++){
   self.postMessage({progress:{stage:'daily',day,through:current.c.day}});
   snapshots.push(await predict({...payload,assessment_time:iso(current.c.t0+day*DAY)},{checkT0:false}));
  }
  return {snapshots};
 }
 throw Error('Unsupported browser calculation');
}
let queue=Promise.resolve();self.onmessage=({data})=>{const respond=async()=>{try{self.postMessage({id:data.id,value:await handle(data.path,data.payload)});}catch(e){self.postMessage({id:data.id,error:String(e.message||e)});}};if(data.path==='health')respond();else queue=queue.then(respond,respond);};
