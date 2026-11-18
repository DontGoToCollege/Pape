using System.IO;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using static Pape.Native;

namespace Pape;

/// <summary>
/// One wallpaper surface: a child window behind the desktop icons holding a WebView2.
/// Images and videos play in the embedded player.html; web wallpapers load directly with
/// Wallpaper Engine's web API (shim.js) injected.
/// </summary>
sealed class WallpaperWindow : NativeWindow, IDisposable
{
    const int WS_CHILD = 0x40000000, WS_POPUP = unchecked((int)0x80000000), WS_CLIPCHILDREN = 0x02000000;
    const int WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x80;

    readonly Engine _engine;
    readonly IntPtr _insertAfter;
    readonly bool _offscreen;
    CoreWebView2Controller? _ctl;
    Rectangle _bounds;
    bool _disposed, _loading, _muted, _paused, _fade;
    string? _page;   // "player.html" or "scene.html" when showing one of Pape's own pages, else null
    bool? _sentPaused;
    JsonObject? _item;
    JsonObject _state = new();
    string _stateJson = "", _sentState = "", _shownUrl = "";

    public string Key { get; }
    public IntPtr Host { get; }
    public bool WantsAudio { get; private set; }
    public bool WantsPointer { get; private set; }
    public Rectangle Bounds => _bounds;
    public string? ItemId => _item?["id"]?.GetValue<string>();

    /// <param name="host">Window behind the icons; zero puts the surface off-screen (self-check).</param>
    public WallpaperWindow(Engine engine, string key, IntPtr host, IntPtr insertAfter, bool layered)
    {
        _engine = engine;
        Key = key;
        Host = host;
        _insertAfter = insertAfter;
        _offscreen = host == IntPtr.Zero;
        var cp = new CreateParams { Caption = "Pape wallpaper" };
        if (_offscreen)
        {
            cp.Style = WS_POPUP | WS_CLIPCHILDREN;
            cp.ExStyle = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            cp.X = cp.Y = -32000;
        }
        else
        {
            cp.Parent = host;
            cp.Style = WS_CHILD | WS_CLIPCHILDREN;
            cp.ExStyle = WS_EX_NOACTIVATE | (layered ? WS_EX_LAYERED : 0);
        }
        CreateHandle(cp);
        if (layered && !_offscreen) SetLayeredWindowAttributes(Handle, 0, 255, 2 /* LWA_ALPHA */);
        _ = InitAsync();
    }

    async Task InitAsync()
    {
        try
        {
            var ctl = await _engine.Env!.CreateCoreWebView2ControllerAsync(Handle);
            if (_disposed) { ctl.Close(); return; }
            _ctl = ctl;
            ctl.DefaultBackgroundColor = Color.Black;
            ctl.Bounds = new Rectangle(0, 0, _bounds.Width, _bounds.Height);
            ctl.IsVisible = true;
            var core = ctl.CoreWebView2;
            var s = core.Settings;
            s.AreDefaultContextMenusEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = false;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            WebHost.ServeApp(core, _engine.Env);
            WebHost.MapSources(core, _engine.Sources());
            await core.AddScriptToExecuteOnDocumentCreatedAsync(WebHost.Shim);
            core.WebMessageReceived += (_, e) =>
            {
                try
                {
                    var type = JsonNode.Parse(e.WebMessageAsJson)?["type"]?.GetValue<string>();
                    if (type == "audio") WantsAudio = true;
                    else if (type == "pointer") WantsPointer = true;
                    _engine.UpdateAudio();
                }
                catch { /* not ours */ }
            };
            core.NavigationStarting += (_, _) => { WantsAudio = WantsPointer = false; _loading = true; };
            core.NavigationCompleted += (_, e) =>
            {
                _loading = false;
                if (!e.IsSuccess) PortablePaths.Log($"wallpaper load failed ({e.WebErrorStatus}): {core.Source}");
                _sentState = "";
                _sentPaused = null;
                if (_page is not null) PostShow(); else PushState();
                _engine.UpdateAudio();
            };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.IsMuted = _muted;
            Apply();
        }
        catch (Exception ex)
        {
            PortablePaths.Log("wallpaper view failed: " + ex);
        }
    }

