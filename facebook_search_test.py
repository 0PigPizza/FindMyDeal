#!/usr/bin/env python3
"""One-off Facebook Marketplace search using FindMyDeal's saved Firefox profile.

Run: python3 facebook_search_test.py
Close any Facebook Sources browser first. This script prints JSON; it does not
change monitors, send messages, or save results to the website.
"""
import json
import fcntl
import os
import pathlib
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

ROOT = pathlib.Path(__file__).resolve().parent
RUNTIME = ROOT / '.data/browser-runtime/usr'
PROFILE = ROOT / '.data/profiles/facebook'
DRIVER = RUNTIME / 'bin/geckodriver'
FIREFOX = RUNTIME / 'lib/firefox/firefox'
CONFIG = ROOT / 'facebook_test_config.json'
DISTANCES = (1, 2, 5, 10, 20, 40, 60, 80, 100, 250, 500)

class WebDriver:
    def __init__(self, base):
        self.base = base
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.session = None
        self.request_timeout = 90

    def request(self, method, path, data=None):
        request = urllib.request.Request(self.base + path, method=method,
            data=None if data is None else json.dumps(data).encode(),
            headers={'Content-Type': 'application/json'})
        try:
            with self.http.open(request, timeout=self.request_timeout) as response:
                return json.load(response)['value']
        except urllib.error.HTTPError as exc:
            try:
                message = json.load(exc).get('value', {}).get('message', '')
            except (ValueError, AttributeError):
                message = ''
            raise RuntimeError(message or f'WebDriver HTTP {exc.code}') from exc

    def execute(self, script, *args):
        return self.request('POST', f'/session/{self.session}/execute/sync', {'script': script, 'args': list(args)})

    def click(self, element):
        self.request('POST', f"/session/{self.session}/element/{element['element-6066-11e4-a52e-4f735466cecf']}/click", {})

    def type_text(self, element, text):
        element_id = element['element-6066-11e4-a52e-4f735466cecf']
        self.request('POST', f'/session/{self.session}/element/{element_id}/clear', {})
        self.request('POST', f'/session/{self.session}/element/{element_id}/value', {'text': text})

    def navigate(self, url):
        self.request('POST', f'/session/{self.session}/url', {'url': url})

    def wait_for(self, script, timeout=25, args=()):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.execute(script, *args)
            if value:
                return value
            time.sleep(.25)
        return None

SEARCH_LINKS = r'''return [...document.querySelectorAll('a[href*="/marketplace/item/"]')]
  .map(a => { let match = a.href.match(/\/marketplace\/item\/(\d+)/); return match && `https://www.facebook.com/marketplace/item/${match[1]}/`; })
  .filter((url, i, urls) => url && urls.indexOf(url) === i);'''
class FacebookTemporarilyBlocked(RuntimeError):
    pass

BLOCK_CHECK = r'''return /you(?:[’']re| are) temporarily blocked/i.test(document.body?.innerText || '');'''
SEARCH_STATE = r'''if ((() => {''' + BLOCK_CHECK + r'''})()) return {blocked:true};
const links=(() => {''' + SEARCH_LINKS + r'''})(); return links.length ? {links} : null;'''
def collect_search_links(driver, limit):
    result=driver.wait_for(SEARCH_STATE,timeout=30)
    if result and result.get('blocked'):raise FacebookTemporarilyBlocked('Facebook temporarily blocked access. Check the Facebook source browser. Retrying in 1 hour.')
    return (result.get('links',[]) if result else [])[:limit]


