<#
.SYNOPSIS
  Builds the ClickOnce release and assembles the complete sochadiff.socha3.com site folder.

.DESCRIPTION
  Runs on Windows with Visual Studio's MSBuild (ClickOnce publishing is not supported by
  `dotnet publish`). Used by .github/workflows/publish-desktop.yml and for manual releases.

    1. prepare-bundle.ps1              stages desktop/bundle/app (web app + production node_modules)
    2. msbuild /t:Publish              ClickOnce profile, framework-dependent, version
                                       <major>.<minor>.<Build>.0 (major/minor from desktop/version.json)
    3. assemble desktop/out/site/      ClickOnce output (SochaDiff.application, setup.exe,
                                       Application Files/) + site/ (page, assets, web.config)
    4. stamp                           displayed version + measured app size into index.html,
                                       and version.json

  Upload the CONTENTS of the output folder to the IIS site root (deploy-site.ps1 does that
  and uploads SochaDiff.application last). Every release needs a higher -Build than the one
  that is live; CI uses the GitHub Actions run number.

  setup.exe prerequisites: the .NET 10 Desktop Runtime package ships with Visual Studio 2026's
  ClickOnce components; the WebView2 package lives in desktop/bootstrapper/ and is copied into
  Visual Studio with -InstallBootstrapperPackages (needs admin). A package that is not found is
  left out of setup.exe with a warning (the site's prerequisite list and in-app checks remain).

  Signing: TODO until Sissy Admin provides the code-signing certificate. Pass
  -CertificateThumbprint (certificate in Cert:\CurrentUser\My) to sign the manifests.

.EXAMPLE
  pwsh desktop/scripts/publish-site.ps1 -Build 42
.EXAMPLE
  pwsh desktop/scripts/publish-site.ps1 -Build 42 -InstallBootstrapperPackages -CertificateThumbprint 0123ABCD...
#>
[CmdletBinding()]
param(
  # Third version part (CI: github.run_number). Must be higher than the live release.
  [int]$Build = 0,
  # Output folder (default desktop/out/site). Emptied first.
  [string]$OutDir,
  # Copy desktop/bootstrapper/* into Visual Studio's BootstrapperPackages folder first (admin).
  [switch]$InstallBootstrapperPackages,
  # Sign the ClickOnce manifests with this certificate (Cert:\CurrentUser\My). Unsigned if empty.
  [string]$CertificateThumbprint,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  # Reuse an existing desktop/bundle instead of running prepare-bundle.ps1.
  [switch]$SkipPrepare,
  # Explicit MSBuild.exe (default: msbuild on PATH, else the latest Visual Studio via vswhere).
  [string]$MSBuild
)

$ErrorActionPreference = 'Stop'
$desktopDir = Split-Path -Parent $PSScriptRoot
$repoRoot   = Split-Path -Parent $desktopDir
$project    = Join-Path $desktopDir 'SochaDiff.Desktop\SochaDiff.Desktop.csproj'
$siteSrc    = Join-Path $repoRoot 'site'
$publishDir = Join-Path $desktopDir 'SochaDiff.Desktop\bin\publish\clickonce'
if (-not $OutDir) { $OutDir = Join-Path $desktopDir 'out\site' }

# ---- version -------------------------------------------------------------------------
$v = Get-Content (Join-Path $desktopDir 'version.json') -Raw | ConvertFrom-Json
$displayVersion = '{0}.{1}.{2}' -f [int]$v.major, [int]$v.minor, $Build
$appVersion     = "$displayVersion.0"
if ($Build -eq 0) { Write-Warning "Build number 0: fine for a local test, but never deploy it over a real release (use -Build N)." }
Write-Host "Socha Diff $appVersion"

# ---- MSBuild ---------------------------------------------------------------------------
if (-not $MSBuild) {
  $cmd = Get-Command msbuild.exe -ErrorAction SilentlyContinue
  if ($cmd) { $MSBuild = $cmd.Source }
  else {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
      $MSBuild = & $vswhere -latest -prerelease -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
    }
  }
}
if (-not $MSBuild -or -not (Test-Path $MSBuild)) { throw "Visual Studio MSBuild not found. Run from a Developer PowerShell or pass -MSBuild." }
Write-Host "MSBuild: $MSBuild"
# ...\MSBuild\Current\Bin\[amd64\]MSBuild.exe -> ...\MSBuild
$msbuildRoot = (Resolve-Path $MSBuild).Path
while ($msbuildRoot -and (Split-Path -Leaf $msbuildRoot) -ne 'MSBuild') { $msbuildRoot = Split-Path -Parent $msbuildRoot }

