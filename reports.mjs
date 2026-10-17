import * as ort from './runtime/ort.wasm.min.mjs';
import {BertTokenizer,radgraphWords,findingSentences} from './tokenizer.mjs';
import {eventsFromGraph} from './report-facts.mjs';
const json=async url=>{const r=await fetch(url);if(!r.ok)throw Error('Report asset unavailable: '+url);return r.json();};
const argmaxReal=scores=>{let best=-1,score=0;for(let i=0;i<scores.length;i++)if(scores[i]>score){score=scores[i];best=i;}return best;};
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
const tensor=(array,shape)=>new ort.Tensor('float32',array,shape);
const idsTensor=ids=>new ort.Tensor('int64',BigInt64Array.from(ids,BigInt),[1,ids.length]);
function boundedSet(map,key,value,max){map.set(key,value);while(map.size>max)map.delete(map.keys().next().value);}

export class ReportPipeline {
 constructor(progress=()=>{}){this.progress=progress;this.notes=new Map();this.graphs=new Map();this.heads={};this.stats={models_loaded:[],cache_hits:0,cache_errors:[]};}
 async init(){
  this.base=new URL('./assets/reports/',import.meta.url);
  this.manifest=await json(new URL('manifest.json',this.base));
  this.clinical=new BertTokenizer(await json(new URL('clinical-tokenizer.json',this.base)));
  this.radConfig=await json(new URL('radgraph-tokenizer.json',this.base));this.rad=new BertTokenizer(this.radConfig);
  return this.manifest;
 }
 async load(name){
  if(this.manifest.deployment_requires_model_host)throw Error('尚未配置报告模型下载地址，请按发布说明设置 model_base_url。Report model hosting is not configured.');
  const m=this.manifest.models[name];
  const url=new URL(m.url||m.file,this.manifest.model_base_url||this.base).href;
  this.progress({stage:'model',name,bytes:m.bytes});
  // OPFS streams large public model files to disk. Cache.put() failed around
  // 256 MiB in the tested Chromium environment, so never use it for these files.
  let directory,handle,file,bytes;
  try{
   const storage=await navigator.storage.getDirectory();directory=await storage.getDirectoryHandle('aclf-report-models-fp32-v1',{create:true});
   handle=await directory.getFileHandle(m.sha256+'.onnx',{create:true});file=await handle.getFile();
  }catch(e){this.stats.cache_errors.push(String(e));}
  if(file?.size===m.bytes){bytes=await file.arrayBuffer();this.stats.cache_hits++;}
  else {
   let response=await fetch(url);if(!response.ok)throw Error('Report model download failed: '+name);
   if(handle){
    try{const writable=await handle.createWritable();await response.body.pipeTo(writable);bytes=await(await handle.getFile()).arrayBuffer();}
    catch(e){this.stats.cache_errors.push(String(e));console.warn('Model cache unavailable: '+String(e));response=await fetch(url);bytes=await response.arrayBuffer();}
   }else bytes=await response.arrayBuffer();
  }
  if(await sha(bytes)!==m.sha256){if(directory)await directory.removeEntry(m.sha256+'.onnx');throw Error('Report model integrity check failed: '+name);}
  const session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  this.stats.models_loaded.push(name);return session;
 }
 async hidden(session,ids){
  const output=await session.run({ids:idsTensor(ids),attention:new ort.Tensor('int64',new BigInt64Array(ids.length).fill(1n),[1,ids.length])});
  const data=Float32Array.from(output.hidden.data);output.hidden.dispose();return data;
 }
 async encode(h,reports){
  const current=new Map(reports.filter(r=>this.notes.has(h+'|'+r.text)).map(r=>[r.text,this.notes.get(h+'|'+r.text)]));
  const missing=[...new Set(reports.map(r=>r.text))].filter(t=>!this.notes.has(h+'|'+t));
  if(missing.length){
   const session=await this.load('clinical-'+h);
   try{for(let i=0;i<missing.length;i++){
    const text=missing[i],chunks=this.clinical.chunks(text),mean=new Float64Array(768);
    for(let c=0;c<chunks.length;c++){
     this.progress({stage:'clinical',horizon:h,report:i+1,reports:missing.length,chunk:c+1,chunks:chunks.length});
     const ids=chunks[c],hidden=await this.hidden(session,ids),count=Math.max(ids.length-2,1);
     for(let j=0;j<768;j++){let sum=0;for(let t=1;t<ids.length-1;t++)sum+=hidden[t*768+j];mean[j]+=Math.fround(sum/count);}
    }
    const vector=Float32Array.from(mean,x=>x/chunks.length);current.set(text,vector);boundedSet(this.notes,h+'|'+text,vector,64);
   }}finally{await session.release();}
  }
  const notes=new Float32Array(5*768);reports.forEach((r,i)=>notes.set(current.get(r.text),i*768));return notes;
 }
 async graph(sentence,encoder,onWords){
  const words=radgraphWords(sentence),wordpieces=this.rad.words(words);
  if(words.length>this.manifest.max_sentence_words||wordpieces.pieces.length>this.manifest.max_sentence_pieces)throw Error('报告单句过长，浏览器验证版请分句后重试；未自动截断报告。');
  if(!words.length)return {text:'',entities:{},data_source:null,data_split:'inference'};
  const total=wordpieces.pieces.length,full=new Float32Array((total+2)*768);
  // Match AllenNLP's 510-wordpiece folding and unfold offsets without truncation.
  if(!total){const out=await this.hidden(encoder,[this.rad.cls,this.rad.sep]);full.set(out);}
  for(let start=0;start<total;start+=510){
   const part=wordpieces.pieces.slice(start,start+510),ids=[this.rad.cls,...part,this.rad.sep],hidden=await this.hidden(encoder,ids);
   if(start===0)full.set(hidden.subarray(0,768));full.set(hidden.subarray(768,(part.length+1)*768),(start+1)*768);
   if(start+510>=total)full.set(hidden.subarray((part.length+1)*768),(total+1)*768);
  }
  const embeddings=new Float32Array(words.length*768);
  wordpieces.offsets.forEach(([a,b],i)=>{if(a<0)return;for(let d=0;d<768;d++){let sum=0;for(let t=a;t<=b;t++)sum+=full[t*768+d];embeddings[i*768+d]=sum/(b-a+1);}});
  if(onWords)onWords(embeddings);
  const spans=[];for(let a=0;a<words.length;a++)for(let b=a;b<Math.min(a+8,words.length);b++)spans.push([a,b]);
  if(!this.heads.spans)this.heads.spans=await this.load('radgraph-spans');
  if(!this.heads.relations)this.heads.relations=await this.load('radgraph-relations');
  const out=await this.heads.spans.run({words:tensor(embeddings,[words.length,768]),spans:new ort.Tensor('int64',BigInt64Array.from(spans.flat(),BigInt),[spans.length,2])});
  const ner=out.ner.data,mentions=Float32Array.from(out.mention.data),spanEmb=Float32Array.from(out.embeddings.data),entities={},bySpan=new Map();
  for(let i=0;i<spans.length;i++){
   const label=argmaxReal(ner.subarray(i*11,(i+1)*11));if(label<0)continue;
   const[a,b]=spans[i],id=String(Object.keys(entities).length+1);
   entities[id]={tokens:words.slice(a,b+1).join(' '),label:this.radConfig.ner_labels[label+1],start_ix:a,end_ix:b,relations:[]};bySpan.set(a+':'+b,id);
  }
  for(const t of Object.values(out))t.dispose();
  const keep=Math.max(Math.ceil(words.length*.5),1),top=Array.from(mentions,(_,i)=>i).sort((a,b)=>mentions[b]-mentions[a]||a-b).slice(0,keep).sort((a,b)=>a-b);
  const count=top.length*top.length;
  for(let start=0;start<count;start+=256){
   const size=Math.min(256,count-start),left=new Float32Array(size*1556),right=new Float32Array(size*1556),left_score=new Float32Array(size),right_score=new Float32Array(size);
   for(let k=0;k<size;k++){const row=Math.floor((start+k)/top.length),col=(start+k)%top.length,a=top[row],b=top[col];left.set(spanEmb.subarray(a*1556,(a+1)*1556),k*1556);right.set(spanEmb.subarray(b*1556,(b+1)*1556),k*1556);left_score[k]=mentions[a];right_score[k]=mentions[b];}
   const out=await this.heads.relations.run({left:tensor(left,[size,1556]),right:tensor(right,[size,1556]),left_score:tensor(left_score,[size]),right_score:tensor(right_score,[size])});
   for(let k=0;k<size;k++){const label=argmaxReal(out.relations.data.subarray(k*3,(k+1)*3));if(label<0)continue;const a=top[Math.floor((start+k)/top.length)],b=top[(start+k)%top.length],from=bySpan.get(spans[a].join(':')),to=bySpan.get(spans[b].join(':'));if(from&&to)entities[from].relations.push([this.radConfig.relation_labels[label],to]);}
   out.relations.dispose();
  }
  return {text:words.join(' '),entities,data_source:null,data_split:'inference'};
 }
 async facts(reports){
  const needed=[...new Set(reports.flatMap(r=>findingSentences(r.text).map(s=>s.sentence)))];
  if(needed.length>128)throw Error('报告句子过多，请缩短报告后重试；未自动截断。');
  const current=new Map(needed.filter(s=>this.graphs.has(s)).map(s=>[s,this.graphs.get(s)]));
  const missing=needed.filter(s=>!this.graphs.has(s));
  if(missing.length){const session=await this.load('radgraph-encoder');try{
   for(let i=0;i<missing.length;i++){this.progress({stage:'graph',sentence:i+1,sentences:missing.length});const graph=await this.graph(missing[i],session);current.set(missing[i],graph);boundedSet(this.graphs,missing[i],graph,128);}
  }finally{await session.release();}}
  const list=reports.map(r=>findingSentences(r.text).flatMap(({section,sentence})=>eventsFromGraph(current.get(sentence),section,sentence)));
  const count=Math.max(1,...list.map(x=>x.length)),events=new Float32Array(5*count*41),event_mask=new Uint8Array(5*count),note_mask=new Uint8Array(5);
  list.forEach((items,i)=>{note_mask[i]=1;items.forEach((e,j)=>{events.set(e.vector,(i*count+j)*41);event_mask[i*count+j]=+e.usable;});});
  return {events,event_mask,note_mask,event_count:count,evidence:list};
 }
 async analyze(reports){
  if(!reports.length)return {};
  for(const report of reports)for(const {sentence}of findingSentences(report.text)){
   const words=radgraphWords(sentence);if(words.length>this.manifest.max_sentence_words||this.rad.words(words).pieces.length>this.manifest.max_sentence_pieces)throw Error('报告单句过长，请分句后重试；未自动截断报告。');
  }
  const graph=await this.facts(reports),out={};
  for(const h of [28,90])out[h]={...graph,notes:await this.encode(h,reports)};
  this.progress({stage:'done'});return out;
 }
}
