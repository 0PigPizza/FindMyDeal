const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const root = __dirname;
const runtime = path.join(root, '.data/browser-runtime/usr');
const sources = { kijiji: 'https://www.kijiji.ca/', ebay: 'https://www.ebay.ca/', facebook: 'https://www.facebook.com/' };
const sessions = new Map();
const monitorProfiles = new Set();
const starting = new Map();
const closing = new Map();
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port=server.address().port; server.close(() => resolve(port)); }); }); }
function stop(session) {
  if (!session || sessions.get(session.id) !== session) return;
  sessions.delete(session.id);
  for (const ws of session.clients) ws.close();
  session.firefox.kill('SIGTERM');
  const finished = delay(1500).then(() => {
    session.firefox.kill('SIGKILL'); session.vnc.kill('SIGTERM'); session.xvfb.kill('SIGTERM');
    try { fs.unlinkSync(session.auth); } catch {}
    closing.delete(session.id);
  });
  closing.set(session.id, finished);
}
async function launch(id) {
  if (!sources[id]) throw new Error('Unknown source.');
  if (monitorProfiles.has(id)) throw new Error('A monitor is using this browser. Try again when the search finishes.');
  if (closing.has(id)) await closing.get(id);
  if (sessions.has(id)) { const session = sessions.get(id); return {token:session.token,password:session.password}; }
  if (starting.has(id)) return starting.get(id);
  const work = startBrowser(id);
  starting.set(id, work);
  try { return await work; } finally { starting.delete(id); }
}
async function startBrowser(id) {
  let xvfb, vnc, firefox, auth;
  try {
    for (const f of ['bin/Xvfb','bin/x11vnc','bin/xdotool','lib/firefox/firefox']) if (!fs.existsSync(path.join(runtime,f))) throw new Error('Firefox/VNC runtime is missing. See the README for setup.');
    const profile=path.join(root,'.data/profiles',id); fs.mkdirSync(profile,{recursive:true,mode:0o700});
    const userPrefs=path.join(profile,'user.js');
    const currentPrefs=fs.existsSync(userPrefs) ? fs.readFileSync(userPrefs,'utf8') : '';
    const scalePref='user_pref("layout.css.devPixelsPerPx", "1.0");';
    fs.writeFileSync(userPrefs, currentPrefs.replace(/^\s*user_pref\(\s*["']layout\.css\.devPixelsPerPx["'].*$/gm,'').trimEnd()+'\n'+scalePref+'\n',{mode:0o600});
    const display=`:${200 + crypto.randomInt(500)}`;
    auth=path.join(root,'.data',`xauth-${crypto.randomBytes(8).toString('hex')}`); fs.writeFileSync(auth,'',{mode:0o600});
    const cookie=crypto.randomBytes(16).toString('hex'); const xauth=spawnSync('xauth',['-f',auth,'add',display,'MIT-MAGIC-COOKIE-1',cookie]); if(xauth.status!==0) throw new Error('Could not prepare the browser display.');
    const env={...process.env, DISPLAY:display, XAUTHORITY:auth, LD_LIBRARY_PATH:`${runtime}/lib:${process.env.LD_LIBRARY_PATH || ''}`, MOZ_ENABLE_WAYLAND:'0', GDK_SCALE:'1', GDK_DPI_SCALE:'1', WAYLAND_DISPLAY:'', XDG_SESSION_TYPE:'x11'};
    delete env.WAYLAND_DISPLAY;
    xvfb=spawn(`${runtime}/bin/Xvfb`,[display,'-screen','0','1600x900x24','-dpi','96','-nolisten','tcp','-auth',auth],{env,stdio:'ignore'}); xvfb.on('error',()=>{});
    await delay(800); if(xvfb.exitCode!==null || !xvfb.pid) throw new Error('Could not start the virtual display.');
    const port=await freePort(), password=crypto.randomBytes(4).toString('hex');
    vnc=spawn(`${runtime}/bin/x11vnc`,['-display',display,'-auth',auth,'-localhost','-rfbport',String(port),'-passwd',password,'-cursor','arrow','-forever','-shared','-quiet'],{env,stdio:'ignore'}); vnc.on('error',()=>{});
    await delay(700); if(vnc.exitCode!==null || !vnc.pid) throw new Error('Could not start VNC.');
    firefox=spawn(`${runtime}/lib/firefox/firefox`,['--no-remote','--profile',profile,sources[id]],{env,stdio:'ignore'}); firefox.on('error',()=>{});
    await delay(1200); if(firefox.exitCode!==null || !firefox.pid) throw new Error('Could not start Firefox.');
    for (let attempt=0; attempt<20; attempt++) {
      const found=spawnSync(`${runtime}/bin/xdotool`,['search','--onlyvisible','--class','firefox'],{env,encoding:'utf8'});
      const windowId=found.stdout?.trim().split(/\s+/)[0];
      if(found.status===0 && windowId) {
        spawnSync(`${runtime}/bin/xdotool`,['windowmove',windowId,'0','0'],{env,stdio:'ignore'});
        spawnSync(`${runtime}/bin/xdotool`,['windowsize',windowId,'1600','900'],{env,stdio:'ignore'});
        break;
      }
      if(firefox.exitCode!==null) throw new Error('Firefox closed before its window opened.');
      await delay(250);
    }
    const session={id,port,password,token:crypto.randomBytes(32).toString('hex'),xvfb,vnc,firefox,auth,clients:new Set()};
    sessions.set(id,session);
    firefox.once('exit',()=>stop(session));
    return {token:session.token,password};
  } catch(e) { for(const child of [firefox,vnc,xvfb]) if(child) child.kill(); if(auth) try { fs.unlinkSync(auth); } catch {} throw e; }
}
function setup(app, server) {
  app.use('/novnc',require('express').static(path.join(root,'node_modules/@novnc/novnc')));
  app.get('/api/sources', (req,res)=>res.json(Object.keys(sources).map(id=>({id, profileExists:fs.existsSync(path.join(root,'.data/profiles',id,'cookies.sqlite')), active:sessions.has(id)}))));
  app.post('/api/sources/:id/open',async(req,res)=>{ try {res.json(await launch(req.params.id));} catch(e){res.status(409).json({error:e.message});} });
  app.post('/api/sources/session-status',(req,res)=>{
    const session=[...sessions.values()].find(item=>item.token===req.body?.token);
    if(!session) return res.sendStatus(403);
    if(!['facebook','kijiji','ebay'].includes(session.id)) return res.json({status:'unsupported'});
    const result=spawnSync('python3',[path.join(root,'scripts',`${session.id}-session.py`),path.join(root,'.data/profiles',session.id)],{encoding:'utf8',timeout:3000});
    const status=result.status===0 ? result.stdout.trim() : 'unknown';
    res.json({status:status==='yes'?'session-present':status==='no'?'not-signed-in':'unknown'});
  });
  app.post('/api/sources/close',(req,res)=>{const session=[...sessions.values()].find(item=>item.token===req.body?.token); if(!session) return res.sendStatus(403); stop(session);res.sendStatus(204);});
  const wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{ const url=new URL(req.url,'http://localhost'); const origin=req.headers.origin; const session=[...sessions.values()].find(item=>item.token===url.searchParams.get('token')); if(url.pathname!=='/source-vnc'||!session||!origin||origin!==`http://${req.headers.host}`){socket.destroy();return;} wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,session)); });
  wss.on('connection',(ws,session)=>{  session.clients.add(ws); const tcp=net.connect(session.port,'127.0.0.1'); tcp.on('data',data=>{if(ws.readyState===WebSocket.OPEN)ws.send(data);}); ws.on('message',data=>tcp.write(data)); tcp.on('error',()=>ws.close()); tcp.on('close',()=>ws.close()); ws.on('close',()=>{tcp.destroy();session.clients.delete(ws);}); ws.on('error',()=>tcp.destroy()); });
  process.on('exit',()=>{for(const session of sessions.values()){session.firefox.kill('SIGTERM');session.vnc.kill('SIGTERM');session.xvfb.kill('SIGTERM');}});
}
setup.tryAcquire = id => { if (monitorProfiles.has(id) || sessions.has(id) || starting.has(id) || closing.has(id)) return false; monitorProfiles.add(id); return true; };
setup.release = id => monitorProfiles.delete(id);
module.exports = setup;
