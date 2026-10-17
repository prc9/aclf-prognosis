// Port of cr_radgraph_facts.events_from_graph; graph edges come from RadGraph-XL.
const concepts=['cirrhosis','ascites','splenomegaly','portal_hypertension','varices_collaterals','portal_vein_thrombosis','liver_lesion','biliary_dilation','consolidation_pneumonia','pulmonary_edema','pleural_effusion','atelectasis'];
function incoming(start,entities){const found=new Set(),pending=[String(start)];while(pending.length){const target=pending.pop();for(const[key,e]of Object.entries(entities))if(!found.has(key)&&key!==String(start)&&(e.relations||[]).some(([r,t])=>r==='modify'&&String(t)===target)){found.add(key);pending.push(key);}}return found;}
function concept(root,linked){root=root.toLowerCase();linked=linked.toLowerCase();
 if(/\bcirrho\w*\b/.test(root))return 'cirrhosis';if(/\bascites\b/.test(root))return 'ascites';if(/\bfluid\b/.test(root)&&/peritone|perihepatic|intraabdominal/.test(linked))return 'ascites';
 if(root.includes('splenomegaly')||/enlarg|increas.*size/.test(root)&&/spleen|splenic/.test(linked))return 'splenomegaly';
 if(/hypertension/.test(root)&&linked.includes('portal'))return 'portal_hypertension';if(/\bvaric(?:es|eal)|\bcollaterals?\b/.test(root))return 'varices_collaterals';
 if(/thromb|\bPVT\b/i.test(root)&&(linked.includes('portal')||root==='pvt'))return 'portal_vein_thrombosis';
 if(root.includes('hepatocellular carcinoma')||/\blesions?|\bmass(?:es)?\b|\bnodules?\b/.test(root)&&/hepatic|liver/.test(linked))return 'liver_lesion';
 if(/dilat/.test(root)&&/biliar|bile|duct/.test(linked))return 'biliary_dilation';if(/consolidat|pneumonia/.test(root))return 'consolidation_pneumonia';
 if(/edema|oedema/.test(root)&&/pulmonary|interstitial|lung/.test(linked))return 'pulmonary_edema';
 if(/effusion/.test(root)&&/pleur|lung|hemithor|costophren|bilateral|left|right/.test(linked))return 'pleural_effusion';if(/atelecta/.test(root))return 'atelectasis';return null;
}
export function eventsFromGraph(annotation,section='BODY',sentence=null){
 const entities=annotation.entities||{},tokens=(annotation.text||'').split(/\s+/),result=[];
 for(const[key,root]of Object.entries(entities)){
  if(!root.label?.startsWith('Observation')||(root.relations||[]).some(([r])=>r==='modify'))continue;
  const modifiers=incoming(key,entities),anatomy=new Set();
  for(const id of [key,...modifiers])for(const[r,t]of entities[id].relations||[])if(r==='located_at'&&entities[String(t)])anatomy.add(String(t));
  for(const id of [...anatomy])for(const n of incoming(id,entities))anatomy.add(n);
  const modifierTexts=[...modifiers].sort().map(k=>entities[k].tokens),anatomyTexts=[...anatomy].sort().map(k=>entities[k].tokens),finding=root.tokens;
  const c=concept(finding,[finding,...modifierTexts,...anatomyTexts].join(' '));if(!c)continue;
  let state=root.label.toLowerCase().includes('absent')?2:root.label.toLowerCase().includes('uncertain')?3:1;
  const prefix=tokens.slice(Math.max(0,root.start_ix-8),root.start_ix).join(' ').toLowerCase()+' ';
  const historical=/\b(?:history of|previously seen|previously identified|previously noted)\s+(?:\w+\s+){0,3}$/.test(prefix);
  const excluded=/\b(?:evaluate|assess|investigate|rule out|screen)\s+(?:for\s+)?(?:\w+\s+){0,3}$/.test(prefix);
  const qualified=/\bno\s+(?:large|significant|overt|definite|obvious)\s+(?:\w+\s+){0,2}$/.test(prefix);
  if(qualified)state=3;if(historical||excluded)state=0;
  const degrees=new Set(),trends=new Set(),trendNodes=[...modifiers].filter(k=>/increas|decreas|improv|worsen|progress|resolv|stable|unchang|new|similar|persist/i.test(entities[k].tokens)),degreeOfChange=new Set();
  for(const id of trendNodes)for(const m of incoming(id,entities))degreeOfChange.add(m);
  for(const id of modifiers){const e=entities[id],text=e.tokens.toLowerCase(),label=(e.label||'').toLowerCase();
   if(/absent|uncertain/.test(label)||degreeOfChange.has(id)||/increas|decreas|improv|worsen|progress/.test(text))continue;
   if(/\b(?:mild|small|moderate|large|severe)\s*-?\s*to\s*-?\s*(?:mild|small|moderate|large|severe)\b/.test(text)){degrees.add(1);degrees.add(3);continue;}
   for(const word of text.match(/\b(?:trace|minimal|mild|small|slight|moderate|moderately|large|marked|severe|extensive|massive)\b/g)||[])degrees.add(['trace','minimal','mild','small','slight'].includes(word)?1:['moderate','moderately'].includes(word)?2:3);
  }
  for(const id of trendNodes){const e=entities[id],v=e.tokens.toLowerCase();if((e.label||'').toLowerCase().includes('absent'))continue;
   if(/no\s+(?:interval\s+)?change|unchang|stable|similar|persist/.test(v))trends.add(4);
   else if(/no\s+(?:increase|worsen)|not\s+(?:increas|worsen)/.test(v))continue;
   else if(/decreas|improv|reduc|resolv|resolution/.test(v))trends.add(3);
   else if(/increas|worsen|progress/.test(v))trends.add(2);
   else if(/\bnew\b|newly|developed/.test(v))trends.add(1);
  }
  const severity=degrees.size===1&&[1,3].includes(state)&&!qualified?[...degrees][0]:0;
  let change=trends.size===1&&state>0&&!qualified?[...trends][0]:0;if(state===2&&change!==3)change=0;
  const sideText=[...anatomyTexts,...modifierTexts].join(' ').toLowerCase(),side=/bilateral|bibasilar/.test(sideText)||sideText.includes('left')&&sideText.includes('right')?3:sideText.includes('left')?1:sideText.includes('right')?2:0;
  const vector=Array(41).fill(0);vector[concepts.indexOf(c)]=1;vector[12+state]=1;vector[16+severity]=1;vector[20+change]=1;vector[25+side]=1;
  const anatomical=anatomyTexts.join(' '),patterns=[/liver|hepatic/i,/peritone|ascites|perihepatic/i,/spleen|splenic/i,/portal/i,/biliar|bile|duct/i,/pulmonary|lung|lobe|basilar/i,/pleur|hemithor|costophren/i,/vein|vascular|arter|venous/i];
  patterns.forEach((p,i)=>{if(p.test(anatomical))vector[30+i]=1;});if(!vector.slice(29,39).some(Boolean))vector[29+(anatomical.trim()?9:0)]=1;
  vector[39]=+historical;vector[40]=+qualified;
  result.push({concept:c,state,severity,change,usable:state>0&&!qualified,vector,section,sentence:sentence||annotation.text,root_text:finding});
 }
 return result;
}
