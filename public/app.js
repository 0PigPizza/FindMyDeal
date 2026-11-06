const dialog = document.querySelector('#monitorDialog');
window.confirmAction=(title,message,action)=>new Promise(resolve=>{
  const box=document.querySelector('#confirmDialog');
  document.querySelector('#confirmTitle').textContent=title;
  document.querySelector('#confirmMessage').textContent=message;
  document.querySelector('#confirmAccept').textContent=action;
  box.returnValue='cancel';
  box.addEventListener('close',()=>resolve(box.returnValue==='confirm'),{once:true});
  box.showModal();
  document.querySelector('#confirmCancel').focus();
});
document.querySelector('#confirmCancel').addEventListener('click',()=>document.querySelector('#confirmDialog').close('cancel'));
document.querySelector('#confirmAccept').addEventListener('click',()=>document.querySelector('#confirmDialog').close('confirm'));
const form = document.querySelector('#monitorForm');
const grid = document.querySelector('#grid');
const formError = document.querySelector('#formError');
let editingId=null;
document.querySelectorAll('.new-monitor').forEach(button => button.addEventListener('click', () => { editingId=null; form.reset(); syncDropdowns(); formError.hidden = true; document.querySelector('#monitorTitle').textContent='New monitor'; document.querySelector('#monitorSave').textContent='Save monitor'; document.querySelector('#monitorNote').textContent='Monitoring starts after saving.'; dialog.showModal(); }));
document.querySelectorAll('.close,.cancel').forEach(button => button.addEventListener('click', () => dialog.close()));
const logos = { 'Kijiji': '/logos/kijiji.png', 'eBay': '/logos/ebay.svg', 'Facebook Marketplace': '/logos/facebook.svg' };
const dropdowns = [];
for (const select of form.querySelectorAll('select')) {
  const container = document.createElement('div'); container.className = 'custom-dropdown';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'dropdown-button'; button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
  const list = document.createElement('div'); list.className = 'dropdown-list'; list.setAttribute('role', 'listbox'); list.hidden = true;
  const label = select.getAttribute('aria-label') || (select.name === 'sortBy' ? 'Sort listings by' : 'Time between searches unit'); button.setAttribute('aria-label', label); list.setAttribute('aria-label', label);
  for (const option of select.options) {
    const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'option'); item.textContent = option.textContent; item.dataset.value = option.value;
    item.addEventListener('click', () => { select.value = option.value; update(); close(); button.focus(); }); list.append(item);
  }
  function update() { button.textContent = select.selectedOptions[0].textContent; for (const item of list.children) item.setAttribute('aria-selected', String(item.dataset.value === select.value)); }
  function close() { list.hidden = true; button.setAttribute('aria-expanded', 'false'); }
  button.addEventListener('click', () => { const opening = list.hidden; for (const dropdown of dropdowns) dropdown.close(); list.hidden = !opening; button.setAttribute('aria-expanded', String(opening)); });
  container.addEventListener('keydown', event => { if (event.key === 'Escape') { close(); button.focus(); } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const items = [...list.children]; if (list.hidden) { list.hidden = false; button.setAttribute('aria-expanded', 'true'); items.find(item => item.dataset.value === select.value).focus(); } else { const current = items.indexOf(document.activeElement); items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); } } });
  select.before(container); container.append(button, list); select.hidden = true; dropdowns.push({ update, close }); update();
}
function syncDropdowns() { dropdowns.forEach(dropdown => { dropdown.update(); dropdown.close(); }); }
document.addEventListener('click', event => { if (!event.target.closest('.custom-dropdown')) dropdowns.forEach(dropdown => dropdown.close()); });

