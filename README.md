# Pape

Live wallpapers for Windows that sit behind your desktop icons, inspired by the look and feel of Wallpaper Engine.
Pape is offline and portable: one `.exe`, no account, no store, and your settings stay in a folder next to it.

## What it does

- **Pictures, videos and web pages as wallpapers**, drawn behind the desktop icons on every display.
- **Plays Wallpaper Engine wallpapers** of the *video* and *web* kinds straight from Steam's Workshop folder
  or your own folders, including their settings (colours, sliders, switches) and music-reactive bars.
  *Scene* wallpapers play too, with their layers, effects and settings (Wallpaper Engine must be installed on the
  same PC for scenes that use its effects), including their particles (snow, rain, fire, sparkles and more)
  3D scenes with models, lights, moving cameras and glow (bloom), and puppet-warp characters that breathe and blink.
- **Library:** search, filter by type, sort, favourites, and open any web page by its address.
- **Per-wallpaper look:** alignment (cover, fit, stretch, centre), position, zoom, flip, brightness, contrast,
  saturation, hue, video speed and volume, plus saved **presets**.
- **Playlists** that change the wallpaper every few minutes, in order or shuffled, with a fade.
- **Displays:** a wallpaper per display, one stretched across all of them, or the same one on each,
  with saved **profiles**.
- **Playback rules:** pause, mute or stop wallpapers while another app is focused, maximized, fullscreen
  or playing sound, on battery, or while the display sleeps. **Application rules** do the same for a
  particular program, or swap in a different wallpaper while it runs.
- **Hotkeys** for pause, stop, mute, next wallpaper, hiding desktop icons, and for any wallpaper, playlist or profile.
- Tray icon, start with Windows, six colour themes.

## Download and use

1. Download `Pape.exe` from the [Releases page](https://github.com/DontGoToCollege/Pape/releases).
2. Put it in any folder and run it. Pape keeps everything in a `Pape-Data` folder beside the exe.
3. Pape looks in your `Pictures\wallpapers` folder (or `Pictures`) and, if you have Wallpaper Engine,
   in its Workshop and project folders. Add more folders under **Settings → Wallpaper folders**.
4. Click a wallpaper to put it on the display chosen at the top right.
5. Closing the window keeps Pape running in the tray. Right-click the tray icon to pause, mute, change
   wallpaper or exit.

Pape needs Windows 10 or 11 with the Microsoft Edge WebView2 Runtime, which comes with Windows 11.

## Building

Needs the .NET SDK (8 or later). Run `.\publish.ps1`, which builds `Pape.exe`, runs its self-check and
keeps a copy in `Versions\Archive`. Use `.\publish.ps1 -Test` to try a build without archiving it.

Pape is an independent personal project. It can play wallpapers made for Wallpaper Engine but contains
none of Wallpaper Engine's code or files and is not made by or connected to its developers.

## License

MIT: free for anyone to use, change and share. See [LICENSE](LICENSE).
