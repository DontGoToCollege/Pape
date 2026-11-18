using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using static Pape.Native;

namespace Pape;

/// <summary>
/// The running program: owns the settings (config.json, edited by the UI), the library, one wallpaper
/// window per display, playlists, playback rules, hotkeys and the tray icon.
/// </summary>
sealed class Engine : ApplicationContext
{
    public readonly bool Smoke;
    public CoreWebView2Environment? Env { get; private set; }

    JsonObject _cfg;
    List<JsonObject> _items = new();
    Dictionary<string, JsonObject> _byId = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, WallpaperWindow> _windows = new();
    readonly Dictionary<string, PlaylistState> _playlists = new();
    readonly Dictionary<string, string> _reasons = new();
    readonly Control _invoker = new();
    readonly MessageWindow _msg;
    readonly NotifyIcon _tray;
    readonly ToolStripMenuItem _miPause, _miMute, _miStop, _miIcons;
    readonly System.Windows.Forms.Timer _tick = new() { Interval = 1000 };
    readonly System.Windows.Forms.Timer _audioTick = new() { Interval = 33 };
    readonly AudioFeed _audio = new();
    MainForm? _ui;
    bool _uiReady, _userPause, _userMute, _userStop, _iconsHidden, _displayOff, _exiting;
    Snapshot _snap = new();
    IntPtr _host, _insertAfter;
    string _sourcesKey = "", _urlsKey = "", _hotkeysKey = "", _lastStatus = "";
    JsonArray _hotkeys = new();
    readonly List<string> _hotkeyErrors = new();

    sealed class PlaylistState
    {
        public string Sig = "";
        public List<string> Order = new();
        public int Index;
        public bool Random;
        public double Minutes;
        public DateTime Next;
    }

    sealed class Snapshot
    {
        public string FgApp = "";
        public Rectangle FgMonitor;
        public bool FgFullscreen, Battery, OtherAudio;
        public List<Rectangle> Maximized = new();
        public HashSet<string> MaximizedApps = new();
        public HashSet<string> Running = new();
        public HashSet<string> AudioApps = new();
    }

    record Target(string Key, Rectangle Bounds, string Slot);

