#!/usr/bin/env python3
"""One-off eBay search using FindMyDeal's saved eBay Firefox profile.

Edit ebay_test_config.json, close the eBay Sources browser, and run:
    python3 ebay_search_test.py
Prints JSON only; this is not connected to the website's monitors.
"""
import fcntl
import hashlib
from decimal import Decimal, InvalidOperation
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode

from facebook_search_test import WebDriver

ROOT = pathlib.Path(__file__).resolve().parent
RUNTIME = pathlib.Path(os.environ.get('FMD_BROWSER_RUNTIME', ROOT / '.data/browser-runtime/usr'))
PROFILE = ROOT / '.data/profiles/ebay'
DRIVER = RUNTIME / 'bin/geckodriver'
FIREFOX = pathlib.Path(os.environ.get('FMD_FIREFOX_PATH', RUNTIME / 'lib/firefox/firefox'))
CONFIG = ROOT / 'ebay_test_config.json'
SITE = 'https://www.ebay.ca'

class EbayForbidden(RuntimeError):
    pass

SEARCH_LINKS = r'''return [...document.querySelectorAll('#srp-river-results a[href*="/itm/"]')]
  .map(a => {
    const match=a.href.match(/\/itm\/(?:[^/?]+\/)?(\d{9,})/); if(!match)return null;
    const card=a.closest('.s-item, .s-card, li');
    const get=selector=>card?.querySelector(selector)?.textContent?.trim() || null;
    const title=get('.s-item__title, .s-card__title, [role="heading"]');
    const price=get('.s-item__price, .s-card__price');
    const condition=get('.SECONDARY_INFO, .s-item__subtitle, .s-card__subtitle');
    return {url:`https://www.ebay.ca/itm/${match[1]}`,title,price,condition};
  }).filter((item,i,items)=>item && items.findIndex(x=>x?.url===item.url)===i);'''
DETAILS = r'''if (location.pathname !== new URL(arguments[0]).pathname) return null;
const title=document.querySelector('h1.x-item-title__mainTitle') || document.querySelector('h1');
const price=document.querySelector('[data-testid="x-price-primary"] .x-price-primary__price, .x-price-primary .ux-textspans');
if(!title || !price || !title.innerText.trim() || !price.innerText.trim()) return null;
const condition=document.querySelector('[data-testid="x-item-condition"] .x-item-condition-text [data-testid="ux-textual-display"] .ux-textspans, .x-item-condition-text .ux-textspans')?.textContent?.trim() || null;
const approximate=document.querySelector('.x-price-approx')?.textContent?.trim() || null;
return {title:title.innerText.trim(),price:price.innerText.trim(),price_approx:approximate || null,description:null,image_url:document.querySelector('meta[property="og:image"]')?.content || null,item_condition:condition};'''
SEARCH_OUTCOME = r'''if (performance.timeOrigin === arguments[0] || location.pathname !== '/sch/i.html') return null;
if (document.readyState === 'complete' && /^Error Page\s*\|\s*eBay$/i.test(document.title)) return {error:true, status:performance.getEntriesByType('navigation')[0]?.responseStatus || null};
const links = (() => {''' + SEARCH_LINKS + r'''})();
if (links.length) return {links};
const headings=[...document.querySelectorAll('h1,h2,h3')].map(e=>e.innerText.trim());
if (document.readyState === 'complete' && headings.some(x=>/^(?:0 results|no results found)/i.test(x))) return {links:[]};
return null;'''
DETAIL_OUTCOME = r'''if (location.pathname !== new URL(arguments[0]).pathname || (arguments[1] !== null && performance.timeOrigin === arguments[1])) return null;
if (document.readyState === 'complete' && /^Error Page\s*\|\s*eBay$/i.test(document.title)) return {error:true, status:performance.getEntriesByType('navigation')[0]?.responseStatus || null};
return (() => {''' + DETAILS + r'''})();'''


