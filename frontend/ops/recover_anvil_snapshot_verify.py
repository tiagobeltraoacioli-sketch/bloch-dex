#!/usr/bin/env python3
"""Read-only isolated Anvil verification; never signs, mines or changes state."""
import json
import sys
import urllib.request
from recover_anvil_snapshot import load


def rpc(method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    request = urllib.request.Request('http://127.0.0.1:18549', data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        result = json.load(response)
    if 'error' in result:
        raise ValueError('RPC verification failed: ' + method)
    return result['result']


state = load(sys.argv[1])
slots = 0
for address, account in state['accounts'].items():
    assert int(rpc('eth_getBalance', [address, 'latest']), 16) == int(account['balance'], 16)
    assert int(rpc('eth_getTransactionCount', [address, 'latest']), 16) == account['nonce']
    assert rpc('eth_getCode', [address, 'latest']).lower() == account['code']
    for key, value in account['storage'].items():
        assert int(rpc('eth_getStorageAt', [address, key, 'latest']), 16) == int(value, 16)
        slots += 1
print(json.dumps({'verified_accounts': len(state['accounts']), 'verified_storage_slots': slots,
                  'local_block_number': rpc('eth_blockNumber', []),
                  'local_genesis_hash': rpc('eth_getBlockByNumber', ['0x0', False])['hash'],
                  'full_chain_recovery': False}))
