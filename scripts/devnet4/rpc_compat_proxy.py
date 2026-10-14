#!/usr/bin/env python3
"""Development JSON-RPC shim between Foundry and the Bloch L2 settled RPC.

The settled RPC omits two constant post-merge header fields (`sha3Uncles`,
`nonce`) from block objects, which alloy-based clients (forge, cast) refuse to
deserialize. This proxy forwards every request unchanged and, in block
results only, fills those fields with their fixed post-merge values when they
are absent. It never alters a field the upstream returned, never signs and
never caches. Remove it once the settled RPC emits the fields itself.
"""
import argparse
import http.server
import json
import urllib.request

EMPTY_UNCLES = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347"
BLOCK_METHODS = {"eth_getBlockByNumber", "eth_getBlockByHash"}
DEFAULTS = {"sha3Uncles": EMPTY_UNCLES, "nonce": "0x0000000000000000"}
MAX_BODY = 8 << 20


def patch(request, response):
    if isinstance(request, dict) and request.get("method") in BLOCK_METHODS:
        block = response.get("result") if isinstance(response, dict) else None
        if isinstance(block, dict):
            for key, value in DEFAULTS.items():
                block.setdefault(key, value)
    return response


class Handler(http.server.BaseHTTPRequestHandler):
    upstream = ""

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > MAX_BODY:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        upstream = urllib.request.Request(self.upstream, data=body, headers={"content-type": "application/json"})
        with urllib.request.urlopen(upstream, timeout=120) as reply:
            raw = reply.read(MAX_BODY + 1)
        try:
            request, response = json.loads(body), json.loads(raw)
            if isinstance(request, list) and isinstance(response, list):
                by_id = {json.dumps(r.get("id")): r for r in request if isinstance(r, dict)}
                response = [patch(by_id.get(json.dumps(r.get("id"))), r) for r in response]
            else:
                response = patch(request, response)
            raw = json.dumps(response).encode()
        except (ValueError, AttributeError):
            pass  # not JSON we understand: pass the upstream bytes through
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--listen", default="127.0.0.1:18946")
    parser.add_argument("--upstream", default="http://127.0.0.1:18945")
    args = parser.parse_args()
    host, port = args.listen.rsplit(":", 1)
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("--listen must be a loopback address")
    Handler.upstream = args.upstream
    http.server.ThreadingHTTPServer((host, int(port)), Handler).serve_forever()


if __name__ == "__main__":
    main()
