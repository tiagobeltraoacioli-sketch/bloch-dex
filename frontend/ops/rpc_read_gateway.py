#!/usr/bin/env python3
"""Bounded read-only gateway to one operator-configured primary RPC."""
import argparse
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import probe_rpc

MAX_BODY = 65536
MAX_GAS = 500000
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
DATA = re.compile(r"0x(?:[0-9a-fA-F]{2})*\Z")


def require(value):
    if not value:
        raise ValueError("invalid read-only RPC request")


def block_tag(value):
    if value in ("latest", "earliest", "safe", "finalized"):
        return
    probe_rpc.quantity(value, "block tag")


def address(value):
    require(isinstance(value, str) and ADDRESS.fullmatch(value))


def digest(value):
    require(isinstance(value, str) and probe_rpc.HASH.fullmatch(value))


def validate_request(item):
    require(isinstance(item, dict) and set(item) == {"jsonrpc", "id", "method", "params"})
    request_id = item["id"]
    require(item["jsonrpc"] == "2.0" and
            ((type(request_id) is int and 0 <= request_id <= (1 << 53) - 1) or
             (isinstance(request_id, str) and len(request_id) <= 64)))
    method, params = item["method"], item["params"]
    require(isinstance(method, str) and isinstance(params, list))
    if method in ("eth_chainId", "eth_blockNumber"):
        require(len(params) == 0)
    elif method == "eth_getBlockByNumber":
        require(len(params) == 2 and params[1] is False)
        block_tag(params[0])
    elif method == "eth_getBlockByHash":
        require(len(params) == 2 and params[1] is False)
        digest(params[0])
    elif method in ("eth_getCode", "eth_getBalance", "eth_getTransactionCount"):
        require(len(params) == 2)
        address(params[0])
        block_tag(params[1])
    elif method == "eth_getTransactionReceipt":
        require(len(params) == 1)
        digest(params[0])
    elif method == "eth_call":
        require(len(params) == 2 and isinstance(params[0], dict))
        call = params[0]
        require({"to", "gas"} <= set(call) <= {"to", "from", "gas", "data", "value"})
        address(call["to"])
        if "from" in call:
            address(call["from"])
        require(0 < probe_rpc.quantity(call["gas"], "gas") <= MAX_GAS)
        if "value" in call:
            require(probe_rpc.quantity(call["value"], "value") == 0)
        if "data" in call:
            require(isinstance(call["data"], str) and len(call["data"]) <= 8194
                    and DATA.fullmatch(call["data"]))
        block_tag(params[1])
    else:
        raise ValueError("method not allowed")
    return method, params, request_id


