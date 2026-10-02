<#
.SYNOPSIS
  Installs a signed sideload .msix, launches it, and checks that the packaged app really works
  as a package: SochaDiff.exe starts, the BUNDLED node.exe starts the server (server.log says
  "server ready"), and killing SochaDiff.exe also kills node (Job Object). Removes the package.

.DESCRIPTION
  For CI (GitHub-hosted windows-latest, elevated) and for a quick manual check on a test PC. Needs
  admin to trust the certificate in Cert:\LocalMachine\TrustedPeople (skipped with -SkipTrust when
  the certificate is already trusted or Developer Mode is on). The app shows its window; on a
  machine without the WebView2 Runtime the server never starts and the test reports that.

.EXAMPLE
  pwsh desktop/msix/smoke-test.ps1 -MsixPath desktop/out/msix/SochaDiff-sideload_1.0.0.0_x64.msix -CerPath desktop/out/msix/SochaDiff-sideload_1.0.0.0.cer
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$MsixPath,
  [string]$CerPath,
  [switch]$SkipTrust,
  [int]$TimeoutSeconds = 120,
  # Leave the package installed afterwards.
  [switch]$Keep
)
$ErrorActionPreference = 'Stop'
$MsixPath = (Resolve-Path -LiteralPath $MsixPath).Path

$trusted = $null
if (-not $SkipTrust -and $CerPath) {
  $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $CerPath).Path)
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPeople', 'LocalMachine')
  $store.Open('ReadWrite'); $store.Add($cert); $store.Close()
  $trusted = $cert
  Write-Host "Trusted $($cert.Subject) ($($cert.Thumbprint)) in LocalMachine\TrustedPeople"
}

$failures = [Collections.Generic.List[string]]::new()
$pkg = $null
try {
  # Identity Name/Version from the package's own AppxManifest.xml (an .msix is a zip).
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($MsixPath)
  try {
    $reader = [IO.StreamReader]::new($zip.GetEntry('AppxManifest.xml').Open())
    try { [xml]$pm = $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $zip.Dispose() }
  $name = $pm.Package.Identity.Name; $version = $pm.Package.Identity.Version
  Write-Host "Package $name $version ($($pm.Package.Identity.Publisher))"

  Add-AppxPackage -Path $MsixPath -ForceApplicationShutdown
  $pkg = Get-AppxPackage -Name $name | Where-Object { $_.Version -eq $version } | Select-Object -First 1
  if (-not $pkg) { throw "Installed package $name $version not found." }
  Write-Host "Installed $($pkg.PackageFullName)`n  at $($pkg.InstallLocation)"
  $manifest = Get-AppxPackageManifest $pkg
  $appId = $manifest.Package.Applications.Application.Id

  $logs = @(
    (Join-Path $env:LOCALAPPDATA "Packages\$($pkg.PackageFamilyName)\LocalCache\Local\SochaDiff\server.log"),  # virtualized (fresh PC)
    (Join-Path $env:LOCALAPPDATA 'SochaDiff\server.log')                                                       # existing real folder
  )
  $started = Get-Date
  Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!$appId"

  $log = $null; $text = ''
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $log = $logs | Where-Object { (Test-Path $_) -and (Get-Item $_).LastWriteTime -ge $started.AddSeconds(-5) } | Select-Object -First 1
    if ($log) {
      $text = Get-Content -Raw -LiteralPath $log -ErrorAction SilentlyContinue
      if ($text -match 'server ready at' -or $text -match 'startup failed|could not start|exited with code') { break }
    }
  }
  if ($log) { Write-Host "`n--- $log"; Write-Host $text; Write-Host '---' } else { $failures.Add("no server.log written within $TimeoutSeconds s (looked at: $($logs -join '; '))") }

  if ($text -notmatch 'host: MSIX package ') { $failures.Add('the host did not detect package identity') }
  if ($text -notmatch 'bundled node in the MSIX package') { $failures.Add('the bundled node.exe was not used') }
  if ($text -notmatch 'server ready at') { $failures.Add('the server did not become ready') }
  if ($text -match 'could not assign node to the job object') { $failures.Add('node was not placed in the job object') }

  $hosts = @(Get-Process SochaDiff -ErrorAction SilentlyContinue)
  $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($pkg.InstallLocation, [StringComparison]::OrdinalIgnoreCase) })
  Write-Host "SochaDiff.exe processes: $($hosts.Count); packaged node.exe processes: $($nodes.Count) $(($nodes | ForEach-Object { "pid $($_.ProcessId) $($_.ExecutablePath)" }) -join ', ')"
  if ($text -match 'server ready at' -and $nodes.Count -eq 0) { $failures.Add('no node.exe from the package install folder is running') }

  # Kill the host hard: the KILL_ON_JOB_CLOSE job must take node with it.
  $hosts | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $left = @($nodes | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
  if ($left.Count -gt 0) { $failures.Add("node.exe still running after SochaDiff.exe was killed: $($left.ProcessId -join ', ')"); $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
  elseif ($nodes.Count -gt 0) { Write-Host 'node.exe exited with the host (job object OK).' }
}
finally {
  if ($pkg -and -not $Keep) { Remove-AppxPackage -Package $pkg.PackageFullName -ErrorAction SilentlyContinue; Write-Host "Removed $($pkg.PackageFullName)" }
  if ($trusted) {
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPeople', 'LocalMachine')
    $store.Open('ReadWrite'); $store.Remove($trusted); $store.Close()
  }
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Host "::error::MSIX smoke test: $_" }
  exit 1
}
Write-Host 'MSIX smoke test passed: package identity, bundled node, server ready, job object.'
