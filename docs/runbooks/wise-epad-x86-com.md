# Runbook — Wise (NYC HRA) ePad “Class not registered” (+ related WMI repair)

Commands we used on `192.168.70.16` (Dell OptiPlex `71G3GK2`) when **Wise** (internal
NYC HRA web app) showed **`0x80040154` Class not registered** on **Create new
(Sign Pad)** in Signature Capture, and when H2Tecs inventory scans returned empty
hardware for the same host.

These are **two separate failures** that happened on the same PC:

| Symptom | Root cause | Fix |
|---|---|---|
| Wise Sign Pad → Class not registered | Signature capture needs **32-bit** ePad COM; only **64-bit** was registered | Deploy **x86** ePad into `Program Files (x86)` + `SysWOW64\regsvr32` |
| Inventory drawer blank / collector CIM empty | WMI `Win32_*` classes missing (`Invalid class`) while `winmgmt /verifyrepository` still said “consistent” | `mofcomp cimwin32.mof` + restart WMI |

Chrome extension + SigCaptureWeb SDK alone do **not** fix Wise Sign Pad if it talks
to local COM/ActiveX. OCX spelling is **`gIIEPad.ocx`** (capital **I**, not L).

---

## 1. Wise / ePad — diagnose bitness

On the target (admin PowerShell). Prefer `Registry::…` — remote/WinRM sessions often
have no `HKCR:` drive.

```powershell
dir "C:\Program Files\ePadLink"
dir "C:\Program Files (x86)\ePadLink"
Test-Path "${env:ProgramFiles(x86)}\ePadLink\ePad\gIIEPad.ocx"
Get-ChildItem "${env:ProgramFiles(x86)}\ePadLink\ePad" | Select-Object Name
```

Known ProgID / CLSID for the ActiveX Sign Pad uses:

```powershell
$c = '{30778FC6-EABA-43A7-BA39-6875A3B16057}'
"ProgID: $((Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\GIIEPAD.GIIEPadCtrl.1\CLSID' -EA SilentlyContinue).'(default)')"
"64: $((Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\CLSID\$c\InprocServer32" -EA SilentlyContinue).'(default)')"
"32: $((Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\Wow6432Node\CLSID\$c\InprocServer32" -EA SilentlyContinue).'(default)')"
```

| Result | Meaning |
|---|---|
| **64** → `Program Files\ePadLink\…\gIIEPad.ocx`, **32** empty | Wise Sign Pad will fail (missing Wow6432Node) |
| **32** → `Program Files (x86)\ePadLink\…\gIIEPad.ocx` | 32-bit COM OK — if Sign Pad still fails, look at browser / Wise client config |

From the collector box (optional remote probe):

```powershell
cd D:\Code\aw\aw-inventory\collector
uv run python _diag_epad3.py
```

(Uses WinRM + credential profiles; expects host `192.168.70.16` in that script.)

---

## 2. Wise / ePad — InstallShield companion (`.iss`) for Software Library

Record a response file from the **same** x86 setup EXE you will upload (InstallShield):

```powershell
cd <folder-with-the-x86-epad-exe>
.\UI13.6.12670_setup.exe /r /f1"$PWD\epad-UI13.iss"
```

Walk the UI once; `epad-UI13.iss` appears beside the EXE. Record SDK the same way if
needed (`epadSDK.iss`).

**In Software Library** (install step):

1. Upload the x86 EXE as the installer  
2. Add companion → upload the `.iss`  
3. Silent args — **filename must match the companion exactly**:

```text
/s /f1"%DIR%\epad-UI13.iss" /v"/qn"
```

`%DIR%` is replaced with the on-target temp folder where companions are staged.

### Deploy exit `4294967293` (= signed **-3**)

InstallShield: required data not found in the Setup.iss file — almost always a
**silent-args / companion name mismatch**, not “must uninstall x64 first.”

x64 under `Program Files` and x86 under `Program Files (x86)` can coexist. Example
that failed for us: silent args asked for `epad.iss` while the companion was
`epad-UI13.iss`.

---

## 3. Wise / ePad — register 32-bit COM

