// The ground: a lit, shadow-receiving plane whose surface is made by a shader, one kind at a
// time: grid, terrain, water, sand, snow, lava, tiles. It is a standard material patched in
// place, so lights, shadows and fog work as everywhere else, and it animates itself.
import * as THREE from "three"
import { getLook } from "./looks.js"

const KINDS = ["grid", "terrain", "water", "sand", "snow", "lava", "tiles"]

// ---- terrain height: the same function builds the mesh and answers heightAt ----
const rolling = (x, z) =>
  0.55 * Math.sin(0.045 * x + 0.9 * Math.sin(0.03 * z)) * Math.cos(0.04 * z + 0.6 * Math.sin(0.02 * x)) +
  0.28 * Math.sin(0.11 * x + 1.7) * Math.sin(0.095 * z + 0.4) + 0.12 * Math.sin(0.23 * x + 0.19 * z + 2.1)
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t) }
const terrainHeight = (x, z, h) => h * 0.5 * (rolling(x, z) + 1) * smooth(5, 34, Math.hypot(x, z))

const COMMON = `
varying vec3 vW; varying vec3 vNW;
uniform float uTime; uniform vec3 uGround, uAccent, uAccent2, uLight, uShadow, uFog, uSunDir;
uniform float uHeight, uTiles, uTileSize;
vec3 gEmis = vec3(0.0); float gRough = 0.9; vec3 gWn = vec3(0.0, 1.0, 0.0);
float hash(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * noise(p); p = p * 2.05 + 5.3; a *= 0.5; } return s; }
vec2 bump(vec2 p){ float e = 0.12; float c = fbm(p);
  return vec2(fbm(p + vec2(e, 0.0)) - c, fbm(p + vec2(0.0, e)) - c) / e; }
float gridLine(vec2 p, float s){ vec2 q = p / s; vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-4)); return 1.0 - min(min(g.x, g.y), 1.0); }
`

// Water: summed travelling waves, value and slope in one function (used by vertex and fragment).
const WAVES = `
vec3 waves(vec2 p, float t, float detail){
  vec3 r = vec3(0.0);
  vec4 w[4] = vec4[4](vec4(0.07, 0.03, 0.9, 0.35), vec4(-0.05, 0.09, 1.1, 0.22), vec4(0.13, -0.08, 1.7, 0.12), vec4(-0.19, -0.14, 2.3, 0.07));
  for (int i = 0; i < 4; i++){
    float ph = dot(p, w[i].xy * 6.2832) * 1.0 + t * w[i].z;
    float c = cos(ph);
    r.x += w[i].w * sin(ph); r.yz += w[i].w * c * w[i].xy * 6.2832;
  }
  if (detail > 0.01){
    for (int i = 0; i < 3; i++){
      vec2 k = vec2(0.9 + float(i) * 0.7, -0.6 + float(i) * 1.1) * 1.7;
      float ph = dot(p, k) * 2.6 + t * (2.0 + float(i));
      r.yz += 0.018 * detail * cos(ph) * k * 2.6;
    }
  }
  return r;
}
`

const VERTEX_WATER = `transformed.y += waves(transformed.xz, uTime, 0.0).x;`

