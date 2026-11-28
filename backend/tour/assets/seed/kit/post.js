// Post-processing, written by hand: the scene renders into a float target, a dual-filter blur
// chain (half resolution and below) makes the bloom, and one final pass adds bloom, chromatic
// aberration, ACES tone mapping, saturation, vignette and grain. Used by stage.js.
import * as THREE from "three"

const VERT = `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`

const pass = (uniforms, frag, blend) =>
  new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false,
    blending: blend ? THREE.CustomBlending : THREE.NoBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  })

// Bright-pass with a soft knee, averaged over four taps so small hot pixels don't shimmer.
const PREFILTER = `uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold; varying vec2 vUv;
vec3 knee(vec3 c){ float b = max(c.r, max(c.g, c.b)); float k = 0.35;
  float s = clamp(b - uThreshold + k, 0.0, 2.0 * k); s = s * s / (4.0 * k + 1e-4);
  return c * max(s, b - uThreshold) / max(b, 1e-4); }
void main(){
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  gl_FragColor = vec4(knee(min(c * 0.25, vec3(30.0))), 1.0);
}`

const DOWN = `uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
void main(){
  vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
  s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  s += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  gl_FragColor = vec4(s / 8.0, 1.0);
}`

// Added on top of the level above it, so every blur radius contributes to the glow.
const UP = `uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uGain; varying vec2 vUv;
void main(){
  vec2 h = uTexel * 0.5; vec3 s = vec3(0.0);
  s += texture2D(tSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb + texture2D(tSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += 2.0 * (texture2D(tSrc, vUv + vec2(-h.x, h.y)).rgb + texture2D(tSrc, vUv + vec2(h.x, h.y)).rgb
            + texture2D(tSrc, vUv + vec2(h.x, -h.y)).rgb + texture2D(tSrc, vUv + vec2(-h.x, -h.y)).rgb);
  gl_FragColor = vec4(s / 12.0 * uGain, 1.0);
}`

const COMPOSITE = `uniform sampler2D tScene; uniform sampler2D tBloom;
uniform float uBloom, uVignette, uGrain, uAberration, uSaturation, uExposure, uTime;
uniform vec4 uFlash; varying vec2 vUv;
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main(){
  vec2 d = vUv - 0.5; float r2 = dot(d, d);
  vec2 o = d * r2 * uAberration * 0.04;
  vec3 c = vec3(texture2D(tScene, vUv + o).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv - o).b);
  vec3 b = vec3(texture2D(tBloom, vUv + o).r, texture2D(tBloom, vUv).g, texture2D(tBloom, vUv - o).b);
  c += b * uBloom;
  c = mix(c, uFlash.rgb * 2.0, uFlash.a);
  c = aces(c * uExposure);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c *= 1.0 - uVignette * smoothstep(0.18, 0.62, sqrt(r2) * 1.15);
  c += (hash(vUv * 1000.0 + fract(uTime) * 91.7) - 0.5) * 0.035 * uGrain;
  gl_FragColor = vec4(max(c, 0.0), 1.0);
  #include <colorspace_fragment>
}`

