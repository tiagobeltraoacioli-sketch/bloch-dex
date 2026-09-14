import http.client
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rpc_read_gateway as gateway

GENESIS = "0x" + "ab" * 32
ADDRESS = "0x" + "12" * 20


def request(method="eth_chainId", params=None):
    return {"jsonrpc": "2.0", "id": "client-id", "method": method, "params": params or []}


def healthy():
    instance = gateway.Gateway("https://operator.example/rpc", 84001, GENESIS)
    instance.healthy = True
    instance.last_success = time.monotonic()
    return instance


class GatewayTests(unittest.TestCase):
    def test_startup_wrong_chain_and_expiry_fail_closed(self):
        instance = gateway.Gateway("https://operator.example/rpc", 84001, GENESIS)
        with patch.object(gateway.probe_rpc, "rpc") as rpc:
            self.assertEqual(instance.forward(request())[0], 503)
            rpc.assert_not_called()
        with patch.object(gateway.probe_rpc, "rpc", return_value=hex(8400)) as rpc:
            instance.refresh()
            self.assertEqual(rpc.call_count, 1)
        self.assertFalse(instance.health()["rpc_healthy"])
        with patch.object(gateway.probe_rpc, "probe", return_value={"rpc_healthy": True, "identity_verified": True}):
            instance.refresh()
        self.assertTrue(instance.health()["rpc_healthy"])
        instance.last_success -= 60
        with patch.object(gateway.probe_rpc, "rpc") as rpc:
            self.assertEqual(instance.forward(request())[0], 503)
            rpc.assert_not_called()

    def test_health_reads_cache_without_network_or_readiness_claims(self):
        instance = healthy()
        with patch.object(gateway.probe_rpc, "rpc") as rpc:
            result = instance.health()
            rpc.assert_not_called()
        for field in ("finality_verified", "mainnet_ready", "bridge_ready"):
            self.assertIs(result[field], False)

    def test_broadcast_admin_wallet_and_batch_never_forward(self):
        instance = healthy()
        with patch.object(gateway.probe_rpc, "rpc") as rpc:
            for method in ("eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign",
                           "wallet_addEthereumChain", "admin_peers", "anvil_mine", "debug_traceCall", "eth_getLogs"):
                self.assertEqual(instance.forward(request(method))[0], 400)
            self.assertEqual(instance.forward([request()])[0], 400)
            rpc.assert_not_called()

    def test_all_supported_methods_preserve_fixed_upstream_and_client_id(self):
        cases = [("eth_chainId", [], hex(84001)), ("eth_blockNumber", [], "0x1"),
                 ("eth_getBlockByNumber", ["latest", False], None),
                 ("eth_getBlockByHash", [GENESIS, False], None),
                 ("eth_getCode", [ADDRESS, "latest"], "0x"),
                 ("eth_getBalance", [ADDRESS, "0x0"], "0x0"),
                 ("eth_getTransactionCount", [ADDRESS, "finalized"], "0x0"),
                 ("eth_getTransactionReceipt", [GENESIS], None),
                 ("eth_call", [{"to": ADDRESS, "gas": hex(gateway.MAX_GAS), "data": "0xab", "value": "0x0"}, "latest"], "0x")]
        for method, params, value in cases:
            instance = healthy()
            with patch.object(gateway.probe_rpc, "rpc", return_value=value) as rpc:
                status, body = instance.forward(request(method, params))
                self.assertEqual(status, 200)
                self.assertEqual(body["id"], "client-id")
                self.assertEqual(rpc.call_args.args[:4], (instance.upstream, method, params, 1))

    def test_malicious_parameters_rejected(self):
        cases = [("eth_chainId", ["https://attacker"]), ("eth_getBlockByNumber", ["latest", True]),
                 ("eth_getBlockByNumber", [{"blockHash": GENESIS}, False]),
                 ("eth_getBalance", [ADDRESS, "pending"]), ("eth_getBalance", [ADDRESS, "0x00"]),
                 ("eth_getBalance", ["https://attacker", "latest"]),
                 ("eth_call", [{"to": ADDRESS}, "latest"]),
                 ("eth_call", [{"to": ADDRESS, "gas": hex(gateway.MAX_GAS + 1)}, "latest"]),
                 ("eth_call", [{"to": ADDRESS, "gas": "0x1", "value": "0x1"}, "latest"]),
                 ("eth_call", [{"to": ADDRESS, "gas": "0x1", "data": "0x" + "aa" * 4097}, "latest"]),
                 ("eth_call", [{"to": ADDRESS, "gas": "0x1", "stateOverride": {}}, "latest"]),
                 ("eth_call", [{"to": ADDRESS, "gas": "0x1"}, "latest", {}])]
        with patch.object(gateway.probe_rpc, "rpc") as rpc:
            for method, params in cases:
                with self.subTest(method=method, params=str(params)[:80]):
                    self.assertEqual(healthy().forward(request(method, params))[0], 400)
            rpc.assert_not_called()

    def test_upstream_failure_identity_change_and_expiry_invalidate(self):
        for value in (hex(8400), gateway.probe_rpc.CheckFailed("secret")):
            instance = healthy()
            with patch.object(gateway.probe_rpc, "rpc", side_effect=value if isinstance(value, Exception) else None,
                              return_value=value):
                status, body = instance.forward(request())
            self.assertEqual(status, 502)
            self.assertNotIn("secret", json.dumps(body))
            self.assertFalse(instance.health()["rpc_healthy"])
        instance = healthy()
        def expire(*args):
            instance.last_success -= 60
            return hex(84001)
        with patch.object(gateway.probe_rpc, "rpc", side_effect=expire):
            self.assertEqual(instance.forward(request())[0], 503)
        instance = healthy()
        with patch.object(gateway.probe_rpc, "rpc", return_value={"number": "0x0", "hash": "0x" + "cd" * 32}):
            self.assertEqual(instance.forward(request("eth_getBlockByNumber", ["0x0", False]))[0], 502)
        self.assertFalse(instance.health()["rpc_healthy"])

    def test_rate_and_config_limits(self):
        instance = healthy()
        with patch.object(gateway.time, "monotonic", return_value=instance.token_time):
            self.assertTrue(all(instance.allow_rate() for _ in range(20)))
            self.assertFalse(instance.allow_rate())
        for endpoint in ("http://127.0.0.1", "https://name:secret@example.test", "https://example.test?token=secret"):
            with self.assertRaises(ValueError):
                gateway.Gateway(endpoint, 84001, GENESIS)
        with self.assertRaises(ValueError):
            gateway.Gateway("https://example.test", 84001, GENESIS, interval=29)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = gateway.Server(("127.0.0.1", 0), healthy())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.server.gateway = healthy()

    def send(self, body=None, path="/", method="POST", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        connection.request(method, path, body, headers or {"Content-Type": "application/json"})
        response = connection.getresponse()
        status, raw = response.status, response.read()
        connection.close()
        return status, raw

    def test_health_has_no_upstream_reads(self):
        with patch.object(gateway.probe_rpc, "rpc") as rpc:
            self.assertEqual(self.send(path="/health", method="GET")[0], 200)
            self.server.gateway.healthy = False
            self.assertEqual(self.send(path="/health", method="GET")[0], 503)
            self.assertEqual(self.send(json.dumps(request()))[0], 503)
            rpc.assert_not_called()

    def test_invalid_and_oversized_requests_never_forward(self):
        with patch.object(gateway.probe_rpc, "rpc") as rpc:
            for body in (b"[{}]", b"{", b"x" * (gateway.MAX_BODY + 1),
                         b'{"id":1,"id":2}', b"[NaN]", b"\xff"):
                self.assertEqual(self.send(body)[0], 400)
            self.assertEqual(self.send(b"{}", headers={"Content-Type": "text/plain"})[0], 400)
            self.assertEqual(self.send(b"{}", path="/?upstream=https://attacker")[0], 404)
            rpc.assert_not_called()

    def test_response_bound_and_thread_concurrency_bound(self):
        with patch.object(gateway.probe_rpc, "rpc", return_value="x" * gateway.probe_rpc.MAX_RESPONSE):
            self.assertEqual(self.send(json.dumps(request("eth_blockNumber")))[0], 502)
        for _ in range(8):
            self.assertTrue(self.server.slots.acquire(blocking=False))
        try:
            self.assertEqual(self.send(path="/health", method="GET")[0], 503)
        finally:
            for _ in range(8):
                self.server.slots.release()


if __name__ == "__main__":
    unittest.main()
