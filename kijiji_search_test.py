#!/usr/bin/env python3
"""One-off Kijiji search using FindMyDeal's saved Kijiji Firefox profile.

Edit kijiji_test_config.json, close the Kijiji Sources browser, and run:
    python3 kijiji_search_test.py
Prints JSON only; this is not connected to the website's monitors.
"""
import fcntl
import json
import os
import pathlib
import re
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
from urllib.parse import quote, urlencode, urlsplit, parse_qs

from facebook_search_test import WebDriver

ROOT = pathlib.Path(__file__).resolve().parent
RUNTIME = pathlib.Path(os.environ.get('FMD_BROWSER_RUNTIME', ROOT / '.data/browser-runtime/usr'))
PROFILE = ROOT / '.data/profiles/kijiji'
DRIVER = RUNTIME / 'bin/geckodriver'
FIREFOX = pathlib.Path(os.environ.get('FMD_FIREFOX_PATH', RUNTIME / 'lib/firefox/firefox'))
CONFIG = ROOT / 'kijiji_test_config.json'


def last_kijiji_location():
    # Kijiji's Canada-wide search can reset the home page location. The
    # project profile's latest regional search retains the previous location.
    try:
        with sqlite3.connect(f'file:{PROFILE / "places.sqlite"}?mode=ro', uri=True) as db:
            rows = db.execute("SELECT url FROM moz_places WHERE url LIKE '%kijiji.ca%' AND url LIKE '%ll=%' ORDER BY last_visit_date DESC LIMIT 50").fetchall()
        for (url,) in rows:
            parsed=urlsplit(url)
            if parsed.scheme!='https' or parsed.hostname not in ('kijiji.ca','www.kijiji.ca'): continue
            parts=parsed.path.strip('/').split('/')
            if len(parts)!=3 or not re.fullmatch(r'b-[a-z0-9-]+',parts[0]) or not re.fullmatch(r'k0l\d+',parts[2]): continue
            values=parse_qs(parsed.query);coords=values.get('ll',[''])[0];address=values.get('address',[''])[0]
            if not re.fullmatch(r'-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?',coords) or not address or len(address)>255: continue
            lat,lon=map(float,coords.split(','))
            if abs(lat)>90 or abs(lon)>180: continue
            return {'area':parts[0],'suffix':parts[2],'ll':coords,'address':address}
    except (sqlite3.Error,OSError,ValueError):
        pass
    return None

SEARCH_LINKS = r'''return [...document.querySelectorAll('h3 a[data-testid="listing-link"]')]
  .map(a => a.href.split('?')[0])
  .filter((url, i, urls) => urls.indexOf(url) === i);'''
DETAILS = r'''if (location.pathname !== new URL(arguments[0]).pathname) return null;
const title = document.querySelector('h1');
const price = document.querySelector('[data-testid="vip-price"]');
const description = document.querySelector('[data-testid="vip-description-wrapper"]');
if (!title || !price || !description) return null;
const image=document.querySelector('meta[property="og:image"]')?.content || null;
const label=[...document.querySelectorAll('span,div,dt,p')].find(e=>e.children.length===0 && /^condition:?$/i.test(e.innerText?.trim() || ''));
let parent=label,condition=null;
for(let i=0;parent && i<5;i++,parent=parent.parentElement){const lines=parent.innerText?.split('\n').map(x=>x.trim()).filter(Boolean)||[];const index=lines.findIndex(x=>/^condition:?$/i.test(x));if(index>=0 && lines[index+1]){condition=lines[index+1];break;}}
return {title: title.innerText.trim(), price: price.innerText.trim(), description: description.innerText.trim() || null, image_url:image,item_condition:condition};'''


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
        raise ValueError('location must be a city or postal code string.')
    distance = config.get('max_distance_km')
    if distance is not None and (isinstance(distance, bool) or not isinstance(distance, (int, float)) or not 1 <= distance <= 1000):
        raise ValueError('max_distance_km must be between 1 and 1000, or null.')
    if distance is not None and not config.get('location', '').strip() and not config.get('use_source_location'):
        raise ValueError('Set a location when using max_distance_km.')
    if config.get('sort_by') not in ('suggested', 'date_listed'):
        raise ValueError('sort_by must be suggested or date_listed.')
    if isinstance(config.get('max_results'), bool) or not isinstance(config.get('max_results'), int) or not 1 <= config['max_results'] <= 30:
        raise ValueError('max_results must be a whole number from 1 to 30.')
    return config


