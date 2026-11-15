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
    def test_kijiji_rechecks_ambiguous_result_without_sending_twice(self):
        class DelayedDriver(Driver):
            def wait_for(self,script,timeout=0,args=()):
                if 'conversation/' in script:
                    self.waits.append((script,args));return None
                return super().wait_for(script,timeout,args)
        driver=DelayedDriver('')
        data=json.dumps({'source':'kijiji','url':'https://www.kijiji.ca/v-test/city/item/1234','message':'Hello there'})
        with patch.object(module.sys,'stdin',io.StringIO(data)), patch.object(module.pathlib.Path,'exists',return_value=True), patch.object(module.subprocess,'Popen',return_value=Process()), patch.object(module,'WebDriver',return_value=driver), patch.object(module.time,'sleep'), patch.object(module,'confirm_kijiji_conversation',return_value=True) as confirm:
            module.main()
        self.assertEqual(driver.clicked,['send'])
        confirm.assert_called_once_with(driver,'https://www.kijiji.ca/v-test/city/item/1234','1234','Hello there')
    def test_facebook_uses_inline_seller_form_and_listing_confirmation(self):
        driver=self.run_source('facebook','https://www.facebook.com/marketplace/item/1234/')
        self.assertEqual(driver.clicked,['send'])
        self.assertEqual(driver.waits[-1][1],('1234','Hello there'))


class KijijiConfirmationTest(unittest.TestCase):
    def test_rechecks_listing_and_verifies_conversation_without_sending(self):
        class VerificationDriver:
            def __init__(self): self.visited=[];self.calls=[]
            def navigate(self,url): self.visited.append(url)
            def wait_for(self,script,timeout,args):
                self.calls.append((script,args))
                return '/m-msg-my-messages/conversation/test' if len(self.calls)==1 else True
        driver=VerificationDriver()
        self.assertTrue(module.confirm_kijiji_conversation(driver,'https://www.kijiji.ca/v-test/city/item/1234','1234','Hello there'))
        self.assertEqual(driver.visited,['https://www.kijiji.ca/v-test/city/item/1234','https://www.kijiji.ca/m-msg-my-messages/conversation/test'])
        self.assertEqual(driver.calls[1][1],('1234','Hello there'))
    def test_unavailable_conversation_remains_unconfirmed(self):
        class MissingDriver:
            def navigate(self,url): pass
            def wait_for(self,*args,**kwargs): return None
        self.assertFalse(module.confirm_kijiji_conversation(MissingDriver(),'https://www.kijiji.ca/v-test/city/item/1234','1234','Hello there'))

if __name__ == '__main__': unittest.main()
