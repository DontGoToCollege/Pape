// Turns a Wallpaper Engine shader (GLSL with HLSL-style helpers, #include, and JSON metadata in
// comments) into WebGL2 GLSL ES 3.00 source plus the metadata a material needs.
//
// read(path) resolves "shaders/<name>" against the wallpaper first and Wallpaper Engine's assets second,
// returning the text or null.

const PRELUDE = `precision highp float;
precision highp int;
precision highp sampler2D;
#define GLSL 1
#define texSample2D texture
#define texSample2DLod textureLod
#define mul(x, y) ((y) * (x))
#define frac fract
#define saturate(x) clamp((x), 0.0, 1.0)
#define lerp mix
#define atan2 atan
#define fmod mod
#define ddx dFdx
#define ddy dFdy
#define rsqrt inversesqrt
#define float2 vec2
#define float3 vec3
#define float4 vec4
#define CAST2(x) (vec2(x))
#define CAST3(x) (vec3(x))
#define CAST4(x) (vec4(x))
#define CAST3X3(x) (mat3(x))
#define CASTF(x) (float(x))
#define CASTU(x) (uint(x))
#define MAKE_SAMPLER2D_ARGUMENT(x) x
#define clip(x) if ((x) < 0.0) discard
#define log10(x) (log2(x) * 0.30102999566)
#define BONECOUNT 1
#define BLENDROWCOUNT 1
float pape_pow(float a, float b) { return pow(a, b); }
vec2 pape_pow(vec2 a, vec2 b) { return pow(a, b); }
vec2 pape_pow(vec2 a, float b) { return pow(a, vec2(b)); }
vec3 pape_pow(vec3 a, vec3 b) { return pow(a, b); }
vec3 pape_pow(vec3 a, float b) { return pow(a, vec3(b)); }
vec4 pape_pow(vec4 a, vec4 b) { return pow(a, b); }
vec4 pape_pow(vec4 a, float b) { return pow(a, vec4(b)); }
#define pow pape_pow
${['max', 'min'].map(f => `${['float', 'vec2', 'vec3', 'vec4'].map(t => `${t} pape_${f}(${t} a, ${t} b) { return ${f}(a, b); }`).join('\n')}
${['vec2', 'vec3', 'vec4'].map(t => `${t} pape_${f}(${t} a, float b) { return ${f}(a, b); }\n${t} pape_${f}(float a, ${t} b) { return ${f}(${t}(a), b); }`).join('\n')}
int pape_${f}(int a, int b) { return ${f}(a, b); }
uint pape_${f}(uint a, uint b) { return ${f}(a, b); }
#define ${f} pape_${f}`).join('\n')}
`;
const PRELUDE_NAMES = [...PRELUDE.matchAll(/#define (\w+)/g)].map(m => m[1]);

// "#require LightingV1" pulls in lighting code WE generates from the scene's lights. Pape's stand-in adds up to
// four point lights (positions and colour+radius set by scene.js) with WE's own PBR light function.
const LIGHTING_V1 = `
uniform vec3 pape_LightsPosition[4];
uniform vec4 pape_LightsColorRadius[4];
vec3 PerformLighting_V1(vec3 worldPos, vec3 albedo, vec3 normal, vec3 viewVector, vec3 specularTint, vec3 f0, float roughness, float metallic) {
  vec3 light = vec3(0.0);
  for (int i = 0; i < 4; i++)
    light += ComputePBRLightShadow(normal, pape_LightsPosition[i] - worldPos, viewVector, albedo, pape_LightsColorRadius[i].rgb,
      max(pape_LightsColorRadius[i].w, 0.001), 2.0, specularTint, f0, roughness, metallic, 1.0);
  return light;
}
`;

const VERT_HEAD = '#define attribute in\n#define varying out\n';
const FRAG_HEAD = '#define varying in\nout vec4 pape_FragColor;\n#define gl_FragColor pape_FragColor\n';

// HLSL (and WE's compiler) promote integer literals to floats; GLSL ES never does. Lines that work
// with integers (declarations, loops, indexing) are left alone.
// (declarations only: an int(...) cast still gets its literals fixed)
const INT_LINE = /\b(int|uint|ivec[234]|uvec[234])\s+\w|\b(for|switch|case)\b|%|<<|>>/;
const INT_LITERAL = /(?<![\w.]|[eE][+-])(\d+)(?![\w.])/g;
// Words GLSL ES 3.00 reserves that WE shaders use as plain names.
const RESERVED = /\b(sample|input|output|filter|common|partition|active|packed|buffer|superp|resource|shared|noise)\b/g;

function floatLiterals(code, intMacros = [], arithmetic = []) {
  // the shader's own combos are integers too; where they sit in arithmetic ("x / count * RESOLUTION") they
  // become float(), while as function arguments or in comparisons they stay integers
  if (arithmetic.length) {
    const names = arithmetic.join('|');
    const re = new RegExp(`(?<=[*/+\\-]\\s*)\\b(${names})\\b(?![\\w(])|\\b(${names})\\b(?=\\s*[*/+\\-])`, 'g');
    code = code.split('\n').map(l => l.trimStart().startsWith('#') || INT_LINE.test(l) ? l : l.replace(re, (m, a, b) => `float(${a ?? b})`)).join('\n');
  }
  // integer variables used in float maths ("sampleCount - 1.0") get an explicit float() outside int lines;
  // so do whole-number macros from the shader's own file ("#define RESOLUTION 64"), but not WE's headers,
  // whose macros are blend-mode and format ids compared with ints
  const ints = [...new Set([...[...code.matchAll(/\bint\s+(\w+)\s*[=;]/g)].map(m => m[1]), ...intMacros])];
  const intUse = ints.length ? new RegExp(`(?<![\\w.])(${ints.join('|')})(?![\\w(])`, 'g') : null;
  return code.split('\n').map(line => {
    const t = line.trimStart();
    if (t.startsWith('#') || INT_LINE.test(line)) return line;
    if (intUse) line = line.replace(intUse, 'float($1)');
    // keep array sizes and indices integral
    return line.replace(INT_LITERAL, '$1.0').replace(/\[\s*(?:float\((\w+)\)|(\d+)\.0)\s*\]/g, (m, v, n) => `[${v ?? n}]`);
  }).join('\n');
}

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * GLSL ES rejects an unknown name in #if (HLSL reads it as 0). Names tested with #ifdef elsewhere become
 * defined(NAME) so they keep meaning "set"; every other unknown name is defined as 0.
 */
function fixConditionals(code, known) {
  const defined = new Set([...known, ...PRELUDE_NAMES]);
  for (const m of code.matchAll(/^\s*#\s*define\s+(\w+)/gm)) defined.add(m[1]);
  const ifdefs = new Set([...code.matchAll(/^\s*#\s*ifn?def\s+(\w+)/gm)].map(m => m[1]).filter(n => !defined.has(n)));
  const missing = new Set();
  code = code.replace(/^(\s*#\s*(?:if|elif)\b)(.*)$/gm, (all, kw, expr) => {
    const bare = expr.replace(/defined\s*\(?\s*\w+\s*\)?/g, '');
    for (const id of bare.matchAll(/\b[A-Za-z_]\w*\b/g))
      if (!defined.has(id[0]) && !ifdefs.has(id[0])) missing.add(id[0]);
    return kw + expr.replace(/(defined\s*\(?\s*)?\b([A-Za-z_]\w*)\b/g, (t, d, id) => !d && ifdefs.has(id) ? `defined(${id})` : t);
  });
  return { code, defines: [...missing].map(k => `#define ${k} 0\n`).join('') };
}

/** Uniforms declared at the top level move to the front: WE includes may use them before their declaration. */
function hoistUniforms(code) {
  const top = [], rest = [];
  let pre = 0, brace = 0;
  for (const line of code.split('\n')) {
    const t = line.trim();
    if (/^#\s*if/.test(t)) pre++;
    else if (/^#\s*endif/.test(t)) pre--;
    if (pre === 0 && brace === 0 && /^uniform\b.*;$/.test(t)) top.push(line); else rest.push(line);
    brace += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  return top.join('\n') + '\n' + rest.join('\n');
}

/** Metadata WE keeps in comments: combos with defaults, uniforms bound to material keys, texture defaults. */
function parseMeta(src, meta) {
  for (const m of src.matchAll(/\/\/\s*\[COMBO\]\s*(\{.*\})/g)) {
    try {
      const c = JSON.parse(m[1]);
      if (c.combo && !(c.combo in meta.combos)) meta.combos[c.combo] = c.default ?? 0;
    } catch { /* malformed: ignore */ }
  }
  for (const m of src.matchAll(/^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*;\s*\/\/\s*(\{.*\})/gm)) {
    let info;
    try { info = JSON.parse(m[3]); } catch { continue; }
    const [, type, name] = m;
    meta.uniforms[name] = { type, ...info };
    const tex = /^g_Texture(\d+)$/.exec(name);
    if (tex && type === 'sampler2D') meta.textures[+tex[1]] = info;
  }
}

export async function loadShader(name, read, combosFromMaterial = {}) {
  const meta = { combos: {}, uniforms: {}, textures: {} };
  const seen = new Set();
  async function expand(src) {
    const out = [];
    for (const line of src.split('\n')) {
      const inc = /^\s*#include\s+"([^"]+)"/.exec(line);
      if (!inc) { out.push(line); continue; }
      if (seen.has(inc[1])) continue;
      seen.add(inc[1]);
      const text = await read('shaders/' + inc[1]);
      if (text == null) throw new Error(`missing include ${inc[1]} in ${name}`);
      out.push(await expand(text));
    }
    return out.join('\n');
  }
  const vsRaw = await read(`shaders/${name}.vert`);
  const fsRaw = await read(`shaders/${name}.frag`);
  if (vsRaw == null || fsRaw == null) throw new Error('missing shader ' + name);
  const ownMacros = src => [...src.matchAll(/^\s*#\s*define\s+(\w+)\s+\d+\s*$/gm)].map(m => m[1]);
  const ownCombos = src => [...src.matchAll(/\/\/\s*\[COMBO\]\s*\{[^}]*"combo"\s*:\s*"(\w+)"/g)].map(m => m[1]);
  seen.clear();
  const vs = await expand(vsRaw);
  seen.clear();
  const fs = await expand(fsRaw);
  parseMeta(vs, meta);
  parseMeta(fs, meta);

  const combos = { ...meta.combos };
  for (const [k, v] of Object.entries(combosFromMaterial)) combos[k.toUpperCase()] = v;
  return { meta, combos, build: (extra = {}) => {
    const all = { ...combos, ...extra };
    const stage = (src, head) => {
      const lighting = head === FRAG_HEAD ? LIGHTING_V1 : '';
      const own = head === FRAG_HEAD ? fsRaw : vsRaw;
      const cleaned = floatLiterals(stripComments(src), ownMacros(own), ownCombos(own)).replace(RESERVED, 'pape_$1')
        .replace(/^\s*#\s*require\s+LightingV1\b.*$/gm, lighting).replace(/^\s*#\s*require\b.*$/gm, '');
      const { code, defines } = fixConditionals(hoistUniforms(cleaned), Object.keys(all));
      return '#version 300 es\n' + PRELUDE + head +
        Object.entries(all).map(([k, v]) => `#define ${k} ${Number(v) | 0}\n`).join('') + defines + code;
    };
    return { vs: stage(vs, VERT_HEAD), fs: stage(fs, FRAG_HEAD) };
  } };
}
