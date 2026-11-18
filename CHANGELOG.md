# Changelog

## 0.6.0 (2026-11-18)

Phase 2, step 5: **puppet animation**.

- Puppet-warp scene layers move: Pape reads the model's skeleton and animations (the `MDLS` and `MDLA` parts of
  the .mdl) and bends the picture's mesh every frame with the scene's chosen animation, speed and blend.
  Tested on a Workshop character that blinks.
- Layers attached to a parent object are placed relative to it (the blinking eyes sit on the face, clock and
  date text groups move together).
- Shaders: a wallpaper's own option switches now work in its arithmetic.
- Not yet: animated 3D models, text and sound layers, SceneScript.
- Self-check builds a one-bone puppet and confirms its animation moves it.

## 0.5.0 (2026-11-18)

Phase 2, step 4: **bloom (glow)**.

- Scenes with bloom on now glow, using Wallpaper Engine's own four bloom passes (bright parts at quarter size,
  blurred at an eighth, added back) with the scene's strength, threshold and tint, including user-bound values.
- 3D scenes draw see-through models far to near, so their clear parts no longer hide what's behind them
  (Neon Sunset's sun now sits behind the mountains). Opaque models and backgrounds keep the scene's order.
- Self-check confirms the bloom passes compile.

## 0.4.0 (2026-11-17)

Phase 2, step 3: **3D scenes**.

- 3D scene wallpapers play: perspective camera, camera paths that fly around the scene, `.mdl` models
  (Wallpaper Engine's model format, versions 4, 14 and 23) with their materials, point lights and depth.
- Wallpaper Engine's lit model shaders work: Pape supplies the lighting code WE normally generates per scene.
- Particles face the camera in 3D scenes; full-screen layers (backgrounds, post effects) sit over the 3D view.
- Material files with comments are read; one broken material no longer drops a whole model.
- Not yet: skinned/animated models, shadows, bloom (glow), fur, text and sound layers, SceneScript.
- Self-check now loads a small .mdl model it writes itself, and Wallpaper Engine's 3D Fantastic Car sample.

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