DETAILS = r'''if (/you(?:[’']re| are) temporarily blocked/i.test(document.body?.innerText || '')) return {blocked:true};
if (location.pathname !== new URL(arguments[0]).pathname) return null;
const visible = e => e.getClientRects().length > 0;
const title = [...document.querySelectorAll('h1')].find(e => visible(e) && e.innerText.trim());
const heading = [...document.querySelectorAll('h2')].find(e => visible(e) && e.innerText.trim() === 'Details');
if (!title || !heading) return null;
let container = title;
while (container && (!container.innerText.includes('Details') || container.innerText.length < title.innerText.length + 10)) container = container.parentElement;
const lines = (container?.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
const titleIndex = lines.indexOf(title.innerText.trim());
const priceLine = lines.slice(titleIndex + 1).find(x => /^(?:[A-Z]{0,3}\s*)?\$\s*[\d,.]+|^free$/i.test(x));
const price = priceLine?.match(/^(?:(?:[A-Z]{0,3}\s*)?\$\s*[\d,.]+|free)/i)?.[0] || null;
let details = heading;
while (details && (!details.innerText.includes('Location is approximate') && !details.innerText.includes('Seller information'))) details = details.parentElement;
const text = details?.innerText || '';
let description = text.split('\n').map(x => x.trim()).filter(Boolean);
if (description[0] === 'Details') description.shift();
const conditionIndex=description.findIndex(x=>/^condition:?$/i.test(x));
const condition=conditionIndex>=0 ? description[conditionIndex+1] || null : null;
while (['Condition','Brand','Type','Size','Colour','Color'].includes(description[0]) && description.length > 2) description.splice(0, 2);
const stop = description.findIndex(x => /Location is approximate|^Seller information$|^Seller details$/.test(x));
if (stop >= 0) description = description.slice(0, stop);
description = description.filter(x => !/^(?:See more|See less|View listing location)$/.test(x));
const photos = [...document.querySelectorAll('img')].filter(img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0 && img.getBoundingClientRect().width >= 150 && img.getBoundingClientRect().height >= 150 && /(^|\.)fbcdn\.net$/i.test(new URL(img.currentSrc || img.src, location.href).hostname));
photos.sort((a,b) => b.getBoundingClientRect().width*b.getBoundingClientRect().height - a.getBoundingClientRect().width*a.getBoundingClientRect().height);
return {title:title.innerText.trim(), price, description:description.join('\n').slice(0,50000) || null, image_url:photos[0]?.currentSrc || photos[0]?.src || null, item_condition:condition};'''


def load_config():
    with CONFIG.open(encoding='utf-8') as file:
        config = json.load(file)
    if not isinstance(config.get('search'), str) or not config['search'].strip():
        raise ValueError('search must be a non-empty string.')
    for key in ('min_price', 'max_price'):
        value = config.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0):
            raise ValueError(f'{key} must be a non-negative number or null.')
    if config.get('min_price') is not None and config.get('max_price') is not None and config['min_price'] > config['max_price']:
        raise ValueError('min_price cannot be greater than max_price.')
    if not isinstance(config.get('location', ''), str):
        raise ValueError('location must be a city string or empty.')
    if config.get('max_distance_km') is not None and config['max_distance_km'] not in DISTANCES:
        raise ValueError(f'max_distance_km must be null or one of: {DISTANCES}.')
    if config.get('sort_by') not in ('suggested', 'date_listed'):
        raise ValueError('sort_by must be suggested or date_listed.')
    if isinstance(config.get('max_results'), bool) or not isinstance(config.get('max_results'), int) or not 1 <= config['max_results'] <= 30:
        raise ValueError('max_results must be a whole number from 1 to 30.')
    return config


