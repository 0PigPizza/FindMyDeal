const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');
const { spawn, spawnSync } = require('child_process');
const root = __dirname;
const names = { 'Facebook Marketplace': 'facebook', Kijiji: 'kijiji', eBay: 'ebay' };
const scripts = { facebook: 'facebook_search_test', kijiji: 'kijiji_search_test', ebay: 'ebay_search_test' };
const facebookDistances = [1, 2, 5, 10, 20, 40, 60, 80, 100, 250, 500];
const ebayDistances = [10, 25, 50, 100, 200, 500, 1000];
const ebayBrowserFailure = /NS_ERROR_OUT_OF_MEMORY|out of memory|browsing context.*discarded|no such window|failed to decode response from marionette|tried to run command without establishing a connection/i;
const kijijiBrowserFailure = /unable to locate window|no such window|browsing context.*discarded|failed to decode response from marionette|tried to run command without establishing a connection/i;

function listingId(source, url) {
  const patterns={facebook:/\/marketplace\/item\/(\d+)(?:[/?#]|$)/,kijiji:/\/(\d+)(?:[/?#]|$)/,ebay:/\/itm\/(?:[^/?]+\/)?(\d+)(?:[/?#]|$)/};
  return url.match(patterns[source])?.[1] || null;
}
async function thumbnail(source, value) {
  const hosts={facebook:['fbcdn.net'],kijiji:['kijiji.ca','kijijistatic.com','ebayimg.com'],ebay:['ebayimg.com']};
  let url; try {url=new URL(value);} catch {return null;}
  if(url.protocol!=='https:' || !hosts[source].some(host=>url.hostname===host || url.hostname.endsWith('.'+host))) return null;
  try {
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return null;
    if(Number(response.headers.get('content-length'))>5*1024*1024) return null;
    const chunks=[];let size=0;
    for await (const chunk of response.body) {size+=chunk.length;if(size>5*1024*1024)return null;chunks.push(chunk);}
    return await sharp(Buffer.concat(chunks),{limitInputPixels:40000000}).rotate().resize(320,240,{fit:'inside',withoutEnlargement:true}).jpeg({quality:65}).toBuffer();
  } catch {return null;}
}

function settingsFor(monitor, source) {
  const distance = monitor.max_distance == null ? null : Number(monitor.max_distance);
  const location = ''; // Use each marketplace profile's saved default.
  if (source === 'facebook' && distance !== null && !facebookDistances.includes(distance)) throw Error(`Facebook supports distances of ${facebookDistances.join(', ')} km.`);
  if (source === 'kijiji' && distance !== null && distance > 1000) throw Error('Kijiji supports distances up to 1000 km.');
  if (source === 'ebay') {
    if (distance !== null && !ebayDistances.includes(distance)) throw Error(`eBay supports distances of ${ebayDistances.join(', ')} km.`);
  }
  return {search: monitor.search_term, min_price: monitor.min_price == null ? null : Number(monitor.min_price), max_price: monitor.max_price == null ? null : Number(monitor.max_price), location, max_distance_km:distance, sort_by:monitor.sort_by === 'date' ? 'date_listed' : 'suggested', max_results:Number(monitor.max_items ?? 30), use_source_location:true};
}
function validateMonitor(b) {
  const monitor={search_term:b.searchTerm, min_price:b.minPrice, max_price:b.maxPrice, location:'', max_distance:b.maxDistance, sort_by:b.sortBy, max_items:b.maxItems};
  for (const name of b.marketplaces) { try { settingsFor(monitor, names[name]); } catch (e) { return e.message; } }
  return null;
}
function ebayBackoffSeconds(failures){const intervals=[5,10,60,300,600];return intervals[Math.min(Math.max(0,failures),intervals.length-1)];}
function retryTimeText(seconds){return seconds<300?`${seconds} seconds`:`${seconds/60} minutes`;}
function failureMessage(stderr) {return (stderr.trim().split('\n').pop() || 'Search failed.').replace(/^Error:\s*/,'');}
function stopProcessGroup(pid) {
  if(!pid)return;
  try{process.kill(-pid,'SIGTERM');}catch{return;}
  const timer=setTimeout(()=>{try{process.kill(-pid,'SIGKILL');}catch{}},2000);
  timer.unref();
}
function runScript(source, settings, setChild) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(root, '.data', 'monitor-'));
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify(settings), {mode:0o600});
    const code = `import pathlib,sys; import ${scripts[source]} as s; s.CONFIG=pathlib.Path(sys.argv[1]); s.main()`;
    const child = spawn('python3', ['-c', code, config], {cwd:root, detached:true, stdio:['ignore','pipe','pipe']});
    setChild(child);
    let out='', err='', failed=null;
    const timer=setTimeout(()=>{failed='timeout';stopProcessGroup(child.pid)}, 10*60*1000);
    child.stdout.on('data', chunk=>{out+=chunk; if(out.length>8*1024*1024){failed='size';stopProcessGroup(child.pid)}});
    child.stderr.on('data', chunk=>{err=(err+chunk).slice(-16000);});
    child.once('exit',()=>stopProcessGroup(child.pid));
    child.once('error', error=>{clearTimeout(timer);fs.rmSync(dir,{recursive:true,force:true});reject(error);});
    child.once('close', code=>{clearTimeout(timer);fs.rmSync(dir,{recursive:true,force:true});setChild(null);if(failed)return reject(Error(failed==='timeout'?'Search took too long.':'Search returned too much data.'));if(code!==0)return reject(Error(failureMessage(err)));try{const items=JSON.parse(out);if(!Array.isArray(items))throw Error('Invalid results');const warning=err.split('\n').find(line=>line.startsWith('FMD_WARNING: '));if(warning)items.warning=warning.slice('FMD_WARNING: '.length,1000);resolve(items);}catch{return reject(Error('Could not read search results.'));}});
  });
}
// Weighted fair scheduling gives each monitor turns in proportion to its priority.
function chooseNext(rows,lastSource=null) {
  if (!rows.length) return null;
  const monitors=new Map(),sources=['ebay','facebook','kijiji'];
  const start=(sources.indexOf(lastSource)+1)%sources.length;
  const sourceRank=source=>{const index=sources.indexOf(source);return index<0?sources.length:(index-start+sources.length)%sources.length;};
  for(const row of rows){const previous=monitors.get(row.id);const time=row.last_checked==null?-Infinity:new Date(row.last_checked).getTime(),previousTime=previous?.last_checked==null?-Infinity:new Date(previous.last_checked).getTime();if(!previous || time<previousTime || (time===previousTime && sourceRank(row.source)<sourceRank(previous.source)))monitors.set(row.id,row);}
  const candidates=[...monitors.values()];
  const known=candidates.filter(row=>row.schedule_pass!=null).map(row=>Number(row.schedule_pass));
  const baseline=known.length?Math.min(...known):0;
  candidates.sort((a,b)=>(a.schedule_pass==null?-Infinity:Number(a.schedule_pass))-(b.schedule_pass==null?-Infinity:Number(b.schedule_pass)) || Number(a.id)-Number(b.id));
  const selected=candidates[0], weight={low:1,normal:2,high:4}[selected.priority]||2;
  return {row:selected,pass:Math.max(baseline,selected.schedule_pass==null?baseline:Number(selected.schedule_pass))+1/weight};
}
async function init(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS monitor_runs (monitor_id INT UNSIGNED NOT NULL, source VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'waiting', last_checked DATETIME NULL, next_run DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, error TEXT NULL, PRIMARY KEY (monitor_id, source), FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS deals (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, source VARCHAR(32) NOT NULL, url_hash CHAR(64) NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, price VARCHAR(255) NULL, description MEDIUMTEXT NULL, first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY deal_unique (source,url_hash))`);
  await pool.query('ALTER TABLE deals ADD COLUMN IF NOT EXISTS thumbnail MEDIUMBLOB NULL');
  await pool.query('ALTER TABLE deals ADD COLUMN IF NOT EXISTS item_condition VARCHAR(255) NULL, ADD COLUMN IF NOT EXISTS ebay_summary_signature CHAR(64) NULL, ADD COLUMN IF NOT EXISTS ebay_details_checked DATETIME NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS deal_matches (deal_id INT UNSIGNED NOT NULL, monitor_id INT UNSIGNED NOT NULL, PRIMARY KEY (deal_id, monitor_id), FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE, FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE)`);
  await pool.query("ALTER TABLE monitors ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'normal', ADD COLUMN IF NOT EXISTS schedule_pass DOUBLE NULL");
  await pool.query("CREATE TABLE IF NOT EXISTS search_settings (id TINYINT UNSIGNED NOT NULL PRIMARY KEY, delay_seconds INT UNSIGNED NOT NULL DEFAULT 30, next_search DATETIME(3) NULL)");
  await pool.query('ALTER TABLE monitor_runs ADD COLUMN IF NOT EXISTS schedule_pass DOUBLE NULL');
  await pool.query('CREATE TABLE IF NOT EXISTS search_source_schedule (source VARCHAR(32) NOT NULL PRIMARY KEY,last_finished DATETIME(3) NULL)');
  await pool.query('ALTER TABLE search_source_schedule ADD COLUMN IF NOT EXISTS blocked_until DATETIME(3) NULL, ADD COLUMN IF NOT EXISTS consecutive_403 INT UNSIGNED NOT NULL DEFAULT 0');
  await pool.query("INSERT IGNORE INTO search_source_schedule(source) VALUES ('ebay'),('facebook'),('kijiji')");
  await pool.query("UPDATE search_source_schedule SET consecutive_403=1 WHERE source='ebay' AND consecutive_403=0 AND blocked_until>NOW(3)");
  const created=await pool.query('INSERT IGNORE INTO search_settings(id,delay_seconds) VALUES (1,30)');
  if(created.affectedRows)await pool.query("UPDATE monitor_runs SET next_run=NOW() WHERE status IN ('ready','waiting','searching')");
  await pool.query("UPDATE monitor_runs SET status='waiting' WHERE status='searching' OR (status='error' AND source='ebay' AND error LIKE '%HTTP 403%')");
}
function start(pool, profiles, options={}) {
  const search = options.search || runScript;
  const connected = options.connected || (source => { const check=spawnSync('python3',[path.join(root,'scripts',`${source}-session.py`),path.join(root,'.data/profiles',source)],{encoding:'utf8',timeout:3000}); return check.status===0 && check.stdout.trim()==='yes'; });
  let timer, stopped=false, polling=false;
  const active=new Map();
  async function tick() {
    if (stopped || polling) return;
    polling=true;
    try {
      const monitors=await pool.query('SELECT * FROM monitors ORDER BY id');
      for (const monitor of monitors) {
        let chosen; try { chosen=JSON.parse(monitor.marketplaces); } catch { continue; }
        for(const name of chosen) if(names[name]) await pool.query('INSERT IGNORE INTO monitor_runs (monitor_id,source) VALUES (?,?)',[monitor.id,names[name]]);
      }
      const schedules=await pool.query("SELECT q.source,CASE WHEN q.source='ebay' AND q.consecutive_403>0 AND q.blocked_until IS NOT NULL THEN GREATEST(0,COALESCE(TIMESTAMPDIFF(MICROSECOND,NOW(3),q.blocked_until),0)) ELSE GREATEST(COALESCE(TIMESTAMPDIFF(MICROSECOND,NOW(3),DATE_ADD(q.last_finished,INTERVAL s.delay_seconds SECOND)),0),COALESCE(TIMESTAMPDIFF(MICROSECOND,NOW(3),q.blocked_until),0)) END AS wait_us FROM search_source_schedule q JOIN search_settings s ON s.id=1");
      const due=await pool.query("SELECT m.*,r.source,r.last_checked,r.schedule_pass AS source_pass FROM monitor_runs r JOIN monitors m ON m.id=r.monitor_id WHERE m.enabled=1 AND r.next_run<=NOW() ORDER BY r.next_run,r.monitor_id");
      for(const schedule of schedules){
        const source=schedule.source;if(stopped || active.has(source) || schedule.wait_us>0)continue;
        const candidates=due.filter(row=>row.source===source).map(row=>({...row,schedule_pass:row.source_pass}));
        const next=chooseNext(candidates);if(!next)continue;
        const monitor=next.row,job={id:Number(monitor.id),revision:Number(monitor.revision),cancelled:false,child:null};
        active.set(source,job);
        try{await pool.query('UPDATE monitor_runs SET schedule_pass=? WHERE monitor_id=? AND source=?',[next.pass,monitor.id,source]);}
        catch(e){active.delete(source);throw e;}
        runJob(monitor,source,job).catch(e=>{if(!stopped)console.error('Monitor worker:',e.message);}).finally(async()=>{try{await pool.query('UPDATE search_source_schedule SET last_finished=NOW(3) WHERE source=?',[source]);}catch(e){if(!stopped)console.error('Search scheduler:',e.message);}finally{if(active.get(source)===job)active.delete(source);}});
      }
    } catch(e) { if(!stopped) console.error('Monitor worker:',e.message); }
    finally { polling=false; if(!stopped) timer=setTimeout(tick,1000); }
  }
  async function runJob(monitor,source,job) {
      let settings;
      try { settings=settingsFor(monitor,source); } catch(e) { await finish(monitor,source,'error',e.message); return; }
      if (!profiles.tryAcquire(source)) { await pool.query("UPDATE monitor_runs SET status='waiting',error=?,next_run=DATE_ADD(NOW(),INTERVAL 10 SECOND) WHERE monitor_id=? AND source=?",['Browser profile is in use.',monitor.id,source]); return; }
      try {
        if(!connected(source)) { await finish(monitor,source,'error','Connect this source in Sources before monitoring.'); return; }
        const changed=await pool.query("UPDATE monitor_runs SET status='searching',error=NULL WHERE monitor_id=? AND source=? AND EXISTS (SELECT 1 FROM monitors WHERE id=? AND enabled=1 AND revision=?)",[monitor.id,source,monitor.id,job.revision]);
        if(!changed.affectedRows || job.cancelled || stopped) return;
        if(source==='ebay'){
          const cached=await pool.query("SELECT d.id,d.url,d.price,d.ebay_summary_signature,TIMESTAMPDIFF(SECOND,d.ebay_details_checked,NOW()) AS age_seconds FROM deals d JOIN deal_matches dm ON dm.deal_id=d.id WHERE d.source='ebay' AND dm.monitor_id=? AND d.ebay_summary_signature IS NOT NULL AND d.ebay_details_checked IS NOT NULL",[monitor.id]);
          settings.cached_listings={};for(const row of cached){const id=listingId('ebay',row.url);if(id)settings.cached_listings[id]={id:Number(row.id),price:row.price,signature:row.ebay_summary_signature,age_seconds:Number(row.age_seconds)};}
        }
        let items;
        for(let attempt=0;attempt<2;attempt++) {
          try {
            items=await search(source,settings,value=>{job.child=value;if(value && (job.cancelled || stopped) && value.pid)try{process.kill(-value.pid,'SIGTERM');}catch{}});
            break;
          } catch(e) {
            const facebookRetry=source==='facebook' && /failed to decode response from marionette/i.test(e.message);
            const ebayRetry=source==='ebay' && ebayBrowserFailure.test(e.message);
            const kijijiRetry=source==='kijiji' && kijijiBrowserFailure.test(e.message);
            if((!facebookRetry && !ebayRetry && !kijijiRetry) || attempt>0 || stopped || job.cancelled) throw e;
            await new Promise(resolve=>setTimeout(resolve,ebayRetry || kijijiRetry?5000:1000));
            if(stopped || job.cancelled) return;
          }
        }
        if (stopped || job.cancelled) return;
        const current=await pool.query('SELECT revision,enabled FROM monitors WHERE id=?',[monitor.id]);
        if(!current.length || !current[0].enabled || Number(current[0].revision)!==job.revision) return;
        const imageJobs=[];
        for(const item of items) {
          if(stopped || job.cancelled) break;
          if(source==='ebay' && Number.isSafeInteger(item?.cached_id) && item.cached_id>0){await pool.query("UPDATE deals d JOIN deal_matches dm ON dm.deal_id=d.id SET d.last_seen=CURRENT_TIMESTAMP WHERE d.id=? AND d.source='ebay' AND dm.monitor_id=? AND EXISTS (SELECT 1 FROM monitors WHERE id=? AND enabled=1 AND revision=?)",[item.cached_id,monitor.id,monitor.id,job.revision]);continue;}
          if(!item || typeof item.url!=='string' || typeof item.title!=='string' || !item.title.trim()) continue;
          let url; try {url=new URL(item.url);}catch{continue;}
          const hosts={facebook:['facebook.com','www.facebook.com'],kijiji:['kijiji.ca','www.kijiji.ca'],ebay:['ebay.ca','www.ebay.ca','ebay.com','www.ebay.com']};
          if(url.protocol!=='https:' || !hosts[source].includes(url.hostname))continue;
          const hash=crypto.createHash('sha256').update(url.href).digest('hex');
          const externalId=listingId(source,url.href);
          const found=await pool.query('SELECT id,thumbnail IS NOT NULL AS has_image FROM deals WHERE source=? AND (url_hash=?'+(externalId?' OR url REGEXP ?':'')+') ORDER BY id LIMIT 1',externalId?[source,hash,`/${externalId}([/?#]|$)`]:[source,hash]);
          if(found.length) {
            await pool.query(`UPDATE deals SET title=?,price=?,description=${source==='ebay'?'COALESCE(?,description)':'?'},item_condition=COALESCE(?,item_condition),last_seen=CURRENT_TIMESTAMP WHERE id=?`,[item.title.slice(0,5000),typeof item.price==='string'?item.price.slice(0,255):null,typeof item.description==='string'?item.description.slice(0,500000):null,typeof item.item_condition==='string'?item.item_condition.slice(0,255):null,found[0].id]);
            await pool.query('INSERT IGNORE INTO deal_matches (deal_id,monitor_id) SELECT ?,id FROM monitors WHERE id=? AND enabled=1 AND revision=?',[found[0].id,monitor.id,job.revision]);
            if(source==='ebay' && typeof item.description==='string' && item.description.trim() && /^[a-f0-9]{64}$/.test(item.summary_signature||''))await pool.query('UPDATE deals SET ebay_summary_signature=?,ebay_details_checked=NOW() WHERE id=?',[item.summary_signature,found[0].id]);
            if(!found[0].has_image && item.image_url)imageJobs.push([found[0].id,item.image_url]);
            continue;
          }
          await pool.query('INSERT INTO deals (source,url_hash,url,title,price,description,item_condition) SELECT ?,?,?,?,?,?,? FROM monitors WHERE id=? AND enabled=1 AND revision=? ON DUPLICATE KEY UPDATE title=VALUES(title),price=VALUES(price),description=VALUES(description),item_condition=COALESCE(VALUES(item_condition),item_condition),last_seen=CURRENT_TIMESTAMP',[source,hash,url.href,item.title.slice(0,5000),typeof item.price==='string'?item.price.slice(0,255):null,typeof item.description==='string'?item.description.slice(0,500000):null,typeof item.item_condition==='string'?item.item_condition.slice(0,255):null,monitor.id,job.revision]);
          await pool.query('INSERT IGNORE INTO deal_matches (deal_id,monitor_id) SELECT d.id,m.id FROM deals d JOIN monitors m ON m.id=? AND m.enabled=1 AND m.revision=? WHERE d.source=? AND d.url_hash=?',[monitor.id,job.revision,source,hash]);
          if(source==='ebay' && typeof item.description==='string' && item.description.trim() && /^[a-f0-9]{64}$/.test(item.summary_signature||''))await pool.query("UPDATE deals SET ebay_summary_signature=?,ebay_details_checked=NOW() WHERE source='ebay' AND url_hash=?",[item.summary_signature,hash]);
          if(item.image_url){const rows=await pool.query('SELECT id,thumbnail IS NOT NULL AS has_image FROM deals WHERE source=? AND url_hash=?',[source,hash]);if(rows.length&&!rows[0].has_image)imageJobs.push([rows[0].id,item.image_url]);}
        }
        for(let i=0;i<imageJobs.length && !stopped && !job.cancelled;i+=3) await Promise.all(imageJobs.slice(i,i+3).map(async([id,url])=>{const image=await thumbnail(source,url);if(image)await pool.query('UPDATE deals SET thumbnail=? WHERE id=? AND thumbnail IS NULL',[image,id]);}));
        await finish(monitor,source,items.warning?'error':'ready',items.warning||null,items.warning?300:0);
      } catch(e) { if(!stopped && !job.cancelled) {const temporaryEbayError=source==='ebay' && /eBay returned an error page|eBay refused the request \(HTTP 403\)/i.test(e.message);const ebayBrowserError=source==='ebay' && ebayBrowserFailure.test(e.message);const kijijiBrowserError=source==='kijiji' && kijijiBrowserFailure.test(e.message);const message=/HTTP 403/.test(e.message)?'eBay refused the request (HTTP 403). Retrying in 5 minutes.':temporaryEbayError?'eBay returned an error page. Retrying in 5 minutes.':ebayBrowserError?'Firefox lost its connection or a tab; eBay will retry on the next search.':kijijiBrowserError?'Firefox lost its connection or a tab; Kijiji will retry on the next search.':e.message.slice(0,1000);await finish(monitor,source,'error',message,temporaryEbayError?300:null);} }
      finally { profiles.release(source); }
  }
  async function finish(monitor,source,status,error,retrySeconds=null) {
    if(source==='facebook' && /Facebook temporarily blocked access/i.test(error||'')){
      error=error.replace(/^(?:facebook_search_test\.)?FacebookTemporarilyBlocked:\s*/, '');
      retrySeconds=3600;
      await pool.query("UPDATE search_source_schedule SET blocked_until=DATE_ADD(NOW(3),INTERVAL 1 HOUR) WHERE source='facebook'");
      await pool.query("UPDATE monitor_runs r JOIN monitors m ON m.id=r.monitor_id SET r.status='error',r.error='Facebook temporarily blocked access. Check the Facebook source browser. Retrying in 1 hour.',r.next_run=DATE_ADD(NOW(),INTERVAL 1 HOUR) WHERE r.source='facebook' AND m.enabled=1 AND r.monitor_id<>? AND r.status<>'searching'",[monitor.id]);
    }
    if(source==='ebay' && /HTTP 403/.test(error||'')){
      status='waiting';
      const rows=await pool.query("SELECT consecutive_403 FROM search_source_schedule WHERE source='ebay'");
      const failures=Number(rows[0]?.consecutive_403||0);
      retrySeconds=ebayBackoffSeconds(failures);
      error=error.replace(/Retrying in 5 minutes\./,`Retrying in ${retryTimeText(retrySeconds)}.`);
      await pool.query("UPDATE search_source_schedule SET consecutive_403=consecutive_403+1,blocked_until=DATE_ADD(NOW(3),INTERVAL ? SECOND) WHERE source='ebay'",[retrySeconds]);
    }else if(source==='ebay' && status==='ready')await pool.query("UPDATE search_source_schedule SET consecutive_403=0,blocked_until=NULL WHERE source='ebay'");
    else if(source==='facebook' && status==='ready')await pool.query("UPDATE search_source_schedule SET blocked_until=NULL WHERE source='facebook'");
    await pool.query('UPDATE monitor_runs SET status=?,error=?,last_checked=NOW(),next_run=DATE_ADD(NOW(),INTERVAL ? SECOND) WHERE monitor_id=? AND source=? AND EXISTS (SELECT 1 FROM monitors WHERE id=? AND enabled=1 AND revision=?)',[status,error,retrySeconds ?? 300,monitor.id,source,monitor.id,Number(monitor.revision)]);
  }
  timer=setTimeout(tick,1000);
  function cancel(job) {job.cancelled=true;if(job.child && job.child.pid)try{process.kill(-job.child.pid,'SIGTERM');}catch{}}
  const stop=() => { stopped=true;clearTimeout(timer);for(const job of active.values())cancel(job); };
  stop.cancel=id=>{for(const job of active.values())if(job.id===Number(id))cancel(job);};
  return stop;
}
module.exports={init,start,validateMonitor,runScript,chooseNext,failureMessage,ebayBackoffSeconds,retryTimeText,stopProcessGroup};
