import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile
from backup_devnet_capture import preserve, verify


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        snapshot = {'accounts': {'fixture': {}}, 'storage': {}, 'block_hashes': {'0x0': 'fixture'}}
        for name in ('latest.json', 'previous.json'):
            (self.source / name).write_text(json.dumps(snapshot))
        (self.source / 'state.json').write_bytes(b'')
        with sqlite3.connect(self.source / 'faucet.sqlite') as db:
            db.execute('CREATE TABLE claims (nonce INTEGER)')
        self.destination = self.root / 'backups'

    def test_roundtrip_retains_invalid_state_evidence_and_excludes_secrets(self):
        (self.source / 'private.key').write_text('NEVER INCLUDE')
        path, manifest = preserve(self.source, self.destination)
        self.assertEqual(verify(path), manifest)
        self.assertFalse(manifest['full_chain_recovery_verified'])
        self.assertFalse(manifest['state_dump_has_blocks'])
        self.assertEqual(manifest['files']['state.json']['bytes'], 0)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with zipfile.ZipFile(path) as archive:
            self.assertNotIn('private.key', archive.namelist())

    def test_identical_capture_is_idempotent(self):
        first, manifest = preserve(self.source, self.destination)
        second, repeated = preserve(self.source, self.destination)
        self.assertEqual(first, second)
        self.assertEqual(manifest, repeated)
        self.assertEqual(len(list(self.destination.glob('capture-*.zip'))), 1)

    def test_repeated_older_capture_is_retained_when_limit_shrinks(self):
        first, _ = preserve(self.source, self.destination)
        (self.source / 'state.json').write_bytes(b'other evidence')
        second, _ = preserve(self.source, self.destination)
        (self.source / 'state.json').write_bytes(b'')
        repeated, _ = preserve(self.source, self.destination, keep=1)
        self.assertEqual(first, repeated)
        self.assertTrue(first.exists())
        self.assertFalse(second.exists())

    def test_symlink_and_corrupt_sqlite_rejected(self):
        path = self.source / 'state.json'
        path.unlink()
        path.symlink_to(self.source / 'latest.json')
        with self.assertRaises(ValueError):
            preserve(self.source, self.destination)
        path.unlink()
        path.write_bytes(b'')
        (self.source / 'faucet.sqlite').write_bytes(b'broken')
        with self.assertRaises(sqlite3.DatabaseError):
            preserve(self.source, self.destination)

    def test_retention_is_scoped_and_preserves_unrelated_files(self):
        first, _ = preserve(self.source, self.destination)
        unrelated = self.destination / 'do-not-delete.zip'
        unrelated.write_bytes(b'operator evidence')
        (self.source / 'state.json').write_bytes(b'new incident evidence')
        second, _ = preserve(self.source, self.destination, keep=1)
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        self.assertTrue(unrelated.exists())
        self.assertTrue((self.source / 'latest.json').exists())

    def test_manifest_tampering_rejected(self):
        path, _ = preserve(self.source, self.destination)
        with zipfile.ZipFile(path, 'a') as archive:
            archive.writestr('unexpected', 'bad')
        with self.assertRaises(ValueError):
            verify(path)


if __name__ == '__main__':
    unittest.main()
