namespace Pape;

static class AppInfo
{
    public const string Name = "Pape";
    /// <summary>Data folder beside the exe.</summary>
    public const string DataFolder = "Pape-Data";
    /// <summary>Folder under %LOCALAPPDATA%, used only when the exe's own folder is read-only.</summary>
    public const string FallbackFolder = "Pape";
    public static string Version { get; } =
        typeof(AppInfo).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "0.0.0";
}
