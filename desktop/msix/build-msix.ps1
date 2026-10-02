<#
.SYNOPSIS
  Builds the MSIX packages of Socha Diff: the Store upload (.msixupload, unsigned; the Store signs it)
  and/or a sideload test package (.msix, signed with a PFX, e.g. the self-signed Socha3 cert).

.DESCRIPTION
  Windows only (Windows 10/11 SDK: makeappx.exe, makepri.exe, signtool.exe; .NET 10 SDK; network for
  the pinned Node download). No Visual Studio and no .wapproj needed. Steps:

    1. prepare-bundle.ps1 -IncludeNode  -> desktop/bundle/ (web app + production node_modules +
                                           the pinned node.exe from desktop/node-pin.json, SHA256
                                           checked against the pin AND nodejs.org SHASUMS256.txt)
    2. dotnet publish -p:PublishProfile=Msix (self-contained win-x64) -> desktop/out/msix/publish/
    3. per package kind: AppxManifest.xml from Package.appxmanifest + identity (identity.json or
       parameters) + version; resources.pri from Assets/ (makepri); makeappx pack with a mapping
       file (publish output + manifest + assets + resources.pri)
    4. Sideload: signtool sign (SHA256, RFC 3161 timestamp). Store: .msix wrapped into .msixupload.

  Output: desktop/out/msix/ (git-ignored)
    SochaDiff_<version>_x64.msixupload          Store upload (unsigned .msix inside)
    SochaDiff-sideload_<version>_x64.msix       sideload test package (signed when a PFX is given)
    SochaDiff-sideload_<version>.cer            the signing certificate's public part (to trust it)
    msix-info.json                              what was built (version, identities, sizes, node)

  ClickOnce is not touched: publish-site.ps1 runs prepare-bundle WITHOUT -IncludeNode, which
  restages desktop/bundle/ without node.exe.

.EXAMPLE
  pwsh desktop/msix/build-msix.ps1 -Build 42 -Kind Sideload -PfxPath C:\temp\socha3.pfx -PfxPassword (Read-Host -AsSecureString)
.EXAMPLE
  pwsh desktop/msix/build-msix.ps1 -Version 1.0.42.0 -Kind Store
.EXAMPLE
  pwsh desktop/msix/build-msix.ps1 -Build 1 -Kind Store,Sideload -AllowPlaceholderIdentity    # build check only
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
  # Four-part version; the 4th part must be 0 for the Store. Default <major>.<minor>.<Build>.0.
  [string]$Version,
  # Build number used when -Version is not given (CI: the run number). 0 = local build.
  [int]$Build = 0,
  # Which packages to build.
  [ValidateSet('Store', 'Sideload')]
  [string[]]$Kind = @('Store', 'Sideload'),

  # Store identity overrides (default: identity.json "store"). Must match Partner Center exactly.
  [string]$StoreName,
  [string]$StorePublisher,
  [string]$StorePublisherDisplayName,
  # Build the Store package even though its identity still contains PLACEHOLDER (build checks only;
  # such a package cannot be submitted).
  [switch]$AllowPlaceholderIdentity,

  # Sideload identity overrides (default: identity.json "sideload"; Publisher = the PFX's Subject).
  [string]$SideloadName,
  [string]$SideloadPublisher,
  # PFX for signing the sideload package. Without it the sideload .msix is unsigned (cannot be
  # installed until signed).
  [string]$PfxPath,
  [SecureString]$PfxPassword,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',

  [string]$OutDir,
  # Reuse desktop/bundle/ as is (it must contain node/node.exe and app/).
  [switch]$SkipBundle,
  # Reuse an existing desktop/out/msix/publish/ (skips prepare-bundle and dotnet publish).
  [switch]$SkipPublish
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3.0

$msixDir    = $PSScriptRoot
$desktopDir = Split-Path -Parent $msixDir
$repoRoot   = Split-Path -Parent $desktopDir
$project    = Join-Path $desktopDir 'SochaDiff.Desktop\SochaDiff.Desktop.csproj'
if (-not $OutDir) { $OutDir = Join-Path $desktopDir 'out\msix' }
$OutDir     = [IO.Path]::GetFullPath($OutDir)
$publishDir = Join-Path $OutDir 'publish'
$workDir    = Join-Path $OutDir 'work'

