#!/usr/bin/env python3
"""Atomically checkpoint local Anvil 1.7.1 state; never send transactions."""
import argparse
import contextlib
import fcntl
import gzip
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import sys

MAX_BYTES = 64 * 1024 * 1024
MIN_FREE = 512 * 1024 * 1024
TIMEOUT = 10
DEFAULT_STATE = Path("/var/lib/bloch-dex-devnet-v2/state.json")
HEX = re.compile(r"0x[0-9a-fA-F]*\Z")
QUANTITY = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")


def require(condition, message="invalid Anvil checkpoint"):
    if not condition:
        raise ValueError(message)


def unique_object(items):
    result = {}
    for key, value in items:
        require(key not in result, "duplicate checkpoint field")
        result[key] = value
    return result


def parse_json(raw):
    require(len(raw) <= MAX_BYTES, "checkpoint exceeds 64 MiB")
    return json.loads(raw, object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite checkpoint value")))


def uint(value, bits=64):
    require(type(value) is int and 0 <= value < 1 << bits)
    return value


def quantity(value, bits=256):
    require(type(value) is str and len(value) <= 2 + (bits + 3) // 4 and QUANTITY.fullmatch(value))
    number = int(value[2:], 16)
    require(number < 1 << bits)
    return number


def hexbytes(value, size=None):
    require(type(value) is str and len(value) <= MAX_BYTES and HEX.fullmatch(value)
            and len(value) % 2 == 0 and (size is None or len(value) == 2 + size * 2))


def validate_state(raw):
    """Validate the current SerializableState format, not legacy account-only dumps.

    Schema source: foundry 4072e48705af9d93e3c0f6e29e93b5e9a40caed8,
    crates/anvil/src/eth/backend/db.rs (SerializableState and nested records).
    This structural integrity check is not consensus or Ethereum proof validation.
    """
    state = parse_json(raw)
    require(type(state) is dict and set(state) == {
        "block", "accounts", "best_block_number", "blocks", "transactions", "historical_states"})
    best = uint(state["best_block_number"])
    block = state["block"]
    require(type(block) is dict and {"number", "beneficiary", "timestamp", "gas_limit", "basefee",
                                   "difficulty", "prevrandao", "blob_excess_gas_and_price", "slot_num"} == set(block))
    require(quantity(block["number"]) == best)
    quantity(block["timestamp"])
    quantity(block["difficulty"])
    uint(block["gas_limit"])
    uint(block["basefee"])
    hexbytes(block["beneficiary"], 20)
    if block["prevrandao"] is not None:
        hexbytes(block["prevrandao"], 32)
    if "slot_num" in block:
        uint(block["slot_num"])
    blob = block["blob_excess_gas_and_price"]
    if blob is not None:
        require(type(blob) is dict and set(blob) == {"excess_blob_gas", "blob_gasprice"})
        uint(blob["excess_blob_gas"])
        uint(blob["blob_gasprice"], 128)
    require(state["historical_states"] is None, "historical states must be disabled")
    accounts = state["accounts"]
    require(type(accounts) is dict and len(accounts) <= 100000)
    normalized = set()
    slots = 0
    for address, account in accounts.items():
        hexbytes(address, 20)
        require(address.lower() not in normalized)
        normalized.add(address.lower())
        require(type(account) is dict and set(account) == {"nonce", "balance", "code", "storage"})
        uint(account["nonce"])
        quantity(account["balance"])
        hexbytes(account["code"])
        storage = account["storage"]
        require(type(storage) is dict)
        slots += len(storage)
        require(slots <= 1000000)
        normalized_slots = set()
        for key, value in storage.items():
            hexbytes(key, 32)
            hexbytes(value, 32)
            require(key.lower() not in normalized_slots)
            normalized_slots.add(key.lower())
    blocks = state["blocks"]
    require(type(blocks) is list and 1 <= len(blocks) <= 100000)
    numbers = set()
    for item in blocks:
        require(type(item) is dict and set(item) == {"header", "transactions", "ommers", "withdrawals"})
        header = item["header"]
        require(type(header) is dict)
        for field in ("parentHash", "sha3Uncles", "stateRoot", "transactionsRoot", "receiptsRoot", "mixHash"):
            hexbytes(header.get(field), 32)
        hexbytes(header.get("miner"), 20)
        hexbytes(header.get("logsBloom"), 256)
        hexbytes(header.get("nonce"), 8)
        hexbytes(header.get("extraData"))
        number = quantity(header.get("number"), 64)
        require(number not in numbers and number <= best)
        numbers.add(number)
        for field in ("difficulty", "gasLimit", "gasUsed", "timestamp"):
            quantity(header.get(field))
        require(type(item["transactions"]) is list and all(type(tx) is dict for tx in item["transactions"]))
        require(type(item["ommers"]) is list and all(type(ommer) is dict for ommer in item["ommers"]))
        require(item["withdrawals"] is None or type(item["withdrawals"]) is list)
    require(best in numbers, "checkpoint lacks its best block header")
    transactions = state["transactions"]
    require(type(transactions) is list and len(transactions) <= 100000)
    for transaction in transactions:
        require(type(transaction) is dict and set(transaction) == {"info", "receipt", "block_hash", "block_number"})
        require(type(transaction["info"]) is dict and type(transaction["receipt"]) is dict)
        hexbytes(transaction["block_hash"], 32)
        require(uint(transaction["block_number"]) <= best)
    return {"best_block_number": best, "accounts": len(accounts), "blocks": len(blocks),
            "transactions": len(transactions), "storage_slots": slots,
            "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


@contextlib.contextmanager
def deadline():
    def expired(*_):
        raise TimeoutError("checkpoint RPC exceeded ten seconds")
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, TIMEOUT)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def fetch_state():
    connection = http.client.HTTPConnection("127.0.0.1", 8547, timeout=TIMEOUT)
    try:
        with deadline():
            connection.request("POST", "/", body=b'{"jsonrpc":"2.0","id":1,"method":"anvil_dumpState","params":[false]}',
                               headers={"Content-Type": "application/json", "Accept": "application/json"})
            response = connection.getresponse()
            require(response.status == 200, "checkpoint RPC unavailable")
            require(response.getheader("Content-Type", "").split(";")[0].strip() == "application/json")
            require(response.getheader("Content-Encoding", "identity") == "identity")
            payload = response.read(MAX_BYTES + 1)
    finally:
        connection.close()
    data = parse_json(payload)
    require(type(data) is dict and set(data) == {"jsonrpc", "id", "result"}
            and data["jsonrpc"] == "2.0" and type(data["id"]) is int and data["id"] == 1)
    value = data["result"]
    hexbytes(value)
    compressed = bytes.fromhex(value[2:])
    require(compressed.startswith(b"\x1f\x8b"), "checkpoint is not a gzip state dump")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
        raw = stream.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, "decompressed checkpoint exceeds 64 MiB")
    return raw


def regular(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid(), "checkpoint path has unexpected type or owner")
    require(info.st_size <= MAX_BYTES, "existing checkpoint exceeds limit")
    return True


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def save_checkpoint(path=DEFAULT_STATE, fetch=fetch_state, initial_state_sha256=None):
    path = Path(path)
    require(path.name == "state.json", "checkpoint filename must be state.json")
    directory = path.parent
    require(directory.is_dir() and not directory.is_symlink(), "checkpoint directory must already exist")
    lock_path = directory / ".checkpoint.lock"
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(shutil.disk_usage(directory).free >= MIN_FREE, "less than 512 MiB free for checkpoint")
        previous = [directory / "state.json.previous-1", directory / "state.json.previous-2"]
        initial = directory / "state.json.initial-accounts"
        pending = directory / ".state.json.pending"
        link = directory / ".state.json.previous-pending"
        for item in [path, *previous, initial, pending, link]:
            regular(item)  # Refuse symlinks and unexpected owners before any mutation.
        raw = fetch()
        report = validate_state(raw)
        initialize = initial_state_sha256 is not None
        if initialize:
            require(type(initial_state_sha256) is str and re.fullmatch(r"[0-9a-f]{64}", initial_state_sha256))
            require(regular(path) and not regular(initial) and not any(regular(item) for item in previous),
                    "bootstrap requires an untouched initial account-state file")
        if regular(path):
            with path.open("rb") as stream:
                old_raw = stream.read(MAX_BYTES + 1)
            if initialize:
                require(hashlib.sha256(old_raw).hexdigest() == initial_state_sha256,
                        "initial account-state digest mismatch")
                old = parse_json(old_raw)
                require(type(old) is dict and set(old) == {"block", "accounts", "best_block_number",
                        "blocks", "transactions", "historical_states"} and type(old["accounts"]) is dict
                        and old["block"] is None and old["best_block_number"] is None
                        and old["blocks"] == [] and old["transactions"] == []
                        and old["historical_states"] is None, "not an initial account-only artifact")
            else:
                validate_state(old_raw)
        require(shutil.disk_usage(directory).free >= MIN_FREE, "less than 512 MiB free for checkpoint")
        # These fixed temporary names bound debris even after a SIGKILL.
        for item in (pending, link):
            if regular(item):
                item.unlink()
        try:
            output = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(output, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            # Hardlink immutable snapshots instead of moving the current file.
            # An interruption before the final replace leaves the current state intact.
            rotations = [(path, initial)] if initialize else [(previous[0], previous[1]), (path, previous[0])]
            for source, destination in rotations:
                if regular(source):
                    os.link(source, link, follow_symlinks=False)
                    os.replace(link, destination)
                    sync_directory(directory)
            os.replace(pending, path)
            sync_directory(directory)
        finally:
            for item in (pending, link):
                if regular(item):
                    item.unlink()
        return {**report, "initialized_from_account_only": initialize}
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--initial-state-sha256", help="One-time, explicitly pinned account-only bootstrap; never used by the timer")
    args = parser.parse_args()
    try:
        report = save_checkpoint(args.state, initial_state_sha256=args.initial_state_sha256)
        print(json.dumps({"checkpoint_saved": True, **report}, sort_keys=True))
        return 0
    except Exception:
        # No endpoint, response body, account data, credentials or exception text.
        print('{"checkpoint_saved":false,"error":"checkpoint-refused"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