def _apply_location_once(driver, city, radius):
    if not city:
        return
    # The location button can be visible before Kijiji finishes attaching its
    # click handlers. Wait for the results, then retry if the modal didn't open.
    driver.wait_for("return document.readyState === 'complete' && document.querySelector('[data-testid=\"set-search-range-header\"]') ? true : null;", timeout=30)
    field = None
    for _ in range(5):
        button = driver.wait_for('return [...document.querySelectorAll(\'[data-testid="set-search-range-header"]\')].find(e=>e.getClientRects().length) || null;', timeout=5)
        if not button: continue
        try:
            driver.click(button)
        except RuntimeError:
            time.sleep(.5)
            continue
        field = driver.wait_for('return [...document.querySelectorAll(\'#search-location-modal input[role="combobox"], #search-location-modal input[placeholder*="city" i], #search-location-modal input[aria-autocomplete="list"]\')].find(e=>e.getClientRects().length) || null;', timeout=3)
        if field: break
        time.sleep(.5)
    if not field: raise RuntimeError('Could not open Kijiji’s location picker. Try again shortly.')
    driver.click(field)
    element_id = field['element-6066-11e4-a52e-4f735466cecf']
    driver.request('POST', f'/session/{driver.session}/element/{element_id}/value', {'text': '\ue009a\ue000\ue003' + city})
    suggestion_script = '''const q=arguments[0].toLowerCase().trim(); return [...document.querySelectorAll('#search-location-modal [id*=-item-], #search-location-modal [role=option]')].find(e=>e.getClientRects().length && e.innerText.toLowerCase().trim().startsWith(q)) || null;'''
    suggestion = None
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not suggestion:
        suggestion = driver.execute(suggestion_script, city)
        if not suggestion: time.sleep(.25)
    if not suggestion: raise RuntimeError(f'Kijiji did not suggest a matching location for {city!r}. Try a more specific city or postal code.')
    driver.click(suggestion)
    apply = driver.wait_for('return [...document.querySelectorAll("#search-location-modal button")].find(e=>e.getClientRects().length && e.innerText.trim()==="Apply") || null;')
    if not apply: raise RuntimeError('Kijiji did not accept the location.')
    driver.click(apply)
    applied = driver.wait_for('return !document.querySelector("#search-location-modal") && new URL(location.href).searchParams.has("ll") ? location.href : null;', timeout=30)
    if not applied: raise RuntimeError('Kijiji did not apply the selected location.')
    if radius is not None:
        url = driver.execute('const url=new URL(location.href); url.searchParams.set("radius", arguments[0]); return url.href;', str(radius))
        driver.navigate(url)


# Accept a canonical redirect and results visible before slow subresources finish.
SEARCH_STATE = r'''const current=new URL(location.href), expected=new URL(arguments[0]);
const kijijiHost=h=>h==='kijiji.ca' || h==='www.kijiji.ca';
const allowed=current.origin===expected.origin || (expected.protocol==='https:' && current.protocol==='https:' && kijijiHost(expected.hostname) && kijijiHost(current.hostname));
if (!allowed || performance.timeOrigin === arguments[1]) return null;
const text=document.body?.innerText || '';
if (/verify (?:you are|you're) human|captcha|access denied|temporarily blocked/i.test(text)) return {blocked:true};
if ((arguments[2] && !current.searchParams.has('ll')) ||
    (arguments[2] && arguments[3] !== null && current.searchParams.get('radius') !== String(arguments[3]))) return null;
const links=[...document.querySelectorAll('h3 a[data-testid="listing-link"]')]
  .map(a=>a.href.split('?')[0]).filter((url,i,urls)=>urls.indexOf(url)===i);
if (links.length) return {links};
if (/\bNo results for\b/i.test(text)) return {links:[]};
return null;'''

def wait_search(driver, url, previous, location_required=False, radius=None):
    result=driver.wait_for(SEARCH_STATE, timeout=30, args=(url, previous, location_required, radius))
    if result and result.get('blocked'):
        raise RuntimeError('Kijiji requires verification or has blocked access. Check the Kijiji source browser.')
    if result is None:
        raise RuntimeError('Could not load Kijiji search results. Check whether Kijiji requires sign-in or verification.')
    return result

def apply_location(driver, city, radius):
    for attempt in range(2):
        try:return _apply_location_once(driver,city,radius)
        except RuntimeError as error:
            if attempt or str(error)!='Kijiji did not apply the selected location.':raise
            time.sleep(2)


