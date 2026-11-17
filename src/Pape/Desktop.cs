using System.Text;
using static Pape.Native;

namespace Pape;

/// <summary>
/// Finds the window that sits behind the desktop icons, where wallpapers go.
/// Older Windows: a top-level "WorkerW" that Progman creates on request (message 0x052C).
/// Windows 11 24H2 and later: the icons (SHELLDLL_DefView) stay inside Progman, so wallpapers become
/// layered children of Progman placed just below the icons.
/// </summary>
static class Desktop
{
    public static string Mode { get; private set; } = "not attached";
    public static bool Layered => Mode == "Progman (24H2+)";

    public static IntPtr Host(out IntPtr insertAfter)
    {
        insertAfter = IntPtr.Zero;
        var progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero) { Mode = "no desktop found"; return IntPtr.Zero; }
        SendMessageTimeout(progman, 0x052C, 0xD, 1, 0, 1000, out _);
        SendMessageTimeout(progman, 0x052C, 0, 0, 0, 1000, out _);

        var defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (Environment.OSVersion.Version.Build >= 26002 && defView != IntPtr.Zero)
        {
            Mode = "Progman (24H2+)";
            insertAfter = defView;
            return progman;
        }

        var worker = IntPtr.Zero;
        EnumWindows((top, _) =>
        {
            if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
            {
                var w = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
                if (w != IntPtr.Zero) worker = w;
            }
            return true;
        }, IntPtr.Zero);
        if (worker != IntPtr.Zero) { Mode = "WorkerW"; return worker; }

        Mode = "Progman (fallback)";
        return progman;
    }

    static IntPtr IconList()
    {
        var defView = FindWindowEx(FindWindow("Progman", null), IntPtr.Zero, "SHELLDLL_DefView", null);
        if (defView == IntPtr.Zero)
            EnumWindows((top, _) =>
            {
                var dv = FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (dv != IntPtr.Zero) defView = dv;
                return defView == IntPtr.Zero;
            }, IntPtr.Zero);
        return defView == IntPtr.Zero ? IntPtr.Zero : FindWindowEx(defView, IntPtr.Zero, "SysListView32", null);
    }

    public static void SetIconsHidden(bool hidden)
    {
        var list = IconList();
        if (list != IntPtr.Zero) ShowWindow(list, hidden ? 0 : 5);
    }

    /// <summary>Re-applies the current Windows wallpaper so no frame of ours is left on the desktop.</summary>
    public static void RepaintWallpaper()
    {
        var path = new StringBuilder(1024);
        if (SystemParametersInfo(0x73 /* SPI_GETDESKWALLPAPER */, (uint)path.Capacity, path, 0) && path.Length > 0)
            SystemParametersInfo(0x14 /* SPI_SETDESKWALLPAPER */, 0, path, 0);
    }
}
