using System.IO;
using System.Reflection;
using System.Text.Json;

namespace SochaDiff.Desktop;

/// <summary>The web app folder the server runs from, and why it was chosen.</summary>
/// <param name="IsBundle">True for the staged bundle next to the exe (the only case in an installed app).</param>
internal sealed record AppDirChoice(string Path, string Source, bool IsBundle);

/// <summary>Per-user locations. Everything lives under %LOCALAPPDATA%\SochaDiff so it
/// survives ClickOnce updates (which install each version into a new folder).
/// In the MSIX package the same path is used: Windows virtualizes NEW files/folders under
/// %LOCALAPPDATA% for packaged desktop apps into %LOCALAPPDATA%\Packages\&lt;family&gt;\LocalCache\Local\
/// (the app and its node.exe child still see the normal path; removed on uninstall), while a
/// folder that already exists (e.g. from a ClickOnce install) is used in place. See desktop/STORE.md.</summary>
internal static class AppPaths
{
    /// <summary>Developer-only override: run the web app from this folder (Debug and Release).</summary>
    public const string AppDirVariable = "SOCHA_APP_DIR";

    /// <summary>Older name of <see cref="AppDirVariable"/>, still honored.</summary>
    public const string LegacyAppDirVariable = "SOCHA_DESKTOP_APP_DIR";

    public static string DataDir { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SochaDiff");

    public static string WebViewDataDir => Path.Combine(DataDir, "WebView2");

    public static string ServerLog => Path.Combine(DataDir, "server.log");

    public static string PreviousServerLog => Path.Combine(DataDir, "server.previous.log");

    /// <summary>node.exe staged by prepare-bundle -IncludeNode: portable builds and the MSIX package
    /// (desktop/msix/build-msix.ps1); absent in ClickOnce.</summary>
    public static string BundledNodeExe => Path.Combine(AppContext.BaseDirectory, "node", "node.exe");

    /// <summary>The web app staged by prepare-bundle and copied next to SochaDiff.exe (build/publish/ClickOnce).</summary>
    public static string BundledAppDir => Path.Combine(AppContext.BaseDirectory, "app");

    public static string BundleInfo => Path.Combine(AppContext.BaseDirectory, "bundle-info.json");

    /// <summary>
    /// Picks the web app folder. Order:
    ///   1. SOCHA_APP_DIR (or the older SOCHA_DESKTOP_APP_DIR): developer-only override, any build.
    ///   2. app\ next to SochaDiff.exe (the staged bundle; what Release/ClickOnce always uses).
    ///   3. Debug builds only: the repo checkout (the root baked in at build time, else the first
    ///      folder above the exe with server.js + package.json + public\), so F5 works without
    ///      running prepare-bundle.
    /// Folders other than the bundle must have their npm dependencies installed.
    /// Throws <see cref="NodeStartException"/> with a user-facing message when nothing usable is found.
    /// </summary>
    public static AppDirChoice ResolveAppDir()
    {
        foreach (var name in new[] { AppDirVariable, LegacyAppDirVariable })
        {
            var value = Env(name);
            if (value == null) continue;
            string dir;
            try { dir = Path.GetFullPath(value.Trim('"')); }
            catch (Exception ex) { throw new NodeStartException($"{name} is not a valid folder path:\n{value}\n\n{ex.Message}", title: "Socha Diff could not start"); }
            if (!File.Exists(Path.Combine(dir, "server.js")))
                throw new NodeStartException(
                    $"The environment variable {name} points at a folder without server.js:\n{dir}\n\n" +
                    $"{name} is a developer-only override. Point it at the repo root (or another web app folder), or remove it.");
            RequireDependencies(dir, $"{name} points at");
            return new AppDirChoice(dir, name, IsBundle: false);
        }

        if (File.Exists(Path.Combine(BundledAppDir, "server.js")))
            return new AppDirChoice(BundledAppDir, "staged bundle next to SochaDiff.exe", IsBundle: true);

#if DEBUG
        var repo = FindRepoRoot();
        if (repo != null)
        {
            RequireDependencies(repo.Path, "This Debug build runs the web app from the repo checkout at");
            return repo;
        }
#endif

        throw new NodeStartException(
            $"The Socha Diff web app files are missing:\n{Path.Combine(BundledAppDir, "server.js")}\n\n" +
            "The app files may be incomplete; reinstall Socha Diff.\n\n" +
            "Developers: Release builds and publishing need the bundle staged by desktop/scripts/prepare-bundle.ps1. " +
            "Debug builds fall back to the repo checkout (the folder with server.js, package.json and public\\)" +
#if DEBUG
            $", but none was found above {AppContext.BaseDirectory}" +
#endif
            $". {AppDirVariable} can point at any web app folder.");
    }

#if DEBUG
    /// <summary>Repo root baked into Debug builds by the csproj (AssemblyMetadata "SochaRepoRoot").</summary>
    private static string? BakedRepoRoot =>
        typeof(AppPaths).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "SochaRepoRoot")?.Value;

    private static AppDirChoice? FindRepoRoot()
    {
        var baked = BakedRepoRoot;
        if (!string.IsNullOrEmpty(baked) && IsWebAppRoot(baked))
            return new AppDirChoice(Path.GetFullPath(baked), "Debug fallback: repo root recorded at build time", IsBundle: false);

        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
        {
            if (IsWebAppRoot(dir.FullName))
                return new AppDirChoice(dir.FullName, "Debug fallback: repo root found above SochaDiff.exe", IsBundle: false);
        }
        return null;
    }

    private static bool IsWebAppRoot(string dir) =>
        File.Exists(Path.Combine(dir, "server.js")) &&
        File.Exists(Path.Combine(dir, "package.json")) &&
        Directory.Exists(Path.Combine(dir, "public"));
#endif

    /// <summary>
    /// A folder outside the bundle has no staged node_modules: check every package.json dependency
    /// is installed, so a missing `npm install` gets a clear panel instead of a node stack trace.
    /// </summary>
    private static void RequireDependencies(string dir, string context)
    {
        var missing = new List<string>();
        try
        {
            string packageJson = Path.Combine(dir, "package.json");
            if (File.Exists(packageJson))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(packageJson));
                if (doc.RootElement.TryGetProperty("dependencies", out var deps) && deps.ValueKind == JsonValueKind.Object)
                {
                    foreach (var dep in deps.EnumerateObject())
                    {
                        var parts = dep.Name.Split('/');
                        if (!File.Exists(Path.Combine([dir, "node_modules", .. parts, "package.json"])))
                            missing.Add(dep.Name);
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            // Unreadable package.json: let node report whatever is wrong.
            return;
        }
        if (missing.Count == 0) return;

        bool noFolder = !Directory.Exists(Path.Combine(dir, "node_modules"));
        throw new NodeStartException(
            $"{context}:\n{dir}\n\n" +
            (noFolder
                ? "but its npm packages are not installed (there is no node_modules folder)."
                : $"but some of its npm packages are missing: {string.Join(", ", missing)}.") +
            $"\n\nOpen a terminal in that folder and run:\n\n    npm install\n\nthen click Retry.",
            title: "The web app's npm packages are not installed");
    }

    internal static string? Env(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }
}
