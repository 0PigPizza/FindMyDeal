require('dotenv').config();
const express = require('express');
const database = require('./database');
const app = express();
const worker = require('./monitor-worker');
const ai = require('./ai-worker');
const alerts = require('./alerts');
const dealFilters = require('./deal-filters');
const sources = require('./sources');
const pool = database.createPool();
const updater = process.env.FMD_CONTAINER === '1' ? require('./updates').createContainerUpdater() : require('./updates').createUpdater({supervised: process.env.FMD_SUPERVISED === '1', restart: () => shutdown(75)});
app.use(express.json());
app.use(express.static('public'));

let stopWorker=Object.assign(()=>{}, {cancel:()=>{}}),stopAi=()=>{};
require('./routes')(app, {pool, worker, ai, alerts, dealFilters, getWorker:()=>stopWorker});
require('./instant')(app, {worker, ai, profiles:sources, getWorker:()=>stopWorker});
const server = require('http').createServer(app);
sources(app, server);
app.get('/api/updates', (req,res)=>res.json(updater.getStatus()));
app.post('/api/updates/check', async (req,res)=>res.json(await updater.check()));
app.put('/api/updates', (req,res)=>{if(typeof req.body?.enabled!=='boolean')return res.status(400).json({error:'Invalid update setting.'});try{updater.setEnabled(req.body.enabled);res.json(updater.getStatus());}catch(e){res.status(503).json({error:'Could not save update setting.'});}});
database.init(pool).then(()=>worker.init(pool)).then(()=>ai.init(pool)).then(()=>server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', ()=>{stopWorker=worker.start(pool,sources);stopAi=ai.start(pool);console.log(`FindMyDeal running at http://localhost:${process.env.PORT || 3000}`);setTimeout(()=>updater.check(),10000).unref();setInterval(()=>updater.check(),6*60*60*1000).unref()})).catch(e=>{console.error('MariaDB initialization failed:', e.message); process.exit(1);});

let shuttingDown=false;
function shutdown(code=0){if(shuttingDown)return;shuttingDown=true;stopWorker();stopAi();server.close(()=>pool.end().finally(()=>process.exit(code)));setTimeout(()=>process.exit(code),3000).unref();}
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>shutdown());