function Write-Step([string]$Text) { Write-Host "`n=== $Text" -ForegroundColor Cyan }
function Invoke-Tool([string]$Exe, [string[]]$Arguments, [string]$Display) {
  Write-Host "> $(Split-Path -Leaf $Exe) $(if ($Display) { $Display } else { $Arguments -join ' ' })"
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$(Split-Path -Leaf $Exe) failed with exit code $LASTEXITCODE" }
}

# ---------------------------------------------------------------- version
$verJson = Get-Content (Join-Path $desktopDir 'version.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = '{0}.{1}.{2}.0' -f [int]$verJson.major, [int]$verJson.minor, $Build }
if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)\.(\d+)$') { throw "Version must have four numeric parts: $Version" }
$parts = $Version.Split('.') | ForEach-Object { [int]$_ }
if ($parts | Where-Object { $_ -gt 65535 }) { throw "Each version part must be <= 65535: $Version" }
if ($Kind -contains 'Store' -and $parts[3] -ne 0) { throw "The Store requires the 4th version part to be 0: $Version" }
$buildNumber = $parts[2]

# ---------------------------------------------------------------- identities
$ids = Get-Content (Join-Path $msixDir 'identity.json') -Raw | ConvertFrom-Json
$storeId = [ordered]@{
  Name                 = $(if ($StoreName) { $StoreName } else { $ids.store.name })
  Publisher            = $(if ($StorePublisher) { $StorePublisher } else { $ids.store.publisher })
  PublisherDisplayName = $(if ($StorePublisherDisplayName) { $StorePublisherDisplayName } else { $ids.store.publisherDisplayName })
  DisplayName          = $ids.store.displayName
}
$sideId = [ordered]@{
  Name                 = $(if ($SideloadName) { $SideloadName } else { $ids.sideload.name })
  Publisher            = $(if ($SideloadPublisher) { $SideloadPublisher } else { $ids.sideload.publisher })
  PublisherDisplayName = $ids.sideload.publisherDisplayName
  DisplayName          = $ids.sideload.displayName
}
if ($Kind -contains 'Store') {
  $placeholder = @($storeId.Values | Where-Object { $_ -match 'PLACEHOLDER' })
  if ($placeholder.Count -gt 0) {
    if (-not $AllowPlaceholderIdentity) {
      throw "The Store identity in desktop/msix/identity.json still contains PLACEHOLDER values. Copy Name, Publisher and PublisherDisplayName from Partner Center (Product identity), or pass -StoreName/-StorePublisher/-StorePublisherDisplayName. (-AllowPlaceholderIdentity builds a check-only package.)"
    }
    Write-Warning 'Store identity contains PLACEHOLDER values: the .msixupload is a build check only and cannot be submitted.'
  }
}
foreach ($id in @($storeId, $sideId)) {
  if ($id.Name -notmatch '^[-.A-Za-z0-9]{3,50}$') { throw "Invalid package Name '$($id.Name)' (3-50 chars: letters, digits, '.', '-')." }
}

# ---------------------------------------------------------------- signing certificate (sideload)
$pfxCert = $null
$plainPassword = $null
if ($PfxPath) {
  if (-not $PfxPassword) { throw '-PfxPassword is required with -PfxPath.' }
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($PfxPassword))
  $pfxCert = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    (Resolve-Path -LiteralPath $PfxPath).Path, $plainPassword,
    [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
  Write-Host "Signing certificate: $($pfxCert.Subject) (thumbprint $($pfxCert.Thumbprint), expires $($pfxCert.NotAfter.ToString('yyyy-MM-dd')))"
  # The package Publisher must equal the signing certificate's Subject, or signtool/Add-AppxPackage refuse it.
  if (-not $SideloadPublisher -and $pfxCert.Subject -ne $sideId.Publisher) {
    Write-Warning "identity.json sideload publisher '$($sideId.Publisher)' differs from the certificate subject '$($pfxCert.Subject)'; using the certificate subject."
    $sideId.Publisher = $pfxCert.Subject
  } elseif ($pfxCert.Subject -ne $sideId.Publisher) {
    throw "Sideload Publisher '$($sideId.Publisher)' does not match the signing certificate subject '$($pfxCert.Subject)'."
  }
}

