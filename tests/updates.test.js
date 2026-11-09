const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFile, execFileSync} = require('child_process');
const {promisify} = require('util');
const {createUpdater} = require('../updates');
const runFile = promisify(execFile);
function git(cwd, ...args) { return execFileSync('git', args, {cwd, stdio:'pipe'}).toString().trim(); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'findmydeal-update-'));
  const remote = path.join(root, 'remote.git'), publisher = path.join(root, 'publisher'), checkout = path.join(root, 'checkout');
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main', publisher);
  git(publisher, 'config', 'user.name', 'Test'); git(publisher, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(publisher, 'file'), 'one');
  git(publisher, 'add', 'file'); git(publisher, 'commit', '-m', 'initial');
  git(publisher, 'remote', 'add', 'origin', remote); git(publisher, 'push', '-u', 'origin', 'main');
  git(root, 'clone', '-b', 'main', remote, checkout);
  git(checkout, 'config', 'user.name', 'Test'); git(checkout, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(checkout, '.git', 'info', 'exclude'), '.data/\n');
  fs.writeFileSync(path.join(publisher, 'file'), 'two'); git(publisher, 'commit', '-am', 'update'); git(publisher, 'push');
  return {root, remote, checkout};
}
test('updates respect the setting and refuse to overwrite local changes', async t => {
  const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  let restarts=0, installs=0;
  const run=async (program,args,options)=>{if(program==='npm'){installs++;return {stdout:''};}return runFile(program,args,options);};
  const updater=createUpdater({root:f.checkout,repository:f.remote,supervised:true,run,restart:()=>restarts++});
  updater.setEnabled(false);
  assert.equal((await updater.check()).state,'available');
  updater.setEnabled(true);
  fs.writeFileSync(path.join(f.checkout,'local.txt'),'keep');
  assert.equal((await updater.check()).state,'blocked');
  assert.equal(fs.readFileSync(path.join(f.checkout,'file'),'utf8'),'one');
  fs.unlinkSync(path.join(f.checkout,'local.txt'));
  assert.equal((await updater.check()).state,'restarting');
  assert.equal(fs.readFileSync(path.join(f.checkout,'file'),'utf8'),'two');
  assert.equal(installs,1); assert.equal(restarts,1);
});
test('failed dependency installation is retried before restart', async t => {
  const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  let attempts=0, restarts=0;
  const run=async (program,args,options)=>{if(program==='npm'){if(++attempts===1)throw Error('install failed');return {stdout:''};}return runFile(program,args,options);};
  const updater=createUpdater({root:f.checkout,repository:f.remote,supervised:true,run,restart:()=>restarts++});
  assert.equal((await updater.check()).state,'error');
  assert.equal(restarts,0);
  assert.equal((await updater.check()).state,'restarting');
  assert.equal(attempts,2); assert.equal(restarts,1);
});
test('manual installation works when automatic updates are disabled and only after checking', async t=>{
 const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));let restarted=0;
 const updater=createUpdater({root:f.checkout,repository:f.remote,supervised:true,run:async(p,a,o)=>p==='npm'?{stdout:''}:runFile(p,a,o),restart:()=>restarted++});
 updater.setEnabled(false);assert.equal((await updater.install()).state,'idle');assert.equal((await updater.check({install:false})).state,'available');assert.equal((await updater.install()).state,'restarting');assert.equal(restarted,1);
});
test('container update requires an available release and live host helper', async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fmd-control-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const updater=require('../updates').createContainerUpdater({version:'v1.0.0',controlDir:root,fetchRelease:async()=>({ok:true,json:async()=>({tag_name:'v1.1.0',assets:[{name:'SHA256SUMS',state:'uploaded'},{name:'findmydeal-images-linux-amd64.tar.gz',state:'uploaded'}]})})});
 assert.equal((await updater.install()).state,'idle');assert.equal((await updater.check()).state,'available');assert.equal((await updater.install()).state,'available');
 fs.writeFileSync(path.join(root,'heartbeat'),'');assert.equal((await updater.install()).state,'installing');assert.equal(fs.existsSync(path.join(root,'request')),true);
});

test('container updates wait until both release files are uploaded', async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fmd-control-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const updater=require('../updates').createContainerUpdater({version:'v1.0.0',controlDir:root,fetchRelease:async()=>({ok:true,json:async()=>({tag_name:'v1.1.0',assets:[]})})});
 const result=await updater.check();assert.equal(result.state,'error');assert.match(result.message,/still being prepared/);assert.equal((await updater.install()).state,'error');
});
