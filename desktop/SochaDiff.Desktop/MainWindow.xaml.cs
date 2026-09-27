using System.Diagnostics;
using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace SochaDiff.Desktop;

public partial class MainWindow : Window
{
    private const string WebView2DownloadUrl = "https://developer.microsoft.com/microsoft-edge/webview2/";

    // Browser-chrome items that make no sense in an app window. Editing items
    // (Cut/Copy/Paste/Select all/Undo/Redo/Emoji, spelling) stay. The diff area
    // never reaches this: the page cancels contextmenu there and shows its own Copy menu.
    private static readonly HashSet<string> HiddenMenuItems = new(StringComparer.OrdinalIgnoreCase)
    {
        "back", "forward", "reload", "saveAs", "print", "createQrCode", "share", "webCapture",
        "openLinkInNewWindow", "saveLinkAs", "copyLinkLocation", "copyLinkToClipboard",
        "saveImageAs", "copyImageLocation", "openImageInNewWindow", "saveMediaAs", "openMediaInNewWindow",
        "readAloud", "search", "sendTabToSelf",
    };

    private readonly NodeServer _server = new();
    private bool _serverStartedOnce;
    private bool _webViewInitialized;
    private bool _closing;

    public MainWindow()
    {
        InitializeComponent();
        _server.UnexpectedExit += code => Dispatcher.BeginInvoke(() =>
        {
            if (_closing) return;
            ShowError("The Socha Diff server stopped",
                $"The bundled Node server exited unexpectedly (exit code {code}). Retry starts a new one.",
                canRetry: true);
        });
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e) => await StartAsync();

    private async Task StartAsync()
    {
        ShowLoading("Starting...");

        string? runtimeVersion = GetWebView2RuntimeVersion();
        if (runtimeVersion == null)
        {
            ShowRuntimeMissing();
            return;
        }

        try
        {
            bool restart = _serverStartedOnce;
            _serverStartedOnce = true;
            Task serverTask = Task.Run(() => restart ? _server.RestartAsync() : _server.StartAsync());
            Task webViewTask = InitWebViewAsync();
            await Task.WhenAll(serverTask, webViewTask);
        }
        catch (NodeStartException ex)
        {
            ShowError("Socha Diff could not start", ex.Message, canRetry: true);
            return;
        }
        catch (WebView2RuntimeNotFoundException)
        {
            ShowRuntimeMissing();
            return;
        }
        catch (Exception ex)
        {
            _server.Log($"host: startup failed: {ex}");
            ShowError("Socha Diff could not start", ex.Message, canRetry: true);
            return;
        }

        if (_closing) return;
        _server.Log($"host: WebView2 runtime {runtimeVersion}; navigating to {_server.BaseUri}");
        LoadingText.Text = "Loading...";
        WebView.CoreWebView2.Navigate(_server.BaseUri.ToString());
    }

    private static string? GetWebView2RuntimeVersion()
    {
        try
        {
            return CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            return null;
        }
    }