    public Engine(bool smoke, bool showUi)
    {
        Smoke = smoke;
        if (smoke) ResetSmokeData();
        _cfg = LoadConfig();
        _ = _invoker.Handle;   // gives BeginInvoke a window on this thread
        _msg = new MessageWindow(this);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Browse wallpapers", null, (_, _) => ShowUi("wallpapers"));
        menu.Items.Add("Displays", null, (_, _) => ShowUi("displays"));
        menu.Items.Add("Settings", null, (_, _) => ShowUi("settings"));
        menu.Items.Add(new ToolStripSeparator());
        _miPause = (ToolStripMenuItem)menu.Items.Add("Pause", null, (_, _) => Command("pause", null));
        _miMute = (ToolStripMenuItem)menu.Items.Add("Mute", null, (_, _) => Command("mute", null));
        _miStop = (ToolStripMenuItem)menu.Items.Add("Stop (free memory)", null, (_, _) => Command("stop", null));
        menu.Items.Add("Next wallpaper", null, (_, _) => Command("next", null));
        _miIcons = (ToolStripMenuItem)menu.Items.Add("Hide desktop icons", null, (_, _) => Command("icons", null));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => Exit());
        _tray = new NotifyIcon { Icon = AppIcon(true), Text = AppInfo.Name, ContextMenuStrip = menu, Visible = !smoke };
        _tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowUi(null); };

        _tick.Tick += (_, _) => Tick();
        _audioTick.Tick += (_, _) => PushAudio();

        if (!smoke)
        {
            var show = new EventWaitHandle(false, EventResetMode.AutoReset, "Pape-show");
            var exit = new EventWaitHandle(false, EventResetMode.AutoReset, "Pape-exit");
            ThreadPool.RegisterWaitForSingleObject(show, (_, _) => _invoker.BeginInvoke(() => ShowUi(null)), null, -1, false);
            ThreadPool.RegisterWaitForSingleObject(exit, (_, _) => _invoker.BeginInvoke(Exit), null, -1, true);
        }
        _invoker.BeginInvoke(async () => await StartAsync(showUi));
    }

    async Task StartAsync(bool showUi)
    {
        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (!Smoke)
                MessageBox.Show("Pape needs the Microsoft Edge WebView2 Runtime. It ships with Windows 11; on older Windows install it once from Microsoft.",
                    AppInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Exit();
            return;
        }
        try
        {
            // Occlusion detection would freeze wallpapers sitting behind the desktop icons.
            var options = new CoreWebView2EnvironmentOptions(
                "--autoplay-policy=no-user-gesture-required --disable-features=CalculateNativeWinOcclusion,msSmartScreenProtection " +
                "--disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding " +
                "--disable-component-update --disable-domain-reliability --no-pings");
            Env = await CoreWebView2Environment.CreateAsync(null, PortablePaths.WebViewDir, options);
        }
        catch (Exception ex)
        {
            PortablePaths.Log("web view environment failed: " + ex);
            if (!Smoke) MessageBox.Show("Pape could not start its web view:\n" + ex.Message, AppInfo.Name);
            Exit();
            return;
        }
        Rescan();
        RegisterHotkeys();
        ApplyStartup();
        _tick.Start();
        Refresh();
        if (showUi || Smoke) ShowUi(null);
        if (Smoke) await RunSmokeAsync();
    }

    /* ================= config ================= */

    static JsonObject Defaults() => new()
    {
        ["sources"] = new JsonArray(Library.DefaultSources().Select(s => (JsonNode?)JsonValue.Create(s)).ToArray()),
        ["urls"] = new JsonArray(),
        ["layout"] = "per",
        ["displays"] = new JsonObject(),
        ["props"] = new JsonObject(),
        ["favorites"] = new JsonArray(),
        ["presets"] = new JsonObject(),
        ["playlists"] = new JsonObject(),
        ["profiles"] = new JsonObject(),
        ["rules"] = new JsonObject
        {
            ["focused"] = "keep", ["maximized"] = "keep", ["fullscreen"] = "pause",
            ["battery"] = "keep", ["audio"] = "keep", ["sleep"] = "pause",
        },
        ["appRules"] = new JsonArray(),
        ["hotkeys"] = new JsonArray(),
        ["settings"] = new JsonObject { ["theme"] = "slate", ["startWithWindows"] = false, ["volume"] = 100 },
    };

    static JsonObject LoadConfig()
    {
        JsonObject? cfg = null;
        try
        {
            if (File.Exists(PortablePaths.ConfigFile))
                cfg = JsonNode.Parse(File.ReadAllText(PortablePaths.ConfigFile)) as JsonObject;
        }
        catch (Exception ex)
        {
            PortablePaths.Log("config unreadable, starting fresh (old copy kept as config.json.bad): " + ex.Message);
            try { File.Copy(PortablePaths.ConfigFile, PortablePaths.ConfigFile + ".bad", true); } catch { /* best effort */ }
        }
        var defaults = Defaults();
        if (cfg is null) return defaults;
        foreach (var (key, value) in defaults)
            if (cfg[key] is null) cfg[key] = value?.DeepClone();
        return cfg;
    }

    void SaveConfig()
    {
        try
        {
            var tmp = PortablePaths.ConfigFile + ".tmp";
            File.WriteAllText(tmp, _cfg.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, PortablePaths.ConfigFile, true);
        }
        catch (Exception ex)
        {
            PortablePaths.Log("config not saved: " + ex.Message);
        }
    }

    public List<string> Sources() =>
        (_cfg["sources"] as JsonArray)?.Select(Str).Where(s => !string.IsNullOrWhiteSpace(s)).Cast<string>().ToList() ?? new();

    JsonObject DisplaysCfg()
    {
        if (_cfg["displays"] is not JsonObject d) _cfg["displays"] = d = new JsonObject();
        return d;
    }

    JsonObject Slot(string key)
    {
        var d = DisplaysCfg();
        if (d[key] is not JsonObject o) d[key] = o = new JsonObject();
        return o;
    }

    IEnumerable<string> SlotKeys() =>
        (Str(_cfg["layout"]) ?? "per") == "per" ? Screen.AllScreens.Select(s => s.DeviceName) : new[] { "*" };

    double MasterVolume => Math.Clamp(Num(_cfg["settings"]?["volume"], 100) / 100.0, 0, 1);

    /* ================= library ================= */

    void Rescan()
    {
        var sources = Sources();
        var items = Library.Scan(sources);
        foreach (var node in (_cfg["urls"] as JsonArray) ?? new JsonArray())
        {
            if (node is not JsonObject u || Str(u["url"]) is not { } url) continue;
            items.Add(new JsonObject
            {
                ["id"] = Str(u["id"]) ?? url, ["title"] = Str(u["title"]) ?? url, ["type"] = "web",
                ["url"] = url, ["path"] = url, ["supported"] = true, ["source"] = "url",
            });
        }
        _items = items;
        _byId = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in items) _byId.TryAdd(Str(item["id"])!, item);
        _sourcesKey = _cfg["sources"]?.ToJsonString() ?? "";
        _urlsKey = _cfg["urls"]?.ToJsonString() ?? "";
        if (_ui?.Core is { } core) WebHost.MapSources(core, sources);
        foreach (var w in _windows.Values) w.MapSources(sources);
    }

    static JsonObject UserProps(JsonObject item, JsonObject? props)
    {
        var result = new JsonObject();
        if (item["properties"] is JsonObject defs)
            foreach (var (key, def) in defs)
                if (def?["value"] is { } value) result[key] = value.DeepClone();
        if (props?["user"] is JsonObject user)
            foreach (var (key, value) in user) result[key] = value?.DeepClone();
        return result;
    }

    /* ================= what each display shows ================= */

    List<Target> Targets()
    {
        var screens = Screen.AllScreens;
        var layout = Str(_cfg["layout"]) ?? "per";
        if (layout == "stretch")
        {
            var all = screens.Select(s => s.Bounds).Aggregate(Rectangle.Union);
            return new() { new Target("*", all, "*") };
        }
        return screens.Select(s => new Target(s.DeviceName, s.Bounds, layout == "clone" ? "*" : s.DeviceName)).ToList();
    }

    string? PlaylistItem(string slot, string name)
    {
        if (_cfg["playlists"]?[name] is not JsonObject pl) return null;
        var ids = (pl["items"] as JsonArray)?.Select(Str)
            .Where(id => id is not null && _byId.TryGetValue(id, out var it) && Bool(it["supported"]))
            .Cast<string>().ToList() ?? new();
        if (ids.Count == 0) return null;
        var random = Str(pl["order"]) == "random";
        var minutes = Math.Max(0.1, Num(pl["minutes"], 15));
        var sig = $"{name}|{random}|{minutes}|{string.Join("|", ids)}";
        if (!_playlists.TryGetValue(slot, out var st) || st.Sig != sig)
        {
            st = new PlaylistState
            {
                Sig = sig, Random = random, Minutes = minutes,
                Order = random ? ids.OrderBy(_ => System.Random.Shared.Next()).ToList() : ids,
                Next = DateTime.Now.AddMinutes(minutes),
            };
            _playlists[slot] = st;
        }
        return st.Order[st.Index % st.Order.Count];
    }

    void AdvancePlaylist(string slot)
    {
        if (!_playlists.TryGetValue(slot, out var st) || st.Order.Count == 0) return;
        st.Index = (st.Index + 1) % st.Order.Count;
        if (st.Index == 0 && st.Random) st.Order = st.Order.OrderBy(_ => System.Random.Shared.Next()).ToList();
        st.Next = DateTime.Now.AddMinutes(st.Minutes);
    }

    static int Severity(string? action) => action switch { "mute" => 1, "pause" => 2, "stop" => 3, _ => 0 };

    (string? id, int severity, string reason) Resolve(Target t)
    {
        var slot = DisplaysCfg()[t.Slot] as JsonObject;
        var id = Str(slot?["item"]);
        if (Str(slot?["playlist"]) is { } pl) id = PlaylistItem(t.Slot, pl) ?? id;
        else _playlists.Remove(t.Slot);

        var severity = 0;
        var reason = "";
        void Hit(string? action, string why)
        {
            var s = Severity(action);
            if (s > severity) { severity = s; reason = $"{Verb(s)}: {why}"; }
        }
        if (_userStop) Hit("stop", "stopped from the tray or a hotkey");
        if (_userPause) Hit("pause", "paused from the tray or a hotkey");
        if (_userMute) Hit("mute", "muted from the tray or a hotkey");
        if (Bool(slot?["muted"])) Hit("mute", "this display is muted");

        var rules = _cfg["rules"] as JsonObject;
        string? Rule(string key) => Str(rules?[key]);
        if (_snap.Battery) Hit(Rule("battery"), "on battery");
        if (_displayOff) Hit(Rule("sleep"), "display asleep");
        if (_snap.OtherAudio) Hit(Rule("audio"), "another app is playing audio");
        if (_snap.FgApp.Length > 0 && t.Bounds.IntersectsWith(_snap.FgMonitor))
        {
            if (_snap.FgFullscreen) Hit(Rule("fullscreen"), $"{_snap.FgApp} is fullscreen");
            Hit(Rule("focused"), $"{_snap.FgApp} is focused");
        }
        if (_snap.Maximized.Any(m => m.IntersectsWith(t.Bounds))) Hit(Rule("maximized"), "a window is maximized");

        foreach (var node in (_cfg["appRules"] as JsonArray) ?? new JsonArray())
        {
            if (node is not JsonObject rule || !RuleMet(rule)) continue;
            var action = Str(rule["action"]);
            if (action == "wallpaper" && Str(rule["arg"]) is { } over) id = over;
            else Hit(action, $"rule for {Str(rule["app"])}");
        }
        return (id, severity, reason);
    }

    static string Verb(int severity) => severity switch { 1 => "Muted", 2 => "Paused", _ => "Stopped" };

    static string AppName(string? s)
    {
        var n = (s ?? "").Trim().ToLowerInvariant();
        return n.EndsWith(".exe") ? n[..^4] : n;
    }

    bool RuleMet(JsonObject rule)
    {
        var app = AppName(Str(rule["app"]));
        if (app.Length == 0) return false;
        return Str(rule["when"]) switch
        {
            "focused" => _snap.FgApp == app,
            "fullscreen" => _snap.FgApp == app && _snap.FgFullscreen,
            "maximized" => _snap.MaximizedApps.Contains(app),
            "audio" => _snap.AudioApps.Contains(app),
            _ => _snap.Running.Contains(app),
        };
    }

    public void Refresh()
    {
        if (Env is null || _exiting) return;
        if (!Smoke && _windows.Count > 0 && !IsWindow(_host)) DropWindows();   // Explorer went away
        var live = new HashSet<string>();
        var playing = new JsonObject();
        _reasons.Clear();
        foreach (var t in Targets())
        {
            var (id, severity, reason) = Resolve(t);
            if (reason.Length > 0) _reasons[t.Key] = reason;
            var item = id is not null && _byId.TryGetValue(id, out var it) && Bool(it["supported"]) ? it : null;
            if (item is null || severity >= 3) continue;
            if (!_windows.TryGetValue(t.Key, out var w))
            {
                if (!Smoke && (_host == IntPtr.Zero || !IsWindow(_host))) _host = Desktop.Host(out _insertAfter);
                if (!Smoke && _host == IntPtr.Zero) continue;
                w = new WallpaperWindow(this, t.Key, Smoke ? IntPtr.Zero : _host, Smoke ? IntPtr.Zero : _insertAfter, !Smoke && Desktop.Layered);
                _windows[t.Key] = w;
            }
            live.Add(t.Key);
            w.Place(t.Bounds);
            var props = DisplaysProps(id!);
            var fade = Bool(_cfg["playlists"]?[Str(DisplaysCfg()[t.Slot]?["playlist"]) ?? ""]?["fade"], true);
            w.Show(item, props, UserProps(item, props), MasterVolume, fade);
            w.SetMuted(severity >= 1);
            w.SetPaused(severity >= 2);
            playing[t.Key] = id;
        }
        var gone = _windows.Keys.Where(k => !live.Contains(k)).ToList();
        foreach (var k in gone) { _windows[k].Dispose(); _windows.Remove(k); }
        if (gone.Count > 0 && _windows.Count == 0 && !Smoke) Desktop.RepaintWallpaper();
        UpdateAudio();
        SendStatus(playing);
    }

    JsonObject DisplaysProps(string id) => (_cfg["props"]?[id] as JsonObject)?.DeepClone() as JsonObject ?? new JsonObject();

    void DropWindows()
    {
        foreach (var w in _windows.Values) w.Dispose();
        _windows.Clear();
        _host = IntPtr.Zero;
    }

    /* ================= rules: what's happening on the PC ================= */

    void Tick()
    {
        _snap = TakeSnapshot();
        foreach (var (slot, st) in _playlists.ToList())
            if (DateTime.Now >= st.Next && !_userPause && !_userStop) AdvancePlaylist(slot);
        Refresh();
    }

    Snapshot TakeSnapshot()
    {
        var snap = new Snapshot { Battery = SystemInformation.PowerStatus.PowerLineStatus == PowerLineStatus.Offline };
        var me = Environment.ProcessId;
        var fg = GetForegroundWindow();
        if (fg != IntPtr.Zero && !IsShell(fg, me))
        {
            GetWindowThreadProcessId(fg, out var pid);
            snap.FgApp = ProcessName((int)pid);
            snap.FgMonitor = Screen.FromHandle(fg).Bounds;
            GetWindowRect(fg, out var r);
            var rect = r.ToRectangle();
            // a maximized window also overhangs its monitor by its borders, so it isn't fullscreen
            snap.FgFullscreen = rect.Contains(snap.FgMonitor) && !IsZoomed(fg);
        }

        EnumWindows((h, _) =>
        {
            if (IsWindowVisible(h) && !IsIconic(h) && IsZoomed(h) && !IsCloaked(h) && !IsShell(h, me))
            {
                snap.Maximized.Add(Screen.FromHandle(h).Bounds);
                GetWindowThreadProcessId(h, out var pid);
                snap.MaximizedApps.Add(ProcessName((int)pid));
            }
            return true;
        }, IntPtr.Zero);
        if (snap.FgFullscreen) snap.Maximized.Add(snap.FgMonitor);

        var appRules = ((_cfg["appRules"] as JsonArray) ?? new JsonArray()).OfType<JsonObject>().ToList();
        if (appRules.Any(r => (Str(r["when"]) ?? "running") == "running"))
        {
            foreach (var p in Process.GetProcesses())
            {
                snap.Running.Add(p.ProcessName.ToLowerInvariant());
                p.Dispose();
            }
        }
        if (Str(_cfg["rules"]?["audio"]) is { } a && a != "keep" || appRules.Any(r => Str(r["when"]) == "audio"))
        {
            snap.AudioApps = AudioFeed.AppsPlaying(OurProcesses());
            snap.OtherAudio = snap.AudioApps.Count > 0;
        }
        return snap;
    }

    HashSet<int> OurProcesses()
    {
        var pids = new HashSet<int> { Environment.ProcessId };
        try
        {
            if (Env is not null)
                foreach (var info in Env.GetProcessInfos()) pids.Add(info.ProcessId);
        }
        catch { /* environment closing */ }
        return pids;
    }

    static bool IsShell(IntPtr hwnd, int me)
    {
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == me) return true;
        return ClassName(hwnd) is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Shell_SecondaryTrayWnd";
    }

    static string ProcessName(int pid)
    {
        try { using var p = Process.GetProcessById(pid); return p.ProcessName.ToLowerInvariant(); }
        catch { return ""; }
    }

    public void OnDisplayPower(bool on)
    {
        _displayOff = !on;
        Refresh();
    }

    public void OnDisplayChange()
    {
        _host = IntPtr.Zero;
        DropWindows();
        Refresh();
        SendState();
    }

    public void OnExplorerRestart()
    {
        DropWindows();
        if (_iconsHidden) Desktop.SetIconsHidden(true);
        Refresh();
    }

    /* ================= audio for audio-reactive web wallpapers ================= */

    /// <summary>Starts or stops the ~30 fps feed of audio bands and pointer position, as wallpapers ask for them.</summary>
    public void UpdateAudio()
    {
        var audio = _windows.Values.Any(w => w.WantsAudio);
        if (audio && !_audio.Running) _audio.Start();
        else if (!audio && _audio.Running) _audio.Stop();
        var feed = audio || _windows.Values.Any(w => w.WantsPointer);
        if (feed && !_audioTick.Enabled) _audioTick.Start();
        else if (!feed && _audioTick.Enabled) _audioTick.Stop();
    }

    Point _lastPointer = new(int.MinValue, 0);

    void PushAudio()
    {
        var json = _audio.Running ? "{\"type\":\"audio\",\"data\":" + JsonSerializer.Serialize(_audio.Bands()) + "}" : null;
        var cursor = Cursor.Position;
        var moved = cursor != _lastPointer;
        _lastPointer = cursor;
        foreach (var w in _windows.Values)
        {
            if (w.WantsAudio && json is not null) w.PostJson(json);
            if (w.WantsPointer && moved && w.Bounds.Width > 0)
            {
                var b = w.Bounds;
                FormattableString msg = $"{{\"type\":\"pointer\",\"x\":{(cursor.X - b.X) / (double)b.Width},\"y\":{(cursor.Y - b.Y) / (double)b.Height}}}";
                w.PostJson(msg.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
        }
    }

    /* ================= commands: tray, hotkeys, UI buttons ================= */

    public void Command(string? name, string? arg)
    {
        switch (name)
        {
            case "pause": _userPause = !_userPause; break;
            case "mute": _userMute = !_userMute; break;
            case "stop": _userStop = !_userStop; break;
            case "icons":
                _iconsHidden = !_iconsHidden;
                Desktop.SetIconsHidden(_iconsHidden);
                break;
            case "next": Next(); break;
            case "browse": ShowUi("wallpapers"); return;
            case "settings": ShowUi("settings"); return;
            case "wallpaper" when arg is not null:
                foreach (var k in SlotKeys()) { var s = Slot(k); s["item"] = arg; s["playlist"] = null; }
                ChangedByHost();
                break;
            case "playlist" when arg is not null:
                foreach (var k in SlotKeys()) Slot(k)["playlist"] = arg;
                ChangedByHost();
                break;
            case "profile" when arg is not null && (_cfg["profiles"]?[arg]) is JsonObject profile:
                _cfg["layout"] = profile["layout"]?.DeepClone() ?? JsonValue.Create("per");
                _cfg["displays"] = profile["displays"]?.DeepClone() ?? new JsonObject();
                ChangedByHost();
                break;
        }
        Refresh();
    }

    void Next()
    {
        var order = _items.Where(i => Bool(i["supported"]))
            .OrderBy(i => Str(i["title"]), StringComparer.CurrentCultureIgnoreCase)
            .Select(i => Str(i["id"])!).ToList();
        var changed = false;
        foreach (var key in SlotKeys())
        {
            var slot = Slot(key);
            if (Str(slot["playlist"]) is not null && _playlists.ContainsKey(key)) { AdvancePlaylist(key); continue; }
            if (order.Count == 0) continue;
            var at = order.FindIndex(id => string.Equals(id, Str(slot["item"]), StringComparison.OrdinalIgnoreCase));
            slot["item"] = order[(at + 1) % order.Count];
            changed = true;
        }
        if (changed) ChangedByHost();
    }

    void ChangedByHost()
    {
        SaveConfig();
        SendState();
    }

    void RegisterHotkeys()
    {
        if (Smoke) return;
        var key = _cfg["hotkeys"]?.ToJsonString() ?? "";
        if (key == _hotkeysKey) return;
        _hotkeysKey = key;
        for (var i = 1; i <= _hotkeys.Count; i++) UnregisterHotKey(_msg.Handle, i);
        _hotkeyErrors.Clear();
        _hotkeys = (_cfg["hotkeys"]?.DeepClone() as JsonArray) ?? new JsonArray();
        for (var i = 0; i < _hotkeys.Count; i++)
        {
            var keys = Str(_hotkeys[i]?["keys"]);
            if (!ParseHotkey(keys, out var mods, out var vk) || !RegisterHotKey(_msg.Handle, i + 1, mods | 0x4000 /* no repeat */, vk))
                _hotkeyErrors.Add(keys ?? "");
        }
        _lastStatus = "";
    }

    /// <summary>"Ctrl+Alt+P" → modifier flags and virtual key. At least one of Ctrl/Alt/Shift/Win is required.</summary>
    static bool ParseHotkey(string? text, out uint mods, out uint vk)
    {
        mods = 0;
        vk = 0;
        if (string.IsNullOrWhiteSpace(text)) return false;
        foreach (var part in text.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            switch (part.ToLowerInvariant())
            {
                case "ctrl": mods |= 2; break;
                case "alt": mods |= 1; break;
                case "shift": mods |= 4; break;
                case "win": mods |= 8; break;
                default:
                    if (!Enum.TryParse<Keys>(part, true, out var k)) return false;
                    vk = (uint)k;
                    break;
            }
        }
        return mods != 0 && vk != 0;
    }

    public void OnHotkey(int id)
    {
        if (id < 1 || id > _hotkeys.Count) return;
        var hk = _hotkeys[id - 1];
        Command(Str(hk?["action"]), Str(hk?["arg"]));
    }

    void ApplyStartup()
    {
        if (Smoke) return;
        try
        {
            using var run = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
            if (Bool(_cfg["settings"]?["startWithWindows"])) run.SetValue("Pape", $"\"{Environment.ProcessPath}\" --tray");
            else if (run.GetValue("Pape") is not null) run.DeleteValue("Pape", false);
        }
        catch (Exception ex)
        {
            PortablePaths.Log("start with Windows: " + ex.Message);
        }
    }

    /* ================= the library window ================= */

    public void ShowUi(string? page)
    {
        if (Env is null || _exiting) return;
        if (_ui is null || _ui.IsDisposed)
        {
            _uiReady = false;
            _ui = new MainForm(this, page);
            _ui.FormClosed += (_, _) => { _ui = null; _uiReady = false; };
            _ui.Show();
            return;
        }
        if (_ui.WindowState == FormWindowState.Minimized) _ui.WindowState = FormWindowState.Normal;
        if (!Smoke) _ui.Activate();
        if (page is not null) _ui.ShowPage(page);
    }

    public void OnUiMessage(string json)
    {
        JsonObject? msg;
        try { msg = JsonNode.Parse(json) as JsonObject; }
        catch (Exception ex) { PortablePaths.Log("bad ui message: " + ex.Message); return; }
        switch (Str(msg?["type"]))
        {
            case "ready":
                _uiReady = true;
                SendState();
                break;
            case "config" when msg!["config"] is JsonObject cfg:
                _cfg = (JsonObject)cfg.DeepClone();
                SaveConfig();
                var rescan = (_cfg["sources"]?.ToJsonString() ?? "") != _sourcesKey || (_cfg["urls"]?.ToJsonString() ?? "") != _urlsKey;
                if (rescan) Rescan();
                RegisterHotkeys();
                ApplyStartup();
                if (rescan) SendState(); else Refresh();
                break;
            case "rescan":
                Rescan();
                SendState();
                break;
            case "cmd":
                Command(Str(msg!["name"]), Str(msg["arg"]));
                break;
            case "pickFolder":
                using (var dlg = new FolderBrowserDialog { Description = "Choose a folder with wallpapers", UseDescriptionForTitle = true })
                    if (dlg.ShowDialog(_ui) == DialogResult.OK)
                        _ui?.Post(new JsonObject { ["type"] = "folder", ["path"] = dlg.SelectedPath }.ToJsonString());
                break;
            case "open" when Str(msg!["path"]) is { } path:
                if (File.Exists(path)) Process.Start("explorer.exe", $"/select,\"{path}\"");
                else if (Directory.Exists(path)) Process.Start("explorer.exe", $"\"{path}\"");
                break;
            case "devtools" when Str(msg!["display"]) is { } key:
                if (_windows.TryGetValue(key, out var w)) w.OpenDevTools();
                break;
            case "reset":
                _cfg = Defaults();
                SaveConfig();
                Rescan();
                RegisterHotkeys();
                ApplyStartup();
                SendState();
                break;
            case "exit":
                Exit();
                break;
        }
    }

    void SendState()
    {
        if (_ui is null || !_uiReady) { Refresh(); return; }
        var displays = new JsonArray(Screen.AllScreens.Select((s, i) => (JsonNode?)new JsonObject
        {
            ["key"] = s.DeviceName, ["name"] = $"Display {i + 1}", ["primary"] = s.Primary,
            ["x"] = s.Bounds.X, ["y"] = s.Bounds.Y, ["w"] = s.Bounds.Width, ["h"] = s.Bounds.Height,
        }).ToArray());
        var msg = new JsonObject
        {
            ["type"] = "state",
            ["config"] = _cfg.DeepClone(),
            ["items"] = new JsonArray(_items.Select(i => (JsonNode?)i.DeepClone()).ToArray()),
            ["displays"] = displays,
            ["version"] = AppInfo.Version,
            ["dataDir"] = PortablePaths.DataDir,
            ["weInstall"] = Library.WeInstall,
        };
        _ui.Post(msg.ToJsonString());
        _lastStatus = "";
        Refresh();
    }

    void SendStatus(JsonObject playing)
    {
        var status = new JsonObject
        {
            ["type"] = "status",
            ["paused"] = _userPause, ["muted"] = _userMute, ["stopped"] = _userStop, ["iconsHidden"] = _iconsHidden,
            ["playing"] = playing,
            ["reasons"] = JsonSerializer.SerializeToNode(_reasons),
            ["desktop"] = Desktop.Mode,
            ["hotkeyErrors"] = new JsonArray(_hotkeyErrors.Select(e => (JsonNode?)JsonValue.Create(e)).ToArray()),
        };
        var json = status.ToJsonString();
        if (json == _lastStatus) return;
        _lastStatus = json;
        _miPause.Checked = _userPause;
        _miMute.Checked = _userMute;
        _miStop.Checked = _userStop;
        _miIcons.Checked = _iconsHidden;
        if (_uiReady) _ui?.Post(json);
    }

    /* ================= shutdown ================= */

    void Exit()
    {
        if (_exiting) return;
        _exiting = true;
        _tick.Stop();
        _audioTick.Stop();
        _tray.Visible = false;
        _ui?.Close();
        DropWindows();
        _audio.Dispose();
        if (_iconsHidden) Desktop.SetIconsHidden(false);
        if (!Smoke) Desktop.RepaintWallpaper();
        _tray.Dispose();
        _msg.DestroyHandle();
        ExitThread();
    }

    public static Icon AppIcon(bool small)
    {
        using var s = typeof(Engine).Assembly.GetManifestResourceStream("app.ico")!;
        return small ? new Icon(s, SystemInformation.SmallIconSize) : new Icon(s);
    }

    /* ================= self-check (--smoke) ================= */

    static void ResetSmokeData()
    {
        foreach (var f in new[] { PortablePaths.ConfigFile, Path.Combine(PortablePaths.DataDir, "smoke.txt") })
            if (File.Exists(f)) File.Delete(f);
        var src = Path.Combine(PortablePaths.DataDir, "smoke-src");
        if (Directory.Exists(src)) Directory.Delete(src, true);
        Directory.CreateDirectory(Path.Combine(src, "web-test"));
        using (var bmp = new Bitmap(640, 360))
        using (var g = Graphics.FromImage(bmp))
        using (var brush = new LinearGradientBrush(new Rectangle(0, 0, 640, 360), Color.FromArgb(40, 90, 200), Color.FromArgb(240, 120, 60), 30f))
        {
            g.FillRectangle(brush, 0, 0, 640, 360);
            bmp.Save(Path.Combine(src, "Smoke Image.png"));
        }
        File.WriteAllText(Path.Combine(src, "web-test", "project.json"),
            """{"type":"web","file":"index.html","title":"Smoke Web","general":{"properties":{"word":{"type":"textinput","text":"Word","value":"ok","order":1}}}}""");
        File.WriteAllText(Path.Combine(src, "web-test", "index.html"), """
            <!doctype html><html><body style="margin:0;background:#123;color:#fff;font:48px sans-serif">
            <div id="t">waiting</div>
            <script>
              window.wallpaperPropertyListener = {
                applyUserProperties(p) { if (p.word) document.title = 'props:' + p.word.value; document.getElementById('t').textContent = document.title; },
                setPaused(v) { window.__paused = v; }
              };
              window.wallpaperRegisterAudioListener(a => { window.__audio = a.length; });
            </script></body></html>
            """);
        // A packed scene with its own shader and texture: top half green, bottom half blue.
        Directory.CreateDirectory(Path.Combine(src, "scene-test"));
        File.WriteAllText(Path.Combine(src, "scene-test", "project.json"), """{"type":"scene","file":"scene.json","title":"Smoke Scene"}""");
        var pixels = new byte[64 * 64 * 4];
        for (var i = 0; i < 64 * 64; i++) { pixels[i * 4 + (i < 64 * 32 ? 1 : 2)] = 200; pixels[i * 4 + 3] = 255; }
        byte[] Text(string t) => System.Text.Encoding.UTF8.GetBytes(t);
        File.WriteAllBytes(Path.Combine(src, "scene-test", "scene.pkg"), SmokePkg(
            ("scene.json", Text("""{"general":{"clearcolor":"1 0 0","orthogonalprojection":{"width":64,"height":64}},"objects":[{"name":"square","image":"models/smoke.json","origin":"32 32 0","scale":"1 1 1","angles":"0 0 0"},{"name":"dots","image":null,"particle":"particles/smoke.json","origin":"4 4 0"},{"name":"tile","model":"models/tile.mdl","origin":"60 4 0","scale":"2 2 1"},{"name":"puppet","image":"models/puppet.json","origin":"60 60 0","scale":"0.05 0.05 1","animationlayers":[{"animation":7,"rate":1,"blend":1,"visible":true}]}]}""")),
            ("models/tile.mdl", SmokeMdl()),
            ("models/puppet.json", Text("""{"autosize":true,"material":"materials/smoke.json","puppet":"models/puppet.mdl"}""")),
            ("models/puppet.mdl", SmokePuppetMdl()),
            // a small particle system in a corner, away from the pixels the colour check reads
            ("particles/smoke.json", Text("""{"material":"materials/dot.json","maxcount":50,"starttime":1,"emitter":[{"name":"sphererandom","rate":100,"distancemax":2,"directions":"1 1 0"}],"initializer":[{"name":"lifetimerandom","min":5,"max":5},{"name":"sizerandom","min":2,"max":2}],"operator":[{"name":"movement"}],"renderer":[{"name":"sprite"}]}""")),
            ("materials/dot.json", Text("""{"passes":[{"blending":"translucent"}]}""")),
            ("models/smoke.json", Text("""{"autosize":true,"material":"materials/smoke.json"}""")),
            ("materials/smoke.json", Text("""{"passes":[{"shader":"smoke","blending":"translucent","textures":["smoke"],"constantshadervalues":{"mult":1}}]}""")),
            ("materials/smoke.tex", SmokeTex(64, 64, pixels)),
            ("shaders/smoke.vert", Text("""
                uniform mat4 g_ModelViewProjectionMatrix;
                attribute vec3 a_Position;
                attribute vec2 a_TexCoord;
                varying vec2 v_TexCoord;
                void main() { gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix); v_TexCoord = a_TexCoord; }
                """)),
            // "* 1" is an integer literal on purpose: Pape must turn it into 1.0 for WebGL
            ("shaders/smoke.frag", Text("""
                uniform sampler2D g_Texture0;
                uniform float g_Mult; // {"material":"mult","default":0}
                varying vec2 v_TexCoord;
                void main() { gl_FragColor = texSample2D(g_Texture0, v_TexCoord) * g_Mult * 1; }
                """))));
        // rules off: what the owner happens to have on screen must not pause the self-check's wallpapers
        var keep = new JsonObject();
        foreach (var rule in new[] { "focused", "maximized", "fullscreen", "battery", "audio", "sleep" }) keep[rule] = "keep";
        File.WriteAllText(PortablePaths.ConfigFile,
            new JsonObject { ["sources"] = new JsonArray(JsonValue.Create(src)), ["rules"] = keep }.ToJsonString());
    }

    /// <summary>scene.pkg: "PKGV0001", file count, then (name, offset, length) entries and the file data.</summary>
    static byte[] SmokePkg(params (string name, byte[] data)[] files)
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        void Str(string t) { var b = System.Text.Encoding.UTF8.GetBytes(t); w.Write(b.Length); w.Write(b); }
        Str("PKGV0001");
        w.Write(files.Length);
        var offset = 0;
        foreach (var (name, data) in files) { Str(name); w.Write(offset); w.Write(data.Length); offset += data.Length; }
        foreach (var (_, data) in files) w.Write(data);
        return ms.ToArray();
    }

    /// <summary>A one-quad .mdl (positions and uvs, flags 9) using the smoke material.</summary>
    static byte[] SmokeMdl()
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write("MDLV0014\0"u8);
        foreach (var v in new[] { 9 /* position + uv */, 1 /* material name per mesh */, 1 /* mesh */ }) w.Write(v);
        w.Write("materials/smoke.json\0"u8);
        w.Write(0);
        w.Write(4 * 20);
        foreach (var (x, y, u, v) in new[] { (-1f, -1f, 0f, 1f), (1f, -1f, 1f, 1f), (1f, 1f, 1f, 0f), (-1f, 1f, 0f, 0f) })
        { w.Write(x); w.Write(y); w.Write(0f); w.Write(u); w.Write(v); }
        w.Write(12);
        foreach (var i in new ushort[] { 0, 1, 2, 0, 2, 3 }) w.Write(i);
        w.Write((byte)0);
        return ms.ToArray();
    }

    /// <summary>
    /// A puppet-warp .mdl: one 64x64 quad bound to one bone, and animation 7 (1 fps, 2 frames) that slides the
    /// bone 10 units right at frame 1. Laid out as Wallpaper Engine writes them (see docs\SCENE-FORMAT.md).
    /// </summary>
    static byte[] SmokePuppetMdl()
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        void Ints(params int[] v) { foreach (var x in v) w.Write(x); }
        void Floats(params float[] v) { foreach (var x in v) w.Write(x); }
        const int flags = 9 | 0x800000 | 0x1000000;   // position, bone indices, bone weights, uv
        w.Write("MDLV0023\0"u8);
        Ints(flags, 1, 1);
        w.Write("materials/smoke.json\0"u8);
        Ints(0);
        Floats(0, 0, 0, 0, 0, 0);
        Ints(flags, 4 * 52);
        foreach (var (x, y, u, v) in new[] { (-32f, -32f, 0f, 1f), (32f, -32f, 1f, 1f), (32f, 32f, 1f, 0f), (-32f, 32f, 0f, 0f) })
        {
            Floats(x, y, 0);
            Ints(0, 0, 0, 0);
            Floats(1, 0, 0, 0);
            Floats(u, v);
        }
        Ints(12);
        foreach (var i in new ushort[] { 0, 1, 2, 0, 2, 3 }) w.Write(i);
        w.Write((byte)0);
        w.Write("MDLS0004\0"u8);
        Ints(0, 1);                               // end offset (not used by Pape), one bone
        w.Write("\0"u8);
        Ints(1, -1, 64);
        Floats(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
        w.Write("{}\0"u8);
        w.Write("MDLA0006\0"u8);
        Ints(0, 1, 7, 0);                         // end offset, one animation, id 7
        w.Write("slide\0loop\0"u8);
        Floats(1);
        Ints(2, 0, 1, 0, 3 * 36);                 // 2 frames, one bone track of 3 frames
        foreach (var x in new[] { 0f, 10f, 0f }) Floats(x, 0, 0, 0, 0, 0, 1, 1, 1);
        return ms.ToArray();
    }

    /// <summary>An uncompressed RGBA .tex with one mip level.</summary>
    static byte[] SmokeTex(int width, int height, byte[] rgba)
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write("TEXV0005 TEXI0001 "u8);
        foreach (var v in new[] { 0 /* RGBA8888 */, 2 /* clamp */, width, height, width, height, 0 }) w.Write(v);
        w.Write("TEXB0003 "u8);
        foreach (var v in new[] { 1 /* images */, -1 /* raw pixels */, 1 /* mips */, width, height, 0 /* not LZ4 */, rgba.Length, rgba.Length }) w.Write(v);
        w.Write(rgba);
        return ms.ToArray();
    }

    async Task RunSmokeAsync()
    {
        var report = new List<string>();
        var pass = true;
        void Check(bool ok, string what) { report.Add((ok ? "ok    " : "FAIL  ") + what); pass &= ok; }
        var dir = PortablePaths.DataDir;
        try
        {
            for (var i = 0; i < 150 && !_uiReady; i++) await Task.Delay(100);
            Check(_uiReady, "library window loaded");
            Check(_items.Count == 3, $"library found {_items.Count} wallpapers (expected 3)");
            var probe = await _ui!.EvalPromiseAsync(WebHost.ReadResource("smoke.js"));
            Check(probe.ok, "library window clicks through every tab: " + probe.result);

            var key = Targets()[0].Key;
            async Task<string> WaitFor(string script, Func<string, bool> done)
            {
                var v = "";
                for (var i = 0; i < 100; i++)
                {
                    if (_windows.TryGetValue(key, out var w) && done(v = await w.EvalAsync(script))) return v;
                    await Task.Delay(100);
                }
                return v;
            }
            var width = await WaitFor("String(document.querySelector('.layer.on img')?.naturalWidth || 0)", v => v == "\"640\"");
            Check(width == "\"640\"", $"image wallpaper shown (natural width {width})");
            await Task.Delay(1200);   // let the fade-in finish
            if (_windows.TryGetValue(key, out var win)) await win.CaptureAsync(Path.Combine(dir, "smoke-image.png"));
            await _ui.CaptureAsync(Path.Combine(dir, "smoke-ui.png"));

            var web = _items.First(i => Str(i["type"]) == "web");
            var webId = Str(web["id"])!;
            Slot(key)["item"] = webId;
            Slot(key)["playlist"] = null;
            Refresh();
            var title = await WaitFor("document.title", v => v.Contains("props:ok"));
            Check(title.Contains("props:ok"), $"web wallpaper got its properties ({title})");
            var audio = await WaitFor("String(window.__audio || 0)", v => v == "\"128\"");
            Check(audio == "\"128\"", $"web wallpaper gets audio bands ({audio})");
            if (_windows.TryGetValue(key, out win)) await win.CaptureAsync(Path.Combine(dir, "smoke-web.png"));

            if (_cfg["props"] is not JsonObject props) _cfg["props"] = props = new JsonObject();
            props[webId] = new JsonObject { ["user"] = new JsonObject { ["word"] = "changed" } };
            Refresh();
            title = await WaitFor("document.title", v => v.Contains("props:changed"));
            Check(title.Contains("props:changed"), $"changed property reaches the running wallpaper ({title})");

            Command("pause", null);
            var paused = await WaitFor("String(window.__paused)", v => v == "\"true\"");
            Check(paused == "\"true\"", $"pause reaches the wallpaper ({paused})");
            Command("pause", null);

            var sceneId = Str(_items.First(i => Str(i["type"]) == "scene")["id"])!;
            Slot(key)["item"] = sceneId;
            Refresh();
            const string probeScene = """
                (() => { const s = window.__scene; if (!s) return 'no scene ' + (window.__sceneError || '');
                  s.render(); const gl = s.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, a = new Uint8Array(4), b = new Uint8Array(4);
                  gl.readPixels(w >> 1, Math.floor(h * 0.7), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
                  gl.readPixels(w >> 1, Math.floor(h * 0.3), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
                  return 'top ' + [...a].slice(0, 3) + ' bottom ' + [...b].slice(0, 3); })()
                """;
            var colours = await WaitFor(probeScene, v => v.Contains("top"));
            Check(colours.Contains("top 0,200,0 bottom 0,0,200"), $"packed scene drawn the right way up ({colours})");
            var dots = await WaitFor("String(window.__scene?.layers.find(l => l.system)?.system.particles.length || 0)", v => v != "\"0\"");
            Check(dots != "\"0\"" && dots != "null", $"packed scene's particle system is running ({dots} particles)");
            var meshes = await WaitFor("String(window.__scene?.layers.find(l => l.meshes)?.meshes.length || 0)", v => v != "\"0\"");
            Check(meshes == "\"1\"", $"packed scene's .mdl model loaded ({meshes} mesh)");
            const string probePuppet = """
                (() => { const s = window.__scene, l = s?.layers.find(l => l.puppet); if (!l) return 'no puppet';
                  const p = l.puppet, t = s.time; s.time = 0; s.skin(p); const a = p.out[0];
                  s.time = 1; s.skin(p); const b = p.out[0]; s.time = t; return 'moved ' + Math.round(b - a); })()
                """;
            var puppet = await WaitFor(probePuppet, v => v.Contains("moved"));
            Check(puppet == "\"moved 10\"", $"packed scene's puppet bends with its animation ({puppet})");
            if (_windows.TryGetValue(key, out win)) await win.CaptureAsync(Path.Combine(dir, "smoke-scene.png"));

            // A real Wallpaper Engine scene with its shaders from WE's install, when WE is on this PC.
            var beach = Library.WeInstall is { } we ? Path.Combine(we, "projects", "defaultprojects", "beach") : null;
            if (beach is not null && Directory.Exists(beach))
            {
                ((JsonArray)_cfg["sources"]!).Add(Path.GetDirectoryName(beach));
                Rescan();
                Slot(key)["item"] = _items.FirstOrDefault(i => string.Equals(Str(i["path"]), beach, StringComparison.OrdinalIgnoreCase))?["id"]?.GetValue<string>();
                Refresh();
                var layers = await WaitFor("String(window.__sceneError || (window.__scene && window.__scene.layers.length) || '')", v => v.Length > 2);
                Check(layers == "\"3\"", $"Wallpaper Engine's Beach scene loads all 3 layers ({layers})");
                await Task.Delay(1500);
                if (_windows.TryGetValue(key, out win))
                {
                    var beachInfo = await win.EvalAsync("""
                        (() => { const s = window.__scene; s.render(); const gl = s.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                          const p = new Uint8Array(4); gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
                          return 'frames ' + (window.__frames || 0) + ' centre ' + [...p] + ' canvas ' + gl.drawingBufferWidth + 'x' + gl.drawingBufferHeight; })()
                        """);
                    Check(!beachInfo.Contains("frames 0 ") && !beachInfo.Contains("centre 0,0,0"), "Beach scene keeps drawing frames: " + beachInfo);
                    await win.CaptureAsync(Path.Combine(dir, "smoke-we-scene.png"));
                }

                // and a 3D one: perspective camera, .mdl models, lit materials
                var car = Path.Combine(Path.GetDirectoryName(beach)!, "fantasticcar");
                Slot(key)["item"] = _items.FirstOrDefault(i => string.Equals(Str(i["path"]), car, StringComparison.OrdinalIgnoreCase))?["id"]?.GetValue<string>();
                Refresh();
                var carInfo = await WaitFor("String(window.__sceneError || (window.__scene && window.__scene.is3D && window.__scene.layers.filter(l => l.meshes).length) || '')", v => v.Length > 2);
                Check(carInfo == "\"4\"", $"Wallpaper Engine's 3D Fantastic Car scene loads its 4 models ({carInfo})");
                var bloom = await WaitFor("String(window.__scene?.bloomPasses?.length || 0)", v => v != "\"0\"");
                Check(bloom == "\"4\"", $"Wallpaper Engine's 4 bloom passes compile ({bloom})");
                await Task.Delay(1500);
                if (_windows.TryGetValue(key, out win)) await win.CaptureAsync(Path.Combine(dir, "smoke-we-3d.png"));
            }
            else report.Add("skipped: Wallpaper Engine sample scene (Wallpaper Engine not installed)");

            _ui.ShowPage("settings");
            await Task.Delay(500);
            await _ui.CaptureAsync(Path.Combine(dir, "smoke-settings.png"));

            Desktop.Host(out _);
            report.Add("desktop host on this PC: " + Desktop.Mode);
        }
        catch (Exception ex)
        {
            Check(false, "exception: " + ex);
        }
        File.WriteAllText(Path.Combine(dir, "smoke.txt"), (pass ? "PASS" : "FAIL") + "\n" + string.Join("\n", report) + "\n");
        Exit();
    }

    /* ================= json helpers ================= */

    static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    static bool Bool(JsonNode? n, bool fallback = false) => n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : fallback;
    static double Num(JsonNode? n, double fallback) => n is JsonValue v && v.TryGetValue<double>(out var d) ? d : fallback;
}
