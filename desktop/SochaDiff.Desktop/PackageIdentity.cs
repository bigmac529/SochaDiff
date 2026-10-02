using System.Runtime.InteropServices;

namespace SochaDiff.Desktop;

/// <summary>
/// Whether SochaDiff.exe runs with MSIX package identity (installed from the Microsoft Store or a
/// sideloaded .msix), as opposed to ClickOnce, a folder publish or a dev build. Uses
/// GetCurrentPackageFullName (kernel32, Windows 8+): APPMODEL_ERROR_NO_PACKAGE means unpackaged.
/// Packaged builds bundle their own node.exe and prefer it (see NodeLocator).
/// </summary>
internal static class PackageIdentity
{
    private const int ErrorSuccess = 0;
    private const int ErrorInsufficientBuffer = 122;

    /// <summary>The package full name (Name_Version_Arch_ResourceId_PublisherId), or null when unpackaged.</summary>
    public static string? FullName { get; } = Query();

    public static bool IsPackaged => FullName != null;

    private static string? Query()
    {
        try
        {
            int length = 0;
            // Unpackaged processes get APPMODEL_ERROR_NO_PACKAGE (15700); packaged ones need a buffer.
            if (GetCurrentPackageFullName(ref length, null) != ErrorInsufficientBuffer || length <= 0) return null;
            var buffer = new char[length];
            if (GetCurrentPackageFullName(ref length, buffer) != ErrorSuccess) return null;
            return new string(buffer, 0, Math.Max(0, length - 1)); // length includes the terminating NUL
        }
        catch (Exception ex) when (ex is EntryPointNotFoundException or DllNotFoundException)
        {
            return null;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetCurrentPackageFullName(ref int packageFullNameLength, [Out] char[]? packageFullName);
}
