# 04 — Python Collector Spec (Agentless Fleet Scanning)

**Status:** Draft v1 · **Last updated:** 2026-08-21 · **Stack:** Python 3.12 worker

The engine that keeps the inventory current. It discovers hosts on the two subnets,
resolves the right local-admin credential per host, collects hardware/health/software/
file/compliance data over WinRM/WMI/SMB (and SNMP for printers), and posts normalized
results to the inventory ingest API.

> **Security note up front.** This service is the only component that holds endpoint
> credentials. Treat it accordingly: encrypted vault, least privilege, full audit,
> dry-run defaults, and a tightly restricted network path. See §7.

---

## 1. Fleet facts it must handle

| Fact | Consequence for the design |
|---|---|
| Domain devices on **192.168.70.0/24** (incl. printers) | Scan this subnet; printers here need **SNMP**, not WinRM |
| Workgroup devices on **192.168.72.0/24** | Local-account auth; needs UAC token-filter + WinRM TrustedHosts prep |
| Win10 local admin `infotech` | Credential profile A |
| Win11 workgroup local admin `Intech` | Credential profile B |
| Win11 AD-joined local admin `Infotech` (different password) | Credential profile C — same username as A, different secret |
| ~2–3 distinct passwords, may change | Vault + rules + ordered fallback, never hardcoded pairs |

---

## 2. Pipeline

```
 schedule ─▶ discover ─▶ classify ─▶ resolve credential ─▶ collect ─▶ normalize ─▶ ingest ─▶ report
                │            │              │                  │
             ping/ARP    OS/printer     vault + rules     WinRM/WMI/
             both /24s    + subnet       + fallback        SMB/SNMP
```

### 2.1 Discover
- ICMP ping sweep + ARP table read of `192.168.70.0/24` and `192.168.72.0/24`.
- Optional: read the DHCP/DNS or AD computer list for the 70 subnet to seed hostnames.
- Output: candidate `(ip, subnet, maybe-hostname)` list.

### 2.2 Classify
- Probe ports/fingerprint: `5985/5986` (WinRM), `445` (SMB), `161` (SNMP), `9100`/`631`
  (print).
- Decide **device type**: Windows host vs printer vs unknown.
- Decide **identity domain**: subnet 70 = domain-ish, 72 = workgroup (used by cred rules).
- Detect **OS version** (Win10 vs Win11) via SMB/WinRM fingerprint once reachable.

### 2.3 Resolve credential (the crux)
A **credential vault** holds encrypted profiles; **match rules** pick candidates in order;
the collector tries them until one authenticates, then caches the winner per host.

```yaml
# credential-rules.yml (illustrative; secrets NOT stored here — only references)
profiles:
  - id: win10-infotech      # A
    username: ".\\infotech"
    secret_ref: vault://collector/win10-infotech
  - id: wg-intech           # B
    username: ".\\Intech"
    secret_ref: vault://collector/wg-intech
  - id: ad-infotech         # C  (same name as A, different password)
    username: ".\\Infotech"
    secret_ref: vault://collector/ad-infotech

rules:                       # evaluated top-down; each yields an ordered candidate list
  - match: { subnet: 192.168.72.0/24 }
    try: [wg-intech, win10-infotech]              # workgroup, then Win10 fallback
  - match: { subnet: 192.168.70.0/24, os: win11 }
    try: [ad-infotech, win10-infotech]            # AD Win11, then Win10 fallback
  - match: { os: win10 }
    try: [win10-infotech, ad-infotech, wg-intech]
  - match: { any: true }                          # last-resort: try all
    try: [ad-infotech, win10-infotech, wg-intech]

cache: per-host winning profile (stored on machine.working_credential_profile)
```

Rationale: you told me there are ~3 profiles and the passwords may change; this models
*profiles + rules + fallback* rather than "two passwords," so adding/rotating a
credential is a config edit, not a code change. The per-host cache means steady-state
runs authenticate on the first try.

### 2.4 Collect
Per device type (see §3).

### 2.5 Normalize → 2.6 Ingest
Map raw output into the ingest contract (§4) and POST in batches with the service-account
token from `aw-auth`.

### 2.7 Report
Each run emits a report: hosts discovered/reached/failed, per-host credential used,
changes detected, errors. Surfaced in the UI (Scans view) and logged.

---

## 3. Collector modules

### 3.1 Windows hosts (WinRM primary, WMI/SMB fallback)
Transport: **pywinrm** (PowerShell/CIM over WinRM); fallback **impacket** (WMI/DCOM) and
**smbprotocol** for file operations.

| Data | Source |
|---|---|
| System/model/serial | `Win32_ComputerSystem`, `Win32_BIOS`, `Win32_ComputerSystemProduct` (UUID) |
| CPU | `Win32_Processor` |
| RAM | `Win32_PhysicalMemory` (sum) |
| Disks + SMART | `Win32_DiskDrive`, `MSStorageDriver_FailurePredictStatus`, `Get-PhysicalDisk` |
| OS + build + uptime | `Win32_OperatingSystem` |
| Free space per volume | `Win32_LogicalDisk` |
| Installed software | Registry `Uninstall` keys (x64 + WOW6432Node) |
| Local admins | `Get-LocalGroupMember Administrators` |
| BitLocker | `Get-BitLockerVolume` |
| AV status | `SecurityCenter2` `AntiVirusProduct` |
| Battery health (laptops) | `Win32_Battery` / `powercfg` |
| Pending reboot / patch | CBS/WU registry + `Win32_QuickFixEngineering` |

