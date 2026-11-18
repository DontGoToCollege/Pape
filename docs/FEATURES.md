# Pape: feature map and build plan

Pape is an offline, personal-use wallpaper program built to feel like Wallpaper Engine (WE) 2.8.0.42.
This file records what WE does (taken from its shipped files) and how Pape will do it.

## How this was worked out (clean-room)

- **Read:** WE's English UI text (`locale\ui_en-us.json`, 3,332 strings; `core_en-us.json`, 96 tray strings),
  the UI bundle's route list (REA evidence `ev_6376d897…`, `ui\dist\scripts\scripts.js`),
  the install layout, and the default wallpapers' `project.json` files.
- **Not done:** WE's program code (`wallpaper64.exe`, `wallpaperui.exe`, the DLLs) was not decompiled.
  None of WE's code, art, shaders, UI or sounds are copied into Pape.
- **Scene wallpapers** need WE's engine assets (`assets\shaders`, `materials`, …). Pape will read them
  from the WE install on the same PC at run time and never ship them.

## What Wallpaper Engine is made of

| Part | File | Role |
|---|---|---|
| Launcher | `launcher.exe` → `distribution\wallpaper64.exe` | Native D3D11 renderer, tray, desktop host |
| UI | `bin\wallpaperui.exe` (CEF) + `ui\dist` (AngularJS) | Browse, Settings, Displays, Editor screens |
| Web wallpapers | `bin\webwallpaper64.exe` (CEF), `edgewallpaper64.exe` | HTML wallpapers, livestream URLs |
| Scene scripting | `bin\scenescript64.dll` (V8) | SceneScript in scene wallpapers |
| App wallpapers | `bin\applicationwallpaperinject64.exe` | Runs an .exe as a wallpaper |
| Screensaver | `bin\wpxscreensaver64.scr` | Uses a wallpaper as the Windows screensaver |
| LEDs | `plugins\led\ledextensions64.dll`, `CUESDK`, Chroma | Corsair iCUE / Razer Chroma lighting |
| Depth AI | `dlc\pymidas` (Python + MiDaS weights) | Makes 3D depth from a flat image (editor) |
| Editor | `/editor` route, ~2,160 strings | Scene editor, particles, puppet warp, code editor |

## Wallpaper types (all four in WE's type filter)

| Type | Stored as | Pape plan |
|---|---|---|
| **Video** | `project.json` + `.mp4`/`.webm` | Phase 1: WebView2 `<video>` (hardware decode) |
| **Web** | `project.json` + `index.html` | Phase 1: WebView2, with WE's web API (properties, audio bars, media info) so existing web wallpapers run |
| **Image/GIF** | (template `gif`) | Phase 1 |
| **Scene** | `project.json` + `scene.json` (or packed `scene.pkg`) + materials/models/`.tex` textures + GLSL-style shaders | Phase 2: own D3D11 renderer that reads WE's format |
| **Application** | `.exe` | Phase 3 (or skip) |

## Features by screen

### Desktop and playback (core)
- Wallpaper drawn behind desktop icons on every display; desktop icon opacity.
- **Playback rules:** when another app is focused / maximized / fullscreen / playing audio, on battery,
  display asleep → Keep running, Mute, Pause, Stop (free memory), per display or all.
- **Application rules:** app name + condition (running, focused, maximized, fullscreen, playing audio) →
  pause/stop/mute or load a wallpaper/playlist/profile.
- Override the Windows wallpaper image and lock screen image (with restore); remove the Windows slideshow fade.
- Adjust Windows accent colour from the wallpaper.
- Start with Windows; process priority; crash protection (skip the last wallpaper if it crashed); restart after crash.
- Virtual desktop support (different wallpaper per virtual desktop).
- Media integration (now-playing title/artist/cover to wallpapers) with a blocklist.

### Hotkeys
Pause, stop, mute, toggle audio recording, hide desktop icons, screenshot, next wallpaper,
open Browse/Settings/Editor, start screensaver, and per wallpaper/playlist/profile hotkeys.
Hotkeys must use Ctrl/Shift/Alt; reassigning prompts to override.

