// Wallpaper Engine .mdl models (MDLV0004, 0014, 0023): meshes, and for puppet-warp models the skeleton
// (MDLS) and animations (MDLA) that follow them.
// Header: "MDLVnnnn\0", int32 vertex flags, int32 material names per mesh, int32 mesh count. Per mesh:
// material name(s) (zero-terminated), int32 (unused), [v23+: 6 float bounding box, int32 flags], int32 vertex
// bytes, vertices, int32 index bytes, uint16 indices (triangles). Zero padding may sit between meshes.
// Vertex: position (3 floats), [flag 2: normal (3)], [flag 4: tangent (4)], [flag 0x800000: 4 uint32 bone
// indices], [flag 0x1000000: 4 float bone weights], uv (2), [flag 32: second uv (2)].

export function readMdl(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (!magic.startsWith('MDLV')) throw new Error('not a model');
  const version = Number(magic.slice(4));
  let p = 9;
  const i32 = () => { const x = v.getInt32(p, true); p += 4; return x; };
  const str = () => { const s = p; while (bytes[p] !== 0) p++; return new TextDecoder().decode(bytes.subarray(s, p++)); };
  let flags = i32();
  const names = i32(), count = i32();
  const meshes = [];
  for (let m = 0; m < count; m++) {
    while (m > 0 && bytes[p] === 0 && p < bytes.length) p++;
    const materials = [];
    for (let k = 0; k < Math.max(1, names); k++) materials.push(str());
    i32();
    if (version >= 23) { p += 24; flags = i32(); }
    const layout = vertexLayout(flags);
    const vb = i32();
    const vertices = new Float32Array(bytes.slice(p, p + vb).buffer);
    p += vb;
    const ib = i32();
    const indices = new Uint16Array(bytes.slice(p, p + ib).buffer);
    p += ib;
    meshes.push({ material: materials[0], flags, layout, vertices, indices });
  }
  const at = tag => { for (let i = p; i < bytes.length - 4; i++) if (bytes[i] === 77 && bytes[i + 1] === 68 && bytes[i + 2] === 76 && bytes[i + 3] === tag) return i; return -1; };
  const s = at(83 /* S */), a = at(65 /* A */);
  return { version, meshes, bones: s >= 0 ? readBones(bytes, v, s) : [], animations: a >= 0 ? readAnimations(bytes, v, a) : [] };
}

/** Byte offsets of each part of a vertex, and the stride. */
export function vertexLayout(flags) {
  let o = 12;
  const layout = { position: 0 };
  if (flags & 2) { layout.normal = o; o += 12; }
  if (flags & 4) { layout.tangent = o; o += 16; }
  if (flags & 0x800000) { layout.boneIndices = o; o += 16; }
  if (flags & 0x1000000) { layout.boneWeights = o; o += 16; }
  layout.uv = o; o += 8;
  if (flags & 32) { layout.uv2 = o; o += 8; }
  layout.stride = o;
  return layout;
}

/**
 * MDLS: "MDLSnnnn\0", int32 end offset, int32 bone count; per bone: name, int32 (1), int32 parent (-1 = root),
 * int32 matrix bytes, the bone's rest transform relative to its parent (column-major 4x4), editor JSON.
 */
function readBones(bytes, v, at) {
  let p = at + 9;
  const i32 = () => { const x = v.getInt32(p, true); p += 4; return x; };
  const str = () => { const s = p; while (bytes[p] !== 0) p++; return new TextDecoder().decode(bytes.subarray(s, p++)); };
  i32();
  const bones = [];
  for (let n = i32(), i = 0; i < n; i++) {
    const name = str();
    i32();
    const parent = i32(), size = i32();
    const local = new Float32Array(16);
    for (let k = 0; k < Math.min(16, size / 4); k++) local[k] = v.getFloat32(p + k * 4, true);
    p += size;
    str();
    bones.push({ name, parent, local });
  }
  return bones;
}

/**
 * MDLA: "MDLAnnnn\0", int32 end offset, int32 animation count; per animation: int32 id, int32, name, mode
 * ("loop", "mirror", "single"), float fps, int32 frame count, int32, int32 bone count; per bone, in bone order:
 * int32 (0), int32 byte count, then per frame 9 floats: position xyz, rotation xyz (radians), scale xyz.
 */
function readAnimations(bytes, v, at) {
  let p = at + 9;
  const i32 = () => { const x = v.getInt32(p, true); p += 4; return x; };
  const str = () => { const s = p; while (bytes[p] !== 0) p++; return new TextDecoder().decode(bytes.subarray(s, p++)); };
  i32();
  const animations = [];
  for (let n = i32(), i = 0; i < n && p < bytes.length; i++) {
    const id = i32();
    i32();
    const name = str(), mode = str();
    const fps = v.getFloat32(p, true); p += 4;
    const frames = i32();
    i32();
    const tracks = [];
    // tracks come in bone order; the int32 before each one is 0 in every file seen
    for (let b = i32(), k = 0; k < b; k++) {
      i32();
      const size = i32();
      tracks.push(new Float32Array(bytes.slice(p, p + size).buffer));
      p += size;
    }
    animations.push({ id, name, mode, fps, frames, tracks });
  }
  return animations;
}