// Per kind, in the fragment: COLOR sets diffuseColor and gRough, NORMAL sets gWn (the world
// normal), EMIT adds light the surface gives off (this is what blooms).
const CODE = {
  grid: {
    color: `
      float r = length(vW.xz);
      float minor = gridLine(vW.xz, 2.0), major = gridLine(vW.xz, 10.0);
      float ring = pow(0.5 + 0.5 * sin(r * 0.3 - uTime * 2.2), 5.0);
      float centre = exp(-r * 0.018);
      diffuseColor.rgb = mix(uGround, uGround * 1.6 + uAccent2 * 0.03, noise(vW.xz * 0.15)) ;
      gRough = 0.62;
      float aa = 1.0 - smoothstep(0.12, 0.4, fwidth(vW.x) / 2.0 + fwidth(vW.z) / 2.0);
      gEmis = (uAccent2 * minor * (0.45 + 1.6 * ring) * (0.4 + centre) * aa + uAccent * major * (1.3 + 1.6 * ring))
            + uAccent2 * 0.06 * exp(-r * 0.035);`,
  },
  terrain: {
    color: `
      float hn = clamp(vW.y / max(uHeight, 0.01), 0.0, 1.0);
      float n = fbm(vW.xz * 0.28), sp = noise(vW.xz * 2.6);
      vec3 col = mix(uGround * 0.6, uGround * 1.05 + uAccent * 0.05, n);
      col = mix(col, col * 0.7 + uAccent * 0.12, smoothstep(0.55, 0.75, fbm(vW.xz * 0.05 + 11.0)));
      col *= 0.85 + 0.3 * sp;
      col = mix(col, uShadow * 1.4 + 0.07, smoothstep(0.82, 0.55, vNW.y));   // steep: rock
      col = mix(col, mix(uGround, uLight, 0.55), smoothstep(0.6, 1.0, hn) * 0.65); // peaks catch the light
      diffuseColor.rgb = col; gRough = 0.92;`,
    normal: `vec2 b = bump(vW.xz * 1.8); gWn = normalize(vNW + vec3(-b.x, 0.0, -b.y) * 0.18);`,
  },
  water: {
    color: `
      diffuseColor.rgb = mix(uGround * 0.35, uAccent2 * 0.12, 0.35) + uShadow * 0.15; gRough = 0.1;`,
    normal: `float near = 1.0 - smoothstep(12.0, 45.0, distance(cameraPosition, vW));
      vec3 w = waves(vW.xz, uTime, near); gWn = normalize(vec3(-w.y, 1.0, -w.z));`,
    emit: `
      vec3 V = normalize(cameraPosition - vW);
      float near = 1.0 - smoothstep(12.0, 45.0, distance(cameraPosition, vW));
      float fres = pow(1.0 - clamp(dot(gWn, V), 0.0, 1.0), 3.5);
      vec3 R = reflect(-V, gWn);
      float sun = pow(max(dot(R, normalize(uSunDir)), 0.0), 90.0);
      vec2 cell = floor(vW.xz * 9.0);
      float h = hash(cell), tw = 0.5 + 0.5 * sin(uTime * (2.0 + h * 5.0) + h * 40.0);
      float glint = step(0.93, h) * tw * (0.3 + 0.7 * fres) * (0.2 + 0.8 * near);
      gEmis = mix(uFog, uAccent2, 0.25) * fres * 0.9 + uLight * (sun * 5.0 + glint * 0.8)
            + uAccent2 * 0.05;`,
  },
  sand: {
    color: `
      vec2 p = vW.xz;
      float dunes = fbm(p * 0.05 + 3.0), rip = sin(dot(p, vec2(0.8, 0.6)) * 2.4 + dunes * 14.0 + noise(p * 0.5) * 3.0);
      vec3 base = mix(vec3(0.6, 0.42, 0.22), uFog, 0.18) * 0.8;
      diffuseColor.rgb = mix(base * 0.78, base * 1.12, 0.5 + 0.5 * rip * 0.6 + (dunes - 0.5)) * (0.9 + 0.2 * hash(floor(p * 40.0)));
      gRough = 0.95;`,
    normal: `vec2 q = vW.xz; float ph = dot(q, vec2(0.8, 0.6)) * 2.4 + fbm(q * 0.05 + 3.0) * 14.0;
      vec2 b = bump(q * 0.6); gWn = normalize(vec3(0.0, 1.0, 0.0) + vec3(cos(ph) * 0.8, 0.0, cos(ph) * 0.6) * 0.06 + vec3(-b.x, 0.0, -b.y) * 0.08);`,
  },
  snow: {
    color: `
      vec3 base = mix(vec3(0.7, 0.78, 0.9), uFog, 0.12);
      diffuseColor.rgb = base * (0.9 + 0.12 * fbm(vW.xz * 0.2)); gRough = 0.8;`,
    normal: `vec2 b = bump(vW.xz * 0.5); gWn = normalize(vec3(-b.x, 1.0, -b.y) * vec3(0.25, 1.0, 0.25) + vec3(0.0, 0.0, 0.0));`,
    emit: `
      vec3 V = normalize(cameraPosition - vW);
      float sp = step(0.987, hash(floor(vW.xz * 22.0))) * (0.5 + 0.5 * sin(uTime * 2.0 + hash(floor(vW.xz * 22.0)) * 40.0));
      gEmis = (uLight + uAccent * 0.4) * sp * 2.2 * (0.4 + 0.6 * pow(1.0 - clamp(dot(gWn, V), 0.0, 1.0), 1.0));`,
  },
  lava: {
    color: `
      vec2 p = vW.xz * 0.11;
      vec2 wp = p + vec2(fbm(p * 1.3 + uTime * 0.03), fbm(p * 1.3 - uTime * 0.025)) * 1.6;
      float cr = fbm(wp * 2.0 + vec2(0.0, uTime * 0.05));
      float vein = 1.0 - smoothstep(0.0, 0.085, abs(cr - 0.5));          // glowing cracks
      float pool = smoothstep(0.7, 0.78, fbm(wp * 0.7 + 9.0));         // open pools
      float heat = clamp(vein * 0.85 + pool, 0.0, 1.0);
      vec3 crust = (uShadow * 0.6 + 0.02) * (0.6 + 0.8 * fbm(vW.xz * 0.8));
      diffuseColor.rgb = crust; gRough = 0.9;
      vec3 hot = mix(vec3(1.0, 0.28, 0.04), uAccent, 0.35), core = mix(vec3(1.0, 0.8, 0.25), uAccent2, 0.3);
      gEmis = mix(hot, core, pow(heat, 4.0) * 0.6) * heat * (1.5 + 0.5 * sin(uTime * 1.3 + cr * 12.0)) + hot * 0.07 * smoothstep(0.0, 0.5, fbm(wp * 3.0));`,
  },
  tiles: {
    color: `
      vec2 q = vW.xz / uTileSize + uTiles * 0.5;
      vec2 id = floor(q), f = fract(q);
      bool inside = all(greaterThanEqual(id, vec2(0.0))) && all(lessThan(id, vec2(uTiles)));
      float chk = mod(id.x + id.y, 2.0);
      float edge = max(abs(f.x - 0.5), abs(f.y - 0.5)) * 2.0;
      float bevel = smoothstep(0.86, 0.98, edge);
      if (inside){
        diffuseColor.rgb = mix(uGround * 0.8, uGround * 1.45 + uAccent2 * 0.03, chk) * (1.0 - 0.55 * bevel);
        gEmis = uAccent2 * (smoothstep(0.93, 0.99, edge) * 0.5 + 0.0) + uAccent * 0.02 * chk;
        gRough = 0.6;
      } else {
        float r = length(vW.xz);
        diffuseColor.rgb = uGround * 0.5; gRough = 0.8;
        float rim = exp(-max(max(abs(q.x - uTiles * 0.5), abs(q.y - uTiles * 0.5)) - uTiles * 0.5, 0.0) * 1.6);
        gEmis = uAccent2 * 0.16 * rim;
      }`,
  },
}

