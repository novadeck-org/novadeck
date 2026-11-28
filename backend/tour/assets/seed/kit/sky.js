// The sky: one shader on a big sphere that rides along with the camera. A gradient, twinkling
// stars, a sun or moon disc with glow, and optional aurora and drifting clouds. It animates
// itself while it is on a rendered scene.
import * as THREE from "three"
import { getLook } from "./looks.js"

const VERT = `varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

const FRAG = `
uniform vec3 uTop, uHorizon, uLight, uAccent, uAccent2, uSunDir;
uniform float uTime, uStars, uAurora, uClouds, uSun, uMoon;
varying vec3 vDir;
float hash(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
float hash3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }

vec3 starLayer(vec3 d, float scale, float t){
  vec3 p = d * scale, ip = floor(p), fp = fract(p) - 0.5;
  float r = hash3(ip);
  if (r < 0.9) return vec3(0.0);
  vec3 off = (vec3(hash3(ip + 3.1), hash3(ip + 7.7), hash3(ip + 1.3)) - 0.5) * 0.55;
  float dist = length(fp - off);
  float tw = 0.65 + 0.35 * sin(t * (1.5 + r * 4.0) + r * 60.0);
  float s = smoothstep(0.11, 0.0, dist) * tw;
  vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), hash3(ip + 9.9));
  return tint * s * (1.0 + (r - 0.9) * 40.0);
}

void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  float up = pow(clamp(h, 0.0, 1.0), 0.5);
  vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.95, up));
  col += uHorizon * 0.5 * exp(-abs(h) * 7.0);               // glow hugging the horizon
  col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.35, h)); // below it, the world fades down

  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  float gl = uMoon > 0.5 ? 0.35 : 1.0;
  col += uLight * (pow(sd, 6.0) * 0.12 + pow(sd, 48.0) * 0.22) * gl;

  float vis = smoothstep(-0.02, 0.25, h);
  if (uStars > 0.5){
    vec3 st = starLayer(d, 70.0, uTime) + starLayer(d, 150.0, uTime * 1.3) * 0.7;
    col += st * vis;
  }

  if (uAurora > 0.5 && h > 0.0){
    vec2 q = d.xz / (h + 0.35) * 0.55;
    float w = q.y + 0.9 - 0.35 * sin(q.x * 1.3 + uTime * 0.12) - 0.18 * sin(q.x * 2.9 - uTime * 0.17);
    float rays = 0.45 + 0.55 * noise(vec2(q.x * 14.0 + uTime * 0.2, q.y * 1.5));
    float a = exp(-w * w * 5.0) * (0.35 + 0.65 * noise(vec2(q.x * 2.0 + uTime * 0.05, 3.0))) * rays;
    vec3 ac = mix(uAccent2, uAccent, smoothstep(-0.5, 0.6, w));
    col += ac * a * 1.9 * smoothstep(0.02, 0.3, h);
  }

  if (uSun > 0.5 || uMoon > 0.5){
    float r = uMoon > 0.5 ? 0.038 : 0.045;
    float disc = smoothstep(cos(r * 1.04), cos(r * 0.96), sd);
    float edge = acos(clamp(sd, 0.0, 1.0)) / r;
    float shade = uMoon > 0.5 ? 0.78 + 0.35 * fbm(vec2(d.x, d.y) * 70.0) - 0.2 * edge * edge : 1.0;
    col = mix(col, uLight * (uMoon > 0.5 ? 0.85 : 6.0) * shade, disc);
  }

  if (uClouds > 0.5 && h > -0.02){
    vec2 uv = d.xz / (h + 0.12) * 0.55 + vec2(uTime * 0.012, uTime * 0.004);
    float n = fbm(uv * 1.3);
    float cover = smoothstep(0.54, 0.86, n) * smoothstep(0.0, 0.16, h);
    vec2 sdir = normalize(uSunDir.xz + 1e-4) * 0.09;
    float lit = clamp((n - fbm(uv * 1.3 + sdir)) * 7.0 + 0.55, 0.0, 1.0);
    vec3 cc = mix(uHorizon * 0.65 + uTop * 0.25, uLight * 1.25 + 0.15, lit);
    col = mix(col, cc, cover * 0.92);
  }
  gl_FragColor = vec4(col, 1.0);
}`

export const createSky = (options = {}) => {
  const o = options && typeof options === "object" ? options : {}
  const look = getLook(o.look, "createSky")
  const night = !!look.night
  const flag = (v, fallback) => (v == null ? fallback : v ? 1 : 0)
  const uniforms = {
    uTop: { value: new THREE.Color(look.sky) }, uHorizon: { value: new THREE.Color(look.horizon) },
    uLight: { value: new THREE.Color(look.light) }, uAccent: { value: new THREE.Color(look.accent) },
    uAccent2: { value: new THREE.Color(look.accent2) }, uSunDir: { value: new THREE.Vector3(...look.sun).normalize() },
    uTime: { value: 0 }, uStars: { value: flag(o.stars, night ? 1 : 0) }, uAurora: { value: flag(o.aurora, 0) },
    uClouds: { value: flag(o.clouds, night ? 0 : 1) },
    uSun: { value: o.sun === false ? 0 : night ? 0 : 1 }, uMoon: { value: o.sun === false ? 0 : night ? 1 : 0 },
  }
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  })
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), material)
  sky.renderOrder = -1000
  sky.frustumCulled = false
  sky.name = "sky"
  sky.onBeforeRender = (renderer, scene, camera) => {
    sky.position.copy(camera.position)
    uniforms.uTime.value = performance.now() / 1000
  }
  sky.uniforms = uniforms
  return sky
}
