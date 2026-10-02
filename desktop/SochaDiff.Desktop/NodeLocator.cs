using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

namespace SochaDiff.Desktop;

/// <summary>A usable Node.js: the real executable (shims resolved) and its version.</summary>
internal sealed record NodeInstall(string Path, Version Version, string Source);

/// <summary>Node.js was not found, or only versions older than <see cref="NodeLocator.MinimumMajor"/>.</summary>
internal sealed class NodeMissingException(string message, IReadOnlyList<NodeInstall> tooOld) : Exception(message)
{
    public IReadOnlyList<NodeInstall> TooOld { get; } = tooOld;
}

/// <summary>
/// Finds Node.js. ClickOnce/dev builds use the user's Node.js (a prerequisite, not bundled); the MSIX
/// (Microsoft Store / sideload) package bundles a pinned node.exe and, when running with package
/// identity (<see cref="PackageIdentity"/>), tries it FIRST. Order:
///   0. MSIX package only: node\node.exe next to SochaDiff.exe (bundled in the package)
///   1. SOCHA_NODE (or the older SOCHA_DESKTOP_NODE) environment variable
///   2. node\node.exe next to SochaDiff.exe (portable builds made with prepare-bundle -IncludeNode)
///   3. node.exe on PATH (machine + user PATH re-read from the registry, so a Node installed
///      while Socha Diff was open is found on Retry)
///   4. %ProgramFiles%\nodejs, %ProgramFiles(x86)%\nodejs
///   5. version managers: nvm-windows (NVM_SYMLINK, NVM_HOME, %APPDATA%\nvm), fnm (FNM_DIR,
///      %APPDATA%\fnm, %LOCALAPPDATA%\fnm), Volta (%LOCALAPPDATA%\Volta), Scoop, Chocolatey.
/// Each candidate is asked for process.version and process.execPath, so version-manager shims
/// resolve to the real node.exe (the host's /api/health pid check needs the direct child).
/// The first candidate with major version >= MinimumMajor wins.
/// </summary>
internal static class NodeLocator
{
    public const int MinimumMajor = 20;
    public const string DownloadUrl = "https://nodejs.org/en/download";
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(10);

    public static NodeInstall Find(Action<string>? log = null)
    {
        var tooOld = new List<NodeInstall>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (path, source) in Candidates())
        {
            string full;
            try { full = System.IO.Path.GetFullPath(path); } catch { continue; }
            if (!seen.Add(full) || !File.Exists(full)) continue;

            var probed = Probe(full, source, log);
            if (probed == null) continue;
            if (!seen.Contains(probed.Path)) seen.Add(probed.Path);
            if (probed.Version.Major >= MinimumMajor)
            {
                log?.Invoke($"host: using node {probed.Version} at {probed.Path} (found via {source})");
                return probed;
            }
            log?.Invoke($"host: skipping node {probed.Version} at {probed.Path} (via {source}): Socha Diff needs {MinimumMajor} or newer");
            tooOld.Add(probed);
        }