### 3.2 File-check rules engine
Config-driven presence/hash checks over SMB (read-only).
```yaml
file_rules:
  - id: prohibited-installer
    scope: { subnet: any }
    paths: ["C:\\Users\\*\\Downloads\\*.exe"]
    action: report_presence            # or hash, or match-pattern
  - id: license-file
    paths: ["C:\\ProgramData\\MyApp\\license.dat"]
    action: report_presence
```
Results → `file_check_result`. Scope-limited, rate-limited, never modifies target files.

### 3.3 Printers (SNMP)
Transport: **pysnmp**. On the 70 subnet, devices classified as printers.
| Data | OID / MIB |
|---|---|
| Model / description | `sysDescr`, Printer-MIB |
| Serial | `prtGeneralSerialNumber` |
| Page counts | `prtMarkerLifeCount` |
| Toner/supply levels | `prtMarkerSuppliesLevel` |
| Status | `hrPrinterStatus` |
Results → `printer_snapshot`.

---

## 4. Ingest contract (collector → `web` `/api/ingest`)

Authenticated with `Authorization: Bearer <service-account access token>` (scope
`ingest:write`). Idempotent per `(source, external_id, captured_at)`.

```http
POST /api/ingest/scan
Content-Type: application/json

{
  "run_id": "2026-08-21T02:00:00Z-run-3",
  "machines": [
    {
      "hardware_uuid": "…", "serial": "…", "hostname": "WS-ENG-14",
      "subnet": "192.168.70.0/24", "credential_profile": "ad-infotech",
      "os": { "name": "Windows 11 Pro", "version": "23H2", "build": "22631" },
      "hardware": { "cpu": "…", "cpu_cores": 8, "ram_gb": 32, "disks": [ … ], "gpu": "…" },
      "health": { "free_disk_gb": { "C:": 210 }, "uptime_hours": 52, "smart": "ok", "battery_health_pct": 88 },
      "software": [ { "name": "…", "version": "…", "publisher": "…" } ],
      "compliance": { "bitlocker_on": true, "av_product": "…", "av_up_to_date": true, "local_admins": [ … ] },
      "file_checks": [ { "rule_id": "prohibited-installer", "path": "…", "found": false } ]
    }
  ],
  "printers": [ { "hostname": "…", "ip": "…", "model": "…", "serial": "…", "page_count": 84213, "toner_levels": { "K": 42 } } ],
  "errors": [ { "ip": "192.168.72.51", "reason": "auth_failed_all_profiles" } ]
}
```
Response: per-item reconcile result (`matched_asset_id` | `discovered_device_id`).

---

## 5. Scheduling & execution

- Scheduler: **APScheduler** (single worker) or **Celery beat + workers** (scale).
- Cadence: full discovery nightly; targeted health refresh more often (configurable).
- **Concurrency caps** and jitter so we don't flood the network or a switch.
- **Timeouts + retries** with backoff per host; a dead host doesn't stall the run.
- **Dry-run mode** (default in staging): collect + report, do not ingest.
- Config lives in the DB/UI where possible so ops can tune without redeploying.

---

## 6. Windows host prerequisites (documented for rollout)

For agentless WinRM/WMI to work, especially workgroup machines:
- Enable WinRM (`winrm quickconfig`) or push via GPO on the domain side.
- Workgroup: set `LocalAccountTokenFilterPolicy=1` (UAC remote token) and add the
  collector host to WinRM **TrustedHosts**; prefer HTTPS/5986 with a cert where possible.
- Firewall: allow the collector host to reach 5985/5986, 445, 161 on the subnets.
- Least-privilege: the local-admin accounts are already admin; scope collection scripts
  to read-only operations only.

A `prep-endpoint.ps1` (GPO-deployable) will ship to standardize this.

---

## 7. Security & safety requirements

- **Vault:** credentials encrypted at rest (app-level envelope encryption or an external
  secrets store); the YAML holds only `secret_ref`s. Master key from env/HSM, never repo.
- **Least privilege & read-only:** collection scripts never write to endpoints (except
  nothing — they read); file-check is read-only.
- **Audit:** every host contacted, which credential profile succeeded/failed, what was
  collected — logged and surfaced. Auth failures don't leak passwords.
- **Blast-radius control:** collector runs on a dedicated host/container with network
  access only to the two subnets + `web`; no inbound exposure.
- **Rate limiting / politeness:** capped concurrency, jitter, backoff.
- **Fail safe:** dry-run default off-prod; explicit enable to ingest; kill switch.

---

## 8. Libraries

| Need | Library |
|---|---|
| WinRM / PowerShell | pywinrm |
| WMI / DCOM fallback | impacket |
| SMB file ops | smbprotocol |
| SNMP (printers) | pysnmp |
| Discovery | scapy / raw sockets / python-nmap |
| Scheduling | APScheduler or Celery |
| HTTP ingest | httpx (retries/backoff) |
| Config/secrets | pydantic-settings + cryptography (Fernet) or vault client |

---

## 9. Later: optional installed agent

For roaming laptops or to avoid central credential storage, a small Python agent
(packaged exe via PyInstaller, run as a scheduled task/service) can push the same ingest
payload outbound over HTTPS with its own service-account key. Same contract (§4), so it
drops in without server changes. Not needed for the on-network fleet today.
