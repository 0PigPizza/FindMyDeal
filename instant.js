const filters=require('./deal-filters');
const instantSettings=require('./instant-settings');
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
  const {searchTerm,aiRequest,marketplaces,requestId,additionalSettings:rawAdditionalSettings}=req.body||{};
  const additionalSettings=rawAdditionalSettings??{};
  const settingsError=instantSettings.validate(additionalSettings);if(settingsError)return res.status(400).json({error:settingsError});
  if(requestId!==undefined&&(typeof requestId!=='string'||!/^[0-9a-f-]{36}$/.test(requestId)))return res.status(400).json({error:'Invalid request ID.'});
  if(requestId&&state.requestId===requestId)return res.json(state);
  const aiMode=typeof aiRequest==='string'&&!!aiRequest.trim();
  if((aiMode?(aiRequest.trim().length>2000):(typeof searchTerm!=='string'||!searchTerm.trim()||searchTerm.trim().length>150))||!Array.isArray(marketplaces)||!marketplaces.length||new Set(marketplaces).size!==marketplaces.length||marketplaces.some(x=>!names[x]))return res.status(400).json({error:'Enter a valid search and choose at least one marketplace.'});
  if(['planning','searching','reviewing'].includes(state.status))return res.status(409).json({error:'An instant search is already running.'});
  const settings=ai.getSettings();if(aiMode&&(!settings.enabled||!settings.apiKey))return res.status(400).json({error:'Enable AI reviews and add an OpenRouter API key in AI to use an AI search.'});
  state={...(requestId?{requestId}:{}),status:aiMode?'planning':'searching',searchTerm:aiMode?'':searchTerm.trim(),items:[],errors:[],sources:marketplaces.map(name=>({name,status:'waiting',count:0})),review:{completed:0,total:0},analysisStatus:'waiting'};res.status(202).json(state);
  const result=state;
  void run(result,marketplaces,aiMode?aiRequest.trim():'',settings,additionalSettings).catch(e=>{result.errors.push(e.message);result.status='done';});
 });
 async function run(result,marketplaces,request,settings,additionalSettings){
  if(request){try{result.plan=await ai.planInstant(request,settings);result.searchTerm=result.plan.searchTerm;}catch(e){result.errors.push(`AI search: ${e.message}`);result.status='done';return;}}
  const inferred=result.plan||{minPrice:null,maxPrice:null,filters:filters.parse()};
  const plan={...inferred,...additionalSettings,filters:{...filters.parse(inferred.filters),...additionalSettings.filters}};
  if(plan.minPrice!=null&&plan.maxPrice!=null&&plan.minPrice>plan.maxPrice){result.errors.push('Minimum price cannot exceed maximum price.');result.status='done';return;}
  result.appliedSettings={minPrice:plan.minPrice,maxPrice:plan.maxPrice,maxDistance:plan.maxDistance??null,sortBy:plan.sortBy??'suggested',maxItems:plan.maxItems??10,filters:plan.filters};
  const monitor={search_term:result.searchTerm,min_price:plan.minPrice,max_price:plan.maxPrice,max_distance:plan.maxDistance??null,sort_by:plan.sortBy??'suggested',max_items:plan.maxItems??10};
  const running=getWorker();result.status='searching';let paused=false;
  try{
   await running.pause();paused=true;
   await Promise.all(marketplaces.map(async name=>{const source=names[name],progress=result.sources.find(x=>x.name===name);let acquired=false;progress.status='searching';
    try{
     acquired=profiles.tryAcquire(source);if(!acquired)throw Error('Browser profile is in use. Close the source browser and try again.');
     const found=await worker.runScript(source,worker.settingsFor(monitor,source),()=>{});
     if(found.warning)result.errors.push(`${name}: ${found.warning}`);
     for(const item of found){if(!item||typeof item.title!=='string'||typeof item.url!=='string')continue;let url;try{url=new URL(item.url);}catch{continue;}const allowed={kijiji:['kijiji.ca','www.kijiji.ca'],ebay:['ebay.ca','www.ebay.ca','ebay.com','www.ebay.com'],facebook:['facebook.com','www.facebook.com']};if(url.protocol!=='https:'||!allowed[source].includes(url.hostname))continue;const listing={id:result.items.length+1,source,title:item.title.slice(0,5000),url:url.href,price:typeof item.price==='string'?item.price.slice(0,255):null,description:typeof item.description==='string'?item.description.slice(0,500000):null,item_condition:typeof item.item_condition==='string'?item.item_condition.slice(0,255):null,has_image:!!item.image_url};const amount=price(listing.price);if(plan.filters&&!filters.matches(listing,plan.filters))continue;if((plan.minPrice!==null||plan.maxPrice!==null)&&(amount===null||(plan.minPrice!==null&&amount<plan.minPrice)||(plan.maxPrice!==null&&amount>plan.maxPrice)))continue;result.items.push(listing);}
     progress.count=result.items.filter(item=>item.source===source).length;progress.status=found.warning?'warning':'done';
    }catch(e){progress.status='error';result.errors.push(`${name}: ${e.message}`);}finally{if(acquired)profiles.release(source);}
   }));
   result.statistics=stats(result.items);result.status='reviewing';
   if(!settings.enabled||!settings.apiKey){result.errors.push('Enable AI reviews and add an OpenRouter API key in AI to analyze deals.');result.status='done';return;}
   const rows=result.items.map(item=>({...item,deal_id:item.id,search_term:result.searchTerm,marketplaces:JSON.stringify(marketplaces),min_price:plan.minPrice,max_price:plan.maxPrice,max_distance:monitor.max_distance,sort_by:monitor.sort_by,max_items:monitor.max_items,interval_seconds:0,filter_options:JSON.stringify(plan.filters),monitor_prompt:[request,plan.aiPrompt].filter(Boolean).join('\n'),item_prompt:''}));
   result.items=rows;result.review.total=rows.length;let next=0;
   async function review(){while(next<rows.length){const batch=rows.slice(next,next+5);next+=5;try{const decisions=await ai.reviewBatch(batch,settings);for(const row of batch){const decision=decisions.get(row.id);row.ai_deal=decision.deal;row.ai_reason=decision.reason;}}catch(e){result.errors.push(`AI review: ${e.message}`);}finally{result.review.completed+=batch.length;result.topDeals=rows.filter(x=>x.ai_deal).sort((a,b)=>(price(a.price)??Infinity)-(price(b.price)??Infinity)).slice(0,5);}}}
   result.analysisStatus='working';const analysis=rows.length?ai.marketAnalysis(rows,settings,result.searchTerm,result.statistics).then(value=>{result.analysis=value;result.analysisStatus='done';},e=>{result.errors.push(`Market analysis: ${e.message}`);result.analysisStatus='error';}):Promise.resolve().then(()=>{result.analysisStatus='done';});
   await Promise.all([analysis,...Array.from({length:Math.min(3,Math.ceil(rows.length/5))},()=>review())]);
   result.status='done';
  }finally{if(paused)running.resume();}
 }
};
module.exports.price=price;module.exports.stats=stats;
