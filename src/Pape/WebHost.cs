using System.IO;
using Microsoft.Web.WebView2.Core;

namespace Pape;

/// <summary>
/// URLs every web view uses: the embedded UI/player on a private host, and each wallpaper folder
/// mapped to its own host (s0, s1, ...) so videos can stream from disk with seeking.
/// </summary>
static class WebHost
{
    public const string Host = "app.pape.portable";
    public static readonly string Origin = $"https://{Host}/";
    public static string SourceHost(int index) => $"s{index}.pape.portable";
    /// <summary>Wallpaper Engine's own assets folder (shaders, effects, materials) for scene wallpapers.</summary>
    public const string AssetsHost = "we.pape.portable";

    static string? _shim;
    public static string Shim => _shim ??= ReadResource("shim.js");

    public static string ReadResource(string name)
    {
        using var reader = new StreamReader(typeof(WebHost).Assembly.GetManifestResourceStream(name)!);
        return reader.ReadToEnd();
    }

    public static void ServeApp(CoreWebView2 core, CoreWebView2Environment env)
    {
        core.AddWebResourceRequestedFilter(Origin + "*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, e) =>
        {
            var uri = new Uri(e.Request.Uri);
            if (!uri.Host.Equals(Host, StringComparison.OrdinalIgnoreCase)) return;
            var stream = WebAssets.Open(uri.AbsolutePath, out var contentType);
            e.Response = stream is null
                ? env.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain")
                : env.CreateWebResourceResponse(stream, 200, "OK", $"Content-Type: {contentType}\r\nCache-Control: no-cache");
        };
    }

    public static void MapSources(CoreWebView2 core, IReadOnlyList<string> sources)
    {
        for (var i = 0; i < sources.Count + 8; i++)
        {
            try { core.ClearVirtualHostNameToFolderMapping(SourceHost(i)); } catch { /* was not mapped */ }
        }
        if (Library.WeInstall is { } we && Directory.Exists(Path.Combine(we, "assets")))
        {
            try { core.SetVirtualHostNameToFolderMapping(AssetsHost, Path.Combine(we, "assets"), CoreWebView2HostResourceAccessKind.Allow); }
            catch (Exception ex) { PortablePaths.Log("cannot map Wallpaper Engine assets: " + ex.Message); }
        }
        for (var i = 0; i < sources.Count; i++)
        {
            if (!Directory.Exists(sources[i])) continue;
            try { core.SetVirtualHostNameToFolderMapping(SourceHost(i), sources[i], CoreWebView2HostResourceAccessKind.Allow); }
            catch (Exception ex) { PortablePaths.Log($"cannot map {sources[i]}: {ex.Message}"); }
        }
    }
}
