"""Tests for the WinRM wall-clock timeout wrapper (_run_ps_timeout).

A hung server-side query must not block the collect forever: pywinrm polls a
running command indefinitely, so the collector runs each call on a daemon thread
it abandons at the cap, returning None (the caller then swaps in a fresh session).
"""

from __future__ import annotations

import time

from collect_windows import _run_ps_timeout


class _Resp:
    def __init__(self, code: int = 0) -> None:
        self.status_code = code


class _Session:
    """A fake pywinrm session: fast ok, a hang (sleep), or a raise."""

    def __init__(self, behavior: str) -> None:
        self.behavior = behavior

    def run_ps(self, script: str):  # noqa: ARG002
        if self.behavior == "ok":
            return _Resp(0)
        if self.behavior == "slow":
            time.sleep(5)  # longer than any test timeout
            return _Resp(0)
        raise RuntimeError("boom")


def test_returns_response_when_fast():
    r = _run_ps_timeout(_Session("ok"), "x", 2)
    assert r is not None and r.status_code == 0


def test_none_on_timeout():
    # The slow call (5s) exceeds the 0.3s cap → abandoned, None returned promptly.
    start = time.time()
    assert _run_ps_timeout(_Session("slow"), "x", 0.3) is None
    assert time.time() - start < 2  # returned near the cap, not after the 5s sleep


def test_none_on_error():
    assert _run_ps_timeout(_Session("raise"), "x", 2) is None