# ---- bootstrapper packages ----------------------------------------------------------------
$packageDirs = @()
if ($msbuildRoot) { $packageDirs += (Join-Path $msbuildRoot 'Microsoft\VisualStudio\BootstrapperPackages') }
$sdkBootstrapper = Join-Path ${env:ProgramFiles(x86)} 'Microsoft SDKs\ClickOnce Bootstrapper'
$packageDirs += (Join-Path $sdkBootstrapper 'Packages')
foreach ($key in 'HKLM:\SOFTWARE\Microsoft\GenericBootstrapper', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\GenericBootstrapper') {
  if (Test-Path $key) {
    Get-ChildItem $key -ErrorAction SilentlyContinue | ForEach-Object {
      $p = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).Path
      if ($p) { $packageDirs += (Join-Path $p 'Packages') }
    }
  }
}
$packageDirs = $packageDirs | Where-Object { $_ } | Select-Object -Unique

if ($InstallBootstrapperPackages) {
  $target = $packageDirs | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $target) { Write-Warning "No ClickOnce BootstrapperPackages folder found; cannot install the custom packages." }
  else {
    foreach ($pkg in Get-ChildItem (Join-Path $desktopDir 'bootstrapper') -Directory) {
      try {
        Copy-Item -Recurse -Force $pkg.FullName (Join-Path $target $pkg.Name)
        Write-Host "Installed bootstrapper package $($pkg.Name) -> $target"
      } catch {
        Write-Warning "Could not install bootstrapper package $($pkg.Name) into $target (run elevated): $($_.Exception.Message)"
      }
    }
  }
}

function Test-BootstrapperPackage([string]$ProductCode) {
  foreach ($dir in $packageDirs) {
    if (-not (Test-Path $dir)) { continue }
    foreach ($xml in Get-ChildItem $dir -Filter product.xml -Recurse -Depth 1 -ErrorAction SilentlyContinue) {
      if ((Get-Content $xml.FullName -Raw) -match ('ProductCode\s*=\s*"' + [regex]::Escape($ProductCode) + '"')) { return $xml.DirectoryName }
    }
  }
  return $null
}
$prereqDotNet  = Test-BootstrapperPackage 'Microsoft.NetCore.DesktopRuntime.10.0.x64'
$prereqWebView = Test-BootstrapperPackage 'Socha3.WebView2Runtime.Evergreen'
if ($prereqDotNet)  { Write-Host "setup.exe prerequisite: .NET 10 Desktop Runtime x64 ($prereqDotNet)" }
else { Write-Warning "Bootstrapper package Microsoft.NetCore.DesktopRuntime.10.0.x64 not found (Visual Studio 2026 ClickOnce components). setup.exe will not offer .NET 10; the app's own '.NET is required' prompt and the site cover it." }
if ($prereqWebView) { Write-Host "setup.exe prerequisite: WebView2 Evergreen ($prereqWebView)" }
else { Write-Warning "Bootstrapper package Socha3.WebView2Runtime.Evergreen not installed (use -InstallBootstrapperPackages, elevated). setup.exe will not offer WebView2; the app's own panel and the site cover it." }

# ---- 1. bundle ------------------------------------------------------------------------------
if (-not $SkipPrepare) {
  & (Join-Path $PSScriptRoot 'prepare-bundle.ps1')
  if (-not $?) { throw "prepare-bundle.ps1 failed" }
}

# ---- 2. ClickOnce publish ------------------------------------------------------------------
if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }
$msbuildArgs = @(
  $project, '/restore', '/t:Publish', '/nologo', '/v:minimal',
  '/p:PublishProfile=ClickOnce', '/p:Configuration=Release',
  "/p:SochaBuildNumber=$Build",
  "/p:ApplicationVersion=$appVersion", '/p:ApplicationRevision=0', "/p:MinimumRequiredVersion=$appVersion",
  "/p:PublishDir=$publishDir\",
  ('/p:SochaPrereqDotNet=' + [bool]$prereqDotNet).ToLowerInvariant(),
  ('/p:SochaPrereqWebView2=' + [bool]$prereqWebView).ToLowerInvariant()
)
$signed = $false
if ($CertificateThumbprint) {
  $thumb = $CertificateThumbprint -replace '\s', ''
  if (-not (Test-Path "Cert:\CurrentUser\My\$thumb")) { throw "Certificate $thumb not found in Cert:\CurrentUser\My" }
  $msbuildArgs += @('/p:SignManifests=true', "/p:ManifestCertificateThumbprint=$thumb",
                    "/p:ManifestTimestampRFC3161Url=$TimestampUrl", '/p:SignatureAlgorithm=sha256RSA')
  $signed = $true
  Write-Host "Signing manifests with $thumb"
} else {
  Write-Warning "Unsigned publish (TODO: certificate from Sissy Admin). Installs show 'Unknown publisher'."
}
& $MSBuild @msbuildArgs
if ($LASTEXITCODE -ne 0) { throw "msbuild publish failed with exit code $LASTEXITCODE" }

