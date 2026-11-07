const {execFile} = require('child_process');
const {promisify} = require('util');
const path = require('path');
const fs = require('fs');
const runFile = promisify(execFile);
const REPOSITORY = 'https://github.com/0PigPizza/FindMyDeal.git';

function createUpdater({root = __dirname, repository = REPOSITORY, restart = () => {}, supervised = false, run = runFile} = {}) {
  const settingsPath = path.join(root, '.data', 'update-settings.json');
  const pendingPath = path.join(root, '.data', 'update-pending.json');
  let status = {state: 'idle', message: 'Updates have not been checked yet.', checkedAt: null};
  let busy = false;
  function enabled() {
    try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')).enabled !== false; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  function setEnabled(value) {
    fs.mkdirSync(path.dirname(settingsPath), {recursive: true, mode: 0o700});
    fs.writeFileSync(settingsPath, JSON.stringify({enabled: value}), {mode: 0o600});
  }
  async function command(program, args) {
    const result = await run(program, args, {cwd: root, timeout: 120000, maxBuffer: 1024 * 1024, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}});
    return result.stdout.trim();
  }
  async function check({install = true, force = false} = {}) {
    if (busy) return getStatus();
    busy = true;
    status = {...status, state: 'checking', message: 'Checking GitHub for updates…'};
    try {
      if (fs.existsSync(pendingPath)) {
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        if (await command('git', ['rev-parse', 'HEAD']) !== pending.target) throw Error('An interrupted update needs manual attention.');
        if (!supervised) throw Error('An interrupted update needs npm start to finish installing dependencies.');
        status = {...status, state: 'installing', message: 'Finishing update; FindMyDeal will restart.'};
        await command('npm', ['ci', '--no-audit', '--no-fund']);
        fs.unlinkSync(pendingPath);
        status = {...status, state: 'restarting', message: 'Update installed. Restarting FindMyDeal…'};
        restart();
        return getStatus();
      }
      const origin = await command('git', ['remote', 'get-url', 'origin']);
      if (![repository, repository.replace(/\.git$/, ''), repository.replace('https://github.com/', 'git@github.com:')].includes(origin)) throw Error('The Git origin does not match the FindMyDeal repository.');
      if (await command('git', ['branch', '--show-current']) !== 'main') throw Error('Automatic updates require the main branch.');
      await command('git', ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
      const current = await command('git', ['rev-parse', 'HEAD']);
      const latest = await command('git', ['rev-parse', 'refs/remotes/origin/main']);
      const checkedAt = new Date().toISOString();
      if (current === latest) status = {state: 'current', message: 'FindMyDeal is up to date.', checkedAt};
      else {
        await command('git', ['merge-base', '--is-ancestor', current, latest]).catch(() => { throw Error('The local branch has diverged from GitHub. Update it manually.'); });
        if (!install || (!force && !enabled())) status = {state: 'available', message: 'An update is available.', checkedAt};
        else if (!supervised) status = {state: 'available', message: 'An update is available. Start with npm start to install it automatically.', checkedAt};
        else if (await command('git', ['status', '--porcelain', '--untracked-files=normal'])) status = {state: 'blocked', message: 'Local changes prevent an automatic update. Commit or move them first.', checkedAt};
        else {
          status = {state: 'installing', message: 'Installing update; FindMyDeal will restart.', checkedAt};
          fs.mkdirSync(path.dirname(pendingPath), {recursive: true, mode: 0o700});
          fs.writeFileSync(pendingPath, JSON.stringify({target: latest}), {mode: 0o600});
          try { await command('git', ['merge', '--ff-only', latest]); } catch (error) { fs.unlinkSync(pendingPath); throw error; }
          await command('npm', ['ci', '--no-audit', '--no-fund']);
          fs.unlinkSync(pendingPath);
          status = {state: 'restarting', message: 'Update installed. Restarting FindMyDeal…', checkedAt};
          restart();
        }
      }
    } catch (error) {
      status = {state: 'error', message: `Update check failed: ${error.message}`, checkedAt: new Date().toISOString()};
    } finally { busy = false; }
    return getStatus();
  }
  function getStatus() { return {...status, enabled: enabled()}; }
  async function install() { if (status.state !== 'available') return getStatus(); return check({install:true,force:true}); }
  return {check, getStatus, setEnabled, install};
}
function createContainerUpdater({version = process.env.FMD_RELEASE || '', fetchRelease = fetch, controlDir = path.join(__dirname,'.data','update-control')} = {}) {
  let status = {state:'idle', enabled:false, container:true, message:'Container updates are installed from GitHub Releases.', checkedAt:null};
  function helperAvailable(){try{return Date.now()-fs.statSync(path.join(controlDir,'heartbeat')).mtimeMs<15000;}catch{return false;}}
  function getStatus(){let helperStatus;try{helperStatus=JSON.parse(fs.readFileSync(path.join(controlDir,'status.json'),'utf8'));}catch{};return {...status,helperAvailable:helperAvailable(),...(helperStatus?.state==='installing' || helperStatus?.state==='error' ? {state:helperStatus.state,message:helperStatus.message}: {})};}
  return {
    getStatus,
    install: async () => {if(status.state!=='available'||!helperAvailable())return getStatus();try{fs.mkdirSync(path.join(controlDir,'request'));status={...status,state:'installing',message:'Preparing container update…'};}catch(e){if(e.code!=='EEXIST')status={...status,state:'error',message:'Could not request the container update.'};}return getStatus();},
    setEnabled: () => { throw Error('Container updates must be installed from a release.'); },
    check: async () => {
      try {
        try{const old=JSON.parse(fs.readFileSync(path.join(controlDir,'status.json'),'utf8'));if(old.state==='error')fs.unlinkSync(path.join(controlDir,'status.json'));}catch{}
        const response = await fetchRelease('https://api.github.com/repos/0PigPizza/FindMyDeal/releases/latest', {headers:{'Accept':'application/vnd.github+json'}, signal:AbortSignal.timeout(10000)});
        if (!response.ok) throw Error(`GitHub returned HTTP ${response.status}.`);
        const release = await response.json();
        status = {...status, state:release.tag_name===version?'current':'available', message:release.tag_name===version?'This container is up to date.':`Release ${release.tag_name} is available. Download and load its container images, then restart Compose.`, checkedAt:new Date().toISOString()};
      } catch (e) { status = {...status, state:'error', message:`Update check failed: ${e.message}`, checkedAt:new Date().toISOString()}; }
      return getStatus();
    }
  };
}
module.exports = {createUpdater, createContainerUpdater, REPOSITORY};