    public void MapSources(IReadOnlyList<string> sources)
    {
        if (_ctl is not null) WebHost.MapSources(_ctl.CoreWebView2, sources);
        _shownUrl = "";   // the URL may now point at a different folder: load again
    }

    public void Place(Rectangle screen)
    {
        if (screen == _bounds) return;
        _bounds = screen;
        if (_offscreen)
        {
            SetWindowPos(Handle, IntPtr.Zero, -32000, -32000, screen.Width, screen.Height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
        else
        {
            var r = new RECT(screen);
            MapWindowPoints(IntPtr.Zero, Host, ref r, 2);
            SetWindowPos(Handle, _insertAfter, r.Left, r.Top, screen.Width, screen.Height,
                (_insertAfter == IntPtr.Zero ? SWP_NOZORDER : 0) | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
        if (_ctl is not null)
        {
            _ctl.Bounds = new Rectangle(0, 0, screen.Width, screen.Height);
            _ctl.NotifyParentWindowPositionChanged();
        }
    }

    public void Show(JsonObject item, JsonObject props, JsonObject user, double volume, bool fade)
    {
        _item = item;
        _fade = fade;
        _state = new JsonObject { ["props"] = props, ["user"] = user, ["volume"] = volume };
        _stateJson = _state.ToJsonString();
        Apply();
    }

    public void SetPaused(bool paused)
    {
        if (_paused == paused) return;
        _paused = paused;
        Apply();
    }

    public void SetMuted(bool muted)
    {
        _muted = muted;
        if (_ctl is not null && _ctl.CoreWebView2.IsMuted != muted) _ctl.CoreWebView2.IsMuted = muted;
    }

    void Apply()
    {
        if (_ctl is null || _item is null) return;
        var url = _item["url"]?.GetValue<string>() ?? "";
        if (url != _shownUrl)
        {
            _shownUrl = url;
            var page = _item["type"]?.GetValue<string>() switch
            {
                "image" or "video" => "player.html",
                "scene" => "scene.html",
                _ => null,
            };
            // the image/video player cross-fades to the next picture; a scene always starts on a fresh page
            if (page == "player.html" && _page == page && !_loading) { PostShow(); return; }
            _page = page;
            _ctl.CoreWebView2.Navigate(page is null ? url : WebHost.Origin + page);
            return;
        }
        if (!_loading) PushState();
    }

    void PostShow()
    {
        if (_ctl is null || _item is null) return;
        var msg = (JsonObject)_state.DeepClone();
        msg["type"] = "show";
        msg["item"] = _item.DeepClone();
        msg["fade"] = _fade;
        msg["paused"] = _paused;
        Post(msg);
        _sentState = _stateJson;
        _sentPaused = _paused;
    }

    void PushState()
    {
        if (_stateJson != _sentState)
        {
            var msg = (JsonObject)_state.DeepClone();
            msg["type"] = "props";
            Post(msg);
            _sentState = _stateJson;
        }
        if (_sentPaused != _paused)
        {
            Post(new JsonObject { ["type"] = "paused", ["value"] = _paused });
            _sentPaused = _paused;
        }
    }

    void Post(JsonObject msg) => PostJson(msg.ToJsonString());

    public void PostJson(string json)
    {
        try { _ctl?.CoreWebView2.PostWebMessageAsJson(json); }
        catch (Exception ex) { PortablePaths.Log("post to wallpaper: " + ex.Message); }
    }

    public void OpenDevTools() => _ctl?.CoreWebView2.OpenDevToolsWindow();

    public async Task<string> EvalAsync(string script) =>
        _ctl is null ? "null" : await _ctl.CoreWebView2.ExecuteScriptAsync(script);

    public async Task CaptureAsync(string path)
    {
        if (_ctl is null) return;
        await using var file = File.Create(path);
        await _ctl.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _ctl?.Close(); } catch { /* explorer may already have destroyed the parent */ }
        _ctl = null;
        DestroyHandle();
    }
}
