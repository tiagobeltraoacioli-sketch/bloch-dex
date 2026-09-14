#!/usr/bin/env python3
"""Bounded, read-only network monitor. It never validates consensus or bridges."""
import argparse
import copy
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time

_spec = importlib.util.spec_from_file_location("network_probe", Path(__file__).with_name("probe_rpc.py"))
probe_rpc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe_rpc)
MAX_CONFIG = 16384
MAX_REPORT = 32768
MAX_TARGETS = 8
POLICY = {"finality_verified": False, "mainnet_ready": False, "bridge_ready": False}


def require(condition):
    if not condition:
        raise ValueError("invalid monitor configuration")


def decode_json(raw):
    return json.loads(raw, object_pairs_hook=probe_rpc.unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))


def validate_config(config):
    require(type(config) is dict and set(config) == {"targets", "interval_seconds", "timeout_seconds"})
    require(type(config["interval_seconds"]) is int and 30 <= config["interval_seconds"] <= 3600)
    require(type(config["timeout_seconds"]) in (int, float) and 0 < config["timeout_seconds"] <= 5)
    require(type(config["targets"]) is list and 1 <= len(config["targets"]) <= MAX_TARGETS)
    names = set()
    for target in config["targets"]:
        require(type(target) is dict and set(target) == {
            "name", "endpoint", "expected_chain_id", "expected_genesis"})
        name = target["name"]
        require(type(name) is str and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,47}", name) and name not in names)
        names.add(name)
        require(type(target["endpoint"]) is str and len(target["endpoint"]) <= 2048)
        probe_rpc.endpoint_url(target["endpoint"])
        require(type(target["expected_chain_id"]) is int and 0 < target["expected_chain_id"] < 1 << 256)
        genesis = target["expected_genesis"]
        require(type(genesis) is str and probe_rpc.HASH.fullmatch(genesis) and int(genesis[2:], 16) != 0)
    return config


def load_config(path):
    with open(path, "rb") as stream:
        raw = stream.read(MAX_CONFIG + 1)
    require(len(raw) <= MAX_CONFIG)
    return validate_config(decode_json(raw))


def encoded_report(report):
    raw = (json.dumps(report, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()
    if len(raw) > MAX_REPORT:
        raise ValueError("monitor report exceeds limit")
    return raw


def atomic_report(path, report):
    """Persist only a complete snapshot; durability includes the directory entry."""
    raw = encoded_report(report)
    path = Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=path.parent, prefix=".network-watch-", delete=False) as stream:
            temporary = stream.name
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
        descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary is not None:
            os.unlink(temporary)


def target_record(target):
    return {"name": target["name"], "expected_chain_id": target["expected_chain_id"],
            "expected_genesis": target["expected_genesis"].lower(), "status": "pending",
            "rpc_healthy": False, "identity_verified": False, **POLICY}


def probe_target(target, timeout):
    """The worker also bounds DNS/trickle stalls beyond socket operation timeouts.

    Pass endpoints on stdin, never in process arguments or diagnostic output.
    The child calls the existing probe unchanged, with no signing/write methods.
    """
    result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--probe-worker"],
        input=json.dumps({"target": target, "timeout": timeout}).encode(),
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=3 * timeout + 2, check=True)
    if len(result.stdout) > MAX_REPORT:
        raise ValueError("invalid worker response")
    return decode_json(result.stdout)


