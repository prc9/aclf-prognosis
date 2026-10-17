// Pinned BERT BasicTokenizer + WordPiece contract, tested against both saved tokenizers.
const special=['[UNK]','[SEP]','[PAD]','[CLS]','[MASK]'];
const white=c=>c===' '||c==='\n'||c==='\r'||c==='\t'||/\p{Zs}/u.test(c);
const control=c=>!['\t','\n','\r'].includes(c)&&/[\p{Cc}\p{Cf}]/u.test(c);
const punctuation=c=>{const n=c.codePointAt(0);return n>=33&&n<=47||n>=58&&n<=64||n>=91&&n<=96||n>=123&&n<=126||/\p{P}/u.test(c);};
const chinese=n=>n>=0x4e00&&n<=0x9fff||n>=0x3400&&n<=0x4dbf||n>=0x20000&&n<=0x2a6df||n>=0x2a700&&n<=0x2b73f||n>=0x2b740&&n<=0x2b81f||n>=0x2b820&&n<=0x2ceaf||n>=0xf900&&n<=0xfaff||n>=0x2f800&&n<=0x2fa1f;
export class BertTokenizer {
 constructor(config){this.vocab=config.vocab;this.ids=new Map(this.vocab.map((s,i)=>[s,i]));this.lower=config.lower_case;this.cls=this.ids.get('[CLS]');this.sep=this.ids.get('[SEP]');this.pad=this.ids.get('[PAD]');}
 pieces(text){
  const result=[];
  for(const segment of text.split(/(\[UNK\]|\[SEP\]|\[PAD\]|\[CLS\]|\[MASK\])/)) {
   if(!segment)continue;
   if(special.includes(segment)){result.push(this.ids.get(segment));continue;}
   let clean='';
   for(const c of segment){const n=c.codePointAt(0);if(n===0||n===0xfffd||control(c))continue;clean+=white(c)?' ':chinese(n)?' '+c+' ':c;}
   for(let token of clean.trim().split(/\s+/).filter(Boolean)){
    if(this.lower)token=token.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu,'');
    let parts=[],word='';
    for(const c of token){if(punctuation(c)){if(word)parts.push(word);word='';parts.push(c);}else word+=c;}
    if(word)parts.push(word);
    for(const part of parts){
     const chars=[...part];if(chars.length>100){result.push(this.ids.get('[UNK]'));continue;}
     let start=0,sub=[],bad=false;
     while(start<chars.length){let end=chars.length,id;
      while(end>start){const text=(start?'##':'')+chars.slice(start,end).join('');if(this.ids.has(text)){id=this.ids.get(text);break;}end--;}
      if(id===undefined){bad=true;break;}sub.push(id);start=end;
     }
     result.push(...(bad?[this.ids.get('[UNK]')]:sub));
    }
   }
  }
  return result;
 }
 chunks(text,maxLength=256,overlap=32){
  const pieces=this.pieces(text),size=maxLength-2,out=[];
  if(!pieces.length)return [[this.cls,this.sep]];
  for(let start=0;;start+=size-overlap){const body=pieces.slice(start,start+size);out.push([this.cls,...body,this.sep]);if(start+size>=pieces.length)break;}
  return out;
 }
 words(tokens){
  const pieces=[],offsets=[];
  for(const word of tokens){const p=this.pieces(word);offsets.push(p.length?[pieces.length+1,pieces.length+p.length]:[-1,-1]);pieces.push(...p);}
  return {pieces,offsets};
 }
}

export function radgraphWords(text){
 text=text.replaceAll('\\n','  ').replaceAll('\\f','  ').replaceAll('\\u2122','      ').replaceAll('\n',' ').replaceAll('\\"','``').replace(/\s+/g,' ');
 let tokenized=(text.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]+/gu)||[]).join(' ');
 for(const [a,b]of [[').',') .'],['%.','% .'],[".'",". '"],['%,','% ,'],['%)','% )']])tokenized=tokenized.replaceAll(a,b);
 return tokenized.trim()?tokenized.trim().split(/\s+/):[];
}

export function findingSentences(text){
 const pattern=/^\s*(EXAMINATION|EXAM|HISTORY|INDICATION|CLINICAL HISTORY|REASON FOR EXAM|REASON FOR STUDY|COMPARISON|TECHNIQUE|FINDINGS|IMPRESSION|CONCLUSION|RECOMMENDATION|ADDENDUM)\s*:\s*/gim;
 const matches=[...text.matchAll(pattern)],spans=[],out=[];
 if(!matches.length)spans.push(['BODY',text]);
 else matches.forEach((m,i)=>{const section=m[1].toUpperCase(),body=text.slice(m.index+m[0].length,i+1<matches.length?matches[i+1].index:text.length);
  if(['FINDINGS','IMPRESSION','CONCLUSION'].includes(section))spans.push([section,body]);
  else if(['HISTORY','INDICATION','REASON FOR EXAM','REASON FOR STUDY','CLINICAL HISTORY'].includes(section)){
   const paragraphs=body.trim().split(/\n\s*\n/);if(paragraphs.length>1)spans.push(['BODY',paragraphs.slice(1).join('\n\n')]);
  }
 });
 for(let[section,body]of spans){body=body.split(/^\s*(?:Electronically signed|Dictated by|FINAL REPORT)/im)[0];
  for(let sentence of body.split(/(?<=[.!?;])\s+|\n\s*\n/)){sentence=sentence.replace(/\s+/g,' ').trim();if(sentence)out.push({section,sentence});}
 }
 return out;
}