export const createGround = (options = {}) => {
  const o = options && typeof options === "object" ? options : {}
  const look = getLook(o.look, "createGround")
  let kind = o.kind == null ? "grid" : o.kind
  if (!KINDS.includes(kind)) {
    console.warn(`createGround: unknown kind "${kind}" (use ${KINDS.join(", ")}); using "grid".`)
    kind = "grid"
  }
  const size = Number.isFinite(o.size) && o.size > 4 ? o.size : 200
  const height = Number.isFinite(o.height) ? o.height : 6
  const tiles = Math.max(1, Math.round(Number.isFinite(o.tiles) ? o.tiles : 12))
  const tileSize = Number.isFinite(o.tileSize) && o.tileSize > 0 ? o.tileSize : 2

  const segs = kind === "terrain" ? 180 : kind === "water" ? 200 : 2
  const geo = new THREE.PlaneGeometry(size, size, segs, segs)
  geo.rotateX(-Math.PI / 2)
  if (kind === "terrain") {
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i), height))
    geo.computeVertexNormals()
  }

  const c = (hex) => ({ value: new THREE.Color(hex) })
  const uniforms = {
    uTime: { value: 0 }, uGround: c(look.ground), uAccent: c(look.accent), uAccent2: c(look.accent2), uLight: c(look.light),
    uShadow: c(look.shadow), uFog: c(look.fog), uSunDir: { value: new THREE.Vector3(...look.sun).normalize() },
    uHeight: { value: height }, uTiles: { value: tiles }, uTileSize: { value: tileSize },
  }
  const code = CODE[kind]
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: kind === "water" ? 0.1 : 0 })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", `varying vec3 vW; varying vec3 vNW; uniform float uTime;\n${kind === "water" ? WAVES : ""}\nvoid main() {`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${kind === "water" ? VERTEX_WATER : ""}\nvNW = objectNormal; vW = (modelMatrix * vec4(transformed, 1.0)).xyz;`)
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `${COMMON}\n${kind === "water" ? WAVES : ""}\nvoid main() {`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n{ ${code.color} }`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\nroughnessFactor = gRough;`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${code.normal ? `{ ${code.normal} }\nnormal = normalize((viewMatrix * vec4(gWn, 0.0)).xyz);` : ""}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${code.emit ? `{ ${code.emit} }` : ""}\ntotalEmissiveRadiance += gEmis;`)
  }
  material.onBeforeRender = () => { uniforms.uTime.value = performance.now() / 1000 }

  const ground = new THREE.Mesh(geo, material)
  ground.name = `ground-${kind}`
  ground.receiveShadow = true
  ground.castShadow = kind === "terrain"
  ground.kind = kind
  ground.heightAt = (x = 0, z = 0) => (kind === "terrain" ? terrainHeight(x, z, height) : 0)
  const half = tiles / 2
  ground.tileAt = (x = 0, z = 0) => {
    const i = Math.floor(x / tileSize + half), j = Math.floor(z / tileSize + half)
    return i < 0 || j < 0 || i >= tiles || j >= tiles ? null : { i, j }
  }
  ground.tileCentre = (i = 0, j = 0) => new THREE.Vector3((i + 0.5 - half) * tileSize, 0, (j + 0.5 - half) * tileSize)
  ground.tiles = tiles
  ground.tileSize = tileSize
  return ground
}
