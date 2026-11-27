// The stage: renderer, scene, camera, lights with soft shadows, and the post-processing.
// createStage({ look, camera, parent }) → { scene, camera, renderer, sun, post, cam, ... }.
// Extra hooks other kit parts use: stage.timeScale (multiplies dt, 0 = frozen), stage.time,
// stage.cameraOffset / stage.cameraRoll (shake), stage.setLook(name).
import * as THREE from "three"
import { getLook } from "./looks.js"
import { createPost } from "./post.js"
import { createCameraRig } from "./cameras.js"

export const createStage = (options = {}) => {
  const opts = options && typeof options === "object" ? options : {}
  let look = getLook(opts.look, "createStage")
  const parent = opts.parent || document.getElementById("game") || document.body

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", stencil: false })
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.toneMapping = THREE.NoToneMapping // the post pass tone-maps
  renderer.autoClear = false
  const canvas = renderer.domElement
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none"
  parent.append(canvas)

  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(look.fog, look.fogDensity)
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1200)
  camera.position.set(0, 9, 18)
  const rig = createCameraRig(camera, canvas, opts.camera || "orbit")
  rig.init()
  const { cam } = rig

  // Lights: the sun (soft shadows that follow the camera's target) and a sky/ground fill.
  const sun = new THREE.DirectionalLight(look.light, look.sunPower)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 140 })
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.04
  sun.shadow.radius = 3.5
  sun.shadow.blurSamples = 12
  const fill = new THREE.HemisphereLight(look.sky, look.ground, 1)
  const rimLight = new THREE.DirectionalLight(look.accent2, 0.9) // a coloured kicker from behind
  scene.add(sun, sun.target, fill, rimLight)
  const sunDir = new THREE.Vector3()

  const post = createPost(renderer)

  // Quality: "high" on a real GPU; "low" (pixel ratio 1, no MSAA, smaller bloom and shadows) on
  // a software renderer, or once frames run slow, so the game stays playable everywhere.
  const softwareGL = (() => {
    try {
      const gl = renderer.getContext()
      const info = gl.getExtension("WEBGL_debug_renderer_info")
      const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
      return /swiftshader|llvmpipe|software|basic render/i.test(name)
    } catch {
      return false
    }
  })()
  let quality = "high"
  const stage = {
    scene, camera, renderer, sun, fill, post: post.settings, cam, canvas, look,
    time: 0, timeScale: 1, cameraOffset: new THREE.Vector3(), cameraRoll: 0, running: true,
  }

  stage.setQuality = (q) => {
    quality = q === "low" ? "low" : "high"
    stage.quality = quality
    sun.shadow.mapSize.setScalar(quality === "low" ? 1024 : 2048)
    sun.shadow.map?.dispose()
    sun.shadow.map = null
    post.setQuality(quality)
    resize()
  }

  stage.setLook = (name) => {
    look = stage.look = getLook(name, "stage.setLook")
    scene.fog.color.set(look.fog)
    scene.fog.density = look.fogDensity
    renderer.setClearColor(look.fog, 1)
    sun.color.set(look.light)
    sun.intensity = look.sunPower
    sunDir.set(...look.sun).normalize()
    fill.color.set(look.sky).lerp(new THREE.Color(look.horizon), 0.5)
    fill.groundColor.set(look.ground).lerp(new THREE.Color(look.shadow), 0.5)
    fill.intensity = look.night ? 0.9 : 1.5
    rimLight.color.set(look.accent2)
    rimLight.intensity = look.night ? 1.0 : 0.35
    Object.assign(post.settings, { bloom: look.bloom, exposure: look.exposure, saturation: look.saturation })
    return stage
  }
  stage.setLook(look)

  stage.setCamera = (mode) => rig.setMode(mode)
  stage.follow = (object, o = {}) => {
    cam.object = object || null
    if (o && typeof o === "object") {
      if (o.distance != null) cam.distance = o.distance
      if (o.height != null) cam.height = o.height
      if (o.lag != null) cam.lag = o.lag
    }
    return stage
  }

  // The frame loop. Callbacks get (dt, time); a callback that throws is logged, not fatal.
  const callbacks = []
  stage.onFrame = (fn) => {
    if (typeof fn !== "function") return () => {}
    const entry = { fn, errors: 0 }
    callbacks.push(entry)
    return () => { const i = callbacks.indexOf(entry); if (i >= 0) callbacks.splice(i, 1) }
  }

  const size = new THREE.Vector2()
  const resize = () => {
    const w = Math.max(2, parent.clientWidth || innerWidth), h = Math.max(2, parent.clientHeight || innerHeight)
    // A software renderer draws on the CPU: half resolution keeps it responsive.
    const pr = quality === "low" ? (softwareGL ? 0.5 : 1) : Math.min(devicePixelRatio || 1, 2)
    renderer.setPixelRatio(pr)
    renderer.setSize(w, h, false)
    renderer.getDrawingBufferSize(size)
    post.setSize(size.x, size.y)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(parent)
  addEventListener("resize", resize)
  resize()
  stage.quality = quality
  if (softwareGL) stage.setQuality("low")

  // Steps down to "low" by itself when frames run slow (over 40 ms on average for 2 seconds).
  let slowFor = 0
  const lastShake = new THREE.Vector3()
  let last = performance.now(), frame = 0, lastRoll = 0
  const tick = (now) => {
    requestAnimationFrame(tick)
    if (document.hidden) { last = now; return }
    const spent = (now - last) / 1000
    const real = Math.min(spent, 0.05)
    last = now
    if (quality === "high" && spent < 1) {
      slowFor = spent > 0.04 ? slowFor + spent : Math.max(0, slowFor - spent)
      if (slowFor > 2) stage.setQuality("low")
    }
    const dt = real * stage.timeScale
    stage.time += dt
    for (const e of callbacks.slice()) {
      try { e.fn(dt, stage.time) } catch (err) {
        if (e.errors++ < 3) console.error("onFrame callback threw:", err)
      }
    }
    camera.position.sub(lastShake)
    rig.update(real) // the camera keeps moving during hitstop
    lastShake.copy(stage.cameraOffset)
    camera.position.add(lastShake)
    camera.rotateZ(stage.cameraRoll - lastRoll)
    lastRoll = stage.cameraRoll
    // the sun's shadow box rides along with what the camera looks at, snapped to texels
    const t = cam.mode === "orbit" ? cam.target : cam.object ? cam.object.position : cam.target
    const texel = 64 / 2048
    sun.target.position.set(Math.round(t.x / texel) * texel, 0, Math.round(t.z / texel) * texel)
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 60)
    rimLight.position.set(-sunDir.x * 30 + sun.target.position.x, 14, -sunDir.z * 30 + sun.target.position.z)
    post.render(scene, camera, real, stage.time)
    frame++
  }
  requestAnimationFrame(tick)
  stage.frames = () => frame

  // Aiming and clicking. Both work in CSS pixels, relative to the page.
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), hit = new THREE.Vector3()
  const pointer = { x: innerWidth / 2, y: innerHeight / 2 }
  addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY })
  stage.screenToGround = (x = pointer.x, y = pointer.y, height = 0) => {
    const r = canvas.getBoundingClientRect()
    ndc.set(((x - r.left) / (r.width || 1)) * 2 - 1, -((y - r.top) / (r.height || 1)) * 2 + 1)
    camera.updateMatrixWorld()
    ray.setFromCamera(ndc, camera)
    const { origin, direction } = ray.ray
    const s = direction.y < -1e-4 ? (height - origin.y) / direction.y : 300 // a ray into the sky lands far away
    return hit.copy(origin).addScaledVector(direction, Math.min(s, 300)).setY(height).clone()
  }
  const proj = new THREE.Vector3()
  stage.worldToScreen = (v) => {
    const r = canvas.getBoundingClientRect()
    proj.set(v?.x || 0, v?.y || 0, v?.z || 0).project(camera)
    return { x: r.left + (proj.x * 0.5 + 0.5) * r.width, y: r.top + (-proj.y * 0.5 + 0.5) * r.height, visible: proj.z > -1 && proj.z < 1 }
  }
  stage.lockPointer = () => { try { canvas.requestPointerLock?.() } catch {} }

  return stage
}