def usd_cad_rate():
    cache = ROOT / '.data' / 'ebay-usdcad-rate.json'
    saved = None
    try:
        saved = json.loads(cache.read_text(encoding='utf-8'))
        rate = Decimal(str(saved['rate']))
        if not rate.is_finite() or not Decimal('0.1') <= rate <= Decimal('10'): saved = None
        elif time.time() - float(saved['fetched_at']) < 86400: return rate, saved['date']
    except (OSError, ValueError, TypeError, KeyError, InvalidOperation):
        saved = None
    try:
        request = urllib.request.Request('https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1', headers={'User-Agent':'FindMyDeal/1.0'})
        with urllib.request.urlopen(request, timeout=10) as response: data=json.load(response)
        observation=data['observations'][-1]; rate=Decimal(observation['FXUSDCAD']['v']); date=observation['d']
        if not rate.is_finite() or not Decimal('0.1') <= rate <= Decimal('10'): raise ValueError('Invalid exchange rate')
        cache.parent.mkdir(parents=True, exist_ok=True)
        temp=cache.with_suffix('.tmp');temp.write_text(json.dumps({'rate':str(rate),'date':date,'fetched_at':time.time()}),encoding='utf-8');os.chmod(temp,0o600);temp.replace(cache)
        return rate,date
    except (OSError, ValueError, KeyError, IndexError, TypeError, InvalidOperation):
        if saved and time.time()-float(saved['fetched_at']) < 7*86400: return Decimal(str(saved['rate'])),saved['date']
        raise RuntimeError('Could not load the CAD/USD exchange rate for eBay. Try again later.')


def price_in_cad(result, rate, date):
    raw=(result.get('price') or '').strip()
    number=r'([0-9][0-9,]*(?:\.[0-9]{1,2})?)'
    cad=re.match(r'(?:C\s*\$|CA\s*\$|CAD\s*\$?|\$)\s*'+number,raw,re.IGNORECASE)
    if cad:return Decimal(cad.group(1).replace(',','')),raw
    usd=re.match(r'(?:US\s*\$|USD\s*\$?)\s*'+number,raw,re.IGNORECASE)
    if not usd:return None,raw
    amount=Decimal(usd.group(1).replace(',',''));converted=(amount*rate).quantize(Decimal('0.01'))
    return converted,f'C ${converted:,.2f} (approx.; US ${amount:,.2f}, {date} rate)'


def search_links(driver, url):
    for attempt in range(3):
        previous_page = driver.execute('return performance.timeOrigin;')
        driver.navigate(url)
        result = driver.wait_for(SEARCH_OUTCOME, timeout=30, args=(previous_page,))
        if result is not None and 'links' in result:
            return result['links']
        if result and result.get('status') == 403:
            raise EbayForbidden('eBay refused the request (HTTP 403). Try again later or check the eBay source browser.')
        if result and result.get('error'):
            if attempt < 2: time.sleep(2 ** (attempt + 1))
            continue
        raise RuntimeError('Could not load eBay search results. Check whether eBay requires sign-in or verification.')
    raise RuntimeError('eBay returned an error page. Try again later.')


def listing_details(driver, link):
    previous_page = None
    for attempt in range(2):
        result = driver.wait_for(DETAIL_OUTCOME, timeout=20, args=(link, previous_page))
        if result and not result.get('error'):
            return result
        if result and result.get('status') == 403:
            raise EbayForbidden('eBay refused the request (HTTP 403). Try again later or check the eBay source browser.')
        if attempt == 0:
            previous_page = driver.execute('return performance.timeOrigin;')
            driver.navigate(link)
    return None


def read_description(driver):
    frame = driver.wait_for("const f=document.querySelector('#desc_ifr'); if(f) f.scrollIntoView({block:'center'}); return f || null;", timeout=8)
    if not frame:
        return None
    try:
        driver.request('POST', f'/session/{driver.session}/frame', {'id':frame})
        text=driver.wait_for('''if (!document.body) return null;
            const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:n=>/^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement?.tagName||'') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
            let parts=[],length=0,count=0,node;
            while ((node=walker.nextNode()) && length<50000 && count++<2000) {const value=node.nodeValue.trim();if(value){parts.push(value.slice(0,50000-length));length+=value.length;}}
            return parts.join('\\n').trim() || null;''', timeout=8)
        return text
    finally:
        driver.request('POST', f'/session/{driver.session}/frame', {'id':None})


def discarded_context(error):
    return bool(re.search(r'NS_ERROR_OUT_OF_MEMORY|out of memory|browsing context.*discarded|no such window|failed to decode response from marionette',str(error),re.IGNORECASE))


def close_tab(driver, handle):
    if not handle: return
    try:
        driver.request('POST', f'/session/{driver.session}/window', {'handle':handle})
        driver.request('DELETE', f'/session/{driver.session}/window')
    except (RuntimeError, urllib.error.URLError, ConnectionError):
        pass


def open_listing_tab(driver, search_handle, link):
    driver.request('POST', f'/session/{driver.session}/window', {'handle':search_handle})
    handle=driver.request('POST', f'/session/{driver.session}/window/new', {'type':'tab'})['handle']
    try:
        driver.request('POST', f'/session/{driver.session}/window', {'handle':handle})
        driver.navigate(link)
        return handle
    except Exception:
        close_tab(driver,handle)
        raise


