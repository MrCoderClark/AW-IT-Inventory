# Runbook — Onboarding a new Windows computer (WinRM)

When a new PC is added to the fleet it should appear in OPUS after a scan, reconcile
by serial, and show live hardware/health in the asset drawer. When it appears but the
hardware stays **blank** — or the collector logs `auth_failed_all_profiles (...)` —
the WinRM collect isn't authenticating. This runbook is the decision tree we used to
onboard `192.168.70.30`; follow it top to bottom.

> Context: the collector collects Windows hosts over **WinRM (HTTP, port 5985)** using
> the local-admin credential profiles in `collector/config.yaml` (secrets in
> `collector/.env`). Profiles resolve per subnet; see `collector/AGENTS.md` → *Gotchas*
> and spec [04](../specs/04-collector-agent-spec.md).

## Step 0 — Diagnose first (don't guess)

From the collector box, in `collector/`:

```
uv run python diag_winrm.py <ip>
```

This resolves **every** profile the collector would try for that host, prints the exact
qualified username, whether a password is loaded from `.env`, and the **real per-profile
auth result** — without an install job and without the single-last-error masking that
`auth_failed_all_profiles` suffers from.

- `-> OK (COMPUTERNAME=...)` → done. Restart the worker and hit **Scan**; hardware fills in.
- `-> SKIP (no password in .env)` → the `password_env` var for that profile is unset. Fix `.env`.
- `-> InvalidCredentialsError` → **does not reliably mean the password is wrong.** pywinrm
  reports both a genuine bad password *and* a WinRM access-denied/filtered-token 401 with
  the same `InvalidCredentialsError`. Disambiguate with Step 1.

## Step 1 — Is it the password, or the token? (the net use test)

From the collector box (or any box on the network), test raw SMB auth to the admin share:

```
net use \\<ip>\ADMIN$ /user:<ip>\<localadmin> *
```

Read the **error code**, not just the words:

| Result | Meaning | Go to |
|---|---|---|
| Connection succeeds | Password correct **and** admin token is full — WinRM should work too | Step 5 |
| **System error 5** — Access is denied | Password **correct**; logon succeeded but the token was denied admin rights (UAC filtering, or account isn't admin) | Step 2 |
| **System error 1326** — logon failure | Password **wrong** (or account name wrong) | Step 4 |
| **System error 1219** — multiple connections | You already hold a session to this server under another user; it's **per-server** and harmless to the test | see note below |

> **Error 5 is the important one.** It proved on `.30` that the credential was fine and
> the problem was authorization, not authentication — so we stopped chasing the password.

> **Error 1219** is scoped to the one target server; connections to *other* servers are
> irrelevant. You don't need to drop unrelated mapped drives. Either clear only this
> server's session (`net use \\<ip>\IPC$ /delete`, plus `cmdkey /delete:<ip>` if a
> credential is cached), **or just skip net use** — `diag_winrm.py` uses WinRM/HTTP, not
> SMB, so it can never hit 1219. net use is only a convenience check.

## Step 2 — Fix UAC remote-token filtering (the most common cause)

A **local** admin account on a **domain-joined** machine gets a UAC-filtered (standard-user)
token over the network, so WinRM admin ops and `ADMIN$` are denied even though auth
succeeded. The fleet's `70.0/24` subnet is domain-joined, so new PCs there hit this by default.

On the **target machine**, in an **elevated** prompt (the window title must say
*Administrator* — a non-elevated `reg add` to HKLM silently no-ops):

```
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f
```

Verify it actually wrote (must print `0x1`):

```
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v LocalAccountTokenFilterPolicy
```

Takes effect **immediately** — no reboot. For the whole fleet, push this via **GPO**
rather than per-machine. (Alternative to the policy: use a *domain* account that's in the
target's local Administrators group, instead of a local account.)

> Gotcha that bit us: the first `reg add` was run on the wrong box. Always confirm you're
> on the target first with `hostname`, then prove the value exists with `reg query`.

## Step 3 — Confirm the target is actually ready

Run these on the **target** and check all three:

```
hostname                                    # must match the name the collector qualifies with (Step 6)
net localgroup Administrators               # the collector's account must be listed (local-admin)
powershell -c "Get-Service WinRM | Select Status,StartType"   # Running / Automatic
```

If WinRM isn't running / configured: `winrm quickconfig` (elevated) on the target, and make
sure 5985 is reachable (collector discovery probes it; `winrm_port_closed` in the result
means the port was filtered or the service is down).

## Step 4 — Password genuinely wrong (error 1326)

The profile's password in `collector/.env` doesn't match the account on the target.
Reconcile the real local-admin password into the matching `password_env` var
(`PW_WIN10_INFOTECH`, `PW_WIN10_INFOTECH_FALLBACK`, `PW_AD_INFOTECH`, …). You can list
several profiles for the **same account with different passwords**; they're tried in order,
first that authenticates wins (`collector/config.yaml` → `rules[].try`).

## Step 5 — Username qualification (if InvalidCredentials persists with a correct password)

pywinrm's NTLM is picky about the username form:

- **Local account, workgroup machine** → **bare** username (`infotech`). A `.\infotech`
  prefix is sent as NTLM domain `"."` literally and rejected. `config.yaml` uses a bare
  username or `.\name` (stripped defensively by `collect_windows._winrm_username`).
- **Local account, domain-joined machine** → must be **machine-qualified** `HOSTNAME\infotech`,
  or bare resolves against the *domain* and fails. The profile's `qualify: true` does this
  via reverse-DNS (`creds.py` → `_short_hostname`). **That reverse-DNS name must equal the
  target's real computer name** — confirm with `hostname` on the target. A stale PTR record
  → wrong qualifier → `InvalidCredentialsError` regardless of the password. Fix the PTR, or
  the collector can't qualify correctly.
- **Domain account** → `DOMAIN\user` or `user@domain`, left untouched.

## Step 6 — Verify end-to-end

1. `uv run python diag_winrm.py <ip>` → `OK (COMPUTERNAME=...)`.
2. Restart the worker (`uv run python main.py worker`).
3. Trigger a **Scan** for the host (or its subnet) from the app.
4. The asset drawer shows live hardware/health for the matched machine.

---

## Quick reference — net use error codes

| Code | Name | Auth status | Typical fix |
|---|---|---|---|
| 5 | Access is denied | **Succeeded**, token/authz denied | `LocalAccountTokenFilterPolicy=1`; confirm account is local admin |
| 1326 | Logon failure | **Failed** (bad user/password) | Fix `.env` password / username |
| 1219 | Multiple connections | n/a (existing session conflict) | Clear only this server's session, or skip net use (use `diag_winrm.py`) |

## See also

- `collector/AGENTS.md` → *Gotchas* (WinRM local-account auth, bare username, token filter)
- `docs/specs/04-collector-agent-spec.md` — collector architecture
- `collector/diag_winrm.py` — the per-profile auth diagnostic
