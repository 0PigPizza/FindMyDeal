import RFB from '/novnc/core/rfb.js';
const names={kijiji:'Kijiji',ebay:'eBay',facebook:'Facebook Marketplace'};
const id=new URLSearchParams(location.search).get('source');
const screen=document.querySelector('#vncScreen'), status=document.querySelector('#vncStatus');
let rfb=null, token=null, leaving=false, signInTimer=null, detectedCount=0;
document.querySelector('#sourceTitle').textContent=names[id] || 'Source browser';
document.title=`${names[id] || 'Source'} — FindMyDeal`;
async function openSource(){
  if(!names[id]){status.textContent='Unknown source.';return;}
  try{
    const response=await fetch(`/api/sources/${encodeURIComponent(id)}/open`,{method:'POST'});
    const data=await response.json();if(!response.ok)throw new Error(data.error);
    token=data.token;
    if(leaving){closeSession();return;}
    rfb=new RFB(screen,`ws://${location.host}/source-vnc?token=${encodeURIComponent(token)}`,{credentials:{password:data.password}});
    rfb.scaleViewport=true;rfb.resizeSession=false;rfb.showDotCursor=true;
    rfb.addEventListener('connect',()=>{status.textContent='Sign in in the browser above.'; if(['facebook','kijiji','ebay'].includes(id)) signInTimer=setInterval(checkSignIn,3000);});
    rfb.addEventListener('disconnect',()=>{if(!leaving)status.textContent='Browser disconnected.';});
  }catch(error){status.textContent=error.message;}
}
async function checkSignIn(){
  if(!token||leaving)return;
  try {
    const response=await fetch('/api/sources/session-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    if(!response.ok)return;
    const result=await response.json();
    detectedCount=result.status==='session-present'?detectedCount+1:0;
    if(detectedCount>=2){
      leaving=true; clearInterval(signInTimer); status.textContent=`${names[id]} session saved. Closing this tab…`;
      if(rfb)rfb.disconnect(); closeSession();
      setTimeout(()=>{window.close();status.textContent=`${names[id]} session saved. You can close this tab.`;},800);
    }
  } catch {}
}
function closeSession(){
  if(!token)return;
  navigator.sendBeacon('/api/sources/close',new Blob([JSON.stringify({token})],{type:'application/json'}));
  token=null;
}
document.querySelector('#doneSource').addEventListener('click',()=>{leaving=true;clearInterval(signInTimer);if(rfb)rfb.disconnect();closeSession();window.close();status.textContent='Browser closed. You can close this window.';});
window.addEventListener('pagehide',()=>{leaving=true;clearInterval(signInTimer);closeSession();});
openSource();
