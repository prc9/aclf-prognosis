import * as ort from './runtime/ort.wasm.min.mjs';
import {curves} from './features.mjs';
ort.env.wasm.wasmPaths=new URL('./runtime/',import.meta.url).href;
// One WASM thread also works on ordinary static hosts without COOP/COEP.
ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
export class BrowserEngine {
  constructor(){this.sessions={};}
  async load(){
    const response=await fetch(new URL('./assets/manifest.json',import.meta.url));
    if(!response.ok)throw Error('Model manifest is unavailable.');
    this.manifest=await response.json();
    for(const h of [28,90]) {
      const response=await fetch(new URL(`./assets/risk-${h}.onnx`,import.meta.url));
      if(!response.ok)throw Error('Model download failed.');
      const bytes=await response.arrayBuffer();
      const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
      if(sha!==this.manifest.models[h].onnx_sha256)throw Error('Model integrity check failed.');
      this.sessions[h]=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    }
    return this.manifest;
  }
  async run(h,prepared,report){
    const feeds={summary:new ort.Tensor('float32',prepared.summary,[1,232]),delta:new ort.Tensor('float32',prepared.delta,[1,18,prepared.count]),
      pair_mask:new ort.Tensor('bool',prepared.pair_mask,[1,18,prepared.count]),notes:new ort.Tensor('float32',new Float32Array(5*768),[1,5,768]),
      note_mask:new ort.Tensor('bool',new Uint8Array(5),[1,5]),events:new ort.Tensor('float32',new Float32Array(5*41),[1,5,1,41]),event_mask:new ort.Tensor('bool',new Uint8Array(5),[1,5,1])};
    if(report){
      feeds.notes=new ort.Tensor('float32',report.notes,[1,5,768]);feeds.note_mask=new ort.Tensor('bool',report.note_mask,[1,5]);
      feeds.events=new ort.Tensor('float32',report.events,[1,5,report.event_count,41]);feeds.event_mask=new ort.Tensor('bool',report.event_mask,[1,5,report.event_count]);
    }
    const output=await this.sessions[h].run(feeds),logits=Float32Array.from(output.logits.data);
    output.logits.dispose();
    if(!logits.every(Number.isFinite))throw Error('Nonfinite model output.');
    const result=curves(logits,h);
    if(Math.abs(result.death+result.transplant+result.event_free-1)>2e-5)throw Error('Invalid competing-risk distribution.');
    return {logits,result};
  }
  async encoded(h,inputs){
    const feeds=Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,new ort.Tensor(v.type,v.type==='bool'?Uint8Array.from(v.data,Number):Float32Array.from(v.data),v.shape)]));
    const out=await this.sessions[h].run(feeds);return Array.from(out.logits.data);
  }
}
