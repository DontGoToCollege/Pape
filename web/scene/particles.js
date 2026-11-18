// Wallpaper Engine particle systems, simulated on the CPU and drawn as textured sprites.
// A particle file has emitters (where particles appear), initializers (their starting values),
// operators (what happens to them each frame) and a renderer; drawing uses the material's own shader.
// Children systems, ropes, boids and
// remapping aren't simulated yet: ropes draw as sprites, the rest is skipped.

const TAU = Math.PI * 2;
const nums = v => typeof v === 'number' ? [v] : typeof v === 'string' ? v.trim().split(/\s+/).map(Number) : Array.isArray(v) ? v.map(Number) : [];
const num = (v, d) => { const n = nums(v); return n.length ? n[0] : d; };
const vec3 = (v, d = [0, 0, 0]) => { const n = nums(v); return n.length === 0 ? d : n.length === 1 ? [n[0], n[0], n[0]] : [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0]; };
const rnd = (a, b) => a + Math.random() * (b - a);
const rndExp = (a, b, e = 1) => a + Math.pow(Math.random(), e || 1) * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.min(1, Math.max(0, t));

/* smooth 3D value noise in -1..1, enough for turbulence */
function hash(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}
function noise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const f = t => t * t * (3 - 2 * t);
  const u = f(x - xi), v = f(y - yi), w = f(z - zi);
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++)
    r += hash(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  return r;
}
const noise3 = (x, y, z) => [noise(x, y, z), noise(x + 31.4, y + 17.3, z + 5.9), noise(x + 57.2, y + 91.1, z + 13.7)];

function hsv2rgb(h, s, v) {
  const f = n => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}

export class ParticleSystem {
  /**
   * @param def        the particle json
   * @param texture    the material's texture 0 (from Scene.texture), or null for a soft white dot
   * @param blending   material blending
   * @param override   the object's instanceoverride (already resolved), or {}
   * @param value      Scene.value, for user-bound numbers
   */
  constructor(def, texture, blending, override, value) {
    this.def = def;
    this.texture = texture;
    this.blending = blending;
    const o = k => num(value(override?.[k]), 1);
    this.mul = { rate: o('rate'), count: o('count'), life: o('lifetime'), size: o('size'), speed: o('speed'), alpha: o('alpha') };
    const tint = override?.colorn ? vec3(value(override.colorn), [1, 1, 1]) : [1, 1, 1];
    const bright = num(value(override?.brightness), 1);
    this.tint = tint.map(c => c * bright);
    this.max = Math.max(1, Math.round(num(def.maxcount, 100) * this.mul.count));
    this.particles = [];
    this.time = 0;
    this.emitters = (def.emitter || []).map(e => ({ e, acc: 0, fired: false, on: true, until: 0 }));
    this.renderer = def.renderer?.[0] || { name: 'sprite' };
    this.trail = this.renderer.name === 'spritetrail' || this.renderer.name === 'ropetrail';
    this.frames = texture?.frames?.length ? texture.frames : null;
    this.cps = (def.controlpoint || []).map(cp => ({ id: cp.id, mouse: !!(cp.flags & 1) || !!cp.locktopointer, offset: vec3(cp.offset) }));
    this.pointer = [0, 0, 0];
    // run the system ahead so it doesn't start empty
    const warm = Math.min(num(def.starttime, 0), 30);
    for (let t = 0; t < warm; t += 1 / 30) this.update(1 / 30);
  }

  cp(id) {
    const c = this.cps.find(c => c.id === id);
    if (!c) return [0, 0, 0];
    return c.mouse ? this.pointer : c.offset;
  }

  spawn(em) {
    if (this.particles.length >= this.max) return;
    const e = em.e;
    const p = { pos: [0, 0, 0], vel: [0, 0, 0], age: 0, life: 1, size: 20, color: [1, 1, 1], alpha: 1, rot: [0, 0, 0], spin: [0, 0, 0], osc: {}, frame: 0 };
    const origin = vec3(e.origin);
    const dirs = vec3(e.directions, [1, 1, 0]);
    if (e.name === 'boxrandom') {
      const lo = vec3(e.distancemin), hi = vec3(e.distancemax, [100, 100, 0]);
      for (let i = 0; i < 3; i++) p.pos[i] = origin[i] + (Math.random() < 0.5 ? -1 : 1) * rnd(lo[i], hi[i]) * dirs[i];
    } else {
      // sphererandom: a random point in a sphere that "directions" stretches per axis
      let d;
      do d = [rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)]; while (Math.hypot(...d) > 1 || Math.hypot(...d) < 1e-6);
      const len = Math.hypot(...d);
      d = d.map(c => c / len);
      const sign = e.sign ? vec3(e.sign) : null;
      if (sign) d = d.map((c, i) => sign[i] ? Math.abs(c) * Math.sign(sign[i]) : c);
      const dist = rnd(num(e.distancemin, 0), num(e.distancemax, 0));
      const speed = rnd(num(e.speedmin, 0), num(e.speedmax, 0)) * this.mul.speed;
      for (let i = 0; i < 3; i++) { p.pos[i] = origin[i] + d[i] * dist * dirs[i]; p.vel[i] = d[i] * dirs[i] * speed; }
    }
    if (e.controlpoint !== undefined) { const c = this.cp(e.controlpoint); for (let i = 0; i < 3; i++) p.pos[i] += c[i]; }

