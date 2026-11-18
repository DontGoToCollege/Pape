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

## Particles
A particle object points at a particle json: `material`, `maxcount`, `starttime` (seconds to run ahead),
`animationmode` (sequence / randomframe for sprite-sheet textures), `sequencemultiplier`, `controlpoint[]`
(`flags` 1 = follows the mouse, `offset`), and four lists, each entry with a `name`:
- `emitter`: `sphererandom` (random point in a sphere stretched per axis by `directions`, between `distancemin`
  and `distancemax`, moving outward at `speedmin..speedmax`) or `boxrandom`; `rate` per second, `instantaneous`,
  `delay`, `duration`, periodic on/off times, `sign`, `controlpoint`.
- `initializer`: lifetime, size (full width), colour (0..255), alpha, velocity, rotation, angular velocity,
  turbulent velocity, position offset, HSV colour; `min`/`max` with an optional `exponent`.
- `operator`: movement (gravity, drag), alpha fade (in/out fractions of the lifetime), size/colour/alpha change
  over the lifetime, oscillate position/alpha/size (between `scalemin` and `scalemax`), angular movement,
  turbulence, control point attract, vortex, cap velocity, reduce movement near a control point.
- `renderer`: `sprite`, `spritetrail` (stretched along the velocity: `length`, `minlength`, `maxlength`), rope.
The object's `instanceoverride` multiplies rate, count, lifetime, size, speed and alpha and tints by `colorn`.
WE's particle shaders have a path without geometry shaders: each quad corner carries the particle's centre
(`a_Position`), corner/rotation/size (`a_TexCoordVec4`), x/y rotation (`a_TexCoordC2`), `a_Color` and
velocity/life (`a_TexCoordVec4C1`, with the `THICKFORMAT` combo), plus `g_RenderVar0` (trail lengths) and
`g_RenderVar1` (sprite frame size and count).
