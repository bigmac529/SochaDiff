# Socha Diff in the Microsoft Store (MSIX)

The desktop app can also be packaged as **MSIX** for the Microsoft Store, next to the ClickOnce
release on https://sochadiff.socha3.com/. Nothing about ClickOnce changes: `publish-desktop.yml`,
`ClickOnce.pubxml`, `publish-site.ps1` and the framework-dependent build are untouched, and the MSIX
workflow is manual (plus a build-only check on pull requests).

> Status (2026-10-01): packaging, assets and workflow are written and checked on Linux (compile,
> self-contained publish layout and size, manifest XML, script parsing, actionlint). **Nothing has
> been built with makeappx or installed on real Windows yet**; the PR check on `windows-latest` is the
> first real run. Partner Center values are placeholders until the name is reserved.

## What is in the package

| | ClickOnce (site) | MSIX (Store / sideload) |
|---|---|---|
| .NET | framework-dependent, .NET 10 Desktop Runtime is a prerequisite | **self-contained** win-x64 (no prerequisite) |
| Node.js | user-installed prerequisite (20+), found via SOCHA_NODE/PATH/Program Files/nvm/fnm/Volta... | **bundled** pinned `node.exe` (24.21.0 LTS, `node-pin.json`), preferred when packaged |
| WebView2 | prerequisite (built into Windows 11) | same (Evergreen runtime, built into Windows 11; Windows 10 usually has it via Edge) |
| Updates | ClickOnce checks the site at every start | the Store updates the package; no update code in the app |
| Signing | self-signed `CN=Socha3` | Store: signed by Microsoft. Sideload test: `CN=Socha3` |
| Size | ~6 MB | ~237 MB installed (842 files: .NET ~139 MB, node.exe ~94 MB, web app ~4 MB); ~97 MB compressed (measured with a zip of the same payload; the .msix should be similar) |

Files:

```
desktop/msix/
  Package.appxmanifest    the manifest template (placeholders; build-msix.ps1 fills identity + version)
  identity.json           Store identity (PLACEHOLDER until Partner Center) + sideload test identity (CN=Socha3)
  Assets/                 77 PNGs: Square44x44 (scale + targetsize, plated/unplated), 71/150/310 tiles,
                          Wide310x150, StoreLogo, SplashScreen; generated, committed
  generate-assets.sh      regenerates Assets/ from site/favicon.svg (rsvg-convert + ImageMagick)
  build-msix.ps1          prepare-bundle -IncludeNode -> self-contained publish -> makepri -> makeappx -> sign
  smoke-test.ps1          installs the signed sideload package, launches it, checks bundled node + job object
desktop/SochaDiff.Desktop/
  PackageIdentity.cs      GetCurrentPackageFullName: packaged or not
  Properties/PublishProfiles/Msix.pubxml   self-contained folder publish (MSIX payload only)
.github/workflows/package-msix.yml        manual build (+ PR build check), GitHub-hosted windows-latest only
site/privacy.html         privacy policy (required for the Store listing)
```

## Design choices

**Packaging: MakeAppx + hand-written manifest** (not a `.wapproj`, not single-project MSIX).

- It builds with the .NET SDK and the Windows SDK tools (`makeappx`, `makepri`, `signtool`), which
  `windows-latest` already has; no Visual Studio project type, no extra NuGet tooling.
- It does not touch `SochaDiff.Desktop.csproj`. Single-project MSIX (`EnableMsixTooling`,
  `Microsoft.Windows.SDK.BuildTools.MSIX`) would put MSIX properties into the same project the
  ClickOnce publish uses; a `.wapproj` needs VS's DesktopBridge targets, is edited through VS
  designers and hides the manifest/mapping logic. Both make it harder to see what goes into the
  package, and both add risk to the ClickOnce path.
- Everything is explicit and reviewable: one manifest, one mapping file, one script. The payload
  is a normal `dotnet publish` folder, so what runs packaged is exactly what runs unpackaged.
- Cost: the script must keep up with SDK tool flags itself (they have been stable for years).

**Self-contained .NET.** The Store has no framework package for the .NET 10 Desktop Runtime, and
a Store user should not hit Windows' ".NET is required" dialog. Self-contained adds ~139 MB
uncompressed. Trimming is not used (WPF is not trim-safe).

