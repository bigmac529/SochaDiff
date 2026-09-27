<#
.SYNOPSIS
  Builds the ClickOnce release of Socha Diff and assembles the complete website
  (download page + ClickOnce files) in desktop/out/site/, ready for the IIS root of
  https://sochadiff.socha3.com/.

.DESCRIPTION
  Windows only: ClickOnce publishing needs Visual Studio's MSBuild (or Build Tools with the
  ClickOnce/.NET desktop components); `dotnet publish` cannot do it.

    1. resolves the version: -Version a.b.c.d, or <major>.<minor> from desktop/version.json
       plus -Build (CI passes the GitHub Actions run number);
    2. runs prepare-bundle.ps1 (stages desktop/bundle/: the web app + production node_modules);
    3. runs msbuild /t:Publish with PublishProfile=ClickOnce, passing the version into
       ApplicationVersion, MinimumRequiredVersion (so installed clients must update at their
       next launch) and the assembly Version/FileVersion/AssemblyVersion;
       optional signing: -CertificateThumbprint (cert already in Cert:\CurrentUser\My) or
       -PfxPath/-PfxPassword (imported for the build and removed again afterwards). Signing
       covers the deployment + application manifests, SochaDiff.exe, the entry point
       assembly and setup.exe (MSBuild's ClickOnce signing);
    4. copies site/ and then the ClickOnce output (SochaDiff.application, setup.exe,
       Application Files/SochaDiff_a_b_c_d/) into desktop/out/site/, and stamps the output copy
       of the site: version.json (version, commit, time, measured app size, signed flag),
       the version/size markers in index.html, and removes the "Unknown publisher" notice
       when the release is signed. The committed site/ files are not modified.

  Deploy desktop/out/site/ with the manifest (SochaDiff.application) copied LAST, so a client
  never sees a manifest that points at files that are not uploaded yet (the GitHub workflow
  does this with a two-phase msdeploy sync).

.EXAMPLE
  pwsh desktop/scripts/publish-site.ps1 -Build 42
  # -> 1.0.42.0 (major/minor from desktop/version.json), unsigned
.EXAMPLE
  pwsh desktop/scripts/publish-site.ps1 -Version 1.0.42.0 -CertificateThumbprint 0123ABCD...
.EXAMPLE
  pwsh desktop/scripts/publish-site.ps1 -Build 42 -PfxPath C:\temp\socha3.pfx -PfxPassword (Read-Host -AsSecureString)
#>
[CmdletBinding()]
param(
  # Full four-part version (a.b.c.d). Takes precedence over -Build.
  [string]$Version,
  # Build number (third part); major/minor come from desktop/version.json.
  [int]$Build = -1,
  # Output folder for the assembled site (default desktop/out/site).
  [string]$OutDir,
  # Explicit MSBuild.exe; default: msbuild on PATH, else the newest VS/Build Tools via vswhere.
  [string]$MSBuildPath,
  # Signing, option 1: thumbprint of a code-signing cert (with private key) in Cert:\CurrentUser\My.
  [string]$CertificateThumbprint,
  # Signing, option 2: a PFX file, imported into Cert:\CurrentUser\My for the build and removed afterwards.
  [string]$PfxPath,
  [SecureString]$PfxPassword,
  # RFC 3161 timestamp server used for manifests and Authenticode signatures.
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  # Copy desktop/bootstrapper/* (the WebView2 setup.exe prerequisite) into Visual Studio's
  # BootstrapperPackages folder first. Needs admin rights (GitHub-hosted runners have them).
  [switch]$InstallBootstrapperPackages,
  # Use the existing desktop/bundle/ instead of running prepare-bundle.ps1.
  [switch]$SkipPrepareBundle
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$desktopDir = Split-Path -Parent $PSScriptRoot
$repoRoot   = Split-Path -Parent $desktopDir
$projectDir = Join-Path $desktopDir 'SochaDiff.Desktop'
$project    = Join-Path $projectDir 'SochaDiff.Desktop.csproj'
$publishDir = Join-Path $projectDir 'bin\publish\clickonce'
$siteSrc    = Join-Path $repoRoot 'site'
if (-not $OutDir) { $OutDir = Join-Path $desktopDir 'out\site' }
$OutDir = [IO.Path]::GetFullPath($OutDir)

function Write-Step([string]$Text) { Write-Host "`n=== $Text" -ForegroundColor Cyan }

if ($env:OS -ne 'Windows_NT') { throw 'publish-site.ps1 needs Windows (Visual Studio MSBuild for ClickOnce).' }

# ---------------------------------------------------------------- 1. version
$versionJson = Get-Content (Join-Path $desktopDir 'version.json') -Raw | ConvertFrom-Json
if ($Version) {
  if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "-Version must have four numeric parts (a.b.c.d), got '$Version'." }
} elseif ($Build -ge 0) {
  $Version = '{0}.{1}.{2}.0' -f [int]$versionJson.major, [int]$versionJson.minor, $Build
} else {
  throw 'Pass -Version a.b.c.d or -Build N (the version must be higher than the one already on the site).'
}
$parts = $Version.Split('.') | ForEach-Object { [int]$_ }
if (($parts | Where-Object { $_ -gt 65535 }).Count -gt 0) { throw "Each version part must be <= 65535 ($Version)." }
if ($parts[0] -ne [int]$versionJson.major -or $parts[1] -ne [int]$versionJson.minor) {
  Write-Warning "Version $Version does not match major/minor $($versionJson.major).$($versionJson.minor) in desktop/version.json."
}
$displayVersion = '{0}.{1}.{2}' -f $parts[0], $parts[1], $parts[2]
$commit = ''
try { $commit = (git -C $repoRoot rev-parse --short HEAD 2>$null) } catch { }
Write-Host "Socha Diff $Version (commit $commit)"

# ---------------------------------------------------------------- 2. MSBuild + Visual Studio
Write-Step 'Locating MSBuild'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not $MSBuildPath) {
  $cmd = Get-Command msbuild -ErrorAction SilentlyContinue
  if ($cmd) { $MSBuildPath = $cmd.Source }
  elseif (Test-Path $vswhere) {
    $MSBuildPath = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
  }
}
if (-not $MSBuildPath -or -not (Test-Path $MSBuildPath)) {
  throw 'MSBuild.exe not found. Run from a Developer PowerShell, pass -MSBuildPath, or install Visual Studio / Build Tools with the .NET desktop workload.'
}
# <VS>\MSBuild\Current\Bin[\amd64]\MSBuild.exe -> <VS>
$vsRoot = $MSBuildPath
while ($vsRoot -and (Split-Path -Leaf $vsRoot) -ne 'MSBuild') { $vsRoot = Split-Path -Parent $vsRoot }
if ($vsRoot) { $vsRoot = Split-Path -Parent $vsRoot }
Write-Host "MSBuild: $MSBuildPath"
Write-Host "Visual Studio: $vsRoot"

