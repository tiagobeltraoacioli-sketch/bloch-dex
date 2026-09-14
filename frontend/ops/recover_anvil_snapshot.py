#!/usr/bin/env python3
"""Offline account salvage, NOT chain recovery (Foundry 4072e487 db.rs).

Never fabricates block headers, timestamps, genesis, transactions or receipts.
Outputs only an account-only SerializableState for isolated inspection.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def load(path):
    return json.loads(Path(path).read_bytes(), object_pairs_hook=unique)


def hexbytes(value, length=None):
    if not isinstance(value, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', value):
        raise ValueError('invalid hex bytes')
    result = bytes.fromhex(value[2:])
    if length is not None and len(result) != length:
        raise ValueError('invalid byte length')
    return result


def uint(value, bits=256):
    if isinstance(value, str) and re.fullmatch(r'0x[0-9a-fA-F]+', value):
        value = int(value, 16)
    if type(value) is not int or not 0 <= value < 2**bits:
        raise ValueError('invalid unsigned integer')
    return value


def convert(snapshot, keccak, contracts):
    if set(snapshot) != {'accounts', 'storage', 'block_hashes'}:
        raise ValueError('unexpected snapshot fields')
    if set(snapshot['storage']) != set(snapshot['accounts']):
        raise ValueError('storage/account mismatch')
    # Foundry clear_into_state_snapshot removes shared code from its hash map
    # once, leaving code=None on later accounts sharing the same runtime hash.
    codes = {keccak(b''): b''}
    for account in snapshot['accounts'].values():
        if set(account) != {'balance', 'nonce', 'code_hash', 'code'}:
            raise ValueError('unexpected account fields')
        code = account['code']
        if code is None:
            continue
        if set(code) != {'LegacyAnalyzed'}:
            raise ValueError('unsupported bytecode representation')
        analyzed = code['LegacyAnalyzed']
        if set(analyzed) != {'bytecode', 'original_len', 'jump_table'}:
            raise ValueError('unexpected analyzed bytecode fields')
        padded = hexbytes(analyzed['bytecode'])
        length = uint(analyzed['original_len'], 64)
        if length > len(padded) or any(padded[length:]):
            raise ValueError('invalid analyzed bytecode padding')
        raw = padded[:length]
        expected = '0x' + hexbytes(account['code_hash'], 32).hex()
        if expected != keccak(raw):
            raise ValueError('account code hash mismatch')
        codes[expected] = raw
    records = {}
    for address, account in snapshot['accounts'].items():
        hexbytes(address, 20)
        source_address = address
        address = address.lower()
        if address in records:
            raise ValueError('duplicate normalized address')
        expected = '0x' + hexbytes(account['code_hash'], 32).hex()
        if expected not in codes:
            raise ValueError('missing runtime code for account hash')
        raw = codes[expected]
        slots = {}
        for key, value in snapshot['storage'][source_address].items():
            slot = '0x' + uint(key).to_bytes(32, 'big').hex()
            if slot in slots:
                raise ValueError('duplicate normalized storage slot')
            slots[slot] = '0x' + uint(value).to_bytes(32, 'big').hex()
        records[address] = {'balance': hex(uint(account['balance'])),
                            'nonce': uint(account['nonce'], 64),
                            'code': '0x' + raw.hex(), 'storage': slots}
    for address, expected in contracts.items():
        address = address.lower()
        hexbytes(expected, 32)
        if address not in records or keccak(hexbytes(records[address]['code'])) != expected.lower():
            raise ValueError('deployment runtime hash mismatch')
    hashes = {}
    for height, block_hash in snapshot['block_hashes'].items():
        number = uint(height, 64)
        if number in hashes:
            raise ValueError('duplicate normalized block number')
        hashes[number] = '0x' + hexbytes(block_hash, 32).hex()
    if not hashes:
        raise ValueError('no block hash evidence')
    maximum = max(hashes)
    report = {'account_count': len(records), 'storage_slots': sum(len(a['storage']) for a in records.values()),
              'verified_deployment_contracts': len(contracts), 'cached_block_hash_count': len(hashes),
              'maximum_cached_height': maximum, 'maximum_cached_hash': hashes[maximum],
              'complete_chain_recovery': False,
              'missing': ['block headers', 'transactions', 'receipts', 'block environment', 'changes after snapshot']}
    return {'block': None, 'best_block_number': None, 'accounts': records,
            'blocks': [], 'transactions': [], 'historical_states': None}, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot')
    parser.add_argument('--deployment', required=True)
    parser.add_argument('--cast', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--cast-library-path')
    args = parser.parse_args()
    environment = dict(os.environ)
    if args.cast_library_path:
        environment['DYLD_LIBRARY_PATH'] = args.cast_library_path
    def keccak(raw):
        return subprocess.check_output([args.cast, 'keccak', '0x' + raw.hex()], text=True, env=environment).strip().lower()
    state, report = convert(load(args.snapshot), keccak, load(args.deployment)['contracts'])
    # Refuse to overwrite an existing artifact; caller must explicitly select a new path.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(state, output, sort_keys=True)
    report['source_sha256'] = hashlib.sha256(Path(args.snapshot).read_bytes()).hexdigest()
    print(json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    main()
