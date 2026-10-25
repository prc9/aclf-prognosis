// Grouped permutation Shapley for the current 466-feature rolling model.
// Synthetic references, fixed assessment clock, joint within-variable masks
// and changes. This is a model explanation, not a causal attribution.
import {rollingFeatures,iso,HOUR} from './rolling-features.mjs?v=20261025';

export function informationGroups(schema,metadata){
 const groups=schema.fields.map(f=>({key:f.key,kind:'numeric',indices:metadata.feature_names.flatMap((name,i)=>name.endsWith('|'+f.key)?[i]:[])}));
 for(const key of ['age','prior_definite','prior_ascites_or_he_code'])groups.push({key,kind:'baseline',indices:[metadata.feature_names.indexOf(key)]});
 for(const key of ['mechanical_ventilation_in_window','rrt_in_window','vasopressor_in_window'])groups.push({key,kind:'support',indices:[metadata.feature_names.indexOf('support_positive|'+key)]});
 groups.push({key:'reports',kind:'report',indices:['reports_log_count','report_latest_age_hours'].map(k=>metadata.feature_names.indexOf(k))});
 const covered=groups.flatMap(g=>g.indices),held=['admission_to_T0_hours','landmark_day'].map(k=>metadata.feature_names.indexOf(k));
 if(covered.some(i=>i<0)||new Set([...covered,...held]).size!==466||covered.length+held.length!==466)throw Error('Explanation feature groups do not cover the current model');
 return groups;
}

export function syntheticReferences(payload,prepared,schema,metadata){
 const levels=[
  {age:45,prior_definite:1,prior_ascites_or_he_code:0,total_bilirubin:6,inr:1.6,creatinine:1,albumin:3.5,sodium:138,potassium:4,lactate:1.5,wbc:8,heart_rate:80,mean_arterial_pressure:85,respiratory_rate:18,spo2:98,temperature_c:36.8,fio2_fraction:.21},
  {age:55,prior_definite:1,prior_ascites_or_he_code:0,total_bilirubin:10,inr:2,creatinine:1.5,albumin:3,sodium:135,potassium:4.2,lactate:2,wbc:10,heart_rate:90,mean_arterial_pressure:80,respiratory_rate:20,spo2:96,temperature_c:37,fio2_fraction:.28},
  {age:65,prior_definite:1,prior_ascites_or_he_code:1,total_bilirubin:15,inr:2.4,creatinine:2,albumin:2.8,sodium:132,potassium:4.5,lactate:3,wbc:12,heart_rate:100,mean_arterial_pressure:75,respiratory_rate:22,spo2:94,temperature_c:37.2,fio2_fraction:.35},
  {age:50,prior_definite:0,prior_ascites_or_he_code:0,total_bilirubin:20,inr:3,creatinine:2.5,albumin:2.5,sodium:130,potassium:4.7,lactate:4,wbc:15,heart_rate:110,mean_arterial_pressure:70,respiratory_rate:24,spo2:92,temperature_c:37.5,fio2_fraction:.4}
 ];
 return levels.map((level,n)=>{
  const measurements=[],moments=new Set([Math.max(prepared.c.admission,prepared.c.t0-6*HOUR),prepared.c.t0]);
  if(prepared.c.s>prepared.c.t0){moments.add(Math.max(prepared.c.admission,prepared.c.s-6*HOUR));moments.add(prepared.c.s);}
  for(const time of [...moments].sort((a,b)=>a-b))for(const f of schema.fields){
   if(!Object.hasOwn(level,f.key))continue;
   // The earlier baseline INR stays below its trigger threshold; the
   // artificial qualifying pair first becomes available at the fixed T0.
   const value=f.key==='inr'&&time<prepared.c.t0?1.4:level[f.key];
   measurements.push({feature:f.key,value,unit:f.unit,measured_at:iso(time),available_at:iso(time),trigger:time===prepared.c.t0&&['total_bilirubin','inr'].includes(f.key)});
  }
  const reference={...payload,case_id:'ARTIFICIAL-REFERENCE-'+(n+1),synthetic:true,age:level.age,prior_definite:level.prior_definite,prior_ascites_or_he_code:level.prior_ascites_or_he_code,measurements,support_records:[],reports:[]};
  const p=rollingFeatures(reference,schema,metadata,{checkT0:false});
  return {id:reference.case_id,age:reference.age,normalized:p.normalized};
 });
}

