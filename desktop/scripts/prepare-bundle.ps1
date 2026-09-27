<#
.SYNOPSIS
  Stages the bundled Node runtime and the Socha Diff web app for the desktop host.

.DESCRIPTION
  Produces desktop/bundle/ (git-ignored), which SochaDiff.Desktop.csproj includes
  as content so it is copied to the build output and published by ClickOnce:

    bundle/node/node.exe          portable Node (version pinned in desktop/node-pin.json)
    bundle/node/LICENSE
    bundle/app/server.js, lib/, public/, package.json, package-lock.json
    bundle/app/node_modules/      production dependencies (npm ci --omit=dev)
    bundle/bundle-info.json       what was staged (Node version, git commit, time)

  The Node zip is downloaded from nodejs.org once into desktop/.cache/ and its
  SHA256 must match both the pinned hash and the official SHASUMS256.txt entry.
  npm ci runs with the pinned Node's own npm, so no system Node is required.

.EXAMPLE
  pwsh desktop/scripts/prepare-bundle.ps1
#>
[CmdletBinding()]
param(
  # Re-download the Node zip even if a verified copy is cached.
  [switch]$RefreshNode
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much faster without the progress bar

$desktopDir = Split-Path -Parent $PSScriptRoot
$repoRoot   = Split-Path -Parent $desktopDir
$pin        = Get-Content (Join-Path $desktopDir 'node-pin.json') -Raw | ConvertFrom-Json
$cacheDir   = Join-Path $desktopDir '.cache'
$bundleDir  = Join-Path $desktopDir 'bundle'
$zipPath    = Join-Path $cacheDir $pin.file
$baseUrl    = "https://nodejs.org/dist/v$($pin.version)"

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

# 1. Pinned hash must match the official SHASUMS256.txt entry.
Write-Host "Node v$($pin.version): checking SHASUMS256.txt"
$shasums = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt").Content
if ($shasums -is [byte[]]) { $shasums = [Text.Encoding]::UTF8.GetString($shasums) }
$line = ($shasums -split "`n") | Where-Object { $_ -match "^\s*([0-9a-f]{64})\s+$([regex]::Escape($pin.file))\s*$" } | Select-Object -First 1
if (-not $line) { throw "$($pin.file) is not listed in $baseUrl/SHASUMS256.txt" }
$officialHash = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
if ($officialHash -ne $pin.sha256.ToLowerInvariant()) {
  throw "Pinned sha256 ($($pin.sha256)) does not match SHASUMS256.txt ($officialHash) for $($pin.file)"
}

# 2. Download (or reuse the cached zip) and verify it.
if ($RefreshNode -or -not (Test-Path $zipPath) -or (Get-Sha256 $zipPath) -ne $officialHash) {
  Write-Host "Downloading $baseUrl/$($pin.file)"
  $tmp = "$zipPath.download"
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$($pin.file)" -OutFile $tmp
  $actual = Get-Sha256 $tmp
  if ($actual -ne $officialHash) {
    Remove-Item $tmp -Force
    throw "SHA256 mismatch for $($pin.file): expected $officialHash, got $actual"
  }
  Move-Item -Force $tmp $zipPath
}
Write-Host "Verified $($pin.file) sha256 $officialHash"

# 3. Extract the full Node distribution to the cache (npm is used from here).
$nodeDist = Join-Path $cacheDir ([IO.Path]::GetFileNameWithoutExtension($pin.file))
if (-not (Test-Path (Join-Path $nodeDist 'node.exe'))) {
  Write-Host "Extracting $($pin.file)"
  if (Test-Path $nodeDist) { Remove-Item -Recurse -Force $nodeDist }
  Expand-Archive -LiteralPath $zipPath -DestinationPath $cacheDir -Force
}

# 4. Fresh bundle folder.
if (Test-Path $bundleDir) { Remove-Item -Recurse -Force $bundleDir }
$nodeOut = Join-Path $bundleDir 'node'
$appOut  = Join-Path $bundleDir 'app'
New-Item -ItemType Directory -Force -Path $nodeOut, $appOut | Out-Null

Copy-Item (Join-Path $nodeDist 'node.exe') $nodeOut
Copy-Item (Join-Path $nodeDist 'LICENSE') $nodeOut

foreach ($f in 'server.js', 'package.json', 'package-lock.json') { Copy-Item (Join-Path $repoRoot $f) $appOut }
foreach ($d in 'lib', 'public') { Copy-Item -Recurse (Join-Path $repoRoot $d) (Join-Path $appOut $d) }

# 5. Production dependencies with the pinned Node's npm.
Write-Host "npm ci --omit=dev (Node v$($pin.version))"
$npmCli = Join-Path $nodeDist 'node_modules\npm\bin\npm-cli.js'
Push-Location $appOut
try {
  & (Join-Path $nodeDist 'node.exe') $npmCli ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
# Drop dot-entries (.bin shims, .package-lock.json, .github, lint configs):
# unused at runtime and awkward for ClickOnce manifests.
Get-ChildItem -LiteralPath (Join-Path $appOut 'node_modules') -Recurse -Force -Filter '.*' |
  Sort-Object { $_.FullName.Length } -Descending |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 6. Record what was staged.
$commit = ''
try { $commit = (git -C $repoRoot rev-parse --short HEAD 2>$null) } catch { }
$dirty = $false
try { $dirty = [bool](git -C $repoRoot status --porcelain -- server.js lib public package.json package-lock.json 2>$null) } catch { }
[ordered]@{
  nodeVersion = $pin.version
  nodeSha256  = $officialHash
  appCommit   = $commit
  appDirty    = $dirty
  preparedAt  = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $bundleDir 'bundle-info.json')

$count = (Get-ChildItem -Recurse -File $bundleDir).Count
Write-Host "Bundle ready: $bundleDir ($count files)"
