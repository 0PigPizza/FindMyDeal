"""Offline browser and PID 1 checks, run inside the release image."""
import http.server
import os
import pathlib
import socket
import sys
import subprocess
import tempfile
import threading
import time
import urllib.error
sys.path.insert(0, '/app')
from facebook_search_test import WebDriver
from kijiji_search_test import SEARCH_STATE

class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302); self.send_header('Location', '/canonical'); self.end_headers(); return
        if self.path == '/slow':
            time.sleep(5); return
        self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
        body = {'/canonical': '<h3><a data-testid="listing-link" href="/123">Item</a></h3><img src="/slow">',
                '/empty': '<p>No results for test</p>', '/blocked': '<p>Access denied</p>'}.get(self.path, '<p>loading</p>')
        self.wfile.write(body.encode())
    def log_message(self, *args): pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
base = 'http://127.0.0.1:%d' % server.server_port
with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); port=s.getsockname()[1]
proc = subprocess.Popen(['/usr/bin/geckodriver', '--host', '127.0.0.1', '--port', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
driver = WebDriver('http://127.0.0.1:%d' % port)
try:
    for _ in range(100):
        try: driver.request('GET', '/status'); break
        except (urllib.error.URLError, ConnectionError): time.sleep(.1)
    for cycle in range(3):
        with tempfile.TemporaryDirectory() as profile:
            caps={'capabilities':{'alwaysMatch':{'browserName':'firefox','moz:firefoxOptions':{'binary':'/opt/firefox/firefox','args':['-headless','-profile',profile]},'pageLoadStrategy':'none'}}}
            driver.session=driver.request('POST','/session',caps)['sessionId']
            for path, key in [('/redirect','links'),('/empty','links'),('/blocked','blocked')]:
                print('fixture:', path, flush=True)
                previous=driver.execute('return performance.timeOrigin;'); driver.navigate(base+path)
                try: result=driver.wait_for(SEARCH_STATE,timeout=10,args=(base+path,previous,False,None))
                except TimeoutError:
                    print(driver.execute('return [location.href, performance.timeOrigin, document.readyState, document.body?.innerHTML];'), 'previous', previous, flush=True); raise
                assert result is not None and key in result, (path,result)
                if path == '/redirect': assert len(result['links']) == 1
                if path == '/empty': assert result['links'] == []
            previous=driver.execute('return performance.timeOrigin;');driver.navigate(base+'/stalled')
            assert driver.wait_for(SEARCH_STATE,timeout=1,args=(base+'/stalled',previous,False,None)) is None
            driver.request('DELETE','/session/'+driver.session);driver.session=None
finally:
    proc.terminate()
    try: proc.wait(timeout=5)
    except subprocess.TimeoutExpired: proc.kill();proc.wait()
    server.shutdown()
# An orphan must be adopted and reaped by the packaged PID 1.
r,w=os.pipe(); child=os.fork()
if child == 0:
    os.close(r); grandchild=os.fork()
    if grandchild == 0:
        os.close(w);time.sleep(.2);os._exit(0)
    os.write(w,str(grandchild).encode());os.close(w);os._exit(0)
os.close(w); orphan=int(os.read(r,64));os.close(r);os.waitpid(child,0)
for _ in range(50):
    if not pathlib.Path('/proc/%d' % orphan).exists(): break
    time.sleep(.1)
else: raise AssertionError('PID 1 did not reap orphan %d' % orphan)
print('Offline browser fixtures and PID 1 reaping passed')
