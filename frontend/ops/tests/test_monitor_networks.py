import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("monitor_networks", Path(__file__).resolve().parents[1] / "monitor_networks.py")
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)
GENESIS = "0x" + "ab" * 32
LATEST = "0x" + "cd" * 32


def config():
    return {"interval_seconds": 30, "timeout_seconds": 5,
            "targets": [{"name": "testnet-a", "endpoint": "https://rpc.example.test/private-path",
                         "expected_chain_id": 84001, "expected_genesis": GENESIS}]}


def healthy(*_):
    return {"rpc_healthy": True, "identity_verified": True, "chain_id": 84001,
            "genesis_hash": GENESIS, "latest_block": {"number": 18, "hash": LATEST},
            "mainnet_ready": True, "bridge_ready": True, "finality_verified": True,
            "unexpected": "https://do-not-report.test/secret"}


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "latest.json"

    def test_config_rejects_unknown_fields_types_sizes_names_and_endpoints(self):
        changes = [("interval_seconds", 29), ("interval_seconds", 30.0), ("interval_seconds", True),
                   ("timeout_seconds", 5.1), ("timeout_seconds", 0), ("timeout_seconds", float("nan")),
                   ("targets", []), ("targets", config()["targets"] * 9), ("unexpected", 1)]
        for key, value in changes:
            bad = config()
            bad[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                monitor.validate_config(bad)
        for key, value in [("endpoint", "http://remote.test"), ("endpoint", "https://u:p@example.test"),
                           ("endpoint", "https://example.test/?secret=x"), ("endpoint", "https://example.test/#x"),
                           ("expected_chain_id", True), ("expected_chain_id", 0),
                           ("expected_genesis", "0x" + "00" * 32), ("name", "secret\nurl"),
                           ("name", "../file"), ("extra", "field")]:
            bad = config()
            bad["targets"][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                monitor.validate_config(bad)
        bad = config()
        bad["targets"] *= 2
        with self.assertRaises(ValueError):
            monitor.validate_config(bad)
        for raw in [b'{"targets": [], "targets": []}', b'[' * 2000, b'x' * (monitor.MAX_CONFIG + 1)]:
            self.path.write_bytes(raw)
            with self.assertRaises((ValueError, RecursionError)):
                monitor.load_config(self.path)

    def test_startup_does_not_reuse_old_healthy_snapshot(self):
        self.path.write_text(json.dumps({"rpc_healthy": True}))
        watch = monitor.Monitor(config(), self.path, probe=healthy, clock=lambda: 100)
        self.assertFalse(watch.cached()["rpc_healthy"])
        watch.publish(watch.pending())
        self.assertEqual(json.loads(self.path.read_text())["status"], "pending")

    def test_success_is_pending_during_probe_and_never_readiness(self):
        def check_pending(*args):
            self.assertFalse(watch.cached()["rpc_healthy"])
            self.assertEqual(json.loads(self.path.read_text())["status"], "pending")
            return healthy(*args)
        watch = monitor.Monitor(config(), self.path, probe=check_pending, clock=lambda: 100)
        self.assertTrue(watch.cycle())
        report = watch.cached()
        self.assertTrue(report["rpc_healthy"])
        self.assertEqual(json.loads(self.path.read_text()), report)
        for data in (report, report["targets"][0]):
            for flag in monitor.POLICY:
                self.assertIs(data[flag], False)
        serialized = self.path.read_text()
        self.assertNotIn("https:", serialized)
        self.assertNotIn("private-path", serialized)
        self.assertNotIn("unexpected", serialized)

    def test_failure_after_success_removes_old_success_and_sanitizes_errors(self):
        watch = monitor.Monitor(config(), self.path, probe=healthy, clock=lambda: 100)
        watch.cycle()
        def failure(*_):
            raise RuntimeError("https://secret.test/private-token")
        watch.probe = failure
        self.assertFalse(watch.cycle())
        report = json.loads(self.path.read_text())
        self.assertFalse(report["rpc_healthy"])
        self.assertEqual(report["targets"][0]["error"], "probe-failed")
        self.assertNotIn("latest_block", report["targets"][0])
        self.assertNotIn("secret", self.path.read_text())

    def test_bad_probe_identity_or_shape_cannot_be_reported_as_healthy(self):
        for key, value in [("chain_id", 8400), ("chain_id", True), ("genesis_hash", LATEST),
                           ("latest_block", {"number": 0, "hash": LATEST}),
                           ("latest_block", {"number": -1, "hash": LATEST}),
                           ("latest_block", {"number": 18, "hash": "invalid"})]:
            result = healthy()
            result[key] = value
            watch = monitor.Monitor(config(), self.path, probe=lambda *_: result)
            with self.subTest(key=key):
                self.assertFalse(watch.cycle())

    def test_expired_cached_success_becomes_unhealthy_without_refetching(self):
        now = [100]
        watch = monitor.Monitor(config(), self.path, probe=healthy, clock=lambda: now[0])
        watch.cycle()
        now[0] = 136
        watch.probe = lambda *_: self.fail("cached reads cannot fetch")
        report = watch.cached()
        self.assertEqual(report["status"], "stale")
        self.assertFalse(report["rpc_healthy"])
        self.assertFalse(report["targets"][0]["identity_verified"])

    def test_atomic_write_fsyncs_and_replaces_whole_document(self):
        self.path.write_text('{"old":true}')
        real_replace = monitor.os.replace
        observed = []
        def replace(source, destination):
            observed.append(json.loads(Path(source).read_text()))
            self.assertEqual(json.loads(self.path.read_text()), {"old": True})
            real_replace(source, destination)
        with patch.object(monitor.os, "replace", side_effect=replace), patch.object(monitor.os, "fsync") as sync:
            monitor.atomic_report(self.path, {"new": True})
        self.assertEqual(observed, [{"new": True}])
        self.assertEqual(sync.call_count, 2)
        self.assertEqual(json.loads(self.path.read_text()), {"new": True})
        self.assertEqual(list(self.path.parent.glob(".network-watch-*")), [])

    def test_storage_failure_clears_cached_health_and_cleans_temporary(self):
        watch = monitor.Monitor(config(), self.path, probe=healthy)
        watch.cycle()
        before = self.path.read_bytes()
        with patch.object(monitor.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                watch.publish(watch.cached())
        self.assertFalse(watch.cached()["rpc_healthy"])
        self.assertEqual(watch.cached()["status"], "storage-error")
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.glob(".network-watch-*")), [])

    def test_worker_has_wall_clock_deadline_and_no_endpoint_in_arguments(self):
        with patch.object(monitor.subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 17)) as run:
            watch = monitor.Monitor(config(), self.path)
            self.assertFalse(watch.cycle())
        self.assertEqual(run.call_args.kwargs["timeout"], 17)
        self.assertNotIn("https://", str(run.call_args.args))
        self.assertEqual(json.loads(run.call_args.kwargs["input"])["timeout"], 5)

    def test_invalid_startup_config_overwrites_previous_success(self):
        config_path = self.path.parent / "config.json"
        config_path.write_text('{"invalid":true}')
        self.path.write_text('{"rpc_healthy":true}')
        with patch.object(monitor.sys, "argv", ["monitor", "--config", str(config_path), "--report", str(self.path), "--once"]), \
             patch("builtins.print"):
            self.assertEqual(monitor.main(), 1)
        self.assertFalse(json.loads(self.path.read_text())["rpc_healthy"])

    def test_status_dispatch_is_get_only_cached_and_stale_aware(self):
        now = [100]
        watch = monitor.Monitor(config(), self.path, probe=healthy, clock=lambda: now[0])
        self.assertEqual(monitor.cached_response(watch, "GET", "/health")[0], 503)
        watch.cycle()
        watch.probe = lambda *_: self.fail("HTTP requests cannot fetch")
        for path in ("/health", "/status"):
            code, body = monitor.cached_response(watch, "GET", path)
            self.assertEqual(code, 200)
            self.assertTrue(json.loads(body)["rpc_healthy"])
        self.assertEqual(monitor.cached_response(watch, "GET", "/status?endpoint=https://elsewhere")[0], 404)
        for method in ("POST", "PUT", "DELETE", "HEAD", "OPTIONS", "CONNECT"):
            self.assertEqual(monitor.cached_response(watch, method, "/status")[0], 405)
        now[0] = 136
        self.assertEqual(monitor.cached_response(watch, "GET", "/health")[0], 503)

    def test_status_http_handler_binds_loopback_and_does_not_forward(self):
        watch = monitor.Monitor(config(), self.path, probe=healthy)
        watch.cycle()
        watch.probe = lambda *_: self.fail("HTTP requests cannot fetch")
        with patch.object(monitor.HTTPServer, "__init__", return_value=None) as init:
            server = monitor.status_server(watch)
        self.assertEqual(init.call_args.args[0], ("127.0.0.1", 18600))
        handler = init.call_args.args[1]
        class Socket:
            def __init__(self, request):
                self.request = request
                self.response = bytearray()

            def makefile(self, *_):
                return io.BytesIO(self.request)

            def sendall(self, data):
                self.response.extend(data)

        for request, expected in [(b"GET /health HTTP/1.0\r\n\r\n", b"200 OK"),
                                  (b"POST /status HTTP/1.0\r\n\r\n", b"405 Method Not Allowed"),
                                  (b"GET /rpc HTTP/1.0\r\n\r\n", b"404 Not Found")]:
            socket = Socket(request)
            handler(socket, ("127.0.0.1", 1), server)
            self.assertIn(expected, socket.response.split(b"\r\n")[0])

    def test_once_success_uses_bounded_worker_and_persists_result(self):
        config_path = self.path.parent / "config.json"
        config_path.write_text(json.dumps(config()))
        child = subprocess.CompletedProcess([], 0, stdout=json.dumps(healthy()).encode())
        with patch.object(monitor.sys, "argv", ["monitor", "--config", str(config_path), "--report", str(self.path), "--once"]), \
             patch.object(monitor.subprocess, "run", return_value=child):
            self.assertEqual(monitor.main(), 0)
        self.assertTrue(json.loads(self.path.read_text())["rpc_healthy"])

    def test_worker_calls_unchanged_probe_with_explicit_identity(self):
        payload = {"target": config()["targets"][0], "timeout": 5}
        class Stream:
            def __init__(self, data=b""):
                self.buffer = io.BytesIO(data)
        stdout = Stream()
        with patch.object(monitor.sys, "stdin", Stream(json.dumps(payload).encode())), \
             patch.object(monitor.sys, "stdout", stdout), \
             patch.object(monitor.probe_rpc, "probe", return_value=healthy()) as probe:
            self.assertEqual(monitor.worker(), 0)
        probe.assert_called_once_with(payload["target"]["endpoint"], 84001, GENESIS, 5)
        self.assertTrue(json.loads(stdout.buffer.getvalue())["rpc_healthy"])

    def test_one_failed_target_makes_aggregate_unhealthy(self):
        settings = config()
        settings["targets"].append({**settings["targets"][0], "name": "testnet-b"})
        watch = monitor.Monitor(settings, self.path,
            probe=lambda target, _: healthy() if target["name"] == "testnet-a" else {"rpc_healthy": False})
        self.assertFalse(watch.cycle())
        report = watch.cached()
        self.assertEqual([target["status"] for target in report["targets"]], ["healthy", "unhealthy"])
        self.assertEqual(monitor.cached_response(watch, "GET", "/health")[0], 503)


if __name__ == "__main__":
    unittest.main()
