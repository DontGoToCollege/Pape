// Renders Wallpaper Engine 2D scenes (orthographic camera): image layers with their materials and
// effect chains, user-property bindings, sprite sheets, video textures, mouse parallax and audio.
// Not yet: particles, 3D models, puppet warp, text, sound, bloom, SceneScript (layers are skipped).
//
// Conventions: the scene buffer is GL-native (y up, scene units 0..W, 0..H). Every per-layer buffer
// keeps WE's top-row-first layout, so texture v = 0 is the top of a picture everywhere.

import { loadShader } from './shaders.js';
import { readPkg, readTex, TEX, TEX_FLAG } from './formats.js';

const warn = (...a) => console.warn('[scene]', ...a);

/* ---------------- values ---------------- */

function parseJson(text) {
  text = text.replace(/^﻿/, '');
  try { return JSON.parse(text); } catch { return JSON.parse(text.replace(/,\s*([}\]])/g, '$1')); }
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
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(prog)}`);
    const uniforms = new Map();
    for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const u = gl.getActiveUniform(prog, i);
      uniforms.set(u.name.replace(/\[0\]$/, ''), { loc: gl.getUniformLocation(prog, u.name), type: u.type, size: u.size });
    }
    return { prog, uniforms };
  }

  target(width, height) {
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
    return { tex, fbo, width, height, format: TEX.RGBA8888 };
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
      else if (name.startsWith('_rt_')) textures[i] = null;
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
    return { program, names, textures, binds, values, userKeys, blending: matPass.blending || 'normal' };
  }

  /* ---------- building the scene ---------- */

  async build(scene) {
    const g = scene.general || {};
    const proj = g.orthogonalprojection;
    if (!proj) throw new Error('3D scenes are not supported yet');
    this.width = proj.auto ? this.canvas.width : proj.width;
    this.height = proj.auto ? this.canvas.height : proj.height;
    this.general = g;
    this.clear = nums(this.value(g.clearcolor) ?? '0 0 0');
    this.layers = [];
    this.skipped = {};
    for (const o of scene.objects || []) {
      const kind = ['image', 'particle', 'model', 'text', 'sound', 'light'].find(k => k in o) || 'other';
      if (kind !== 'image' || !o.image) { this.skipped[kind] = (this.skipped[kind] || 0) + 1; continue; }
      try {
        const layer = await this.layer(o);
        if (layer) this.layers.push(layer);
      } catch (e) {
        warn('layer', o.name, e.message);
      }
    }
    this.resize();
    const used = [...this.programs.values()].filter(Boolean).flatMap(p => [...p.uniforms.keys()]);
    this.usesAudio = used.some(n => n.startsWith('g_AudioSpectrum'));
    this.usesPointer = !!this.value(g.cameraparallax) || used.includes('g_PointerPosition');
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

  resize() {
    const c = this.canvas, gl = this.gl;
    // the scene renders at the screen's pixel density, cropped to cover the screen like WE does
    const s = Math.max(c.width / this.width, c.height / this.height, 0.25);
    if (this.sceneRt && this.scale === s) return;
    this.scale = s;
    if (this.sceneRt) { gl.deleteTexture(this.sceneRt.tex); gl.deleteFramebuffer(this.sceneRt.fbo); gl.deleteTexture(this.fullRt.tex); gl.deleteFramebuffer(this.fullRt.fbo); }
    this.sceneRt = this.target(this.width * s, this.height * s);
    this.fullRt = this.target(this.width * s, this.height * s);
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
      else if (info.type === gl.FLOAT_MAT3) gl.uniformMatrix3fv(info.loc, false, a);
      else if (info.type === gl.INT || info.type === gl.BOOL) gl.uniform1i(info.loc, a[0] | 0);
    };
    for (const [k, v] of Object.entries(this.globals)) put(k, v);
    for (const [k, v] of Object.entries(extra)) put(k, v);
    put('g_TexelSize', [1 / target.width, 1 / target.height]);
    put('g_TexelSizeHalf', [0.5 / target.width, 0.5 / target.height]);
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
    this.vp = ortho(W, H);
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
      g_EyePosition: [0, 0, 0],
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
    if (this.value(g.clearenabled) !== false) {
      gl.clearColor(this.clear[0] ?? 0, this.clear[1] ?? 0, this.clear[2] ?? 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    for (const layer of this.layers) {
      const o = layer.o;
      if (this.value(o.visible) === false) continue;
      try { this.drawLayer(layer, W, H, amount); } catch (e) { warn('draw', o.name, e.message); layer.o = { ...o, visible: false }; }
    }

    // cover the screen: crop the scene's longer side, centred
    const cw = this.canvas.width, ch = this.canvas.height;
    const s = Math.max(cw / scene.width, ch / scene.height);
    const sw = cw / s, sh = ch / s, sx = (scene.width - sw) / 2, sy = (scene.height - sh) / 2;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, scene.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(sx, sy, sx + sw, sy + sh, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  drawLayer(layer, W, H, amount) {
    const o = layer.o;
    const origin = nums(this.value(o.origin) ?? `${W / 2} ${H / 2} 0`);
    const scale = nums(this.value(o.scale) ?? '1 1 1');
    const angles = nums(this.value(o.angles) ?? '0 0 0');
    const depth = nums(this.value(o.parallaxDepth) ?? '0 0');
    const pos = [
      (origin[0] ?? 0) - this.parallax[0] * (depth[0] ?? 0) * amount * W * 0.1,
      (origin[1] ?? 0) + this.parallax[1] * (depth[1] ?? 0) * amount * H * 0.1,
      origin[2] ?? 0,
    ];
    const model = layer.fullscreen ? modelMatrix([W / 2, H / 2, 0], [1, 1, 1], [0, 0, 0])
      : modelMatrix(pos, [scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1], [angles[0] ?? 0, angles[1] ?? 0, angles[2] ?? 0]);
    const mvp = mul(this.vp, model);

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
