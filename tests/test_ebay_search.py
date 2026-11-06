import unittest
from decimal import Decimal
from unittest.mock import patch
import ebay_search_test as ebay

@patch.object(ebay,'LISTING_REQUEST_DELAY',0)
class EbayRefusalTests(unittest.TestCase):
    def test_partial_results_survive_refusal_and_remaining_tabs_close(self):
        opened=[]; closed=[]
        def open_tab(driver, search, link):
            opened.append(link)
            return 'tab-'+link
        def read(driver, search, handle, link, *args):
            if link == '2':
                raise ebay.EbayForbidden('HTTP 403')
            return ({'url':link}, True, False)
        with patch.object(ebay,'open_listing_tab',side_effect=open_tab), patch.object(ebay,'read_listing',side_effect=read), patch.object(ebay,'close_tab',side_effect=lambda driver,handle:closed.append(handle)):
            results,warning=ebay.collect_listings(None,'search',['1','2','3','4'],None,None,None,None)
        self.assertEqual(results,[{'url':'1','summary_signature':None}])
        self.assertEqual(opened,['1','2'])
        self.assertEqual(closed,['tab-2'])
        self.assertIn('HTTP 403',warning)
        self.assertIn('5 minutes',warning)

    def test_refusal_before_any_read_propagates(self):
        with patch.object(ebay,'open_listing_tab',return_value='tab'), patch.object(ebay,'read_listing',side_effect=ebay.EbayForbidden('HTTP 403')), patch.object(ebay,'close_tab'):
            with self.assertRaises(ebay.EbayForbidden):
                ebay.collect_listings(None,'search',['1'],None,None,None,None)

    def test_filtered_read_still_preserves_partial_run(self):
        with patch.object(ebay,'open_listing_tab',side_effect=['a','b']), patch.object(ebay,'read_listing',side_effect=[(None,True,False),ebay.EbayForbidden('HTTP 403')]), patch.object(ebay,'close_tab'):
            results,warning=ebay.collect_listings(None,'search',['1','2'],100,200,None,None)
        self.assertEqual(results,[])
        self.assertIn('HTTP 403',warning)

class CanadianSiteTests(unittest.TestCase):
    def test_search_uses_canadian_dollars_and_kilometres(self):
        self.assertEqual(ebay.SITE,'https://www.ebay.ca')
        config={'search':' ryzen ','min_price':50,'max_price':160,'sort_by':'date_listed','max_distance_km':100,'location':'A1A 1A1','use_source_location':False}
        self.assertEqual(ebay.search_params(config),{'_nkw':'ryzen','_udlo':'50','_udhi':'160','_sop':'10','LH_PrefLoc':'99','_fspt':'1','_sadis':100,'_stpos':'A1A 1A1'})
        config['use_source_location']=True
        self.assertNotIn('_sadis',ebay.search_params(config))
    def test_canadian_and_us_prices_are_distinguished(self):
        rate=Decimal('1.4');date='2026-10-30'
        for price in ['C $100.00','CA $100.00','CAD $100.00','$100.00']:
            with self.subTest(price=price):self.assertEqual(ebay.price_in_cad({'price':price},rate,date)[0],Decimal('100.00'))
        for price in ['US $100.00','USD $100.00']:
            with self.subTest(price=price):self.assertEqual(ebay.price_in_cad({'price':price},rate,date)[0],Decimal('140.00'))
        self.assertIsNone(ebay.price_in_cad({'price':'AU $100.00'},rate,date)[0])