class Monitor:
    def __init__(self, config, report_path, probe=probe_target, clock=time.time):
        self.config = validate_config(config)
        self.report_path = report_path
        self.probe = probe
        self.clock = clock
        self.lock = threading.Lock()
        self.report = self.pending()

    def pending(self):
        now = self.clock()
        return {"schema_version": 1, "role": "read-only-network-monitor", "status": "pending",
                "rpc_healthy": False, **POLICY, "observed_at": now, "valid_until": now,
                "targets": [target_record(target) for target in self.config["targets"]]}

    def publish(self, report):
        # Invalidate the cached success BEFORE disk I/O, including an I/O failure.
        with self.lock:
            self.report = self.pending()
        try:
            atomic_report(self.report_path, report)
        except OSError:
            with self.lock:
                self.report["status"] = "storage-error"
            raise
        with self.lock:
            self.report = copy.deepcopy(report)

    def cached(self):
        with self.lock:
            report = copy.deepcopy(self.report)
        if report["status"] == "healthy" and self.clock() > report["valid_until"]:
            report["status"] = "stale"
            report["rpc_healthy"] = False
            for target in report["targets"]:
                target.update(status="stale", rpc_healthy=False, identity_verified=False)
        return report

    def cycle(self):
        report = self.pending()
        self.publish(report)  # Never load/reuse a previous process's healthy report.
        for target, record in zip(self.config["targets"], report["targets"]):
            record.update(status="unhealthy", error="probe-failed")
            try:
                result = self.probe(target, self.config["timeout_seconds"])
                if (type(result) is dict and result.get("rpc_healthy") is True
                        and result.get("identity_verified") is True
                        and type(result.get("chain_id")) is int
                        and result["chain_id"] == target["expected_chain_id"]
                        and result.get("genesis_hash") == target["expected_genesis"].lower()):
                    latest = result.get("latest_block")
                    require(type(latest) is dict and type(latest.get("number")) is int
                            and 0 <= latest["number"] < 1 << 256)
                    height, digest = probe_rpc.block({"number": hex(latest["number"]),
                                                     "hash": latest.get("hash")}, "latest")
                    require(height != 0 or digest == target["expected_genesis"].lower())
                    record.update(status="healthy", rpc_healthy=True, identity_verified=True,
                                  latest_block={"number": height, "hash": digest})
                    record.pop("error")
            except Exception:
                # Transport/library errors can contain URLs and remote payloads.
                # Deliberately publish only the stable, local failure classification.
                pass
            record["observed_at"] = self.clock()
            self.publish(report)
        report["observed_at"] = self.clock()
        report["valid_until"] = report["observed_at"] + self.config["interval_seconds"] + 5
        healthy = all(record["rpc_healthy"] for record in report["targets"])
        report.update(status="healthy" if healthy else "unhealthy", rpc_healthy=healthy)
        self.publish(report)
        return healthy


def cached_response(monitor, method, path):
    if method != "GET":
        return 405, b'{"error":"get-only"}\n'
    if path not in ("/health", "/status"):
        return 404, b'{"error":"not-found"}\n'
    report = monitor.cached()
    return (200 if report["rpc_healthy"] else 503), encoded_report(report)


def status_server(monitor, port=18600):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Includes no client-supplied paths, headers or source URLs.

        def reply(self, code, data):
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def do_GET(self):
            self.reply(*cached_response(monitor, "GET", self.path))

        def refused(self):
            self.reply(*cached_response(monitor, self.command, self.path))

        do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_CONNECT = do_TRACE = refused

    class Server(HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(2)
            return connection, address

        def handle_error(self, *_):
            pass

    return Server(("127.0.0.1", port), Handler)


def worker():
    try:
        payload = decode_json(sys.stdin.buffer.read(MAX_CONFIG + 1))
        config = validate_config({"targets": [payload["target"]], "interval_seconds": 30,
                                  "timeout_seconds": payload["timeout"]})
        target = config["targets"][0]
        result = probe_rpc.probe(target["endpoint"], target["expected_chain_id"],
                                 target["expected_genesis"], config["timeout_seconds"])
        sys.stdout.buffer.write(encoded_report(result))
        return 0
    except Exception:
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--serve", action="store_true", help="GET-only cached status on 127.0.0.1:18600")
    args = parser.parse_args()
    server = None
    try:
        # Invalidate an earlier run even when the new configuration cannot load.
        atomic_report(args.report, {"schema_version": 1, "role": "read-only-network-monitor",
            "status": "pending", "rpc_healthy": False, **POLICY, "observed_at": time.time(),
            "valid_until": 0, "targets": []})
        monitor = Monitor(load_config(args.config), args.report)
        monitor.publish(monitor.pending())
        if args.serve:
            server = status_server(monitor)
            threading.Thread(target=server.serve_forever, daemon=True).start()
        while True:
            healthy = monitor.cycle()
            if args.once:
                return 0 if healthy else 1
            time.sleep(monitor.config["interval_seconds"])
    except KeyboardInterrupt:
        return 130
    except Exception:
        print("Network monitor stopped: configuration, storage or runtime failure.", file=sys.stderr)
        return 1
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    sys.exit(worker() if sys.argv[1:] == ["--probe-worker"] else main())