def read_listing(driver, search_handle, handle, link, minimum, maximum, rate, rate_date):
    for attempt in range(2):
        try:
            driver.request('POST', f'/session/{driver.session}/window', {'handle':handle})
            result=listing_details(driver,link)
            if not result:
                close_tab(driver,handle)
                return None,False,True
            cad_price,display_price=price_in_cad(result,rate,rate_date)
            if (minimum is not None or maximum is not None) and (cad_price is None or (minimum is not None and cad_price<Decimal(str(minimum))) or (maximum is not None and cad_price>Decimal(str(maximum)))):
                close_tab(driver,handle)
                return None,True,False
            result['price']=display_price
            result.pop('price_approx',None)
            result['description']=read_description(driver)
            result['url']=link
            close_tab(driver,handle)
            return result,True,False
        except (RuntimeError, urllib.error.URLError, ConnectionError, TimeoutError) as error:
            if not discarded_context(error) and not isinstance(error,(urllib.error.URLError,ConnectionError,TimeoutError)):
                close_tab(driver,handle)
                raise
            close_tab(driver,handle)
            handle=None
            if attempt==0:
                try:
                    handle=open_listing_tab(driver,search_handle,link)
                    continue
                except (RuntimeError, urllib.error.URLError, ConnectionError, TimeoutError) as retry_error:
                    if not discarded_context(retry_error) and not isinstance(retry_error,(urllib.error.URLError,ConnectionError,TimeoutError)):
                        raise
            return None,False,True
    return None,False,True


def default_postal_code(driver, url):
    for attempt in range(3):
        previous_page = driver.execute('return performance.timeOrigin;')
        driver.navigate(url)
        result = driver.wait_for(r'''if (performance.timeOrigin === arguments[0] || location.pathname !== '/sch/i.html') return null;
            if (/^Error Page\s*\|\s*eBay$/i.test(document.title) && document.readyState === 'complete') return {error:true, status:performance.getEntriesByType('navigation')[0]?.responseStatus || null};
            const field=[...document.querySelectorAll('input[name="_stpos"]')].find(el=>el.value.trim());
            return field ? {postal:field.value.trim()} : null;''', timeout=20, args=(previous_page,))
        if result and result.get('postal'):
            return result['postal']
        if result and result.get('status') == 403:
            raise EbayForbidden('eBay refused the request (HTTP 403). Try again later or check the eBay source browser.')
        if result and result.get('error'):
            if attempt < 2: time.sleep(2 ** (attempt + 1))
            continue
        raise RuntimeError('Set a default postal code in eBay before using a distance.')
    raise RuntimeError('eBay returned an error page. Try again later.')


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
    if distance is not None and (isinstance(distance, bool) or not isinstance(distance, (int, float)) or distance not in (10, 25, 50, 100, 200, 500, 1000)):
        raise ValueError('max_distance_km must be 10, 25, 50, 100, 200, 500, 1000, or null.')
    if not config.get('use_source_location') and bool(distance is not None) != bool(config.get('location', '').strip()):
        raise ValueError('Set both location (postal code) and max_distance_km together.')
    if config.get('location', '').strip() and not re.fullmatch(r'(?:[A-Z]\d[A-Z] ?\d[A-Z]\d|\d{5}(?:-\d{4})?)', config['location'].strip(), re.IGNORECASE):
        raise ValueError('location must be a Canadian postal code or US ZIP code for eBay.')
    if config.get('sort_by') not in ('suggested', 'date_listed'):
        raise ValueError('sort_by must be suggested or date_listed.')
    if isinstance(config.get('max_results'), bool) or not isinstance(config.get('max_results'), int) or not 1 <= config['max_results'] <= 30:
        raise ValueError('max_results must be a whole number from 1 to 30.')
    return config




DETAIL_REFRESH_SECONDS=24*60*60
LISTING_REQUEST_DELAY=2

