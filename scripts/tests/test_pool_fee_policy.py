import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('policy', Path(__file__).resolve().parents[1] / 'prepare-pool-fees.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def fixture():
    return dict(schema='bloch.dex.fee-policy.v1', chain_id=8453, genesis_hash='0x' + 'ab'*32,
                factory='0x'+'12'*20, authority='0x'+'23'*20,
                routers=[dict(address='0x'+'34'*20, approved=True)],
                pools=[dict(pair='0x'+'45'*20, fee_bps=100,
                            rebates=[dict(address='0x'+'56'*20, rebate_bps=5000)])])


class FeePolicyTest(unittest.TestCase):
    def test_exact_calldata_and_no_broadcast(self):
        result = policy.prepare(fixture())
        self.assertFalse(result['broadcast'])
        calls = result['transactions']
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1]['data'], '0x8b0a5f4e' + '00'*12+'45'*20 + f'{100:064x}')
        self.assertEqual(calls[2]['data'], '0xfb9d0304' + '00'*12+'45'*20 + '00'*12+'56'*20 + f'{5000:064x}')
        self.assertEqual(calls[0]['value'], '0x0')

    def test_limits_duplicates_and_unknown_fields(self):
        mutations = [lambda p: p.update(extra=True), lambda p: p.update(chain_id=True),
                     lambda p: p.update(factory=p['authority']), lambda p: p['pools'].append(copy.deepcopy(p['pools'][0])),
                     lambda p: p['pools'][0].update(fee_bps=1001),
                     lambda p: p['pools'][0]['rebates'][0].update(rebate_bps=10001),
                     lambda p: p['pools'][0]['rebates'][0].update(rebate_bps=0.5),
                     lambda p: p['routers'][0].update(approved=1)]
        for change in mutations:
            p = fixture(); change(p)
            with self.assertRaises(ValueError): policy.prepare(p)