def apply_location(driver, location, distance):
    if not location and distance is None:
        return
    button = driver.wait_for(r"""const buttons = [...document.querySelectorAll('[role=button],button')].filter(e => e.getClientRects().length);
        return buttons.find(e => /^location\s*:/i.test(e.getAttribute('aria-label') || '') && /\b\d+\s*(?:km|mi)\b/i.test(e.getAttribute('aria-label'))) ||
          buttons.find(e => /\bwithin\s+\d+\s*(?:km|mi)\b/i.test(e.innerText || '') && (e.innerText || '').length < 200) || null;""")
    if not button:
        raise RuntimeError('Could not find Facebook’s location filter.')
    driver.click(button)
    dialog = driver.wait_for("return [...document.querySelectorAll('[role=dialog]')].find(e => e.getClientRects().length && e.querySelector('input[aria-label=\"Location\"]')) || null;")
    if not dialog:
        raise RuntimeError('Could not open Facebook’s location filter.')
    if location:
        field = driver.wait_for("return arguments[0].querySelector('input[aria-label=\"Location\"]')", args=(dialog,))
        if not field: raise RuntimeError('Could not find Facebook’s location input.')
        driver.type_text(field, location)
        # Facebook returns location suggestions; choose a city whose name starts with the requested text.
        choice_script = """const q=arguments[0].toLowerCase().trim(); return [...document.querySelectorAll('li[role=option] [role=option]')].find(e=>e.getClientRects().length && e.innerText.toLowerCase().trim().startsWith(q)) || null;"""
        choice = None
        deadline=time.monotonic()+15
        while time.monotonic()<deadline and not choice:
            choice=driver.execute(choice_script, location)
            if not choice: time.sleep(.5)
        if not choice: raise RuntimeError(f'Facebook did not suggest a matching location for {location!r}. Try a more specific city.')
        driver.click(choice)
    if distance is not None:
        radius=driver.wait_for("""return [...arguments[0].querySelectorAll('[role=combobox]')].find(e => {
            const label = e.getAttribute('aria-label') || '';
            const labelled = (e.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
            return e.getClientRects().length && /\\bradius\\b/i.test(label + ' ' + labelled + ' ' + (e.innerText || ''));
        }) || null;""", args=(dialog,))
        if not radius: raise RuntimeError('Could not find Facebook’s distance selector.')
        driver.click(radius)
        option_script="""const n=String(arguments[0]); return [...document.querySelectorAll('[role=option]')].find(e=>e.getClientRects().length && e.innerText.trim().startsWith(n+' ') && e.innerText.trim().toLowerCase().includes('kilometer')) || null;"""
        option=None
        deadline=time.monotonic()+10
        while time.monotonic()<deadline and not option:
            option=driver.execute(option_script,distance)
            if not option: time.sleep(.5)
        if not option: raise RuntimeError(f'Facebook did not offer the requested {distance} km radius. Visible options: {driver.execute("return [...document.querySelectorAll(\"[role=option]\")].filter(e=>e.getClientRects().length).map(e=>e.innerText);")}')
        driver.click(option)
    apply=driver.wait_for("return [...arguments[0].querySelectorAll('[role=button],button')].find(e=>e.getClientRects().length && e.innerText.trim()==='Apply' && e.getAttribute('aria-disabled')!=='true') || null;", args=(dialog,))
    if not apply: raise RuntimeError('Facebook did not accept the location or radius.')
    driver.click(apply)
    # Let the location change complete before collecting results.
    time.sleep(3)



def collect_listing_details(driver, search_handle, links, *, deadline_seconds=300, detail_timeout=20):
    results=[]
    failed=0
    consecutive_failures=0
    deadline=time.monotonic()+deadline_seconds
    stopped_early=False
    blocked=False
    for offset in range(0,len(links),3):
        pages=[]
        try:
            for link in links[offset:offset+3]:
                if time.monotonic()>=deadline:
                    stopped_early=True
                    break
                handle=driver.request('POST',f'/session/{driver.session}/window/new',{'type':'tab'})['handle']
                pages.append((handle,link))
                driver.request('POST',f'/session/{driver.session}/window',{'handle':handle})
                driver.navigate(link)
            while pages:
                if time.monotonic()>=deadline or consecutive_failures>=3:
                    stopped_early=True
                    break
                handle,link=pages.pop(0)
                try:
                    driver.request('POST',f'/session/{driver.session}/window',{'handle':handle})
                    result=driver.wait_for(DETAILS,timeout=detail_timeout,args=(link,))
                    if result and result.get('blocked'):raise FacebookTemporarilyBlocked('Facebook temporarily blocked access. Check the Facebook source browser. Retrying in 1 hour.')
                    if result:
                        result['url']=link;results.append(result);consecutive_failures=0
                    else:
                        failed+=1;consecutive_failures+=1
                finally:
                    try:driver.request('DELETE',f'/session/{driver.session}/window')
                    except (RuntimeError,urllib.error.URLError,ConnectionError,TimeoutError):pass
        except FacebookTemporarilyBlocked:
            if not results:raise
            blocked=True;stopped_early=True
        except (RuntimeError,urllib.error.URLError,ConnectionError,TimeoutError):
            if not results:raise
            failed+=1;stopped_early=True
        finally:
            for handle,_ in pages:
                try:
                    driver.request('POST',f'/session/{driver.session}/window',{'handle':handle})
                    driver.request('DELETE',f'/session/{driver.session}/window')
                except (RuntimeError,urllib.error.URLError,ConnectionError,TimeoutError):pass
        if stopped_early:break
        driver.request('POST',f'/session/{driver.session}/window',{'handle':search_handle})
    if not results:raise RuntimeError('Listings appeared, but no listing details could be read. Check the Facebook source browser.')
    warning=None
    if blocked:
        warning=f'Saved {len(results)} Facebook listings before Facebook temporarily blocked access. Check the Facebook source browser. Retrying in 1 hour.'
    elif stopped_early or failed:
        warning=f'Saved {len(results)} Facebook listings; some details could not be read. Will retry later.'
    return results,warning


