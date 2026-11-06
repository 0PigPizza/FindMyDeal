const defaults={include:'',exclude:'',match:'all',scope:'title',condition:'any',requirePrice:false,requirePhoto:false};
function parse(value){try{return {...defaults,...(typeof value==='string'?JSON.parse(value):value || {})};}catch{return {...defaults};}}
function validate(value){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value))return 'Invalid listing filters.';
  const f=parse(value);
  if(['include','exclude'].some(k=>typeof f[k]!=='string'||f[k].length>500))return 'Keyword filters must be 500 characters or less.';
  if(!['all','any'].includes(f.match)||!['title','both'].includes(f.scope)||!['any','new','used','refurbished'].includes(f.condition)||typeof f.requirePrice!=='boolean'||typeof f.requirePhoto!=='boolean')return 'Choose valid listing filters.';
  return null;
}
function normalizeCondition(value){const s=String(value||'').trim().toLowerCase();if(/refurbish/.test(s))return 'refurbished';if(/\b(pre-owned|preowned|used|open box|open-box|like new)\b/.test(s))return 'used';if(/\bnew\b/.test(s))return 'new';return null;}
function matches(deal,options){
 const f=parse(options),terms=s=>s.split(',').map(x=>x.trim().toLocaleLowerCase()).filter(Boolean);
 const text=(String(deal.title||'')+(f.scope==='both'?'\n'+String(deal.description||''):'')).toLocaleLowerCase();
 const included=terms(f.include),excluded=terms(f.exclude);
 if(included.length && !(f.match==='any'?included.some(x=>text.includes(x)):included.every(x=>text.includes(x))))return false;
 if(excluded.some(x=>text.includes(x)))return false;
 if(f.condition!=='any'&&normalizeCondition(deal.item_condition)!==f.condition)return false;
 if(f.requirePrice&&!/(?:\d|\bfree\b)/i.test(deal.price||''))return false;
 if(f.requirePhoto&&!deal.has_image)return false;
 return true;
}
module.exports={defaults,parse,validate,matches};
