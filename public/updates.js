const automaticUpdates = document.querySelector('#automaticUpdates');
const updateStatus = document.querySelector('#updateStatus');
const checkUpdates = document.querySelector('#checkUpdates');
const installUpdate = document.querySelector('#installUpdate');
function showUpdateStatus(data) {
  installUpdate.disabled = data.state !== 'available' || (data.container && !data.helperAvailable);
  automaticUpdates.checked = data.enabled;
  automaticUpdates.disabled = Boolean(data.container);
  document.querySelector('#updateHint').textContent = data.container ? (data.helperAvailable ? 'Install available releases using Update now.' : 'Container update helper is not installed; update through Docker Compose.') : 'Checks at startup and every six hours. Updates restart the app and require a clean main branch.';
  updateStatus.textContent = data.message + (data.checkedAt ? ` Last checked: ${new Date(data.checkedAt).toLocaleString()}.` : '');
}
window.loadUpdates = async () => {
  try { const response = await fetch('/api/updates'); if (!response.ok) throw Error('Could not load update status.'); showUpdateStatus(await response.json()); }
  catch (error) { updateStatus.textContent = error.message; }
};
automaticUpdates.addEventListener('change', async () => {
  automaticUpdates.disabled = true;
  try { const response = await fetch('/api/updates', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:automaticUpdates.checked})}); if (!response.ok) throw Error('Could not save update setting.'); showUpdateStatus(await response.json()); }
  catch (error) { automaticUpdates.checked = !automaticUpdates.checked; updateStatus.textContent = error.message; }
  finally { automaticUpdates.disabled = false; }
});
checkUpdates.addEventListener('click', async () => {
  checkUpdates.disabled = true; updateStatus.textContent = 'Checking GitHub for updates…';
  try { const response = await fetch('/api/updates/check', {method:'POST'}); if (!response.ok) throw Error('Could not check for updates.'); showUpdateStatus(await response.json()); }
  catch (error) { updateStatus.textContent = error.message; }
  finally { checkUpdates.disabled = false; }
});

installUpdate.addEventListener('click', async () => {
  installUpdate.disabled=true; updateStatus.textContent='Starting update…';
  try {const response=await fetch('/api/updates/install',{method:'POST'});if(!response.ok)throw Error('Could not start update.');showUpdateStatus(await response.json());}catch(error){updateStatus.textContent=error.message;}
});
setInterval(()=>{if(!document.querySelector('#updatesPage').hidden)window.loadUpdates();},3000);
