import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("checkpoint", Path(__file__).resolve().parents[1] / "atomic_anvil_checkpoint.py")
checkpoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkpoint)
HASH = "0x" + "ab" * 32
ADDRESS = "0x" + "12" * 20


def fixture(nonce=0):
    # Structural fixture matching the pinned serde representation, not a state
    # root proof. A real 1.7.1 dump/restart is separately rehearsed before deployment.
    header = {field: HASH for field in ("parentHash", "sha3Uncles", "stateRoot", "transactionsRoot", "receiptsRoot", "mixHash")}
    header.update(miner=ADDRESS, logsBloom="0x" + "00" * 256, nonce="0x" + "00" * 8,
                  extraData="0x", number="0x0", difficulty="0x0", gasLimit="0x1c9c380",
                  gasUsed="0x0", timestamp="0x1", baseFeePerGas="0x3b9aca00")
    return {"block": {"number": "0x0", "beneficiary": ADDRESS, "timestamp": "0x1",
                      "gas_limit": 30000000, "basefee": 1000000000, "difficulty": "0x0",
                      "prevrandao": HASH, "slot_num": 0,
                      "blob_excess_gas_and_price": {"excess_blob_gas": 0, "blob_gasprice": 1}},
            "accounts": {ADDRESS: {"nonce": nonce, "balance": "0x0", "code": "0x", "storage": {HASH: HASH}}},
            "best_block_number": 0, "blocks": [{"header": header, "transactions": [], "ommers": [], "withdrawals": None}],
            "transactions": [], "historical_states": None}