def main():
    config = load_config()
    params = {'query': config['search'].strip(), 'exact': 'false'}
    if config.get('min_price') is not None: params['minPrice'] = config['min_price']
    if config.get('max_price') is not None: params['maxPrice'] = config['max_price']
    if config['sort_by'] == 'date_listed': params['sortBy'] = 'creation_time_descend'
    query_url = 'https://www.facebook.com/marketplace/search/?' + urlencode(params)
    for item in (DRIVER, FIREFOX, PROFILE):
        if not item.exists():
            raise RuntimeError(f'Missing {item}. Set up the Facebook source and Firefox runtime first.')
    lock = PROFILE / '.parentlock'
    if lock.exists():
        with lock.open('r+') as file:
            try:
                fcntl.lockf(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.lockf(file, fcntl.LOCK_UN)
            except BlockingIOError:
                raise RuntimeError('Close the Facebook source browser before running this script; Firefox cannot share a profile.')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    env['LD_LIBRARY_PATH'] = f"{RUNTIME / 'lib'}:{env.get('LD_LIBRARY_PATH', '')}"
    driver_process = subprocess.Popen([str(DRIVER), '--host', '127.0.0.1', '--port', str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    driver = WebDriver(f'http://127.0.0.1:{port}')
    try:
        for _ in range(50):
            if driver_process.poll() is not None:
                raise RuntimeError('Could not start geckodriver.')
            try:
                driver.request('GET', '/status')
                break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(.1)
        caps = {'capabilities': {'alwaysMatch': {'browserName': 'firefox', 'moz:firefoxOptions': {'binary': str(FIREFOX), 'args': ['-headless', '-profile', str(PROFILE)]}, 'pageLoadStrategy': 'none'}}}
        driver.session = driver.request('POST', '/session', caps)['sessionId']
        driver.navigate(query_url)
        try:
            apply_location(driver, config.get('location', '').strip(), config.get('max_distance_km'))
        except RuntimeError:
            if driver.execute(BLOCK_CHECK):raise FacebookTemporarilyBlocked('Facebook temporarily blocked access. Check the Facebook source browser. Retrying in 1 hour.')
            raise
        links = collect_search_links(driver, config['max_results'])
        if not links:
            raise RuntimeError('No Marketplace listings appeared. Facebook may require sign-in or show a verification page.')
        search_handle = driver.request('GET', f'/session/{driver.session}/window')
        driver.request_timeout=25
        results,warning=collect_listing_details(driver,search_handle,links[:config['max_results']])
        if warning:print(f'FMD_WARNING: {warning}',file=sys.stderr)
        print(json.dumps(results, indent=2, ensure_ascii=False))
    finally:
        if driver.session:
            try: driver.request('DELETE', f'/session/{driver.session}')
            except Exception: pass
        driver_process.terminate()
        try: driver_process.wait(timeout=5)
        except subprocess.TimeoutExpired: driver_process.kill(); driver_process.wait()

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Error: {exc}', file=sys.stderr)
        sys.exit(1)