    private async Task InitWebViewAsync()
    {
        if (_webViewInitialized) return;
        Directory.CreateDirectory(AppPaths.WebViewDataDir);
        var env = await CoreWebView2Environment.CreateAsync(null, AppPaths.WebViewDataDir);
        await WebView.EnsureCoreWebView2Async(env);
        _webViewInitialized = true;

        var core = WebView.CoreWebView2;
        var settings = core.Settings;
#if DEBUG
        settings.AreDevToolsEnabled = true;
#else
        settings.AreDevToolsEnabled = false;
#endif
        settings.IsStatusBarEnabled = false;
        settings.AreHostObjectsAllowed = false;
        settings.IsWebMessageEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;

        core.NavigationStarting += (_, args) =>
        {
            if (IsAppUri(args.Uri)) return;
            args.Cancel = true;
            OpenExternal(args.Uri);
        };
        core.NewWindowRequested += (_, args) =>
        {
            // Never open a second WebView2 window. Same-origin links (e.g. the
            // /api/open-* anchors on middle-click) are ignored; the rest go to the browser.
            args.Handled = true;
            if (!IsAppUri(args.Uri)) OpenExternal(args.Uri);
        };
        core.NavigationCompleted += (_, args) =>
        {
            if (args.IsSuccess)
            {
                ShowWebView();
            }
            else if (!_closing && ErrorPanel.Visibility != Visibility.Visible &&
                     args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
            {
                _server.Log($"host: navigation failed: {args.WebErrorStatus}");
                ShowError("Socha Diff could not load", $"The page failed to load ({args.WebErrorStatus}).", canRetry: true);
            }
        };
        core.ContextMenuRequested += (_, args) => FilterContextMenu(args);
        core.ProcessFailed += (_, args) =>
        {
            _server.Log($"host: WebView2 process failed: {args.ProcessFailedKind} ({args.Reason})");
            if (args.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited
                or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
            {
                core.Reload();
            }
            else if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                ShowError("The embedded browser stopped",
                    "The WebView2 browser process exited. Close and reopen Socha Diff.", canRetry: false);
            }
        };
    }

    private static void FilterContextMenu(CoreWebView2ContextMenuRequestedEventArgs args)
    {
        var items = args.MenuItems;
        for (int i = items.Count - 1; i >= 0; i--)
        {
            if (HiddenMenuItems.Contains(items[i].Name)) items.RemoveAt(i);
        }
        // Drop leading, trailing and doubled separators left behind.
        for (int i = items.Count - 1; i >= 0; i--)
        {
            bool separator = items[i].Kind == CoreWebView2ContextMenuItemKind.Separator;
            if (separator && (i == 0 || i == items.Count - 1 || items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator))
                items.RemoveAt(i);
        }
        if (items.Count == 0) args.Handled = true;   // nothing useful left: show no menu
    }

    private bool IsAppUri(string uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var u) &&
        u.Scheme == Uri.UriSchemeHttp && u.Host == NodeServer.Host && u.Port == _server.Port;

    private void OpenExternal(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var u) ||
            (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeMailto))
        {
            _server.Log($"host: blocked navigation to {uri}");
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            _server.Log($"host: could not open {uri}: {ex.Message}");
        }
    }

    private void ShowLoading(string text)
    {
        LoadingText.Text = text;
        LoadingPanel.Visibility = Visibility.Visible;
        ErrorPanel.Visibility = Visibility.Collapsed;
        WebView.Visibility = Visibility.Hidden;
    }

    private void ShowWebView()
    {
        LoadingPanel.Visibility = Visibility.Collapsed;
        ErrorPanel.Visibility = Visibility.Collapsed;
        WebView.Visibility = Visibility.Visible;
        WebView.Focus();
    }

    private void ShowError(string title, string message, bool canRetry, bool showLog = true)
    {
        LoadingPanel.Visibility = Visibility.Collapsed;
        WebView.Visibility = Visibility.Hidden;   // an HWND would cover the panel otherwise
        ErrorTitle.Text = title;
        ErrorMessage.Text = message;
        ErrorLogLine.Text = showLog ? $"Log: {_server.LogPath}" : "";
        ErrorLogLine.Visibility = showLog ? Visibility.Visible : Visibility.Collapsed;
        OpenLogButton.Visibility = showLog ? Visibility.Visible : Visibility.Collapsed;
        OpenLogFolderButton.Visibility = showLog ? Visibility.Visible : Visibility.Collapsed;
        RetryButton.Visibility = canRetry ? Visibility.Visible : Visibility.Collapsed;
        DownloadRuntimeButton.Visibility = Visibility.Collapsed;
        ErrorPanel.Visibility = Visibility.Visible;
    }

    private void ShowRuntimeMissing()
    {
        ShowError("Microsoft Edge WebView2 Runtime is required",
            "Socha Diff displays its interface with the Microsoft Edge WebView2 Runtime, which was not found on this PC. " +
            "It is built into Windows 11; on other systems install the free Evergreen Runtime from Microsoft, then click Retry.",
            canRetry: true, showLog: false);
        DownloadRuntimeButton.Visibility = Visibility.Visible;
    }

    private async void Retry_Click(object sender, RoutedEventArgs e) => await StartAsync();

    private void OpenLog_Click(object sender, RoutedEventArgs e) => ShellOpen(_server.LogPath);

    private void OpenLogFolder_Click(object sender, RoutedEventArgs e) =>
        ShellOpen(Path.GetDirectoryName(_server.LogPath) ?? AppPaths.DataDir);

    private void DownloadRuntime_Click(object sender, RoutedEventArgs e) => ShellOpen(WebView2DownloadUrl);

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private static void ShellOpen(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Socha Diff", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        _closing = true;
        _server.Dispose();
    }
}
