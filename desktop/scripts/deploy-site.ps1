<#
.SYNOPSIS
  Uploads an assembled site folder (publish-site.ps1 output) to the sochadiff.socha3.com IIS site.

.DESCRIPTION
  Two phases so a client never sees a deployment manifest that points at files not uploaded
  yet: everything except SochaDiff.application first, then SochaDiff.application. Nothing is
  deleted on the server (older "Application Files" versions stay, so clients mid-update keep
  working; prune very old ones by hand occasionally).

  Refuses to deploy a version that is not newer than the live one (from <SiteUrl>/version.json),
  unless -Force.

  -Mode WebDeploy  msdeploy.exe to the IIS Web Management Service (WMSvc, port 8172).
                   Credentials from env DEPLOY_USER / DEPLOY_PASSWORD.
  -Mode Copy       robocopy to a local/UNC folder, e.g. a self-hosted runner on the IIS
                   server copying to C:\WebApps\SochaDiff.

.EXAMPLE
  $env:DEPLOY_USER='deploy'; $env:DEPLOY_PASSWORD='...'
  pwsh desktop/scripts/deploy-site.ps1 -Source desktop/out/site -Mode WebDeploy -ServerHost iis.socha3.com -SiteName sochadiff.socha3.com
.EXAMPLE
  pwsh desktop/scripts/deploy-site.ps1 -Source desktop/out/site -Mode Copy -TargetPath C:\WebApps\SochaDiff
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$Source,
  [Parameter(Mandatory)] [ValidateSet('WebDeploy', 'Copy')] [string]$Mode,
  # WebDeploy: server host name, or a full https://host:8172/msdeploy.axd URL.
  [string]$ServerHost,
  # WebDeploy: IIS site name (contentPath root).
  [string]$SiteName,
  # WebDeploy: accept the WMSvc self-signed certificate.
  [switch]$AllowUntrusted,
  # Copy: destination folder (the IIS site's physical path).
  [string]$TargetPath = 'C:\WebApps\SochaDiff',
  [string]$SiteUrl = 'https://sochadiff.socha3.com/',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path $Source).Path.TrimEnd('\', '/')
$manifestName = 'SochaDiff.application'
if (-not (Test-Path (Join-Path $Source $manifestName))) { throw "$Source has no $manifestName; run publish-site.ps1 first." }
$new = Get-Content (Join-Path $Source 'version.json') -Raw | ConvertFrom-Json
Write-Host "Deploying Socha Diff $($new.applicationVersion) from $Source ($Mode)"

# ---- version guard ---------------------------------------------------------------------------
try {
  $live = Invoke-RestMethod -Uri ($SiteUrl.TrimEnd('/') + '/version.json') -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 20
  if ($live.applicationVersion) {
    Write-Host "Live version: $($live.applicationVersion)"
    if ([version]$new.applicationVersion -le [version]$live.applicationVersion -and -not $Force) {
      throw "Refusing to deploy $($new.applicationVersion): the live site already has $($live.applicationVersion). Use -Force to override."
    }
  }
} catch [System.Net.WebException], [System.Net.Http.HttpRequestException], [Microsoft.PowerShell.Commands.HttpResponseException] {
  Write-Host "No live version.json yet ($($_.Exception.Message)); continuing."
}

if ($Mode -eq 'Copy') {
  New-Item -ItemType Directory -Force -Path $TargetPath | Out-Null
  # Phase 1: everything but the deployment manifest (no /MIR: never delete on the server).
  robocopy $Source $TargetPath /E /XF $manifestName /R:3 /W:5 /NP /NFL /NDL
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
  # Phase 2: the manifest, which switches clients to the new version.
  Copy-Item -Force (Join-Path $Source $manifestName) (Join-Path $TargetPath $manifestName)
  $global:LASTEXITCODE = 0
  Write-Host "Copied to $TargetPath"
  return
}

# ---- Web Deploy ----------------------------------------------------------------------------
if (-not $ServerHost -or -not $SiteName) { throw "WebDeploy needs -ServerHost and -SiteName." }
if (-not $env:DEPLOY_USER -or -not $env:DEPLOY_PASSWORD) { throw "WebDeploy needs DEPLOY_USER and DEPLOY_PASSWORD in the environment." }
$msdeploy = @(
  (Join-Path $env:ProgramFiles 'IIS\Microsoft Web Deploy V3\msdeploy.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'IIS\Microsoft Web Deploy V3\msdeploy.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $msdeploy) { throw "msdeploy.exe not found (install Web Deploy 3.6, e.g. choco install webdeploy)." }
if ($Source -match '[\s,]') { throw "Source path must not contain spaces or commas for msdeploy: $Source" }

$url = if ($ServerHost -match '://') { $ServerHost } else { "https://${ServerHost}:8172/msdeploy.axd?site=$SiteName" }
$dest = "-dest:contentPath=$SiteName,computerName=$url,userName=$($env:DEPLOY_USER),password=$($env:DEPLOY_PASSWORD),authType=Basic"
$common = @('-verb:sync', "-source:contentPath=$Source", $dest, '-enableRule:DoNotDeleteRule', '-retryAttempts:3', '-retryInterval:3000')
if ($AllowUntrusted) { $common += '-allowUntrusted' }

Write-Host "Phase 1: everything except $manifestName -> $SiteName on $url"
& $msdeploy @common '-skip:objectName=filePath,absolutePath=\\SochaDiff\.application$'
if ($LASTEXITCODE -ne 0) { throw "msdeploy phase 1 failed ($LASTEXITCODE)" }
Write-Host "Phase 2: $manifestName"
& $msdeploy @common
if ($LASTEXITCODE -ne 0) { throw "msdeploy phase 2 failed ($LASTEXITCODE)" }
Write-Host "Deployed $($new.applicationVersion) to $SiteUrl"
