import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('send_chat', pathlib.Path(__file__).resolve().parent.parent / 'scripts/send-chat.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Process:
    def poll(self): return None
    def terminate(self): pass
    def wait(self, timeout): pass

class Driver:
    def __init__(self, base): self.session = None; self.clicked = []; self.waits = []
    def request(self, method, path, data=None):
        return {'sessionId':'test'} if path == '/session' else {}
    def navigate(self, url): self.url = url
    def execute(self, script, *args): return False
    def wait_for(self, script, timeout=0, args=()):
        self.waits.append((script,args))
        if 'document.readyState' in script: return True
        if 'const fields=' in script and 'send message to' in script: return ['field','send']
        if "return 'existing'" in script: return 'new'
        if "querySelector('textarea#message')" in script: return 'field'
        if "find(b=>visible(b)" in script: return 'send'
        if 'conversation/' in script: return True
        if 'p.innerText.includes(message)' in script: return True
        raise AssertionError(script)
    def type_text(self, element, text): self.typed = (element,text)
    def click(self, element): self.clicked.append(element)

class SendChatTest(unittest.TestCase):
    def run_source(self, source, url):
        driver=Driver('')
        data=json.dumps({'source':source,'url':url,'message':'Hello there'})
        with patch.object(module.sys,'stdin',io.StringIO(data)), patch.object(module.pathlib.Path,'exists',return_value=True), patch.object(module.subprocess,'Popen',return_value=Process()), patch.object(module,'WebDriver',return_value=driver), patch.object(module.time,'sleep'):
            module.main()
        return driver
    def test_kijiji_confirms_new_conversation_without_stale_element(self):
        driver=self.run_source('kijiji','https://www.kijiji.ca/v-test/city/item/1234')
        self.assertEqual(driver.clicked,['send'])
        self.assertEqual(driver.typed,('field','Hello there'))
        self.assertIn('conversation/',driver.waits[-1][0])
        self.assertEqual(driver.waits[-1][1],())
    def test_facebook_uses_inline_seller_form_and_listing_confirmation(self):
        driver=self.run_source('facebook','https://www.facebook.com/marketplace/item/1234/')
        self.assertEqual(driver.clicked,['send'])
        self.assertEqual(driver.waits[-1][1],('1234','Hello there'))

if __name__ == '__main__': unittest.main()
