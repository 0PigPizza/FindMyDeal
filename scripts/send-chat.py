#!/usr/bin/env python3
"""Send one initial message using the project's signed-in marketplace profile."""
import json, os, pathlib, socket, subprocess, sys, time
from urllib.parse import urlparse
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from facebook_search_test import WebDriver, RUNTIME, FIREFOX

VISIBLE = "const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);"

def confirm_kijiji_conversation(driver, listing_url, listing_id, message):
    """Recheck an uncertain submission without ever sending another message."""
    try:
        driver.navigate(listing_url)
        link=driver.wait_for(VISIBLE+"""const id=arguments[0];
          if (!location.pathname.split('/').filter(Boolean).includes(id)) return null;
          const a=[...document.querySelectorAll('a[href]')].find(a=>visible(a)&&/open chat/i.test(a.innerText)&&a.hostname==='www.kijiji.ca'&&a.pathname.startsWith('/m-msg-my-messages/conversation/'));
          return a?a.pathname:null;""",timeout=30,args=(listing_id,))
        if not link: return False
        driver.navigate('https://www.kijiji.ca'+link)
        return bool(driver.wait_for(VISIBLE+r"""const id=arguments[0],message=arguments[1];
          const normalize=s=>(s||'').replace(/\s+/g,' ').trim();
          if (!location.pathname.startsWith('/m-msg-my-messages/conversation/'))return false;
          const listing=[...document.querySelectorAll('a[href]')].some(a=>a.hostname==='www.kijiji.ca'&&a.pathname.split('/').filter(Boolean).includes(id));
          return listing&&[...document.querySelectorAll('div,p,span')].some(e=>visible(e)&&e.children.length===0&&normalize(e.innerText)===normalize(message));""",timeout=30,args=(listing_id,message)))
    except Exception:
        return False

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
        listing_id=parsed.path.rstrip('/').split('/')[-1]
        if not driver.wait_for("return document.readyState === 'complete' && location.pathname.split('/').filter(Boolean).includes(arguments[0]);",timeout=30,args=(listing_id,)):
            raise RuntimeError('The requested listing did not load.')
        if source == 'facebook':
            # New Marketplace listings expose an inline seller textarea, with a
            # button labelled "Send message to <seller>". Never use a restored
            # Messenger chat: it can belong to a different listing.
            find_form=VISIBLE+"""for (const e of document.querySelectorAll('textarea')) {
              if (!visible(e)) continue;
              let p=e; for(let i=0;p&&i<12;i++,p=p.parentElement) {
                const fields=[...p.querySelectorAll('textarea')].filter(visible);
                const buttons=[...p.querySelectorAll('button,[role=button]')].filter(b=>visible(b)&&/^send message to .+/i.test(b.getAttribute('aria-label')||''));
                if(fields.length===1&&buttons.length===1)return [e,buttons[0]];
              }
            } return null;"""
            form=driver.wait_for(find_form,timeout=25)
            if not form: raise RuntimeError('Could not identify this listing’s message box. Check the listing in Sources.')
            driver.type_text(form[0],message)
            # Reacquire after typing because React may replace the form.
            form=driver.wait_for(find_form,timeout=10)
            if not form: raise RuntimeError('Send button not found. Check the listing in Sources.')
            driver.click(form[1])
            # Confirm in the conversation for this listing, not in an unrelated
            # restored chat or in the still-unsent textarea.
            confirmation=driver.wait_for(VISIBLE+"""const id=arguments[0],message=arguments[1];
              for(const a of document.querySelectorAll('a[href]')) {
                if(!a.href.includes('/marketplace/item/'+id)) continue;
                let p=a; for(let i=0;p&&i<12;i++,p=p.parentElement) {
                  if(p.querySelectorAll('textarea,[contenteditable=true][role=textbox]').length>1) break;
                  if(visible(p) && p.innerText.includes(message) && p.querySelector('[role=textbox],[contenteditable=true]'))return true;
                }
              }return false;""",timeout=15,args=(listing_id,message))
        else:
            # Existing conversations are not initial messages and must not be
            # contacted again. Wait for the asynchronous contact panel to load.
            state=driver.wait_for(VISIBLE+"""if ([...document.querySelectorAll('a')].some(a=>visible(a)&&/open chat/i.test(a.innerText)))return 'existing';
              const e=document.querySelector('textarea#message');return e&&visible(e)?'new':null;""",timeout=30)
            if state=='new':
                time.sleep(2)  # Allow the existing-conversation check to finish loading.
                if driver.execute(VISIBLE+"return [...document.querySelectorAll('a')].some(a=>visible(a)&&/open chat/i.test(a.innerText));"): state='existing'
            if state=='existing': raise RuntimeError('A conversation already exists for this listing. Check the marketplace.')
            if state!='new': raise RuntimeError('Could not identify this listing’s message box. Check the listing in Sources.')
            composer=driver.wait_for(VISIBLE+"const e=document.querySelector('textarea#message');return e&&visible(e)?e:null;",timeout=5)
            driver.type_text(composer,message)
            button=driver.wait_for(VISIBLE+"return [...document.querySelectorAll('button')].find(b=>visible(b)&&/^send message$/i.test(b.innerText.trim())&&!b.disabled)||null;",timeout=10)
            if not button: raise RuntimeError('Send button not found. Check the listing in Sources.')
            driver.click(button)
            # Kijiji replaces the entire form after submission; do not inspect
            # the now-stale textarea. A newly appearing Open chat link confirms
            # that a conversation was created for this listing.
            try:
                confirmation=driver.wait_for(VISIBLE+"return [...document.querySelectorAll('a')].some(a=>visible(a)&&/open chat/i.test(a.innerText)&&a.href.includes('/m-msg-my-messages/conversation/'));",timeout=15)
            except Exception:
                confirmation=False
            if not confirmation:
                confirmation=confirm_kijiji_conversation(driver,url,listing_id,message)
        if not confirmation: raise RuntimeError('Delivery could not be confirmed. Check the marketplace before sending again.')
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
