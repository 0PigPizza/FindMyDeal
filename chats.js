const {spawn}=require('child_process');
const path=require('path');
async function init(pool){
 await pool.query("ALTER TABLE monitors ADD COLUMN IF NOT EXISTS chat_message TEXT NULL");
 await pool.query(`CREATE TABLE IF NOT EXISTS chat_deliveries (deal_id INT UNSIGNED NOT NULL PRIMARY KEY, monitor_id INT UNSIGNED NULL, message TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', error TEXT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE, FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE SET NULL)`);
 await pool.query("CREATE TABLE IF NOT EXISTS chat_limits (source VARCHAR(16) NOT NULL PRIMARY KEY, max_per_hour INT UNSIGNED NULL)");
 await pool.query("INSERT IGNORE INTO chat_limits (source) VALUES ('kijiji'),('facebook')");
 await pool.query("CREATE TABLE IF NOT EXISTS chat_hourly_counts (source VARCHAR(16) NOT NULL, hour_bucket BIGINT UNSIGNED NOT NULL, attempts INT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY(source,hour_bucket))");
 // Seed the current hour from existing delivery history when upgrading.
 await pool.query("INSERT IGNORE INTO chat_hourly_counts(source,hour_bucket,attempts) SELECT d.source,FLOOR(UNIX_TIMESTAMP()/3600),COUNT(*) FROM chat_deliveries c JOIN deals d ON d.id=c.deal_id WHERE d.source IN ('kijiji','facebook') AND c.status IN ('sent','sending','unknown') AND FLOOR(UNIX_TIMESTAMP(c.updated_at)/3600)=FLOOR(UNIX_TIMESTAMP()/3600) GROUP BY d.source");
 await pool.query("UPDATE chat_deliveries SET status='unknown',error='The app stopped during delivery. Check the marketplace before sending again.' WHERE status='sending'");
 // This specific old Facebook failure happened before the send button was clicked.
 await pool.query("UPDATE chat_deliveries c JOIN deals d ON d.id=c.deal_id SET c.status='pending',c.error=NULL WHERE c.status='unknown' AND d.source='facebook' AND c.error='Could not identify this listing’s message box. Check the listing in Sources.'");
}
async function enqueue(pool,row){
 if(!['facebook','kijiji'].includes(row.source))return;
 await pool.query(`INSERT IGNORE INTO chat_deliveries (deal_id,monitor_id,message) SELECT d.id,m.id,m.chat_message FROM deals d JOIN monitors m ON m.id=? JOIN ai_reviews r ON r.deal_id=d.id AND r.monitor_id=m.id WHERE d.id=? AND d.source IN ('facebook','kijiji') AND m.enabled=1 AND m.chat_message IS NOT NULL AND LENGTH(TRIM(m.chat_message))>0 AND r.verdict='deal'`,[row.monitor_id,row.deal_id]);
}
async function claim(pool,row){
 const conn=await pool.getConnection();
 try{
  await conn.beginTransaction();
  const limits=await conn.query('SELECT max_per_hour FROM chat_limits WHERE source=? FOR UPDATE',[row.source]);
  if(!limits.length){await conn.rollback();return false;}
  const counts=await conn.query('SELECT attempts FROM chat_hourly_counts WHERE source=? AND hour_bucket=FLOOR(UNIX_TIMESTAMP()/3600)',[row.source]);
  if(limits[0].max_per_hour!==null && Number(counts[0]?.attempts||0)>=Number(limits[0].max_per_hour)){await conn.rollback();return false;}
  const claimed=await conn.query("UPDATE chat_deliveries c JOIN monitors m ON m.id=c.monitor_id JOIN ai_reviews r ON r.deal_id=c.deal_id AND r.monitor_id=c.monitor_id SET c.status='sending',c.error=NULL WHERE c.deal_id=? AND c.status='pending' AND m.enabled=1 AND m.chat_message IS NOT NULL AND r.verdict='deal'",[row.deal_id]);
  if(!claimed.affectedRows){await conn.rollback();return false;}
  await conn.query('INSERT INTO chat_hourly_counts(source,hour_bucket,attempts) VALUES (?,FLOOR(UNIX_TIMESTAMP()/3600),1) ON DUPLICATE KEY UPDATE attempts=attempts+1',[row.source]);
  await conn.commit();return true;
 }catch(e){await conn.rollback();throw e;}finally{conn.release();}
}
function routes(app,pool){
 app.get('/api/chat-limits',async(req,res)=>{try{const rows=await pool.query("SELECT l.source,l.max_per_hour,COALESCE(c.attempts,0) AS attempts FROM chat_limits l LEFT JOIN chat_hourly_counts c ON c.source=l.source AND c.hour_bucket=FLOOR(UNIX_TIMESTAMP()/3600) ORDER BY l.source");res.json(Object.fromEntries(rows.map(row=>[row.source,{limit:row.max_per_hour,attempts:Number(row.attempts)}])));}catch{res.status(503).json({error:'Could not load message limits.'});}});
 app.put('/api/chat-limits',async(req,res)=>{const body=req.body||{};if(!['kijiji','facebook'].every(k=>body[k]===null||(Number.isSafeInteger(body[k])&&body[k]>=0&&body[k]<=10000)))return res.status(400).json({error:'Enter a whole number from 0 to 10000, or leave the limit blank.'});try{await pool.query("UPDATE chat_limits SET max_per_hour=CASE source WHEN 'kijiji' THEN ? WHEN 'facebook' THEN ? END WHERE source IN ('kijiji','facebook')",[body.kijiji,body.facebook]);res.json({ok:true});}catch{res.status(503).json({error:'Could not save message limits.'});}});
 app.get('/api/chats',async(req,res)=>{try{const monitors=await pool.query('SELECT id,search_term,marketplaces,chat_message FROM monitors ORDER BY id');const deliveries=await pool.query('SELECT c.deal_id,c.monitor_id,c.message,c.status,c.error,c.updated_at,d.title,d.source,d.url FROM chat_deliveries c JOIN deals d ON d.id=c.deal_id ORDER BY c.created_at DESC LIMIT 100');res.json({monitors,deliveries});}catch{res.status(503).json({error:'Could not load chats.'});}});
 app.put('/api/chats/:id',async(req,res)=>{const id=Number(req.params.id),message=req.body?.message;if(!Number.isSafeInteger(id)||id<1||typeof message!=='string'||message.length>2000)return res.status(400).json({error:'Invalid message.'});try{const result=await pool.query('UPDATE monitors SET chat_message=? WHERE id=?',[message.trim()||null,id]);if(!result.affectedRows){const rows=await pool.query('SELECT id FROM monitors WHERE id=?',[id]);if(!rows.length)return res.status(404).json({error:'Monitor not found.'});}res.json({ok:true});}catch{res.status(503).json({error:'Could not save message.'});}});
}
function start(pool,profiles,runner=run){let stopped=false,timer,child;async function tick(){try{const rows=await pool.query("SELECT c.deal_id,c.monitor_id,c.message,d.source,d.url FROM chat_deliveries c JOIN deals d ON d.id=c.deal_id JOIN monitors m ON m.id=c.monitor_id JOIN ai_reviews r ON r.deal_id=c.deal_id AND r.monitor_id=c.monitor_id JOIN chat_limits l ON l.source=d.source LEFT JOIN chat_hourly_counts h ON h.source=d.source AND h.hour_bucket=FLOOR(UNIX_TIMESTAMP()/3600) WHERE c.status='pending' AND m.enabled=1 AND m.chat_message IS NOT NULL AND r.verdict='deal' AND (l.max_per_hour IS NULL OR COALESCE(h.attempts,0)<l.max_per_hour) ORDER BY c.created_at LIMIT 20");for(const row of rows){if(stopped)break;if(!profiles.tryAcquire(row.source))continue;try{if(!await claim(pool,row))continue;try{await runner(row,c=>{child=c;});await pool.query("UPDATE chat_deliveries SET status='sent' WHERE deal_id=?",[row.deal_id]);await pool.query("UPDATE deals SET listing_status='messaged' WHERE id=? AND listing_status='unmarked'",[row.deal_id]);}catch(e){await pool.query("UPDATE chat_deliveries SET status='unknown',error=? WHERE deal_id=?",[String(e.message).slice(0,500),row.deal_id]);}finally{child=null;}}finally{profiles.release(row.source);}break;}}catch(e){if(!stopped)console.error('Chat worker:',e.message);}finally{if(!stopped)timer=setTimeout(tick,5000);}}timer=setTimeout(tick,1000);return()=>{stopped=true;clearTimeout(timer);if(child)try{process.kill(-child.pid,'SIGTERM');}catch{}};}
function run(row,setChild){return new Promise((resolve,reject)=>{const child=spawn('python3',[path.join(__dirname,'scripts/send-chat.py')],{stdio:['pipe','ignore','pipe'],detached:true});setChild(child);let err='';child.stderr.on('data',x=>{err=(err+x).slice(-2000);});const timeout=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}},180000);child.on('error',e=>{clearTimeout(timeout);reject(e);});child.on('close',code=>{clearTimeout(timeout);code===0?resolve():reject(Error(err.trim()||'Delivery could not be confirmed. Check the marketplace.'));});child.stdin.end(JSON.stringify({source:row.source,url:row.url,message:row.message}));});}
module.exports={init,enqueue,routes,start,run,claim};
