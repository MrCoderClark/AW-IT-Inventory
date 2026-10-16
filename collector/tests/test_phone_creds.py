"""Tests for the per-phone credential loader (spec 27 phase 2).

Parse an `ip,username,password` CSV (header/comment/blank lines skipped), look up by
IP, and treat a missing file as "no credentials" rather than an error.
"""

from __future__ import annotations

import os

from config import Config

import phone_creds


def _config(tmp_path, name="phone_credentials.csv") -> Config:
    return Config(phone_credentials_file=str(tmp_path / name))


def test_parses_and_resolves_by_ip(tmp_path):
    phone_creds.clear_cache()
    (tmp_path / "phone_credentials.csv").write_text(
        "ip,username,password\n"
        "# a comment line\n"
        "\n"
        "192.168.75.62,admin,22903756052\n"
        "192.168.75.64, admin , secret64 \n",
        encoding="utf-8",
    )
    cfg = _config(tmp_path)

    c = phone_creds.resolve_phone_credential(cfg, "192.168.75.62")
    assert c is not None
    assert c.username == "admin"
    assert c.password == "22903756052"

    # Whitespace is trimmed.
    c64 = phone_creds.resolve_phone_credential(cfg, "192.168.75.64")
    assert c64.password == "secret64"

    # The password never leaks via repr.
    assert "22903756052" not in repr(c)


def test_reloads_when_csv_changes(tmp_path):
    phone_creds.clear_cache()
    path = tmp_path / "phone_credentials.csv"
    path.write_text("192.168.75.1,admin,pw1\n", encoding="utf-8")
    cfg = _config(tmp_path)
    assert phone_creds.resolve_phone_credential(cfg, "192.168.75.2") is None
    path.write_text(
        "192.168.75.1,admin,pw1\n192.168.75.2,admin,pw2\n", encoding="utf-8"
    )
    st = path.stat()
    os.utime(path, (st.st_atime, st.st_mtime + 1))
    # mtime is the cache key; a rewrite must be visible without clear_cache().
    c2 = phone_creds.resolve_phone_credential(cfg, "192.168.75.2")
    assert c2 is not None
    assert c2.password == "pw2"


def test_missing_file_is_empty_not_an_error(tmp_path):
    phone_creds.clear_cache()
    cfg = _config(tmp_path, "does-not-exist.csv")
    assert phone_creds.load_phone_credentials(cfg) == {}
    assert phone_creds.resolve_phone_credential(cfg, "192.168.75.62") is None


def test_defaults_username_and_skips_bad_rows(tmp_path):
    phone_creds.clear_cache()
    (tmp_path / "phone_credentials.csv").write_text(
        "192.168.75.70,,pw70\n"  # blank username → defaults to 'admin'
        "192.168.75.71,admin\n"  # too few columns → skipped
        "192.168.75.72,admin,\n",  # blank password → skipped
        encoding="utf-8",
    )
    cfg = _config(tmp_path)

    assert phone_creds.resolve_phone_credential(cfg, "192.168.75.70").username == "admin"
    assert phone_creds.resolve_phone_credential(cfg, "192.168.75.71") is None
    assert phone_creds.resolve_phone_credential(cfg, "192.168.75.72") is None
