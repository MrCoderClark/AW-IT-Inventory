"""Ingest client: authenticate to aw-auth (client-credentials) and POST a run
to the web app's ingest API."""

from __future__ import annotations

import httpx

from config import Config
from models import RunReport


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
