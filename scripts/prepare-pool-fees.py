#!/usr/bin/env python3
"""Encode reviewed fee-policy transactions without RPC, signing or broadcasting."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


def require(ok, message):
    if not ok:
        raise ValueError(message)


def fields(value, names):
    require(type(value) is dict and set(value) == set(names.split()), 'unknown/missing policy fields')


def address(value):
    require(type(value) is str and re.fullmatch('0x[0-9a-fA-F]{40}', value)
            and int(value[2:], 16) != 0, 'nonzero EVM address required')
    return value.lower()


def uint(value, maximum):
    require(type(value) is int and 0 <= value <= maximum, 'integer policy limit')
    return value


def word(value):
    return (value[2:] if isinstance(value, str) else hex(value)[2:]).rjust(64, '0')


def prepare(policy):
    fields(policy, 'schema chain_id genesis_hash factory authority routers pools')
    require(policy['schema'] == 'bloch.dex.fee-policy.v1', 'unsupported fee policy')
    chain = uint(policy['chain_id'], (1 << 53) - 1)
    require(chain > 0, 'positive chain ID required')
    require(type(policy['genesis_hash']) is str and re.fullmatch('0x[0-9a-f]{64}', policy['genesis_hash'])
            and int(policy['genesis_hash'][2:], 16) != 0, 'canonical genesis hash required')
    factory, authority = address(policy['factory']), address(policy['authority'])
    require(factory != authority, 'factory cannot be fee authority')
    require(type(policy['pools']) is list and 1 <= len(policy['pools']) <= 64, 'bounded pool set required')
    require(type(policy['routers']) is list and len(policy['routers']) <= 16, 'bounded router set required')
    transactions = []
    def tx(method, selector, arguments):
        transactions.append({'method': method, 'chainId': str(chain), 'from': authority, 'to': factory,
                             'value': '0x0', 'data': selector + ''.join(word(v) for v in arguments)})
    seen_routers, seen_pools = set(), set()
    for router in policy['routers']:
        fields(router, 'address approved')
        target = address(router['address'])
        require(target not in seen_routers and target not in (factory, authority), 'duplicate/invalid router')
        require(type(router['approved']) is bool, 'router approval must be boolean')
        seen_routers.add(target)
        tx('setFeeRouter(address,bool)', '0x5cfcff6a', [target, int(router['approved'])])
    for pool in policy['pools']:
        fields(pool, 'pair fee_bps rebates')
        pair = address(pool['pair'])
        require(pair not in seen_pools and pair not in (factory, authority), 'duplicate/invalid pool')
        seen_pools.add(pair)
        fee = uint(pool['fee_bps'], 1000)
        tx('setPoolFee(address,uint16)', '0x8b0a5f4e', [pair, fee])
        require(type(pool['rebates']) is list and len(pool['rebates']) <= 256, 'bounded address rebates required')
        seen_addresses = set()
        for rebate in pool['rebates']:
            fields(rebate, 'address rebate_bps')
            trader = address(rebate['address'])
            require(trader not in seen_addresses, 'duplicate rebate address')
            seen_addresses.add(trader)
            rate = uint(rebate['rebate_bps'], 10000)
            tx('setAddressRebate(address,address,uint16)', '0xfb9d0304', [pair, trader, rate])
    return {'schema': 'bloch.dex.fee-transactions.v1', 'genesis_hash': policy['genesis_hash'],
            'transactions': transactions, 'broadcast': False, 'onchain_state_verified': False,
            'notice': 'Verify chain/genesis, factory code, canonical pools, current authority and router code before signing. Apply as one reviewed authority batch when available.'}


def unique(pairs):
    output = {}
    for key, value in pairs:
        require(key not in output, 'duplicate JSON key')
        output[key] = value
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('policy', type=Path)
    args = parser.parse_args()
    with args.policy.open('rb') as stream:
        raw = stream.read(1_048_577)
    require(len(raw) <= 1_048_576, 'policy size limit')
    result = prepare(json.loads(raw, object_pairs_hook=unique))
    result['policy_sha3'] = hashlib.sha3_256(raw).hexdigest()
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, TypeError, KeyError, RecursionError) as error:
        print(json.dumps({'broadcast': False, 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