# ---------------------------------------------------------------- 3. setup.exe prerequisites
# GenerateBootstrapper looks in both folders.
$pkgDirs = @()
if ($vsRoot) { $pkgDirs += (Join-Path $vsRoot 'MSBuild\Microsoft\VisualStudio\BootstrapperPackages') }
$pkgDirs += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft SDKs\ClickOnce Bootstrapper\Packages')
if ($InstallBootstrapperPackages) {
  if (-not $vsRoot) { throw 'Cannot install bootstrapper packages: Visual Studio folder unknown.' }
  $dest = $pkgDirs[0]
  Write-Step "Installing desktop/bootstrapper packages into $dest"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Get-ChildItem -Directory (Join-Path $desktopDir 'bootstrapper') | ForEach-Object {
    Copy-Item -Recurse -Force $_.FullName $dest
    Write-Host "  $($_.Name)"
  }
}
function Test-BootstrapperPackage([string]$Name) {
  foreach ($d in $pkgDirs) { if (Test-Path (Join-Path $d "$Name\product.xml")) { return $true } }
  return $false
}
$prereqDotNet   = Test-BootstrapperPackage 'Microsoft.NetCore.DesktopRuntime.10.0.x64'
$prereqWebView2 = Test-BootstrapperPackage 'Socha3.WebView2Runtime.Evergreen'
if (-not $prereqDotNet)   { Write-Warning 'Bootstrapper package Microsoft.NetCore.DesktopRuntime.10.0.x64 not installed (comes with Visual Studio 2026 ClickOnce components): setup.exe will not offer the .NET 10 Desktop Runtime.' }
if (-not $prereqWebView2) { Write-Warning 'Bootstrapper package Socha3.WebView2Runtime.Evergreen not installed (use -InstallBootstrapperPackages): setup.exe will not offer the WebView2 Runtime.' }

