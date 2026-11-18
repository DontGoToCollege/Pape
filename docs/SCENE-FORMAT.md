# Wallpaper Engine scene format (as Pape reads it)

Worked out from Wallpaper Engine's own sample scenes and asset folder (`projects\defaultprojects`,
`assets`), not from its program code. Pape's reader is `web/scene/formats.js`, `shaders.js` and `scene.js`.

## Files
- `project.json`: `type` "scene" (missing in some old projects, which are scenes too), `file` (usually
  `scene.json`), `general.properties` (the user settings).
- Workshop scenes pack everything into **`scene.pkg`**: int32-length string `PKGV0001`, int32 file count,
  then per file (int32-length name, int32 offset, int32 length); offsets count from the end of that table.
- Files resolve against the package or wallpaper folder first, then WE's `assets` folder. Files of an
  effect (`effects/<name>/effect.json`) resolve inside that effect's folder first.

## scene.json
- `general.orthogonalprojection {width, height}` makes a 2D scene (scene units, y up, 0..width/0..height).
  Without it the scene is 3D (perspective camera): Pape shows the preview picture for those for now.
- `general.clearcolor`, `cameraparallax`, `cameraparallaxamount`, `cameraparallaxdelay`, bloom settings.
- `objects[]`: `image` (model json), `particle`, `model` (.mdl), `text`, `sound`, `light`.
  `origin`/`scale`/`angles` are "x y z" strings; angles are radians. `parallaxDepth` "x y".
- Any value may be `{"user": "prop", "value": v}` (bound to a user setting),
  `{"user": {"name": "prop", "condition": "1"}, "value": v}` (true when the setting equals the condition),
  or `{"script": "...", "value": v}` (SceneScript; Pape uses `value`).
- `effects[]`: `{file, visible, passes: [{constantshadervalues, combos, textures}]}`, one entry per effect pass.

## Models, materials, effects
- Image model: `{material, width, height}` or `autosize: true` (size of texture 0), `fullscreen`, `passthrough`.
- Material: `passes[]` with `shader`, `textures[]`, `blending` (translucent, additive, normal),
  `combos`, `constantshadervalues` (material key → value), `usershadervalues` (user setting → material key).
- `effect.json`: `passes[]` with `material`, `target` (an fbo, else the layer's ping-pong buffer),
  `bind[] {name, index}` ("previous" = the result so far; slot 0 defaults to it); `fbos[] {name, scale}`.

## Shaders
GLSL with HLSL-style helpers (`mul(v, M)`, `texSample2D`, `frac`, `saturate`, `lerp`, `CAST3`...),
`#include` from `assets/shaders`, `// [COMBO] {...}` switches and `uniform ...; // {"material": key, "default": ...}`
bindings. HLSL habits that WebGL rejects and Pape rewrites: integer literals in float maths, undefined names in
`#if`, `pow(vec3, float)` and `max(float, vec3)`, reserved words such as `sample`, uniforms used before declared.
Texture 0's format goes into the `TEX0FORMAT` combo (RG88 = grey+alpha, R8 = alpha only).

## .tex
`TEXV0005\0` `TEXI0001\0`, then int32 format (0 RGBA8888, 4 DXT5, 6 DXT3, 7 DXT1, 8 RG88, 9 R8), flags
(1 no filtering, 2 clamp, 4 sprite sheet), texture width/height (padded to a power of two), picture
width/height, one unused int32. Then `TEXB0001..4\0`, image count, (v3+) image file format (-1 = raw pixels,
otherwise each mip is a PNG/JPEG file), (v4) is-mp4 flag. Per image: mip count; per mip: width, height,
(v2+) LZ4 flag and unpacked size, byte count, bytes (LZ4 block format when flagged). Sprite sheets end with
`TEXS0001..3\0`, frame count, ((v3) width, height), then per frame image index, seconds, x, y, w, wy, hx, h.
