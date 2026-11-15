const test=require('node:test');const assert=require('node:assert/strict');const chats=require('../chats');
test('only supported marketplaces enqueue an AI-approved deal with a configured message',async()=>{const queries=[];const pool={query:async(...args)=>{queries.push(args);return {affectedRows:1};}};await chats.enqueue(pool,{source:'ebay',monitor_id:1,deal_id:2});assert.equal(queries.length,0);await chats.enqueue(pool,{source:'kijiji',monitor_id:1,deal_id:2});assert.equal(queries.length,1);assert.match(queries[0][0],/INSERT IGNORE/);assert.match(queries[0][0],/r.verdict='deal'/);assert.deepEqual(queries[0][1],[1,2]);});
test('messages are validated and saved through the chats endpoint',async()=>{const routes={};const pool={query:async()=>({affectedRows:1})};chats.routes({get:(p,f)=>routes[p]=f,put:(p,f)=>routes[p]=f},pool);const res={statusCode:200,status(n){this.statusCode=n;return this;},json(data){this.data=data;return this;}};await routes['/api/chats/:id']({params:{id:'1'},body:{message:'x'.repeat(2001)}},res);assert.equal(res.statusCode,400);res.statusCode=200;await routes['/api/chats/:id']({params:{id:'1'},body:{message:'Hi'}},res);assert.equal(res.statusCode,200);assert.equal(res.data.ok,true);});
test('a platform limit reserves one attempt and keeps the other platform independent',async()=>{
 const limits={kijiji:1,facebook:1},counts={};let status='pending';
 const conn={async beginTransaction(){},async commit(){},async rollback(){},release(){},async query(sql,args){
  if(sql.includes('FROM chat_limits'))return [{max_per_hour:limits[args[0]]}];
  if(sql.startsWith('SELECT attempts'))return counts[args[0]]?[{attempts:counts[args[0]]}]:[];
  if(sql.startsWith('UPDATE chat_deliveries'))return {affectedRows:status==='pending'?1:0};
  if(sql.startsWith('INSERT INTO chat_hourly_counts')){counts[args[0]]=(counts[args[0]]||0)+1;return {affectedRows:1};}
  throw Error(sql);
 }};
 const pool={getConnection:async()=>conn};
 assert.equal(await chats.claim(pool,{source:'kijiji',deal_id:1}),true);
 assert.equal(await chats.claim(pool,{source:'kijiji',deal_id:2}),false);
 assert.equal(await chats.claim(pool,{source:'facebook',deal_id:3}),true);
 assert.deepEqual(counts,{kijiji:1,facebook:1});
 counts.kijiji=0;assert.equal(await chats.claim(pool,{source:'kijiji',deal_id:4}),true);
});
test('hourly limits accept blank or nonnegative integers and reject invalid input',async()=>{
 const handlers={};const calls=[];chats.routes({get:(p,f)=>handlers[p]=f,put:(p,f)=>handlers[p]=f},{query:async(...args)=>{calls.push(args);return {affectedRows:2};}});
 const res={code:200,status(n){this.code=n;return this;},json(data){this.data=data;return this;}};
 await handlers['/api/chat-limits']({body:{kijiji:0,facebook:null}},res);assert.equal(res.code,200);assert.deepEqual(calls[0][1],[0,null]);
 await handlers['/api/chat-limits']({body:{kijiji:-1,facebook:1}},res);assert.equal(res.code,400);assert.equal(calls.length,1);
});