**Bundled Node.** `prepare-bundle.ps1 -IncludeNode` downloads `node-v24.21.0-win-x64.zip` from
nodejs.org, checks its SHA256 against both `node-pin.json` and the official `SHASUMS256.txt`, and
stages `bundle/node/node.exe`. When the app has package identity (`PackageIdentity.IsPackaged`),
`NodeLocator` tries that `node.exe` **first**; if it fails its probe, the normal search continues
(SOCHA_NODE, PATH, ...), so a broken bundle degrades to the ClickOnce behavior instead of failing.
ClickOnce/dev builds keep the existing discovery order unchanged. Update the pin (version, file,
sha256) to move to a newer LTS (Node 26 is scheduled to become LTS in October 2026).

**Manifest.** `EntryPoint="Windows.FullTrustApplication"` + `rescap:runFullTrust`, nothing else.
MinVersion 10.0.19041.0 (Windows 10 2004), MaxVersionTested 10.0.26100.0, x64, language en-us.

## Behavior when packaged (and what still needs a Windows test)

### Settings and logs (`%LOCALAPPDATA%\SochaDiff`)

The code is unchanged and works: packaged full-trust desktop apps can read and write
`%LOCALAPPDATA%`. Since Windows 10 1903, **new** files and folders that a packaged desktop app
creates under `AppData\Local` (and `Roaming`) are redirected to a per-user, per-package location,
`%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Local\SochaDiff\`, and merged back so the app
(and its child processes such as `node.exe`) still see `%LOCALAPPDATA%\SochaDiff`. Existing files are
used in place. Consequences:

- Fresh Store install: settings, logs and the WebView2 profile live in the package's private
  location and are **deleted on uninstall** (good Store behavior). To read the log from outside the
  app, look in `%LOCALAPPDATA%\Packages\<family>\LocalCache\Local\SochaDiff\server.log`.
- PC that also has the ClickOnce version: `%LOCALAPPDATA%\SochaDiff` already exists, so the Store
  app uses it in place: **shared settings and last folders** with ClickOnce. Running both at the same
  time works for logs (the second instance writes `server.<pid>.log`), but both would use one
  WebView2 profile; if that turns out to conflict, give the packaged app its own data folder name.
- Sources: [How packaged desktop apps run](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)
  (AppData operations on 1903 and later), [Flexible virtualization](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization).
  Turning virtualization off would need the restricted `unvirtualizedResources` capability; not used.

### File system access: no `broadFileSystemAccess`

Not needed and not declared. `broadFileSystemAccess` grants access through the
`Windows.Storage` APIs for apps in an AppContainer (UWP-style). Socha Diff is a full-trust
(medium integrity) desktop app: it runs outside the AppContainer "with the same permissions as a
standard desktop app", and Node's `fs` uses plain Win32 file APIs. So it reads and writes any path the
user can, like the ClickOnce version. Writes inside the package folder are blocked (read-only),
which the app never does.

- [MSIX containerization overview](https://learn.microsoft.com/en-us/windows/msix/msix-containerization-overview):
  "Full trust apps run with the same permissions as a standard desktop app."
- [App capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations):
  broadFileSystemAccess "works for the Windows.Storage APIs"; runFullTrust is what a package with
  full-trust apps needs.
- [Manifest for packaged desktop apps](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion):
  full-trust apps declare `runFullTrust`.

### Child processes and the job object

- **node.exe** is started by `SochaDiff.exe` with `CreateProcess` (`UseShellExecute=false`) from the
  package folder, so it runs inside the package (identity + the same AppData view). Windows 11 does
  this automatically for executables inside the package; on Windows 10 2004+ packaged desktop
  children stay in the package context by default. Risk: if an older Windows 10 build refuses to
  start node from `WindowsApps`, `NodeLocator` logs it and falls back to an installed Node.
- **Open / Open with / Open folder** (`cmd /c start`, `rundll32 shell32.dll,OpenAs_RunDLL`,
  `explorer.exe` from `server.js`): these start outside the package's install folder. `start` and
  the Open With dialog launch the chosen app through ShellExecute, and `explorer.exe <folder>` hands
  the window to the running shell, so the opened apps normally run outside Socha Diff's container.
  **Risk to test:** if an opened app does stay in Socha Diff's package context, its new AppData files
  would be virtualized into Socha Diff's package (and removed when Socha Diff is uninstalled). The
  fix, if needed, is to start node with `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY` =
  `PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE` (node stays in the package, its
  children break away; [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)).
- **Job object** (`JobObject.cs`, `KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK`): nested jobs are
  supported since Windows 8, so it also works if the packaged process is already in a job.
  If assigning fails, the app logs `could not assign node to the job object` and still kills node on
  normal close. **Risk to test:** that apps opened via Open/Open with survive closing Socha Diff in the
  packaged build too (breakaway must be allowed by every job in the chain).
- `smoke-test.ps1` (run by the workflow) checks package identity, that the bundled node is used and
  serves `/api/health`, and that killing `SochaDiff.exe` kills node. It does not click Open/Open with.

## Step by step for Michael

### 1. Partner Center account (one time)

1. Go to **https://storedeveloper.microsoft.com** -> **Get started for free** -> **Individual
   developer**, sign in with your personal Microsoft account, verify with a government ID + selfie.
2. Fee: **none**. Microsoft waived the former $19 individual fee in the new onboarding flow
   ("No registration fee | The $19 registration fee is waived in the new flow"), and company accounts
   are now free too. It only applies when you start at storedeveloper.microsoft.com (other entry
   points show the legacy flow). Sources:
   [Free developer registration for individual developers](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer),
   [Account types, locations and fees](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/account-types-locations-and-fees),
   [Windows Developer Blog, 2025-09-10](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/).
   An individual account publishes under your own name (the PublisherDisplayName); it cannot be
   converted to a company account later.

### 2. Reserve the name and copy the identity

1. Partner Center -> **Apps and games** -> **New product** -> **MSIX or PWA app** -> name
   **Socha Diff** -> **Check availability** -> **Reserve product name**
   ([docs](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/reserve-your-apps-name)).
2. **Product management -> Product identity**
   ([docs](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)) shows
   three values. Copy them exactly into `desktop/msix/identity.json` -> `"store"`:
   - `Package/Identity/Name` -> `name` (e.g. `12345Socha.SochaDiff`)
   - `Package/Identity/Publisher` -> `publisher` (e.g. `CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`)
   - `Package/Properties/PublisherDisplayName` -> `publisherDisplayName`
3. Commit that through a PR (the values are not secrets). Until then you can pass them as the
   workflow inputs `store_name` / `store_publisher` / `store_publisher_display_name` instead. Any value
   that still contains `PLACEHOLDER` makes the workflow skip the `.msixupload` with a warning.

### 3. Build the packages

GitHub -> **Actions** -> **Package MSIX (Microsoft Store)** -> **Run workflow** (branch `main`; the
workflow must be on the default branch to be dispatched). Inputs: `build_number` (empty = run
number; must go up for each Store submission), `store`, `sideload`, `smoke_test`, and the identity
overrides. It runs on GitHub-hosted `windows-latest` only, never on the self-hosted runner, and
produces:

- `sochadiff-msix-store-<version>`: `SochaDiff_<version>_x64.msixupload` (unsigned; the Store signs it)
- `sochadiff-msix-sideload-<version>`: `SochaDiff-sideload_<version>_x64.msix` signed with the Socha3
  cert (secrets `SIGNING_PFX_BASE64`/`SIGNING_PFX_PASSWORD`) + `SochaDiff-sideload_<version>.cer`
- a job summary with sizes and the smoke-test result

Locally (Windows, pwsh 7, .NET 10 SDK, Windows SDK):

```powershell
pwsh desktop/msix/build-msix.ps1 -Build 5 -Kind Sideload -PfxPath C:\temp\socha3.pfx -PfxPassword (Read-Host -AsSecureString)
pwsh desktop/msix/build-msix.ps1 -Build 5 -Kind Store            # needs the real identity in identity.json
# -> desktop/out/msix/
```

It restages `desktop/bundle/` **with** node.exe; a later ClickOnce publish (`publish-site.ps1`) runs
prepare-bundle again without node, so ClickOnce stays small.

### 4. Sideload test (before submitting)

1. Either trust the Socha3 certificate for packages: double-click the `.cer` -> **Install
   Certificate** -> **Local Machine** -> **Place all certificates in the following store** ->
   **Trusted People** (admin), or in an elevated PowerShell:
   `Import-Certificate -FilePath .\SochaDiff-sideload_<version>.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople`.
   (Developer Mode alone lets you register an unpacked folder with `Add-AppxPackage -Register`, but
   a signed .msix still needs a trusted cert; see
   [Enable your device for development](https://learn.microsoft.com/en-us/windows/apps/get-started/enable-your-device-for-development).)
2. Double-click the `.msix` (App Installer) or `Add-AppxPackage .\SochaDiff-sideload_<version>_x64.msix`.
   It installs as **Socha Diff (sideload test)**, side by side with ClickOnce and a later Store install.
3. Check: Start menu tile/icon, compare two real folders, Settings, Copy, **open a file, Open with,
   open folder, then close Socha Diff: the opened apps must stay open**, Task Manager shows
   `node.exe` under Socha Diff and it disappears on close, `server.log` (see above) says
   `MSIX package ...` and `using node v24.21.0 ... (found via bundled node in the MSIX package)`.
4. Optional: run the Windows App Certification Kit (`appcert.exe`, in the Windows SDK) on the Store
   `.msix` (inside the `.msixupload`, it is a zip) to see certification issues early.
5. Uninstall: Settings -> Apps -> Socha Diff (sideload test) -> Uninstall.

### 5. Submit

In the product's **Start your submission**
([docs](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission)):

1. **Pricing and availability**: Free, markets, visibility (you can start with "Private audience"
   or "hidden" for a test).
2. **Properties**: category **Developer tools** (or Productivity); no special hardware.
3. **Age ratings**: the IARC questionnaire
   ([docs](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/age-ratings)).
   Answers for Socha Diff: no violence, sexual content, gambling, drugs or user-to-user interaction;
   no sharing of location or personal info; it opens web links only in the default browser. That
   gives the lowest rating (e.g. IARC 3+ / ESRB Everyone).
4. **Packages**: upload `SochaDiff_<version>_x64.msixupload`
   ([docs](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages)).
   Partner Center rejects it if Name/Publisher do not match the reservation.
5. **Store listings** (English)
   ([docs](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-and-edit-store-listing-info)):
   description, at least one screenshot, privacy policy URL, and optionally features/keywords. Draft
   text is below.
6. **Submission options**
   ([docs](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options)):
   **Restricted capabilities -> runFullTrust** must be explained, e.g. "Socha Diff is a Win32 (WPF)
   desktop app packaged as MSIX. runFullTrust is needed to run it as a full-trust desktop app; it
   starts its bundled Node.js runtime as a local, loopback-only server for its UI." Certification
   notes: "No account or sign-in needed. Compare any two folders, e.g. two copies of a project."
7. **Submit for certification** (usually a few business days for a first submission).

### 6. Privacy policy (required)

Microsoft Store Policies 10.5.1: "Product types that inherently have access to Personal Information
must always have privacy policies. These include, but are not limited to, Desktop Bridge and Win32
products" ([Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)).
This PR adds **`site/privacy.html`** (no data collected; local-only comparisons; what is stored on
the PC; update checks; links; server/CDN access logs) and a footer link. It goes live with the next
site deploy, i.e. when this PR is merged. Privacy policy URL for the listing:
**https://sochadiff.socha3.com/privacy.html**. Re-read it before submitting and adjust anything
that is not accurate for you (e.g. whether the IIS/Cloudflare logs are kept).

### 7. Screenshots and listing text

Screenshots ([requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images)):
PNG, at least **1366x768** (up to 3840x2160), at least one, 4-8 recommended. Take them from the real
app window (Win+Shift+S or `record-scenes.js` frames at 1366x768+): side-by-side diff, summary chips
filtering, unified view, whitespace chars, Settings dialog, Make B match A confirmation. Optional
Store logos: 1:1 box art (e.g. 1080x1080 from `site/favicon.svg`).

Draft listing:

- **Short description**: Compare two folders and see every real (non-whitespace) difference.
- **Description**: Socha Diff compares two folders, including all subfolders, and shows every file
  that differs, exists on one side only, or is identical. Whitespace-only changes (indentation,
  spacing, blank lines, CRLF vs LF) are ignored by default, so you see only the changes that
  matter, side by side or unified, with changed characters highlighted. Filter results with summary
  chips, expand hidden lines, copy exact text from either side, open files in their default app,
  and make one folder match the other after a safety check and confirmation. Everything runs on your
  PC: no account, no telemetry, nothing uploaded.
- **Features**: Side-by-side and unified diffs; Whitespace-aware or whitespace-ignoring comparison;
  Visible whitespace and line endings; Excluded folder names (node_modules, .git, bin, obj...);
  Case-sensitivity detection per folder; Make A match B / Make B match A with change detection;
  Works offline.
- **Keywords**: diff, compare folders, folder compare, directory diff, whitespace, code review.
- **Support / website**: https://sochadiff.socha3.com/ (guide: /guide.html).

### 8. Keeping ClickOnce alongside

- Both stay: the site keeps offering ClickOnce (`publish-desktop.yml` on every merge), the Store
  offers MSIX. They are different apps to Windows (ClickOnce identity vs package family) and install
  side by side. Users who want Store updates can uninstall the ClickOnce version.
- Shared data: see "Settings and logs" above (a PC with both uses one `%LOCALAPPDATA%\SochaDiff`).
- Versions: ClickOnce uses publish-desktop's run number, MSIX uses this workflow's run number (or
  `build_number`), so the third part differs between channels. Each channel's numbers only go up.
  Set `build_number` explicitly if you want them aligned (it must still increase per Store submission).
- Later, a Store link/badge can be added to `site/index.html` once the listing is live.
