#!/usr/bin/env python3
"""Focused tests for fetch_data.py console/encoding hardening."""

import io
import sys
import unittest

# Import the module under test (same directory).  This also runs the module-level
# _configure_console_encoding() call, which is part of the production behaviour.
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
