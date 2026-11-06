import unittest
from unittest.mock import patch
import kijiji_search_test as kijiji
class KijijiLocationTests(unittest.TestCase):
    def test_location_application_retries_once_when_site_does_not_apply_it(self):
        with patch.object(kijiji,'_apply_location_once',side_effect=[RuntimeError('Kijiji did not apply the selected location.'),None]) as call,patch.object(kijiji.time,'sleep'):
            kijiji.apply_location(None,'Toronto',100)
        self.assertEqual(call.call_count,2)
    def test_unrelated_location_error_is_not_retried(self):
        with patch.object(kijiji,'_apply_location_once',side_effect=RuntimeError('Could not open location picker')) as call:
            with self.assertRaisesRegex(RuntimeError,'Could not open'):kijiji.apply_location(None,'Toronto',100)
        self.assertEqual(call.call_count,1)
    def test_repeated_location_failure_is_reported(self):
        with patch.object(kijiji,'_apply_location_once',side_effect=RuntimeError('Kijiji did not apply the selected location.')) as call,patch.object(kijiji.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'did not apply'):kijiji.apply_location(None,'Toronto',100)
        self.assertEqual(call.call_count,2)
if __name__=='__main__':unittest.main()
