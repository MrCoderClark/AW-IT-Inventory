#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$extId = 'idldbjenlmipmpigmfamdlfifkkeaplc'
$updateUrl = 'https://clients2.google.com/service/update2/crx'
$forceEntry = "$extId;$updateUrl"

$settings = @"
{"$extId":{"installation_mode":"force_installed","update_url":"$updateUrl"}}
"@

# --- Chrome ---
$chromePol = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
New-Item -Path $chromePol -Force | Out-Null
New-ItemProperty -Path $chromePol -Name 'ExtensionSettings' -PropertyType String -Value $settings -Force | Out-Null

$chromeForce = "$chromePol\ExtensionInstallForcelist"
New-Item -Path $chromeForce -Force | Out-Null
New-ItemProperty -Path $chromeForce -Name '1' -PropertyType String -Value $forceEntry -Force | Out-Null

# --- Edge ---
$edgePol = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
New-Item -Path $edgePol -Force | Out-Null
# Allow Chrome Web Store extensions in Edge
New-ItemProperty -Path $edgePol -Name 'ControlDefaultStateOfAllowExtensionFromOtherStoresSettingEnabled' -PropertyType DWord -Value 1 -Force | Out-Null
New-ItemProperty -Path $edgePol -Name 'ExtensionSettings' -PropertyType String -Value $settings -Force | Out-Null

$edgeForce = "$edgePol\ExtensionInstallForcelist"
New-Item -Path $edgeForce -Force | Out-Null
New-ItemProperty -Path $edgeForce -Name '1' -PropertyType String -Value $forceEntry -Force | Out-Null

Write-Output "Force-install policy set for Chrome and Edge."
Write-Output "Extension: $extId"
Write-Output ""
Write-Output "Fully quit Chrome and Edge, then reopen."
Write-Output "Verify at chrome://policy or edge://policy -> Reload policies."