# ---------------------------------------------------------------- 4. bundle
if (-not $SkipPrepareBundle) {
  Write-Step 'prepare-bundle.ps1'
  & (Join-Path $PSScriptRoot 'prepare-bundle.ps1')
}

# ---------------------------------------------------------------- 5. signing certificate
$importedCert = $null
$signed = $false
function Remove-ImportedCertificate($Cert) {
  if (-not $Cert) { return }
  try {
    # Delete the persisted private key first (CNG or CSP), then the store entry.
    $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Cert)
    if ($rsa -is [Security.Cryptography.RSACng]) { $rsa.Key.Delete() }
    elseif ($rsa -is [Security.Cryptography.RSACryptoServiceProvider]) { $rsa.PersistKeyInCsp = $false; $rsa.Clear() }
  } catch { Write-Warning "Could not delete the imported private key: $($_.Exception.Message)" }
  $store = New-Object Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')
  $store.Open('ReadWrite')
  try { $store.Remove($Cert) } finally { $store.Close() }
  Write-Host "Removed signing certificate $($Cert.Thumbprint) from Cert:\CurrentUser\My"
}

try {
  if ($PfxPath) {
    Write-Step 'Importing signing certificate'
    if (-not (Test-Path $PfxPath)) { throw "PFX not found: $PfxPath" }
    $plain = ''
    if ($PfxPassword) { $plain = (New-Object System.Net.NetworkCredential('', $PfxPassword)).Password }
    $flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]'UserKeySet, PersistKeySet'
    $collection = New-Object Security.Cryptography.X509Certificates.X509Certificate2Collection
    $collection.Import((Resolve-Path $PfxPath).Path, $plain, $flags)
    $plain = $null
    $leaf = $collection | Where-Object { $_.HasPrivateKey } | Select-Object -First 1
    if (-not $leaf) { throw 'The PFX contains no certificate with a private key.' }
    $store = New-Object Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')
    $store.Open('ReadWrite')
    try { $store.Add($leaf) } finally { $store.Close() }
    $importedCert = $leaf
    $CertificateThumbprint = $leaf.Thumbprint
    Write-Host "Imported $($leaf.Subject) ($CertificateThumbprint), expires $($leaf.NotAfter.ToString('yyyy-MM-dd'))"
  }
  if ($CertificateThumbprint) {
    $CertificateThumbprint = ($CertificateThumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $CertificateThumbprint } | Select-Object -First 1
    if (-not $cert) { throw "Certificate $CertificateThumbprint is not in Cert:\CurrentUser\My (ClickOnce signing looks there)." }
    if (-not $cert.HasPrivateKey) { throw "Certificate $CertificateThumbprint has no private key." }
    if ($cert.NotAfter -lt (Get-Date)) { throw "Certificate $CertificateThumbprint expired on $($cert.NotAfter)." }
    $signed = $true
    Write-Host "Signing with $($cert.Subject)"
  } else {
    Write-Warning 'No certificate: the release is UNSIGNED (installs show "Unknown publisher").'
  }

  # -------------------------------------------------------------- 6. msbuild /t:Publish
  Write-Step "msbuild /t:Publish (ClickOnce $Version)"
  if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }
  $msbuildArgs = @(
    $project, '/restore', '/t:Publish', '/nologo', '/v:minimal', '/m',
    '/p:PublishProfile=ClickOnce',
    '/p:Configuration=Release',
    "/p:SochaBuildNumber=$($parts[2])",
    "/p:ApplicationVersion=$Version",
    "/p:MinimumRequiredVersion=$Version",
    "/p:Version=$displayVersion",
    "/p:FileVersion=$Version",
    "/p:AssemblyVersion=$Version",
    "/p:SochaPrereqDotNet=$($prereqDotNet.ToString().ToLowerInvariant())",
    "/p:SochaPrereqWebView2=$($prereqWebView2.ToString().ToLowerInvariant())"
  )
  if ($signed) {
    $msbuildArgs += @(
      '/p:SignManifests=true',
      "/p:ManifestCertificateThumbprint=$CertificateThumbprint",
      "/p:ManifestTimestampUrl=$TimestampUrl"
    )
  }
  & $MSBuildPath @msbuildArgs
  if ($LASTEXITCODE -ne 0) { throw "msbuild failed with exit code $LASTEXITCODE" }
} finally {
  Remove-ImportedCertificate $importedCert
}

