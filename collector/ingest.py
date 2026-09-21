"""Ingest client: authenticate to aw-auth (client-credentials) and POST a run
to the web app's ingest API. Also reads the discovery type toggles (spec 13)."""

from __future__ import annotations

import json

import httpx

from config import Config
from models import RunReport

# The device types the toggles cover today (spec 13). Kept in sync with the web
# app's DISCOVERY_TYPES and the `discovery_settings.device_type` union.
DISCOVERY_TYPES = ("computer", "printer")


def get_token(config: Config) -> str:
    if not config.client_id or not config.client_secret:
        raise RuntimeError(
            f"Missing service-account credentials. Set {config.client_id_env} and "
            f"{config.client_secret_env} in .env."
        )
    resp = httpx.post(
        f"{config.auth_url}/v1/auth/token/client",
        json={
            "client_id": config.client_id,
            "client_secret": config.client_secret,
        },
        timeout=15,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"Token request failed ({resp.status_code}): {resp.text[:200]}"
        )
    token = resp.json().get("access")
    if not token:
        raise RuntimeError("Token response missing 'access'.")
    return token


def _coerce_settings(data: object) -> dict[str, bool]:
    """Normalize the endpoint's (or cache's) JSON to a full {type: bool} map,
    defaulting a missing or non-bool type to True (absent = on, AC-2)."""
    out: dict[str, bool] = {}
    for t in DISCOVERY_TYPES:
        value = data.get(t) if isinstance(data, dict) else None
        out[t] = value if isinstance(value, bool) else True
    return out


def _write_discovery_cache(config: Config, settings: dict[str, bool]) -> None:
    try:
        config.discovery_cache_path.write_text(
            json.dumps(settings), encoding="utf-8"
        )
    except Exception:  # noqa: BLE001 — caching is best-effort, never fatal
        pass


def _read_discovery_cache(config: Config) -> dict[str, bool] | None:
    try:
        path = config.discovery_cache_path
        if not path.exists():
            return None
        return _coerce_settings(json.loads(path.read_text(encoding="utf-8")))
    except Exception:  # noqa: BLE001
        return None


def get_discovery_settings(config: Config) -> tuple[dict[str, bool], str]:
    """Fetch the discovery type toggles before an automatic sweep (spec 13).

    Returns ``(settings, source)`` where ``settings`` is
    ``{"computer": bool, "printer": bool}`` and ``source`` is ``"fetched"``,
    ``"cache"``, or ``"default"``. Never raises: a successful fetch refreshes the
    on-host cache; a read failure falls back to the last cached result, and if
    none was ever cached it proceeds with all types on (fail open on first run
    only, AC-6).
    """
    try:
        token = get_token(config)
        resp = httpx.get(
            f"{config.ingest_url}/api/scan/discovery-settings",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        resp.raise_for_status()
        settings = _coerce_settings(resp.json())
        _write_discovery_cache(config, settings)
        return settings, "fetched"
    except Exception:  # noqa: BLE001 — a settings outage must not stop scanning
        cached = _read_discovery_cache(config)
        if cached is not None:
            return cached, "cache"
        return {t: True for t in DISCOVERY_TYPES}, "default"


def post_scan(config: Config, report: RunReport) -> dict:
    token = get_token(config)
    payload = report.model_dump(mode="json")
    resp = httpx.post(
        f"{config.ingest_url}/api/ingest/scan",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"Ingest failed ({resp.status_code}): {resp.text[:300]}"
        )
    return resp.json()
