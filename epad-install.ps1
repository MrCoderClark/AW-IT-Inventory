#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$WorkDir = Join-Path $env:TEMP ("h2tecs-export-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Write-Host "Work directory: $WorkDir"
Write-Host 'Downloading package files...'
$ProgressPreference = 'SilentlyContinue'
$__wc = New-Object System.Net.WebClient
$__out = Join-Path $WorkDir 'UI13.6.12670_setup.exe'
Write-Host ('  ' + 'UI13.6.12670_setup.exe')
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  & curl.exe -fsSL --retry 3 -o $__out 'https://huggingface.co/buckets/MrCoderClark/Apps/resolve/UI13.6.12670_setup.exe?download=true'
  if ($LASTEXITCODE -ne 0) { throw "download failed: UI13.6.12670_setup.exe" }
} else {
  $__wc.DownloadFile('https://huggingface.co/buckets/MrCoderClark/Apps/resolve/UI13.6.12670_setup.exe?download=true', $__out)
}
$__out = Join-Path $WorkDir 'epad-UI13.iss'
Write-Host ('  ' + 'epad-UI13.iss')
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  & curl.exe -fsSL --retry 3 -o $__out 'https://huggingface.co/buckets/MrCoderClark/Apps/resolve/epad-UI13-uninstall.iss?download=true'
  if ($LASTEXITCODE -ne 0) { throw "download failed: epad-UI13.iss" }
} else {
  $__wc.DownloadFile('https://huggingface.co/buckets/MrCoderClark/Apps/resolve/epad-UI13-uninstall.iss?download=true', $__out)
}
$__out = Join-Path $WorkDir 'SigCaptureWebSDK.exe'
Write-Host ('  ' + 'SigCaptureWebSDK.exe')
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  & curl.exe -fsSL --retry 3 -o $__out 'https://huggingface.co/buckets/MrCoderClark/Apps/resolve/SigCaptureWebSDK.exe?download=true'
  if ($LASTEXITCODE -ne 0) { throw "download failed: SigCaptureWebSDK.exe" }
} else {
  $__wc.DownloadFile('https://huggingface.co/buckets/MrCoderClark/Apps/resolve/SigCaptureWebSDK.exe?download=true', $__out)
}
$__out = Join-Path $WorkDir 'epadSDK.iss'
Write-Host ('  ' + 'epadSDK.iss')
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  & curl.exe -fsSL --retry 3 -o $__out 'https://huggingface.co/buckets/MrCoderClark/Apps/resolve/epadSDK-uninstall.iss?download=true'
  if ($LASTEXITCODE -ne 0) { throw "download failed: epadSDK.iss" }
} else {
  $__wc.DownloadFile('https://huggingface.co/buckets/MrCoderClark/Apps/resolve/epadSDK-uninstall.iss?download=true', $__out)
}
$__wc.Dispose()

Write-Host 'Step: Enable .NET3.5'
$__script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('JHN0YXRlID0gKEdldC1XaW5kb3dzT3B0aW9uYWxGZWF0dXJlIC1PbmxpbmUgLUZlYXR1cmVOYW1lIE5ldEZ4MykuU3RhdGUKCmlmICgkc3RhdGUgLW5lICdFbmFibGVkJykgewogICAgRW5hYmxlLVdpbmRvd3NPcHRpb25hbEZlYXR1cmUgLU9ubGluZSAtRmVhdHVyZU5hbWUgTmV0RngzIC1BbGwgLU5vUmVzdGFydAp9IGVsc2UgewogICAgV3JpdGUtT3V0cHV0ICIuTkVUIEZyYW1ld29yayAzLjUgaXMgYWxyZWFkeSBlbmFibGVkLiIKfQ=='))
[IO.File]::WriteAllText((Join-Path $WorkDir 'c47d39ef-71c3-4258-a46a-bbadfc5cff50.ps1'), $__script, (New-Object System.Text.UTF8Encoding $true))
$ProgressPreference = 'SilentlyContinue'
& (Join-Path $WorkDir 'c47d39ef-71c3-4258-a46a-bbadfc5cff50.ps1')
$__exit = $LASTEXITCODE
if ($__exit -ne 0) {
  Write-Error "Step failed: Enable .NET3.5 (exit $__exit)"
  exit 1
}

