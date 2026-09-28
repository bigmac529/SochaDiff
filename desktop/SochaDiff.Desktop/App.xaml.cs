using System.IO;
using System.Windows;
using System.Windows.Threading;

namespace SochaDiff.Desktop;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) => WriteCrash(args.ExceptionObject as Exception);
        base.OnStartup(e);
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        WriteCrash(e.Exception);
        MessageBox.Show($"Unexpected error:\n\n{e.Exception.Message}\n\nDetails were written to {CrashLog}.",
            "Socha Diff", MessageBoxButton.OK, MessageBoxImage.Error);
        e.Handled = true;
    }

    private static string CrashLog => Path.Combine(AppPaths.DataDir, "host-errors.log");

    private static void WriteCrash(Exception? ex)
    {
        try
        {
            Directory.CreateDirectory(AppPaths.DataDir);
            File.AppendAllText(CrashLog, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {ex}{Environment.NewLine}");
        }
        catch
        {
            // Nothing else we can do.
        }
    }
}
