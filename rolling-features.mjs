// Numerical feature contract shared with dynamic_prediction/features.py.
// Timestamps use a timezone-free wall-clock axis, independent of device zone.
import {timestamp} from './features.mjs';
export const HOUR=3600000,DAY=24*HOUR;
export const supportKeys=['mechanical_ventilation_in_window','rrt_in_window','vasopressor_in_window'];
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
export const iso=t=>new Date(t).toISOString().slice(0,19);

export function validateRolling(payload,schema,{checkT0=true}={}){
 check(payload&&typeof payload==='object'&&!Array.isArray(payload),'Invalid case / 病例格式错误');
 const admission=timestamp(payload.admission_time),t0=timestamp(payload.baseline_time),s=timestamp(payload.assessment_time);
 check(admission<=t0&&t0<=s,'Require admission ≤ T0 ≤ assessment / 时间顺序须为入院≤T0≤本次评估');
 const day=(s-t0)/DAY;check(day<=28,'Updates are supported through day 28 / 仅支持T0后第0—28天');
 check(Math.abs(day-Math.round(day))<1e-8,'Use a daily assessment at the same clock time as T0 / 请选择与T0相同时分的每日评估时点');
 check(payload.current_status?.alive===true&&payload.current_status?.transplanted===false&&payload.current_status?.in_index_admission===true,'Confirm alive, no transplant and same admission / 请确认仍存活、尚未移植且仍在本次住院');
 check(finite(payload.age)&&payload.age>=18&&payload.age<=120,'Age must be 18–120 / 年龄须为18—120岁');
 for(const key of ['prior_definite','prior_ascites_or_he_code'])check(Number.isInteger(payload[key])&&[0,1].includes(payload[key]),'Check prior diagnosis codes / 请核对既往编码');
 check(payload.case_id===undefined||typeof payload.case_id==='string'&&payload.case_id.length<=80,'Study ID too long / 研究编号过长');
 const byKey=Object.fromEntries(schema.fields.map(f=>[f.key,f]));
 check(Array.isArray(payload.measurements)&&payload.measurements.length>=2&&payload.measurements.length<=10000,'Enter 2–10,000 measurements / 请录入2—10000条测量');
 const events=payload.measurements.map((m,i)=>{
  const f=Object.hasOwn(byKey,m?.feature)?byKey[m.feature]:null;
  check(f&&finite(m.value)&&Object.hasOwn(f.units,m.unit),'Invalid measurement or unit / 指标、数值或单位无效');
  const value=m.value*f.units[m.unit],time=timestamp(m.measured_at),available=timestamp(m.available_at||m.measured_at);
  check(value>=f.min&&value<=f.max,`${f.key}: out of range; check units / 数值超出范围，请核对单位`);
  check(available>=time,'Result cannot be known before sampling / 结果已知时间不能早于采样');
  check(!f.key.startsWith('gcs_')||Number.isInteger(value),'GCS components must be integers / GCS须为整数');
  const item=m.source_item_id??i;check(Number.isInteger(item)&&item>=0,'Invalid source item ID / 原始项目编号无效');
  return {...m,value,time,available,item,index:i};
 });
 if(checkT0){
  const begin=Math.max(admission,t0-DAY),triggers=[];
  for(const [key,minimum] of [['total_bilirubin',5],['inr',1.5]]){
   const selected=events.filter(e=>e.feature===key&&e.trigger===true);
   check(selected.length===1&&selected[0].value>=minimum&&selected[0].time>=begin&&selected[0].available<=t0,'Select qualifying baseline bilirubin and INR T0 results / 请指定符合阈值且在T0前24小时内的胆红素及INR触发结果');triggers.push(selected[0]);
  }
  check(Math.max(...triggers.map(e=>e.available))===t0,'T0 must equal the later availability of the trigger results / T0须为两项触发结果中较晚的已知时间');
  check(Math.abs(triggers[0].time-triggers[1].time)<=DAY,'Trigger samples must be within 24 hours / 两项触发采样相隔不能超过24小时');
 }
 check(Array.isArray(payload.reports||[])&&(payload.reports||[]).length<=100,'At most 100 report records / 最多100条报告');
 const reports=(payload.reports||[]).map((r,index)=>{
  const time=timestamp(r.measured_at||r.available_at),available=timestamp(r.available_at);
  check(available>=time&&typeof r.text==='string'&&r.text.trim().length>0&&r.text.length<=20000,'Invalid report text or times / 报告正文或时间无效');
  check(!/[\u4e00-\u9fff]/.test(r.text),'English reports are supported by the current encoder / 当前编码器支持英文报告');
  return {...r,time,available,index};
 });
 check(Array.isArray(payload.support_records||[])&&(payload.support_records||[]).length<=1000,'Too many support records / 治疗支持记录过多');
 const supports=(payload.support_records||[]).map(r=>{
  const start=timestamp(r.start_at),end=timestamp(r.end_at),available=timestamp(r.available_at);
  check(supportKeys.includes(r.feature)&&end>=start&&available>=start,'Invalid support type or times / 治疗支持类型或时间顺序错误');return {...r,start,end,available};
 });
 return {admission,t0,s,day,events,reports,supports};
}

