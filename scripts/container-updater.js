// Host-side helper. Only a fixed GitHub release and the configured Compose app are accepted.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {pipeline}=require('stream/promises'),{Readable}=require('stream'),{spawn}=require('child_process');
const composeDir=process.argv[2],controlDir=process.argv[3];
if(!composeDir||!controlDir)throw Error('Usage: container-updater.js COMPOSE_DIR CONTROL_DIR');
function write(name,value){const tmp=path.join(controlDir,`.${name}.${crypto.randomBytes(16).toString('hex')}`);fs.writeFileSync(tmp,value,{flag:'wx'});fs.renameSync(tmp,path.join(controlDir,name));}
function command(args){return new Promise((resolve,reject)=>{const child=spawn('docker',args,{cwd:composeDir,stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Docker ${args[0]} failed (exit ${code}).`)));});}
async function download(url,dest){const response=await fetch(url,{signal:AbortSignal.timeout(600000)});if(!response.ok||!response.body)throw Error(`Release download failed (HTTP ${response.status}).`);await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(dest,{flags:'wx'}));}
async function update(){
 let dir;try{
  write('status.json',JSON.stringify({state:'installing',message:'Downloading and installing the latest release…'}));
  const response=await fetch('https://api.github.com/repos/0PigPizza/FindMyDeal/releases/latest',{headers:{'User-Agent':'FindMyDeal-updater','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(`GitHub returned HTTP ${response.status}.`);
  const release=await response.json(),tag=release.tag_name;if(!/^v\d+\.\d+\.\d+$/.test(tag))throw Error('Invalid release version.');
  const base=`https://github.com/0PigPizza/FindMyDeal/releases/download/${tag}/`;dir=fs.mkdtempSync(path.join(os.tmpdir(),'findmydeal-update-'));
  const image=path.join(dir,'findmydeal-images-linux-amd64.tar.gz'),sums=path.join(dir,'SHA256SUMS');
  await download(base+'SHA256SUMS',sums);const match=fs.readFileSync(sums,'utf8').match(/^([a-f0-9]{64})\s+\*?findmydeal-images-linux-amd64\.tar\.gz$/m);if(!match)throw Error('Release image checksum is missing.');
  await download(base+'findmydeal-images-linux-amd64.tar.gz',image);
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(image))hash.update(chunk);if(hash.digest('hex')!==match[1])throw Error('Release image checksum does not match.');
  await command(['load','-i',image]);await command(['compose','up','-d','--no-deps','--force-recreate','app']);
  write('status.json',JSON.stringify({state:'done',message:`Installed ${tag}.`}));
 }catch(e){write('status.json',JSON.stringify({state:'error',message:`Container update failed: ${e.message}`}));}finally{if(dir)fs.rmSync(dir,{recursive:true,force:true});}
}
let busy=false;
async function tick(){try{write('heartbeat',String(Date.now()));if(!busy){try{fs.rmdirSync(path.join(controlDir,'request'));busy=true;update().finally(()=>{busy=false;});}catch(e){if(e.code!=='ENOENT')console.error('Update request:',e.message);}}}catch(e){console.error('Update helper:',e.message);}}
tick();setInterval(tick,2000);