def raw(nonce=0):
    return json.dumps(fixture(nonce), separators=(",", ":")).encode()


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.json"
        self.disk = patch.object(checkpoint.shutil, "disk_usage", return_value=Mock(free=checkpoint.MIN_FREE + 1)).start()
        self.addCleanup(patch.stopall)

    def test_schema_and_exact_bytes_are_preserved(self):
        original = raw()
        result = checkpoint.save_checkpoint(self.path, fetch=lambda: original)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(result["best_block_number"], 0)
        self.assertEqual(result["accounts"], 1)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_rejects_account_only_malformed_metadata_and_duplicate_fields(self):
        mutations = [lambda state: state.update(block=None),
                     lambda state: state.update(best_block_number=None),
                     lambda state: state.update(blocks=[]),
                     lambda state: state.update(historical_states=[]),
                     lambda state: state.update(private_key="not permitted"),
                     lambda state: state["block"].update(number="0x1"),
                     lambda state: state["accounts"][ADDRESS].update(nonce=True),
                     lambda state: state["accounts"][ADDRESS].update(code="0x0"),
                     lambda state: state["blocks"][0]["header"].update(number="0x1"),
                     lambda state: state["blocks"][0]["header"].pop("stateRoot")]
        for mutation in mutations:
            state = fixture()
            mutation(state)
            with self.assertRaises(ValueError):
                checkpoint.validate_state(json.dumps(state).encode())
        with self.assertRaises(ValueError):
            checkpoint.validate_state(b'{"accounts":{},"accounts":{}}')

    def test_network_request_is_fixed_read_only_dump_and_hex_gzip_decodes(self):
        response = Mock(status=200)
        response.getheader.side_effect = lambda key, default: "application/json" if key == "Content-Type" else default
        response.read.return_value = json.dumps({"jsonrpc": "2.0", "id": 1,
            "result": "0x" + gzip.compress(raw()).hex()}).encode()
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(checkpoint.http.client, "HTTPConnection", return_value=connection) as factory:
            self.assertEqual(checkpoint.fetch_state(), raw())
        factory.assert_called_once_with("127.0.0.1", 8547, timeout=10)
        call = connection.request.call_args
        self.assertEqual(call.args, ("POST", "/"))
        self.assertEqual(json.loads(call.kwargs["body"]), {"jsonrpc": "2.0", "id": 1,
                                                          "method": "anvil_dumpState", "params": [False]})
        connection.close.assert_called_once()

    def test_transport_failure_and_gzip_bomb_do_not_replace_checkpoint(self):
        self.path.write_bytes(raw(1))
        def timeout():
            raise TimeoutError("remote contents must not be printed")
        with self.assertRaises(TimeoutError):
            checkpoint.save_checkpoint(self.path, fetch=timeout)
        self.assertEqual(self.path.read_bytes(), raw(1))
        response = Mock(status=200)
        response.getheader.side_effect = lambda key, default: "application/json" if key == "Content-Type" else default
        response.read.return_value = json.dumps({"jsonrpc": "2.0", "id": 1,
            "result": "0x" + gzip.compress(b"x" * 20000).hex()}).encode()
        with patch.object(checkpoint, "MAX_BYTES", 4096), \
             patch.object(checkpoint.http.client, "HTTPConnection") as factory:
            factory.return_value.getresponse.return_value = response
            with self.assertRaises(ValueError):
                checkpoint.fetch_state()
        self.assertEqual(self.path.read_bytes(), raw(1))

    def test_rotation_keeps_two_previous_files_and_no_growing_temporary_set(self):
        for nonce in range(5):
            checkpoint.save_checkpoint(self.path, fetch=lambda n=nonce: raw(n))
        self.assertEqual(self.path.read_bytes(), raw(4))
        self.assertEqual(self.path.with_name("state.json.previous-1").read_bytes(), raw(3))
        self.assertEqual(self.path.with_name("state.json.previous-2").read_bytes(), raw(2))
        self.assertEqual({path.name for path in self.path.parent.iterdir()},
                         {"state.json", "state.json.previous-1", "state.json.previous-2", ".checkpoint.lock"})

    def test_failure_before_final_replace_preserves_current_and_recoverable_previous(self):
        checkpoint.save_checkpoint(self.path, fetch=lambda: raw(1))
        checkpoint.save_checkpoint(self.path, fetch=lambda: raw(2))
        replace = checkpoint.os.replace
        def fail_current(source, destination):
            if Path(destination) == self.path:
                raise OSError("simulated power loss before atomic commit")
            replace(source, destination)
        with patch.object(checkpoint.os, "replace", side_effect=fail_current):
            with self.assertRaises(OSError):
                checkpoint.save_checkpoint(self.path, fetch=lambda: raw(3))
        self.assertEqual(self.path.read_bytes(), raw(2))
        self.assertEqual(self.path.with_name("state.json.previous-1").read_bytes(), raw(2))
        self.assertEqual(self.path.with_name("state.json.previous-2").read_bytes(), raw(1))
        self.assertFalse(self.path.with_name(".state.json.pending").exists())

    def test_low_disk_invalid_new_or_invalid_existing_state_fails_without_rotation(self):
        self.path.write_bytes(raw(1))
        with patch.object(checkpoint.shutil, "disk_usage", return_value=Mock(free=checkpoint.MIN_FREE - 1)):
            fetch = Mock(return_value=raw(2))
            with self.assertRaises(ValueError):
                checkpoint.save_checkpoint(self.path, fetch=fetch)
            fetch.assert_not_called()
        with self.assertRaises(ValueError):
            checkpoint.save_checkpoint(self.path, fetch=lambda: b"{}")
        self.assertEqual(self.path.read_bytes(), raw(1))
        self.path.write_bytes(b"truncated")
        with self.assertRaises(ValueError):
            checkpoint.save_checkpoint(self.path, fetch=lambda: raw(2))
        self.assertEqual(self.path.read_bytes(), b"truncated")

    def test_file_fsync_failure_and_symlinks_leave_original_untouched(self):
        self.path.write_bytes(raw(1))
        with patch.object(checkpoint.os, "fsync", side_effect=OSError("fsync failed")):
            with self.assertRaises(OSError):
                checkpoint.save_checkpoint(self.path, fetch=lambda: raw(2))
        self.assertEqual(self.path.read_bytes(), raw(1))
        backup = self.path.with_name("state.json.previous-1")
        backup.symlink_to(self.path)
        with self.assertRaises(ValueError):
            checkpoint.save_checkpoint(self.path, fetch=lambda: raw(2))
        self.assertTrue(backup.is_symlink())

    def test_nonblocking_lock_prevents_overlapping_writers(self):
        path = self.path.with_name(".checkpoint.lock")
        with path.open("w") as lock:
            checkpoint.fcntl.flock(lock, checkpoint.fcntl.LOCK_EX | checkpoint.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                checkpoint.save_checkpoint(self.path, fetch=lambda: raw())
        self.assertFalse(self.path.exists())

    def test_explicit_initial_bootstrap_requires_exact_digest_and_preserves_original(self):
        initial = fixture()
        initial.update(block=None, best_block_number=None, blocks=[], transactions=[])
        initial_raw = json.dumps(initial).encode()
        self.path.write_bytes(initial_raw)
        digest = checkpoint.hashlib.sha256(initial_raw).hexdigest()
        with self.assertRaises(ValueError):
            checkpoint.save_checkpoint(self.path, fetch=lambda: raw(), initial_state_sha256="0" * 64)
        self.assertEqual(self.path.read_bytes(), initial_raw)
        report = checkpoint.save_checkpoint(self.path, fetch=lambda: raw(), initial_state_sha256=digest)
        self.assertTrue(report["initialized_from_account_only"])
        self.assertEqual(self.path.read_bytes(), raw())
        self.assertEqual(self.path.with_name("state.json.initial-accounts").read_bytes(), initial_raw)
        self.assertFalse(self.path.with_name("state.json.previous-1").exists())
        # Repeating bootstrap is forbidden; subsequent saves use normal rotation.
        with self.assertRaises(ValueError):
            checkpoint.save_checkpoint(self.path, fetch=lambda: raw(), initial_state_sha256=digest)
        checkpoint.save_checkpoint(self.path, fetch=lambda: raw(1))
        self.assertEqual(self.path.with_name("state.json.previous-1").read_bytes(), raw())

    def test_real_transaction_bearing_anvil_1_7_1_dump_is_preserved(self):
        original = (Path(__file__).parent / "fixtures/anvil-1.7.1-transaction-state.json").read_bytes()
        result = checkpoint.save_checkpoint(self.path, fetch=lambda: original)
        self.assertEqual(result["best_block_number"], 1)
        self.assertEqual(result["blocks"], 2)
        self.assertEqual(result["transactions"], 1)
        self.assertEqual(self.path.read_bytes(), original)
        malformed = json.loads(original)
        malformed["transactions"][0].pop("receipt")
        with self.assertRaises(ValueError):
            checkpoint.save_checkpoint(self.path, fetch=lambda: json.dumps(malformed).encode())
        self.assertEqual(self.path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
