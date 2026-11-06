const automaticUpdates = document.querySelector('#automaticUpdates');
const updateStatus = document.querySelector('#updateStatus');
const checkUpdates = document.querySelector('#checkUpdates');
function showUpdateStatus(data) {
  automaticUpdates.checked = data.enabled;
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
