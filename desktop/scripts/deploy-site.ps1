<#
.SYNOPSIS
  Deploys an assembled site folder (publish-site.ps1 output) into the IIS content root of
  https://sochadiff.socha3.com/ on the local machine (or a UNC path).

.DESCRIPTION
  Used by the `deploy` job of .github/workflows/publish-desktop.yml, which runs on the
  self-hosted runner on the web server, and for manual deploys. Runs on Windows PowerShell 5.1
  and PowerShell 7.

    1. Checks the source: SochaDiff.application, version.json, index.html, web.config,
       setup.exe and "Application Files\SochaDiff_a_b_c_d" must exist and agree on the version.
    2. Version guard: refuses a version that is not newer than the live one (the target's
       version.json, and <SiteUrl>/version.json), unless -Force.
    3. Backs up the current content root to <BackupRoot>\<yyyyMMdd-HHmmss>-<live version>
       (default BackupRoot C:\WebApps\_deploy-backups\SochaDiff, a folder for this site only;
       it is created if missing) and keeps only the newest -KeepBackups backups. Pruning only
       looks at the direct subfolders of BackupRoot whose names match exactly what this script
       creates (yyyyMMdd-HHmmss-<a.b[.c[.d]]> or yyyyMMdd-HHmmss-unknown) and never follows
       junctions/symlinks; anything else in BackupRoot is left alone.
    4. Copies WITHOUT deleting anything on the server (no /MIR, no /PURGE): old
       "Application Files\SochaDiff_*" folders stay for clients that are mid-update, and an
       existing web.config is only ever overwritten by the new one, never removed.
       Phase 1: every folder and every root file except SochaDiff.application, version.json
       and index.html (web.config and setup.exe included). Phase 2: SochaDiff.application, then
       version.json and index.html, each written to a temporary name and swapped in, so a client
       never sees a manifest that points at files that are not there yet.
       robocopy exit codes 0-7 are success, 8 and above are failures.
    5. -Verify: requests <SiteUrl>/version.json and /SochaDiff.application with a cache-busting
       query string. Expects the new version, HTTP 200 and Content-Type
       application/x-ms-application. If the response is an outdated copy served from the
       Cloudflare cache (CF-Cache-Status HIT/STALE/UPDATING/REVALIDATED) it only warns; if the
       origin itself serves the wrong thing, it fails.
    6. Writes a summary to $env:GITHUB_STEP_SUMMARY when present.

  Prune very old "Application Files\SochaDiff_*" folders by hand now and then.

.EXAMPLE
  powershell -File desktop/scripts/deploy-site.ps1 -Source desktop/out/site -Verify
.EXAMPLE
  pwsh desktop/scripts/deploy-site.ps1 -Source .\site-out -TargetPath \\web1\c$\WebApps\SochaDiff -SkipBackup