    for (const init of this.def.initializer || []) {
      const mn = init.min, mx = init.max ?? init.min, ex = init.exponent;
      switch (init.name) {
        case 'lifetimerandom': p.life = rndExp(num(mn, 1), num(mx, num(mn, 1)), ex) * this.mul.life; break;
        case 'sizerandom': p.size = rndExp(num(mn, 20), num(mx, num(mn, 20)), ex) * this.mul.size; break;
        case 'alpharandom': p.alpha = rndExp(num(mn, 1), num(mx, num(mn, 1)), ex); break;
        case 'colorrandom': {
          const a = vec3(mn, [255, 255, 255]), b = vec3(mx, a), t = Math.pow(Math.random(), ex || 1);
          p.color = a.map((c, i) => lerp(c, b[i], t) / 255);
          break;
        }
        case 'hsvcolorrandom':
          p.color = hsv2rgb(rnd(num(init.huemin, 0), num(init.huemax, 1)) % 1, rnd(num(init.saturationmin, 1), num(init.saturationmax, 1)), rnd(num(init.valuemin, 1), num(init.valuemax, 1)));
          break;
        case 'velocityrandom': {
          const a = vec3(mn), b = vec3(mx, a);
          for (let i = 0; i < 3; i++) p.vel[i] += rnd(a[i], b[i]) * this.mul.speed;
          break;
        }
        case 'rotationrandom': { const a = vec3(mn), b = vec3(mx, [0, 0, TAU]); p.rot = a.map((c, i) => rnd(c, b[i])); break; }
        case 'angularvelocityrandom': { const a = vec3(mn), b = vec3(mx, a); p.spin = a.map((c, i) => rnd(c, b[i])); break; }
        case 'turbulentvelocityrandom': {
          const s = num(init.scale, 1), n = noise3(p.pos[0] * s * 0.01, p.pos[1] * s * 0.01, this.time * num(init.timescale, 1));
          const speed = rnd(num(init.speedmin, 100), num(init.speedmax, 250)) * this.mul.speed;
          const len = Math.hypot(...n) || 1;
          for (let i = 0; i < 2; i++) p.vel[i] += n[i] / len * speed;
          break;
        }
        case 'positionoffsetrandom': {
          const r = num(init.distance, 0);
          for (let i = 0; i < 2; i++) p.pos[i] += rnd(-r, r);
          break;
        }
      }
    }
    p.size0 = p.size;
    p.alpha0 = p.alpha;
    p.color0 = p.color.slice();
    if (this.frames) p.frame = this.def.animationmode === 'randomframe' ? Math.floor(Math.random() * this.frames.length) : 0;
    this.particles.push(p);
  }

  update(dt) {
    this.time += dt;
    // emitters
    for (const em of this.emitters) {
      const e = em.e;
      const delay = num(e.delay, 0);
      if (this.time < delay) continue;
      if (e.duration && this.time > delay + num(e.duration, 0)) continue;
      if (e.instantaneous) {
        if (!em.fired) { em.fired = true; for (let i = 0; i < num(e.instantaneous, 0); i++) this.spawn(em); }
        if (!num(e.rate, 0)) continue;
      }
      // optional on/off periods
      if (num(e.maxperiodicduration, 0) > 0 && this.time >= em.until) {
        em.on = !em.on;
        em.until = this.time + (em.on ? rnd(num(e.minperiodicduration, 0), num(e.maxperiodicduration, 1)) : rnd(num(e.minperiodicdelay, 0), num(e.maxperiodicdelay, 1)));
      }
      if (!em.on) continue;
      em.acc += num(e.rate, 5) * this.mul.rate * dt;
      while (em.acc >= 1) { em.acc--; this.spawn(em); }
    }

    // operators
    const ops = this.def.operator || [];
    const alive = [];
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.life) continue;
      const t = p.age / p.life;
      p.size = p.size0;
      p.alpha = p.alpha0;
      p.color = p.color0.slice();
      for (let k = 0; k < ops.length; k++) {
        const op = ops[k];
        switch (op.name) {
          case 'movement': {
            const g = vec3(op.gravity), drag = num(op.drag, 0);
            for (let i = 0; i < 3; i++) { p.vel[i] = (p.vel[i] + g[i] * dt) * Math.max(0, 1 - drag * dt); p.pos[i] += p.vel[i] * dt; }
            break;
          }
          case 'angularmovement': {
            const f = vec3(op.force), drag = num(op.drag, 0);
            for (let i = 0; i < 3; i++) { p.spin[i] = (p.spin[i] + f[i] * dt) * Math.max(0, 1 - drag * dt); p.rot[i] += p.spin[i] * dt; }
            break;
          }
          case 'alphafade': {
            const fin = num(op.fadeintime, 0.5), fout = num(op.fadeouttime, 0.5);
            if (fin > 0 && t < fin) p.alpha *= t / fin;
            if (fout > 0 && t > 1 - fout) p.alpha *= (1 - t) / fout;
            break;
          }
          case 'sizechange': case 'alphachange': {
            const s = num(op.starttime, 0), e = num(op.endtime, 1);
            const m = lerp(num(op.startvalue, 1), num(op.endvalue, 0), clamp01((t - s) / ((e - s) || 1)));
            if (op.name === 'sizechange') p.size *= m; else p.alpha *= m;
            break;
          }
          case 'colorchange': {
            const s = num(op.starttime, 0), e = num(op.endtime, 1), u = clamp01((t - s) / ((e - s) || 1));
            const a = vec3(op.startvalue, [1, 1, 1]), b = vec3(op.endvalue, [1, 1, 1]);
            for (let i = 0; i < 3; i++) p.color[i] *= lerp(a[i], b[i], u);
            break;
          }
          case 'oscillateposition': case 'oscillatealpha': case 'oscillatesize': {
            const o = p.osc[k] ??= {
              f: rnd(num(op.frequencymin, 0), num(op.frequencymax, num(op.frequencymin, 1))),
              s: rnd(num(op.scalemin, 0), num(op.scalemax, num(op.scalemin, 1))),
              ph: rnd(num(op.phasemin, 0), num(op.phasemax, 1)) * TAU,
              last: 0,
            };
            const wave = Math.sin(p.age * o.f * TAU + o.ph);
            if (op.name === 'oscillateposition') {
              const mask = vec3(op.mask, [1, 1, 0]), off = wave * o.s;
              for (let i = 0; i < 3; i++) p.pos[i] += (off - o.last) * mask[i];
              o.last = off;
            } else {
              // "oscillate between two values": scalemin..scalemax
              const m = lerp(num(op.scalemin, 0), num(op.scalemax, 1), 0.5 + 0.5 * wave);
              if (op.name === 'oscillatealpha') p.alpha *= m; else p.size *= m;
            }
            break;
          }
          case 'turbulence': {
            const s = num(op.scale, 0.01), ts = num(op.timescale, 1), mask = vec3(op.mask, [1, 1, 0]);
            const o = p.osc[k] ??= { speed: rnd(num(op.speedmin, 500), num(op.speedmax, 1000)) };
            const n = noise3(p.pos[0] * s, p.pos[1] * s, this.time * ts * 0.01);
            for (let i = 0; i < 3; i++) p.vel[i] += n[i] * o.speed * dt * mask[i];
            break;
          }
          case 'controlpointattract': {
            const c = this.cp(num(op.controlpoint, 0)), org = vec3(op.origin);
            const d = [0, 1, 2].map(i => c[i] + org[i] - p.pos[i]);
            const dist = Math.hypot(d[0], d[1]);
            if (dist > 0.001 && dist < num(op.threshold, 1e9)) for (let i = 0; i < 2; i++) p.vel[i] += d[i] / dist * num(op.scale, 100) * dt;
            break;
          }
          case 'vortex': case 'vortex_v2': {
            const c = this.cp(num(op.controlpoint, 0));
            const dx = p.pos[0] - c[0], dy = p.pos[1] - c[1], dist = Math.hypot(dx, dy) || 1;
            const inner = num(op.distanceinner, 0), outer = num(op.distanceouter, 500);
            const speed = lerp(num(op.speedinner, 0), num(op.speedouter, num(op.speedinner, 0)), clamp01((dist - inner) / ((outer - inner) || 1)));
            p.vel[0] += -dy / dist * speed * dt;
            p.vel[1] += dx / dist * speed * dt;
            break;
          }
          case 'capvelocity': {
            const cap = num(op.maxspeed, 100), sp = Math.hypot(...p.vel);
            if (sp > cap) for (let i = 0; i < 3; i++) p.vel[i] *= cap / sp;
            break;
          }
          case 'reducemovementnearcontrolpoint': {
            const c = this.cp(num(op.controlpoint, 0)), dist = Math.hypot(p.pos[0] - c[0], p.pos[1] - c[1]);
            const inner = num(op.distanceinner, 0), outer = num(op.distanceouter, 100);
            const keep = lerp(1 - num(op.reductioninner, 1), 1, clamp01((dist - inner) / ((outer - inner) || 1)));
            for (let i = 0; i < 3; i++) p.vel[i] *= lerp(1, keep, Math.min(1, dt * 10));
            break;
          }
        }
      }
      if (this.frames && this.def.animationmode === 'sequence')
        p.frame = Math.floor(t * this.frames.length * num(this.def.sequencemultiplier, 1)) % this.frames.length;
      alive.push(p);
    }
    this.particles = alive;
  }

  /**
   * Vertex data in Wallpaper Engine's particle layout (its shaders place the corners themselves):
   * a_Position xyz (centre), a_TexCoordVec4 (corner u, v, rotation z, size), a_TexCoordC2 (rotation x, y),
   * a_Color rgba, a_TexCoordVec4C1 (velocity xyz, life 0..1 for sprite-sheet frames). Six vertices per particle.
   */
  vertices() {
    const out = new Float32Array(this.particles.length * 6 * VERTEX);
    const n = this.frames?.length || 1;
    const random = this.def.animationmode === 'randomframe', mult = num(this.def.sequencemultiplier, 1);
    let o = 0;
    for (const p of this.particles) {
      const t = p.age / p.life;
      const life = !this.frames ? t : random ? (p.frame + 0.5) / n : (t * mult) % 1;
      const r = p.color[0] * this.tint[0], g = p.color[1] * this.tint[1], b = p.color[2] * this.tint[2];
      const a = Math.max(0, Math.min(1, p.alpha * this.mul.alpha));
      for (const [u, v] of [[0, 1], [1, 1], [1, 0], [0, 1], [1, 0], [0, 0]]) {
        out.set([p.pos[0], p.pos[1], p.pos[2], u, v, p.rot[2], p.size, p.rot[0], p.rot[1], r, g, b, a, p.vel[0], p.vel[1], p.vel[2], life], o);
        o += VERTEX;
      }
    }
    return out;
  }
}

