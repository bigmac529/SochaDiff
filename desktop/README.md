# Socha Diff desktop host (Windows)

A small .NET 10 WPF app (`SochaDiff.exe`) that shows the Socha Diff web UI in a
full-window WebView2 and runs the web app's Node server privately on a random
loopback port. Nothing about the web app changes: it is the same `server.js` +
`lib/` + `public/`.

It is **framework-dependent**: the app download is only the host plus the web app
(about 6 MB). Three prerequisites are installed once, separately:

| Prerequisite | Why | If missing |
|---|---|---|
| .NET 10 Desktop Runtime (x64) | runs the WPF host | the apphost shows Windows' ".NET is required" dialog with a download link; `setup.exe` can install it |
| Microsoft Edge WebView2 Runtime | renders the UI (built into Windows 11) | in-app panel with a download button; `setup.exe` can install it |
| Node.js 20+ (LTS recommended) | runs `server.js` | in-app panel: needed version, **Get Node.js**, **All prerequisites**, **Retry** |

The download page (`site/`, published to https://sochadiff.socha3.com/) lists them with
links, sizes and "check what you have" commands.

```
desktop/
  SochaDiff.sln
  version.json                     major/minor of the app (build number comes from CI)
  node-pin.json                    minimum Node major + the Node pinned for -IncludeNode builds
  bootstrapper/Socha3.WebView2Runtime/   ClickOnce setup.exe package for WebView2 (VS has none)
  scripts/prepare-bundle.ps1       stages desktop/bundle/ (Windows, PowerShell 5.1 or 7)
  scripts/prepare-bundle.sh        same for Linux/macOS/Git Bash (CI, compile checks)
  scripts/publish-site.ps1         prepare-bundle + ClickOnce publish + site assembly -> desktop/out/site/
  scripts/deploy-site.ps1          uploads desktop/out/site/ (Web Deploy or folder copy)
  scripts/record-demo.js           re-records the site's demo video/GIF from a real session (Linux)
  bundle/                          git-ignored staging folder (created by the scripts)
  out/                             git-ignored publish-site output
  SochaDiff.Desktop/
    SochaDiff.Desktop.csproj       net10.0-windows, win-x64, framework-dependent, Microsoft.Web.WebView2
    App.xaml(.cs)                  palette, unhandled-exception logging
    MainWindow.xaml(.cs)           WebView2, loading/error/prerequisite panels, link + menu policy
    NodeServer.cs                  port pick, node launch, logging, health polling
    NodeLocator.cs                 finds the user's Node.js (>= 20)
    JobObject.cs                   KILL_ON_JOB_CLOSE job for node.exe
    AppPaths.cs                    %LOCALAPPDATA%\SochaDiff paths, dev overrides
    Properties/PublishProfiles/
      ClickOnce.pubxml             https://sochadiff.socha3.com/, framework-dependent
      Folder.pubxml                plain framework-dependent folder, for local testing
../site/                           the static download page (vanilla HTML/CSS/JS, web.config)
../.github/workflows/publish-desktop.yml   publishes on every push to main
```

## Prepare the bundle

`node_modules` (and `node.exe`, for portable builds) are never committed. Stage the web app
once, and again after changing `server.js`, `lib/`, `public/` or dependencies:

```powershell
pwsh desktop/scripts/prepare-bundle.ps1            # or: powershell -File desktop\scripts\prepare-bundle.ps1
pwsh desktop/scripts/prepare-bundle.ps1 -IncludeNode   # portable/full build that also bundles node.exe
```

It writes `desktop/bundle/`:

- `app/server.js`, `app/lib/`, `app/public/`, `app/package.json`, `app/package-lock.json`
- `app/node_modules/` from `npm ci --omit=dev --ignore-scripts` (Node/npm 20+ on PATH);
  dot-entries (`.bin`, `.github`, lint configs) are removed
- `bundle-info.json` (git commit, dirty flag, time, Node requirement), logged at startup
- with `-IncludeNode` only: `node/node.exe` + `LICENSE` from the Node pinned in
  `node-pin.json` (currently **24.21.0 LTS**), SHA256-checked against the pin and the official
  `SHASUMS256.txt` (download cached in `desktop/.cache/`). This adds ~90 MB, so the ClickOnce
  release never uses it; it exists for a portable copy that runs without installing Node.

`node-pin.json` also holds `minimumMajor` (20), which prepare-bundle enforces for the build
machine. The app's own check is `NodeLocator.MinimumMajor` (keep them in sync).

The csproj includes everything under `bundle/` as `Content` (copied to the output and listed
in the ClickOnce manifest). Building without `bundle/app` only warns (`SOCHA001`); publishing
without it fails (`SOCHA002`).

## Build and run

```powershell
cd desktop
dotnet build SochaDiff.sln                 # Debug: DevTools (F12) enabled
dotnet run --project SochaDiff.Desktop
```

Or open `desktop/SochaDiff.sln` in Visual Studio and press F5. The project sets
`EnableWindowsTargeting=true`, so `dotnet build` also works on Linux/macOS as a
compile check (the app itself only runs on Windows). It needs the .NET 10 SDK.

Dev overrides (environment variables read by the host):

- `SOCHA_DESKTOP_APP_DIR`: run a different web app folder, e.g. the repo root, to
  test `public/` edits without re-running prepare-bundle. That folder needs its own
  `node_modules`.
- `SOCHA_NODE` (or the older `SOCHA_DESKTOP_NODE`): use a specific `node.exe`.
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`: standard
  WebView2 variable, handy for driving the UI over CDP in tests.

## How it runs

- **Node.js**: `NodeLocator` looks, in order, at `SOCHA_NODE` (or `SOCHA_DESKTOP_NODE`),
  `node\node.exe` next to the exe (portable builds only), `node.exe` on PATH (process PATH
  plus machine and user PATH re-read from the registry, so a Node installed while the app
  shows its error panel is found on **Retry**), `%ProgramFiles%\nodejs` and
  `%ProgramFiles(x86)%\nodejs`, then nvm-windows (`NVM_SYMLINK`, `NVM_HOME`, `%APPDATA%\nvm`),
  fnm (`FNM_DIR`, `%APPDATA%\fnm`, `%LOCALAPPDATA%\fnm`), Volta (`%LOCALAPPDATA%\Volta`), Scoop
  and Chocolatey. Each candidate runs `node -p "process.version+'|'+process.execPath"`: the
  first with major >= 20 wins, and version-manager shims resolve to the real `node.exe` (the
  `/api/health` pid check needs the direct child). None, or only older versions: the Node
  panel names what was found and what is needed.
- **.NET runtime**: checked by the framework-dependent apphost before any app code runs; if
  the .NET 10 Desktop Runtime is missing, Windows shows the standard ".NET is required to run
  this application" dialog with a download link (no in-app check is possible at that point).
  The host logs the runtime version it runs on.
- **Server**: picks a free port on `127.0.0.1` (bind to port 0, read it, release it),
  then starts `node app\server.js` with `PORT=<port>`, `SOCHA_HOST=127.0.0.1`,
  `SOCHA_NO_OPEN=1` and `SOCHA_DATA_DIR=%LOCALAPPDATA%\SochaDiff`, without a console
  window. `NODE_OPTIONS` and `SOCHA_OPEN_BROWSER` are removed from its environment.
  If node exits with `EADDRINUSE` (another process took the port in between), it retries
  on a new port, up to three attempts.
- **Readiness**: polls `GET /api/health` (every 100 ms, up to 30 s) and only accepts a
  reply whose `pid` matches the child it started. A loading panel shows meanwhile.
- **Logs**: node stdout/stderr and host events go to `%LOCALAPPDATA%\SochaDiff\server.log`
  (the previous run is kept as `server.previous.log`). Host crashes go to `host-errors.log`.
- **Errors**: missing app files, node failing to start or exiting, or a failed page load
  shows a panel with the message, the log path, and Retry / Open log / Open log folder.
  A missing WebView2 Runtime or Node.js shows a panel with a download button, **All
  prerequisites** (opens the site's prerequisite list) and Retry.
- **Lifecycle**: node is placed in a Job Object with `KILL_ON_JOB_CLOSE`, so it dies
  whenever SochaDiff.exe dies (normal close, crash, Task Manager, `Stop-Process -Force`).
  Normal close also kills it explicitly. The job has `SILENT_BREAKAWAY_OK`, so programs
  node launches for you (Explorer, a file's default app, the Open With picker) are
  not killed when Socha Diff closes.
- **Data**: `%LOCALAPPDATA%\SochaDiff\` holds `.socha-diff-settings.json`,
  `.socha-diff-state.json`, logs, and `WebView2\` (browser profile). None of it is inside
  the ClickOnce install folder, so it survives updates. The desktop app does not share
  settings with a `node server.js` run from the repo (that one uses the repo folder).
- **WebView2 policy**: navigation stays on `http://127.0.0.1:<port>/`; any other http(s)
  or mailto link opens in the default browser, and other schemes are blocked. New-window
  requests never open a second WebView window. The status bar, host objects, web
  messages and password autosave are off; DevTools are on only in Debug builds.
- **Context menu**: the page cancels `contextmenu` on the diff panes and shows its own
  Copy menu, so WebView2 never shows a menu there. Elsewhere the WebView2 menu stays, minus
  browser items (Back/Forward/Reload/Save as/Print/Share/More tools/link and image
  items). Text fields keep Cut/Copy/Paste/Select all/Undo/Redo; the page background
  shows no menu in Release (only Inspect in Debug).
- **Origin note**: the port is random on every launch, so the page origin changes each
  time. The web app only uses `sessionStorage` today (per-session anyway). If it ever
  uses `localStorage`/IndexedDB, give the host a stable preferred port.

## Publish

### Local folder (testing)

```powershell
dotnet publish desktop/SochaDiff.Desktop -p:PublishProfile=Folder
# -> desktop/SochaDiff.Desktop/bin/publish/folder/SochaDiff.exe (framework-dependent)
```

Measured on the build box (2026-09-27, re-checked after the publish scripts landed):
**5,975,161 bytes (5.7 MiB, 615 files)** for the whole folder, of which `app/node_modules` is
3,062,028 bytes in 592 files (2,913,133 bytes / 23 files without it); about 2 MB compressed.
ClickOnce downloads the same files one by one (as `*.deploy`), so a first install is about 6 MB.
The previous self-contained .NET 8 publish with bundled `node.exe` was 251,753,026 bytes
(240 MiB, 101 MB zipped).

### ClickOnce and the site (manual)

ClickOnce needs Visual Studio's MSBuild (VS 2026 / MSBuild 18 for .NET 10); `dotnet publish`
does not support it. From a Developer PowerShell:

```powershell
pwsh desktop/scripts/publish-site.ps1 -Build 42                     # 1.0.42.0 (major/minor from version.json), unsigned
pwsh desktop/scripts/publish-site.ps1 -Version 1.0.42.0            # explicit four-part version
pwsh desktop/scripts/publish-site.ps1 -Build 42 -InstallBootstrapperPackages   # elevated: adds the WebView2 prerequisite to VS
pwsh desktop/scripts/publish-site.ps1 -Build 42 -CertificateThumbprint <thumb> # signed, cert in Cert:\CurrentUser\My
pwsh desktop/scripts/publish-site.ps1 -Build 42 -PfxPath C:\temp\socha3.pfx -PfxPassword (Read-Host -AsSecureString)
# -> desktop/out/site/  index.html, styles.css, site.js, assets/, web.config, version.json,
#                       SochaDiff.application, setup.exe, Application Files/SochaDiff_1_0_42_0/
```

It runs prepare-bundle, `msbuild /t:Publish /p:PublishProfile=ClickOnce` with the version passed
as `ApplicationVersion`, `MinimumRequiredVersion`, `Version`/`FileVersion`/`AssemblyVersion`,
checks that `SochaDiff.application` carries that version, then assembles the site and stamps
the version and the measured app payload size into the output copy of `index.html` and
`version.json` (the committed `site/` files stay placeholders). Upload the **contents** of
`desktop/out/site/` to the site root, `SochaDiff.application` last:

```powershell
pwsh desktop/scripts/deploy-site.ps1 -Source desktop/out/site -Mode Copy -TargetPath \\server\WebApps\SochaDiff
```

`-Build` must be higher than the live release (see `https://sochadiff.socha3.com/version.json`).
Normally CI publishes; if you publish by hand, use a number above the latest run number.

Profile choices (`ClickOnce.pubxml`):

- **Framework-dependent .NET 10** (win-x64). Prerequisites are listed on the site and, where
  possible, installed by `setup.exe` (below). The payload is about 6 MB instead of ~240 MB.
- **Version**: `ApplicationVersion` = `<major>.<minor>.<SochaBuildNumber>.0` (csproj computes
  it from `desktop/version.json`; CI passes the run number). The assembly/file version is the
  same, `Version` is `<major>.<minor>.<build>`.
- **Updates**: `UpdateEnabled`, `UpdateMode=Foreground` (checked before the app starts),
  `UpdateRequired=true` and `MinimumRequiredVersion` = the published version. So every launch
  checks the site and installs a newer release before starting, with no "Skip" button.
  Offline launches start the installed version.
- **setup.exe prerequisites** (downloaded from the vendors, never bundled; ComponentsLocation
  HomeSite):
  - `.NET Desktop Runtime 10.0 (x64)` (`Microsoft.NetCore.DesktopRuntime.10.0.x64`): ships with
    Visual Studio 2026's ClickOnce components.
  - `Microsoft Edge WebView2 Runtime (Evergreen)` (`Socha3.WebView2Runtime.Evergreen`): Visual
    Studio has no WebView2 package, so it lives in `desktop/bootstrapper/`. It downloads
    Microsoft's Evergreen Bootstrapper from the official fwlink only when the runtime is missing
    (per-machine or per-user registry check). `PublicKey="0"` accepts any trusted Microsoft
    signature instead of pinning a leaf key that Microsoft rotates. `publish-site.ps1
    -InstallBootstrapperPackages` copies it into `<VS>\MSBuild\Microsoft\VisualStudio\BootstrapperPackages`
    (admin).
  - If a package is not installed on the publishing machine, publish-site.ps1 drops it from
    `setup.exe` with a warning (`SochaPrereqDotNet` / `SochaPrereqWebView2=false`). Node.js has no
    bootstrapper package: the site lists it and the app checks it.
- `MapFileExtensions=true` (files are served as `*.deploy`), `setup.exe` bootstrapper
  enabled (Chrome/Firefox, and Edge without ClickOnce support, do not open `.application`
  links), desktop shortcut.
- **Signing**: see [Signing](#signing) below. Unsigned until the Socha3 certificate arrives.

### Signing

The Socha3 code-signing certificate comes from Sissy Admin. Until it is configured the release
is unsigned: installs show "Unknown publisher" and SmartScreen prompts, and the site shows a
clearly marked `UNSIGNED-NOTICE` block that publish-site.ps1 removes automatically when it signs.

- `publish-site.ps1 -CertificateThumbprint <thumb>` (certificate with private key already in
  `Cert:\CurrentUser\My`) or `-PfxPath <file> -PfxPassword <SecureString>` (imported into
  `Cert:\CurrentUser\My` for the build; certificate and private key are removed again
  afterwards, even on failure).
- It sets `SignManifests=true`, `ManifestCertificateThumbprint` and `ManifestTimestampUrl`
  (`-TimestampUrl`, default `http://timestamp.digicert.com`; use the issuing CA's RFC 3161 server
  if it has one). MSBuild's ClickOnce signing then Authenticode-signs `SochaDiff.exe` (the apphost),
  the entry assembly and `setup.exe` **before** hashing them into the manifests, and signs the
  application and deployment manifests. No separate signtool step is needed (signing the exe
  after publishing would break the manifest hashes).
- The certificate must be a code-signing certificate (EKU 1.3.6.1.5.5.7.3.3) with an exportable
  private key in a PFX. A certificate whose key lives only in a hardware token/HSM or a cloud
  signing service cannot be used from a PFX secret; that would need a self-hosted build runner
  with the token, or a different signing step.
- Keep the same certificate across releases where possible. Renewing it is fine for ClickOnce
  (.NET 4.5+ clients accept a new certificate), but the publisher name shown should stay "Socha3".
- CI: store the PFX as `SIGNING_PFX_BASE64`
  (`[Convert]::ToBase64String([IO.File]::ReadAllBytes('socha3.pfx')) | Set-Clipboard`) and its
  password as `SIGNING_PFX_PASSWORD`. Missing either one = unsigned build (with a notice).

### IIS site (`site/web.config`)

Static files only; no ASP.NET or URL Rewrite needed. It maps `.application`
(`application/x-ms-application`), `.manifest` (`application/x-ms-manifest`), `.deploy` and
`.exe` (`application/octet-stream`), `.gif`/`.webp`/`.webm`/`.mp4`/`.svg`/`.json`; turns off
caching for `SochaDiff.application`, `setup.exe`, `version.json` and `index.html`; caches
`Application Files/` for a year (version folders never change); and un-hides the `bin` segment /
allows double escaping so any node_modules path in `Application Files` is served.

## Continuous publishing (`.github/workflows/publish-desktop.yml`)

Every push to `main` builds and publishes a new version; **Actions -> Publish desktop app and
site -> Run workflow** does the same on demand (inputs: `deploy`, `force`, `allow_untrusted`).
A manual run on another branch builds the artifact but never deploys.

### Versioning

- `desktop/version.json` holds `major` and `minor`. The build number is `github.run_number`, so
  every run gets `<major>.<minor>.<run_number>.0`, e.g. `1.0.57.0`. The run number only goes up,
  so versions are monotonic; to start a new line, bump `minor`/`major` in version.json (never
  lower them).
- That one version is passed (`publish-site.ps1 -Version`) into ClickOnce `ApplicationVersion`
  and `MinimumRequiredVersion`, the assembly `Version`/`FileVersion`/`AssemblyVersion`, the
  displayed version on the page and the site's `version.json` (`version`,
  `applicationVersion`, commit, time, payload size, signed flag).
- `MinimumRequiredVersion` = the new version plus `UpdateMode=Foreground`: an installed client
  checks `SochaDiff.application` before every start and installs the new version without a
  Skip option. Offline starts run the installed version.
- Local builds (`dotnet build`, no `SochaBuildNumber`) are `<major>.<minor>.0.0`.

### What the workflow does

1. `build` on `windows-latest`: checkout, Node 24 (`actions/setup-node`), .NET 10 SDK
   (`actions/setup-dotnet`), `npm ci`, Playwright Chromium, `npm run test:selection`,
   `npm run test:paths`, `microsoft/setup-msbuild`.
2. Optional signing: when `SIGNING_PFX_BASE64` and `SIGNING_PFX_PASSWORD` both exist, the PFX is
   decoded to `RUNNER_TEMP`, publish-site.ps1 imports it for the build and removes the
   certificate and key, and an `always()` step deletes the PFX file.
3. `publish-site.ps1 -Version <version> -InstallBootstrapperPackages`, then `desktop/out/site/`
   is uploaded as the artifact `sochadiff-site-<version>` (30 days). You can download it from
   the run page and deploy it by hand.
4. `deploy` (needs `build`): runs only on `main` and only when `DEPLOY_HOST`, `DEPLOY_SITE`,
   `DEPLOY_USER` and `DEPLOY_PASSWORD` all exist (checked in a step of `build` and exposed as a
   job output, because secrets cannot appear in a job-level `if`). Installs Web Deploy on the
   runner if missing, then `deploy-site.ps1 -Mode WebDeploy`:
   - refuses a version that is not newer than the live `version.json` (`force` input overrides);
   - **phase 1** syncs everything except `SochaDiff.application`; **phase 2** syncs the
     manifest, so a client never sees a manifest pointing at files that are not uploaded yet;
   - never deletes on the server (older `Application Files/SochaDiff_*` folders stay, so a client
     mid-update keeps working; prune old ones by hand now and then, about 6 MB each).
5. `concurrency: publish-desktop` without cancel-in-progress: runs queue, and a newer push never
   cancels a deploy in progress.

The workflow lints clean with actionlint 1.7.12.

### Secrets and variables (Settings -> Secrets and variables -> Actions)

| Name | Kind | What it is |
|---|---|---|
| `DEPLOY_HOST` | secret | Host name of the IIS server's Web Management Service, e.g. `web1.socha3.com` (port 8172 is added), or `host:port`, or a full `https://host:8172/msdeploy.axd?site=<site>` URL |
| `DEPLOY_SITE` | secret | IIS site name exactly as in IIS Manager, e.g. `sochadiff.socha3.com` (the sync target is that site's root) |
| `DEPLOY_USER` | secret | IIS Manager user (or Windows account) allowed to deploy to that site only |
| `DEPLOY_PASSWORD` | secret | Its password (no commas or double quotes: msdeploy's argument syntax) |
| `DEPLOY_ALLOW_UNTRUSTED` | variable (optional) | `true` while WMSvc still uses its self-signed certificate (passes `-allowUntrusted`) |
| `SIGNING_PFX_BASE64` | secret (optional) | The Socha3 code-signing PFX, base64-encoded |
| `SIGNING_PFX_PASSWORD` | secret (optional) | The PFX password |

Without the four `DEPLOY_*` secrets the workflow still builds, tests and uploads the artifact.

### Server setup (Sissy Admin)

Common: IIS site `sochadiff.socha3.com` (static content only; default document `index.html`;
no ASP.NET or URL Rewrite needed), physical path e.g. `C:\WebApps\SochaDiff`, HTTPS binding
with a certificate for `sochadiff.socha3.com`, DNS `sochadiff.socha3.com` -> the server. The
app's `InstallUrl` is `https://sochadiff.socha3.com/`, so it must be served at the site root;
`site/web.config` (deployed with the site) supplies the ClickOnce MIME types and cache rules.
Enable IIS **Static Content** (and optionally static compression).

Option A, Web Deploy from GitHub-hosted runners (what the workflow does):
1. Server Manager -> IIS -> **Management Tools -> Management Service**. In IIS Manager -> server
   -> Management Service: **Enable remote connections**, "Windows credentials or IIS Manager
   credentials", port 8172, ideally a real certificate for the host name; set the WMSvc
   service to start automatically and start it.
2. Install **Web Deploy 4.0** (x64, Complete / including the *IIS Deployment Handler* and
   *Management Service Delegation*). Install it after the Management Service, or re-run it
   ("Change") so the handler registers.
3. IIS Manager -> server -> **IIS Manager Users** -> add e.g. `sochadiff-deploy`; then site
   `sochadiff.socha3.com` -> **IIS Manager Permissions** -> Allow User -> that user. The user can
   then deploy to this site only.
4. Server -> **Management Service Delegation**: make sure a rule allows `contentPath` (and
   `createApp`, `setAcl`) for that user/site (the "Deploy Applications with Content" template),
   and that the rule's identity (usually the site's app pool or a dedicated account) can write
   to the physical path.
5. Firewall: allow inbound **TCP 8172**. GitHub-hosted runner IPs change (they are published in
   `https://api.github.com/meta`, "actions"), so either open 8172 broadly with a strong password
   or use Option B.
6. Add the four `DEPLOY_*` secrets (plus `DEPLOY_ALLOW_UNTRUSTED=true` if WMSvc keeps its
   self-signed certificate).

Test from any Windows PC with Web Deploy:
`msdeploy -verb:dump -source:contentPath=sochadiff.socha3.com,computerName=https://<host>:8172/msdeploy.axd?site=sochadiff.socha3.com,userName=<u>,password=<p>,authType=Basic -allowUntrusted`.

Option B, self-hosted runner on the IIS server (no inbound port, no deploy secrets):
1. Repo -> Settings -> Actions -> Runners -> New self-hosted runner (Windows x64); install it as
   a service with the extra label `sochadiff` (labels `self-hosted, windows, sochadiff`). The
   service account needs modify rights on `C:\WebApps\SochaDiff` and outbound HTTPS to GitHub.
2. In `publish-desktop.yml`, replace the `deploy` job with the commented `deploy-self-hosted`
   job (same two phases, via `deploy-site.ps1 -Mode Copy`, robocopy without deletes). Build
   still runs on GitHub's Windows runner; only the copy runs on the server.
3. Keep that runner attached to this private repository only: it runs whatever workflow code
   it is given and can write to the site.

Manual deploy from a Windows PC (e.g. before the secrets exist):
`pwsh desktop/scripts/deploy-site.ps1 -Source desktop/out/site -Mode Copy -TargetPath \\server\WebApps\SochaDiff`
(or `-Mode WebDeploy -ServerHost ... -SiteName ...` with `DEPLOY_USER`/`DEPLOY_PASSWORD` set).
