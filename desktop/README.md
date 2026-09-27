# Socha Diff desktop host (Windows)

A small .NET 8 WPF app (`SochaDiff.exe`) that shows the Socha Diff web UI in a
full-window WebView2 and runs its own bundled Node server. Nothing about the web
app changes: it is the same `server.js` + `lib/` + `public/`, started privately
on a random loopback port.

```
desktop/
  SochaDiff.sln
  node-pin.json                    pinned Node version + SHA256 of the win-x64 zip
  scripts/prepare-bundle.ps1       stages desktop/bundle/ (Windows, PowerShell 5.1 or 7)
  scripts/prepare-bundle.sh        same for Linux/macOS/Git Bash (CI, compile checks)
  bundle/                          git-ignored staging folder (created by the scripts)
  .cache/                          git-ignored download cache for the Node zip
  SochaDiff.Desktop/
    SochaDiff.Desktop.csproj       net8.0-windows, win-x64, Microsoft.Web.WebView2
    App.xaml(.cs)                  palette, unhandled-exception logging
    MainWindow.xaml(.cs)           WebView2, loading/error panels, link + menu policy
    NodeServer.cs                  port pick, node launch, logging, health polling
    JobObject.cs                   KILL_ON_JOB_CLOSE job for node.exe
    AppPaths.cs                    %LOCALAPPDATA%\SochaDiff paths, dev overrides
    Properties/PublishProfiles/
      ClickOnce.pubxml             https://sochadiff.socha3.com/ (not published yet)
      Folder.pubxml                plain self-contained folder, for local testing
```

## Prepare the bundle

`node.exe` and `node_modules` are never committed. Stage them once (and again
after changing `server.js`, `lib/`, `public/` or dependencies):

```powershell
pwsh desktop/scripts/prepare-bundle.ps1        # or: powershell -File desktop\scripts\prepare-bundle.ps1
```

The script:

1. reads `node-pin.json` (currently **Node 24.21.0 LTS "Krypton"**, `node-v24.21.0-win-x64.zip`);
2. checks the pinned SHA256 against the official `SHASUMS256.txt`, downloads the zip
   (cached in `desktop/.cache/`) and verifies the download against the same hash;
3. writes `desktop/bundle/`:
   - `node/node.exe`, `node/LICENSE`
   - `app/server.js`, `app/lib/`, `app/public/`, `app/package.json`, `app/package-lock.json`
   - `app/node_modules/` from `npm ci --omit=dev --ignore-scripts`, run with the pinned
     Node's own npm (no system Node needed); dot-entries (`.bin`, `.github`, lint
     configs) are removed
   - `bundle-info.json` (Node version/hash, git commit, dirty flag, time), logged at startup.

To move to a newer Node, update `version`, `file` and `sha256` in `node-pin.json`
together (hash from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`).

The csproj includes everything under `bundle/` as `Content` (copied to the output
and listed in the ClickOnce manifest). Building without a bundle only warns
(`SOCHA001`); publishing without one fails (`SOCHA002`).

## Build and run

```powershell
cd desktop
dotnet build SochaDiff.sln                 # Debug: DevTools (F12) enabled
dotnet run --project SochaDiff.Desktop
```

Or open `desktop/SochaDiff.sln` in Visual Studio and press F5. The project sets
`EnableWindowsTargeting=true`, so `dotnet build` also works on Linux/macOS as a
compile check (the app itself only runs on Windows).

Dev overrides (environment variables read by the host):

- `SOCHA_DESKTOP_APP_DIR`: run a different web app folder, e.g. the repo root, to
  test `public/` edits without re-running prepare-bundle. That folder needs its own
  `node_modules`.
- `SOCHA_DESKTOP_NODE`: use a different `node.exe`.
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`: standard
  WebView2 variable, handy for driving the UI over CDP in tests.

## How it runs

- **Server**: picks a free port on `127.0.0.1` (bind to port 0, read it, release it),
  then starts `node\node.exe app\server.js` with `PORT=<port>`, `SOCHA_HOST=127.0.0.1`,
  `SOCHA_NO_OPEN=1` and `SOCHA_DATA_DIR=%LOCALAPPDATA%\SochaDiff`, without a console
  window. `NODE_OPTIONS` and `SOCHA_OPEN_BROWSER` are removed from its environment.
  If node exits with `EADDRINUSE` (another process took the port in between), it retries
  on a new port, up to three attempts.
- **Readiness**: polls `GET /api/health` (every 100 ms, up to 30 s) and only accepts a
  reply whose `pid` matches the child it started. A loading panel shows meanwhile.
- **Logs**: node stdout/stderr and host events go to `%LOCALAPPDATA%\SochaDiff\server.log`
  (the previous run is kept as `server.previous.log`). Host crashes go to `host-errors.log`.
- **Errors**: a missing bundle, node failing to start or exiting, or a failed page load
  shows a panel with the message, the log path, and Retry / Open log / Open log folder.
  A missing WebView2 Runtime shows a panel linking to Microsoft's download page.
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
# -> desktop/SochaDiff.Desktop/bin/publish/folder/SochaDiff.exe (self-contained, ~240 MB)
```

### ClickOnce (not published yet)

ClickOnce needs Visual Studio's MSBuild; `dotnet publish` does not support it. From a
Developer PowerShell:

```powershell
pwsh desktop/scripts/prepare-bundle.ps1
msbuild desktop/SochaDiff.Desktop/SochaDiff.Desktop.csproj /restore /t:Publish `
  /p:PublishProfile=ClickOnce /p:ApplicationVersion=1.0.0.N
# -> desktop/SochaDiff.Desktop/bin/publish/clickonce/
#      SochaDiff.application, setup.exe, Launcher.exe, Application Files/SochaDiff_1_0_0_N/
```

Upload the contents of `bin/publish/clickonce/` to the root of
`https://sochadiff.socha3.com/`. Bump `ApplicationVersion` for every release. From the
command line it does not auto-increment; Visual Studio's Publish dialog does.

Profile choices:

- **Self-contained .NET 8** (win-x64). Users need no .NET Desktop Runtime prerequisite
  (installing that takes admin rights and a bootstrapper step). The cost is size: about
  145 MB of runtime on top of Node (~90 MB) and the app (~6.5 MB), ~240 MB unpacked for
  the first install. Later updates only download files whose hash changed, so a
  typical app-only update is small. Framework-dependent would cut ~145 MB, but the
  user would have to install the runtime.
- **Updates**: checked before the app starts (`UpdateMode=Foreground`); skipped when offline.
- `MapFileExtensions=true` (files are served as `*.deploy`), `setup.exe` bootstrapper
  enabled (Edge does not open `.application` links by default), desktop shortcut.
- **Signing: TODO.** The code-signing certificate comes from Sissy Admin; until then
  `SignManifests=false`, and installs show "Unknown publisher" and SmartScreen prompts.
  After signing, also consider Authenticode-signing `SochaDiff.exe`/`Launcher.exe`.
