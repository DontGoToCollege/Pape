using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Pape;

/// <summary>The library window: the embedded web UI. Closing it frees its web view; Pape keeps running in the tray.</summary>
sealed class MainForm : Form
{
    readonly Engine _engine;
    readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    readonly WindowSettings _place = WindowSettings.Load();
    readonly string? _page;

    public CoreWebView2? Core => _web.CoreWebView2;
    public event Action? PageLoaded;

    public MainForm(Engine engine, string? page)
    {
        _engine = engine;
        _page = page;
        Text = AppInfo.Name;
        Icon = Engine.AppIcon(false);
        BackColor = Color.FromArgb(0x10, 0x14, 0x1b);
        _web.DefaultBackgroundColor = BackColor;
        Controls.Add(_web);
        StartPosition = FormStartPosition.Manual;
        if (engine.Smoke)
        {
            ShowInTaskbar = false;
            Location = new Point(-32000, -32000);
            Size = new Size(LogicalToDeviceUnits(1320), LogicalToDeviceUnits(840));
        }
        HandleCreated += (_, _) => Native.DarkTitleBar(Handle);
        Load += async (_, _) => { if (!engine.Smoke) ApplyPlacement(); await InitAsync(); };
        FormClosing += (_, _) => SavePlacement();
    }

    protected override bool ShowWithoutActivation => _engine.Smoke;

    async Task InitAsync()
    {
        try
        {
            await _web.EnsureCoreWebView2Async(_engine.Env);
        }
        catch (Exception ex)
        {
            PortablePaths.Log("ui web view failed: " + ex);
            return;
        }
        var core = _web.CoreWebView2;
        var devtools = Environment.GetCommandLineArgs().Contains("--devtools", StringComparer.OrdinalIgnoreCase);
        var s = core.Settings;
        s.AreDevToolsEnabled = devtools;
        s.AreDefaultContextMenusEnabled = devtools;
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        WebHost.ServeApp(core, _engine.Env!);
        WebHost.MapSources(core, _engine.Sources());
        core.NavigationStarting += (_, e) =>
        {
            if (e.Uri.StartsWith(WebHost.Origin, StringComparison.OrdinalIgnoreCase)) return;
            e.Cancel = true;
            PortablePaths.Log("navigation blocked: " + e.Uri);
        };
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.WebMessageReceived += (_, e) => _engine.OnUiMessage(e.WebMessageAsJson);
        core.NavigationCompleted += (_, _) => PageLoaded?.Invoke();
        core.Navigate(WebHost.Origin + "index.html" + (_page is null ? "" : "#" + _page));
    }

    public void Post(string json)
    {
        try { _web.CoreWebView2?.PostWebMessageAsJson(json); }
        catch (Exception ex) { PortablePaths.Log("post to ui: " + ex.Message); }
    }

    public void ShowPage(string page) => Post(new JsonObject { ["type"] = "nav", ["page"] = page }.ToJsonString());

    public async Task<string> EvalAsync(string script) => _web.CoreWebView2 is null ? "null" : await _web.CoreWebView2.ExecuteScriptAsync(script);

    /// <summary>Runs a script that returns a promise and waits for it (self-check). ok is false if it threw.</summary>
    public async Task<(bool ok, string result)> EvalPromiseAsync(string script)
    {
        if (_web.CoreWebView2 is null) return (false, "no web view");
        var args = JsonSerializer.Serialize(new { expression = script, awaitPromise = true, returnByValue = true, userGesture = true });
        using var doc = JsonDocument.Parse(await _web.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate", args));
        return doc.RootElement.TryGetProperty("exceptionDetails", out var error)
            ? (false, error.ToString())
            : (true, doc.RootElement.GetProperty("result").GetProperty("value").ToString());
    }

    public async Task CaptureAsync(string path)
    {
        if (_web.CoreWebView2 is null) return;
        await using var file = File.Create(path);
        await _web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
    }

    void ApplyPlacement()
    {
        Size = new Size(LogicalToDeviceUnits(1320), LogicalToDeviceUnits(840));
        MinimumSize = new Size(LogicalToDeviceUnits(900), LogicalToDeviceUnits(560));
        var saved = new Rectangle((int)_place.Left, (int)_place.Top, (int)_place.Width, (int)_place.Height);
        if (!double.IsNaN(_place.Left) && Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(saved) && sc.WorkingArea.Contains(saved.Left + 60, saved.Top + 20)))
            Bounds = saved;
        else
            CenterToScreen();
        if (_place.Maximized) WindowState = FormWindowState.Maximized;
    }

    void SavePlacement()
    {
        if (_engine.Smoke) return;
        var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        _place.Left = r.Left;
        _place.Top = r.Top;
        _place.Width = r.Width;
        _place.Height = r.Height;
        _place.Maximized = WindowState == FormWindowState.Maximized;
        _place.Save();
    }
}
