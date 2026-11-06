import unittest
from unittest.mock import patch
import facebook_search_test as facebook

class FakeDriver:
    def __init__(self, answers):self.session='test';self.answers=iter(answers);self.opened=[];self.closed=[];self.current=None
    def request(self, method, path, data=None):
        if path.endswith('/window/new'):
            handle=f'tab{len(self.opened)+1}';self.opened.append(handle);return {'handle':handle}
        if method=='POST' and path.endswith('/window'):self.current=data['handle'];return None
        if method=='DELETE' and path.endswith('/window'):self.closed.append(self.current);return None
        raise AssertionError((method,path,data))
    def navigate(self,link):pass
    def wait_for(self,script,timeout,args):
        assert timeout==20
        return next(self.answers)

class FacebookPartialTests(unittest.TestCase):
    def test_complete_run_returns_all(self):
        d=FakeDriver([{'title':'a'},{'title':'b'},{'title':'c'},{'title':'d'}]);results,warning=facebook.collect_listing_details(d,'search',['a','b','c','d'])
        self.assertEqual([r['url'] for r in results],['a','b','c','d']);self.assertIsNone(warning);self.assertCountEqual(d.opened,d.closed)
    def test_repeated_unreadable_details_stop_and_keep_prior_results(self):
        d=FakeDriver([{'title':'a'},None,None,None]);results,warning=facebook.collect_listing_details(d,'search',['a','b','c','d','e','f','g'])
        self.assertEqual([r['url'] for r in results],['a']);self.assertIn('Saved 1',warning);self.assertEqual(len(d.opened),6);self.assertCountEqual(d.opened,d.closed)
    def test_browser_failure_preserves_readable_results(self):
        d=FakeDriver([{'title':'a'},RuntimeError('lost tab')])
        original=d.wait_for
        def wait(*args,**kwargs):
            result=original(*args,**kwargs)
            if isinstance(result,Exception):raise result
            return result
        d.wait_for=wait
        results,warning=facebook.collect_listing_details(d,'search',['a','b','c'])
        self.assertEqual([r['url'] for r in results],['a']);self.assertIn('Saved 1',warning);self.assertCountEqual(d.opened,d.closed)
    def test_blocked_listing_preserves_partial_and_stops(self):
        d=FakeDriver([{'title':'a'},{'blocked':True}]);results,warning=facebook.collect_listing_details(d,'search',['a','b','c','d'])
        self.assertEqual([r['url'] for r in results],['a']);self.assertIn('Facebook temporarily blocked access',warning);self.assertIn('1 hour',warning);self.assertCountEqual(d.opened,d.closed)
    def test_first_blocked_listing_raises_explicit_error(self):
        d=FakeDriver([{'blocked':True}])
        with self.assertRaises(facebook.FacebookTemporarilyBlocked):facebook.collect_listing_details(d,'search',['a'])
    def test_blocked_search_raises_explicit_error(self):
        class SearchDriver:
            def wait_for(self,*args,**kwargs):return {'blocked':True}
        with self.assertRaises(facebook.FacebookTemporarilyBlocked):facebook.collect_search_links(SearchDriver(),5)
    def test_search_returns_requested_number_of_links(self):
        class SearchDriver:
            def wait_for(self,*args,**kwargs):return {'links':['a','b','c']}
        self.assertEqual(facebook.collect_search_links(SearchDriver(),2),['a','b'])
    def test_no_readable_details_reports_clear_failure(self):
        d=FakeDriver([None,None,None])
        with self.assertRaisesRegex(RuntimeError,'no listing details'):facebook.collect_listing_details(d,'search',['a','b','c','d'])
        self.assertCountEqual(d.opened,d.closed)
    def test_deadline_keeps_results_and_closes_pending_tabs(self):
        d=FakeDriver([{'title':'a'}]);clock=iter([0,0,0,0,0,100])
        with patch.object(facebook.time,'monotonic',side_effect=lambda:next(clock,100)):
            results,warning=facebook.collect_listing_details(d,'search',['a','b','c'],deadline_seconds=30)
        self.assertEqual(len(results),1);self.assertTrue(warning);self.assertCountEqual(d.opened,d.closed)

if __name__=='__main__':unittest.main()
