const {test}=require('node:test');const assert=require('node:assert/strict');const {chooseNext,start}=require('../monitor-worker');
test('priority gives 1:2:4 turns without starving low priority',()=>{const rows=['low','normal','high'].map((priority,i)=>({id:i+1,source:'ebay',priority,schedule_pass:null})),counts=[0,0,0];for(let n=0;n<700;n++){const next=chooseNext(rows);counts[next.row.id-1]++;next.row.schedule_pass=next.pass;}assert.ok(counts.every((count,i)=>Math.abs(count-[100,200,400][i])<=1));});
test('multiple sources share a monitor turn and the least recently checked is chosen',()=>{const rows=[{id:1,source:'ebay',priority:'high',schedule_pass:0,last_checked:new Date('2026-01-02')},{id:1,source:'kijiji',priority:'high',schedule_pass:0,last_checked:null},{id:2,source:'ebay',priority:'low',schedule_pass:0,last_checked:null}];const next=chooseNext(rows);assert.equal(next.row.source,'kijiji');assert.equal(next.pass,.25);});
test('different sources run concurrently while each source waits for its own cooldown',async()=>{let release;const starts=[],cooldown=new Set(),wait=new Promise(r=>release=r);const monitors=[{id:1,source:'ebay',marketplaces:'["eBay"]',search_term:'x',priority:'normal',schedule_pass:0,enabled:1,revision:1,sort_by:'suggested',max_items:1},{id:2,source:'ebay',marketplaces:'["eBay"]',search_term:'x',priority:'normal',schedule_pass:0,enabled:1,revision:1,sort_by:'suggested',max_items:1},{id:3,source:'kijiji',marketplaces:'["Kijiji"]',search_term:'x',priority:'normal',schedule_pass:0,enabled:1,revision:1,sort_by:'suggested',max_items:1},{id:4,source:'facebook',marketplaces:'["Facebook Marketplace"]',search_term:'x',priority:'normal',schedule_pass:0,enabled:1,revision:1,sort_by:'suggested',max_items:1}];const pool={query:async(sql,args)=>{if(sql==='SELECT * FROM monitors ORDER BY id')return monitors;if(sql.startsWith('SELECT d.id,d.url,d.price,d.ebay_summary_signature'))return [];if(sql.startsWith('SELECT q.source'))return ['ebay','kijiji','facebook'].map(source=>({source,wait_us:cooldown.has(source)?10000000:0}));if(sql.startsWith('SELECT m.*,r.source'))return monitors.map(row=>({...row,source_pass:row.schedule_pass}));if(sql.startsWith('UPDATE monitor_runs SET status=\'searching\''))return {affectedRows:1};if(sql.startsWith('SELECT revision,enabled'))return [{revision:1,enabled:1}];if(sql.startsWith('UPDATE search_source_schedule SET last_finished')){cooldown.add(args[0]);return {affectedRows:1};}return {affectedRows:1};}};const stop=start(pool,{tryAcquire:()=>true,release:()=>{}},{connected:()=>true,search:async(source)=>{starts.push(source);await wait;return [];}});try{await new Promise(r=>setTimeout(r,2300));assert.deepEqual(starts.sort(),['ebay','facebook','kijiji']);assert.deepEqual([...cooldown].sort(),['ebay','facebook','kijiji']);release();await new Promise(r=>setTimeout(r,2300));assert.equal(starts.length,3);}finally{release();stop();}});
test('new monitors rotate tied sources instead of always starting with eBay',()=>{const rows=[1,2,3].flatMap(id=>['ebay','facebook','kijiji'].map(source=>({id,source,priority:'normal',schedule_pass:null,last_checked:null})));let lastSource=null;const chosen=[];for(let i=0;i<3;i++){const next=chooseNext(rows,lastSource);chosen.push(next.row.source);lastSource=next.row.source;for(const row of rows.filter(r=>r.id===next.row.id))row.schedule_pass=next.pass;}assert.deepEqual(chosen,['ebay','facebook','kijiji']);});
test('oldest source wins over rotation',()=>{const rows=[{id:1,source:'ebay',schedule_pass:0,last_checked:null},{id:1,source:'facebook',schedule_pass:0,last_checked:new Date()}];assert.equal(chooseNext(rows,'ebay').row.source,'ebay');});
test('a newly enabled sole monitor starts despite the regular cooldown but respects marketplace blocks',async()=>{
  const monitor={id:1,marketplaces:'["eBay"]',search_term:'test',priority:'normal',enabled:1,revision:1,sort_by:'suggested',max_items:1};
  let blocked=true,started=0,sourcePass=null,finish;
  const startedPromise=new Promise(resolve=>{finish=resolve;});
  const pool={query:async(sql,args)=>{
    if(sql==='SELECT * FROM monitors ORDER BY id')return [monitor];
    if(sql.startsWith('SELECT q.source'))return [{source:'ebay',wait_us:600000000,blocked_us:blocked?60000000:0}];
    if(sql.startsWith('SELECT m.*,r.source'))return [{...monitor,source:'ebay',source_pass:sourcePass}];
    if(sql.startsWith('UPDATE monitor_runs SET schedule_pass=')){sourcePass=args[0];return {affectedRows:1};}
    if(sql.startsWith('UPDATE monitor_runs SET status=\'searching\''))return {affectedRows:1};
    if(sql.startsWith('SELECT revision,enabled'))return [monitor];
    if(sql.startsWith('UPDATE search_source_schedule SET last_finished'))return {affectedRows:1};
    return [];
  }};
  const stop=start(pool,{tryAcquire:()=>true,release:()=>{}},{connected:()=>true,search:async()=>{started++;finish();return [];}});
  try{
    await new Promise(resolve=>setTimeout(resolve,1400));
    assert.equal(started,0,'marketplace block must be respected');
    blocked=false;
    await Promise.race([startedPromise,new Promise((_,reject)=>setTimeout(()=>reject(Error('monitor did not start promptly')),2500))]);
    assert.equal(started,1);
    await new Promise(resolve=>setTimeout(resolve,1400));
    assert.equal(started,1,'later searches must respect the normal cooldown');
  }finally{stop();}
});
test('cancellation interrupts a browser retry and releases its profile promptly',async()=>{
 const monitor={id:91,source:'kijiji',marketplaces:'["Kijiji"]',search_term:'x',priority:'normal',enabled:1,revision:1,max_items:1};
 let first,release,attempts=0;const started=new Promise(r=>first=r),released=new Promise(r=>release=r);
 const pool={query:async(sql)=>{if(sql==='SELECT * FROM monitors ORDER BY id')return [monitor];if(sql.startsWith('SELECT q.source'))return [{source:'kijiji',wait_us:0}];if(sql.startsWith('SELECT m.*,r.source'))return [monitor];return {affectedRows:1};}};
 const stop=start(pool,{tryAcquire:()=>true,release:()=>release()},{connected:()=>true,search:async()=>{attempts++;first();throw Error('Failed to decode response from marionette');}});
 try{await started;await new Promise(r=>setTimeout(r,30));stop.cancel(91);await Promise.race([released,new Promise((_,reject)=>setTimeout(()=>reject(Error('profile held during retry')),700))]);assert.equal(attempts,1);}finally{stop();}
});
