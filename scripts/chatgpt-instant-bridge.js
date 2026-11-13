// Outbound-only bridge between the private ChatGPT relay and the local Instant API.
const site=process.env.FMD_RELAY_URL,siteToken=process.env.FMD_SITE_TOKEN,bridgeToken=process.env.FMD_BRIDGE_TOKEN,local=process.env.FMD_LOCAL_URL||'http://127.0.0.1:3000';
if(!site||!siteToken||!bridgeToken)throw Error('Missing relay configuration.');
const relay=new URL(site),localUrl=new URL(local),net=require('net');
const host=localUrl.hostname,octets=host.split('.').map(Number),privateIPv4=net.isIP(host)===4&&(octets[0]===127||octets[0]===10||(octets[0]===192&&octets[1]===168)||(octets[0]===172&&octets[1]>=16&&octets[1]<=31));
if(relay.protocol!=='https:'||localUrl.protocol!=='http:'||!(host==='localhost'||privateIPv4))throw Error('Invalid relay or local URL.');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function relayRequest(path,method='GET',data){const response=await fetch(new URL(path,relay),{method,headers:{'OAI-Sites-Authorization':`Bearer ${siteToken}`,'x-findmydeal-bridge-token':bridgeToken,...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error(`Relay returned HTTP ${response.status}`);return response.json();}
async function appRequest(method='GET',data){const response=await fetch(new URL('/api/instant',localUrl),{method,headers:data?{'content-type':'application/json'}:{},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(15000)});const body=await response.json();if(!response.ok){const error=Error(body.error||`FindMyDeal returned HTTP ${response.status}`);error.status=response.status;throw error;}return body;}
function summary(state){const items=(state.items||[]).map(item=>({id:item.id,source:item.source,title:item.title,price:item.price,url:item.url,item_condition:item.item_condition,ai_deal:item.ai_deal,ai_reason:item.ai_reason,description:typeof item.description==='string'?item.description.slice(0,1000):null}));const deals=(state.topDeals||[]).map(item=>({id:item.id,source:item.source,title:item.title,price:item.price,url:item.url,ai_reason:item.ai_reason}));return {status:state.status,searchTerm:state.searchTerm,plan:state.plan,sources:state.sources,review:state.review,analysisStatus:state.analysisStatus,statistics:state.statistics,analysis:state.analysis,items,topDeals:deals,errors:state.errors,updatedAt:Date.now()};}
async function runJob(job){
 const id=job.id;
 await relayRequest('/bridge/update','POST',{id,result:{status:'starting',updatedAt:Date.now()}});
 const request={requestId:id,marketplaces:job.marketplaces,...(job.mode==='ai'?{aiRequest:job.search}:{searchTerm:job.search})};
 let state;
 try{state=await appRequest('POST',request);}catch(e){
  // A failed request may still have reached the app. Retry the same ID on the next tick.
  if(e.status>=400&&e.status<500&&e.status!==409){await relayRequest('/bridge/update','POST',{id,claimed:true,result:{status:'error',errors:[String(e.message).slice(0,300)],updatedAt:Date.now()}});return;}
  console.error(`Instant bridge: ${e.message}`);return;
 }
 const deadline=Date.now()+20*60*1000;
 while(true){
  await relayRequest('/bridge/update','POST',{id,claimed:state.status==='done',result:summary(state)});
  if(state.status==='done')return;
  if(Date.now()>deadline){await relayRequest('/bridge/update','POST',{id,claimed:true,result:{status:'error',errors:['Search timed out. Check FindMyDeal for its status.'],updatedAt:Date.now()}});return;}
  await sleep(2000);
  state=await appRequest();
  if(state.requestId!==id)throw Error('Instant search changed; retrying the queued request.');
 }
}
let running=false,stopped=false;
async function tick(){if(running||stopped)return;running=true;try{await relayRequest('/bridge/heartbeat','POST',{});const {job}=await relayRequest('/bridge/next');if(job)await runJob(job);}catch(e){console.error(`Instant bridge: ${e.message}`);}finally{running=false;}}
const heartbeat=setInterval(()=>relayRequest('/bridge/heartbeat','POST',{}).catch(e=>console.error(`Instant bridge heartbeat: ${e.message}`)),10000);
const timer=setInterval(tick,3000);tick();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopped=true;clearInterval(timer);clearInterval(heartbeat);process.exit(0);});