Write-Host 'Step: Uninstall ePad'
$__script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('JGZvdW5kID0gJGZhbHNlCiAgJHJlZ1BhdGhzID0gQCgKICAgICAgJ0hLTE06XFNPRlRXQVJFXE1pY3Jvc29mdFxXaW5kb3dzXEN1cnJlbnRWZXJzaW9uXFVuaW5zdGFsbCcsCiAgICAgICdIS0xNOlxTT0ZUV0FSRVxXT1c2NDMyTm9kZVxNaWNyb3NvZnRcV2luZG93c1xDdXJyZW50VmVyc2lvblxVbmluc3RhbGwnCiAgKQoKICBmb3JlYWNoICgkcnAgaW4gJHJlZ1BhdGhzKSB7CiAgICAgIGZvcmVhY2ggKCRrZXkgaW4gKEdldC1DaGlsZEl0ZW0gJHJwIC1FQSBTaWxlbnRseUNvbnRpbnVlKSkgewogICAgICAgICAgJHByb3BzID0gR2V0LUl0ZW1Qcm9wZXJ0eSAka2V5LlBTUGF0aCAtRUEgU2lsZW50bHlDb250aW51ZQogICAgICAgICAgaWYgKCRwcm9wcy5EaXNwbGF5TmFtZSAtbGlrZSAnZVBhZExpbmsqJykgewogICAgICAgICAgICAgICRmb3VuZCA9ICR0cnVlCiAgICAgICAgICAgICAgJHVzID0gJHByb3BzLlVuaW5zdGFsbFN0cmluZwogICAgICAgICAgICAgIFdyaXRlLU91dHB1dCAiRm91bmQ6ICQoJHByb3BzLkRpc3BsYXlOYW1lKSAkKCRwcm9wcy5EaXNwbGF5VmVyc2lvbikiCiAgICAgICAgICAgICAgaWYgKCR1cyAtbWF0Y2ggJ21zaWV4ZWMnKSB7CiAgICAgICAgICAgICAgICAgICRtID0gW3JlZ2V4XTo6TWF0Y2goJHVzLCAnW3tdWzAtOUEtRmEtZi1dK1t9XScpCiAgICAgICAgICAgICAgICAgIGlmICgkbS5TdWNjZXNzKSB7CiAgICAgICAgICAgICAgICAgICAgICBXcml0ZS1PdXRwdXQgIk1TSSByZW1vdmUgJCgkbS5WYWx1ZSkiCiAgICAgICAgICAgICAgICAgICAgICBtc2lleGVjIC94ICRtLlZhbHVlIC9xbiAvbm9yZXN0YXJ0IHwgT3V0LU51bGwKICAgICAgICAgICAgICAgICAgICAgIFdyaXRlLU91dHB1dCAibXNpZXhlYyBleGl0OiAkTEFTVEVYSVRDT0RFIgogICAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgfQogICAgICAgICAgICAgIFdyaXRlLU91dHB1dCAiUmVtb3ZpbmcgcmVnaXN0cnkga2V5OiAkKCRrZXkuUFNQYXRoKSIKICAgICAgICAgICAgICBSZW1vdmUtSXRlbSAka2V5LlBTUGF0aCAtRm9yY2UgLUVBIFNpbGVudGx5Q29udGludWUKICAgICAgICAgIH0KICAgICAgfQogIH0KCiAgaWYgKC1ub3QgJGZvdW5kKSB7IFdyaXRlLU91dHB1dCAiTm8gZVBhZExpbmsgaW5zdGFsbGVkLiIgfQoKICBpZiAoVGVzdC1QYXRoICdDOlxQcm9ncmFtIEZpbGVzICh4ODYpXGVQYWRMaW5rJykgewogICAgICBXcml0ZS1PdXRwdXQgIlJlbW92aW5nIHg4NiBlUGFkTGluayBmb2xkZXIiCiAgICAgIFJlbW92ZS1JdGVtICdDOlxQcm9ncmFtIEZpbGVzICh4ODYpXGVQYWRMaW5rJyAtUmVjdXJzZSAtRm9yY2UgLUVBIFNpbGVudGx5Q29udGludWUKICB9CiAgaWYgKFRlc3QtUGF0aCAnQzpcUHJvZ3JhbSBGaWxlc1xlUGFkTGluaycpIHsKICAgICAgV3JpdGUtT3V0cHV0ICJSZW1vdmluZyB4NjQgZVBhZExpbmsgZm9sZGVyIgogICAgICBSZW1vdmUtSXRlbSAnQzpcUHJvZ3JhbSBGaWxlc1xlUGFkTGluaycgLVJlY3Vyc2UgLUZvcmNlIC1FQSBTaWxlbnRseUNvbnRpbnVlCiAgfQoKICAkaXNCYXNlID0gJ0M6XFByb2dyYW0gRmlsZXMgKHg4NilcSW5zdGFsbFNoaWVsZCBJbnN0YWxsYXRpb24gSW5mb3JtYXRpb24nCiAgaWYgKFRlc3QtUGF0aCAkaXNCYXNlKSB7CiAgICAgIGZvcmVhY2ggKCRkaXIgaW4gKEdldC1DaGlsZEl0ZW0gJGlzQmFzZSAtRGlyZWN0b3J5IC1FQSBTaWxlbnRseUNvbnRpbnVlKSkgewogICAgICAgICAgJGluaSA9IEpvaW4tUGF0aCAkZGlyLkZ1bGxOYW1lICdzZXR1cC5pbmknCiAgICAgICAgICBpZiAoKFRlc3QtUGF0aCAkaW5pKSAtYW5kICgoR2V0LUNvbnRlbnQgJGluaSAtUmF3KSAtbWF0Y2ggJ2VQYWQnKSkgewogICAgICAgICAgICAgIFdyaXRlLU91dHB1dCAiUmVtb3ZpbmcgSVMgZm9sZGVyOiAkKCRkaXIuTmFtZSkiCiAgICAgICAgICAgICAgUmVtb3ZlLUl0ZW0gJGRpci5GdWxsTmFtZSAtUmVjdXJzZSAtRm9yY2UgLUVBIFNpbGVudGx5Q29udGludWUKICAgICAgICAgIH0KICAgICAgfQogIH0KCiAgV3JpdGUtT3V0cHV0ICJDbGVhbnVwIGRvbmUuIg=='))
[IO.File]::WriteAllText((Join-Path $WorkDir '0850eb52-066a-4d78-b532-d723214f6510.ps1'), $__script, (New-Object System.Text.UTF8Encoding $true))
$ProgressPreference = 'SilentlyContinue'
& (Join-Path $WorkDir '0850eb52-066a-4d78-b532-d723214f6510.ps1')
$__exit = $LASTEXITCODE
if ($__exit -ne 0) {
  Write-Error "Step failed: Uninstall ePad (exit $__exit)"
  exit 1
}

