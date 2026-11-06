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
