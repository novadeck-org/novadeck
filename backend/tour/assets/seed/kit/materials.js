// Shaders for things. Each function returns a three.js material to put on a mesh; it animates
// itself (time comes from the clock) once the mesh is in a rendered scene.
//   toon  glow  hologram  forcefield  dissolve  rim   and  outline(mesh)
// `color` takes a hex number, a CSS string or a THREE.Color; `look` picks default colours.
import * as THREE from "three"
import { getLook } from "./looks.js"

const toColor = (c, fallback) => {
  try { return new THREE.Color(c == null ? fallback : c) } catch { return new THREE.Color(fallback) }
}
const num = (v, d) => (Number.isFinite(v) ? v : d)
const accentOf = (o, key = "accent", fallback = 0x4aa8ff) => (o.look ? getLook(o.look, "materials")[key] : fallback)
const clock = () => performance.now() / 1000
const NOISE = `
float hash(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
`

// ---- toon: cel shading in a few flat steps, with a soft rim. Add materials.outline(mesh) for ink.
const stepTextures = new Map()
const stepTexture = (steps) => {
  if (!stepTextures.has(steps)) {
    const data = new Uint8Array(steps)
    for (let i = 0; i < steps; i++) data[i] = Math.round(70 + (185 * i) / Math.max(1, steps - 1))
    const t = new THREE.DataTexture(data, steps, 1, THREE.RedFormat)
    t.minFilter = t.magFilter = THREE.NearestFilter
    t.needsUpdate = true
    stepTextures.set(steps, t)
  }
  return stepTextures.get(steps)
}
export const toon = (o = {}) => {
  o = o || {}
  const m = new THREE.MeshToonMaterial({
    color: toColor(o.color, accentOf(o)), gradientMap: stepTexture(Math.max(2, Math.min(8, Math.round(num(o.steps, 4))))),
  })
  if (o.emissive != null) m.emissive = toColor(o.emissive, 0)
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
       totalEmissiveRadiance += diffuseColor.rgb * 0.55 * pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);`,
    )
  }
  return m
}

// outline(mesh, { color, thickness }): an inverted shell that draws a dark edge around the
// mesh (or around every mesh inside a group). Returns the outline mesh (the last one made).
const outlineMaterials = new Map()
export const outline = (object, o = {}) => {
  o = o || {}
  const key = `${new THREE.Color(toColor(o.color, 0x07040f)).getHex()}-${num(o.thickness, 0.035)}`
  if (!outlineMaterials.has(key)) {
    outlineMaterials.set(key, new THREE.ShaderMaterial({
      uniforms: { uColor: { value: toColor(o.color, 0x07040f) }, uThick: { value: num(o.thickness, 0.035) } },
      vertexShader: `uniform float uThick; void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xyz += normalize(normalMatrix * normal) * uThick * (1.0 + 0.04 * length(mv.xyz));
        gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; void main(){ gl_FragColor = vec4(uColor, 1.0);
        #include <colorspace_fragment>
      }`,
      side: THREE.BackSide, fog: false,
    }))
  }
  const mat = outlineMaterials.get(key)
  let made = null
  const targets = []
  object?.traverse?.((n) => { if (n.isMesh && !n.userData.isOutline && !n.children.some((c) => c.userData.isOutline)) targets.push(n) })
  for (const mesh of targets) {
    const shell = new THREE.Mesh(mesh.geometry, mat)
    shell.userData.isOutline = true
    shell.name = "outline"
    shell.raycast = () => {}
    mesh.add(shell)
    made = shell
  }
  return made
}

// ---- glow: a flat colour brighter than the screen can show, so the bloom picks it up
export const glow = (o = {}) => {
  o = o || {}
  const base = toColor(o.color, accentOf(o, "accent2", 0x33ddff))
  let intensity = num(o.intensity, 2.2)
  const pulse = num(o.pulse, 0)
  const m = new THREE.MeshBasicMaterial({ color: base.clone().multiplyScalar(intensity), toneMapped: false })
  m.onBeforeRender = () => {
    m.color.copy(base).multiplyScalar(intensity * (pulse ? 1 + 0.3 * Math.sin(clock() * pulse * 6.2832) : 1))
  }
  Object.defineProperty(m, "intensity", { get: () => intensity, set: (v) => { intensity = num(v, intensity) } })
  return m
}

const shaderBase = (uniforms, vertexShader, fragmentShader, extra = {}) =>
  new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, ...extra,
  })
const VARY_VERT = `varying vec3 vW; varying vec3 vN; varying vec3 vL;
void main(){ vL = position; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`

// ---- hologram: see-through, scan lines, a travelling bright band, now and then a glitch
export const hologram = (o = {}) => {
  o = o || {}
  const uniforms = { uColor: { value: toColor(o.color, accentOf(o, "accent2", 0x33ddff)) }, uTime: { value: 0 } }
  const m = shaderBase(uniforms, VARY_VERT, `uniform vec3 uColor; uniform float uTime; varying vec3 vW; varying vec3 vN; varying vec3 vL;
    ${NOISE}
    void main(){
      vec3 V = normalize(cameraPosition - vW);
      float fres = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
      float scan = 0.55 + 0.45 * sin(vW.y * 46.0 - uTime * 3.5);
      float band = smoothstep(0.93, 1.0, fract(vW.y * 0.5 - uTime * 0.35));
      float glitch = step(0.965, hash(vec2(floor(uTime * 9.0), 3.0)));
      float flick = 0.88 + 0.12 * sin(uTime * 50.0) - glitch * 0.35;
      float shift = glitch * (hash(vec2(floor(vW.y * 18.0), floor(uTime * 9.0))) - 0.5) * 0.6;
      float a = (0.16 + fres * 0.85) * scan * flick + band * 0.5 + shift * 0.2;
      gl_FragColor = vec4(uColor * (1.4 + band * 3.0 + fres), clamp(a, 0.0, 1.0));
    }`, { side: THREE.DoubleSide })
  m.onBeforeRender = () => { uniforms.uTime.value = clock() }
  return m
}

// ---- forcefield: a fresnel bubble with a faint honeycomb; material.hit(point) sends a ripple
export const forcefield = (o = {}) => {
  o = o || {}
  const rip = Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 0, -1000))
  const uniforms = { uColor: { value: toColor(o.color, accentOf(o, "accent2", 0x44aaff)) }, uTime: { value: 0 }, uRip: { value: rip } }
  const m = shaderBase(uniforms, VARY_VERT, `uniform vec3 uColor; uniform float uTime; uniform vec4 uRip[4];
    varying vec3 vW; varying vec3 vN; varying vec3 vL;
    float hexEdge(vec2 p){ p *= vec2(1.0, 1.1547); vec2 q = vec2(p.x * 1.1547 , p.y);
      vec2 a = mod(q, vec2(2.0, 2.0)) - 1.0, b = mod(q + 1.0, vec2(2.0, 2.0)) - 1.0;
      return smoothstep(0.1, 0.0, min(abs(length(a) - 0.95), abs(length(b) - 0.95))); }
    void main(){
      vec3 N = normalize(vN), V = normalize(cameraPosition - vW);
      float fres = pow(1.0 - abs(dot(N, V)), 2.4);
      vec3 d = normalize(vL);
      float cells = hexEdge(vec2(atan(d.z, d.x) * 6.0, d.y * 9.0));
      float ripple = 0.0;
      for (int i = 0; i < 4; i++){
        float age = uTime - uRip[i].w;
        float ring = exp(-pow((distance(vW, uRip[i].xyz) - age * 4.0) * 1.4, 2.0)) * exp(-age * 1.5);
        ripple += ring * step(0.0, age);
      }
      float pulse = 0.85 + 0.15 * sin(uTime * 2.0);
      float a = (0.04 + fres * 0.7 * pulse + cells * (0.05 + fres * 0.3) + ripple * 0.9);
      gl_FragColor = vec4(uColor * (1.2 + ripple * 3.0 + fres * 1.5), clamp(a, 0.0, 1.0));
    }`, { side: THREE.DoubleSide })
  let next = 0
  m.hit = (point = { x: 0, y: 0, z: 0 }) => {
    rip[next].set(num(point?.x, 0), num(point?.y, 0), num(point?.z, 0), clock())
    next = (next + 1) % rip.length
  }
  m.onBeforeRender = () => { uniforms.uTime.value = clock() }
  return m
}

// ---- dissolve: a lit material that burns away with glowing edges as `amount` goes 0 → 1
export const dissolve = (o = {}) => {
  o = o || {}
  const uniforms = {
    uAmount: { value: num(o.amount, 0) }, uEdge: { value: toColor(o.edge, accentOf(o, "accent", 0xff7a1a)) },
  }
  const m = new THREE.MeshStandardMaterial({ color: toColor(o.color, 0x8a8aa8), roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "varying vec3 vL;\nvoid main() {")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvL = position;")
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `varying vec3 vL; uniform float uAmount; uniform vec3 uEdge; float gEdge = 0.0;${NOISE}\nvoid main() {`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 q = vL * 3.5 + 17.0;
        float dn = 0.4 * noise(q.xy) + 0.35 * noise(q.yz * 1.7) + 0.25 * noise(q.zx * 3.1) * 0.8 + 0.05 * vL.y;
        float thr = uAmount * 1.12 - 0.06;
        if (dn < thr) discard;
        gEdge = smoothstep(thr + 0.09, thr, dn) * step(0.0005, uAmount);`)
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += uEdge * gEdge * 5.0;")
  }
  Object.defineProperty(m, "amount", { get: () => uniforms.uAmount.value, set: (v) => { uniforms.uAmount.value = Math.min(1, Math.max(0, num(v, 0))) } })
  return m
}

// ---- rim: a lit material with a bright edge, like a backlit character
export const rim = (o = {}) => {
  o = o || {}
  const uniforms = { uRim: { value: toColor(o.rim, accentOf(o, "accent2", 0x66ddff)) }, uPower: { value: num(o.power, 2.6) }, uStrength: { value: num(o.strength, 1.8) } }
  const m = new THREE.MeshStandardMaterial({ color: toColor(o.color, 0x3a2a66), roughness: num(o.roughness, 0.5), metalness: num(o.metalness, 0.05) })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform vec3 uRim; uniform float uPower, uStrength;\nvoid main() {")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance += uRim * uStrength * pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), uPower);`)
  }
  Object.defineProperty(m, "rimColor", { get: () => uniforms.uRim.value, set: (v) => uniforms.uRim.value.set(v) })
  return m
}
