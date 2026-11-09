// HTTP routes are registered separately from process startup.
module.exports = function registerRoutes(app, { pool, worker, ai, alerts, dealFilters, getWorker }) {
function validate(b) {
  const marketplaces = ['Kijiji', 'eBay', 'Facebook Marketplace'];
  if (typeof b.searchTerm !== 'string' || !b.searchTerm.trim() || b.searchTerm.trim().length > 150) return 'Enter a search term (up to 150 characters).';
  if (!Array.isArray(b.marketplaces) || !b.marketplaces.length || b.marketplaces.some(x => !marketplaces.includes(x)) || new Set(b.marketplaces).size !== b.marketplaces.length) return 'Choose at least one marketplace.';
  if (!Number.isInteger(b.maxItems) || b.maxItems < 1 || b.maxItems > 30) return 'Maximum items must be between 1 and 30.';
  const filterError=dealFilters.validate(b.filters);if(filterError)return filterError;
  if(b.aiPrompt!==undefined && (typeof b.aiPrompt!=='string' || b.aiPrompt.length>4000))return 'AI prompt must be 4,000 characters or less.';
  for (const key of ['minPrice','maxPrice']) if (b[key] !== null && (typeof b[key] !== 'number' || !Number.isFinite(b[key]) || b[key] < 0 || b[key] > 9999999999.99 || Math.abs(Math.round(b[key] * 100) - b[key] * 100) > 1e-7)) return 'Prices must be non-negative numbers with at most two decimal places.';
  if (b.minPrice !== null && b.maxPrice !== null && b.minPrice > b.maxPrice) return 'Minimum price cannot exceed maximum price.';
  if (b.maxDistance !== null && (!Number.isInteger(b.maxDistance) || b.maxDistance < 1 || b.maxDistance > 100000)) return 'Distance must be between 1 and 100,000 km.';
  if (!['suggested','date'].includes(b.sortBy)) return 'Choose a valid sort method.';
  if (!['low','normal','high'].includes(b.priority)) return 'Choose a valid monitor priority.';
  if ((b.latitude === null) !== (b.longitude === null) || (b.latitude !== null && (typeof b.latitude !== 'number' || typeof b.longitude !== 'number' || !Number.isFinite(b.latitude) || !Number.isFinite(b.longitude) || Math.abs(b.latitude) > 90 || Math.abs(b.longitude) > 180))) return 'Invalid coordinates.';
  return worker.validateMonitor(b);
}
app.get('/api/search-settings',async(req,res)=>{try{const rows=await pool.query('SELECT delay_seconds FROM search_settings WHERE id=1');res.json({delaySeconds:Number(rows[0].delay_seconds)});}catch(e){res.status(503).json({error:'Could not load search settings.'});}});
app.put('/api/search-settings',async(req,res)=>{const delay=req.body?.delaySeconds;if(!Number.isInteger(delay)||delay<1||delay>86400)return res.status(400).json({error:'Delay must be between 1 and 86,400 seconds.'});try{await pool.query('UPDATE search_settings SET delay_seconds=? WHERE id=1',[delay]);res.json({delaySeconds:delay});}catch(e){res.status(503).json({error:'Could not save search settings.'});}});
app.get('/api/monitors', async (req,res) => { try { const rows = await pool.query('SELECT * FROM monitors ORDER BY created_at DESC, id DESC'); res.json(rows.map(r => ({...r, marketplaces: JSON.parse(r.marketplaces),filters:dealFilters.parse(r.filter_options)}))); } catch(e) { console.error(e); res.status(503).json({error:'Could not load monitors. Check the MariaDB connection.'}); }});
app.post('/api/monitors', async (req,res) => { const b=req.body || {}; const error=validate(b); if(error) return res.status(400).json({error}); try { const result=await pool.query('INSERT INTO monitors (search_term, marketplaces, min_price, max_price, location, latitude, longitude, max_distance, sort_by, interval_seconds, max_items,filter_options,ai_prompt,priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [b.searchTerm.trim(), JSON.stringify(b.marketplaces), b.minPrice, b.maxPrice, '', null, null, b.maxDistance, b.sortBy, 1800, b.maxItems,JSON.stringify(dealFilters.parse(b.filters)),b.aiPrompt || '',b.priority]); res.status(201).json({id:Number(result.insertId)}); } catch(e) { console.error(e); res.status(503).json({error:'Could not save monitor. Check the MariaDB connection.'}); }});
app.put('/api/monitors/:id', async (req,res) => {
  if(!/^\d+$/.test(req.params.id)) return res.status(400).json({error:'Invalid monitor ID.'});
  const b=req.body || {}, error=validate(b); if(error) return res.status(400).json({error});
  let connection;
  try {
    connection=await pool.getConnection(); await connection.beginTransaction();
    const previous=await connection.query('SELECT search_term,filter_options,ai_prompt FROM monitors WHERE id=? FOR UPDATE',[req.params.id]);
    if(!previous.length){await connection.rollback();return res.status(404).json({error:'Monitor not found.'});}
    const result=await connection.query('UPDATE monitors SET search_term=?,marketplaces=?,min_price=?,max_price=?,max_distance=?,sort_by=?,max_items=?,filter_options=?,ai_prompt=?,priority=?,schedule_pass=NULL,revision=revision+1 WHERE id=?',[b.searchTerm.trim(),JSON.stringify(b.marketplaces),b.minPrice,b.maxPrice,b.maxDistance,b.sortBy,b.maxItems,JSON.stringify(dealFilters.parse(b.filters ?? previous[0].filter_options)),b.aiPrompt ?? previous[0].ai_prompt ?? '',b.priority,req.params.id]);
    if(!result.affectedRows){await connection.rollback();return res.status(404).json({error:'Monitor not found.'});}
    if(previous[0].search_term.trim().toLowerCase()!==b.searchTerm.trim().toLowerCase()) await connection.query('DELETE FROM deal_matches WHERE monitor_id=?',[req.params.id]);
    await connection.query('DELETE FROM monitor_runs WHERE monitor_id=?',[req.params.id]); await connection.commit();
    getWorker().cancel(req.params.id); res.json({ok:true});
  } catch(e) { if(connection) await connection.rollback().catch(()=>{}); console.error(e); res.status(503).json({error:'Could not update monitor.'}); }
  finally { if(connection) connection.release(); }
});
app.patch('/api/monitors/:id/state', async (req,res) => {
  if(!/^\d+$/.test(req.params.id) || typeof req.body?.enabled!=='boolean') return res.status(400).json({error:'Invalid monitor state.'});
  let connection;
  try {
    connection=await pool.getConnection();await connection.beginTransaction();
    const monitors=await connection.query('SELECT id,enabled FROM monitors ORDER BY id FOR UPDATE');
    const current=monitors.find(m=>Number(m.id)===Number(req.params.id));
    if(!current){await connection.rollback();return res.status(404).json({error:'Monitor not found.'});}
    const wasEnabled=Number(current.enabled)===1;
    const enabledBefore=monitors.filter(m=>Number(m.enabled)===1).length;
    await connection.query('UPDATE monitors SET enabled=?,schedule_pass=NULL,revision=revision+1 WHERE id=?',[req.body.enabled?1:0,req.params.id]);
    await connection.query('UPDATE monitor_runs SET status=?,error=NULL,next_run=NOW(),schedule_pass=NULL WHERE monitor_id=?',[req.body.enabled?'waiting':'paused',req.params.id]);
    if(wasEnabled!==req.body.enabled && (enabledBefore===0 || (enabledBefore===1 && wasEnabled && !req.body.enabled))) {
      await connection.query('UPDATE search_source_schedule SET last_finished=NULL');
    }
    await connection.commit();getWorker().cancel(req.params.id);res.json({ok:true});
  } catch(e) { if(connection) await connection.rollback().catch(()=>{});console.error(e);res.status(503).json({error:'Could not change monitor state.'}); }
  finally { if(connection) connection.release(); }
});
const aiRows=`SELECT d.id,d.id AS deal_id,d.source,d.url,d.title,d.price,d.description,d.item_condition,d.listing_status,d.first_seen,d.last_seen,d.thumbnail IS NOT NULL AS has_image,m.id AS monitor_id,m.search_term,m.marketplaces,m.min_price,m.max_price,m.max_distance,m.sort_by,m.max_items,m.interval_seconds,m.filter_options,m.ai_prompt AS monitor_prompt,dm.ai_prompt AS item_prompt,r.fingerprint AS reviewed_fingerprint,r.verdict,r.reason,r.error AS ai_error FROM deals d JOIN deal_matches dm ON dm.deal_id=d.id JOIN monitors m ON m.id=dm.monitor_id LEFT JOIN ai_reviews r ON r.deal_id=d.id AND r.monitor_id=m.id`;
function reviewed(row,settings){if(!dealFilters.matches(row,row.filter_options))return {status:'not_reviewed',reason:null,error:null};if(!settings.enabled || !settings.apiKey)return {status:'disabled',reason:null,error:null};let matches=false;try{matches=ai.matchesFingerprint(row,settings);}catch{}return {status:matches?(row.verdict || 'pending'):'pending',reason:matches?row.reason:null,error:matches?row.ai_error:null};}
app.get('/api/deals/summary', async (req,res) => {try{const kind=req.query.kind==='items'?'items':'deals';const monitors=await pool.query('SELECT id FROM monitors');const rows=await pool.query(aiRows);const settings=ai.getSettings();const counts=new Map(monitors.map(m=>[m.id,0]));for(const row of rows)if(kind==='items'||(dealFilters.matches(row,row.filter_options)&&reviewed(row,settings).status==='deal'))counts.set(row.monitor_id,counts.get(row.monitor_id)+1);res.json([...counts].map(([id,deal_count])=>({id,deal_count})));}catch(e){console.error(e);res.status(503).json({error:'Could not load counts.'});}});
app.get('/api/alerts', (req,res)=>res.json(alerts.publicSettings()));
app.put('/api/alerts/:service',async(req,res)=>{try{const config=alerts.validate(req.params.service,req.body||{});await alerts.send(req.params.service,config,'FindMyDeal is connected. New deals will appear here.');const settings=alerts.getSettings();settings[req.params.service]=config;alerts.saveSettings(settings);res.json(alerts.publicSettings());}catch(e){res.status(400).json({error:e.message.startsWith('Enter ')||e.message.startsWith('Unknown ')||e.message.includes('rejected the message')?e.message:'Could not connect. Check your details and try again.'});}});
app.delete('/api/alerts/:service',(req,res)=>{if(!['discord','telegram'].includes(req.params.service))return res.status(400).json({error:'Unknown alert service.'});try{const settings=alerts.getSettings();delete settings[req.params.service];alerts.saveSettings(settings);res.json(alerts.publicSettings());}catch{res.status(503).json({error:'Could not disconnect alerts.'});}});
app.get('/api/ai/settings',(req,res)=>res.json(ai.publicSettings()));
app.put('/api/ai/settings',(req,res)=>{const b=req.body||{};if(typeof b.enabled!=='boolean'||typeof b.model!=='string'||(!b.model.endsWith(':free')&&b.model!=='openrouter/free')||b.model.length>200||typeof b.instructions!=='string'||b.instructions.length>4000||(b.apiKey!==undefined&&(typeof b.apiKey!=='string'||b.apiKey.length>500)))return res.status(400).json({error:'Enter a free model and valid AI settings.'});try{const current=ai.getSettings();ai.saveSettings({enabled:b.enabled,model:b.model.trim(),instructions:b.instructions,apiKey:b.apiKey?.trim()||current.apiKey});res.json(ai.publicSettings());}catch(e){console.error(e);res.status(503).json({error:'Could not save AI settings.'});}});
app.put('/api/monitors/:id/items/:deal/prompt',async(req,res)=>{if(!/^\d+$/.test(req.params.id)||!/^\d+$/.test(req.params.deal)||typeof req.body?.prompt!=='string'||req.body.prompt.length>2000)return res.status(400).json({error:'Invalid item prompt.'});try{const result=await pool.query('UPDATE deal_matches SET ai_prompt=? WHERE monitor_id=? AND deal_id=?',[req.body.prompt,req.params.id,req.params.deal]);if(!result.affectedRows){const rows=await pool.query('SELECT 1 FROM deal_matches WHERE monitor_id=? AND deal_id=?',[req.params.id,req.params.deal]);if(!rows.length)return res.status(404).json({error:'Item not found.'});}res.json({ok:true});}catch(e){res.status(503).json({error:'Could not save item prompt.'});}});
app.delete('/api/monitors/:id/deals', async (req,res) => {
  if(!/^\d+$/.test(req.params.id)) return res.status(400).json({error:'Invalid monitor ID.'});
  let connection;
  try {
    connection=await pool.getConnection();await connection.beginTransaction();
    const result=await connection.query('UPDATE monitors SET revision=revision+1 WHERE id=?',[req.params.id]);
    if(!result.affectedRows){await connection.rollback();return res.status(404).json({error:'Monitor not found.'});}
    await connection.query('DELETE FROM deal_matches WHERE monitor_id=?',[req.params.id]);
    await connection.query("UPDATE monitor_runs r JOIN monitors m ON m.id=r.monitor_id SET r.status=IF(m.enabled=1,'waiting','paused'),r.error=NULL,r.next_run=NOW() WHERE r.monitor_id=?",[req.params.id]);
    await connection.commit();getWorker().cancel(req.params.id);res.status(204).end();
  } catch(e) {if(connection)await connection.rollback().catch(()=>{});console.error(e);res.status(503).json({error:'Could not clear listings.'});}
  finally {if(connection)connection.release();}
});
app.delete('/api/deals', async (req,res) => {
  let connection;
  try {
    connection=await pool.getConnection();await connection.beginTransaction();
    const monitors=await connection.query('SELECT id FROM monitors FOR UPDATE');
    await connection.query('UPDATE monitors SET revision=revision+1');
    await connection.query('DELETE FROM deal_matches');
    await connection.query("UPDATE monitor_runs r JOIN monitors m ON m.id=r.monitor_id SET r.status=IF(m.enabled=1,'waiting','paused'),r.error=NULL,r.next_run=NOW()");
    await connection.commit();for(const monitor of monitors)getWorker().cancel(monitor.id);res.status(204).end();
  } catch(e) {if(connection)await connection.rollback().catch(()=>{});console.error(e);res.status(503).json({error:'Could not clear listings.'});}
  finally {if(connection)connection.release();}
});
app.put('/api/deals/:id/status',async(req,res)=>{
  const {status,automatic}=req.body||{};
  if(!/^\d+$/.test(req.params.id)||!['unmarked','messaged','refused','sold'].includes(status)||(automatic!==undefined&&typeof automatic!=='boolean')||(automatic&&status!=='messaged'))return res.status(400).json({error:'Invalid listing status.'});
  try{
    await pool.query(automatic?"UPDATE deals SET listing_status=IF(listing_status='unmarked',?,listing_status) WHERE id=?":'UPDATE deals SET listing_status=? WHERE id=?',[status,req.params.id]);
    const rows=await pool.query('SELECT listing_status FROM deals WHERE id=?',[req.params.id]);
    if(!rows.length)return res.status(404).json({error:'Listing not found.'});
    res.json({status:rows[0].listing_status});
  }catch(e){console.error(e);res.status(503).json({error:'Could not save listing status.'});}
});
app.get('/api/deals/:id/image', async(req,res)=>{if(!/^\d+$/.test(req.params.id))return res.sendStatus(400);try{const rows=await pool.query('SELECT thumbnail FROM deals WHERE id=? AND thumbnail IS NOT NULL',[req.params.id]);if(!rows.length)return res.sendStatus(404);res.type('image/jpeg').set('Cache-Control','private, max-age=86400').send(rows[0].thumbnail);}catch(e){res.sendStatus(503);}});
app.get('/api/deals', async (req,res) => {
  const monitor=req.query.monitor_id, source=req.query.source, listingStatus=req.query.status,kind=req.query.kind==='items'?'items':'deals';
  if(monitor!==undefined && !/^\d+$/.test(monitor)) return res.status(400).json({error:'Invalid monitor ID.'});
  if(source!==undefined && !['facebook','kijiji','ebay'].includes(source)) return res.status(400).json({error:'Invalid source.'});
  if(listingStatus!==undefined && !['unmarked','messaged','refused','sold'].includes(listingStatus)) return res.status(400).json({error:'Invalid listing status.'});
  try {const where=[],values=[];if(listingStatus!==undefined){where.push('d.listing_status=?');values.push(listingStatus);}if(monitor!==undefined){where.push('dm.monitor_id=?');values.push(monitor);}if(source!==undefined){where.push('d.source=?');values.push(source);}
    const rows=await pool.query(aiRows+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY d.first_seen DESC,d.id DESC',values),settings=ai.getSettings(),unique=new Map();
    for(const row of rows){const review=reviewed(row,settings);if(kind==='deals'&&(!dealFilters.matches(row,row.filter_options)||review.status!=='deal'))continue;if(!unique.has(row.id))unique.set(row.id,{id:row.id,source:row.source,url:row.source==='ebay'?row.url.replace(/^https:\/\/(?:www\.)?ebay\.com(?=\/|$)/i,'https://www.ebay.ca'):row.url,title:row.title,price:row.price,description:row.description,item_condition:row.item_condition,listing_status:row.listing_status,first_seen:row.first_seen,last_seen:row.last_seen,has_image:row.has_image,searches:row.search_term,ai_status:review.status,ai_reason:review.reason,ai_error:review.error,item_prompt:row.item_prompt||''});}
    res.json([...unique.values()]);
  }catch(e){console.error(e);res.status(503).json({error:'Could not load listings.'});}
});
app.get('/api/monitor-status', async (req,res) => { try {
  const rows=await pool.query(`SELECT r.monitor_id,r.source,r.status,r.last_checked,r.next_run AS monitor_due,
    q.blocked_until AS source_blocked_until,
    CASE WHEN m.enabled=1 AND r.schedule_pass IS NULL AND (SELECT COUNT(*) FROM monitors WHERE enabled=1)=1 AND (q.blocked_until IS NULL OR q.blocked_until<=NOW(3)) THEN r.next_run
    ELSE GREATEST(r.next_run,COALESCE(q.blocked_until,r.next_run),COALESCE(CASE WHEN q.source='ebay' AND q.consecutive_403>0 AND q.blocked_until IS NOT NULL THEN NULL ELSE DATE_ADD(q.last_finished,INTERVAL s.delay_seconds SECOND) END,r.next_run)) END AS next_run,
    r.error FROM monitor_runs r JOIN monitors m ON m.id=r.monitor_id JOIN search_source_schedule q ON q.source=r.source JOIN search_settings s ON s.id=1 ORDER BY r.monitor_id,r.source`);
  for(const row of rows) if(row.source_blocked_until && /Retrying in .*?\./i.test(row.error||'')) row.error=row.error.replace(/Retrying in .*?\./i,'Retry scheduled after the source block expires.');
  res.json(rows);
} catch(e) { res.status(503).json({error:'Could not load monitor status.'}); } });
app.delete('/api/monitors/:id', async (req,res) => { if(!/^\d+$/.test(req.params.id)) return res.status(400).json({error:'Invalid monitor ID.'}); try { const result=await pool.query('DELETE FROM monitors WHERE id = ?', [req.params.id]); if(!result.affectedRows) return res.status(404).json({error:'Monitor not found.'}); getWorker().cancel(req.params.id); res.status(204).end(); } catch(e) { console.error(e); res.status(503).json({error:'Could not delete monitor.'}); }});
};
