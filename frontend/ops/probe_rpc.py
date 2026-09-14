#!/usr/bin/env python3
"""Read-only RPC identity/health check, never a finality or readiness proof."""
import argparse
import http.client
import ipaddress
import json
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_RESPONSE = 262144
USER_AGENT = "PosternNetworkMonitor/1.0"
HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
QUANTITY = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")


class CheckFailed(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise CheckFailed(message)


def endpoint_url(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        require(not any(ord(char) <= 32 or ord(char) == 127 for char in value),
                "endpoint contains control characters or whitespace")
        require(parsed.hostname and parsed.username is None and parsed.password is None
                and not parsed.query and not parsed.fragment and "?" not in value and "#" not in value,
                "endpoint must omit credentials, query and fragment")
        # Remote plaintext URLs are forbidden. HTTP exists only for local probes/tests.
        loopback = False
        try:
            loopback = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            pass
        require(parsed.scheme == "https" or (parsed.scheme == "http" and loopback),
                "endpoint requires HTTPS (HTTP allowed only for loopback IP literals)")
        require(parsed.port is None or 0 < parsed.port <= 65535, "invalid endpoint port")
    except ValueError as error:
        if isinstance(error, CheckFailed):
            raise
        raise CheckFailed("invalid endpoint URL") from None
    return value


def unique_object(items):
    result = {}
    for key, value in items:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CheckFailed("RPC redirects are not accepted")


def rpc(endpoint, method, params, request_id, timeout):
    request = urllib.request.Request(endpoint, data=json.dumps({
        "jsonrpc": "2.0", "id": request_id, "method": method, "params": params
    }).encode(), headers={"Content-Type": "application/json", "Accept": "application/json",
                         "User-Agent": USER_AGENT})
    # Disable implicit environment proxies, credential handlers and redirects.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    try:
        with opener.open(request, timeout=timeout) as response:
            require(response.status == 200, "RPC HTTP status is not 200")
            require(response.headers.get_content_type() == "application/json",
                    "RPC response is not application/json")
            require(response.headers.get("Content-Encoding", "identity") == "identity",
                    "encoded RPC responses are not accepted")
            raw = response.read(MAX_RESPONSE + 1)
        require(len(raw) <= MAX_RESPONSE, "RPC response exceeds size limit")
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(CheckFailed("nonfinite JSON value")))
        require(isinstance(data, dict) and set(data) == {"jsonrpc", "id", "result"},
                "RPC response must contain exactly jsonrpc, id and result")
        require(data["jsonrpc"] == "2.0" and type(data["id"]) is int and data["id"] == request_id,
                "RPC response version or request ID mismatch")
        return data["result"]
    except CheckFailed:
        raise
    except (OSError, ValueError, RecursionError, urllib.error.URLError, http.client.HTTPException):
        # Exception messages can include URLs, response bodies or secrets.
        raise CheckFailed("RPC transport, timeout or JSON decoding failure") from None


def quantity(value, label):
    require(isinstance(value, str) and len(value) <= 66 and QUANTITY.fullmatch(value),
            f"malformed {label}")
    return int(value, 16)


def block(value, label):
    require(isinstance(value, dict), f"missing or malformed {label} block")
    height = quantity(value.get("number"), f"{label} block number")
    digest = value.get("hash")
    require(isinstance(digest, str) and HASH.fullmatch(digest) and int(digest[2:], 16) != 0,
            f"missing or malformed {label} block hash")
    return height, digest.lower()


def probe(endpoint, expected_chain_id, expected_genesis, timeout=5.0):
    result = {"check": "read-only-rpc-identity-and-health-only", "rpc_healthy": False,
              "identity_verified": False, "finality_verified": False,
              "mainnet_ready": False, "bridge_ready": False}
    try:
        endpoint_url(endpoint)
        require(type(expected_chain_id) is int and 0 < expected_chain_id < 1 << 256,
                "expected chain ID must be a positive uint256")
        require(isinstance(expected_genesis, str) and HASH.fullmatch(expected_genesis)
                and int(expected_genesis[2:], 16) != 0, "expected genesis must be a nonzero 32-byte hash")
        require(type(timeout) in (int, float) and 0 < timeout <= 30, "timeout must be in (0, 30] seconds")
        chain_id = quantity(rpc(endpoint, "eth_chainId", [], 1, timeout), "chain ID")
        require(chain_id == expected_chain_id, "RPC chain ID does not match expected identity")
        genesis_height, genesis_hash = block(rpc(endpoint, "eth_getBlockByNumber", ["0x0", False], 2, timeout), "genesis")
        require(genesis_height == 0 and genesis_hash == expected_genesis.lower(),
                "RPC genesis does not match expected identity")
        height, digest = block(rpc(endpoint, "eth_getBlockByNumber", ["latest", False], 3, timeout), "latest")
        require(height != 0 or digest == genesis_hash, "latest block at height zero contradicts genesis")
        result.update(rpc_healthy=True, identity_verified=True, chain_id=chain_id,
                      genesis_hash=genesis_hash, latest_block={"number": height, "hash": digest})
    except CheckFailed as error:
        result["error"] = str(error)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--expected-chain-id", required=True, type=int)
    parser.add_argument("--expected-genesis", required=True)
    parser.add_argument("--timeout", default=5.0, type=float)
    args = parser.parse_args()
    result = probe(args.endpoint, args.expected_chain_id, args.expected_genesis, args.timeout)
    print(json.dumps(result, indent=2))
    return 0 if result["rpc_healthy"] else 1


if __name__ == "__main__":
    sys.exit(main())
