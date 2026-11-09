const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registerRoutes = require('../routes');
const worker = require('../monitor-worker');
const ai = require('../ai-worker');
const alerts = require('../alerts');
const dealFilters = require('../deal-filters');

test('routes use the injected database and current worker', async () => {
  const calls = [];
  const pool = {query: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.startsWith('SELECT delay_seconds')) return [{delay_seconds: 30}];
    if (sql.startsWith('DELETE FROM monitors')) return {affectedRows: 1};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  let cancelled;
  const app = express();
  app.use(express.json());
  registerRoutes(app, {pool, worker, ai, alerts, dealFilters, getWorker: () => ({cancel: id => { cancelled = id; }})});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const settings = await fetch(`${base}/api/search-settings`);
    assert.deepEqual(await settings.json(), {delaySeconds: 30});
    const removed = await fetch(`${base}/api/monitors/42`, {method: 'DELETE'});
    assert.equal(removed.status, 204);
    assert.equal(cancelled, '42');
    assert.deepEqual(calls[1][1], ['42']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the delay resets only when the last monitor stops or the first starts', async () => {
  const monitors = [{id:1,enabled:1},{id:2,enabled:1}];
  let resets=0;
  const connection = {
    beginTransaction:async()=>{}, commit:async()=>{}, rollback:async()=>{}, release:()=>{},
    query:async(sql,args)=>{
      if(sql.startsWith('SELECT id,enabled'))return monitors.map(row=>({...row}));
      if(sql.startsWith('UPDATE monitors SET enabled=')){monitors.find(row=>row.id===Number(args[1])).enabled=args[0];return {affectedRows:1};}
      if(sql==='UPDATE search_source_schedule SET last_finished=NULL'){resets++;return {affectedRows:3};}
      if(sql.startsWith('UPDATE monitor_runs SET status='))return {affectedRows:1};
      throw Error(`Unexpected query: ${sql}`);
    }
  };
  const app=express();app.use(express.json());
  registerRoutes(app,{pool:{getConnection:async()=>connection},worker,ai,alerts,dealFilters,getWorker:()=>({cancel:()=>{}})});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const change=async(id,enabled)=>fetch(`http://127.0.0.1:${server.address().port}/api/monitors/${id}/state`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
  try{
    assert.equal((await change(1,false)).status,200);assert.equal(resets,0);
    assert.equal((await change(2,false)).status,200);assert.equal(resets,1);
    assert.equal((await change(2,false)).status,200);assert.equal(resets,1);
    assert.equal((await change(1,true)).status,200);assert.equal(resets,2);
    assert.equal((await change(2,true)).status,200);assert.equal(resets,2);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('listing statuses are shared, validated, and automatic clicks preserve an existing status', async () => {
  const rows = new Map([[1, 'unmarked']]);
  const pool = {query: async (sql, args) => {
    if (sql.startsWith('UPDATE deals SET listing_status=')) {
      const [status, id] = args; const key = Number(id);
      if (rows.has(key) && (!sql.includes('IF(') || rows.get(key) === 'unmarked')) rows.set(key, status);
      return {affectedRows: rows.has(key) ? 1 : 0};
    }
    if (sql.startsWith('SELECT listing_status FROM deals')) return rows.has(Number(args[0])) ? [{listing_status: rows.get(Number(args[0]))}] : [];
    if (sql.startsWith('SELECT d.id,')) {
      assert.match(sql, /d\.listing_status=\?/);
      return [{id:1,source:'kijiji',url:'https://example.com',title:'Item',listing_status:rows.get(1),monitor_id:2,search_term:'Search'}].filter(row => row.listing_status === args[0]);
    }
    throw Error(`Unexpected query: ${sql}`);
  }};
  const app=express();app.use(express.json());
  registerRoutes(app,{pool,worker,ai:{getSettings:()=>({enabled:false})},alerts,dealFilters,getWorker:()=>({})});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const put=(id,body)=>fetch(`${base}/api/deals/${id}/status`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    assert.deepEqual(await (await put(1,{status:'messaged',automatic:true})).json(),{status:'messaged'});
    assert.deepEqual(await (await put(1,{status:'sold'})).json(),{status:'sold'});
    assert.deepEqual(await (await put(1,{status:'messaged',automatic:true})).json(),{status:'sold'});
    assert.equal((await put(1,{status:'invalid'})).status,400);
    assert.equal((await put(1,{status:'sold',automatic:true})).status,400);
    assert.equal((await put(99,{status:'sold'})).status,404);
    const filtered=await fetch(`${base}/api/deals?kind=items&status=sold`);
    assert.equal((await filtered.json())[0].listing_status,'sold');
    assert.deepEqual(await (await fetch(`${base}/api/deals?kind=items&status=refused`)).json(),[]);
    assert.equal((await fetch(`${base}/api/deals?status=invalid`)).status,400);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