def summary_signature(item, rate, rate_date):
    if not isinstance(item,dict): return None
    title,price=item.get('title'),item.get('price')
    if not isinstance(title,str) or not title.strip() or not isinstance(price,str) or not price.strip(): return None
    # Ranges and missing prices cannot safely identify the actual item price.
    if re.search(r'\bto\b|[–—]',price,re.IGNORECASE): return None
    amount,_=price_in_cad({'price':price},rate,rate_date)
    if amount is None:return None
    data=['ebay.ca',title.strip(),price.strip(),item.get('condition') or '',str(rate),rate_date]
    return hashlib.sha256(json.dumps(data,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

def cached_listing(item, cache, rate, rate_date, minimum=None, maximum=None):
    signature=summary_signature(item,rate,rate_date)
    if not signature:return None
    match=re.search(r'/itm/(?:[^/?]+/)?(\d{9,})(?:[/?#]|$)',item.get('url',''))
    if not match:return None
    previous=cache.get(match.group(1))
    if not previous or previous.get('signature')!=signature:return None
    price,_=price_in_cad({'price':previous.get('price')},rate,rate_date)
    if (minimum is not None or maximum is not None) and (price is None or (minimum is not None and price<Decimal(str(minimum))) or (maximum is not None and price>Decimal(str(maximum)))):return None
    age=previous.get('age_seconds')
    if not isinstance(age,(int,float)) or age<0 or age>=DETAIL_REFRESH_SECONDS:return None
    return {'url':item['url'],'cached_id':previous['id']}


def collect_listings(driver, search_handle, selected, minimum, maximum, rate, rate_date, cache=None):
    results = []
    readable = failed = consecutive_failures = 0
    last_request = None
    cache=cache or {}
    for position,entry in enumerate(selected):
        item={'url':entry} if isinstance(entry,str) else entry
        if not isinstance(item,dict) or not item.get('url'):continue
        cached=cached_listing(item,cache,rate,rate_date,minimum,maximum)
        if cached:
            results.append(cached);readable+=1;consecutive_failures=0
            continue
        link=item['url'];handle=None
        if last_request is not None:
            remaining=LISTING_REQUEST_DELAY-(time.monotonic()-last_request)
            if remaining>0:time.sleep(remaining)
        try:
            last_request=time.monotonic()
            handle=open_listing_tab(driver,search_handle,link)
            result,was_read,was_failed=read_listing(driver,search_handle,handle,link,minimum,maximum,rate,rate_date)
            handle=None
            readable+=int(was_read);failed+=int(was_failed)
            consecutive_failures=consecutive_failures+1 if was_failed else 0
            if result:
                result['summary_signature']=summary_signature(item,rate,rate_date)
                results.append(result)
        except EbayForbidden:
            if not readable:raise
            return results,f'Saved {len(results)} eBay listings before eBay refused a listing (HTTP 403). Retrying in 5 minutes.'
        except (RuntimeError,urllib.error.URLError,ConnectionError,TimeoutError) as error:
            if not discarded_context(error) and not isinstance(error,(urllib.error.URLError,ConnectionError,TimeoutError)):raise
            failed+=1;consecutive_failures+=1
        finally:
            if handle:close_tab(driver,handle)
        if consecutive_failures>=3:
            failed+=len(selected)-position-1
            break
    if not results and not readable:raise RuntimeError('Listings appeared, but no listing details could be read.')
    warning=f'Saved {len(results)} eBay listings; {failed} could not be read because Firefox tabs failed or listings were unavailable.' if failed else None
    return results,warning


def search_params(config):
    params={'_nkw':config['search'].strip()}
    if config.get('min_price') is not None:params['_udlo']=str(config['min_price'])
    if config.get('max_price') is not None:params['_udhi']=str(config['max_price'])
    if config['sort_by']=='date_listed':params['_sop']='10'
    if config.get('max_distance_km') is not None and not config.get('use_source_location'):
        params.update({'LH_PrefLoc':'99','_fspt':'1','_sadis':config['max_distance_km'],'_stpos':config['location'].strip()})
    return params


def main():
    config = load_config()
    for item in (DRIVER, FIREFOX, PROFILE):
        if not item.exists(): raise RuntimeError(f'Missing {item}. Set up the eBay source and Firefox runtime first.')
    lock = PROFILE / '.parentlock'
    if lock.exists():
        with lock.open('r+') as file:
            try:
                fcntl.lockf(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.lockf(file, fcntl.LOCK_UN)
            except BlockingIOError:
                raise RuntimeError('Close the eBay source browser before running this script; Firefox cannot share a profile.')
    params = search_params(config)
    minimum, maximum = config.get('min_price'), config.get('max_price')
    rate, rate_date = usd_cad_rate()
    site = SITE
    url = site + '/sch/i.html?' + urlencode(params)
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
        if config.get('use_source_location') and config.get('max_distance_km') is not None:
            postal = default_postal_code(driver, url)
            params.update({'LH_PrefLoc':'99', '_fspt':'1', '_sadis':config['max_distance_km'], '_stpos':postal})
            url = site + '/sch/i.html?' + urlencode(params)
        links = search_links(driver, url)
        if not links:
            print('[]')
            return
        search_handle = driver.request('GET', f'/session/{driver.session}/window')
        results, warning = collect_listings(driver, search_handle, links[:config['max_results']], minimum, maximum, rate, rate_date, config.get('cached_listings'))
        if warning:
            print(f'FMD_WARNING: {warning}',file=sys.stderr)
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