#>
[CmdletBinding()]
param(
  # The assembled site (desktop/out/site or the downloaded CI artifact).
  [Parameter(Mandatory)] [string]$Source,
  # The IIS site's physical path (local or UNC). Must already exist.
  [string]$TargetPath = 'C:\WebApps\SochaDiff',
  # Backups of the content root go into <BackupRoot>\<yyyyMMdd-HHmmss>-<live version>. The folder
  # is this site's own (created if missing); the runner account only needs Modify on it.
  [string]$BackupRoot = 'C:\WebApps\_deploy-backups\SochaDiff',
  [ValidateRange(1, 100)] [int]$KeepBackups = 5,
  [switch]$SkipBackup,
  # Public URL of the site root (version guard and verification).
  [string]$SiteUrl = 'https://sochadiff.socha3.com/',
  # Optional: the version the caller expects in Source (CI passes the build's version).
  [string]$ExpectedVersion,
  # Deploy even if the live site already has the same or a newer version.
  [switch]$Force,
  # Check the live site after copying.
  [switch]$Verify,
  [ValidateRange(1, 30)] [int]$VerifyAttempts = 6,
  [ValidateRange(0, 120)] [int]$VerifyDelaySeconds = 10
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($PSVersionTable.PSVersion.Major -lt 6) {
  # Windows PowerShell 5.1 on older servers may not offer TLS 1.2 by default.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$manifestName = 'SochaDiff.application'
$lastFiles = @($manifestName, 'version.json', 'index.html')   # phase 2, in this order
$siteBase = $SiteUrl.TrimEnd('/') + '/'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$summary = New-Object System.Collections.Generic.List[string]
$failures = New-Object System.Collections.Generic.List[string]

function Add-Summary([string]$Line) { $summary.Add($Line) }

function Write-DeployWarning([string]$Message) {
  if ($env:GITHUB_ACTIONS -eq 'true') { Write-Host "::warning::$Message" } else { Write-Warning $Message }
  Add-Summary "- WARNING: $Message"
}

function Write-StepSummary {
  if (-not $env:GITHUB_STEP_SUMMARY) { return }
  [IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, (($summary -join "`n") + "`n"), $utf8)
}

function ConvertTo-AppVersion([string]$Json) {
  # applicationVersion from a version.json text, or $null.
  if (-not $Json) { return $null }
  $obj = $Json.TrimStart([char]0xFEFF) | ConvertFrom-Json
  if ($obj.applicationVersion) { return [version]$obj.applicationVersion }
  return $null
}

function Get-ManifestVersion([string]$Xml) {
  # The first assemblyIdentity of a deployment manifest is the deployment's own identity.
  $m = [regex]::Match($Xml, '<assemblyIdentity\b[^>]*?\sversion="([0-9.]+)"')
  if ($m.Success) { return [version]$m.Groups[1].Value }
  return $null
}

function Get-HeaderValue($Response, [string]$Name) {
  foreach ($key in @($Response.Headers.Keys)) {
    if ($key -ieq $Name) { return (@($Response.Headers[$key]) -join ', ') }
  }
  return ''
}

function Invoke-SiteProbe([string]$RelativePath) {
  # GET <SiteUrl><RelativePath>?deploycheck=<random> (the query string bypasses the Cloudflare
  # cache unless the zone ignores query strings; IIS ignores it for static files).
  $uri = $siteBase + $RelativePath + '?deploycheck=' + [guid]::NewGuid().ToString('N')
  $result = [ordered]@{ Uri = $uri; Status = 0; ContentType = ''; CacheStatus = ''; Body = ''; Error = '' }
  try {
    $resp = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 30 -UserAgent 'SochaDiff-deploy-check' `
      -Headers @{ 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache' }
    $result.Status = [int]$resp.StatusCode
    $result.ContentType = Get-HeaderValue $resp 'Content-Type'
    $result.CacheStatus = Get-HeaderValue $resp 'CF-Cache-Status'
    $body = $resp.Content
    if ($body -is [byte[]]) { $body = [Text.Encoding]::UTF8.GetString($body) }
    $result.Body = [string]$body
  } catch {
    $ex = $_.Exception
    if ($ex.Response) { try { $result.Status = [int]$ex.Response.StatusCode } catch { } }
    $result.Error = $ex.Message
  }
  return [pscustomobject]$result
}

function Test-FromCache($Probe) {
  return @('HIT', 'STALE', 'UPDATING', 'REVALIDATED') -contains ($Probe.CacheStatus.ToUpperInvariant())
}

function Invoke-Robocopy([string]$From, [string]$To, [string[]]$Arguments, [string]$What) {
  # No /MIR and no /PURGE anywhere: robocopy only adds and overwrites files.
  $all = @($From, $To) + $Arguments + @('/R:3', '/W:5', '/XJ', '/NP', '/NFL', '/NDL', '/NJH')
  Write-Host "robocopy ($What): $From -> $To"
  & robocopy @all | ForEach-Object { if ("$_".Trim()) { Write-Host "  $_" } }
  $code = $LASTEXITCODE
  $global:LASTEXITCODE = 0
  # 0 = nothing to copy, 1 = copied, 2/4 = extra/mismatched files at the target, combinations up
  # to 7 are all success. 8 and above: some files could not be copied, or a fatal error.
  if ($code -ge 8) { throw "robocopy ($What) failed with exit code $code." }
  Write-Host "robocopy ($What) exit code $code (0-7 = success)"
}

function Copy-FileLast([string]$Name) {
  # Write to a temporary name next to the target, then swap it in, so the file is never seen
  # half-written. (IIS answers 404 for the unknown .deploying extension.)
  $from = Join-Path $Source $Name
  $to = Join-Path $TargetPath $Name
  $tmp = "$to.deploying"
  Copy-Item -LiteralPath $from -Destination $tmp -Force
  try {
    if (Test-Path -LiteralPath $to) { [IO.File]::Replace($tmp, $to, [NullString]::Value) }
    else { [IO.File]::Move($tmp, $to) }
  } catch {
    Write-Host "Swapping in $Name failed ($($_.Exception.Message)); copying in place."
    Copy-Item -LiteralPath $from -Destination $to -Force
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Copied $Name"
}

# Exactly the folder names this script creates: <yyyyMMdd-HHmmss>-<live version or 'unknown'>.
$backupNamePattern = '^\d{8}-\d{6}-(\d+(\.\d+){1,3}|unknown)$'

function Remove-OldBackups {
  # Only direct subfolders of BackupRoot with this script's own name pattern, never reparse
  # points (a junction's target must not be deleted), newest first by name (= by time).
  $all = @(Get-ChildItem -LiteralPath $BackupRoot -Directory -Force |
    Where-Object { $_.Name -match $backupNamePattern -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
    Sort-Object Name -Descending)
  foreach ($dir in @($all | Select-Object -Skip $KeepBackups)) {
    try {
      Remove-Item -LiteralPath $dir.FullName -Recurse -Force
    } catch {
      # Windows PowerShell 5.1 cannot delete paths over 260 characters (deep node_modules).
      if ($dir.FullName -match '^[A-Za-z]:\\') {
        try { [IO.Directory]::Delete('\\?\' + $dir.FullName, $true) } catch { }
      }
    }
    if (Test-Path -LiteralPath $dir.FullName) { Write-DeployWarning "Could not delete old backup $($dir.FullName)." }
    else { Write-Host "Removed old backup $($dir.Name)" }
  }
}

$stage = 'checks'
try {
  # ---- 1. source checks ----------------------------------------------------------------------
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Source folder not found: $Source" }
  $Source = (Resolve-Path -LiteralPath $Source).ProviderPath.TrimEnd('\', '/')
  $TargetPath = $TargetPath.TrimEnd('\', '/')
  $BackupRoot = $BackupRoot.TrimEnd('\', '/')
  foreach ($name in @($manifestName, 'version.json', 'index.html', 'web.config', 'setup.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source $name) -PathType Leaf)) {
      throw "$Source has no $name; it must be the complete output of publish-site.ps1."
    }
  }
  $newVersion = ConvertTo-AppVersion ([IO.File]::ReadAllText((Join-Path $Source 'version.json')))
  if (-not $newVersion) { throw "$Source\version.json has no applicationVersion." }
  $manifestVersion = Get-ManifestVersion ([IO.File]::ReadAllText((Join-Path $Source $manifestName)))
  if ($manifestVersion -ne $newVersion) { throw "$manifestName is version $manifestVersion but version.json says $newVersion." }
  if ($ExpectedVersion -and [version]$ExpectedVersion -ne $newVersion) { throw "Source is version $newVersion, expected $ExpectedVersion." }
  $appFolder = Join-Path 'Application Files' ('SochaDiff_' + ($newVersion.ToString() -replace '\.', '_'))
  if (-not (Test-Path -LiteralPath (Join-Path $Source $appFolder) -PathType Container)) { throw "$Source has no $appFolder folder." }

  if (-not (Test-Path -LiteralPath $TargetPath -PathType Container)) {
    throw "Target $TargetPath does not exist (it must be the IIS site's physical path)."
  }
  $targetFull = (Resolve-Path -LiteralPath $TargetPath).ProviderPath.TrimEnd('\', '/')
  $TargetPath = $targetFull   # absolute from here on (.NET file APIs ignore the PowerShell location)
  if ($targetFull -ieq $Source) { throw 'Source and target are the same folder.' }
  if (-not $SkipBackup) {
    $backupFull = [IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')
    if ($backupFull.StartsWith($targetFull + '\', [StringComparison]::OrdinalIgnoreCase) -or $backupFull -ieq $targetFull) {
      throw "BackupRoot $BackupRoot must not be inside the target $TargetPath (it would be served and backed up recursively)."
    }
  }

  Add-Summary "### Deploy Socha Diff $newVersion"
  Add-Summary ''
  Add-Summary "- Source: ``$Source``"
  Add-Summary "- Target: ``$TargetPath`` (no deletes)"
  Write-Host "Deploying Socha Diff $newVersion from $Source to $TargetPath"

  # ---- 2. version guard ----------------------------------------------------------------------
  $stage = 'version guard'
  $localVersion = $null
  $localVersionFile = Join-Path $TargetPath 'version.json'
  if (Test-Path -LiteralPath $localVersionFile -PathType Leaf) {
    try { $localVersion = ConvertTo-AppVersion ([IO.File]::ReadAllText($localVersionFile)) }
    catch { Write-DeployWarning "Could not read $localVersionFile ($($_.Exception.Message))." }
  }
  $urlVersion = $null
  $probe = Invoke-SiteProbe 'version.json'
  if ($probe.Status -eq 200) {
    try { $urlVersion = ConvertTo-AppVersion $probe.Body } catch { }
  } else {
    Write-Host "Live $($siteBase)version.json: HTTP $($probe.Status) $($probe.Error)"
  }
  Write-Host "Live version: target folder $(if ($localVersion) { $localVersion } else { '(none)' }), $siteBase $(if ($urlVersion) { $urlVersion } else { '(none)' })"
  Add-Summary "- Live before: folder ``$(if ($localVersion) { $localVersion } else { 'none' })``, URL ``$(if ($urlVersion) { $urlVersion } else { 'none' })``"

  if (-not $localVersion -and $urlVersion) {
    $msg = "$TargetPath has no version.json but $siteBase reports $urlVersion. Is -TargetPath really the site's content root?"
    if (-not $Force) { throw "$msg Use -Force to deploy anyway." }
    Write-DeployWarning "$msg Continuing because of -Force."
  }
  $reference = $localVersion
  if ($urlVersion -and (-not $reference -or $urlVersion -gt $reference)) { $reference = $urlVersion }
  if ($reference -and $newVersion -le $reference) {
    if (-not $Force) {
      throw "Refusing to deploy ${newVersion}: the live site already has $reference. Run the workflow manually with 'force' (or pass -Force) to override."
    }
    Write-DeployWarning "Deploying $newVersion over $reference because of -Force."
  }

  # ---- 3. backup -----------------------------------------------------------------------------
  $stage = 'backup'
  if ($SkipBackup) {
    Add-Summary '- Backup: skipped (-SkipBackup)'
  } elseif (-not (Get-ChildItem -LiteralPath $TargetPath -Force | Select-Object -First 1)) {
    Add-Summary '- Backup: skipped (target was empty)'
  } else {
    if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
      # First run with the per-site folder: create it (the runner account can do this while it has
      # Modify on the parent; afterwards it only needs Modify on this folder).
      New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
      Write-Host "Created backup folder $BackupRoot"
    }
    $label = if ($localVersion) { $localVersion.ToString() } else { 'unknown' }
    $backupDir = Join-Path $BackupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $label)
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Invoke-Robocopy $TargetPath $backupDir @('/E') 'backup'
    Write-Host "Backed up $TargetPath to $backupDir"
    Add-Summary "- Backup: ``$backupDir``"
    Remove-OldBackups
  }

  # ---- 4. copy, phase 1: everything except the three files that switch clients over ----------
  $stage = 'copy phase 1'
  foreach ($dir in @(Get-ChildItem -LiteralPath $Source -Directory -Force)) {
    Invoke-Robocopy $dir.FullName (Join-Path $TargetPath $dir.Name) @('/E') $dir.Name
  }
  $rootFiles = @(Get-ChildItem -LiteralPath $Source -File -Force | Where-Object { $lastFiles -notcontains $_.Name } | ForEach-Object { $_.Name })
  if ($rootFiles.Count -gt 0) {
    # File names as robocopy filters, no /E: only these root files.
    Invoke-Robocopy $Source $TargetPath $rootFiles 'root files'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $TargetPath 'web.config') -PathType Leaf)) { throw "web.config is missing in $TargetPath after phase 1." }
  if (-not (Test-Path -LiteralPath (Join-Path $TargetPath $appFolder) -PathType Container)) { throw "$appFolder is missing in $TargetPath after phase 1." }

  # ---- 4b. copy, phase 2: the deployment manifest, then version.json and index.html ------------
  $stage = 'copy phase 2'
  foreach ($name in $lastFiles) { Copy-FileLast $name }
  $afterVersion = ConvertTo-AppVersion ([IO.File]::ReadAllText($localVersionFile))
  if ($afterVersion -ne $newVersion) { throw "$localVersionFile reports $afterVersion after copying, expected $newVersion." }
  Write-Host "Copied Socha Diff $newVersion to $TargetPath"
  Add-Summary ('- Copied: all folders and root files (no deletes), then ' + (($lastFiles | ForEach-Object { '`' + $_ + '`' }) -join ', ') + ' last')

  # ---- 5. verify -------------------------------------------------------------------------------
  if ($Verify) {
    $stage = 'verify'
    Add-Summary "- Verify ($siteBase, cache-busting query string):"
    $vj = $null
    for ($i = 1; $i -le $VerifyAttempts; $i++) {
      $vj = Invoke-SiteProbe 'version.json'
      $seen = $null
      if ($vj.Status -eq 200) { try { $seen = ConvertTo-AppVersion $vj.Body } catch { } }
      if ($seen -eq $newVersion) { break }
      Write-Host "version.json attempt ${i}: HTTP $($vj.Status), version $seen, CF-Cache-Status '$($vj.CacheStatus)' $($vj.Error)"
      if ($i -lt $VerifyAttempts) { Start-Sleep -Seconds $VerifyDelaySeconds }
    }
    if ($vj.Status -ne 200) {
      $failures.Add("version.json: HTTP $($vj.Status) $($vj.Error)")
    } elseif ($seen -eq $newVersion) {
      Add-Summary "  - ``version.json``: $seen (OK, CF-Cache-Status '$($vj.CacheStatus)')"
    } elseif (Test-FromCache $vj) {
      Write-DeployWarning "version.json still shows $seen from the Cloudflare cache (CF-Cache-Status $($vj.CacheStatus)); the origin has $newVersion. Purge the cache if this persists."
    } else {
      $failures.Add("version.json shows $seen (CF-Cache-Status '$($vj.CacheStatus)'), expected ${newVersion}; is the site serving ${TargetPath}?")
    }

    $app = Invoke-SiteProbe $manifestName
    if ($app.Status -ne 200) {
      $failures.Add("${manifestName}: HTTP $($app.Status) $($app.Error)")
    } else {
      $typeOk = $app.ContentType -match '^\s*application/x-ms-application\b'
      $appVersion = Get-ManifestVersion $app.Body
      if ($typeOk -and $appVersion -eq $newVersion) {
        Add-Summary "  - ``$manifestName``: 200, $($app.ContentType), version $appVersion (OK)"
      } elseif (Test-FromCache $app) {
        Write-DeployWarning "$manifestName from the Cloudflare cache (CF-Cache-Status $($app.CacheStatus)) has Content-Type '$($app.ContentType)', version $appVersion; expected application/x-ms-application, $newVersion. Purge the cache if this persists."
      } else {
        if (-not $typeOk) { $failures.Add("$manifestName has Content-Type '$($app.ContentType)', expected application/x-ms-application (web.config MIME map?)") }
        if ($appVersion -ne $newVersion) { $failures.Add("$manifestName is version $appVersion, expected $newVersion") }
      }
    }
    foreach ($f in $failures) { Add-Summary "  - FAILED: $f" }
    if ($failures.Count -gt 0) { throw ("Verification failed: " + ($failures -join '; ')) }
  }

  $stage = 'done'
  Add-Summary ''
  Add-Summary "**Deployed $newVersion.**"
  Write-Host "Deployed Socha Diff $newVersion to $TargetPath ($siteBase)"
} catch {
  Add-Summary ''
  Add-Summary "**Deploy failed during ${stage}:** $($_.Exception.Message)"
  if ($stage -eq 'verify') { Add-Summary '(The files were copied; check the site and the Cloudflare cache.)' }
  throw
} finally {
  Write-StepSummary
}
exit 0
