"""Tests for the WinRM username normalization (fix/collector-local-username).

A local account must reach pywinrm's NTLM as a BARE username — a `.\\name` prefix
is sent as the domain "." literally and the target rejects it. Domain and UPN
formats are left untouched.
"""

from __future__ import annotations

from collect_windows import _winrm_username


def test_strips_local_dot_prefix():
    assert _winrm_username(".\\infotech") == "infotech"


def test_leaves_bare_local_username():
    assert _winrm_username("infotech") == "infotech"


def test_leaves_domain_qualified_username():
    assert _winrm_username("AWINYC\\admin") == "AWINYC\\admin"


def test_leaves_upn_username():
    assert _winrm_username("admin@awinyc.local") == "admin@awinyc.local"
