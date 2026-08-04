#!/usr/bin/env python3
"""Focused tests for fetch_data.py console/encoding and success/failure policy."""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

# Import the module under test (same directory).  Console encoding is no longer
# configured at import time; it is called inside main().
import fetch_data


class TestConsoleEncoding(unittest.TestCase):
    def _make_cp1252_stdout(self):
        """Return a TextIOWrapper over a BytesIO that is set to cp1252."""
        buffer = io.BytesIO()
        return io.TextIOWrapper(buffer, encoding="cp1252"), buffer

    def test_configures_stdout_for_utf8_on_cp1252_console(self):
        """The Unicode symbol-loop header must not raise on a cp1252 console."""
        fake_stdout, buffer = self._make_cp1252_stdout()

        old_stdout = sys.stdout
        try:
            sys.stdout = fake_stdout
            # Force the Windows code path so the test is independent of the host OS.
            with patch("sys.platform", "win32"):
                fetch_data._configure_console_encoding()

            # Reproduce the exact header line used in main() for the first symbol.
            symbol = "AAPL"
            print(
                f"── [1/1] {symbol} "
                + "─" * max(0, 30 - len(symbol))
            )
            fake_stdout.flush()
        finally:
            sys.stdout = old_stdout

        written = buffer.getvalue()
        self.assertIn(b"AAPL", written)
        self.assertIn("──".encode("utf-8"), written)

    def test_config_does_not_fail_on_bufferless_stream(self):
        """StringIO and similar streams without a .buffer are left untouched."""
        old_stdout = sys.stdout
        try:
            sys.stdout = io.StringIO()
            fetch_data._configure_console_encoding()
            print("hello", file=sys.stdout)
            self.assertEqual(sys.stdout.getvalue().strip(), "hello")
        finally:
            sys.stdout = old_stdout


class TestMainSuccessFailurePolicy(unittest.TestCase):
    """Cover the post-loop success/failure event policy in main()."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="fetch_data_test_")
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        # Capture stdout so Unicode prints in main() do not depend on the host
        # console encoding during policy tests.
        self._old_stdout = sys.stdout
        sys.stdout = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", errors="replace")
        self.addCleanup(setattr, sys, "stdout", self._old_stdout)
        # _configure_console_encoding() is exercised in TestConsoleEncoding;
        # here we simply isolate main() from the real console while it runs.

    def _manifest_path(self):
        return os.path.join(self.tmpdir, ".sync_manifest.json")

    def _read_manifest(self):
        with open(self._manifest_path(), "r", encoding="utf-8") as fh:
            return json.load(fh)

    def _make_argv(self, extra=None):
        argv = [
            "fetch_data.py",
            "--symbols", "AAPL", "MSFT",
            "--data-dir", self.tmpdir,
            "--mode", "full",
        ]
        if extra:
            argv.extend(extra)
        return argv

    def test_all_symbols_succeed_notifies_engine_and_exits_zero(self):
        """Full success: manifest written, notify_engine called once, no sys.exit."""
        with patch.object(sys, "argv", self._make_argv()), \
             patch.object(fetch_data, "notify_engine") as mock_notify, \
             patch("time.sleep"), \
             patch.object(fetch_data, "process_symbol_legacy", return_value=(True, 10)):

            fetch_data.main()

        self.assertEqual(mock_notify.call_count, 1)
        self.assertEqual(mock_notify.call_args[0][0], 9000)
        manifest = mock_notify.call_args[0][1]
        self.assertEqual(manifest["ok"], 2)
        self.assertEqual(manifest["fail"], 0)
        self.assertEqual(len(manifest["symbols"]), 2)
        for symbol in ("AAPL", "MSFT"):
            self.assertEqual(manifest["symbols"][symbol]["ok"], True)
            self.assertEqual(manifest["symbols"][symbol]["rows"], 10)

    def test_one_symbol_fails_does_not_notify_and_exits_one(self):
        """Partial failure: manifest written, no engine call, exit code 1."""
        with patch.object(sys, "argv", self._make_argv()), \
             patch.object(fetch_data, "notify_engine") as mock_notify, \
             patch("time.sleep"), \
             patch.object(fetch_data, "process_symbol_legacy",
                          side_effect=[(True, 10), (False, 0)]):

            with self.assertRaises(SystemExit) as cm:
                fetch_data.main()

        self.assertEqual(cm.exception.code, 1)
        mock_notify.assert_not_called()

        manifest = self._read_manifest()
        self.assertEqual(manifest["ok"], 1)
        self.assertEqual(manifest["fail"], 1)
        self.assertEqual(manifest["symbols"]["AAPL"]["ok"], True)
        self.assertEqual(manifest["symbols"]["AAPL"]["rows"], 10)
        self.assertEqual(manifest["symbols"]["MSFT"]["ok"], False)
        self.assertEqual(manifest["symbols"]["MSFT"]["rows"], 0)

    def test_all_symbols_fail_does_not_notify_and_exits_one(self):
        """Total failure: manifest written, no engine call, exit code 1."""
        with patch.object(sys, "argv", self._make_argv()), \
             patch.object(fetch_data, "notify_engine") as mock_notify, \
             patch("time.sleep"), \
             patch.object(fetch_data, "process_symbol_legacy", return_value=(False, 0)):

            with self.assertRaises(SystemExit) as cm:
                fetch_data.main()

        self.assertEqual(cm.exception.code, 1)
        mock_notify.assert_not_called()

        manifest = self._read_manifest()
        self.assertEqual(manifest["ok"], 0)
        self.assertEqual(manifest["fail"], 2)

    def test_main_calls_configure_console_encoding(self):
        """main() must call _configure_console_encoding() exactly once."""
        with patch.object(sys, "argv", self._make_argv()), \
             patch.object(fetch_data, "_configure_console_encoding") as mock_enc, \
             patch.object(fetch_data, "notify_engine"), \
             patch("time.sleep"), \
             patch.object(fetch_data, "process_symbol_legacy", return_value=(True, 10)):

            fetch_data.main()

        self.assertEqual(mock_enc.call_count, 1)

    def test_sync_mode_all_succeed_notifies_engine(self):
        """The same policy holds when using the smart cached-append path."""
        with patch.object(sys, "argv", [
            "fetch_data.py",
            "--symbols", "AAPL",
            "--data-dir", self.tmpdir,
            "--mode", "sync",
        ]), \
             patch.object(fetch_data, "notify_engine") as mock_notify, \
             patch("time.sleep"), \
             patch.object(fetch_data, "process_symbol_sync", return_value={
                 "1m": {"ok": True, "rows": 7, "action": "seed", "added": 7},
             }):

            fetch_data.main()

        self.assertEqual(mock_notify.call_count, 1)
        manifest = mock_notify.call_args[0][1]
        self.assertEqual(manifest["ok"], 1)
        self.assertEqual(manifest["fail"], 0)
        self.assertEqual(manifest["symbols"]["AAPL"]["1m"]["ok"], True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
