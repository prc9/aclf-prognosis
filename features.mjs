// Port of schema.py, numeric_input.py and the pinned v10 feature contract.
// All timestamps are interpreted on a timezone-free wall-clock axis.
const f32 = Math.fround;
const HOUR = 3600000;
const END = 23.999998092651367;
const fail = message => { throw new Error(message); };
const isNumber = n => typeof n === 'number' && Number.isFinite(n);

export function timestamp(text) {
  if (typeof text !== 'string') fail('请填写完整的本地日期和时间。');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
  if (!m) fail('时间须为无时区的本地日期和时间。');
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(x => Number(x || 0));
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day); d.setUTCHours(hour, minute, second, Number((m[7] || '').padEnd(3, '0')));
  if (year < 1 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day || d.getUTCHours() !== hour || d.getUTCMinutes() !== minute || d.getUTCSeconds() !== second) fail('日期或时间无效。');
  return d.getTime();
}

export function validate(payload, schema) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('病例须为对象。');
  const admission = timestamp(payload.admission_time), t0 = timestamp(payload.prediction_time);
  if (admission > t0) fail('入院时间不能晚于预测起点。');
  if (!isNumber(payload.age) || payload.age < 18 || payload.age > 120) fail('年龄须为18～120岁。');
  const history = ['prior_definite', 'prior_ascites_or_he_code'].map(key => {
    if (!Number.isInteger(payload[key]) || ![0, 1].includes(payload[key])) fail('请核对两项既往编码记录。');
    return payload[key];
  });
  const supports = payload.supports === undefined ? {} : payload.supports;
  if (!supports || typeof supports !== 'object' || Array.isArray(supports) || Object.entries(supports).some(([k,v]) => !schema.raw_names.slice(19,22).includes(k) || (v !== 1 && v !== null))) fail('治疗支持仅接受阳性记录或未知。');
  if (!Array.isArray(payload.measurements) || payload.measurements.length < 2 || payload.measurements.length > 500) fail('请录入2～500条观测。');
  const byKey = Object.fromEntries(schema.fields.map(f => [f.key, f]));
  const start = Math.max(admission, t0 - 24 * HOUR), seen = new Set();
  const events = payload.measurements.map(m => {
    const field = Object.hasOwn(byKey,m?.feature) ? byKey[m.feature] : null;
    if (!field) fail('包含不支持的指标。');
    if (!isNumber(m.value) || !Object.hasOwn(field.units, m.unit)) fail(field.label + '的数值或单位无效。');
    const value = m.value * field.units[m.unit];
    if (value < field.min || value > field.max) fail(field.label + '超出允许范围，请核对单位。');
    if (m.feature.startsWith('gcs_') && !Number.isInteger(value)) fail('GCS单项须为整数。');
    const time = timestamp(m.measured_at), available = timestamp(m.available_at === undefined ? m.measured_at : m.available_at);
    if (!(start <= time && time <= available && available <= t0)) fail(field.label + '须在观察窗内测量，且在T0前已知。');
    const id = m.feature + ':' + time;
    if (seen.has(id)) fail(field.label + '在同一时刻有重复记录。');
    seen.add(id);
    if (m.trigger !== undefined && typeof m.trigger !== 'boolean') fail('触发检验标记无效。');
    return {feature: m.feature, value, time, available, trigger: !!m.trigger};
  }).sort((a,b) => a.time - b.time || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));
  const triggers = {};
  for (const [key, minimum] of [['total_bilirubin', 5], ['inr', 1.5]]) {
    const selected = events.filter(e => e.feature === key && e.trigger);
    if (selected.length !== 1 || selected[0].value < minimum) fail('请选择符合阈值的唯一总胆红素和INR触发结果。');
    triggers[key] = selected[0];
  }
  if (Math.max(...Object.values(triggers).map(e => e.available)) !== t0) fail('T0须等于两项触发结果中较晚的已知时间。');
  const gap = Math.abs(triggers.total_bilirubin.time - triggers.inr.time) / HOUR;
  if (gap > 24) fail('两项触发检验的采样间隔不能超过24小时。');
  if (payload.case_id !== undefined && (typeof payload.case_id !== 'string' || [...payload.case_id].length > 80)) fail('研究编号最多80个字符。');
  const incomingReports=payload.reports===undefined?[]:payload.reports;
  if(!Array.isArray(incomingReports)||incomingReports.length>5)fail('最多录入5份英文报告。');
  const reports=incomingReports.map(r=>{
    if(!r||typeof r.text!=='string')fail('报告须包含正文和结果可用时间。');
    const text=r.text.trim();if(!text||[...text].length>4000)fail('每份报告须为1～4000个字符。');
    if(/[\u4e00-\u9fff]/.test(text))fail('当前模型仅接受英文报告，中文报告编码尚未接入。');
    const available=timestamp(r.available_at);if(available<start||available>t0)fail('报告须在观察窗内、T0时已可用。');
    return {text,available,available_at:r.available_at};
  }).sort((a,b)=>a.available-b.available);
  return {admission, t0, start, events, history, triggers, gap, supports, age: payload.age,reports};
}