# ---------------------------------------------------------------- Windows SDK tools
if ($env:OS -ne 'Windows_NT') { throw 'build-msix.ps1 needs Windows (makeappx/makepri/signtool from the Windows SDK).' }
function Find-SdkTool([string]$Name) {
  $roots = @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "$env:ProgramFiles\Windows Kits\10\bin") | Where-Object { Test-Path $_ }
  $hit = foreach ($r in $roots) {
    Get-ChildItem -Path $r -Directory -Filter '10.*' -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName "x64\$Name") } |
      ForEach-Object { [pscustomobject]@{ Version = [version]$_.Name; Path = (Join-Path $_.FullName "x64\$Name") } }
  }
  $best = $hit | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $best) { throw "$Name not found under Windows Kits\10\bin\10.*\x64 (install the Windows 10/11 SDK)." }
  return $best.Path
}
$makeappx = Find-SdkTool 'makeappx.exe'
$makepri  = Find-SdkTool 'makepri.exe'
$signtool = Find-SdkTool 'signtool.exe'
Write-Host "Windows SDK: $(Split-Path -Parent $makeappx)"

# ---------------------------------------------------------------- 1+2. bundle + self-contained publish
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not $SkipPublish) {
  if (-not $SkipBundle) {
    Write-Step 'prepare-bundle.ps1 -IncludeNode (web app + pinned node.exe)'
    & (Join-Path $desktopDir 'scripts\prepare-bundle.ps1') -IncludeNode
  }
  $bundleNode = Join-Path $desktopDir 'bundle\node\node.exe'
  if (-not (Test-Path -LiteralPath $bundleNode)) { throw "desktop/bundle/node/node.exe is missing (run prepare-bundle.ps1 -IncludeNode)." }

  Write-Step "dotnet publish (self-contained win-x64, $Version)"
  if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }
  Invoke-Tool 'dotnet' @('publish', $project, '-p:PublishProfile=Msix', '-p:SelfContained=true',
    "-p:PublishDir=$publishDir\", "-p:SochaBuildNumber=$buildNumber", "-p:FileVersion=$Version", "-p:AssemblyVersion=$Version",
    '-nologo', '-v:minimal')
}
foreach ($required in 'SochaDiff.exe', 'coreclr.dll', 'node\node.exe', 'app\server.js', 'app\node_modules\express\package.json') {
  if (-not (Test-Path -LiteralPath (Join-Path $publishDir $required))) { throw "Publish output is missing $required ($publishDir)." }
}
$publishFiles = @(Get-ChildItem -LiteralPath $publishDir -Recurse -File)
$publishBytes = ($publishFiles | Measure-Object Length -Sum).Sum
$nodeVersion = $null
try { $nodeVersion = (& (Join-Path $publishDir 'node\node.exe') --version).Trim() } catch { }
Write-Host ("Payload: {0} files, {1:N1} MB (node {2})" -f $publishFiles.Count, ($publishBytes / 1MB), $nodeVersion)

