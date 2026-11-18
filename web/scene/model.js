// Wallpaper Engine .mdl models (MDLV0004, 0014, 0023), as far as static meshes go.
// Header: "MDLVnnnn\0", int32 vertex flags, int32 material names per mesh, int32 mesh count. Per mesh:
// material name(s) (zero-terminated), int32 (unused), [v23+: 6 float bounding box, int32 flags], int32 vertex
// bytes, vertices, int32 index bytes, uint16 indices (triangles). Zero padding may sit between meshes.
// Vertex: position (3 floats), [flag 2: normal (3)], [flag 4: tangent (4)], uv (2), [flag 32: second uv (2)].
// Skeletons and animations that may follow the meshes aren't read.

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
  return { version, meshes };
}

/** Byte offsets of each part of a vertex, and the stride. */
export function vertexLayout(flags) {
  let o = 12;
  const layout = { position: 0 };
  if (flags & 2) { layout.normal = o; o += 12; }
  if (flags & 4) { layout.tangent = o; o += 16; }
  layout.uv = o; o += 8;
  if (flags & 32) { layout.uv2 = o; o += 8; }
  layout.stride = o;
  return layout;
}
