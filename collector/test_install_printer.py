"""Tests for remote printer install (spec 20): bundle integrity + hashing."""

from __future__ import annotations

import base64
import io
import zipfile

import pytest

import install_printer
from config import Config


def _zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_tree_hash_is_order_independent():
    a = install_printer._tree_hash({"b.txt": b"2", "a.txt": b"1"})
    b = install_printer._tree_hash({"a.txt": b"1", "b.txt": b"2"})
    assert a == b


def test_extract_round_trips():
    files = {"driver/x.inf": b"inf-bytes", "readme.txt": b"hi"}
    out = install_printer._extract(_zip(files))
    assert out == files


def test_integrity_mismatch_raises_before_touching_target(monkeypatch):
    files = {"driver/x.inf": b"inf"}
    zip_bytes = _zip(files)
    monkeypatch.setattr(
        install_printer, "_download_bundle", lambda *a, **k: zip_bytes
    )
    # If creds were ever resolved, the integrity check didn't run first.
    monkeypatch.setattr(
        install_printer,
        "resolve_profiles",
        lambda *a, **k: pytest.fail("reached creds despite bad hash"),
    )
    job = {
        "id": "j1",
        "targetIp": "10.0.0.5",
        "packageId": "pkg",
        "printerName": "P",
        "connection": {"type": "tcpip", "host": "10.0.0.9", "port": 9100},
        "packageSnapshot": {
            "driverName": "D",
            "infPath": "driver/x.inf",
            "arch": "x64",
            "sha256": "deadbeef",  # wrong on purpose
        },
    }
    with pytest.raises(RuntimeError, match="integrity"):
        install_printer.run_install(Config(), "tok", job)


def test_integrity_match_proceeds_to_creds(monkeypatch):
    files = {"driver/x.inf": b"inf"}
    zip_bytes = _zip(files)
    good = install_printer._tree_hash(files)
    monkeypatch.setattr(
        install_printer, "_download_bundle", lambda *a, **k: zip_bytes
    )
    # Correct hash → integrity passes, so we reach cred resolution (empty → raises).
    monkeypatch.setattr(install_printer, "resolve_profiles", lambda *a, **k: [])
    job = {
        "id": "j1",
        "targetIp": "10.0.0.5",
        "packageId": "pkg",
        "printerName": "P",
        "connection": {"type": "tcpip", "host": "10.0.0.9", "port": 9100},
        "packageSnapshot": {
            "driverName": "D",
            "infPath": "driver/x.inf",
            "arch": "x64",
            "sha256": good,
        },
    }
    with pytest.raises(RuntimeError, match="no credential profiles"):
        install_printer.run_install(Config(), "tok", job)


def test_base64_chunks_stay_under_the_command_line_limit():
    # Every fallback chunk must fit pywinrm's `powershell -encodedcommand <b64>`
    # command line (WinRS cmd shell, ~8 KB) — an oversized chunk fails with
    # "The command line is too long" on chunk 0 (the bug this guards against).
    scripts: list[str] = []

    class FakeResult:
        status_code = 0
        std_out = b""
        std_err = b""

    class FakeSession:
        def run_ps(self, script):
            scripts.append(script)
            return FakeResult()

    payload = bytes(range(256)) * 300  # ~77 KB → forces many chunks
    steps = install_printer._transfer_zip(
        FakeSession(),
        payload,
        r"C:\Windows\Temp\opus-print\job",
        install_printer._CHUNK,
    )

    assert all(s["exitCode"] == 0 for s in steps)
    # The payload was actually split (chunking happened, not one giant command).
    chunk_scripts = [s for s in scripts if "Add-Content" in s]
    assert len(chunk_scripts) > 1

    # Replicate pywinrm's encoding and assert every command line clears the limit.
    for script in scripts:
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        cmd_line = f"powershell -encodedcommand {encoded}"
        assert len(cmd_line) < 8000, f"command line {len(cmd_line)} chars — too long"