class Gateway:
    def __init__(self, upstream, chain_id, genesis, interval=30, timeout=5):
        probe_rpc.endpoint_url(upstream)
        require(upstream.startswith("https://"))
        require(type(chain_id) is int and 0 < chain_id < 1 << 256)
        digest(genesis)
        require(int(genesis[2:], 16) != 0 and 30 <= interval <= 3600 and 0 < timeout <= 10)
        self.upstream, self.chain_id, self.genesis = upstream, chain_id, genesis
        self.interval, self.timeout = interval, timeout
        self.lock = threading.Lock()
        self.last_success = None
        self.healthy = False
        self.latest = None
        self.tokens, self.token_time = 20.0, time.monotonic()

    def refresh(self):
        try:
            result = probe_rpc.probe(self.upstream, self.chain_id, self.genesis, self.timeout)
        except Exception:
            result = {}
        with self.lock:
            self.healthy = result.get("rpc_healthy") is True and result.get("identity_verified") is True
            if self.healthy:
                self.last_success = time.monotonic()
                self.latest = result.get("latest_block")

    def monitor(self, stop):
        while not stop.is_set():
            self.refresh()
            stop.wait(self.interval)

    def health(self):
        with self.lock:
            ready = (self.healthy and self.last_success is not None
                     and time.monotonic() - self.last_success < 2 * self.interval)
            return {"check": "read-only-gateway-to-single-primary", "rpc_healthy": ready,
                    "identity_verified": ready, "latest_block": self.latest if ready else None,
                    "finality_verified": False, "mainnet_ready": False, "bridge_ready": False}

    def allow_rate(self):
        with self.lock:
            now = time.monotonic()
            self.tokens = min(20.0, self.tokens + (now - self.token_time) * 10)
            self.token_time = now
            if self.tokens < 1:
                return False
            self.tokens -= 1
            return True

    def forward(self, item):
        if not self.health()["rpc_healthy"]:
            return 503, {"error": "upstream identity or health unavailable"}
        try:
            method, params, request_id = validate_request(item)
        except (ValueError, TypeError):
            return 400, {"error": "invalid or unsupported read-only RPC request"}
        try:
            result = probe_rpc.rpc(self.upstream, method, params, 1, self.timeout)
            if not self.health()["rpc_healthy"]:
                return 503, {"error": "upstream health expired"}
            # Identity replies must not contradict the background probe.
            if method == "eth_chainId" and probe_rpc.quantity(result, "chain ID") != self.chain_id:
                raise probe_rpc.CheckFailed("identity changed")
            if method == "eth_getBlockByNumber" and params[0] in ("0x0", "earliest"):
                height, digest_value = probe_rpc.block(result, "genesis")
                if height != 0 or digest_value != self.genesis.lower():
                    raise probe_rpc.CheckFailed("identity changed")
            return 200, {"jsonrpc": "2.0", "id": request_id, "result": result}
        except (probe_rpc.CheckFailed, ValueError, TypeError):
            with self.lock:
                self.healthy = False
            return 502, {"error": "upstream read failed"}


class Handler(BaseHTTPRequestHandler):
    server_version = "BlochReadGateway"
    sys_version = ""

    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, *args):
        pass  # Do not log URLs, client payloads or credential-bearing headers.

    def reply(self, status, result):
        body = json.dumps(result, separators=(",", ":"), allow_nan=False).encode()
        if len(body) > probe_rpc.MAX_RESPONSE:
            status, body = 502, b'{"error":"upstream response exceeds size limit"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/health":
            self.reply(404, {"error": "not found"})
            return
        result = self.server.gateway.health()
        self.reply(200 if result["rpc_healthy"] else 503, result)

    def do_POST(self):
        gateway = self.server.gateway
        if self.path != "/":
            self.reply(404, {"error": "not found"})
            return
        if not gateway.health()["rpc_healthy"]:
            self.reply(503, {"error": "upstream identity or health unavailable"})
            return
        if not gateway.allow_rate():
            self.reply(429, {"error": "read request rate exceeded"})
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            require(len(lengths) == 1 and lengths[0].isascii() and lengths[0].isdigit())
            size = int(lengths[0])
            require(0 < size <= MAX_BODY and "Transfer-Encoding" not in self.headers
                    and "Content-Encoding" not in self.headers
                    and self.headers.get_content_type() == "application/json")
            raw = self.rfile.read(size)
            require(len(raw) == size)
            item = json.loads(raw.decode("utf-8"), object_pairs_hook=probe_rpc.unique_object,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, RecursionError, OSError):
            self.reply(400, {"error": "invalid or oversized JSON request"})
            return
        self.reply(*gateway.forward(item))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, bind, gateway):
        self.gateway = gateway
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(bind, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.settimeout(0.1)
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        pass  # Suppress request-derived traceback/URL contents.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--expected-chain-id", required=True, type=int)
    parser.add_argument("--expected-genesis", required=True)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18601)
    parser.add_argument("--interval", type=int, default=30)
    args = parser.parse_args()
    try:
        gateway = Gateway(args.upstream, args.expected_chain_id, args.expected_genesis, args.interval)
        server = Server((args.bind, args.port), gateway)
    except (ValueError, OSError):
        parser.exit(1, "Invalid gateway configuration or listener unavailable\n")
    stop = threading.Event()
    threading.Thread(target=gateway.monitor, args=(stop,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
