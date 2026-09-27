using System.IO;

namespace SochaDiff.Desktop;

/// <summary>Per-user locations. Everything lives under %LOCALAPPDATA%\SochaDiff so it
/// survives ClickOnce updates (which install each version into a new folder).</summary>
internal static class AppPaths
{
    public static string DataDir { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SochaDiff");

    public static string WebViewDataDir => Path.Combine(DataDir, "WebView2");

    public static string ServerLog => Path.Combine(DataDir, "server.log");

    public static string PreviousServerLog => Path.Combine(DataDir, "server.previous.log");

    /// <summary>Bundled node.exe; SOCHA_DESKTOP_NODE overrides it for development.</summary>
    public static string NodeExe =>
        Env("SOCHA_DESKTOP_NODE") ?? Path.Combine(AppContext.BaseDirectory, "node", "node.exe");

    /// <summary>Bundled web app folder; SOCHA_DESKTOP_APP_DIR overrides it (e.g. a repo checkout).</summary>
    public static string AppDir =>
        Env("SOCHA_DESKTOP_APP_DIR") ?? Path.Combine(AppContext.BaseDirectory, "app");

    public static string BundleInfo => Path.Combine(AppContext.BaseDirectory, "bundle-info.json");

    private static string? Env(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }
}
