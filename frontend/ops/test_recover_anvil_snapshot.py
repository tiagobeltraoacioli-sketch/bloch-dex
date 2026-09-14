import copy
import hashlib
import unittest
from recover_anvil_snapshot import convert, unique


def hash_code(raw):
    # Injected deterministic hash for structural tests; live conversion uses cast keccak.
    return '0x' + hashlib.sha256(raw).hexdigest()


def fixture():
    address = '0x' + '11' * 20
    second = '0x' + '22' * 20
    code = {'LegacyAnalyzed': {'bytecode': '0x60000000', 'original_len': 2, 'jump_table': {}}}
    account = {'balance': '0xffff', 'nonce': 7, 'code_hash': hash_code(b'\x60\x00'), 'code': code}
    duplicate = dict(account, code=None)
    return {'accounts': {address: account, second: duplicate},
            'storage': {address: {'0x0': '0xffff'}, second: {}},
            'block_hashes': {'0x3': '0x' + '33' * 32}}, address


class RecoveryTest(unittest.TestCase):
    def test_shared_runtime_and_padded_storage_preserved_without_fake_chain(self):
        snapshot, address = fixture()
        result, report = convert(snapshot, hash_code, {address: hash_code(b'\x60\x00')})
        self.assertIsNone(result['block'])
        self.assertIsNone(result['best_block_number'])
        self.assertEqual(result['blocks'], [])
        self.assertFalse(report['complete_chain_recovery'])
        self.assertEqual(report['maximum_cached_height'], 3)
        for record in result['accounts'].values():
            self.assertEqual(record['code'], '0x6000')
            self.assertEqual(record['nonce'], 7)
            self.assertEqual(record['balance'], '0xffff')
        self.assertEqual(result['accounts'][address]['storage']['0x' + '00' * 32], '0x' + '00' * 30 + 'ffff')

    def test_missing_code_cannot_erase_contract(self):
        snapshot, _ = fixture()
        for account in snapshot['accounts'].values():
            account['code'] = None
        with self.assertRaisesRegex(ValueError, 'missing runtime'):
            convert(snapshot, hash_code, {})

    def test_corrupt_padding_hash_nonce_slot_or_deployment_rejected(self):
        original, address = fixture()
        mutations = [lambda s: s['accounts'][address].update(nonce=-1),
                     lambda s: s['accounts'][address].update(code_hash='0x' + 'ff' * 32),
                     lambda s: s['accounts'][address]['code']['LegacyAnalyzed'].update(original_len=999),
                     lambda s: s['accounts'][address]['code']['LegacyAnalyzed'].update(bytecode='0x60000100'),
                     lambda s: s['storage'][address].update({'0x00': '0x1'}),
                     lambda s: s['storage'].clear()]
        for mutation in mutations:
            snapshot = copy.deepcopy(original)
            mutation(snapshot)
            with self.assertRaises(ValueError):
                convert(snapshot, hash_code, {})
        with self.assertRaisesRegex(ValueError, 'deployment'):
            convert(original, hash_code, {address: '0x' + 'ff' * 32})

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            unique([('a', 1), ('a', 2)])


if __name__ == '__main__':
    unittest.main()
