import importlib.util
import json
from pathlib import Path
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("probe_rpc", Path(__file__).resolve().parents[1] / "probe_rpc.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
GENESIS = "0x" + "ab" * 32
LATEST = "0x" + "cd" * 32


class RpcTests(unittest.TestCase):
    def check(self, values):
        with patch.object(probe, "rpc", side_effect=values) as request:
            result = probe.probe("https://rpc.example.test", 84001, GENESIS)
        return result, request

    def test_identity_and_latest_use_only_read_methods(self):
        result, request = self.check(["0x14821", {"number": "0x0", "hash": GENESIS},
                                      {"number": "0x12", "hash": LATEST}])
        self.assertTrue(result["rpc_healthy"])
        self.assertEqual(result["latest_block"]["number"], 18)
        self.assertTrue(result["identity_verified"])
        for key in ("finality_verified", "mainnet_ready", "bridge_ready"):
            self.assertIs(result[key], False)
        self.assertEqual([(c.args[1], c.args[2]) for c in request.call_args_list],
                         [("eth_chainId", []), ("eth_getBlockByNumber", ["0x0", False]),
                          ("eth_getBlockByNumber", ["latest", False])])

    def test_wrong_chain_stops_before_blocks(self):
        result, request = self.check([hex(8400)])
        self.assertFalse(result["rpc_healthy"])
        self.assertEqual(request.call_count, 1)

    def test_wrong_genesis_and_malformed_blocks(self):
        for genesis in (None, [], {"number": "0x1", "hash": GENESIS},
                        {"number": "0x0", "hash": LATEST}, {"number": "0x00", "hash": GENESIS}):
            with self.subTest(genesis=genesis):
                result, request = self.check([hex(84001), genesis])
                self.assertFalse(result["identity_verified"])
                self.assertEqual(request.call_count, 2)
        for latest in (None, {}, {"number": "0x2", "hash": "0x" + "00" * 32},
                       {"number": "0x0", "hash": LATEST}, {"number": True, "hash": LATEST}):
            result, _ = self.check([hex(84001), {"number": "0x0", "hash": GENESIS}, latest])
            self.assertFalse(result["rpc_healthy"])

    def test_endpoint_credentials_never_reach_transport_or_output(self):
        for endpoint in ("https://secret:password@rpc.test", "https://rpc.test?token=secret",
                         "https://rpc.test#secret", "http://rpc.test", "file:///secret",
                         "https://rpc.test\nsecret", "https://rpc.test:bad"):
            with patch.object(probe, "rpc") as request:
                result = probe.probe(endpoint, 84001, GENESIS)
                request.assert_not_called()
            self.assertFalse(result["rpc_healthy"])
            self.assertNotIn("secret", json.dumps(result))

    def test_invalid_expected_identity_is_not_requested(self):
        for chain, genesis, timeout in [(True, GENESIS, 1), (0, GENESIS, 1),
                                        (84001, "0x1234", 1), (84001, GENESIS, float("nan")),
                                        (84001, GENESIS, 31)]:
            with patch.object(probe, "rpc") as request:
                result = probe.probe("https://rpc.test", chain, genesis, timeout)
                request.assert_not_called()
            self.assertFalse(result["rpc_healthy"])


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                cls.requests.append(request)
                cls.user_agents.append(self.headers.get("User-Agent"))
                time.sleep(cls.delay)
                self.send_response(cls.status)
                self.send_header("Content-Type", cls.content_type)
                if cls.status == 302:
                    self.send_header("Location", "/redirect-secret")
                self.end_headers()
                try:
                    self.wfile.write(cls.body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = f"http://127.0.0.1:{cls.server.server_port}/"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        type(self).requests = []
        type(self).user_agents = []
        type(self).body = b'{"jsonrpc":"2.0","id":1,"result":"0x14821"}'
        type(self).content_type = "application/json"
        type(self).status = 200
        type(self).delay = 0

    def call(self, timeout=1):
        return probe.rpc(self.endpoint, "eth_chainId", [], 1, timeout)

    def test_valid_transport(self):
        self.assertEqual(self.call(), hex(84001))
        self.assertEqual(self.requests[0]["method"], "eth_chainId")
        self.assertEqual(self.user_agents, ["PosternNetworkMonitor/1.0"])

    def test_malformed_http_protocol_is_sanitized(self):
        with patch.object(probe.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = probe.http.client.BadStatusLine("secret")
            with self.assertRaises(probe.CheckFailed) as failure:
                self.call()
        self.assertNotIn("secret", str(failure.exception))

    def test_rejects_malformed_json_rpc_and_oversize(self):
        for body in (b"<html>secret</html>", b"\xff", b"[]", b"{" * 3000,
                     b'{"jsonrpc":"2.0","id":true,"result":1}',
                     b'{"jsonrpc":"2.0","id":2,"result":1}',
                     b'{"jsonrpc":"2.0","id":1,"result":1,"result":2}',
                     b'{"jsonrpc":"2.0","id":1,"result":NaN}',
                     b'{"jsonrpc":"2.0","id":1,"error":{"message":"secret"}}',
                     b" " * (probe.MAX_RESPONSE + 1)):
            type(self).body = body
            with self.subTest(body=body[:60]), self.assertRaises(probe.CheckFailed) as failure:
                self.call()
            self.assertNotIn("secret", str(failure.exception))

    def test_non_json_content_type_http_error_and_redirect(self):
        type(self).content_type = "text/html"
        with self.assertRaises(probe.CheckFailed):
            self.call()
        type(self).content_type = "application/json"
        for status in (502, 302):
            type(self).status = status
            with self.assertRaises(probe.CheckFailed):
                self.call()
        self.assertEqual(len(self.requests), 3)  # Redirect was never followed.

    def test_timeout_fails_closed(self):
        type(self).delay = 0.2
        with self.assertRaises(probe.CheckFailed):
            self.call(timeout=0.02)


if __name__ == "__main__":
    unittest.main()
