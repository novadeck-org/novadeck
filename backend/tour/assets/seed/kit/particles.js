// Particles: bursts, emitters and weather, drawn by the GPU.
// createParticles(stage) → { burst(name, position, opts), emitter(name, object, opts), weather(name, opts) }.
// Every particle is one instance of a camera-facing quad in a pooled ring buffer. Its motion is
// worked out in the vertex shader from its spawn data, so the CPU only writes a particle once,
// when it is born, and nothing is allocated per frame. Colours above 1.0 glow under the bloom.
import * as THREE from "three"
import { getLook } from "./looks.js"

const STRIDE = 28 // floats per particle
// layout: pos.xyz birth | vel.xyz life | size0 size1 drag grav | rgb0 alpha | rgb1 spin | stretch swirl twinkle shape | off.xyz -
const SHAPE = { soft: 0, streak: 1, confetti: 2, star: 3, smoke: 4, plus: 5 }
const BURST_PALETTE = [0xff3366, 0xffd34d, 0x35e0ff, 0x7cff6b, 0xb06bff, 0xffffff]

// ---------------------------------------------------------------- shaders
const PART_VERT = /* glsl */ `
attribute vec4 aPos, aVel, aSize, aC0, aC1, aFx, aOff;
uniform float uTime;
varying vec4 vCol; varying vec2 vUv; varying float vShape; varying float vSeed;
void main() {
  float age = uTime - aPos.w, life = aVel.w, t = age / life;
  if (t < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = max(aSize.z, 0.0001);
  vec3 d = aVel.xyz * ((1.0 - exp(-k * age)) / k) + aOff.xyz;
  d.y -= 0.5 * aSize.w * age * age;
  float ang = aFx.y * age, cs = cos(ang), sn = sin(ang);
  d.xz = vec2(cs * d.x - sn * d.z, sn * d.x + cs * d.z);
  vec4 mv = modelViewMatrix * vec4(aPos.xyz + d, 1.0);
  float size = mix(aSize.x, aSize.y, 1.0 - (1.0 - t) * (1.0 - t));
  float tw = 1.0;
  if (aFx.z > 0.0) tw = 1.0 - aFx.z * (0.5 + 0.5 * sin(age * 28.0 + aPos.w * 173.0));
  vec2 axis = vec2(1.0, 0.0);
  float sx = size, sy = size;
  if (aFx.x > 0.0) {
    vec3 vw = aVel.xyz * exp(-k * age); vw.y -= aSize.w * age;
    vec2 v2 = (modelViewMatrix * vec4(vw, 0.0)).xy;
    float sp = length(v2);
    if (sp > 1e-4) axis = v2 / sp;
    sx = size * (1.0 + aFx.x * length(vw) * 10.0);
  } else {
    float a = aC1.w * age + aPos.w * 41.0;
    axis = vec2(cos(a), sin(a));
    if (aFx.w > 1.5 && aFx.w < 2.5) sy *= abs(cos(age * aC1.w * 0.7 + aPos.w * 13.0));
  }
  vec2 c = position.xy;
  mv.xy += axis * c.x * sx + vec2(-axis.y, axis.x) * c.y * sy;
  mv.z = min(mv.z + size * 1.3, -0.2); // lean towards the camera so big puffs don't sink into the ground
  gl_Position = projectionMatrix * mv;
  vUv = c; vShape = aFx.w; vSeed = aPos.w;
  float fade = smoothstep(0.0, 0.03, age) * (1.0 - t * t) * tw;
  vCol = vec4(mix(aC0.rgb, aC1.rgb, t), aC0.a * fade);
}`

