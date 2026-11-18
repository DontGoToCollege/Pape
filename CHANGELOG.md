# Changelog

## 0.3.0 (2026-11-17)

Phase 2, step 2: **particles** in scene wallpapers.

- Particle systems (snow, rain, fire, embers, leaves, bubbles, sparkles, stars, smoke and so on) run in scenes,
  drawn with each material's own Wallpaper Engine particle shader so colours, tints and soft edges match.
- Emitters, the common initializers and operators, sprite-sheet animation, trails (rain streaks),
  mouse-following control points and the scene's per-object overrides (count, rate, size, speed, alpha, colour).
- Objects that list several kinds (image, model, particle) with only one filled in are read correctly.
- Not yet: child particle systems (such as firework bursts), ropes (drawn as sprites), boids.
- Self-check now also runs a small particle system in its test scene.

## 0.2.0 (2026-11-17)

Phase 2, step 1: Wallpaper Engine **scene** wallpapers (2D).

- Scenes play from their folder or a packed `scene.pkg` (as Steam's Workshop downloads them), with image layers,
  their materials and effect chains (scroll, tint, blur, shine and the rest of WE's effects), drawn with WebGL.
- Wallpaper Engine's shaders are translated to WebGL as they load; effects and shaders come from the
  Wallpaper Engine install on the same PC and are never copied into Pape.
- Scene settings (colours, switches, sliders bound to layers and effects), sprite-sheet animation, video
  textures, mouse parallax and music-reactive shaders.
- 3D scenes, particles, puppet animation, text and sound layers aren't drawn yet; 3D scenes show their preview.
- Self-check now also builds and draws a packed test scene, and draws Wallpaper Engine's Beach sample when installed.

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