export function prepare(payload, norm, schema) {
  const c = validate(payload, schema), names = schema.raw_names;
  const raw = c.events.filter(e => names.slice(0,18).includes(e.feature)).map(e => ({...e}));
  raw.push({time: c.start, feature:'age_at_admission', value:c.age});
  for (const key of names.slice(19,22)) if (c.supports[key] === 1) raw.push({time:c.t0, feature:key, value:1});
  const values = key => c.events.filter(e => e.feature === key).map(e => e.value);
  const maximum = key => values(key).length ? Math.max(...values(key)) : null;
  const tb = maximum('total_bilirubin'), cr = maximum('creatinine'), ir = maximum('inr');
  const organs = {liver_failure:tb === null ? null : +(tb >= 12),
    kidney_failure:c.supports.rrt_in_window === 1 || cr !== null && cr >= 2 ? 1 : null,
    brain_failure_gcs_proxy:null, coagulation_failure:ir === null ? null : +(ir >= 2.5),
    circulation_failure:c.supports.vasopressor_in_window === 1 ? 1 : null, respiratory_failure_sf_proxy:null};
  const gcs = new Map();
  for (const e of c.events.filter(e => e.feature.startsWith('gcs_'))) { if (!gcs.has(e.time)) gcs.set(e.time, {}); gcs.get(e.time)[e.feature] = e.value; }
  const totals = [...gcs.values()].filter(x => Object.keys(x).length === 3).map(x => Object.values(x).reduce((a,b) => a+b,0));
  if (totals.length) organs.brain_failure_gcs_proxy = +(Math.min(...totals) <= 9);
  const fio = c.events.filter(e => e.feature === 'fio2_fraction'), ratios = [];
  for (const s of c.events.filter(e => e.feature === 'spo2')) {
    const near = fio.filter(f => Math.abs(s.time - f.time) <= HOUR).sort((a,b) => Math.abs(s.time-a.time) - Math.abs(s.time-b.time) || a.time-b.time);
    if (near.length) ratios.push(s.value / near[0].value);
  }
  if (ratios.length) organs.respiratory_failure_sf_proxy = +(Math.min(...ratios) <= 214);
  for (const [feature,value] of Object.entries(organs)) if (value !== null) raw.push({time:c.t0,feature,value});
  if (Object.values(organs).some(v => v !== null)) raw.push({time:c.t0,feature:'organ_failure_count_confirmed',value:Object.values(organs).filter(v => v === 1).length});
  raw.sort((a,b) => a.time-b.time || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));
  const trajectories = names.map(() => new Map());
  for (const e of raw) {
    const t = f32(Math.min(Math.max((e.time - c.t0 + 24 * HOUR)/HOUR, 0), END));
    const stat = norm.stats[e.feature];
    trajectories[names.indexOf(e.feature)].set(t, f32((e.value - stat.mean)/stat.std));
  }
  const byKey = Object.fromEntries(schema.fields.map(f => [f.key,f]));
  const extraRaw = [...c.history, Math.log1p((c.t0-c.admission)/HOUR), c.triggers.total_bilirubin.value, c.triggers.inr.value, c.gap];
  for (const label of schema.lab_names) {
    const candidates = c.events.filter(e => byKey[e.feature].lab === label);
    extraRaw.push(candidates.length ? candidates.at(-1).value : NaN);
  }
  const extra = extraRaw.map((v,i) => Number.isFinite(v) ? f32(Math.max(-10,Math.min(10,(f32(v)-norm.t0stats.mean[i])/norm.t0stats.std[i]))) : 0);
  extra.push(...extraRaw.slice(6).map(v => +Number.isFinite(v)));
  const record = {events:trajectories.map(t => [...t].sort((a,b) => a[0]-b[0])), extra, duration:f32(Math.min((c.t0-c.admission)/HOUR,24))};
  return {...fromRecord(record), record, case:c};
}

