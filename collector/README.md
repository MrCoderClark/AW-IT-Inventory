# OPUS collector

Agentless fleet scanner. Discovers hosts on the configured subnets, resolves
per-host credentials, collects hardware/health over **WinRM** and printers over
**SNMP**, and writes a normalized JSON report. Full design:
[`../docs/specs/04-collector-agent-spec.md`](../docs/specs/04-collector-agent-spec.md).

> **This slice is standalone (dry-run).** It scans and writes JSON reports to
> `out/`. Posting to the inventory API is a later step (needs the ingest
> endpoint + an aw-auth service account).

## Setup

```bash
# from collector/
copy .env.example .env          # then fill in the local-admin passwords
# config.yaml already has the 70/72 subnets + credential profiles
```

- `config.yaml` — networks, credential **profiles** (username + which env var
  holds the password), and **rules** (which profiles to try per subnet).
- `.env` — the actual passwords (gitignored).

## Run

```bash
uv run python main.py scan                         # full scan of configured networks
uv run python main.py scan --network 192.168.72.0/24 --limit 20   # small test

# Specific hosts (IPs and/or CIDRs) — repeatable and/or comma-separated:
uv run python main.py scan --target 192.168.72.10,192.168.72.20,192.168.70.5
uv run python main.py scan --target 192.168.72.10 --target 192.168.70.0/28

# From a file (one IP/CIDR per line, # comments allowed):
uv run python main.py scan --targets-file hosts.txt

uv run python main.py scan --no-printers           # Windows only
```

`--target` / `--targets-file` override the `networks:` in `config.yaml`; a bare
IP is treated as a single host.

### Ingest to the inventory

By default `scan` is **dry-run** (writes JSON only). Add `--ingest` to also POST
the run to the web app, which reconciles machines to assets by serial:

```bash
uv run python main.py scan --target 192.168.72.172 --ingest
```

Setup (once):
1. In aw-auth, create a service account and copy its credentials:
   `uv run python manage.py create_service_account collector --scopes ingest:write asset:read`
2. Put them in the collector's `.env`: `OPUS_CLIENT_ID` / `OPUS_CLIENT_SECRET`.
3. Set `auth_url` (aw-auth) and `ingest_url` (web app) in `config.yaml`.

The collector fetches a short-lived service token (client-credentials) and POSTs
to `ingest_url/api/ingest/scan` with `Authorization: Bearer …`.

Output: a table summary in the console + `out/<run_id>.json`.

## Endpoint prerequisites (for WinRM to succeed)

- **WinRM enabled** on targets (`winrm quickconfig`, or via GPO on the domain).
- **Workgroup machines** (`.72`): set `LocalAccountTokenFilterPolicy=1` and add
  the collector host to WinRM **TrustedHosts** so local-admin auth over HTTP/NTLM
  works.
- Firewall: allow the collector host to reach `5985` (WinRM), `445` (SMB), and
  `161/udp` (SNMP), `9100` (printers) on the subnets.
- Collection is **read-only** — no changes are made to endpoints.

## What it collects

- **Windows** (one WinRM/PowerShell call → JSON): manufacturer/model/serial,
  SMBIOS UUID, CPU/cores, RAM, GPU, BIOS, disks, OS name/version/build, uptime,
  free disk per volume, logged-on user.
- **Printers** (SNMP v2c): sysDescr, serial, page count, printer status.

## How credential resolution works

For each host, `rules` (top-down, by subnet) yield an ordered list of profiles;
the collector tries each until one authenticates and records which worked.
Adding/rotating a credential is a config + `.env` edit — no code change.
