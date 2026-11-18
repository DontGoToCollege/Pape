// Renders Wallpaper Engine 2D scenes (orthographic camera): image layers with their materials and
// effect chains, user-property bindings, sprite sheets, video textures, mouse parallax and audio.
// Particles are simulated in particles.js; 3D scenes use a perspective camera and .mdl models (model.js).
// Bloom runs WE's own four bloom passes. Not yet: puppet warp, skinned/animated models, shadows, text, sound,
// SceneScript (those layers are skipped).
//
// Conventions: the scene buffer is GL-native (y up, scene units 0..W, 0..H). Every per-layer buffer
// keeps WE's top-row-first layout, so texture v = 0 is the top of a picture everywhere.

import { loadShader } from './shaders.js';
import { readPkg, readTex, TEX, TEX_FLAG } from './formats.js';
import { ParticleSystem, PARTICLE_VS, PARTICLE_FS, VERTEX, ATTRIBUTES } from './particles.js';
import { readMdl } from './model.js';

const warn = (...a) => console.warn('[scene]', ...a);

/* ---------------- values ---------------- */

// WE's JSON files sometimes carry line and block comments and trailing commas.
function parseJson(text) {
  text = text.replace(/^﻿/, '');
  try { return JSON.parse(text); } catch { /* lenient read below */ }
  let out = '', inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

const nums = v => typeof v === 'number' ? [v] : typeof v === 'boolean' ? [+v]
  : typeof v === 'string' ? v.trim().split(/\s+/).map(Number) : Array.isArray(v) ? v.map(Number) : [];

/* ---------------- matrices (column-major) ---------------- */

const identity = () => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function invert(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b = [a00 * a11 - a01 * a10, a00 * a12 - a02 * a10, a00 * a13 - a03 * a10, a01 * a12 - a02 * a11, a01 * a13 - a03 * a11, a02 * a13 - a03 * a12,
    a20 * a31 - a21 * a30, a20 * a32 - a22 * a30, a20 * a33 - a23 * a30, a21 * a32 - a22 * a31, a21 * a33 - a23 * a31, a22 * a33 - a23 * a32];
  const det = b[0] * b[11] - b[1] * b[10] + b[2] * b[9] + b[3] * b[8] - b[4] * b[7] + b[5] * b[6];
  if (!det) return identity();
  const d = 1 / det;
  return new Float32Array([
    (a11 * b[11] - a12 * b[10] + a13 * b[9]) * d, (a02 * b[10] - a01 * b[11] - a03 * b[9]) * d, (a31 * b[5] - a32 * b[4] + a33 * b[3]) * d, (a22 * b[4] - a21 * b[5] - a23 * b[3]) * d,
    (a12 * b[8] - a10 * b[11] - a13 * b[7]) * d, (a00 * b[11] - a02 * b[8] + a03 * b[7]) * d, (a32 * b[2] - a30 * b[5] - a33 * b[1]) * d, (a20 * b[5] - a22 * b[2] + a23 * b[1]) * d,
    (a10 * b[10] - a11 * b[8] + a13 * b[6]) * d, (a01 * b[8] - a00 * b[10] - a03 * b[6]) * d, (a30 * b[4] - a31 * b[2] + a33 * b[0]) * d, (a21 * b[2] - a20 * b[4] - a23 * b[0]) * d,
    (a11 * b[7] - a10 * b[9] - a12 * b[6]) * d, (a00 * b[9] - a01 * b[7] + a02 * b[6]) * d, (a31 * b[1] - a30 * b[3] - a32 * b[0]) * d, (a20 * b[3] - a21 * b[1] + a22 * b[0]) * d,
  ]);
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan(fovDeg * Math.PI / 360), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = 2 * far * near / (near - far);
  return m;
}
function lookAt(eye, center, up) {
  const z = norm3(sub3(eye, center)), x = norm3(cross3(up, z)), y = cross3(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1]);
}
/** upper 3x3 of the inverse transpose: turns normals the way the model matrix turns surfaces */
function normalMatrix(m) {
  const i = invert(m);
  return new Float32Array([i[0], i[4], i[8], i[1], i[5], i[9], i[2], i[6], i[10]]);
}
function ortho(w, h) {
  const m = identity();
  m[0] = 2 / w; m[5] = 2 / h; m[10] = -1 / 10000; m[12] = -1; m[13] = -1;
  return m;
}
/** translate * rotZ * rotY * rotX * scale */
function modelMatrix([x, y, z], [sx, sy, sz], [ax, ay, az]) {
  const [cx, snx, cy, sny, cz, snz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  const r = [
    cz * cy, snz * cy, -sny,
    cz * sny * snx - snz * cx, snz * sny * snx + cz * cx, cy * snx,
    cz * sny * cx + snz * snx, snz * sny * cx - cz * snx, cy * cx,
  ];
  return new Float32Array([r[0] * sx, r[1] * sx, r[2] * sx, 0, r[3] * sy, r[4] * sy, r[5] * sy, 0, r[6] * sz, r[7] * sz, r[8] * sz, 0, x, y, z, 1]);
}

/* ---------------- the renderer ---------------- */

export class Scene {
  /**
   * @param canvas  WebGL2 canvas
   * @param base    URL of the wallpaper folder, ending in /
   * @param pkg     true when the folder holds scene.pkg
   * @param file    scene file name inside the folder or package (usually scene.json)
   * @param assets  URL of Wallpaper Engine's assets folder, ending in /
   * @param user    current user property values {name: value}
   */
  static async load({ canvas, base, pkg, file, assets, user }) {
    const s = new Scene(canvas, base, assets, user);
    if (pkg) s.pkg = readPkg(new Uint8Array(await (await fetch(base + 'scene.pkg')).arrayBuffer()));
    const scene = await s.json(file || 'scene.json');
    if (!scene) throw new Error('scene file not found');
    await s.build(scene);
    return s;
  }

  constructor(canvas, base, assets, user) {
    this.canvas = canvas;
    this.base = base;
    this.assets = assets;
    this.user = user || {};
    this.cache = new Map();
    this.programs = new Map();
    this.pointer = [0.5, 0.5];
    this.parallax = [0, 0];
    this.audio = new Float32Array(128);
    this.start = performance.now();
    const gl = this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    this.quad = this.buffer([-1, -1, 0, 0, 0, 1, -1, 0, 1, 0, -1, 1, 0, 0, 1, 1, 1, 0, 1, 1]);
    this.white = this.solid([255, 255, 255, 255]);
    this.blitProgram = this.compile(
      `#version 300 es
       in vec3 a_Position; in vec2 a_TexCoord; uniform mat4 u_Mvp; out vec2 v;
       void main() { v = a_TexCoord; gl_Position = u_Mvp * vec4(a_Position, 1.0); }`,
      `#version 300 es
       precision highp float; in vec2 v; uniform sampler2D u_Tex; out vec4 o;
       void main() { o = texture(u_Tex, v); }`);
  }

  /* ---------- files: package first, then the wallpaper folder, then WE's assets ---------- */

  async bytes(path) {
    path = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (this.pkg?.has(path)) return this.pkg.get(path);
    for (const root of [this.base, this.assets]) {
      if (!root) continue;   // no Wallpaper Engine on this PC: only the wallpaper's own files
      const url = root + path.split('/').map(encodeURIComponent).join('/');
      if (!this.cache.has(url)) this.cache.set(url, fetch(url).then(r => r.ok ? r.arrayBuffer().then(b => new Uint8Array(b)) : null, () => null));
      const b = await this.cache.get(url);
      if (b) return b;
    }
    return null;
  }
  async text(path) { const b = await this.bytes(path); return b && new TextDecoder().decode(b); }
  async json(path) { const t = await this.text(path); return t == null ? null : parseJson(t); }
  /** Reader for files of an effect: its own folder first ("effects/<name>/..."), then the usual places. */
  reader(dir = '') { return async p => (dir ? await this.text(dir + p) : null) ?? await this.text(p); }

  /** A value from scene.json that may be bound to a user property, a script or an animation. */
  value(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('user' in v) {
        const name = typeof v.user === 'string' ? v.user : v.user?.name;
        const u = this.user[name];
        if (v.user && typeof v.user === 'object' && 'condition' in v.user) return u === undefined ? v.value : String(u) === String(v.user.condition);
        return u === undefined ? v.value : u;
      }
      if ('value' in v) return v.value;
    }
    return v;
  }

  /* ---------- GL helpers ---------- */

  buffer(data) {
    const gl = this.gl, b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return b;
  }

  solid(rgba) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    return { tex: t, width: 1, height: 1, format: TEX.RGBA8888 };
  }

  compile(vs, fs, name = 'pape') {
    const gl = this.gl, prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`${name}: ${gl.getShaderInfoLog(sh)}`);
      gl.attachShader(prog, sh);
    }
    gl.bindAttribLocation(prog, 0, 'a_Position');
    gl.bindAttribLocation(prog, 1, 'a_TexCoord');
    gl.bindAttribLocation(prog, 2, 'a_Color');
    gl.bindAttribLocation(prog, 3, 'a_TexCoordVec4');
    gl.bindAttribLocation(prog, 4, 'a_TexCoordC2');
    gl.bindAttribLocation(prog, 5, 'a_TexCoordVec4C1');
    gl.bindAttribLocation(prog, 6, 'a_Normal');
    gl.bindAttribLocation(prog, 7, 'a_Tangent4');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(prog)}`);
    const uniforms = new Map();
    for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const u = gl.getActiveUniform(prog, i);
      uniforms.set(u.name.replace(/\[0\]$/, ''), { loc: gl.getUniformLocation(prog, u.name), type: u.type, size: u.size });
    }
    return { prog, uniforms };
  }

  target(width, height, depth = false) {
    const gl = this.gl;
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    if (depth) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    return { tex, fbo, rb, width, height, format: TEX.RGBA8888 };
  }

  /* ---------- textures ---------- */

  async texture(name) {
    const key = 'tex:' + name;
    if (!this.cache.has(key)) this.cache.set(key, this.loadTexture(name).catch(e => { warn('texture', name, e.message); return null; }));
    return this.cache.get(key);
  }

  async loadTexture(name) {
    const bytes = await this.bytes(`materials/${name}.tex`);
    if (!bytes) throw new Error('not found');
    const t = readTex(bytes);
    const gl = this.gl;
    const out = { width: t.width, height: t.height, format: t.format, frames: t.frames, texWidth: t.texWidth, texHeight: t.texHeight };
    const tex = out.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const nearest = t.flags & TEX_FLAG.NoInterpolation;
    const wrap = t.flags & TEX_FLAG.ClampUVs ? gl.CLAMP_TO_EDGE : gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);

    if (t.video) {
      // Video textures: an mp4 inside the .tex, uploaded every frame.
      const video = Object.assign(document.createElement('video'), { muted: true, loop: true, playsInline: true, autoplay: true });
      video.src = URL.createObjectURL(new Blob([t.mips[0].data], { type: 'video/mp4' }));
      await video.play().catch(() => {});
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      out.video = video;
      out.texWidth = out.width;
      out.texHeight = out.height;
      return out;
    }
    if (t.encoded) {
      const bmp = await createImageBitmap(new Blob([t.mips[0].data]), { imageOrientation: 'none', premultiplyAlpha: 'none' });
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      out.texWidth = bmp.width;
      out.texHeight = bmp.height;
      out.format = TEX.RGBA8888;
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR);
    } else {
      const dxt = { [TEX.DXT1]: 'COMPRESSED_RGBA_S3TC_DXT1_EXT', [TEX.DXT3]: 'COMPRESSED_RGBA_S3TC_DXT3_EXT', [TEX.DXT5]: 'COMPRESSED_RGBA_S3TC_DXT5_EXT' }[t.format];
      if (dxt && !this.s3tc) throw new Error('compressed textures are not supported here');
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      t.mips.forEach((m, i) => {
        if (dxt) gl.compressedTexImage2D(gl.TEXTURE_2D, i, this.s3tc[dxt], m.width, m.height, 0, m.data);
        else if (t.format === TEX.RG88) gl.texImage2D(gl.TEXTURE_2D, i, gl.RG8, m.width, m.height, 0, gl.RG, gl.UNSIGNED_BYTE, m.data);
        else if (t.format === TEX.R8) gl.texImage2D(gl.TEXTURE_2D, i, gl.R8, m.width, m.height, 0, gl.RED, gl.UNSIGNED_BYTE, m.data);
        else gl.texImage2D(gl.TEXTURE_2D, i, gl.RGBA8, m.width, m.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, m.data);
      });
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, Math.max(0, t.mips.length - 1));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : t.mips.length > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    }
    // Pictures padded up to a power of two are cut back to their real size, so UV 0..1 covers the picture.
    if (!out.frames.length && (out.texWidth !== out.width || out.texHeight !== out.height)) {
      const rt = this.target(out.width, out.height);
      this.blit(out, rt, [0, 0, out.width / out.texWidth, out.height / out.texHeight]);
      gl.deleteTexture(tex);
      gl.bindTexture(gl.TEXTURE_2D, rt.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR);
      gl.deleteFramebuffer(rt.fbo);
      out.tex = rt.tex;
      out.texWidth = out.width;
      out.texHeight = out.height;
    }
    return out;
  }

  /** Copies a texture region (u0, v0, u1, v1) into a whole render target, keeping row order. */
  blit(src, dst, [u0, v0, u1, v1] = [0, 0, 1, 1]) {
    const gl = this.gl, p = this.blitProgram;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.disable(gl.BLEND);
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.get('u_Tex').loc, 0);
    gl.uniformMatrix4fv(p.uniforms.get('u_Mvp').loc, false, identity());
    const tc = this.buffer([-1, -1, 0, u0, v0, 1, -1, 0, u1, v0, -1, 1, 0, u0, v1, 1, 1, 0, u1, v1]);
    this.drawQuad(tc);
    gl.deleteBuffer(tc);
  }

  drawQuad(buf = this.quad) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* ---------- passes: a material pass (or effect pass) ready to draw ---------- */

  /**
   * @param matPass   pass from a material json
   * @param inst      matching pass from scene.json (effect instance) with overrides, or {}
   * @param read      file reader (effect folders first)
   * @param binds     {index: render target name or 'previous'}
   */
  async pass(matPass, inst = {}, read = this.reader(), binds = {}) {
    const combos = {};
    for (const src of [matPass.combos, inst.combos]) for (const [k, v] of Object.entries(src || {})) combos[k.toUpperCase()] = v;
    const sh = await loadShader(matPass.shader, read, combos);
    const textures = [];
    const names = [];
    for (let i = 0; i < 8; i++) {
      const bound = binds[i];
      const name = bound ?? inst.textures?.[i] ?? matPass.textures?.[i] ?? sh.meta.textures[i]?.default ?? null;
      names[i] = name;
      if (bound || !name) textures[i] = null;
      else if (name.startsWith('_')) textures[i] = null;   // render targets (_rt_) and engine aliases (_alias_)
      else textures[i] = await this.texture(name);
      // samplers marked with a combo switch it on once they have a texture
      const comboName = sh.meta.textures[i]?.combo;
      if (comboName && (bound || textures[i])) combos[comboName] = 1;
    }
    if (textures[0]?.format === TEX.RG88 || textures[0]?.format === TEX.R8) combos.TEX0FORMAT = textures[0].format;
    if (textures[0]?.frames?.length) combos.SPRITESHEET = 1;

    const key = matPass.shader + JSON.stringify(Object.entries({ ...sh.combos, ...combos }).sort());
    if (!this.programs.has(key)) {
      try {
        const { vs, fs } = sh.build(combos);
        this.programs.set(key, this.compile(vs, fs, matPass.shader));
      } catch (e) {
        warn(e.message.slice(0, 400));
        this.programs.set(key, null);
      }
    }
    const program = this.programs.get(key);
    if (!program) return null;

    // material values: shader defaults, then the material, then the scene's instance, then user bindings
    const values = {};
    for (const [name, info] of Object.entries(sh.meta.uniforms)) {
      if (!info.material) continue;
      let v = info.default;
      for (const src of [matPass.constantshadervalues, inst.constantshadervalues]) if (src && info.material in src) v = src[info.material];
      values[name] = { raw: v, key: info.material };
    }
    // usershadervalues is {user property: material key}; turn it round to look up by material key
    const userKeys = {};
    for (const src of [matPass.usershadervalues, inst.usershadervalues])
      for (const [prop, key] of Object.entries(src || {})) userKeys[key] = prop;
    return { program, names, textures, binds, values, userKeys, blending: matPass.blending || 'normal',
      depthtest: matPass.depthtest, depthwrite: matPass.depthwrite, cullmode: matPass.cullmode };
  }

  /* ---------- building the scene ---------- */

  async build(scene) {
    const g = scene.general || {};
    const proj = g.orthogonalprojection;
    // without an orthographic projection the scene is 3D: a perspective camera, maybe moving along paths
    this.is3D = !proj;
    if (this.is3D) {
      this.width = this.canvas.width;
      this.height = this.canvas.height;
      this.cam = scene.camera || {};
      this.paths = [];
      for (const f of this.cam.paths || []) for (const path of (await this.json(f))?.paths || []) if (path.transforms?.length) this.paths.push(path);
    } else {
      this.width = proj.auto ? this.canvas.width : proj.width;
      this.height = proj.auto ? this.canvas.height : proj.height;
    }
    this.lights = (scene.objects || []).filter(o => o.light).slice(0, 4).map(o => ({
      pos: nums(this.value(o.origin) ?? '0 0 0'), color: nums(this.value(o.color) ?? '1 1 1'),
      intensity: nums(this.value(o.intensity) ?? 1)[0], radius: nums(this.value(o.radius) ?? 1000)[0],
    }));
    this.general = g;
    this.clear = nums(this.value(g.clearcolor) ?? '0 0 0');
    this.layers = [];
    this.skipped = {};
    for (const o of scene.objects || []) {
      // objects may list several kinds with the unused ones empty
      const kind = ['image', 'particle', 'model', 'text', 'sound', 'light'].find(k => o[k]) || 'other';
      if (kind === 'light') continue;   // read above
      const supported = kind === 'image' || kind === 'particle' || kind === 'model';
      if (!supported) { this.skipped[kind] = (this.skipped[kind] || 0) + 1; continue; }
      try {
        const layer = kind === 'particle' ? await this.particleLayer(o) : kind === 'model' ? await this.modelLayer(o) : await this.layer(o);
        if (layer) this.layers.push(layer);
      } catch (e) {
        warn('layer', o.name, e.message);
      }
    }
    // WE's bloom: bright parts at quarter size, blurred at an eighth, added back (assets/materials/util)
    if (this.assets) {
      const util = async (name, binds) => {
        const mat = await this.json(`materials/util/${name}.json`);
        return mat?.passes?.[0] ? this.pass(mat.passes[0], {}, this.reader(), binds) : null;
      };
      const passes = [
        await util('downsample_quarter_bloom', { 0: '_rt_FullFrameBuffer' }),
        await util('downsample_eighth_blur_v', { 0: '_rt_4FrameBuffer' }),
        await util('blur_h_bloom', { 0: '_rt_8FrameBuffer' }),
        await util('combine', { 0: '_rt_FullFrameBuffer', 1: '_rt_8FrameBufferB' }),
      ];
      if (passes.every(Boolean)) this.bloomPasses = passes;
    }
    this.resize();
    const used = [...this.programs.values()].filter(Boolean).flatMap(p => [...p.uniforms.keys()]);
    this.usesAudio = used.some(n => n.startsWith('g_AudioSpectrum'));
    this.usesPointer = !!this.value(g.cameraparallax) || used.includes('g_PointerPosition') ||
      this.layers.some(l => l.system?.cps.some(c => c.mouse));
  }

  async layer(o) {
    const model = await this.json(o.image);
    if (!model) throw new Error('model not found ' + o.image);
    const material = model.material && await this.json(model.material);
    if (!material?.passes?.length) throw new Error('material not found ' + model.material);
    const base = [];
    for (const p of material.passes) base.push(await this.pass(p, {}));
    if (!base[0]) return null;
    let width = model.width, height = model.height;
    const tex0 = base[0].textures[0];
    if (model.fullscreen) { width = this.width; height = this.height; }
    else if ((model.autosize || !width) && tex0) {
      const f = tex0.frames?.[0];
      width = f ? f.w : tex0.width;
      height = f ? f.h : tex0.height;
    }
    const layer = { o, model, base, width, height, effects: [], fullscreen: !!model.fullscreen };
    layer.quad = this.buffer([
      -width / 2, -height / 2, 0, 0, 1,
      width / 2, -height / 2, 0, 1, 1,
      -width / 2, height / 2, 0, 0, 0,
      width / 2, height / 2, 0, 1, 0,
    ]);

    for (const e of o.effects || []) {
      try {
        const def = await this.json(e.file);
        if (!def) throw new Error('missing ' + e.file);
        const dir = e.file.replace(/[^/]*$/, '');
        const read = this.reader(dir);
        const effect = { inst: e, fbos: {}, passes: [] };
        for (const f of def.fbos || []) effect.fbos[f.name] = this.target(width / (f.scale || 1), height / (f.scale || 1));
        for (let i = 0; i < (def.passes || []).length; i++) {
          const dp = def.passes[i];
          if (dp.command) { effect.passes.push({ command: dp.command, source: dp.source, target: dp.target }); continue; }
          const mat = parseJson(await read(dp.material) ?? 'null');
          if (!mat) throw new Error('missing ' + dp.material);
          // slot 0 of an effect pass is the picture so far unless the effect binds something else there
          const binds = { 0: 'previous' };
          for (const b of dp.bind || []) binds[b.index] = b.name;
          const p = await this.pass(mat.passes[0], e.passes?.[i] || {}, read, binds);
          if (p) effect.passes.push({ ...p, target: dp.target });
        }
        layer.effects.push(effect);
      } catch (err) {
        warn('effect', e.file, err.message);
      }
    }
    if (layer.effects.length || layer.fullscreen) {
      layer.a = this.target(width, height);
      layer.b = this.target(width, height);
    }
    return layer;
  }

  async modelLayer(o) {
    const bytes = await this.bytes(o.model);
    if (!bytes) throw new Error('model not found ' + o.model);
    const gl = this.gl, meshes = [];
    for (const mesh of readMdl(bytes).meshes) {
      const material = await this.json(mesh.material).catch(e => { warn('model material', mesh.material, e.message); return null; });
      const passes = [];
      for (const mp of material?.passes || []) { const p = await this.pass(mp, {}); if (p) passes.push(p); }
      if (!passes.length) { warn('model material', mesh.material); continue; }
      const vbo = gl.createBuffer(), ibo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      meshes.push({ layout: mesh.layout, passes, vbo, ibo, count: mesh.indices.length });
    }
    return meshes.length ? { o, meshes } : null;
  }

  drawModel(layer, model, mvp) {
    const gl = this.gl, L = this.lights;
    const light = i => L[i] || { pos: [0, 0, 0], color: [0, 0, 0], intensity: 0, radius: 1 };
    const lightUniforms = {
      g_LightsPosition: [0, 1, 2, 3].flatMap(i => light(i).pos.slice(0, 3)),
      g_LightsColorRadius: [0, 1, 2, 3].flatMap(i => [...light(i).color.slice(0, 3).map(c => c * light(i).intensity), light(i).radius]),
      // three lights' colour, with the fourth light's colour spread over their w components
      g_LightsColorPremultiplied: [0, 1, 2].flatMap(i => [...light(i).color.slice(0, 3).map(c => c * light(i).intensity), (light(3).color[i] ?? 0) * light(3).intensity]),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneRt.fbo);
    gl.viewport(0, 0, this.sceneRt.width, this.sceneRt.height);
    for (const mesh of layer.meshes) {
      const { layout } = mesh;
      for (const p of mesh.passes) {
        gl.useProgram(p.program.prog);
        const tex = this.bindTextures(p, () => null);
        this.setUniforms(p, {
          ...tex, ...lightUniforms,
          g_ModelViewProjectionMatrix: mvp, g_ModelMatrix: model, g_ModelMatrixInverse: invert(model),
          g_NormalModelMatrix: normalMatrix(model), g_ViewProjectionMatrix: this.vp, g_EyePosition: this.eye,
        }, this.sceneRt);
        if (p.depthtest === 'disabled') gl.disable(gl.DEPTH_TEST); else { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); }
        gl.depthMask(p.depthwrite !== 'disabled');
        if (p.cullmode === 'normal') { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); } else gl.disable(gl.CULL_FACE);
        this.blend(p.blending);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
        const at = (loc, size, off) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, layout.stride, off); };
        at(0, 3, layout.position);
        at(1, 2, layout.uv);
        at(3, layout.uv2 !== undefined ? 4 : 2, layout.uv);   // a_TexCoordVec4: both uv sets for lightmapped shaders
        if (layout.normal !== undefined) at(6, 3, layout.normal); else { gl.disableVertexAttribArray(6); gl.vertexAttrib3f(6, 0, 0, 1); }
        if (layout.tangent !== undefined) at(7, 4, layout.tangent); else { gl.disableVertexAttribArray(7); gl.vertexAttrib4f(7, 1, 0, 0, 1); }
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      }
    }
    for (const loc of [3, 6, 7]) gl.disableVertexAttribArray(loc);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
  }

  /** Camera for 3D scenes: the scene's camera, or a point along its camera paths (they play in turn, looping). */
  camera() {
    const c = this.cam;
    let eye = nums(c.eye ?? '0 0 1'), center = nums(c.center ?? '0 0 0'), up = nums(c.up ?? '0 1 0');
    const total = this.paths.reduce((s, p) => s + (p.duration || 1), 0);
    if (total > 0) {
      let t = this.time % total, path = this.paths[0];
      for (const p of this.paths) { if (t <= (p.duration || 1)) { path = p; break; } t -= p.duration || 1; }
      const keys = path.transforms;
      let a = keys[0], b = keys[keys.length - 1];
      for (let i = 0; i < keys.length - 1; i++) if (t >= (keys[i].timestamp ?? 0) && t <= (keys[i + 1].timestamp ?? 0)) { a = keys[i]; b = keys[i + 1]; break; }
      const span = (b.timestamp ?? 0) - (a.timestamp ?? 0);
      const u = span > 0 ? Math.min(1, Math.max(0, (t - (a.timestamp ?? 0)) / span)) : 0;
      const k = u * u * (3 - 2 * u);   // ease in and out
      const mix = (x, y) => nums(x).map((v, i) => v + ((nums(y)[i] ?? v) - v) * k);
      eye = mix(a.eye, b.eye); center = mix(a.center, b.center); up = mix(a.up, b.up);
    }
    return { eye, center, up };
  }

  async particleLayer(o) {
    const def = await this.json(o.particle);
    if (!def) throw new Error('particle file not found ' + o.particle);
    const material = def.material && await this.json(def.material);
    const pass = material?.passes?.[0] || {};
    const texName = pass.textures?.[0];
    const texture = texName ? await this.texture(texName) : null;
    this.particleProgram ??= this.compile(PARTICLE_VS, PARTICLE_FS, 'particles');
    const system = new ParticleSystem(def, texture, pass.blending || 'translucent', o.instanceoverride, v => this.value(v));
    // the material's own particle shader, in its no-geometry-shader form
    const own = pass.shader ? await this.pass(pass, { combos: { THICKFORMAT: 1, TRAILRENDERER: system.trail ? 1 : 0 } }).catch(e => { warn('particle shader', e.message); return null; }) : null;
    return { o, system, own, vbo: this.gl.createBuffer() };
  }

  drawParticles(layer, model, mvp, dt) {
    const gl = this.gl, sys = layer.system;
    // the pointer in the system's own space
    const local = mul(invert(model), new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, this.pointerScene[0], this.pointerScene[1], 0, 1]));
    sys.pointer = [local[12], local[13], 0];
    sys.update(dt);
    const verts = sys.vertices();
    if (!verts.length) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneRt.fbo);
    gl.viewport(0, 0, this.sceneRt.width, this.sceneRt.height);
    const own = layer.own;
    if (own) {
      gl.useProgram(own.program.prog);
      const tex = this.bindTextures(own, () => null);
      const r = sys.renderer, f = sys.frames, t = sys.texture;
      const fw = f && t ? f[0].w / t.texWidth : 1, fh = f && t ? f[0].h / t.texHeight : 1;
      this.setUniforms(own, {
        ...tex,
        g_ModelViewProjectionMatrix: mvp, g_ModelMatrix: model, g_ModelMatrixInverse: invert(model), g_ViewProjectionMatrix: this.vp,
        g_OrientationRight: this.camRight, g_OrientationUp: this.camUp, g_OrientationForward: this.camForward,
        g_ViewRight: this.camRight, g_ViewUp: this.camUp, g_EyePosition: this.eye,
        g_RenderVar0: [nums(r.length)[0] ?? 0.05, nums(r.maxlength)[0] ?? 1000, nums(r.minlength)[0] ?? 0, 0],
        g_RenderVar1: [fw, fh, f?.length || 1, f ? f[0].h / f[0].w : 1],
      }, this.sceneRt);
    } else {
      const p = this.particleProgram;
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.uniforms.get('u_Mvp').loc, false, mvp);
      gl.uniform1i(p.uniforms.get('u_HasTex').loc, sys.texture ? 1 : 0);
      gl.uniform1i(p.uniforms.get('u_Format').loc, sys.texture?.format ?? 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, (sys.texture || this.white).tex);
      gl.uniform1i(p.uniforms.get('u_Tex').loc, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.disableVertexAttribArray(1);
    const locations = { a_Position: 0, a_Color: 2, a_TexCoordVec4: 3, a_TexCoordC2: 4, a_TexCoordVec4C1: 5 };
    for (const [name, size, off] of ATTRIBUTES) {
      gl.enableVertexAttribArray(locations[name]);
      gl.vertexAttribPointer(locations[name], size, gl.FLOAT, false, VERTEX * 4, off * 4);
    }
    this.blend(sys.blending);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / VERTEX);
    for (const loc of [2, 3, 4, 5]) gl.disableVertexAttribArray(loc);
  }

  resize() {
    const c = this.canvas, gl = this.gl;
    if (this.is3D) { this.width = c.width; this.height = c.height; }
    // the scene renders at the screen's pixel density, cropped to cover the screen like WE does
    const s = Math.max(c.width / this.width, c.height / this.height, 0.25);
    if (this.sceneRt && this.scale === s && this.sceneRt.width === Math.round(this.width * s) && this.sceneRt.height === Math.round(this.height * s)) return;
    this.scale = s;
    if (this.sceneRt) {
      gl.deleteTexture(this.sceneRt.tex); gl.deleteFramebuffer(this.sceneRt.fbo); gl.deleteRenderbuffer(this.sceneRt.rb);
      gl.deleteTexture(this.fullRt.tex); gl.deleteFramebuffer(this.fullRt.fbo);
    }
    this.sceneRt = this.target(this.width * s, this.height * s, true);
    this.fullRt = this.target(this.width * s, this.height * s);
    for (const rt of [this.rt4, this.rt8, this.rt8b]) if (rt) { gl.deleteTexture(rt.tex); gl.deleteFramebuffer(rt.fbo); }
    this.rt4 = this.target(this.sceneRt.width / 4, this.sceneRt.height / 4);
    this.rt8 = this.target(this.sceneRt.width / 8, this.sceneRt.height / 8);
    this.rt8b = this.target(this.sceneRt.width / 8, this.sceneRt.height / 8);
  }

  /* ---------- drawing ---------- */

  setUniforms(p, extra, target) {
    const gl = this.gl, u = p.program.uniforms;
    const put = (name, v) => {
      const info = u.get(name);
      if (!info || v == null) return;
      const a = v instanceof Float32Array ? v : nums(v);
      const n = { [gl.FLOAT]: 1, [gl.FLOAT_VEC2]: 2, [gl.FLOAT_VEC3]: 3, [gl.FLOAT_VEC4]: 4 }[info.type];
      if (n) {
        const arr = new Float32Array(n * info.size);
        for (let i = 0; i < arr.length; i++) arr[i] = a[i] ?? (n === 4 && i % 4 === 3 ? 1 : a.length === 1 ? a[0] : 0);
        gl[`uniform${n}fv`](info.loc, arr);
      } else if (info.type === gl.FLOAT_MAT4) gl.uniformMatrix4fv(info.loc, false, a);
      else if (info.type === gl.FLOAT_MAT3) gl.uniformMatrix3fv(info.loc, false, a.length === 16 ? [a[0], a[1], a[2], a[4], a[5], a[6], a[8], a[9], a[10]] : a);
      else if (info.type === gl.INT || info.type === gl.BOOL) gl.uniform1i(info.loc, a[0] | 0);
    };
    for (const [k, v] of Object.entries(this.globals)) put(k, v);
    for (const [k, v] of Object.entries(extra)) put(k, v);
    if (!('g_TexelSize' in extra)) put('g_TexelSize', [1 / target.width, 1 / target.height]);
    if (!('g_TexelSizeHalf' in extra)) put('g_TexelSizeHalf', [0.5 / target.width, 0.5 / target.height]);
    for (const [name, { raw, key }] of Object.entries(p.values)) {
      const bound = p.userKeys[key];
      put(name, this.value(bound !== undefined ? { user: bound, value: raw } : raw));
    }
  }

  bindTextures(p, rts) {
    const gl = this.gl;
    const extra = {};
    for (let i = 0; i < 8; i++) {
      const info = p.program.uniforms.get('g_Texture' + i);
      if (!info) continue;
      const name = p.binds[i] ?? p.names[i];
      let t = p.textures[i];
      if (!t && name) t = rts(name);
      t ||= this.white;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      if (t.video && t.video.readyState >= 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, t.video);
      gl.uniform1i(info.loc, i);
      const w = t.width, h = t.height, tw = t.texWidth ?? w, th = t.texHeight ?? h;
      extra[`g_Texture${i}Resolution`] = [tw, th, w, h];
      extra[`g_Texture${i}MipMapInfo`] = [1];
      if (t.frames?.length) {
        const total = t.frames.reduce((s, f) => s + f.time, 0) || 1;
        let at = (this.time % total), f = t.frames[0];
        for (const fr of t.frames) { if (at < fr.time) { f = fr; break; } at -= fr.time; }
        extra[`g_Texture${i}Rotation`] = [f.w / tw, f.wy / th, f.hx / tw, f.h / th];
        extra[`g_Texture${i}Translation`] = [f.x / tw, f.y / th];
      } else {
        extra[`g_Texture${i}Rotation`] = [1, 0, 0, 1];
        extra[`g_Texture${i}Translation`] = [0, 0];
      }
    }
    return extra;
  }

  blend(mode) {
    const gl = this.gl;
    if (mode === 'translucent') { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    else if (mode === 'additive') { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); }
    else if (mode === 'premultiplied') { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    else gl.disable(gl.BLEND);
  }

  /** Copy of the scene so far, top row first like the layer buffers (for fullscreen layers and _rt_FullFrameBuffer). */
  grabScene() {
    const gl = this.gl, s = this.sceneRt, d = this.fullRt;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, d.fbo);
    gl.blitFramebuffer(0, 0, s.width, s.height, 0, d.height, d.width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    return d;
  }

  render() {
    const gl = this.gl, now = performance.now();
    this.time = (now - this.start) / 1000;
    const g = this.general;
    if (this.canvas.width !== this.lastW || this.canvas.height !== this.lastH) { this.lastW = this.canvas.width; this.lastH = this.canvas.height; this.resize(); }
    const W = this.width, H = this.height;
    this.vp2d = ortho(W, H);
    if (this.is3D) {
      const { eye, center, up } = this.camera();
      const g3 = this.general;
      this.vp = mul(perspective(nums(this.value(g3.fov) ?? 50)[0] || 50, W / H, nums(g3.nearz ?? 0.01)[0], nums(g3.farz ?? 10000)[0]), lookAt(eye, center, up));
      this.eye = eye;
      this.camForward = norm3(sub3(center, eye));
      this.camRight = norm3(cross3(this.camForward, up));
      this.camUp = cross3(this.camRight, this.camForward);
    } else {
      this.vp = this.vp2d;
      this.eye = [W / 2, H / 2, 10000];
      this.camForward = [0, 0, -1]; this.camRight = [1, 0, 0]; this.camUp = [0, 1, 0];
    }
    const dt = Math.min(0.1, Math.max(0, this.time - (this.lastTime ?? this.time)));
    this.lastTime = this.time;
    const d = new Date();
    const left = new Float32Array(64), right = new Float32Array(64);
    left.set(this.audio.subarray(0, 64)); right.set(this.audio.subarray(64, 128));
    const bands = n => { const l = new Float32Array(n), r = new Float32Array(n), per = 64 / n;
      for (let i = 0; i < n; i++) for (let k = 0; k < per; k++) { l[i] = Math.max(l[i], left[i * per + k]); r[i] = Math.max(r[i], right[i * per + k]); }
      return [l, r]; };
    const [l16, r16] = bands(16), [l32, r32] = bands(32);
    this.globals = {
      g_Time: [this.time],
      g_Daytime: [(d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400],
      g_PointerPosition: this.pointer,
      g_PointerPositionLast: this.pointer,
      g_Screen: [this.canvas.width, this.canvas.height, this.canvas.width / this.canvas.height],
      g_EyePosition: this.eye,
      // for the stand-in of WE's generated lighting code (shaders.js LIGHTING_V1)
      pape_LightsPosition: [0, 1, 2, 3].flatMap(i => (this.lights[i]?.pos ?? [0, 0, 0]).slice(0, 3)),
      pape_LightsColorRadius: [0, 1, 2, 3].flatMap(i => { const l = this.lights[i]; return l ? [...l.color.slice(0, 3).map(c => c * l.intensity), l.radius] : [0, 0, 0, 1]; }),
      g_LightAmbientColor: nums(this.value(g.ambientcolor) ?? '0.3 0.3 0.3'),
      g_LightSkylightColor: nums(this.value(g.skylightcolor) ?? '0.3 0.3 0.3'),
      g_AudioSpectrum16Left: l16, g_AudioSpectrum16Right: r16,
      g_AudioSpectrum32Left: l32, g_AudioSpectrum32Right: r32,
      g_AudioSpectrum64Left: left, g_AudioSpectrum64Right: right,
    };

    // mouse parallax eases toward the pointer
    const parallaxOn = this.value(g.cameraparallax);
    const amount = Number(this.value(g.cameraparallaxamount) ?? 0.5);
    const delay = Math.max(0.01, Number(this.value(g.cameraparallaxdelay) ?? 0.1));
    const k = Math.min(1, (1 / 60) / delay);
    for (let i = 0; i < 2; i++) this.parallax[i] += ((parallaxOn ? this.pointer[i] - 0.5 : 0) - this.parallax[i]) * k;

    const scene = this.sceneRt;
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
    gl.viewport(0, 0, scene.width, scene.height);
    gl.depthMask(true);
    gl.clearColor(this.clear[0] ?? 0, this.clear[1] ?? 0, this.clear[2] ?? 0, 1);
    gl.clear(this.value(g.clearenabled) !== false ? gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT : gl.DEPTH_BUFFER_BIT);

    // where the pointer is in scene units (the screen shows a centred crop of the scene)
    {
      const cw = this.canvas.width, ch = this.canvas.height, sr = this.sceneRt;
      const s = Math.max(cw / sr.width, ch / sr.height), sw = cw / s, sh = ch / s;
      this.pointerScene = [((sr.width - sw) / 2 + this.pointer[0] * sw) / this.scale, ((sr.height - sh) / 2 + (1 - this.pointer[1]) * sh) / this.scale];
    }

    // In 3D, each run of see-through (translucent or additive) models draws far to near, so their clear parts
    // don't hide what's behind them. Everything else keeps the scene's order: opaque models (the depth buffer
    // sorts those), backgrounds first, full-screen effects last.
    let order = this.layers;
    if (this.is3D) {
      const dist = l => { const p = nums(this.value(l.o.origin) ?? '0 0 0'); return -Math.hypot(p[0] - this.eye[0], (p[1] ?? 0) - this.eye[1], (p[2] ?? 0) - this.eye[2]); };
      const sortable = l => l.meshes?.every(m => m.passes.every(p => p.depthtest !== 'disabled' && (p.blending === 'translucent' || p.blending === 'additive')));
      order = [];
      for (let i = 0; i < this.layers.length;) {
        let j = i;
        while (j < this.layers.length && sortable(this.layers[j])) j++;
        if (j > i) { order.push(...this.layers.slice(i, j).sort((a, b) => dist(a) - dist(b))); i = j; }
        else order.push(this.layers[i++]);
      }
    }
    for (const layer of order) {
      const o = layer.o;
      if (this.value(o.visible) === false) continue;
      try { this.drawLayer(layer, W, H, amount, dt); } catch (e) { warn('draw', o.name, e.message); layer.o = { ...o, visible: false }; }
    }

    const shown = this.bloom(scene);

    // cover the screen: crop the scene's longer side, centred
    const cw = this.canvas.width, ch = this.canvas.height;
    const s = Math.max(cw / scene.width, ch / scene.height);
    const sw = cw / s, sh = ch / s, sx = (scene.width - sw) / 2, sy = (scene.height - sh) / 2;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, shown.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(sx, sy, sx + sw, sy + sh, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  /** Adds the glow when the scene has bloom on; returns the buffer to show. */
  bloom(scene) {
    const g = this.general, passes = this.bloomPasses;
    if (!passes || !this.value(g.bloom)) return scene;
    const hdr = !!this.value(g.hdr);
    const strength = nums(this.value(hdr ? g.bloomhdrstrength ?? g.bloomstrength : g.bloomstrength) ?? 2)[0];
    const threshold = nums(this.value(hdr ? g.bloomhdrthreshold ?? g.bloomthreshold : g.bloomthreshold) ?? 0.65)[0];
    const tint = this.value(g.bloomtint) ?? '1 1 1';
    const bright = passes[0].values;
    if (bright.g_BloomStrength) bright.g_BloomStrength.raw = strength;
    if (bright.g_BloomThreshold) bright.g_BloomThreshold.raw = threshold;
    if (bright.g_BloomTint) bright.g_BloomTint.raw = tint;
    const rts = { _rt_FullFrameBuffer: scene, _rt_4FrameBuffer: this.rt4, _rt_8FrameBuffer: this.rt8, _rt_8FrameBufferB: this.rt8b };
    const texel = { g_TexelSize: [1 / scene.width, 1 / scene.height] };
    // the scene buffer is already in GL row order, so these full-frame passes need no flipping
    [this.rt4, this.rt8, this.rt8b, this.fullRt].forEach((target, i) =>
      this.drawWith(passes[i], target, identity(), this.quad, n => rts[n] ?? null, identity(), texel, 'normal'));
    return this.fullRt;
  }

  drawLayer(layer, W, H, amount, dt = 0) {
    const o = layer.o;
    const origin = nums(this.value(o.origin) ?? `${W / 2} ${H / 2} 0`);
    const scale = nums(this.value(o.scale) ?? '1 1 1');
    const angles = nums(this.value(o.angles) ?? '0 0 0');
    const depth = nums(this.value(o.parallaxDepth) ?? '0 0');
    const shift = this.is3D ? 0 : 1;   // mouse parallax moves 2D layers only
    const pos = [
      (origin[0] ?? 0) - shift * this.parallax[0] * (depth[0] ?? 0) * amount * W * 0.1,
      (origin[1] ?? 0) + shift * this.parallax[1] * (depth[1] ?? 0) * amount * H * 0.1,
      origin[2] ?? 0,
    ];
    const model = layer.fullscreen ? modelMatrix([W / 2, H / 2, 0], [1, 1, 1], [0, 0, 0])
      : modelMatrix(pos, [scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1], [angles[0] ?? 0, angles[1] ?? 0, angles[2] ?? 0]);
    const flat = !layer.system && !layer.meshes;
    const mvp = mul(flat ? this.vp2d : this.vp, model);
    if (layer.system) { this.drawParticles(layer, model, mvp, dt); return; }
    if (layer.meshes) { this.drawModel(layer, model, mvp); return; }

    // object-level colour, alpha and brightness feed the image shader's own controls
    const alpha = Number(this.value(o.alpha) ?? 1);
    const color = nums(this.value(o.color) ?? '1 1 1');
    const brightness = Number(this.value(o.brightness) ?? 1);
    const tint = p => {
      for (const v of Object.values(p.values)) {
        if (v.key === 'Alpha') v.raw = nums(v.raw0 ??= v.raw)[0] * alpha;
        if (v.key === 'Brightness') v.raw = nums(v.raw0 ??= v.raw)[0] * brightness;
      }
    };
    const color4 = { g_Color: color, g_Color4: [...color.slice(0, 3), alpha], g_Alpha: [alpha] };

    const rtsFor = extra => name => {
      if (name === 'previous') return extra.previous;
      if (name === '_rt_FullFrameBuffer' || name === '_rt_MipMappedFrameBuffer') return this.grabScene();
      return extra.fbos?.[name] ?? null;
    };

    if (!layer.a) {
      for (const p of layer.base) {
        if (!p) continue;
        tint(p);
        this.drawWith(p, this.sceneRt, mvp, layer.quad, rtsFor({}), model, color4);
      }
      return;
    }

    // Compose: base material into buffer A, effects ping-pong, then onto the scene.
    const gl = this.gl;
    let prev = layer.a, other = layer.b;
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev.fbo);
    gl.viewport(0, 0, prev.width, prev.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const full = layer.fullscreen ? this.grabScene() : null;
    for (const p of layer.base) {
      if (!p) continue;
      tint(p);
      this.drawWith(p, prev, identity(), this.quad, n => full && n.startsWith('_rt_') ? full : rtsFor({})(n), identity(), color4, 'normal');
    }
    for (const effect of layer.effects) {
      if (this.value(effect.inst.visible) === false) continue;
      for (const p of effect.passes) {
        const rts = rtsFor({ previous: prev, fbos: effect.fbos });
        if (p.command === 'copy') {
          const src = rts(p.source), dst = rts(p.target);
          if (src && dst) this.blit(src, dst);
          continue;
        }
        const target = p.target ? effect.fbos[p.target] : other;
        if (!target) continue;
        if (target.fbo) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
          gl.viewport(0, 0, target.width, target.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        this.drawWith(p, target, identity(), this.quad, rts, identity(), {}, p.blending);
        if (!p.target) [prev, other] = [target, prev];
      }
    }
    const blending = layer.fullscreen ? 'normal' : layer.base[0]?.blending ?? 'translucent';
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneRt.fbo);
    gl.viewport(0, 0, this.sceneRt.width, this.sceneRt.height);
    gl.useProgram(this.blitProgram.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, prev.tex);
    gl.uniform1i(this.blitProgram.uniforms.get('u_Tex').loc, 0);
    gl.uniformMatrix4fv(this.blitProgram.uniforms.get('u_Mvp').loc, false, mvp);
    this.blend(blending === 'normal' && !layer.fullscreen ? 'translucent' : blending);
    this.drawQuad(layer.quad);
  }

  drawWith(p, target, mvp, quad, rts, model, extra, blending) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(p.program.prog);
    const tex = this.bindTextures(p, rts);
    this.setUniforms(p, { ...tex, ...extra, g_ModelViewProjectionMatrix: mvp, g_ModelMatrix: model, g_ViewProjectionMatrix: this.vp }, target);
    this.blend(blending ?? p.blending);
    this.drawQuad(quad);
  }
}