/** floats per vertex, and where each attribute sits: [name, size, offset in floats] */
export const VERTEX = 17;
export const ATTRIBUTES = [['a_Position', 3, 0], ['a_TexCoordVec4', 4, 3], ['a_TexCoordC2', 2, 7], ['a_Color', 4, 9], ['a_TexCoordVec4C1', 4, 13]];

// Fallback when a particle material's own shader won't compile: plain rotated sprites.
export const PARTICLE_VS = `#version 300 es
in vec3 a_Position; in vec4 a_TexCoordVec4; in vec4 a_Color;
uniform mat4 u_Mvp;
out vec2 v_Uv; out vec4 v_Color;
void main() {
  float c = cos(a_TexCoordVec4.z), s = sin(a_TexCoordVec4.z);
  vec2 corner = vec2(a_TexCoordVec4.x - 0.5, 0.5 - a_TexCoordVec4.y) * a_TexCoordVec4.w;
  v_Uv = a_TexCoordVec4.xy; v_Color = a_Color;
  gl_Position = u_Mvp * vec4(a_Position + vec3(c * corner.x - s * corner.y, s * corner.x + c * corner.y, 0.0), 1.0);
}`;

// Texture formats as in WE's shaders: R8 is an alpha-only white sprite, RG88 is grey + alpha.
export const PARTICLE_FS = `#version 300 es
precision highp float;
in vec2 v_Uv; in vec4 v_Color;
uniform sampler2D u_Tex; uniform int u_Format; uniform bool u_HasTex;
out vec4 o;
void main() {
  vec4 t = vec4(1.0);
  if (u_HasTex) {
    t = texture(u_Tex, v_Uv);
    if (u_Format == 9) t = vec4(1.0, 1.0, 1.0, t.r);
    else if (u_Format == 8) t = vec4(t.rrr, t.g);
  } else {
    t.a = 1.0 - smoothstep(0.0, 0.5, length(v_Uv - 0.5));
  }
  o = t * v_Color;
}`;
