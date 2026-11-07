const names={'Kijiji':'kijiji','eBay':'ebay','Facebook Marketplace':'facebook'};
function price(value){
  if(typeof value!=='string')return null;
  if(/^free$/i.test(value.trim()))return 0;
  const match=value.trim().match(/^(?:CA\s*\$|C\s*\$|CAD\s*\$?|\$)\s*([\d,]+(?:\.\d{1,2})?)(?:\s*\(approx\.; US \$[\d,.]+, \d{4}-\d{2}-\d{2} rate\))?$/i);
  if(!match)return null;
  const n=Number(match[1].replace(/,/g,''));return Number.isFinite(n)?n:null;
}
function stats(items){const values=items.map(i=>price(i.price)).filter(n=>n!==null).sort((a,b)=>a-b);if(!values.length)return null;const mid=Math.floor(values.length/2);return {cheapest:values[0],median:values.length%2?values[mid]:(values[mid-1]+values[mid])/2,highest:values.at(-1),count:values.length};}
module.exports=function(app,{worker,ai,profiles,getWorker}){
 let state={status:'idle'};
 app.get('/api/instant',(req,res)=>res.json(state));
 app.post('/api/instant',(req,res)=>{
  const {searchTerm,marketplaces}=req.body||{};
  if(typeof searchTerm!=='string'||!searchTerm.trim()||searchTerm.trim().length>150||!Array.isArray(marketplaces)||!marketplaces.length||new Set(marketplaces).size!==marketplaces.length||marketplaces.some(x=>!names[x]))return res.status(400).json({error:'Enter a search term and choose at least one marketplace.'});
  if(['searching','reviewing'].includes(state.status))return res.status(409).json({error:'An instant search is already running.'});
  state={status:'searching',searchTerm:searchTerm.trim(),items:[],errors:[]};res.status(202).json(state);
  const result=state;
  void run(result,marketplaces).catch(e=>{result.errors.push(e.message);result.status='done';}).finally(()=>getWorker().resume());
 });
 async function run(result,marketplaces){
  const monitor={search_term:result.searchTerm,min_price:null,max_price:null,max_distance:null,sort_by:'suggested',max_items:30};
  const running=getWorker();
  try{
   await running.pause();
   await Promise.all(marketplaces.map(async name=>{const source=names[name];let acquired=false;
    try{
     // Cancelled monitor processes must release their profiles before the instant search starts.
     acquired=profiles.tryAcquire(source);if(!acquired)throw Error('Browser profile is in use. Close the source browser and try again.');
     const found=await worker.runScript(source,worker.settingsFor(monitor,source),()=>{});
     if(found.warning)result.errors.push(`${name}: ${found.warning}`);
     for(const item of found){if(!item||typeof item.title!=='string'||typeof item.url!=='string')continue;let url;try{url=new URL(item.url);}catch{continue;}const allowed={kijiji:['kijiji.ca','www.kijiji.ca'],ebay:['ebay.ca','www.ebay.ca','ebay.com','www.ebay.com'],facebook:['facebook.com','www.facebook.com']};if(url.protocol!=='https:'||!allowed[source].includes(url.hostname))continue;result.items.push({id:result.items.length+1,source,title:item.title.slice(0,5000),url:url.href,price:typeof item.price==='string'?item.price.slice(0,255):null,description:typeof item.description==='string'?item.description.slice(0,500000):null,item_condition:item.item_condition||null});}
    }catch(e){result.errors.push(`${name}: ${e.message}`);}finally{if(acquired)profiles.release(source);}
   }));
  }catch(e){result.errors.push(e.message);}
  result.statistics=stats(result.items);result.status='reviewing';
  const settings=ai.getSettings();
  if(!settings.enabled||!settings.apiKey){result.errors.push('Enable AI reviews and add an OpenRouter API key in AI to analyze deals.');result.status='done';return;}
  const rows=result.items.map(item=>({...item,deal_id:item.id,search_term:result.searchTerm,marketplaces:JSON.stringify(marketplaces),min_price:null,max_price:null,max_distance:null,sort_by:'suggested',max_items:30,interval_seconds:0,filter_options:null,monitor_prompt:'',item_prompt:''}));
  for(let i=0;i<rows.length;i+=5){try{const batch=rows.slice(i,i+5),decisions=await ai.reviewBatch(batch,settings);for(const row of batch){const decision=decisions.get(row.id);row.ai_deal=decision.deal;row.ai_reason=decision.reason;}}catch(e){result.errors.push(`AI review: ${e.message}`);}}
  result.items=rows;result.topDeals=rows.filter(x=>x.ai_deal).sort((a,b)=>(price(a.price)??Infinity)-(price(b.price)??Infinity)).slice(0,5);
  try{result.analysis=await ai.marketAnalysis(rows,settings,result.searchTerm,result.statistics);}catch(e){result.errors.push(`Market analysis: ${e.message}`);}
  result.status='done';
 }
};
module.exports.price=price;module.exports.stats=stats;
