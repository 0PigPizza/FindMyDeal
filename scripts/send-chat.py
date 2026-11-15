#!/usr/bin/env python3
"""Send one initial message using the project's signed-in marketplace profile."""
import json, os, pathlib, socket, subprocess, sys, time
from urllib.parse import urlparse
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from facebook_search_test import WebDriver, RUNTIME, FIREFOX

VISIBLE = "const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);"

def main():
    data=json.load(sys.stdin); source=data['source']; url=data['url']; message=data['message']
    parsed=urlparse(url)
    if source not in ('facebook','kijiji') or parsed.scheme!='https' or parsed.hostname not in (('www.facebook.com','facebook.com') if source=='facebook' else ('www.kijiji.ca','kijiji.ca')):
        raise RuntimeError('Invalid marketplace listing URL.')
    profile=pathlib.Path(__file__).resolve().parent.parent / '.data/profiles' / source
    driver_bin=RUNTIME / 'bin/geckodriver'
    if not all(p.exists() for p in (profile,driver_bin,FIREFOX)): raise RuntimeError('Connect the marketplace in Sources first.')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    env=os.environ.copy();env['LD_LIBRARY_PATH']=f"{RUNTIME / 'lib'}:{env.get('LD_LIBRARY_PATH','')}"
    proc=subprocess.Popen([str(driver_bin),'--host','127.0.0.1','--port',str(port)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    driver=WebDriver(f'http://127.0.0.1:{port}')
    try:
        for _ in range(50):
            if proc.poll() is not None: raise RuntimeError('Could not start marketplace browser.')
            try: driver.request('GET','/status');break
            except Exception: time.sleep(.1)
        caps={'capabilities':{'alwaysMatch':{'browserName':'firefox','moz:firefoxOptions':{'binary':str(FIREFOX),'args':['-headless','-profile',str(profile)]},'pageLoadStrategy':'none'}}}
        driver.session=driver.request('POST','/session',caps)['sessionId'];driver.navigate(url)
        # Facebook can restore other conversations on a listing page. Only use a
        # composer whose conversation contains a link to this exact listing.
        if source == 'facebook':
            opener=driver.wait_for(VISIBLE+"return [...document.querySelectorAll('button,[role=button]')].find(e=>visible(e)&&/^message$/i.test((e.innerText||e.getAttribute('aria-label')||'').trim()))||null;",timeout=10)
            if opener: driver.click(opener)
            listing_id=parsed.path.strip('/').split('/')[-1]
            composer_script=VISIBLE+"""const id=arguments[0];
              for(const e of document.querySelectorAll('textarea,[contenteditable=true][role=textbox]')) {
                if(!visible(e))continue; let p=e;
                for(let i=0;p&&i<12;i++,p=p.parentElement) {
                  const fields=[...p.querySelectorAll('textarea,[contenteditable=true][role=textbox]')].filter(visible);
                  const links=[...p.querySelectorAll('a[href]')].filter(a=>a.href.includes('/marketplace/item/'+id));
                  if(fields.length===1&&links.length)return e;
                }
              } return null;"""
            composer=driver.wait_for(composer_script,timeout=20,args=(listing_id,))
        else:
            opener=driver.wait_for(VISIBLE+"return [...document.querySelectorAll('button,[role=button]')].find(e=>visible(e)&&/^(message|contact seller|reply)$/i.test((e.innerText||e.getAttribute('aria-label')||'').trim()))||null;",timeout=10)
            if opener: driver.click(opener)
            composer=driver.wait_for(VISIBLE+"const items=[...document.querySelectorAll('textarea')].filter(visible);return items.length===1?items[0]:null;",timeout=20)
        if not composer: raise RuntimeError('Could not identify this listing’s message box. Check the listing in Sources.')
        driver.type_text(composer,message)
        button=driver.wait_for(VISIBLE+"""const e=arguments[0]; let p=e;
          for(let i=0;p&&i<12;i++,p=p.parentElement){
            const fields=[...p.querySelectorAll('textarea,[contenteditable=true][role=textbox]')].filter(visible);
            const buttons=[...p.querySelectorAll('button,[role=button]')].filter(b=>visible(b)&&/^(send|send message)$/i.test((b.innerText||b.getAttribute('aria-label')||'').trim())&&!b.disabled&&b.getAttribute('aria-disabled')!=='true');
            if(fields.length===1&&buttons.length===1)return buttons[0];
          }return null;""",timeout=10,args=(composer,))
        if not button: raise RuntimeError('Send button not found. Check the listing in Sources.')
        driver.click(button)
        # An empty composer is evidence of submission; otherwise report an uncertain outcome.
        sent=driver.wait_for("const e=arguments[0];return !(e.value||e.innerText||'').trim();",timeout=10,args=(composer,))
        if not sent: raise RuntimeError('Delivery could not be confirmed. Check the marketplace before sending again.')
    finally:
        if driver.session:
            try: driver.request('DELETE',f'/session/{driver.session}')
            except Exception: pass
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()
if __name__=='__main__':
    try:main()
    except Exception as exc:print(str(exc),file=sys.stderr);sys.exit(1)
