using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace SochaDiff.Desktop;

/// <summary>Raised when the bundled server cannot be started; Message is user-facing.</summary>
internal sealed class NodeStartException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// Runs the bundled `node.exe app/server.js` on a free 127.0.0.1 port, with no
/// console window, stdout/stderr appended to %LOCALAPPDATA%\SochaDiff\server.log,
/// and the process held in a kill-on-close Job Object.
/// </summary>
internal sealed class NodeServer : IDisposable
{
    public const string Host = "127.0.0.1";
    private static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(30);
    private const int MaxPortAttempts = 3;

    private readonly object _logLock = new();
    private readonly Queue<string> _recentOutput = new();
    private StreamWriter? _log;
    private JobObject? _job;
    private Process? _process;
    private bool _stopping;

    public int Port { get; private set; }
    public Uri BaseUri => new($"http://{Host}:{Port}/");
    public int? ProcessId => _process?.Id;

    /// <summary>Fires (on a thread-pool thread) if node exits after startup without Stop/Dispose.</summary>
    public event Action<int>? UnexpectedExit;

    public async Task StartAsync(CancellationToken ct = default)
    {
        OpenLog();
        _job ??= new JobObject();

        string nodeExe = AppPaths.NodeExe;
        string serverJs = Path.Combine(AppPaths.AppDir, "server.js");
        if (!File.Exists(nodeExe))
            throw new NodeStartException($"The bundled Node runtime is missing:\n{nodeExe}\n\nThe app files may be incomplete; reinstall Socha Diff (developers: run desktop/scripts/prepare-bundle.ps1).");
        if (!File.Exists(serverJs))
            throw new NodeStartException($"The bundled web app is missing:\n{serverJs}\n\nThe app files may be incomplete; reinstall Socha Diff (developers: run desktop/scripts/prepare-bundle.ps1).");

        Log($"host: SochaDiff {typeof(NodeServer).Assembly.GetName().Version} pid {Environment.ProcessId}; node {nodeExe}; app {AppPaths.AppDir}; data {AppPaths.DataDir}");
        if (File.Exists(AppPaths.BundleInfo))
            Log("host: bundle " + File.ReadAllText(AppPaths.BundleInfo).ReplaceLineEndings(" "));
        var clickOnceVersion = Environment.GetEnvironmentVariable("ClickOnce_CurrentVersion");
        if (!string.IsNullOrEmpty(clickOnceVersion)) Log($"host: ClickOnce version {clickOnceVersion}");

        for (int attempt = 1; ; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            Port = GetFreeLoopbackPort();
            var process = Launch(nodeExe, serverJs, Port);
            if (await WaitForHealthAsync(process, ct)) break;

            bool portRace = process.HasExited && RecentOutputContains("EADDRINUSE");
            string exit = process.HasExited ? $"exited with code {process.ExitCode}" : "did not answer the health check in time";
            Log($"host: server {exit} (attempt {attempt}, port {Port})");
            KillProcess();
            if (portRace && attempt < MaxPortAttempts) continue;

            string tail = string.Join(Environment.NewLine, _recentOutput.TakeLast(8));
            throw new NodeStartException(
                $"The Socha Diff server {exit}." + (tail.Length > 0 ? $"\n\nLast output:\n{tail}" : ""));
        }

        var ready = _process!;
        Log($"host: server ready at {BaseUri} (node pid {ready.Id})");
        int reported = 0;
        void OnExited(object? sender, EventArgs e)
        {
            if (Interlocked.Exchange(ref reported, 1) != 0) return;
            int code = SafeExitCode(ready);
            Log($"host: node exited with code {code}");
            if (!_stopping) UnexpectedExit?.Invoke(code);
        }
        ready.Exited += OnExited;
        if (ready.HasExited) OnExited(null, EventArgs.Empty);
    }

    /// <summary>Stops the current node process (if any) and starts a fresh one.</summary>
    public async Task RestartAsync(CancellationToken ct = default)
    {
        _stopping = true;
        KillProcess();
        _stopping = false;
        await StartAsync(ct);
    }