export function fromRecord(record) {
  const {events, extra} = record;
  let times = [...new Set(events.flatMap(t => t.map(x => x[0])))].sort((a,b) => a-b);
  if (!times.length) times = [END];
  const duration = record.duration;
  const summary = new Float32Array(232);
  for (let j=0;j<29;j++) {
    const list=events[j], n=list.length;
    if (j<18) {
      if (n) {
        summary[j]=list.at(-1)[1];summary[18+j]=Math.min(...list.map(x => x[1]));summary[36+j]=Math.max(...list.map(x => x[1]));summary[90+j]=1;
        if (n>=2) { const elapsed=f32(list.at(-1)[0]-list[0][0]);if(elapsed>0){summary[54+j]=f32(list.at(-1)[1]-list[0][1]);summary[72+j]=summary[54+j]/elapsed;summary[108+j]=1;} }
      }
      summary[126+j]=f32(Math.log1p(f32(n)));summary[144+j]=f32(n ? Math.max(24-list.at(-1)[0],0) : duration)/24;
    } else if(n) {summary[162+j-18]=list.at(-1)[1];summary[173+j-18]=1;}
  }
  summary[184]=duration/24;summary[185]=events.slice(22,28).filter(t => t.length).length/6;
  summary.set(extra,186);
  // The actual model uses only genuine within-variable observation pairs.
  // Keep the exported pair axis aligned to the full enhanced time sequence.
  if (Math.abs(times.at(-1)-END)>1e-5) times.push(END);
  const count=Math.max(2,times.length)-1;
  const delta=new Float32Array(18*count),pair_mask=new Uint8Array(18*count);
  for(let j=0;j<18;j++) {
    const list=events[j], latest=list.at(-1);
    for(let k=0;k<list.length-1;k++) {
      if(f32(f32(list[k+1][0]/24)-f32(list[k][0]/24))>1e-7) {delta[j*count+k]=f32(latest[1]-list[k][1]);pair_mask[j*count+k]=1;}
    }
  }
  return {summary,delta,pair_mask,count};
}

export function hybrid(patient, background, coalition, groups) {
  const events=Array(29),extra=Array(46);
  groups.forEach((g,i) => {const src=coalition[i]?patient:background;g.raw.forEach(j=>events[j]=src.events[j]);g.extra.forEach(j=>extra[j]=src.extra[j]);});
  const available=events.flatMap(x=>x.map(v=>v[0]));
  const duration=Math.min(24,Math.max((coalition[53]?patient:background).duration,24-(available.length?Math.min(...available):END)));
  return fromRecord({events,extra,duration:f32(duration)});
}

export function curves(logits,horizon) {
  let survival=1,death=0,transplant=0;
  const death_curve=[0],transplant_curve=[0],event_free_curve=[1];
  for(let d=0;d<horizon;d++) {
    const z=Array.from(logits.slice(d*3,d*3+3)),max=Math.max(...z),a=z.map(v=>Math.exp(v-max)),sum=a.reduce((x,y)=>x+y,0);
    death+=survival*a[1]/sum;transplant+=survival*a[2]/sum;survival*=a[0]/sum;
    death_curve.push(death);transplant_curve.push(transplant);event_free_curve.push(survival);
  }
  return {horizon,death,transplant,event_free:survival,days:Array.from({length:horizon+1},(_,i)=>i),death_curve,transplant_curve,event_free_curve};
}
