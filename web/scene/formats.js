// Wallpaper Engine file formats: scene.pkg (a flat file archive) and .tex (textures).
// Worked out from the files themselves; see docs/SCENE-FORMAT.md.

class Reader {
  constructor(buf) { this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); this.b = buf; this.p = 0; }
  i32() { const x = this.v.getInt32(this.p, true); this.p += 4; return x; }
  u32() { const x = this.v.getUint32(this.p, true); this.p += 4; return x; }
  f32() { const x = this.v.getFloat32(this.p, true); this.p += 4; return x; }
  bytes(n) { const x = this.b.subarray(this.p, this.p + n); this.p += n; return x; }
  /** zero-terminated magic such as "TEXV0005" */
  magic() { const s = this.p; while (this.b[this.p] !== 0) this.p++; return new TextDecoder().decode(this.b.subarray(s, this.p++)); }
  /** int32 length + text */
  str() { return new TextDecoder().decode(this.bytes(this.i32())); }
}

/** scene.pkg → Map of "path/inside/package" → bytes */
export function readPkg(buf) {
  const r = new Reader(buf);
  const version = r.str();
  if (!version.startsWith('PKGV')) throw new Error('not a scene package');
  const count = r.i32();
  const entries = [];
  for (let i = 0; i < count; i++) entries.push([r.str(), r.i32(), r.i32()]);
  const base = r.p;
  return new Map(entries.map(([name, off, len]) => [name.replace(/\\/g, '/'), buf.subarray(base + off, base + off + len)]));
}

/** Plain LZ4 block decompression. */
export function lz4(src, size) {
  const out = new Uint8Array(size);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    out.set(src.subarray(s, s + lit), d);
    s += lit; d += lit;
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8);
    s += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
    len += 4;
    for (let i = 0; i < len; i++, d++) out[d] = out[d - off];
  }
  return out;
}

export const TEX = { RGBA8888: 0, DXT5: 4, DXT3: 6, DXT1: 7, RG88: 8, R8: 9 };
export const TEX_FLAG = { NoInterpolation: 1, ClampUVs: 2, Sprite: 4 };

/**
 * .tex → { format, flags, width, height (image), texWidth, texHeight, mips: [{width, height, data}],
 *          encoded: bool (mip data is a PNG/JPEG/etc. file), video: bool, frames: [...] }
 */
export function readTex(buf) {
  const r = new Reader(buf);
  if (r.magic() !== 'TEXV0005' || r.magic() !== 'TEXI0001') throw new Error('not a texture');
  const t = { format: r.i32(), flags: r.i32(), texWidth: r.i32(), texHeight: r.i32(), width: r.i32(), height: r.i32() };
  r.u32();
  const container = r.magic();
  const images = r.i32();
  let imageFormat = -1;
  t.video = false;
  if (container === 'TEXB0003') imageFormat = r.i32();
  else if (container === 'TEXB0004') { imageFormat = r.i32(); t.video = r.i32() === 1; }
  else if (container !== 'TEXB0001' && container !== 'TEXB0002') throw new Error('unknown texture container ' + container);
  t.encoded = imageFormat !== -1;
  const v1 = container === 'TEXB0001';
  t.images = [];
  for (let i = 0; i < images; i++) {
    const mips = [];
    const count = r.i32();
    for (let m = 0; m < count; m++) {
      const width = r.i32(), height = r.i32();
      let lz = false, size = 0;
      if (!v1) { lz = r.i32() === 1; size = r.i32(); }
      const data = r.bytes(r.i32());
      mips.push({ width, height, data: lz ? lz4(data, size) : data });
    }
    t.images.push(mips);
  }
  t.mips = t.images[0] || [];
  // Animated (sprite sheet) textures list their frames after the images.
  t.frames = [];
  if (t.flags & TEX_FLAG.Sprite && r.p < buf.length) {
    const kind = r.magic();
    const n = r.i32();
    if (kind === 'TEXS0003') { r.i32(); r.i32(); }
    for (let i = 0; i < n; i++) {
      const image = r.i32(), time = r.f32();
      const [x, y, w, wy, hx, h] = kind === 'TEXS0001'
        ? [r.i32(), r.i32(), r.i32(), r.i32(), r.i32(), r.i32()]
        : [r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()];
      t.frames.push({ image, time, x, y, w, wy, hx, h });
    }
  }
  return t;
}