export const createPost = (renderer) => {
  const settings = { bloom: 1, threshold: 0.8, vignette: 0.35, grain: 0.35, aberration: 0.5, saturation: 1.1, exposure: 1, enabled: true }
  const flash = { color: new THREE.Color(1, 1, 1), amount: 0 }
  let pulse = 0
  const sceneRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 })
  const levels = [] // bloom chain: [0] is half resolution, each next is half of the last
  for (let i = 0; i < 5; i++) {
    levels.push(new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false }))
  }

  const tex = (t) => ({ value: t })
  const texel = () => ({ value: new THREE.Vector2() })
  const uPre = { tSrc: tex(sceneRT.texture), uTexel: texel(), uThreshold: { value: 0.8 } }
  const uDown = { tSrc: tex(null), uTexel: texel() }
  const uUp = { tSrc: tex(null), uTexel: texel(), uGain: { value: 0.85 } }
  const uComp = {
    tScene: tex(sceneRT.texture), tBloom: tex(levels[0].texture), uBloom: { value: 1 }, uVignette: { value: 0 },
    uGrain: { value: 0 }, uAberration: { value: 0 }, uSaturation: { value: 1 }, uExposure: { value: 1 }, uTime: { value: 0 },
    uFlash: { value: new THREE.Vector4() },
  }
  const mats = { pre: pass(uPre, PREFILTER), down: pass(uDown, DOWN), up: pass(uUp, UP, true), comp: pass(uComp, COMPOSITE) }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  const quad = new THREE.Mesh(geo, mats.comp)
  quad.frustumCulled = false
  const quadScene = new THREE.Scene()
  quadScene.add(quad)
  const camera = new THREE.Camera()

  const run = (material, target) => {
    quad.material = material
    renderer.setRenderTarget(target)
    renderer.render(quadScene, camera)
  }

  // The bloom chain starts at half the scene's size, or a quarter on a slow renderer.
  let bloomShift = 1
  const setSize = (w, h) => {
    const bw = Math.max(2, w >> bloomShift), bh = Math.max(2, h >> bloomShift)
    sceneRT.setSize(w, h)
    levels.forEach((rt, i) => rt.setSize(Math.max(2, bw >> i), Math.max(2, bh >> i)))
  }
  // "high": 4x MSAA, bloom at half size. "low": no MSAA, bloom at a quarter: for software GL.
  const setQuality = (quality) => {
    const low = quality === "low"
    bloomShift = low ? 2 : 1
    const samples = low ? 0 : 4
    if (sceneRT.samples !== samples) {
      sceneRT.samples = samples
      sceneRT.dispose()
    }
    setSize(sceneRT.width, sceneRT.height)
  }

  const render = (scene, camera3, dt, time) => {
    pulse = Math.max(0, pulse - dt * 2.2)
    flash.amount = Math.max(0, flash.amount - dt * 3)
    if (!settings.enabled) {
      renderer.setRenderTarget(null)
      renderer.render(scene, camera3)
      return
    }
    renderer.setRenderTarget(sceneRT)
    renderer.clear()
    renderer.render(scene, camera3)

    uPre.uTexel.value.set(1 / sceneRT.width, 1 / sceneRT.height)
    uPre.uThreshold.value = settings.threshold
    run(mats.pre, levels[0])
    for (let i = 1; i < levels.length; i++) {
      uDown.tSrc.value = levels[i - 1].texture
      uDown.uTexel.value.set(1 / levels[i - 1].width, 1 / levels[i - 1].height)
      run(mats.down, levels[i])
    }
    for (let i = levels.length - 2; i >= 0; i--) {
      uUp.tSrc.value = levels[i + 1].texture
      uUp.uTexel.value.set(1 / levels[i + 1].width, 1 / levels[i + 1].height)
      run(mats.up, levels[i])
    }

    uComp.uBloom.value = settings.bloom * (1 + pulse * 3)
    uComp.uVignette.value = settings.vignette
    uComp.uGrain.value = settings.grain
    uComp.uAberration.value = settings.aberration
    uComp.uSaturation.value = settings.saturation
    uComp.uExposure.value = settings.exposure * (1 + pulse * 0.25)
    uComp.uTime.value = time
    uComp.uFlash.value.set(flash.color.r, flash.color.g, flash.color.b, flash.amount)
    run(mats.comp, null)
  }

  // post.pulse(strength): the bloom flares and fades back over about half a second.
  // post.flash(colour, amount): the screen washes towards a colour and fades.
  const api = Object.assign(settings, {
    pulse: (s = 1) => { pulse = Math.min(2, pulse + (Number.isFinite(s) ? s : 1)) },
    flash: (color = 0xffffff, amount = 0.3) => { flash.color.set(color); flash.amount = Math.min(1, amount) },
  })
  return { settings: api, render, setSize, setQuality, sceneRT }
}
