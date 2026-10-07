"""Tests for remote printer install (spec 20): bundle integrity + hashing."""

from __future__ import annotations

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