const PART_FRAG = /* glsl */ `
varying vec4 vCol; varying vec2 vUv; varying float vShape; varying float vSeed;
void main() {
  vec2 p = vUv; float r = length(p); float a;
  if (vShape < 0.5) { a = 1.0 - smoothstep(0.0, 1.0, r); a = a * a + 0.6 * pow(max(0.0, 1.0 - r * 1.8), 3.0); }
  else if (vShape < 1.5) { a = pow(max(0.0, 1.0 - abs(p.x)), 0.7) * (1.0 - smoothstep(0.0, 1.0, abs(p.y))); a *= a; }
  else if (vShape < 2.5) { a = 1.0 - smoothstep(0.85, 1.0, max(abs(p.x), abs(p.y))); }
  else if (vShape < 3.5) { float s = max(0.0, 1.0 - r); a = s * s * (0.35 + 1.6 * exp(-16.0 * min(abs(p.x), abs(p.y)))); }
  else if (vShape < 4.5) { float w = 0.8 + 0.2 * sin(atan(p.y, p.x) * 3.0 + vSeed * 50.0); a = (1.0 - smoothstep(0.1, w, r)); a *= a; }
  else { float arms = max(1.0 - smoothstep(0.12, 0.3, abs(p.x)) * step(abs(p.y), 1.0), 0.0); a = max((1.0 - smoothstep(0.14, 0.34, abs(p.x))) * (1.0 - smoothstep(0.7, 1.0, abs(p.y))), (1.0 - smoothstep(0.14, 0.34, abs(p.y))) * (1.0 - smoothstep(0.7, 1.0, abs(p.x)))); }
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol.rgb * a * vCol.a, ADDITIVE ? 1.0 : a * vCol.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

const RING_VERT = /* glsl */ `
attribute vec4 aC, aR, aCol; uniform float uTime;
varying vec2 vUv; varying vec4 vCol; varying float vT;
void main() {
  float t = (uTime - aC.w) / aR.x; vT = t;
  if (t < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vUv = position.xy * 1.15; vCol = aCol;
  vec3 wp = aC.xyz + vec3(position.x, 0.0, position.y) * aR.y * 1.15;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`
const RING_FRAG = /* glsl */ `
uniform vec2 uDummy; varying vec2 vUv; varying vec4 vCol; varying float vT;
void main() {
  float e = 1.0 - pow(1.0 - vT, 3.0), d = length(vUv);
  float w = 0.03 + 0.1 * (1.0 - vT);
  float ring = 1.0 - smoothstep(0.0, w, abs(d - e));
  float tail = (1.0 - smoothstep(e - 0.35, e, d)) * step(d, e) * 0.12;
  float a = (ring + tail) * pow(1.0 - vT, 1.4);
  gl_FragColor = vec4(vCol.rgb * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

const WEATHER_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime, uFade; uniform vec3 uBox, uVel, uCenter; uniform vec4 uP; uniform vec4 uCol;
varying vec4 vCol; varying vec2 vUv; varying float vShape;
void main() {
  vec3 p = aSeed.xyz * uBox + uVel * uTime * (0.8 + 0.4 * aSeed.w);
  float f = uP.w > 0.0 ? 1.0 : 0.0;
  p += uP.z * vec3(sin(uTime * 0.9 + aSeed.x * 40.0), sin(uTime * 1.2 + aSeed.y * 40.0), cos(uTime * 0.8 + aSeed.z * 40.0));
  vec3 q = mod(p - uCenter + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec3 wp = uCenter + q;
  vec3 qa = abs(q) / uBox;
  float edge = 1.0 - smoothstep(0.36, 0.5, max(qa.x, max(qa.y, qa.z)));
  float ground = smoothstep(0.0, 0.4, wp.y);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vec2 axis = vec2(1.0, 0.0); float sx = uP.x, sy = uP.x;
  if (uP.y > 0.0) {
    vec2 v2 = (viewMatrix * vec4(uVel, 0.0)).xy; float sp = length(v2);
    if (sp > 1e-4) axis = v2 / sp;
    sx = uP.y;
  }
  vec2 c = position.xy;
  mv.xy += axis * c.x * sx + vec2(-axis.y, axis.x) * c.y * sy;
  gl_Position = projectionMatrix * mv;
  vUv = c; vShape = uP.y > 0.0 ? 1.0 : 0.0;
  float pulse = uP.w > 0.0 ? 0.5 + 0.5 * sin(uTime * uP.w + aSeed.w * 60.0) : 1.0;
  float near = smoothstep(1.5, 6.0, -mv.z);
  vCol = vec4(uCol.rgb, uCol.a * edge * ground * pulse * uFade * near);
}`
const WEATHER_FRAG = /* glsl */ `
varying vec4 vCol; varying vec2 vUv; varying float vShape;
void main() {
  float r = length(vUv), a;
  if (vShape > 0.5) a = (1.0 - abs(vUv.x)) * (1.0 - abs(vUv.y)); else { a = 1.0 - smoothstep(0.0, 1.0, r); a *= a; }
  gl_FragColor = vec4(vCol.rgb * a * vCol.a, ADDITIVE ? 1.0 : a * vCol.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

// ---------------------------------------------------------------- recipes
// A recipe part: n particles, layer (add|alpha), shape, dir (sphere|up|flat|radial|back), cone, spd, life, sz
// [min,max], ze (end size x), drag, g (gravity; negative rises), c0/c1 ([r,g,b] or "A"/"B" look colours),
// h0/h1 (brightness when a colour is given), al, st (stretch), sw (swirl), tw (twinkle), sp (spin), offM
// (point|sphere|ring|disc), offR, offY, lift, dl (delay).
const DEF = { n: 1, layer: "add", sh: "soft", dir: "sphere", cone: 0.6, spd: [0, 0], life: [0.5, 1], sz: [0.2, 0.3], ze: 1, drag: 0, g: 0, c0: [1, 1, 1], c1: [0.3, 0.3, 0.3], h0: 3, h1: 0.8, al: 1, st: 0, sw: 0, tw: 0, sp: [0, 0], offM: "point", offR: 0, offY: 0, lift: 0, dl: 0 }
const SMOKE = { layer: "alpha", sh: "smoke", al: 0.55, h0: 0.35, h1: 0.1 }
const SPARK = { sh: "streak", st: 0.09, tw: 0 }
const parts = (...p) => p.map((x) => Object.setPrototypeOf(x, DEF))

const BURSTS = {
  explosion: { count: 60, ring: { r: 3.4, life: 0.5, c: [3.5, 1.6, 0.5] }, pulse: 0.7, parts: parts(
    { sh: "soft", spd: [0, 0], life: [0.14, 0.2], sz: [1.5, 1.9], ze: 1.5, c0: [7, 6, 4], c1: [3, 1.2, 0.3], h0: 6, h1: 2 },
    { n: 24, spd: [2, 6.5], life: [0.35, 0.75], sz: [0.7, 1.2], ze: 1.6, drag: 3.2, g: -1.5, c0: [2.6, 1.15, 0.28], c1: [0.5, 0.06, 0.01], al: 0.8, lift: 1 },
    { n: 10, spd: [1, 3.5], life: [0.2, 0.4], sz: [0.5, 0.9], ze: 1.4, drag: 3, c0: [7, 6, 4], c1: [2.4, 0.9, 0.2], tint: 0 },
    { ...SPARK, n: 46, spd: [5, 16], life: [0.5, 1.3], sz: [0.045, 0.09], ze: 0.3, drag: 0.6, g: 16, c0: [5, 3, 0.8], c1: [1.2, 0.2, 0.05], lift: 1.5 },
    { ...SMOKE, n: 16, spd: [0.5, 2.6], life: [1.4, 2.6], sz: [0.6, 1], ze: 2.2, drag: 1.4, g: -1.1, al: 0.45, c0: [0.5, 0.22, 0.09], c1: [0.07, 0.065, 0.075], lift: 1 },
    { ...SMOKE, n: 12, dir: "flat", spd: [3, 5.5], life: [0.7, 1.3], sz: [0.5, 0.8], ze: 2.4, drag: 3, c0: [0.3, 0.26, 0.22], c1: [0.1, 0.09, 0.09], al: 0.4 },
    { n: 14, spd: [1, 5], life: [1.2, 2.4], sz: [0.05, 0.09], ze: 0.2, drag: 0.8, g: -0.8, c0: [4, 1.6, 0.3], c1: [1, 0.1, 0], tw: 0.8 },
  ) },
  hit: { count: 20, ring: { r: 1, life: 0.25, c: [3, 2.5, 1.2] }, pulse: 0.2, parts: parts(
    { sz: [0.9, 1.1], life: [0.08, 0.1], c0: [6, 6, 5], c1: [3, 2, 1], ze: 1.5, h0: 5, h1: 2 },
    { ...SPARK, n: 20, spd: [3, 10], life: [0.15, 0.45], sz: [0.04, 0.07], ze: 0.4, drag: 2, g: 8, c0: [5, 3.5, 1.2], c1: [1.5, 0.2, 0.1], h0: 4, h1: 1 },
    { n: 4, spd: [0.5, 2], life: [0.15, 0.3], sz: [0.3, 0.5], ze: 1.6, c0: [4, 2, 0.8], c1: [1, 0.3, 0.1] },
  ) },
  sparks: { count: 30, parts: parts(
    { ...SPARK, n: 30, dir: "up", cone: 0.9, spd: [4, 10], life: [0.5, 1.1], sz: [0.045, 0.09], ze: 0.3, drag: 0.8, g: 14, c0: [5, 3.4, 1], c1: [1.4, 0.25, 0.05], h0: 4, h1: 1 },
    { sz: [0.6, 0.8], life: [0.1, 0.14], c0: [5, 4, 2], c1: [2, 1, 0.3] },
  ) },
  smoke: { count: 14, parts: parts(
    { ...SMOKE, n: 16, dir: "up", cone: 1.1, spd: [0.3, 1.4], life: [1.6, 2.8], sz: [0.35, 0.6], ze: 3, drag: 1.2, g: -0.6, offM: "sphere", offR: 0.55, al: 0.45, c0: [0.3, 0.29, 0.32], c1: [0.08, 0.08, 0.1], h0: 0.5, h1: 0.2 },
  ) },
  magic: { count: 40, ring: { r: 1.1, life: 0.5, c: [1.5, 0.6, 3] }, pulse: 0.15, parts: parts(
    { sh: "star", n: 40, dir: "up", spd: [0.3, 1.3], lift: 0.6, life: [0.8, 1.7], sz: [0.1, 0.22], ze: 0.3, sw: 3, tw: 0.7, offM: "sphere", offR: 0.7, c0: "A", c1: "B", h0: 3.5, h1: 1.5 },
    { n: 18, dir: "up", spd: [0.2, 0.8], life: [0.6, 1.2], sz: [0.1, 0.2], ze: 0.2, sw: -2, offM: "sphere", offR: 0.5, c0: "B", c1: "A", h0: 2, h1: 0.6, al: 0.6 },
    { sz: [1.3, 1.5], life: [0.5, 0.6], ze: 0.4, c0: "A", c1: "B", h0: 1.4, h1: 0.4, al: 0.8 },
  ) },
  heal: { count: 26, parts: parts(
    { sh: "plus", n: 12, dir: "up", spd: [1.2, 2.4], life: [0.9, 1.5], sz: [0.12, 0.2], ze: 0.6, sw: 1.2, offM: "disc", offR: 0.6, c0: [0.7, 3.2, 1], c1: [0.1, 1.2, 0.4], h0: 2.4 },
    { sh: "star", n: 14, dir: "up", spd: [1.5, 3], life: [0.8, 1.4], sz: [0.08, 0.16], ze: 0.3, sw: -1.5, tw: 0.8, offM: "disc", offR: 0.5, c0: [0.7, 3.5, 1.2], c1: [0.2, 1.5, 0.6], h0: 3 },
    { sz: [1.4, 1.6], life: [0.35, 0.45], ze: 0.5, c0: [0.5, 2, 0.8], c1: [0.1, 0.6, 0.3], h0: 1.4, al: 0.6 },
  ) },
  pickup: { count: 24, ring: { r: 1.2, life: 0.45, c: [3, 2.2, 0.6] }, parts: parts(
    { sh: "star", n: 24, dir: "up", spd: [1.4, 2.6], life: [0.6, 1.1], sz: [0.1, 0.2], ze: 0.2, drag: 0.8, tw: 0.8, sw: 2, offM: "ring", offR: 0.55, c0: [5, 3.8, 1], c1: [2, 0.9, 0.2], h0: 4 },
    { sz: [0.9, 1.1], life: [0.2, 0.3], ze: 1.4, c0: [4, 3, 1], c1: [1, 0.6, 0.1], al: 0.8 },
  ) },
  confetti: { count: 70, parts: parts(
    { layer: "alpha", sh: "confetti", n: 70, dir: "up", cone: 0.85, spd: [5, 11], life: [1.8, 3.2], sz: [0.07, 0.13], drag: 1.3, g: 9, sp: [8, 18], offM: "sphere", offR: 0.2, h0: 1, h1: 1, pal: 1 },
  ) },
  dust: { count: 10, parts: parts(
    { ...SMOKE, n: 10, dir: "flat", spd: [0.8, 2.2], life: [0.5, 0.95], sz: [0.18, 0.3], ze: 2.4, drag: 2, g: -0.3, lift: 0.4, offM: "ring", offR: 0.15, c0: [0.62, 0.58, 0.5], c1: [0.5, 0.47, 0.42], al: 0.45, h0: 0.7, h1: 0.6 },
  ) },
  portal: { count: 60, ring: { r: 1.8, life: 0.6, c: [1.5, 0.8, 3.5] }, pulse: 0.3, parts: parts(
    { sh: "star", n: 60, dir: "radial", spd: [-1.6, -0.5], life: [0.9, 1.5], sz: [0.08, 0.17], ze: 0.3, drag: 0.2, sw: 5, tw: 0.5, offM: "ring", offR: 1.3, c0: "A", c1: "B", h0: 4, h1: 2 },
    { sz: [1.8, 2.2], life: [0.5, 0.6], ze: 0.3, c0: "B", c1: "A", h0: 1.5, h1: 0.5, al: 0.9 },
  ) },
}
const EMITTERS = {
  trail: { rate: 1, parts: parts({ rate: 70, spd: [0, 0.15], life: [0.4, 0.7], sz: [0.22, 0.3], ze: 0, c0: "A", c1: "B", h0: 3, h1: 0.7 }) },
  fire: { rate: 1, parts: parts(
    { rate: 45, dir: "up", cone: 0.3, spd: [1, 2.2], life: [0.45, 0.9], sz: [0.18, 0.3], ze: 0.15, g: -2, offM: "disc", offR: 0.12, c0: [3, 1.4, 0.25], c1: [0.7, 0.07, 0.01], al: 0.8 },
    { rate: 12, ...SMOKE, dir: "up", cone: 0.3, spd: [0.8, 1.6], life: [1.2, 2], sz: [0.2, 0.3], ze: 3, g: -1, offY: 0.7, c0: [0.25, 0.24, 0.25], c1: [0.08, 0.08, 0.09], al: 0.4 },
    { rate: 14, sh: "streak", st: 0.05, dir: "up", cone: 0.7, spd: [1.5, 4], life: [0.5, 1.1], sz: [0.025, 0.045], ze: 0.3, g: 1, c0: [5, 2.5, 0.5], c1: [1, 0.1, 0], offY: 0.1 },
  ) },
  smoke: { rate: 1, parts: parts({ ...SMOKE, rate: 14, dir: "up", cone: 0.4, spd: [0.4, 1], life: [1.6, 2.6], sz: [0.3, 0.4], ze: 3, g: -0.4, c0: [0.36, 0.34, 0.37], c1: [0.1, 0.1, 0.12], al: 0.5, h0: 0.5, h1: 0.2 }) },
  thruster: { rate: 1, parts: parts(
    { rate: 110, dir: "back", cone: 0.12, spd: [5, 9], life: [0.2, 0.4], sz: [0.13, 0.2], ze: 0.1, drag: 0.5, c0: [3, 4, 6.5], c1: [0.3, 0.4, 2.2], h0: 4, h1: 0.8 },
    { rate: 40, dir: "back", cone: 0.05, spd: [1, 2], life: [0.1, 0.14], sz: [0.12, 0.16], ze: 0.8, c0: [6, 6, 6], c1: [2, 3, 6], h0: 6, h1: 2, tint: 0 },
    { rate: 30, sh: "streak", st: 0.08, dir: "back", cone: 0.2, spd: [6, 12], life: [0.2, 0.45], sz: [0.03, 0.05], ze: 0.3, c0: [4, 5, 8], c1: [0.4, 0.5, 2] },
  ) },
  aura: { rate: 1, parts: parts({ rate: 30, sh: "star", dir: "up", spd: [0.4, 1], life: [0.8, 1.5], sz: [0.07, 0.14], ze: 0.3, sw: 2.2, tw: 0.7, offM: "ring", offR: 0.7, offY: 0.6, c0: "A", c1: "B", h0: 3.5, h1: 1 }) },
}
const WEATHER = {
  rain: { n: 5000, box: [70, 36, 70], vel: [-3, -32, -1.5], size: 0.014, len: 0.6, sway: 0, col: [0.62, 0.76, 1, 0.6], add: false },
  snow: { n: 3500, box: [60, 30, 60], vel: [0.4, -1.6, 0.2], size: 0.085, sway: 0.7, col: [1.1, 1.15, 1.25, 1], add: false },
  embers: { n: 700, box: [50, 26, 50], vel: [0.4, 1.4, 0.2], size: 0.07, sway: 1, pulse: 7, col: [4.5, 1.7, 0.35, 1], add: true },
  dust: { n: 900, box: [40, 14, 40], vel: [0.25, 0.05, 0.1], size: 0.04, sway: 0.5, col: [1, 0.95, 0.85, 0.4], add: false },
  fireflies: { n: 140, box: [40, 8, 40], vel: [0, 0, 0], size: 0.09, sway: 2, pulse: 2.5, col: [2.5, 3.4, 0.5, 1], add: true },
}
const warned = new Set()
const pickName = (table, name, fallback, who) => {
  if (table[name]) return name
  if (!warned.has(who + name)) { warned.add(who + name); console.warn(`particles.${who}: unknown preset "${name}" (use ${Object.keys(table).join(", ")}${who === "burst" ? ", lightning" : ""}); using "${fallback}".`) }
  return fallback
}

// ---------------------------------------------------------------- helpers
const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d)
const rnd = (a, b) => a + Math.random() * (b - a)
const tmpC = new THREE.Color()
const P = { x: 0, y: 0, z: 0 } // scratch position
const readPos = (v) => {
  P.x = P.y = P.z = 0
  if (!v) return P
  if (v.isObject3D) { v.updateWorldMatrix(true, false); const e = v.matrixWorld.elements; P.x = e[12]; P.y = e[13]; P.z = e[14]; return P }
  P.x = num(v.x, 0); P.y = num(v.y, 0); P.z = num(v.z, 0)
  return P
}
const rgb = new Float32Array(6) // c0 then c1, filled by resolveColors
const resolveColors = (S, ctx) => {
  if (S.pal) { tmpC.set(BURST_PALETTE[(Math.random() * BURST_PALETTE.length) | 0]); if (ctx.user) tmpC.copy(ctx.user); tmpC.toArray(rgb, 0); tmpC.toArray(rgb, 3); return }
  const tok = (c, h, o) => {
    if (c === "A" || c === "B") tmpC.set(c === "A" ? ctx.look.accent : ctx.look.accent2).multiplyScalar(h)
    else tmpC.setRGB(c[0], c[1], c[2])
    tmpC.toArray(rgb, o)
  }
  if (ctx.user && S.tint !== 0) {
    tmpC.copy(ctx.user).multiplyScalar(S.h0).toArray(rgb, 0)
    tmpC.copy(ctx.user).multiplyScalar(S.h1 * 0.45).toArray(rgb, 3)
    return
  }
  tok(S.c0, S.h0, 0); tok(S.c1, S.h1, 3)
}

// One pooled layer: a ring buffer of particles drawn as a single instanced mesh.
const makeLayer = (cap, additive, uTime, order) => {
  const data = new Float32Array(cap * STRIDE)
  for (let i = 0; i < cap; i++) { data[i * STRIDE + 3] = -1e6; data[i * STRIDE + 7] = 1 }
  const buf = new THREE.InstancedInterleavedBuffer(data, STRIDE).setUsage(THREE.DynamicDrawUsage)
  const geo = new THREE.InstancedBufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
  geo.setIndex([0, 1, 2, 0, 2, 3])
  ;["aPos", "aVel", "aSize", "aC0", "aC1", "aFx", "aOff"].forEach((n, i) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, 4, i * 4)))
  geo.instanceCount = 0
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime }, vertexShader: PART_VERT, fragmentShader: PART_FRAG.replace("ADDITIVE", additive ? "true" : "false"),
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = order
  const L = { mesh, data, buf, head: 0, high: 0, lo: Infinity, hi: -1 }
  L.flush = () => {
    if (L.hi < L.lo) return
    buf.clearUpdateRanges()
    buf.addUpdateRange(L.lo * STRIDE, (L.hi - L.lo + 1) * STRIDE)
    buf.needsUpdate = true
    L.lo = Infinity; L.hi = -1
  }
  return L
}

export const createParticles = (stage, options = {}) => {
  const st = stage && typeof stage === "object" ? stage : {}
  const scene = st.scene
  if (!scene) console.warn("createParticles(stage): needs a stage with a scene.")
  const uTime = { value: 0 }
  const group = new THREE.Group()
  group.name = "particles"
  scene?.add(group)
  const glowL = makeLayer(10000, true, uTime, 12)
  const alphaL = makeLayer(5000, false, uTime, 11)
  group.add(alphaL.mesh, glowL.mesh)

  const currentLook = () => getLook(options.look ?? st.look, "createParticles")

  // shockwave rings: a small instanced pool of flat rings
  const RN = 32
  const ringData = new Float32Array(RN * 12)
  const ringBuf = new THREE.InstancedInterleavedBuffer(ringData, 12).setUsage(THREE.DynamicDrawUsage)
  const ringGeo = new THREE.InstancedBufferGeometry()
  ringGeo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
  ringGeo.setIndex([0, 1, 2, 0, 2, 3])
  ;["aC", "aR", "aCol"].forEach((n, i) => ringGeo.setAttribute(n, new THREE.InterleavedBufferAttribute(ringBuf, 4, i * 4)))
  ringGeo.instanceCount = RN
  for (let i = 0; i < RN; i++) ringData[i * 12 + 3] = -1e6
  const ringMesh = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({
    uniforms: { uTime }, vertexShader: RING_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }))
  ringMesh.frustumCulled = false
  ringMesh.renderOrder = 13
  group.add(ringMesh)
  let ringHead = 0
  const addRing = (x, y, z, r, life, c, delay = 0) => {
    const o = ringHead * 12
    ringHead = (ringHead + 1) % RN
    ringData.set([x, y, z, uTime.value + delay, life, r, 0, 0, c[0], c[1], c[2], 1], o)
    ringBuf.needsUpdate = true
  }

  // ---- spawning
  const ctx = { look: null, user: null, size: 1, speed: 1, delay: 0, fx: 0, fy: 0, fz: 1 }
  const dir = [0, 0, 0]
  const spawn = (S, cx, cy, cz) => {
    const L = S.layer === "alpha" ? alphaL : glowL
    const cap = L.data.length / STRIDE
    const i = L.head
    L.head = (i + 1) % cap
    if (L.head === 0) { L.lo = 0; L.hi = cap - 1 } else { L.lo = Math.min(L.lo, i); L.hi = Math.max(L.hi, i) }
    if (i >= L.high) { L.high = i + 1; L.mesh.geometry.instanceCount = L.high }
    // offset from the burst centre
    let ox = 0, oy = S.offY * ctx.size, oz = 0
    if (S.offM !== "point") {
      const a = Math.random() * 6.2832, R = S.offM === "ring" ? S.offR : S.offR * Math.sqrt(Math.random())
      if (S.offM === "sphere") {
        const zz = rnd(-1, 1), rr = Math.sqrt(1 - zz * zz) * R * Math.cbrt(Math.random())
        ox = Math.cos(a) * rr; oy += zz * R * Math.cbrt(Math.random()); oz = Math.sin(a) * rr
      } else { ox = Math.cos(a) * R; oz = Math.sin(a) * R }
      ox *= ctx.size; oy *= ctx.size; oz *= ctx.size
    }
    // direction
    const spd = rnd(S.spd[0], S.spd[1]) * ctx.speed
    let vx, vy, vz
    switch (S.dir) {
      case "up": { const th = Math.random() * S.cone, a = Math.random() * 6.2832; vx = Math.sin(th) * Math.cos(a); vy = Math.cos(th); vz = Math.sin(th) * Math.sin(a); break }
      case "flat": { const a = Math.random() * 6.2832; vx = Math.cos(a); vy = rnd(0, 0.12); vz = Math.sin(a); break }
      case "radial": { const l = Math.hypot(ox, oz) || 1; vx = ox / l; vy = 0; vz = oz / l; break }
      case "back": {
        const th = Math.random() * S.cone, a = Math.random() * 6.2832
        dir[0] = Math.sin(th) * Math.cos(a); dir[1] = Math.sin(th) * Math.sin(a); dir[2] = -Math.cos(th)
        // rotate local (x,y,-z) into the object's frame: z axis = forward (fx,fy,fz)
        const fx = ctx.fx, fy = ctx.fy, fz = ctx.fz
        let ux = 0, uy = 1, uz = 0
        if (Math.abs(fy) > 0.95) { ux = 1; uy = 0 }
        let rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx
        const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl
        const tx = fy * rz - fz * ry, ty = fz * rx - fx * rz, tz = fx * ry - fy * rx
        vx = rx * dir[0] + tx * dir[1] + fx * dir[2]; vy = ry * dir[0] + ty * dir[1] + fy * dir[2]; vz = rz * dir[0] + tz * dir[1] + fz * dir[2]
        break
      }
      default: { const zz = rnd(-1, 1), a = Math.random() * 6.2832, r = Math.sqrt(1 - zz * zz); vx = r * Math.cos(a); vy = zz; vz = r * Math.sin(a) }
    }
    resolveColors(S, ctx)
    const d = L.data, o = i * STRIDE, sz = ctx.size
    d[o] = cx; d[o + 1] = cy; d[o + 2] = cz; d[o + 3] = uTime.value + ctx.delay + S.dl
    d[o + 4] = vx * spd; d[o + 5] = vy * spd + S.lift * ctx.speed; d[o + 6] = vz * spd; d[o + 7] = rnd(S.life[0], S.life[1])
    const s0 = rnd(S.sz[0], S.sz[1]) * sz
    d[o + 8] = s0; d[o + 9] = s0 * S.ze; d[o + 10] = S.drag; d[o + 11] = S.g
    d[o + 12] = rgb[0]; d[o + 13] = rgb[1]; d[o + 14] = rgb[2]; d[o + 15] = S.al
    d[o + 16] = rgb[3]; d[o + 17] = rgb[4]; d[o + 18] = rgb[5]; d[o + 19] = rnd(S.sp[0], S.sp[1]) * (Math.random() < 0.5 ? -1 : 1)
    d[o + 20] = S.st; d[o + 21] = S.sw; d[o + 22] = S.tw; d[o + 23] = SHAPE[S.sh] ?? 0
    d[o + 24] = ox; d[o + 25] = oy; d[o + 26] = oz; d[o + 27] = 0
  }
  const setCtx = (opts, extra) => {
    ctx.look = currentLook()
    ctx.user = null
    if (opts.color != null) { try { ctx.user = new THREE.Color(opts.color) } catch { ctx.user = null } }
    ctx.size = Math.max(0.01, num(opts.size, 1))
    ctx.speed = Math.max(0, num(opts.speed, 1))
    ctx.delay = 0
    return extra
  }
  const pulse = (v) => { try { st.post?.pulse?.(v) } catch {} }

  // ---- lightning: a jagged bolt of glowing points, flickering twice
  const bolt = (ax, ay, az, bx, by, bz, jag, core, halo, delay) => {
    const len = Math.hypot(bx - ax, by - ay, bz - az) || 1
    const seg = Math.max(5, Math.round(len / 0.6)), step = 0.055
    let px = ax, py = ay, pz = az
    const perp = len * jag
    for (let s = 1; s <= seg; s++) {
      const f = s / seg, end = s === seg
      const nx = end ? bx : ax + (bx - ax) * f + rnd(-1, 1) * perp * 0.12, ny = end ? by : ay + (by - ay) * f + rnd(-1, 1) * perp * 0.12, nz = end ? bz : az + (bz - az) * f + rnd(-1, 1) * perp * 0.12
      const n = Math.max(2, Math.ceil(Math.hypot(nx - px, ny - py, nz - pz) / step))
      for (let k = 0; k < n; k++) {
        const t = k / n, x = px + (nx - px) * t, y = py + (ny - py) * t, z = pz + (nz - pz) * t
        ctx.delay = delay
        spawn(core, x, y, z)
        if (k % 5 === 0) spawn(halo, x, y, z)
      }
      px = nx; py = ny; pz = nz
    }
  }
  const BOLT_CORE = Object.setPrototypeOf({ life: [0.1, 0.16], sz: [0.1, 0.14], ze: 0.5, c0: [7, 8, 10], c1: [2, 3, 8], h0: 6, h1: 2, tw: 0.4 }, DEF)
  const BOLT_HALO = Object.setPrototypeOf({ life: [0.14, 0.24], sz: [0.4, 0.55], ze: 0.6, c0: [0.6, 0.9, 3], c1: [0.2, 0.2, 1.5], h0: 1.6, h1: 0.5, al: 0.5 }, DEF)
  const lightning = (p, opts) => {
    const to = readPos(opts.to) // overwrites P, so read `from` first
    const tx = to.x, ty = to.y, tz = to.z, hasTo = opts.to != null
    const f = readPos(p)
    const ax = f.x, ay = f.y, az = f.z
    const bx = hasTo ? tx : ax, by = hasTo ? ty : ay + 6, bz = hasTo ? tz : az
    for (let pass = 0; pass < 3; pass++) {
      const dl = pass * 0.07
      bolt(ax, ay, az, bx, by, bz, 0.5, BOLT_CORE, BOLT_HALO, dl)
      for (let b = 0; b < 2; b++) { // short branches
        const t = rnd(0.2, 0.8), x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t
        bolt(x, y, z, x + rnd(-1.5, 1.5), y + rnd(-1.5, 0.5), z + rnd(-1.5, 1.5), 0.4, BOLT_CORE, BOLT_HALO, dl)
      }
    }
    ctx.delay = 0
    for (const S of BURSTS.hit.parts.slice(0, 2)) { spawn(S, bx, by, bz); spawn(S, ax, ay, az) }
    pulse(0.5)
  }

  // ---- public: burst
  const burst = (name, position, opts) => {
    try {
      const o = opts && typeof opts === "object" ? opts : {}
      if (name === "lightning") { setCtx(o); return lightning(position, o) }
      const key = pickName(BURSTS, name, "hit", "burst")
      const p = readPos(position)
      const R = BURSTS[key], cx = p.x, cy = p.y, cz = p.z
      setCtx(o)
      const cm = Math.max(0.05, num(o.count, R.count) / R.count)
      for (const S of R.parts) {
        const n = S.n === 1 ? 1 : Math.max(1, Math.round(S.n * cm))
        for (let i = 0; i < n; i++) spawn(S, cx, cy, cz)
      }
      if (R.ring) {
        const c = ctx.user ? ctx.user.toArray().map((v) => v * 3) : R.ring.c
        addRing(cx, cy + 0.05, cz, R.ring.r * ctx.size, R.ring.life, c)
      }
      if (R.pulse) pulse(R.pulse * Math.min(1.5, ctx.size))
    } catch (err) { console.warn("particles.burst failed:", err) }
  }

  // ---- public: emitter
  const emitters = new Set()
  const emitter = (name, object, opts) => {
    const o = opts && typeof opts === "object" ? opts : {}
    const key = pickName(EMITTERS, name, "trail", "emitter")
    const R = EMITTERS[key]
    const em = { active: true, acc: R.parts.map(() => 0), has: false, lx: 0, ly: 0, lz: 0, object }
    const off = o.offset
    const ox = num(off?.x, 0), oy = num(off?.y, 0), oz = num(off?.z, key === "thruster" ? -0.4 : 0)
    em.update = (dt) => {
      if (!em.active) return
      setCtx(o)
      const rateMul = o.count != null ? Math.max(0, num(o.count, 1)) / R.parts[0].rate : 1
      // world position and forward axis of the followed thing
      let x, y, z
      ctx.fx = 0; ctx.fy = 0; ctx.fz = 1
      if (object?.isObject3D) {
        object.updateWorldMatrix(true, false)
        const e = object.matrixWorld.elements
        let fx = e[8], fy = e[9], fz = e[10]
        const fl = Math.hypot(fx, fy, fz) || 1
        fx /= fl; fy /= fl; fz /= fl
        const rl = Math.hypot(e[0], e[1], e[2]) || 1, ul = Math.hypot(e[4], e[5], e[6]) || 1
        x = e[12] + (e[0] / rl) * ox + (e[4] / ul) * oy + fx * oz
        y = e[13] + (e[1] / rl) * ox + (e[5] / ul) * oy + fy * oz
        z = e[14] + (e[2] / rl) * ox + (e[6] / ul) * oy + fz * oz
        ctx.fx = fx; ctx.fy = fy; ctx.fz = fz
      } else { const p = readPos(object); x = p.x + ox; y = p.y + oy; z = p.z + oz }
      if (!em.has) { em.lx = x; em.ly = y; em.lz = z; em.has = true }
      R.parts.forEach((S, i) => {
        em.acc[i] = Math.min(em.acc[i] + S.rate * rateMul * dt, 80)
        while (em.acc[i] >= 1) { // spread along the path since last frame
          em.acc[i]--
          const t = Math.random()
          spawn(S, em.lx + (x - em.lx) * t, em.ly + (y - em.ly) * t, em.lz + (z - em.lz) * t)
        }
      })
      em.lx = x; em.ly = y; em.lz = z
    }
    em.stop = () => { em.active = false; emitters.delete(em) }
    em.start = () => { em.active = true; em.has = false; emitters.add(em) }
    emitters.add(em)
    return em
  }
  // an emitter's `rate` per part lives in its recipe; opts.count scales them (1 = default, 2 = double)

  // ---- public: weather
  const weathers = new Map()
  const camDir = new THREE.Vector3()
  const makeWeather = (key, o) => {
    const W = WEATHER[key]
    const n = Math.max(10, Math.min(20000, Math.round(num(o.count, W.n))))
    const seed = new Float32Array(n * 4)
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random()
    const buf = new THREE.InstancedInterleavedBuffer(seed, 4)
    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
    geo.setIndex([0, 1, 2, 0, 2, 3])
    geo.setAttribute("aSeed", new THREE.InterleavedBufferAttribute(buf, 4, 0))
    geo.instanceCount = n
    const sizeMul = Math.max(0.01, num(o.size, 1)), speedMul = num(o.speed, 1)
    let col = W.col
    if (o.color != null) { try { tmpC.set(o.color); col = [tmpC.r * (W.add ? 4 : 1), tmpC.g * (W.add ? 4 : 1), tmpC.b * (W.add ? 4 : 1), W.col[3]] } catch {} }
    const wind = num(o.wind, 0)
    const uniforms = {
      uTime, uFade: { value: 0 }, uBox: { value: new THREE.Vector3(...W.box) }, uCenter: { value: new THREE.Vector3() },
      uVel: { value: new THREE.Vector3(W.vel[0] * speedMul + wind, W.vel[1] * speedMul, W.vel[2] * speedMul) },
      uP: { value: new THREE.Vector4(W.size * sizeMul, W.len ? W.len * sizeMul : 0, W.sway, W.pulse || 0) }, uCol: { value: new THREE.Vector4(...col) },
    }
    const mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: WEATHER_VERT, fragmentShader: WEATHER_FRAG.replace("ADDITIVE", W.add ? "true" : "false"),
      transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: W.add ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: W.add ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 10
    group.add(mesh)
    const w = { key, mesh, uniforms, fade: 0, target: 1, box: W.box }
    w.stop = () => { w.target = 0 }
    return w
  }
  const weather = (name, opts) => {
    try {
      const o = opts && typeof opts === "object" ? opts : {}
      if (name == null || name === "none" || name === false) { for (const w of weathers.values()) w.stop(); return { stop() {} } }
      const key = pickName(WEATHER, name, "dust", "weather")
      weathers.get(key)?.stop()
      const w = makeWeather(key, o)
      weathers.set(key + "#" + weathers.size + Math.random(), w)
      return w
    } catch (err) { console.warn("particles.weather failed:", err); return { stop() {} } }
  }
  const updateWeather = (dt) => {
    const cam = st.camera
    for (const [k, w] of weathers) {
      w.fade += (w.target - w.fade) * Math.min(1, dt * 2.5)
      w.uniforms.uFade.value = w.fade
      if (w.target === 0 && w.fade < 0.01) { group.remove(w.mesh); w.mesh.geometry.dispose(); w.mesh.material.dispose(); weathers.delete(k); continue }
      if (cam) {
        cam.getWorldDirection(camDir)
        let t = camDir.y < -0.1 ? Math.min(-cam.position.y / camDir.y, 40) : 22
        const cx = cam.position.x + camDir.x * t, cz = cam.position.z + camDir.z * t
        w.uniforms.uCenter.value.set(cx, w.box[1] / 2 - 0.5, cz)
      }
    }
  }

  // ---- the frame
  let clock = 0
  const update = (dt) => {
    dt = Math.min(Math.max(dt || 0, 0), 0.1)
    clock += dt
    uTime.value = clock
    for (const e of emitters) e.update(dt)
    updateWeather(dt)
    glowL.flush(); alphaL.flush()
  }
  if (typeof st.onFrame === "function") st.onFrame((dt) => update(dt))
  else {
    console.warn("createParticles: the stage has no onFrame; particles run on their own clock.")
    let last = performance.now()
    const loop = (now) => { requestAnimationFrame(loop); update((now - last) / 1000); last = now }
    requestAnimationFrame(loop)
  }

  const clear = () => {
    for (const e of [...emitters]) e.stop()
    for (const w of weathers.values()) w.stop()
    for (const L of [glowL, alphaL]) { for (let i = 0; i < L.data.length / STRIDE; i++) L.data[i * STRIDE + 3] = -1e6; L.lo = 0; L.hi = L.data.length / STRIDE - 1 }
    ringData.fill(0); for (let i = 0; i < RN; i++) ringData[i * 12 + 3] = -1e6
    ringBuf.needsUpdate = true
  }
  return { burst, emitter, weather, clear, group }
}
