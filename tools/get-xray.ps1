# Downloads the latest Xray-core release (Windows 64-bit) into the xray/ folder.
# Binaries are intentionally not committed to git — run this once after cloning.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$xrayDir = Join-Path $repoRoot "xray"
$zipPath = Join-Path $env:TEMP "xray-windows-64.zip"

Write-Host "Fetching latest Xray-core release info..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/XTLS/Xray-core/releases/latest"
$asset = $release.assets | Where-Object { $_.name -eq "Xray-windows-64.zip" } | Select-Object -First 1
if (-not $asset) { throw "Xray-windows-64.zip not found in the latest release" }

Write-Host "Downloading $($release.tag_name) ..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath

Write-Host "Extracting to $xrayDir ..."
$tmpDir = Join-Path $env:TEMP "xray-extract"
if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
Expand-Archive -Path $zipPath -DestinationPath $tmpDir

New-Item -ItemType Directory -Force -Path $xrayDir | Out-Null
foreach ($f in @("xray.exe", "geoip.dat", "geosite.dat")) {
    Copy-Item (Join-Path $tmpDir $f) (Join-Path $xrayDir $f) -Force
}

Remove-Item $zipPath -Force
Remove-Item -Recurse -Force $tmpDir

Write-Host "Done. Xray $($release.tag_name) installed into xray/"
