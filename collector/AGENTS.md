# Collector

## Overview

The OPUS fleet scanner: an agentless, outbound-only Python service (uv-managed,
Python 3.12). It discovers hosts on the configured subnets by TCP probe, collects
Windows machines over WinRM and printers over SNMP, and posts normalized results
to the web app's ingest API. It never accepts an inbound connection. Two commands:
`scan` (one-off discover + collect) and `worker` (long-running: drains manual scan
jobs and runs the printer reachability + daily report schedule).

## Key files

| File | Owns |
|---|---|
| `main.py` | CLI (`scan`, `worker`) and the discover to collect to report/ingest pipeline |
| `config.py` | `Config` model (pydantic), YAML load + `.env` load; secrets named via `*_env` fields |
| `discovery.py` | Host discovery + classification via TCP connect probes (no ICMP/ARP) |
| `creds.py` | Per-host credential profile resolution (rules matched top-down, ordered fallback) |
| `collect_windows.py` | WinRM collection: one PowerShell/CIM call returns JSON; tries each profile; also reads installed software from the registry Uninstall keys (spec 15) |
| `collect_snmp.py` | SNMP printer collection: identity, status, and the page counter (see Gotchas) |
| `reachability.py` | Worker's scheduled printer TCP probes, daily SNMP collect, counter report, prune |
| `worker.py` | Long-running worker: the job claim loop + an in-process APScheduler |
| `ingest.py` | Auth to aw-auth (client-credentials) + POST the run to the web ingest API; reads the discovery toggles |
| `models.py` | Typed result models (`HostResult`, `PrinterInfo`, `RunReport`, …) |
| `report.py` | Persist a run as JSON and print the console summary |

## Commands

Mirror the root `CLAUDE.md` "Run it" block; the ones used most here:

```bash
uv run python main.py scan --target 192.168.72.10/32          # dry-run (writes JSON to out/)
uv run python main.py scan --target 192.168.72.0/24 --ingest  # scan + post to the ingest API
uv run python main.py worker                                  # long-running worker (jobs + schedule)
uv sync --extra cutout; uv run python main.py cutout          # rembg background-removal worker (spec 18 ph3, opt-in)
uv run pytest -q                                              # tests
```

`--no-windows` / `--no-printers` narrow a run; `--target` / `--targets-file` / `--network` override the config networks.

## Conventions

- **Outbound-only.** The collector never listens; the worker pulls jobs and pushes results. Do not add an inbound server.
- **Secrets never live in YAML.** `config.yaml` names an env var (`password_env`, `client_id_env`, …); the value sits in a gitignored `.env` that `config.py` loads. Only `*.example` files are committed.
- **Config is pydantic + YAML.** Add a knob as a `Config` field with a default and document it in `config.example.yaml`; read it off the loaded `Config`, never re-read the file.
- **Credentials resolve per subnet.** `creds.py` returns an ordered list of profiles to try per host; the first that authenticates wins and is recorded for next time.
- **Discovery uses TCP probes**, not ICMP/ARP (needs no admin rights, reliable on Windows).
- **The automatic `scan` sweep honors the web discovery toggles** (spec 13): it fetches them first, caches the last good result (`.discovery-settings.json`, fail open), and skips an off type. Manual worker jobs bypass the toggles.

## Gotchas

- **SNMP v1: read OIDs separately, never bundled.** Under SNMP v1 a GET that contains ONE missing OID fails the whole request (`noSuchName`). `collect_snmp.collect_printer` anchors reachability on `sysDescr`, pins the version that answered, then reads serial, status, and the page counter as separate best-effort GETs. Some fleet Canons (e.g. the iR1750) do not implement `prtGeneralSerialNumber`; bundling it would drop identity AND the counter. Keep every new SNMP read per-OID.
- **The fleet Canons answer SNMP v1 only** (imageFORCE, iR series) and silently drop v2c. `snmp_version: "auto"` (the default) tries v2c then falls back to v1, so they read with no config; pin `v1` to skip the v2c timeout on an all-Canon subnet.
- **`counter_oids` is tried in order, first number wins**, each in its own GET (per the v1 rule above). Default: Canon "Total 2" (`…1602.1.11.1.3.1.4.102`) then the standard `prtMarkerLifeCount`. Put a vendor OID ahead of the standard fallback; the iR1750's total reads via the standard fallback (its Canon `.101` equals the standard value).
- **WinRM is blocking (run in a thread pool); SNMP is async.** `scan` collects Windows hosts on threads and printers on asyncio; keep that split.
- **WinRM local-account auth needs a BARE username + a target-side registry flag.** A credential profile for a LOCAL admin must use a bare username (`infotech`), NOT `.\infotech`: pywinrm's NTLM sends the `.\` prefix as domain "." literally and the target returns `InvalidCredentialsError` (even though PowerShell's `.\user` works). `collect_windows._winrm_username` strips a leading `.\` defensively. Separately, a local account on a **domain-joined** machine gets a UAC-filtered (non-admin) token over the network → WinRM "Access is denied"; fix on the target with `HKLM\...\Policies\System\LocalAccountTokenFilterPolicy=1` (push by GPO for the fleet), or use a domain account in local Administrators instead. You can list several profiles for the same account with different passwords; they're tried in order (first that authenticates wins). `auth_failed_all_profiles (...)` now lists **every** profile tried — each with its *qualified* username and per-profile reason (`ps_exit_N …`, the exception, or `no password in .env` for a skipped one) — so a failing host is diagnosable straight from the ingest, the same per-profile truth `diag_winrm.py` prints.
- **Installed software rides the WinRM collect (spec 15).** `collect_windows` reads the registry Uninstall keys (HKLM 64-bit, `WOW6432Node`, HKCU) in the same PowerShell call, never `Win32_Product` (slow, can trigger MSI repair). Best effort: a software read failure never fails the machine collect (`software=None` then). The collector sends every named program (`HostResult.software`); the web app filters to the watchlist at ingest. Blank registry values (the PS `"$(...)"` coercion yields `""`) normalize to `None`.

## Related specs

- [04](../docs/specs/04-collector-agent-spec.md) collector agent · [12](../docs/specs/12-scheduled-manual-scans/index.md) scheduled/manual scans + reachability · [13](../docs/specs/13-discovery-type-toggles/index.md) discovery toggles · [14](../docs/specs/14-printer-page-counter/index.md) printer page counter · [15](../docs/specs/15-software-inventory/index.md) software inventory

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