class SearchCacheTests(unittest.TestCase):
    def setUp(self):
        self.rate=Decimal('1.4');self.date='2026-10-30'
        self.card={'url':'https://www.ebay.com/itm/123456789','title':'CPU Ryzen','price':'US $100.00','condition':'Used'}
        self.signature=ebay.summary_signature(self.card,self.rate,self.date)
        self.cache={'123456789':{'id':22,'price':'C $140.00 (approx.; US $100.00, 2026-10-30 rate)','signature':self.signature,'age_seconds':100}}
    def get_cached(self,card=None,cache=None,minimum=None,maximum=None):
        return ebay.cached_listing(self.card if card is None else card,self.cache if cache is None else cache,self.rate,self.date,minimum,maximum)
    def test_unchanged_reuses_saved_id_and_description_is_not_overwritten(self):
        self.assertEqual(self.get_cached(),{'url':self.card['url'],'cached_id':22})
        with patch.object(ebay,'open_listing_tab',side_effect=AssertionError('unexpected request')):
            results,warning=ebay.collect_listings(None,None,[self.card],None,None,self.rate,self.date,self.cache)
        self.assertEqual(results,[{'url':self.card['url'],'cached_id':22}]);self.assertIsNone(warning)
    def test_changed_card_or_exchange_rate_needs_refresh(self):
        for field,value in [('title','New title'),('price','US $101.00'),('condition','New')]:
            with self.subTest(field=field):self.assertIsNone(self.get_cached({**self.card,field:value}))
        self.assertIsNone(ebay.cached_listing(self.card,self.cache,Decimal('1.5'),self.date))
        self.assertIsNone(ebay.cached_listing(self.card,self.cache,self.rate,'2026-11-01'))
    def test_expiration_and_untrusted_age(self):
        for age in [None,-1,86400,999999]:
            with self.subTest(age=age):self.assertIsNone(self.get_cached(cache={'123456789':{**self.cache['123456789'],'age_seconds':age}}))
        self.assertIsNotNone(self.get_cached(cache={'123456789':{**self.cache['123456789'],'age_seconds':86399}}))
    def test_ambiguous_or_missing_card_details_never_reused(self):
        for change in [{'title':None},{'price':None},{'price':'US $100.00 to US $150.00'},{'price':'Contact seller'},{'url':'https://www.ebay.com/itm/not-an-id'}]:
            with self.subTest(change=change):self.assertIsNone(self.get_cached({**self.card,**change}))
    def test_monitor_price_bounds_still_apply_to_cached_items(self):
        self.assertIsNotNone(self.get_cached(minimum=140,maximum=140))
        self.assertIsNone(self.get_cached(minimum=141))
        self.assertIsNone(self.get_cached(maximum=139))
        self.assertIsNone(self.get_cached(cache={'123456789':{**self.cache['123456789'],'price':None}},maximum=100))
    def test_new_or_changed_listing_gets_details_and_a_signature(self):
        with patch.object(ebay,'open_listing_tab',return_value='tab'),patch.object(ebay,'read_listing',return_value=({'title':'CPU','price':'$100','description':'full description'},True,False)) as read:
            results,warning=ebay.collect_listings(None,None,[self.card],None,None,self.rate,self.date,{})
        self.assertEqual(read.call_count,1);self.assertEqual(results[0]['description'],'full description');self.assertEqual(results[0]['summary_signature'],self.signature);self.assertIsNone(warning)
    def test_partial_403_keeps_cached_and_fresh_items(self):
        second={**self.card,'url':'https://www.ebay.com/itm/987654321'}
        with patch.object(ebay,'open_listing_tab',return_value='tab'),patch.object(ebay,'read_listing',side_effect=ebay.EbayForbidden('403')),patch.object(ebay,'close_tab'):
            results,warning=ebay.collect_listings(None,None,[self.card,second],None,None,self.rate,self.date,self.cache)
        self.assertEqual(results,[{'url':self.card['url'],'cached_id':22}]);self.assertIn('HTTP 403',warning)
    def test_thirty_unchanged_items_need_no_detail_requests_then_one_change_needs_one(self):
        cards=[{**self.card,'url':f'https://www.ebay.com/itm/{123456789+i}'} for i in range(30)]
        cache={str(123456789+i):{'id':i+1,'price':'C $140.00','signature':self.signature,'age_seconds':60} for i in range(30)}
        with patch.object(ebay,'open_listing_tab',return_value='tab') as open_tab,patch.object(ebay,'read_listing',return_value=({'title':'CPU','description':'full'},True,False)):
            results,_=ebay.collect_listings(None,None,cards,None,None,self.rate,self.date,cache)
            self.assertEqual(len(results),30);self.assertEqual(open_tab.call_count,0)
            cards[12]={**cards[12],'price':'US $101.00'}
            results,_=ebay.collect_listings(None,None,cards,None,None,self.rate,self.date,cache)
            self.assertEqual(len(results),30);self.assertEqual(open_tab.call_count,1)

    def test_detail_requests_are_serial_and_spaced(self):
        entries=['1','2','3'];opened=[]
        with patch.object(ebay,'open_listing_tab',side_effect=lambda driver,handle,url:opened.append(url) or url),patch.object(ebay,'read_listing',side_effect=lambda driver,search,handle,url,*a:({'url':url},True,False)),patch.object(ebay.time,'monotonic',side_effect=[0,0,2,2,4]),patch.object(ebay.time,'sleep') as sleep:
            results,_=ebay.collect_listings(None,None,entries,None,None,self.rate,self.date)
        self.assertEqual(opened,entries);self.assertEqual(len(results),3);self.assertEqual([x.args[0] for x in sleep.call_args_list],[2,2])

if __name__=='__main__': unittest.main()