function visible(events,begin,end){
 const a=events.filter(e=>e.time>=begin&&e.time<=end&&e.available<=end&&e.available>=e.time).sort((a,b)=>a.time-b.time||a.available-b.available||a.item-b.item);
 // Corrections become visible before deduplication. Urine source items add.
 const urine=new Map(),other=[];
 for(const e of a){if(e.feature==='urine_output_net_ml')urine.set(e.item+'|'+e.time,e);else other.push(e);}
 const sums=new Map();
 for(const e of urine.values()){const prev=sums.get(e.time);if(prev){prev.value+=e.value;prev.available=Math.max(prev.available,e.available);}else sums.set(e.time,{...e});}
 const ordered=[...other,...sums.values()].sort((a,b)=>a.time-b.time||a.available-b.available||a.item-b.item),unique=new Map();
 for(const e of ordered)unique.set(e.feature+'|'+e.time,e);
 return [...unique.values()].sort((a,b)=>a.time-b.time||a.available-b.available||a.item-b.item);
}
function stats(events,begin,end){
 const rows=visible(events,begin,end),groups=new Map();
 for(const e of rows){if(!groups.has(e.feature))groups.set(e.feature,[]);groups.get(e.feature).push(e);}
 const result={};
 for(const [key,g]of groups){const first=g[0],last=g.at(-1),values=g.map(e=>e.value);result[key]={last:last.value,present:1,log_count:Math.log1p(g.length),recency_hours:(end-last.time)/HOUR,change:g.length>1?last.value-first.value:NaN,change_present:+(g.length>1),span_hours:(last.time-first.time)/HOUR,min:Math.min(...values),max:Math.max(...values)};}
 return {result,rows};
}
export function rollingFeatures(payload,schema,metadata,options){
 const c=validateRolling(payload,schema,options),b=stats(c.events,Math.max(c.admission,c.t0-DAY),c.t0),current=stats(c.events,Math.max(c.admission,c.s-DAY),c.s);
 const x={age:payload.age,prior_definite:payload.prior_definite,prior_ascites_or_he_code:payload.prior_ascites_or_he_code,admission_to_T0_hours:(c.t0-c.admission)/HOUR,landmark_day:c.day};
 for(const f of schema.fields.map(f=>f.key)){
  const bs=b.result[f],cs=current.result[f];x['baseline_last|'+f]=bs?.last??NaN;x['baseline_present|'+f]=bs?.present??0;
  for(const stat of ['last','present','log_count','recency_hours','change','change_present','span_hours','min','max'])x['current_'+stat+'|'+f]=cs?.[stat]??(['present','log_count','change_present'].includes(stat)?0:NaN);
  x['baseline_to_current_change|'+f]=bs&&cs?cs.last-bs.last:NaN;
 }
 const begin=Math.max(c.admission,c.s-DAY);
 for(const key of supportKeys)x['support_positive|'+key]=+(c.supports.some(r=>r.feature===key&&r.start<=c.s&&r.end>=begin&&r.available<=c.s));
 const rr=c.reports.filter(r=>r.time>=begin&&r.time<=c.s&&r.available<=c.s);
 x.reports_log_count=Math.log1p(rr.length);x.report_latest_age_hours=rr.length?(c.s-Math.max(...rr.map(r=>r.available)))/HOUR:NaN;
 const vector=metadata.feature_names.map(k=>x[k]);check(vector.length===466,'Feature contract mismatch');
 const t=metadata.transform,normalized=Float32Array.from(vector,(v,i)=>Math.max(-t.standardized_clip,Math.min(t.standardized_clip,((Number.isFinite(v)?v:t.median[i])-t.mean[i])/t.scale[i])));
 const selected=rr.sort((a,b)=>a.available-b.available||a.time-b.time||(String(a.note_id||a.index||'').localeCompare(String(b.note_id||b.index||'')))).slice(-5);
 return {values:vector,normalized,c,selected_reports:selected,visible:current.rows,baseline_visible:b.rows,coverage:{measurement_rows:current.rows.length,numeric_features_observed:Object.keys(current.result).length,numeric_features_repeated:Object.values(current.result).filter(v=>v.change_present).length,baseline_features_observed:Object.keys(b.result).length,reports_last24h:rr.length,reports_encoded:selected.length}};
}
export function hazardCurves(logits){
 const death=[0],transplant=[0],free=[1];let survival=1,d=0,lt=0;
 for(let i=0;i<90;i++){const row=Array.from(logits.slice(i*3,i*3+3));check(row.every(Number.isFinite),'Nonfinite prediction');const max=Math.max(...row),e=row.map(v=>Math.exp(v-max)),sum=e.reduce((a,b)=>a+b,0);d+=survival*e[1]/sum;lt+=survival*e[2]/sum;survival*=e[0]/sum;death.push(d);transplant.push(lt);free.push(survival);}
 check(Math.abs(d+lt+survival-1)<1e-5,'Invalid competing-risk distribution');return {death,transplant,free};
}