def main():
    config = load_config()
    for item in (DRIVER, FIREFOX, PROFILE):
        if not item.exists(): raise RuntimeError(f'Missing {item}. Set up the Kijiji source and Firefox runtime first.')
    lock = PROFILE / '.parentlock'
    if lock.exists():
        with lock.open('r+') as file:
            try:
                fcntl.lockf(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.lockf(file, fcntl.LOCK_UN)
            except BlockingIOError:
                raise RuntimeError('Close the Kijiji source browser before running this script; Firefox cannot share a profile.')
    query = quote('-'.join(config['search'].strip().split()), safe='')
    params = {'view': 'list'}
    minimum, maximum = config.get('min_price'), config.get('max_price')
    if minimum is not None or maximum is not None:
        params['price'] = f'{"" if minimum is None else minimum}__{"" if maximum is None else maximum}'
    if config['sort_by'] == 'date_listed': params['sort'] = 'dateDesc'
    url = f'https://www.kijiji.ca/b-canada/{query}/k0l0?' + urlencode(params)
    # Read the previously used region before Firefox opens and locks its history.
    prior_region = last_kijiji_location() if config.get('use_source_location') and config.get('max_distance_km') is not None else None
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    env['LD_LIBRARY_PATH'] = f"{RUNTIME / 'lib'}:{env.get('LD_LIBRARY_PATH', '')}"
    process = subprocess.Popen([str(DRIVER), '--host', '127.0.0.1', '--port', str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    driver = WebDriver(f'http://127.0.0.1:{port}')
    try:
        for _ in range(50):
            if process.poll() is not None: raise RuntimeError('Could not start geckodriver.')
            try:
                driver.request('GET', '/status')
                break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(.1)
        caps = {'capabilities': {'alwaysMatch': {'browserName': 'firefox', 'moz:firefoxOptions': {'binary': str(FIREFOX), 'args': ['-headless', '-profile', str(PROFILE)]}, 'pageLoadStrategy': 'none'}}}
        driver.session = driver.request('POST', '/session', caps)['sessionId']
        city, radius = config.get('location', '').strip(), config.get('max_distance_km')
        regional = None
        if config.get('use_source_location'):
            driver.navigate('https://www.kijiji.ca/')
            saved = driver.wait_for('''const name=document.querySelector('[data-testid="location-name"]');
                if (!name || !name.innerText.trim()) return null;
                const text=document.querySelector('[data-testid="location-radius"]')?.innerText || '';
                const match=text.match(/(\\d+(?:\\.\\d+)?)\\s*km/i);
                return {name:name.innerText.trim(), radius:match ? Number(match[1]) : null};''', timeout=30)
            if not saved: raise RuntimeError('Could not read the default Kijiji location.')
            city = '' if saved['name'].lower() == 'canada' else saved['name'].split(',')[0].strip()
            if radius is None: radius = saved['radius']
            if not city and radius is not None:
                regional=prior_region
                if not regional: raise RuntimeError('Set a location in Sources → Kijiji before using a distance.')
                params.update({'ll':regional['ll'],'address':regional['address'],'radius':radius})
                url=f'https://www.kijiji.ca/{regional["area"]}/{query}/{regional["suffix"]}?' + urlencode(params)
        previous = driver.execute('return performance.timeOrigin;')
        driver.navigate(url)
        wait_search(driver, url, previous)
        apply_location(driver, city, radius)
        search_result = wait_search(driver, url, previous, bool(city or regional), radius)
        links = search_result['links']
        if not links:
            print('[]')
            return
        results = []
        search_handle = driver.request('GET', f'/session/{driver.session}/window')
        selected = links[:config['max_results']]
        for offset in range(0, len(selected), 3):
            pages = []
            for link in selected[offset:offset + 3]:
                handle = driver.request('POST', f'/session/{driver.session}/window/new', {'type': 'tab'})['handle']
                driver.request('POST', f'/session/{driver.session}/window', {'handle': handle})
                driver.navigate(link)
                pages.append((handle, link))
            for handle, link in pages:
                driver.request('POST', f'/session/{driver.session}/window', {'handle': handle})
                result = driver.wait_for(DETAILS, timeout=20, args=(link,))
                if result:
                    result['url'] = link
                    results.append(result)
                else:
                    print(f'Could not read listing details: {link}', file=sys.stderr)
                driver.request('DELETE', f'/session/{driver.session}/window')
            driver.request('POST', f'/session/{driver.session}/window', {'handle': search_handle})
        if not results: raise RuntimeError('Listings appeared, but no listing details could be read.')
        print(json.dumps(results, indent=2, ensure_ascii=False))
    finally:
        if driver.session:
            try: driver.request('DELETE', f'/session/{driver.session}')
            except Exception: pass
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait()

if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print(f'Error: {exc}', file=sys.stderr)
        sys.exit(1)
