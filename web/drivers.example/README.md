# Driver packages (spec 20)

Remote printer install reads driver packages from the directory named by
`PRINTER_DRIVERS_DIR` (default `web/drivers/`). This folder is a **committed
example** of the format; the real packages live in `web/drivers/` (gitignored).

## Layout

One subfolder per package; **the folder name is the package `id`** (it must be a
single safe path segment: `^[A-Za-z0-9][A-Za-z0-9_-]*$` — mixed case is fine, so
a vendor folder like `Canon-imageFORCE-520` works as-is). Each holds a
`package.json` manifest and the driver files (including the INF):

```
drivers/
  canon-ir1750-v21/
    package.json
    driver/
      CNLB0MA64.INF
      ...
```

## Manifest (`package.json`)

| Field | Required | Notes |
|---|---|---|
| `id` | no | Ignored — the folder name is always the id. Safe to omit. |
| `name` | yes | Shown in the install picker. |
| `vendor`, `model` | no | Picker metadata. |
| `driverName` | yes | **The exact Windows driver model name published by the INF** — what `Add-Printer -DriverName` expects. A mismatch is the most common failure. |
| `infPath` | yes | Path to the INF relative to the package folder. |
| `arch` | no | `x64` (default). |
| `connection` | no | Default connection: `{ "type": "tcpip", "port": 9100 }`, `{ "type": "wsd" }`, or `{ "type": "share", "sharePath": "\\\\server\\queue" }`. `host` is usually supplied at install time. |
| `defaultPrinterName` | no | Suggested printer name. |

Integrity is a content hash over the package's file tree, frozen onto each job at
enqueue; editing a package after a job is queued never changes that job.