After x86 files exist under `Program Files (x86)\ePadLink\ePad`, register with
**SysWOW64** `regsvr32` (32-bit). Run as **one line** if the remote shell drops
variables between prompts:

```powershell
$reg = "$env:SystemRoot\SysWOW64\regsvr32.exe"; $dir = "${env:ProgramFiles(x86)}\ePadLink\ePad"; foreach ($f in @('gIIEPad.ocx','EpadInk.ocx','IePadEnum.dll','ePadIIu.dll','iewedgeu.dll')) { $p = Join-Path $dir $f; if (Test-Path -LiteralPath $p) { & $reg /s $p; Write-Output "$f => exit $LASTEXITCODE" } else { Write-Output "$f => missing" } }; $c = '{30778FC6-EABA-43A7-BA39-6875A3B16057}'; Write-Output ("32: " + ((Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\Wow6432Node\CLSID\$c\InprocServer32" -EA SilentlyContinue).'(default)'))
```

Success looks like:

```text
gIIEPad.ocx => exit 0
EpadInk.ocx => exit 0
IePadEnum.dll => exit 0
ePadIIu.dll => exit 0
iewedgeu.dll => exit 0
32: C:\Program Files (x86)\ePadLink\ePad\gIIEPad.ocx
```

Then retry Wise **Create new (Sign Pad)**.

**Do not** use `System32\regsvr32` against the x86 OCX when you need Wow6432Node —
use `SysWOW64\regsvr32`. Registering an x64 OCX with SysWOW64 will fail; install the
real x86 bits first.

Optional (if you only have x64 under Program Files and want to try — usually fails
for the Sign Pad path):

```cmd
"%SystemRoot%\System32\regsvr32.exe" "C:\Program Files\ePadLink\ePad\gIIEPad.ocx"
"%SystemRoot%\SysWOW64\regsvr32.exe" "C:\Program Files\ePadLink\ePad\gIIEPad.ocx"
```

---

## 4. WMI / inventory — diagnose and repair (same host, separate issue)

Confirm CIM is broken (admin PowerShell on the PC or over WinRM):

```powershell
Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
Get-CimClass -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
Get-CimClass -Namespace root/cimv2 -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
dir $env:SystemRoot\System32\wbem\cimwin32.dll
winmgmt /verifyrepository
```

“WMI repository is consistent” does **not** mean classes exist — you can still get
`Invalid class` on `Win32_ComputerSystem`.

### Repair Win32 provider MOFs

**PowerShell:**

```powershell
cd "$env:SystemRoot\System32\wbem"
mofcomp cimwin32.mof
mofcomp cimwin32.mfl
net stop winmgmt /y
net start winmgmt
net start iphlpsvc
Get-CimInstance Win32_ComputerSystem | Select DNSHostName, Manufacturer, Model
```

**cmd** (if `$env:SystemRoot` fails — you’re not in PowerShell):

```cmd
cd %SystemRoot%\System32\wbem
mofcomp cimwin32.mof
mofcomp cimwin32.mfl
net stop winmgmt /y
net start winmgmt
net start iphlpsvc
```

`cimwin32.mfl` missing (“File not found”) is often fine on English Windows — the
`.mof` is what matters. Stopping `winmgmt` also stops **IP Helper**; start it again
with `net start iphlpsvc`.

Heavier last resorts (only if mofcomp doesn’t restore the class):

```powershell
winmgmt /salvagerepository
winmgmt /resetrepository
```

DISM/SFC only if Windows is generally broken — they won’t register ePad COM.

### Re-scan after WMI works

```powershell
cd D:\Code\aw\aw-inventory\collector
uv run python main.py scan --target 192.168.70.16/32 --ingest
```

---

## 5. Quick checklist (Wise Sign Pad still broken)

1. `Program Files (x86)\ePadLink\ePad\gIIEPad.ocx` exists  
2. Wow6432Node `InprocServer32` for `{30778FC6-EABA-43A7-BA39-6875A3B16057}` points at that path  
3. Pad plugged in; Generic ePad Test Program works  
4. Browser / Wise restarted after registration  
5. If COM is good and Sign Pad still fails → Wise/browser config, not missing x86 COM  
