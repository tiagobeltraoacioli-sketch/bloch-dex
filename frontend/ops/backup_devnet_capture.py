#!/usr/bin/env python3
"""Preserve a selected incident capture; this is not automatic chain recovery."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import zipfile

NAMES = ('latest.json', 'previous.json', 'state.json', 'faucet.sqlite')
LIMIT = 32 * 1024 * 1024
PATTERN = re.compile(r'capture-[0-9a-f]{64}\.zip')


def validate(files):
    if set(files) != set(NAMES) or any(len(data) > LIMIT for data in files.values()):
        raise ValueError('capture file set or size invalid')
    for name in NAMES[:2]:
        snapshot = json.loads(files[name])
        if set(snapshot) != {'accounts', 'storage', 'block_hashes'} or not snapshot['accounts'] or not snapshot['block_hashes']:
            raise ValueError('invalid account snapshot')
    # SQLite integrity is validated on a disposable copy, never the source.
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'faucet.sqlite'
        path.write_bytes(files['faucet.sqlite'])
        with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('SQLite integrity failure')
    state_valid = False
    try:
        state = json.loads(files['state.json'])
        state_valid = isinstance(state, dict) and 'accounts' in state and bool(state.get('blocks'))
    except (ValueError, UnicodeError):
        pass
    return {'format': 'postern-incident-capture-v1', 'full_chain_recovery_verified': False,
            'state_dump_has_blocks': state_valid,
            'limitations': ['account caches omit headers and receipts', 'capture may predate incident',
                            'state.json is preserved even when empty or invalid', 'not a scheduled backup'],
            'files': {name: {'bytes': len(files[name]), 'sha256': hashlib.sha256(files[name]).hexdigest()} for name in NAMES}}


def verify(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > LIMIT * 4 + 65536:
        raise ValueError('invalid archive file')
    with zipfile.ZipFile(path) as archive:
        if sorted(archive.namelist()) != sorted((*NAMES, 'manifest.json')):
            raise ValueError('invalid archive member set')
        if any(info.file_size > LIMIT for info in archive.infolist()):
            raise ValueError('oversize archive member')
        files = {name: archive.read(name) for name in NAMES}
        actual = validate(files)
        if actual != json.loads(archive.read('manifest.json')):
            raise ValueError('manifest verification failed')
    return actual


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def preserve(source, destination, keep=7):
    if not 1 <= keep <= 30:
        raise ValueError('retention must be 1..30')
    files = {}
    for name in NAMES:
        path = source / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size > LIMIT:
            raise ValueError('invalid selected source file')
        files[name] = path.read_bytes()
    manifest = validate(files)
    if destination.is_symlink():
        raise ValueError('destination cannot be a symlink')
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.stat().st_mode & 0o077:
        raise ValueError('destination must have mode 0700')
    content = io.BytesIO()
    with zipfile.ZipFile(content, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in NAMES:
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, files[name])
        entry = zipfile.ZipInfo('manifest.json', date_time=(1980, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, json.dumps(manifest, sort_keys=True))
    raw = content.getvalue()
    target = destination / ('capture-' + hashlib.sha256(raw).hexdigest() + '.zip')
    with tempfile.NamedTemporaryFile(dir=destination, prefix='.capture-', delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        verify(temporary)
        try:
            os.link(temporary, target)  # Refuse to replace existing backups.
        except FileExistsError:
            verify(target)
            if target.read_bytes() != raw:
                raise ValueError('existing backup differs from content hash')
        sync_directory(destination)
    finally:
        temporary.unlink()
        sync_directory(destination)
    # Retain only this tool's verified captures in its dedicated directory.
    captures = sorted((p for p in destination.iterdir() if PATTERN.fullmatch(p.name) and not p.is_symlink()),
                      key=lambda p: (p == target, p.stat().st_mtime_ns), reverse=True)
    for old in captures[keep:]:
        verify(old)
        if hashlib.sha256(old.read_bytes()).hexdigest() != old.stem[8:]:
            raise ValueError('retention content hash mismatch')
        old.unlink()
        sync_directory(destination)
    return target, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    write = sub.add_parser('preserve')
    write.add_argument('source', type=Path)
    write.add_argument('destination', type=Path)
    write.add_argument('--keep', type=int, default=7)
    check = sub.add_parser('verify')
    check.add_argument('archive', type=Path)
    args = parser.parse_args()
    if args.command == 'preserve':
        path, manifest = preserve(args.source, args.destination, args.keep)
        print(json.dumps({'archive': str(path), 'manifest': manifest}, sort_keys=True))
    else:
        print(json.dumps(verify(args.archive), sort_keys=True))


if __name__ == '__main__':
    main()
