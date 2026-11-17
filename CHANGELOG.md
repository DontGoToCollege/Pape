# Changelog

## 0.1.1 (2026-11-17)

- Fixed the wallpaper grid: with more than a screenful of wallpapers the rows overlapped, so titles were hidden
  and a click could pick a different wallpaper than the one under the pointer.

## 0.1.0 (2026-11-17)

First version (Phase 1 of the plan in `docs/FEATURES.md`).

- Image, video and web-page wallpapers behind the desktop icons, one per display, stretched or cloned.
- Plays Wallpaper Engine video and web wallpapers, with their user properties, audio bands and pause.
- Library with search, type filters, sorting, favourites and "open URL".
- Per-wallpaper look settings and presets; playlists; display profiles.
- Playback rules (focused, maximized, fullscreen, other audio, battery, display asleep) and application rules.
- Hotkeys, tray icon, start with Windows, six themes.
- `--smoke` self-check run by `publish.ps1` before a build is kept.