### Browse (library)
- Grid of installed wallpapers with preview; search; filters (type, source, resolution, tags, age rating),
  sort (name, favourite, file size, last updated, date modified); favourites; block list.
- Per-wallpaper properties panel: the wallpaper's own user properties (colours, sliders, combos, toggles,
  text, files) plus scheme colour, playback rate, volume, audio recording, **alignment**
  (cover/center/stretch/fill/free + position/zoom/flip), brightness, saturation, hue, contrast,
  pixel-art optimization, image filter (LUTs) and strength.
- **Presets** of a wallpaper's property values.
- Open a wallpaper from a URL (with livestream mode).
- Context menu: open in Explorer, unsubscribe/delete, etc.

### Playlists
Add/remove/clear, save/load/delete by name, order (random/sorted), change interval, change by time of day
or weekday, transition settings (`transition`, `transitiontime`, `transitionpool`), update on pause, begin first.

### Displays
Layout: wallpaper per display, stretch one across all, clone one to all. Groups (stretch/clone),
splits (incl. auto-split NV Surround/Eyefinity), copy/swap between displays, per-display mute,
save/load **profiles**, separate screensaver config. Monitor identification modes (device path, layout, …).

### Settings
- **General:** language, theme (11 skins: White, Dark, Halloween, Obsidian, Mist, Rose, Moss, Rust, Metal,
  Space, Winter) + seasonal theming, UI quality, UI hardware acceleration, tray icon, browser transition.
- **Performance/quality:** preset Low/Medium/High/Ultra, FPS, anti-aliasing, texture resolution,
  reflections, post-processing, shadows, volumetric lighting, HDR (Ultra Display HDR).
- **Audio:** output device, recording device/volume/threshold (for audio-reactive wallpapers),
  reload on device change.
- **Video:** framework (Media Foundation DX9/DX11, DirectShow LAV, Chromium), hardware acceleration,
  load from disk vs in-memory, loop mode, Media Foundation stutter fix.
- **Advanced:** log level, CEF command line and devtools, unpause during Aero Peek, pause on low VRAM,
  high-precision timers, safe start after hibernation, reset config.
- **Plugins:** LED (iCUE, Chroma) with options.

### Not coming to Pape (Steam/online only)
Workshop browse/upload/ratings/comments, Steam login, mobile companion app sync, "Send to mobile",
adverts. Pape is offline; wallpapers come from folders on disk (including an existing WE/Steam Workshop folder).

## Build plan

**Phase 1: the program around the wallpapers** (most of the "vibe")
Tray app, desktop host behind icons on every display, video/web/image wallpapers, WE web-wallpaper API,
library grid with search/filter/sort/favourites, properties panel + presets, playlists, displays
(per display / stretch / clone, profiles), playback + application rules, hotkeys, Settings with themes.
Imports wallpapers from WE's `projects\myprojects` and Steam's `workshop\content\431960` folders.

**Phase 2: scene wallpapers.** Reverse `scene.pkg` / `.tex` / `scene.json` / material and shader formats
(REA on the user's own wallpaper files, like PortaSnap's `.snagx`), then a D3D11 renderer:
images + effects first, then particles, then puppet warp/3D models, then SceneScript.

**Phase 3 (optional):** application wallpapers, screensaver, LED plugins, own editor.

## Stack
.NET 8 WPF single-file exe + WebView2 (same approach as PortaSnap/MonkeyType Portable): the UI is an HTML page
in WebView2, and each display gets a borderless WebView2 window parented to the desktop `WorkerW`.
Data lives in `Pape-Data\` next to the exe (portable).

## Status
- **0.1.0:** Phase 1 delivered. Not yet in Phase 1: Windows lock-screen/wallpaper image override, accent colour
  from the wallpaper, desktop icon opacity, media integration (now-playing info), virtual desktops, screenshots,
  per-monitor "pause all" vs "pause this display" choice (Pape pauses only the affected display).
- **0.2.0:** Phase 2 step 1: 2D scenes (image layers, materials, effects, user settings, parallax, audio).
  Next: particles, then 3D scenes/models, puppet warp, text, sound, bloom, SceneScript.