function permutation(n,seed){
 let a=Array.from({length:n},(_,i)=>i),state=seed>>>0;
 for(let i=n-1;i>0;i--){state=(Math.imul(1664525,state)+1013904223)>>>0;const j=Math.floor(state/4294967296*(i+1));[a[i],a[j]]=[a[j],a[i]];}
 return a;
}

export async function groupedShapley(prepared,references,groups,predict,actual,{progress=()=>{}}={}){
 const horizons=[28,90],samples={28:[],90:[]},bases={28:[],90:[]},reportGroup=groups.findIndex(g=>g.kind==='report');let calls=0;
 for(let b=0;b<references.length;b++){
  const reference=references[b],base=await predict(reference.normalized,false);calls++;
  for(const h of horizons)bases[h].push(base.death[h]);
  const order=permutation(groups.length,42+b*997),paired={28:[],90:[]};
  for(const indices of [order,[...order].reverse()]){
   const x=Float32Array.from(reference.normalized);let hasReport=false,previous={28:base.death[28],90:base.death[90]};const phi={28:groups.map(()=>0),90:groups.map(()=>0)};
   for(let step=0;step<indices.length;step++){
    const index=indices[step],group=groups[index];for(const i of group.indices)x[i]=prepared.normalized[i];
    if(index===reportGroup)hasReport=true;
    const curve=await predict(x,hasReport);calls++;
    for(const h of horizons){phi[h][index]=curve.death[h]-previous[h];previous[h]=curve.death[h];}
    progress({completed:calls,total:references.length*(1+2*groups.length),background:b+1});
   }
   for(const h of horizons){if(Math.abs(previous[h]-actual.death[h])>3e-6)throw Error('Explanation endpoint differs from the selected prediction');paired[h].push(phi[h]);}
   if(x.some((v,i)=>v!==prepared.normalized[i]))throw Error('Explanation input does not reconstruct the current model input');
  }
  for(const h of horizons)samples[h].push(groups.map((_,i)=>(paired[h][0][i]+paired[h][1][i])/2));
 }
 const output={};
 for(const h of horizons){
  const background=bases[h].reduce((a,b)=>a+b,0)/references.length,values=groups.map((_,i)=>samples[h].reduce((s,v)=>s+v[i],0)/references.length),total=values.reduce((a,b)=>a+b,0),error=Math.abs(background+total-actual.death[h])*100;
  if(error>1e-3)throw Error('Shapley contributions do not reconstruct risk');
  if(!prepared.selected_reports.length&&Math.abs(values[reportGroup])>1e-7)throw Error('No-report contribution must be zero');
  output[h]={risk:actual.death[h],reference_risk:background,contribution_sum_pp:total*100,reconstruction_error_pp:error,
   groups:groups.map((g,i)=>({...g,contribution_pp:values[i]*100,sampling_se_pp:Math.sqrt(samples[h].reduce((s,v)=>s+(v[i]-values[i])**2,0)/Math.max(1,references.length-1)/references.length)*100}))};
 }
 return {horizons:output,method:{name:'Grouped permutation Shapley',groups:groups.length,backgrounds:references.length,paths:references.length*2,seed:42,
  background:'Four artificial illustrative no-report cases; no training patients',held_fixed:['Original T0','assessment time','admission-to-T0 interval'],
  grouping:'Each numeric variable jointly includes baseline/current values, masks, counts, recency and changes; reports jointly include content, facts, timing and availability',
  interpretation:'Model contribution relative to artificial references, not a causal effect or treatment benefit',reference_ids:references.map(r=>r.id),model_calls:calls}};
}