const monitorIcons={
  start:'<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  stop:'<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  edit:'<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  delete:'<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'
};
function setMonitorIcon(button,name,label){
  button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${monitorIcons[name]}</svg>`;
  button.title=label;
}
let monitorStatuses=[];
function render(monitors) {
  grid.querySelectorAll('.monitor-card').forEach(card => card.remove());
  for (const monitor of monitors) {
    const card = document.createElement('article'); card.className = 'monitor-card';
    const top = document.createElement('div'); top.className = 'card-top';
    for (const marketplace of monitor.marketplaces) { const logo = document.createElement('img'); logo.className = 'card-logo'; logo.src = logos[marketplace]; logo.alt = marketplace; top.append(logo); } const title=document.createElement('h3'); title.textContent=monitor.search_term;
    const sub=document.createElement('div'); sub.className='card-sub'; sub.textContent=monitor.marketplaces.join(' · ');
    const bottom=document.createElement('div'); bottom.className='card-bottom'; const status=document.createElement('span'); const runs=monitorStatuses.filter(run=>run.monitor_id===monitor.id); status.textContent=!monitor.enabled?'Stopped':runs.some(run=>run.status==='searching')?'Searching':runs.some(run=>run.status==='error')?'Needs attention':runs.some(run=>run.status==='ready')?'Monitoring':'Waiting'; const interval=document.createElement('span'); interval.textContent=`${{low:"Low",normal:"Normal",high:"High"}[monitor.priority] || "Normal"} priority`; bottom.append(status,interval); card.append(top,title,sub,bottom); for(const run of runs.filter(run=>run.error)){const message=document.createElement('p');message.className=run.status==='waiting'?'monitor-notice':'monitor-error';message.textContent=`${{facebook:'Facebook',kijiji:'Kijiji',ebay:'eBay'}[run.source]}: ${run.error}`;card.append(message);}
    const actions=document.createElement('div');actions.className='monitor-actions';
    const toggle=document.createElement('button');toggle.type='button';setMonitorIcon(toggle,monitor.enabled?'stop':'start',monitor.enabled?'Stop':'Start');toggle.className=monitor.enabled?'monitor-stop':'monitor-start';toggle.setAttribute('aria-label',`${monitor.enabled?'Stop':'Start'} ${monitor.search_term} monitor`);
    toggle.addEventListener('click',async()=>{toggle.disabled=true;try{const res=await fetch(`/api/monitors/${monitor.id}/state`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!monitor.enabled})});if(!res.ok)throw Error((await res.json()).error);await load();}catch(e){showError(e.message);}finally{toggle.disabled=false;}});
    const edit=document.createElement('button');edit.type='button';setMonitorIcon(edit,'edit','Edit');edit.setAttribute('aria-label',`Edit ${monitor.search_term} monitor`);edit.addEventListener('click',()=>editMonitor(monitor));
    const remove=document.createElement('button');remove.type='button';setMonitorIcon(remove,'delete','Delete');remove.setAttribute('aria-label',`Delete ${monitor.search_term} monitor`);remove.addEventListener('click',async()=>{if(!await window.confirmAction('Delete monitor?',`Delete “${monitor.search_term}”? Listings found only by this monitor will no longer appear in Deals.`,'Delete monitor'))return;remove.disabled=true;try{const res=await fetch(`/api/monitors/${monitor.id}`,{method:'DELETE'});if(!res.ok)throw Error((await res.json()).error);await load();if(window.refreshDeals)window.refreshDeals();}catch(e){showError(e.message);}finally{remove.disabled=false;}});
    actions.append(toggle,edit,remove);card.append(actions);grid.insertBefore(card,grid.lastElementChild);
  }
  for(const id of ['monitorCount','navCount','sectionCount']) document.getElementById(id).textContent=monitors.length;
}
function editMonitor(monitor) {
  editingId=monitor.id;form.reset();formError.hidden=true;
  form.elements.searchTerm.value=monitor.search_term;
  for(const input of form.querySelectorAll('input[name="marketplace"]'))input.checked=monitor.marketplaces.includes(input.value);
  form.elements.minPrice.value=monitor.min_price ?? '';form.elements.maxPrice.value=monitor.max_price ?? '';
  form.elements.maxDistance.value=monitor.max_distance ?? '';form.elements.sortBy.value=monitor.sort_by;form.elements.maxItems.value=monitor.max_items ?? 30;
  form.elements.aiPrompt.value=monitor.ai_prompt || '';
  const filters=monitor.filters || {};form.elements.includeKeywords.value=filters.include || '';form.elements.excludeKeywords.value=filters.exclude || '';form.elements.keywordMatch.value=filters.match || 'all';form.elements.keywordScope.value=filters.scope || 'title';form.elements.condition.value=filters.condition || 'any';form.elements.requirePrice.checked=!!filters.requirePrice;form.elements.requirePhoto.checked=!!filters.requirePhoto;
  form.elements.priority.value=monitor.priority || 'normal';syncDropdowns();
  document.querySelector('#monitorTitle').textContent='Edit monitor';document.querySelector('#monitorSave').textContent='Save changes';document.querySelector('#monitorNote').textContent=monitor.enabled?'Monitoring will restart with the new settings.':'This monitor will stay stopped.';
  dialog.showModal();
}
function showError(message) { const error=document.querySelector('#error'); error.textContent=message; error.hidden=false; }
async function load() { try { const [res,statusRes]=await Promise.all([fetch('/api/monitors'),fetch('/api/monitor-status')]); const data=await res.json(); if(!res.ok) throw new Error(data.error); monitorStatuses=statusRes.ok?await statusRes.json():[]; document.querySelector('#error').hidden=true; render(data); } catch(e) { showError(e.message || 'Could not load monitors.'); } }
form.addEventListener('submit', async event => {
  event.preventDefault(); formError.hidden=true;
  const marketplaces=[...form.querySelectorAll('input[name="marketplace"]:checked')].map(input=>input.value);
  const numberOrNull = value => value === '' ? null : Number(value);
  const data={searchTerm:form.elements.searchTerm.value, marketplaces, minPrice:numberOrNull(form.elements.minPrice.value), maxPrice:numberOrNull(form.elements.maxPrice.value), latitude:null, longitude:null, maxItems:Number(form.elements.maxItems.value), maxDistance:numberOrNull(form.elements.maxDistance.value), sortBy:form.elements.sortBy.value, priority:form.elements.priority.value,aiPrompt:form.elements.aiPrompt.value,filters:{include:form.elements.includeKeywords.value,exclude:form.elements.excludeKeywords.value,match:form.elements.keywordMatch.value,scope:form.elements.keywordScope.value,condition:form.elements.condition.value,requirePrice:form.elements.requirePrice.checked,requirePhoto:form.elements.requirePhoto.checked}};
  if(!marketplaces.length) { formError.textContent='Choose at least one marketplace.'; formError.hidden=false; return; }
  const submit=form.querySelector('[type="submit"]'); submit.disabled=true;
  try { const response=await fetch(editingId===null?'/api/monitors':`/api/monitors/${editingId}`,{method:editingId===null?'POST':'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); const result=await response.json(); if(!response.ok) throw new Error(result.error || 'Could not save monitor.'); dialog.close(); await load(); } catch(e) { formError.textContent=e.message; formError.hidden=false; } finally { submit.disabled=false; }
});
const searchSettings=document.querySelector('#searchSettings'),searchSettingsMessage=document.querySelector('#searchSettingsMessage');
async function loadSearchSettings(){try{const res=await fetch('/api/search-settings');const data=await res.json();if(!res.ok)throw Error(data.error);searchSettings.elements.delaySeconds.value=data.delaySeconds;}catch(e){searchSettingsMessage.textContent=e.message;}}
searchSettings.addEventListener('submit',async event=>{event.preventDefault();try{const res=await fetch('/api/search-settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({delaySeconds:Number(searchSettings.elements.delaySeconds.value)})});const data=await res.json();if(!res.ok)throw Error(data.error);searchSettingsMessage.textContent='Saved';}catch(e){searchSettingsMessage.textContent=e.message;}});
loadSearchSettings();
load();
setInterval(()=>{if(!document.hidden && !dialog.open)load();},10000);