Write-Host 'Step: UI13.6.12670_setup.exe'
$__cmd = "`"$WorkDir\UI13.6.12670_setup.exe`" /s /f1`"$WorkDir\epad-UI13.iss`" /v`"/qn`""
$__bat = Join-Path $WorkDir 'h2tecs_run.cmd'
[IO.File]::WriteAllText($__bat, "@echo off`r`n$__cmd`r`n")
cmd.exe /c $__bat
$__exit = $LASTEXITCODE
if ($__exit -ne 0 -and $__exit -ne 3010) {
  Write-Error "Step failed: UI13.6.12670_setup.exe (exit $__exit)"
  exit 1
}

Write-Host 'Step: SigCaptureWebSDK.exe'
$__cmd = "`"$WorkDir\SigCaptureWebSDK.exe`" /s /f1`"$WorkDir\epadSDK.iss`" /v`"/qn`""
$__bat = Join-Path $WorkDir 'h2tecs_run.cmd'
[IO.File]::WriteAllText($__bat, "@echo off`r`n$__cmd`r`n")
cmd.exe /c $__bat
$__exit = $LASTEXITCODE
if ($__exit -ne 0 -and $__exit -ne 3010) {
  Write-Error "Step failed: SigCaptureWebSDK.exe (exit $__exit)"
  exit 1
}