# ---------------------------------------------------------------- 7. check the ClickOnce output
$appFolderName = 'SochaDiff_' + ($Version -replace '\.', '_')
$appFolder = Join-Path $publishDir "Application Files\$appFolderName"
foreach ($p in (Join-Path $publishDir 'SochaDiff.application'), $appFolder) {
  if (-not (Test-Path $p)) { throw "Expected ClickOnce output is missing: $p" }
}
$deployManifest = [xml](Get-Content -Raw (Join-Path $publishDir 'SochaDiff.application'))
$idVersion  = $deployManifest.SelectSingleNode("/*[local-name()='assembly']/*[local-name()='assemblyIdentity']").GetAttribute('version')
$minVersion = $deployManifest.SelectSingleNode("//*[local-name()='deployment']").GetAttribute('minimumRequiredVersion')
if ($idVersion -ne $Version) { throw "SochaDiff.application has version $idVersion, expected $Version." }
if ($minVersion -ne $Version) { Write-Warning "SochaDiff.application minimumRequiredVersion is '$minVersion' (expected $Version)." }

# ---------------------------------------------------------------- 8. assemble desktop/out/site
Write-Step "Assembling $OutDir"
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $siteSrc '*') $OutDir
Get-ChildItem -Force $publishDir | ForEach-Object {
  if (Test-Path (Join-Path $OutDir $_.Name)) { Write-Warning "ClickOnce output overwrites site/$($_.Name)" }
  Copy-Item -Recurse -Force $_.FullName $OutDir
}

# App size = what a first install downloads (the versioned Application Files folder).
$appFiles = Get-ChildItem -Recurse -File (Join-Path $OutDir "Application Files\$appFolderName")
$appBytes = [long]($appFiles | Measure-Object -Property Length -Sum).Sum
$appMB = [math]::Round($appBytes / 1MB, 1)
$sizeText = 'about {0} MB' -f [math]::Max(1, [math]::Round($appBytes / 1MB))

$info = [ordered]@{
  version                = $Version
  displayVersion         = $displayVersion
  minimumRequiredVersion = $Version
  commit                 = $commit
  publishedAt            = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  signed                 = $signed
  appSizeBytes           = $appBytes
  appFiles               = $appFiles.Count
  prerequisites          = [ordered]@{ dotnetDesktopRuntime = '10.0 x64'; webView2 = 'Evergreen'; nodeMinimumMajor = 20 }
}
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $OutDir 'version.json'), ($info | ConvertTo-Json -Depth 4) + "`n", $utf8)

$indexPath = Join-Path $OutDir 'index.html'
$html = [IO.File]::ReadAllText($indexPath)
$html = [regex]::Replace($html, '<!--app-version-->.*?<!--/app-version-->', "<!--app-version-->$displayVersion<!--/app-version-->")
$html = [regex]::Replace($html, '<!--app-size-->.*?<!--/app-size-->', "<!--app-size-->$sizeText<!--/app-size-->")
if ($signed) {
  $html = [regex]::Replace($html, '[ \t]*<!-- UNSIGNED-NOTICE:.*?<!-- /UNSIGNED-NOTICE -->[ \t]*\r?\n?', '',
    [Text.RegularExpressions.RegexOptions]::Singleline)
}
[IO.File]::WriteAllText($indexPath, $html, $utf8)

# ---------------------------------------------------------------- 9. summary
$totalBytes = (Get-ChildItem -Recurse -File $OutDir | Measure-Object -Property Length -Sum).Sum
$summary = @"
Socha Diff $Version published to $OutDir
  signed:          $signed
  app download:    $appMB MB in $($appFiles.Count) files (Application Files\$appFolderName)
  site total:      $([math]::Round($totalBytes / 1MB, 1)) MB
  setup.exe prereqs: .NET 10 Desktop Runtime=$prereqDotNet, WebView2=$prereqWebView2
Deploy the folder to the IIS site root, copying SochaDiff.application last.
"@
Write-Host "`n$summary" -ForegroundColor Green
if ($env:GITHUB_STEP_SUMMARY) {
  Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value ("### Socha Diff $Version`n``````text`n$summary`n``````")
}
if ($env:GITHUB_OUTPUT) {
  Add-Content -Path $env:GITHUB_OUTPUT -Value "app_size_bytes=$appBytes"
  Add-Content -Path $env:GITHUB_OUTPUT -Value "signed=$($signed.ToString().ToLowerInvariant())"
}
