using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Pape;

/// <summary>
/// Finds wallpapers in the library folders: loose images and videos, and Wallpaper Engine project
/// folders (a folder with project.json, as in Steam's Workshop folder or WE's own projects).
/// </summary>
static class Library
{
    static readonly HashSet<string> Images = new(StringComparer.OrdinalIgnoreCase) { ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".avif" };
    static readonly HashSet<string> Videos = new(StringComparer.OrdinalIgnoreCase) { ".mp4", ".webm", ".m4v", ".mov", ".mkv" };
    static readonly JsonDocumentOptions Lenient = new() { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip };

    public static List<JsonObject> Scan(IReadOnlyList<string> sources)
    {
        var list = new List<JsonObject>();
        for (var i = 0; i < sources.Count; i++)
            if (Directory.Exists(sources[i])) Walk(sources[i], sources[i], i, 0, list);
        return list;
    }

    static void Walk(string dir, string root, int index, int depth, List<JsonObject> list)
    {
        try
        {
            var projectFile = Path.Combine(dir, "project.json");
            if (File.Exists(projectFile))
            {
                if (Project(dir, projectFile, root, index) is { } project) list.Add(project);
                return;
            }
            foreach (var file in Directory.EnumerateFiles(dir))
            {
                var ext = Path.GetExtension(file);
                var type = Images.Contains(ext) ? "image" : Videos.Contains(ext) ? "video" : null;
                if (type is null) continue;
                var info = new FileInfo(file);
                var url = Url(root, index, file);
                list.Add(new JsonObject
                {
                    ["id"] = file,
                    ["title"] = Path.GetFileNameWithoutExtension(file),
                    ["type"] = type,
                    ["url"] = url,
                    ["preview"] = type == "image" ? url : null,
                    ["path"] = file,
                    ["size"] = info.Length,
                    ["modified"] = info.LastWriteTimeUtc.ToString("o"),
                    ["supported"] = true,
                });
            }
            if (depth < 6)
                foreach (var sub in Directory.EnumerateDirectories(dir))
                    if ((File.GetAttributes(sub) & (FileAttributes.Hidden | FileAttributes.System)) == 0)
                        Walk(sub, root, index, depth + 1, list);
        }
        catch (Exception ex)
        {
            PortablePaths.Log($"scan {dir}: {ex.Message}");
        }
    }

    static JsonObject? Project(string dir, string projectFile, string root, int index)
    {
        try
        {
            if (JsonNode.Parse(File.ReadAllText(projectFile), documentOptions: Lenient) is not JsonObject p) return null;
            // WE leaves "type" out of some older scene projects
            var type = (Str(p["type"]) ?? "scene").ToLowerInvariant();
            var file = Str(p["file"]);
            if (type == "scene" && file?.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) == true) type = "application";
            var main = file is null ? null : Path.Combine(dir, file);
            var preview = Str(p["preview"]) is { } pv && File.Exists(Path.Combine(dir, pv)) ? Url(root, index, Path.Combine(dir, pv)) : null;
            var hasMain = main is not null && File.Exists(main);
            // Workshop scenes come packed into scene.pkg; WE's own samples are unpacked.
            var pkg = type == "scene" && File.Exists(Path.Combine(dir, "scene.pkg"));
            var scene = type == "scene" && (pkg || hasMain);
            var supported = scene || type is "video" or "web" && hasMain;
            var size = pkg ? new FileInfo(Path.Combine(dir, "scene.pkg")).Length : hasMain ? new FileInfo(main!).Length : 0;
            return new JsonObject
            {
                ["id"] = dir,
                ["title"] = Str(p["title"]) ?? Path.GetFileName(dir),
                ["type"] = type,
                ["url"] = scene ? Url(root, index, dir).TrimEnd('/') + "/" : supported ? Url(root, index, main!) : null,
                ["file"] = file,
                ["pkg"] = pkg,
                ["assets"] = scene && WeInstall is not null ? $"https://{WebHost.AssetsHost}/" : null,
                ["preview"] = preview,
                ["path"] = dir,
                ["size"] = size,
                ["modified"] = Directory.GetLastWriteTimeUtc(dir).ToString("o"),
                ["supported"] = supported,
                ["tags"] = p["tags"]?.DeepClone(),
                ["rating"] = Str(p["contentrating"]),
                ["properties"] = p["general"]?["properties"]?.DeepClone(),
                ["workshop"] = Str(p["workshopid"]),
            };
        }
        catch (Exception ex)
        {
            PortablePaths.Log($"project {projectFile}: {ex.Message}");
            return null;
        }
    }

    static string Url(string root, int index, string path)
    {
        var rel = Path.GetRelativePath(root, path);
        return $"https://{WebHost.SourceHost(index)}/" + (rel == "." ? "" : string.Join('/', rel.Split('\\', '/').Select(Uri.EscapeDataString)));
    }

    static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /* ---------- where Wallpaper Engine keeps wallpapers on this PC ---------- */

    // initialised in this order: FindWeInstall fills SteamLibraries
    static readonly List<string> SteamLibraries = new();
    public static string? WeInstall { get; } = FindWeInstall(out _);

    static string? FindWeInstall(out string? steam)
    {
        steam = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath", null) as string;
        if (steam is null) return null;
        SteamLibraries.Add(steam.Replace('/', '\\'));
        try
        {
            var vdf = Path.Combine(steam, "steamapps", "libraryfolders.vdf");
            if (File.Exists(vdf))
                foreach (Match m in Regex.Matches(File.ReadAllText(vdf), "\"path\"\\s+\"([^\"]+)\""))
                    SteamLibraries.Add(m.Groups[1].Value.Replace(@"\\", @"\"));
        }
        catch { /* first library is enough */ }
        return SteamLibraries.Select(l => Path.Combine(l, "steamapps", "common", "wallpaper_engine"))
            .FirstOrDefault(Directory.Exists);
    }

    /// <summary>Library folders for a first run: the Pictures\wallpapers folder and WE's folders, where they exist.</summary>
    public static List<string> DefaultSources()
    {
        var list = new List<string>();
        var pictures = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "wallpapers");
        list.Add(Directory.Exists(pictures) ? pictures : Environment.GetFolderPath(Environment.SpecialFolder.MyPictures));
        list.AddRange(SteamLibraries.Select(l => Path.Combine(l, "steamapps", "workshop", "content", "431960")).Where(Directory.Exists));
        if (WeInstall is not null)
            list.AddRange(new[] { "myprojects", "defaultprojects" }.Select(p => Path.Combine(WeInstall, "projects", p)).Where(Directory.Exists));
        return list.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }
}