    private Process Launch(string nodeExe, string serverJs, int port)
    {
        var psi = new ProcessStartInfo(nodeExe)
        {
            WorkingDirectory = AppPaths.AppDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add(serverJs);
        psi.Environment["PORT"] = port.ToString();
        psi.Environment["SOCHA_HOST"] = Host;
        psi.Environment["SOCHA_NO_OPEN"] = "1";
        psi.Environment["SOCHA_DATA_DIR"] = AppPaths.DataDir;
        // Don't let a developer's shell settings leak into the bundled runtime.
        psi.Environment.Remove("SOCHA_OPEN_BROWSER");
        psi.Environment.Remove("NODE_OPTIONS");

        Log($"host: starting node on {Host}:{port}");
        lock (_logLock) _recentOutput.Clear();
        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => { if (e.Data != null) Log(e.Data, "out"); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) Log(e.Data, "err"); };
        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            process.Dispose();
            throw new NodeStartException($"Could not start the bundled Node runtime:\n{nodeExe}\n\n{ex.Message}", ex);
        }
        _process = process;
        try
        {
            _job!.Assign(process);
        }
        catch (Exception ex)
        {
            // Still usable: Dispose() kills node on normal exit, just not on a crash.
            Log($"host: could not assign node to the job object: {ex.Message}");
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private async Task<bool> WaitForHealthAsync(Process process, CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var healthUri = new Uri(BaseUri, "api/health");
        var deadline = DateTime.UtcNow + StartupTimeout;
        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (process.HasExited) return false;
            try
            {
                using var response = await http.GetAsync(healthUri, ct);
                if (response.StatusCode == HttpStatusCode.OK)
                {
                    using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
                    var root = doc.RootElement;
                    // pid check: we reached our own child, not something else on the port.
                    if (root.TryGetProperty("app", out var app) && app.GetString() == "socha-diff" &&
                        root.TryGetProperty("pid", out var pid) && pid.GetInt32() == process.Id)
                        return true;
                }
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException && !ct.IsCancellationRequested)
            {
                // Not listening yet.
            }
            await Task.Delay(100, ct);
        }
        return false;
    }

    private static int GetFreeLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try { return ((IPEndPoint)listener.LocalEndpoint).Port; }
        finally { listener.Stop(); }
    }

    private void OpenLog()
    {
        if (_log != null) return;
        Directory.CreateDirectory(AppPaths.DataDir);
        try
        {
            if (File.Exists(AppPaths.ServerLog)) File.Copy(AppPaths.ServerLog, AppPaths.PreviousServerLog, overwrite: true);
            _log = new StreamWriter(new FileStream(AppPaths.ServerLog, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete), new UTF8Encoding(false)) { AutoFlush = true };
        }
        catch (IOException)
        {
            // Another instance holds server.log; use a per-process log instead.
            var alt = Path.Combine(AppPaths.DataDir, $"server.{Environment.ProcessId}.log");
            _log = new StreamWriter(new FileStream(alt, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete), new UTF8Encoding(false)) { AutoFlush = true };
            LogPath = alt;
        }
    }

    public string LogPath { get; private set; } = AppPaths.ServerLog;

    public void Log(string line, string stream = "host")
    {
        lock (_logLock)
        {
            if (stream != "host")
            {
                _recentOutput.Enqueue(line);
                while (_recentOutput.Count > 50) _recentOutput.Dequeue();
            }
            try { _log?.WriteLine($"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{stream}] {line}"); }
            catch (ObjectDisposedException) { }
        }
    }

    private bool RecentOutputContains(string text)
    {
        // Output events may trail the exit slightly.
        Thread.Sleep(200);
        lock (_logLock) return _recentOutput.Any(l => l.Contains(text, StringComparison.Ordinal));
    }

    private static int SafeExitCode(Process p)
    {
        try { return p.ExitCode; } catch { return -1; }
    }

    private void KillProcess()
    {
        var p = _process;
        _process = null;
        if (p == null) return;
        try
        {
            if (!p.HasExited)
            {
                p.Kill(entireProcessTree: true);
                p.WaitForExit(3000);
            }
        }
        catch (Exception ex)
        {
            Log($"host: kill failed: {ex.Message}");
        }
        p.Dispose();
    }

    /// <summary>Stops node (normal exit path); the job handle is the crash-path backstop.</summary>
    public void Dispose()
    {
        _stopping = true;
        KillProcess();
        _job?.Dispose();
        _job = null;
        Log("host: stopped");
        lock (_logLock)
        {
            _log?.Dispose();
            _log = null;
        }
    }
}