        string message = tooOld.Count == 0
            ? $"Socha Diff needs Node.js {MinimumMajor} or newer (the LTS release is recommended), and it was not found on this PC."
            : $"Socha Diff needs Node.js {MinimumMajor} or newer (the LTS release is recommended). This PC only has " +
              string.Join(", ", tooOld.Select(n => $"v{n.Version} ({n.Path})")) + ".";
        if (PackageIdentity.IsPackaged)
            message += $"\n\nThis Microsoft Store / MSIX build includes its own Node.js ({AppPaths.BundledNodeExe}), but it could not be started " +
                       "(see the log). Reinstalling Socha Diff usually fixes that; installing Node.js 20+ also works as a fallback.";
        message += "\n\nInstall Node.js from nodejs.org (the Windows Installer, .msi, adds it to PATH), then click Retry. " +
                   "If Node.js is installed somewhere unusual, set the SOCHA_NODE environment variable to the full path of node.exe.";
        throw new NodeMissingException(message, tooOld);
    }

    private static IEnumerable<(string Path, string Source)> Candidates()
    {
        // The MSIX package ships its own node.exe: prefer it so the Store app never depends on (or is
        // broken by) whatever Node the user has. If it fails the probe, the usual search continues.
        if (PackageIdentity.IsPackaged)
            yield return (AppPaths.BundledNodeExe, "bundled node in the MSIX package");

        foreach (var name in new[] { "SOCHA_NODE", "SOCHA_DESKTOP_NODE" })
        {
            var env = AppPaths.Env(name);
            if (env != null) yield return (env.Trim('"'), name);
        }

        yield return (AppPaths.BundledNodeExe, "bundled node folder");

        foreach (var dir in PathDirectories())
            yield return (System.IO.Path.Combine(dir, "node.exe"), "PATH");

        foreach (var pf in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
        {
            var root = Environment.GetFolderPath(pf);
            if (root.Length > 0) yield return (System.IO.Path.Combine(root, "nodejs", "node.exe"), "Program Files");
        }

        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        // nvm-windows: the active version is a symlink (NVM_SYMLINK, usually C:\Program Files\nodejs).
        var nvmSymlink = AppPaths.Env("NVM_SYMLINK");
        if (nvmSymlink != null) yield return (System.IO.Path.Combine(nvmSymlink, "node.exe"), "nvm-windows");
        foreach (var root in new[] { AppPaths.Env("NVM_HOME"), System.IO.Path.Combine(appData, "nvm") })
            foreach (var exe in VersionDirs(root, "node.exe"))
                yield return (exe, "nvm-windows");

        // fnm: default alias first, then installed versions.
        foreach (var root in new[] { AppPaths.Env("FNM_DIR"), System.IO.Path.Combine(appData, "fnm"), System.IO.Path.Combine(localAppData, "fnm") })
        {
            if (root == null) continue;
            yield return (System.IO.Path.Combine(root, "aliases", "default", "node.exe"), "fnm");
            foreach (var exe in VersionDirs(System.IO.Path.Combine(root, "node-versions"), System.IO.Path.Combine("installation", "node.exe")))
                yield return (exe, "fnm");
        }

        // Volta: the real images (the shim in %LOCALAPPDATA%\Volta\bin also works via execPath).
        var volta = AppPaths.Env("VOLTA_HOME") ?? System.IO.Path.Combine(localAppData, "Volta");
        foreach (var exe in VersionDirs(System.IO.Path.Combine(volta, "tools", "image", "node"), "node.exe"))
            yield return (exe, "Volta");
        yield return (System.IO.Path.Combine(volta, "bin", "node.exe"), "Volta");

        // Scoop and Chocolatey.
        var scoop = AppPaths.Env("SCOOP") ?? System.IO.Path.Combine(home, "scoop");
        foreach (var app in new[] { "nodejs-lts", "nodejs" })
            yield return (System.IO.Path.Combine(scoop, "apps", app, "current", "node.exe"), "Scoop");
        var choco = AppPaths.Env("ChocolateyInstall");
        if (choco != null) yield return (System.IO.Path.Combine(choco, "bin", "node.exe"), "Chocolatey");
    }

    /// <summary>Process PATH plus the current machine and user PATH from the registry.</summary>
    private static IEnumerable<string> PathDirectories()
    {
        var parts = new List<string>();
        foreach (var target in new[] { EnvironmentVariableTarget.Process, EnvironmentVariableTarget.Machine, EnvironmentVariableTarget.User })
        {
            string? value = null;
            try { value = Environment.GetEnvironmentVariable("PATH", target); } catch { }
            if (string.IsNullOrEmpty(value)) continue;
            foreach (var raw in value.Split(System.IO.Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var dir = Environment.ExpandEnvironmentVariables(raw.Trim('"'));
                if (dir.Length > 0 && !parts.Contains(dir, StringComparer.OrdinalIgnoreCase)) parts.Add(dir);
            }
        }
        return parts;
    }

    /// <summary>&lt;root&gt;\v*\&lt;relative&gt;, newest version first.</summary>
    private static IEnumerable<string> VersionDirs(string? root, string relative)
    {
        if (string.IsNullOrEmpty(root) || !Directory.Exists(root)) return [];
        try
        {
            return Directory.GetDirectories(root)
                .Select(d => (Dir: d, Version: ParseVersion(System.IO.Path.GetFileName(d))))
                .Where(x => x.Version != null)
                .OrderByDescending(x => x.Version)
                .Select(x => System.IO.Path.Combine(x.Dir, relative))
                .ToList();
        }
        catch (Exception)
        {
            return [];
        }
    }

    internal static Version? ParseVersion(string? text)
    {
        if (text == null) return null;
        var m = Regex.Match(text, @"v?(\d+)\.(\d+)\.(\d+)");
        return m.Success ? new Version(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value)) : null;
    }

    /// <summary>Runs `node -p "process.version+'|'+process.execPath"`; null if it is not a working node.</summary>
    private static NodeInstall? Probe(string exe, string source, Action<string>? log)
    {
        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            psi.ArgumentList.Add("-p");
            psi.ArgumentList.Add("process.version + '|' + process.execPath");
            psi.Environment.Remove("NODE_OPTIONS");
            using var p = Process.Start(psi);
            if (p == null) return null;
            var stdout = p.StandardOutput.ReadToEndAsync();
            _ = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(ProbeTimeout))
            {
                try { p.Kill(entireProcessTree: true); } catch { }
                log?.Invoke($"host: {exe} did not answer the version probe in time");
                return null;
            }
            var line = stdout.Result.Trim();
            int bar = line.IndexOf('|');
            var version = ParseVersion(bar > 0 ? line[..bar] : line);
            if (p.ExitCode != 0 || version == null)
            {
                log?.Invoke($"host: {exe} is not a usable node (exit {p.ExitCode}, output '{line}')");
                return null;
            }
            string real = bar > 0 && File.Exists(line[(bar + 1)..]) ? line[(bar + 1)..] : exe;
            return new NodeInstall(real, version, source);
        }
        catch (Exception ex)
        {
            log?.Invoke($"host: could not run {exe}: {ex.Message}");
            return null;
        }
    }
}