Write-Host 'Step: Chrome ePadLink Extension'
$__script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('JEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICdTdG9wJwokZXh0SWQgPSAnaWRsZGJqZW5sbWlwbXBpZ21mYW1kbGZpZmtrZWFwbGMnCiR1cGRhdGVVcmwgPSAnaHR0cHM6Ly9jbGllbnRzMi5nb29nbGUuY29tL3NlcnZpY2UvdXBkYXRlMi9jcngnCgokc2V0dGluZ3MgPSBAIgp7IiRleHRJZCI6eyJpbnN0YWxsYXRpb25fbW9kZSI6Im5vcm1hbF9pbnN0YWxsZWQiLCJ1cGRhdGVfdXJsIjoiJHVwZGF0ZVVybCJ9fQoiQAoKIyAtLS0gQ2hyb21lIC0tLQpSZW1vdmUtSXRlbSAtUGF0aCAnSEtMTTpcU09GVFdBUkVcUG9saWNpZXNcR29vZ2xlXENocm9tZVxFeHRlbnNpb25JbnN0YWxsRm9yY2VsaXN0JyAtUmVjdXJzZSAtRm9yY2UgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUKCiRjaHJvbWVQb2wgPSAnSEtMTTpcU09GVFdBUkVcUG9saWNpZXNcR29vZ2xlXENocm9tZScKTmV3LUl0ZW0gLVBhdGggJGNocm9tZVBvbCAtRm9yY2UgfCBPdXQtTnVsbAoKTmV3LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkY2hyb21lUG9sIC1OYW1lICdFeHRlbnNpb25TZXR0aW5ncycgLVByb3BlcnR5VHlwZSBTdHJpbmcgLVZhbHVlICRzZXR0aW5ncyAtRm9yY2UgfCBPdXQtTnVsbAoKIyAtLS0gRWRnZSAoc2FtZSBDaHJvbWUgV2ViIFN0b3JlIGV4dGVuc2lvbikgLS0tClJlbW92ZS1JdGVtIC1QYXRoICdIS0xNOlxTT0ZUV0FSRVxQb2xpY2llc1xNaWNyb3NvZnRcRWRnZVxFeHRlbnNpb25JbnN0YWxsRm9yY2VsaXN0JyAtUmVjdXJzZSAtRm9yY2UgLUVycm9yQWN0aW9uIFNpbGVudGx5Q29udGludWUKCiRlZGdlUG9sID0gJ0hLTE06XFNPRlRXQVJFXFBvbGljaWVzXE1pY3Jvc29mdFxFZGdlJwpOZXctSXRlbSAtUGF0aCAkZWRnZVBvbCAtRm9yY2UgfCBPdXQtTnVsbAoKTmV3LUl0ZW1Qcm9wZXJ0eSAtUGF0aCAkZWRnZVBvbCAtTmFtZSAnRXh0ZW5zaW9uU2V0dGluZ3MnIC1Qcm9wZXJ0eVR5cGUgU3RyaW5nIC1WYWx1ZSAkc2V0dGluZ3MgLUZvcmNlIHwgT3V0LU51bGwKCldyaXRlLU91dHB1dCAiRXh0ZW5zaW9uU2V0dGluZ3M9JHNldHRpbmdzIgpXcml0ZS1PdXRwdXQgJ0Z1bGx5IHF1aXQgQ2hyb21lIGFuZCBFZGdlLCB0aGVuOicKV3JpdGUtT3V0cHV0ICcgIGNocm9tZTovL3BvbGljeSDihpIgUmVsb2FkIHBvbGljaWVzJwpXcml0ZS1PdXRwdXQgJyAgZWRnZTovL3BvbGljeSDihpIgUmVsb2FkIHBvbGljaWVzJwpXcml0ZS1PdXRwdXQgJ0lmIGFuIGV4dGVuc2lvbiBzdGlsbCBzaG93cyBsb2NrZWQsIHJlbW92ZSBpdCBvbmNlIGFuZCByZW9wZW4gdGhlIGJyb3dzZXIgKG1heSB0YWtlIGEgbWludXRlIHRvIHJlYXBwZWFyKS4n'))
[IO.File]::WriteAllText((Join-Path $WorkDir '8a2f4cc3-f1d5-4555-8126-dc1705ede18f.ps1'), $__script, (New-Object System.Text.UTF8Encoding $true))
$ProgressPreference = 'SilentlyContinue'
& (Join-Path $WorkDir '8a2f4cc3-f1d5-4555-8126-dc1705ede18f.ps1')
$__exit = $LASTEXITCODE
if ($__exit -ne 0) {
  Write-Error "Step failed: Chrome ePadLink Extension (exit $__exit)"
  exit 1
}

Write-Host 'Package completed successfully.'