# ---------------------------------------------------------------- 3. per-kind manifest, PRI, pack
function New-Package([string]$KindName, $Id, [string]$FileStem) {
  $dir = Join-Path $workDir $KindName
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item -Recurse (Join-Path $msixDir 'Assets') (Join-Path $dir 'Assets')

  # AppxManifest.xml with this identity and version.
  [xml]$m = Get-Content -Raw (Join-Path $msixDir 'Package.appxmanifest')
  $ns = [Xml.XmlNamespaceManager]::new($m.NameTable)
  $ns.AddNamespace('f', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
  $ns.AddNamespace('uap', 'http://schemas.microsoft.com/appx/manifest/uap/windows10')
  $identity = $m.SelectSingleNode('/f:Package/f:Identity', $ns)
  $identity.SetAttribute('Name', $Id.Name)
  $identity.SetAttribute('Publisher', $Id.Publisher)
  $identity.SetAttribute('Version', $Version)
  $m.SelectSingleNode('/f:Package/f:Properties/f:PublisherDisplayName', $ns).InnerText = $Id.PublisherDisplayName
  $m.SelectSingleNode('/f:Package/f:Properties/f:DisplayName', $ns).InnerText = $Id.DisplayName
  $m.SelectSingleNode('/f:Package/f:Applications/f:Application/uap:VisualElements', $ns).SetAttribute('DisplayName', $Id.DisplayName)
  $manifest = Join-Path $dir 'AppxManifest.xml'
  $settings = [Xml.XmlWriterSettings]@{ Indent = $true; Encoding = [Text.UTF8Encoding]::new($false) }
  $w = [Xml.XmlWriter]::Create($manifest, $settings); try { $m.Save($w) } finally { $w.Dispose() }

  # resources.pri: maps Assets\Square44x44Logo.png etc. to the scale-/targetsize-qualified files.
  # createconfig's default <packaging> section would split resources into extra .pri files; drop it.
  $priConfig = Join-Path $workDir "priconfig-$KindName.xml"
  Invoke-Tool $makepri @('createconfig', '/cf', $priConfig, '/dq', 'en-US', '/pv', '10.0.0', '/o')
  [xml]$pc = Get-Content -Raw $priConfig
  $pkg = $pc.SelectSingleNode('/resources/packaging'); if ($pkg) { [void]$pkg.ParentNode.RemoveChild($pkg) }
  $pc.Save($priConfig)
  Invoke-Tool $makepri @('new', '/pr', $dir, '/cf', $priConfig, '/mn', $manifest, '/of', (Join-Path $dir 'resources.pri'), '/o')

  # Mapping file: everything from the publish folder plus the manifest, assets and resources.pri.
  $map = [Text.StringBuilder]::new()
  [void]$map.AppendLine('[Files]')
  $q = { param($s) '"' + $s + '"' }
  foreach ($f in $publishFiles) {
    $rel = [IO.Path]::GetRelativePath($publishDir, $f.FullName)
    if ($rel -ieq 'AppxManifest.xml' -or $rel -ieq 'resources.pri') { continue }
    [void]$map.AppendLine("$(& $q $f.FullName) $(& $q $rel)")
  }
  foreach ($f in Get-ChildItem -LiteralPath $dir -Recurse -File) {
    [void]$map.AppendLine("$(& $q $f.FullName) $(& $q ([IO.Path]::GetRelativePath($dir, $f.FullName)))")
  }
  $mapFile = Join-Path $workDir "mapping-$KindName.txt"
  [IO.File]::WriteAllText($mapFile, $map.ToString(), [Text.UTF8Encoding]::new($false))

  $msix = Join-Path $OutDir "${FileStem}_${Version}_x64.msix"
  if (Test-Path $msix) { Remove-Item -Force $msix }
  Invoke-Tool $makeappx @('pack', '/f', $mapFile, '/p', $msix, '/o', '/h', 'SHA256')
  return $msix
}

$results = [ordered]@{}

if ($Kind -contains 'Sideload') {
  Write-Step "Sideload package ($($sideId.Name), $($sideId.Publisher))"
  $msix = New-Package 'sideload' $sideId 'SochaDiff-sideload'
  $signed = $false
  if ($pfxCert) {
    $signArgs = @('sign', '/fd', 'SHA256', '/f', (Resolve-Path -LiteralPath $PfxPath).Path, '/p', $plainPassword)
    if ($TimestampUrl) { $signArgs += @('/tr', $TimestampUrl, '/td', 'SHA256') }
    $signArgs += $msix
    Invoke-Tool $signtool $signArgs "sign /fd SHA256 /f <pfx> /p <redacted> /tr $TimestampUrl /td SHA256 $(Split-Path -Leaf $msix)"
    # signtool's exit code is authoritative; this is a readable cross-check (MSIX SIP on Windows 10+).
    $sig = Get-AuthenticodeSignature -LiteralPath $msix
    if ($sig.SignerCertificate -and $sig.SignerCertificate.Thumbprint -ne $pfxCert.Thumbprint) {
      throw "The sideload package is signed with $($sig.SignerCertificate.Thumbprint), expected $($pfxCert.Thumbprint)."
    }
    if (-not $sig.SignerCertificate) { Write-Warning "Get-AuthenticodeSignature could not read the package signature (status: $($sig.Status)); signtool reported success." }
    $cer = Join-Path $OutDir "SochaDiff-sideload_$Version.cer"
    [IO.File]::WriteAllBytes($cer, $pfxCert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    $signed = $true
    Write-Host "Signed with $($pfxCert.Subject) ($($pfxCert.Thumbprint)); signature status $($sig.Status) (UnknownError/NotTrusted is expected for a self-signed cert until it is trusted)."
  } else {
    Write-Warning 'No -PfxPath: the sideload .msix is UNSIGNED and cannot be installed until signed.'
  }
  $results.sideload = [ordered]@{ file = Split-Path -Leaf $msix; bytes = (Get-Item $msix).Length; signed = $signed
    name = $sideId.Name; publisher = $sideId.Publisher; thumbprint = $(if ($pfxCert) { $pfxCert.Thumbprint } else { $null }) }
}

if ($Kind -contains 'Store') {
  Write-Step "Store package ($($storeId.Name), $($storeId.Publisher))"
  $msix = New-Package 'store' $storeId 'SochaDiff'
  # .msixupload = zip of the (unsigned) .msix; Partner Center signs the package with the Store's cert.
  $upload = [IO.Path]::ChangeExtension($msix, '.msixupload')
  if (Test-Path $upload) { Remove-Item -Force $upload }
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::Open($upload, [IO.Compression.ZipArchiveMode]::Create)
  try { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $msix, (Split-Path -Leaf $msix), [IO.Compression.CompressionLevel]::NoCompression) }
  finally { $zip.Dispose() }
  $results.store = [ordered]@{ file = Split-Path -Leaf $upload; msix = Split-Path -Leaf $msix; bytes = (Get-Item $upload).Length
    name = $storeId.Name; publisher = $storeId.Publisher; publisherDisplayName = $storeId.PublisherDisplayName
    placeholder = [bool]($storeId.Values -match 'PLACEHOLDER') }
}

$pin = Get-Content (Join-Path $desktopDir 'node-pin.json') -Raw | ConvertFrom-Json
$commit = ''; try { $commit = (git -C $repoRoot rev-parse --short HEAD 2>$null) } catch { }
$info = [ordered]@{
  version = $Version; commit = $commit; builtAt = (Get-Date).ToString('o')
  payloadFiles = $publishFiles.Count; payloadBytes = $publishBytes
  node = [ordered]@{ version = $pin.version; reported = $nodeVersion; zip = $pin.file; sha256 = $pin.sha256 }
  packages = $results
}
$info | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $OutDir 'msix-info.json')
if ($env:GITHUB_OUTPUT) {
  Add-Content $env:GITHUB_OUTPUT "version=$Version"
  if ($results.Contains('store')) { Add-Content $env:GITHUB_OUTPUT "store=$(Join-Path $OutDir $results.store.file)" }
  if ($results.Contains('sideload')) { Add-Content $env:GITHUB_OUTPUT "sideload=$(Join-Path $OutDir $results.sideload.file)"; Add-Content $env:GITHUB_OUTPUT "sideload_signed=$($results.sideload.signed.ToString().ToLower())" }
}
Write-Step 'Done'
Get-ChildItem -LiteralPath $OutDir -File | ForEach-Object { Write-Host ("{0,-55} {1,10:N1} MB" -f $_.Name, ($_.Length / 1MB)) }