$manifest = Join-Path $publishDir 'SochaDiff.application'
$versionFolder = Join-Path $publishDir ("Application Files\SochaDiff_" + ($appVersion -replace '\.', '_'))
if (-not (Test-Path $manifest)) { throw "Publish output has no SochaDiff.application ($publishDir)" }
if (-not (Test-Path $versionFolder)) { throw "Publish output has no $versionFolder" }

# ---- 3. assemble ---------------------------------------------------------------------------
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $siteSrc '*') $OutDir
Copy-Item -Recurse -Force (Join-Path $publishDir '*') $OutDir

# ---- 4. measure + stamp -------------------------------------------------------------------
$payloadBytes = (Get-ChildItem -LiteralPath $versionFolder -Recurse -File | Measure-Object -Sum Length).Sum
$payloadMB = [math]::Round($payloadBytes / 1MB, 1)
$sizeText = "about $payloadMB MB"
$index = Join-Path $OutDir 'index.html'
$html = [IO.File]::ReadAllText($index)
$html = [regex]::Replace($html, '<!--app-version-->.*?<!--/app-version-->', "<!--app-version-->$displayVersion<!--/app-version-->")
$html = [regex]::Replace($html, '<!--app-size-->.*?<!--/app-size-->', "<!--app-size-->$sizeText<!--/app-size-->")
if ($signed) {
  # Signed: drop the "Unknown publisher" notice.
  $html = [regex]::Replace($html, '(?s)\s*<!-- UNSIGNED-NOTICE:.*?<!-- /UNSIGNED-NOTICE -->', '')
}
[IO.File]::WriteAllText($index, $html, (New-Object Text.UTF8Encoding($false)))

$commit = ''
try { $commit = (git -C $repoRoot rev-parse --short HEAD 2>$null) } catch { }
[ordered]@{
  version            = $displayVersion
  applicationVersion = $appVersion
  build              = $Build
  commit             = $commit
  publishedAt        = (Get-Date).ToUniversalTime().ToString('o')
  appPayloadBytes    = $payloadBytes
  appPayloadMB       = $payloadMB
  signed             = $signed
  setupPrerequisites = @(@(if ($prereqDotNet) { '.NET 10 Desktop Runtime x64' }) + @(if ($prereqWebView) { 'WebView2 Runtime' }))
} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutDir 'version.json')

$fileCount = (Get-ChildItem -Recurse -File $OutDir).Count
Write-Host ""
Write-Host "Site ready: $OutDir ($fileCount files)"
Write-Host "  version $appVersion, app payload $payloadBytes bytes ($sizeText), signed: $signed"
Write-Host "  upload the folder CONTENTS to the IIS root; SochaDiff.application last (deploy-site.ps1 does this)"

if ($env:GITHUB_OUTPUT) {
  "version=$displayVersion"        | Out-File -Append -Encoding utf8 $env:GITHUB_OUTPUT
  "application_version=$appVersion" | Out-File -Append -Encoding utf8 $env:GITHUB_OUTPUT
  "payload_mb=$payloadMB"           | Out-File -Append -Encoding utf8 $env:GITHUB_OUTPUT
  "out_dir=$OutDir"                 | Out-File -Append -Encoding utf8 $env:GITHUB_OUTPUT
}
if ($env:GITHUB_STEP_SUMMARY) {
  @(
    "### Socha Diff $appVersion",
    "",
    "| | |", "|---|---|",
    "| App payload | $payloadBytes bytes ($sizeText) |",
    "| Signed | $signed |",
    "| setup.exe prerequisites | .NET 10: $([bool]$prereqDotNet), WebView2: $([bool]$prereqWebView) |",
    "| Files | $fileCount |"
  ) | Out-File -Append -Encoding utf8 $env:GITHUB_STEP_SUMMARY
}
