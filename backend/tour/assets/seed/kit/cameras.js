// The camera rig: orbit, follow, top, side, first and fixed, all with damped motion, written
// by hand (no OrbitControls). Used by stage.js; stage.cam holds the live state to tweak:
//   cam.target (orbit centre), cam.yaw, cam.pitch, cam.distance, cam.height, cam.lag, cam.object
import * as THREE from "three"

const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const FOV = { orbit: 55, follow: 60, top: 45, side: 42, first: 78, fixed: 55 }
export const CAMERA_MODES = Object.keys(FOV)

export const createCameraRig = (camera, dom, mode = "orbit") => {
  if (!FOV[mode]) {
    console.warn(`createStage: unknown camera "${mode}" (use ${CAMERA_MODES.join(", ")}); using "orbit".`)
    mode = "orbit"
  }
  const cam = {
    mode, object: null, target: new THREE.Vector3(0, 1, 0), yaw: 0.6, pitch: 0.42, distance: 18, height: 9, lag: 0.12,
    locked: false,
  }
  const shown = { yaw: cam.yaw, pitch: cam.pitch, distance: cam.distance, target: cam.target.clone() }
  const want = new THREE.Vector3(), look = new THREE.Vector3(), lookNow = new THREE.Vector3(0, 1, 0)
  const heading = new THREE.Vector2(0, -1), lastObj = new THREE.Vector3()
  let haveLast = false

  const defaults = (m) => {
    cam.mode = m
    camera.fov = FOV[m]
    camera.updateProjectionMatrix()
    if (m === "orbit") Object.assign(cam, { distance: 18, pitch: 0.42, yaw: 0.6 })
    if (m === "follow") Object.assign(cam, { distance: 14, height: 9 })
    if (m === "top") Object.assign(cam, { distance: 24, height: 24 })
    if (m === "side") Object.assign(cam, { distance: 20, height: 3 })
    if (m === "first") Object.assign(cam, { yaw: 0, pitch: 0, height: 1.7 })
    if (m === "fixed" && camera.position.lengthSq() < 1e-6) camera.position.set(0, 9, 18)
    if (m === "fixed") camera.lookAt(0, 1, 0)
    camera.rotation.order = m === "first" ? "YXZ" : "XYZ"
    shown.yaw = cam.yaw; shown.pitch = cam.pitch; shown.distance = cam.distance
    shown.target.copy(cam.target)
    haveLast = false
  }

  // Pointer input: drag to turn, wheel or pinch to zoom, right-drag or shift-drag to pan.
  const pointers = new Map()
  let pinch = 0
  const onDown = (e) => {
    if (cam.mode !== "orbit" && cam.mode !== "first") return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try { dom.setPointerCapture(e.pointerId) } catch {}
    pinch = 0
  }
  const onMove = (e) => {
    const p = pointers.get(e.pointerId)
    if (cam.mode === "first" && (cam.locked || p)) {
      const dx = cam.locked ? e.movementX : e.clientX - p.x, dy = cam.locked ? e.movementY : e.clientY - p.y
      cam.yaw -= dx * 0.0032
      cam.pitch = clamp(cam.pitch - dy * 0.0032, -1.5, 1.5)
    } else if (cam.mode === "orbit" && p) {
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinch) cam.distance = clamp(cam.distance * (pinch / d), 2, 160)
        pinch = d
      } else if (e.buttons & 2 || e.shiftKey) {
        const k = cam.distance * 0.0016
        cam.target.x -= (Math.cos(cam.yaw) * (e.clientX - p.x) + Math.sin(cam.yaw) * (e.clientY - p.y)) * k
        cam.target.z -= (-Math.sin(cam.yaw) * (e.clientX - p.x) + Math.cos(cam.yaw) * (e.clientY - p.y)) * k
      } else {
        cam.yaw -= (e.clientX - p.x) * 0.006
        cam.pitch = clamp(cam.pitch + (e.clientY - p.y) * 0.005, 0.04, 1.5)
      }
    }
    if (p) { p.x = e.clientX; p.y = e.clientY }
  }
  const onUp = (e) => { pointers.delete(e.pointerId); pinch = 0 }
  const onWheel = (e) => {
    if (cam.mode !== "orbit") return
    e.preventDefault()
    cam.distance = clamp(cam.distance * Math.exp(e.deltaY * 0.001), 2, 160)
  }
  dom.addEventListener("pointerdown", onDown)
  dom.addEventListener("pointermove", onMove)
  dom.addEventListener("pointerup", onUp)
  dom.addEventListener("pointercancel", onUp)
  dom.addEventListener("wheel", onWheel, { passive: false })
  dom.addEventListener("contextmenu", (e) => cam.mode === "orbit" && e.preventDefault())
  document.addEventListener("pointerlockchange", () => { cam.locked = document.pointerLockElement === dom })

  // Where followed objects head: the camera sits behind their recent movement, whichever way
  // the model faces (and stays put while they stand still).
  const updateHeading = (pos, dt) => {
    if (haveLast && dt > 0) {
      const dx = pos.x - lastObj.x, dz = pos.z - lastObj.z
      if (dx * dx + dz * dz > (0.4 * dt) ** 2) {
        const l = Math.hypot(dx, dz)
        heading.set(damp(heading.x, dx / l, 4, dt), damp(heading.y, dz / l, 4, dt)).normalize()
      }
    }
    lastObj.copy(pos)
    haveLast = true
  }

  const update = (dt) => {
    const k = 1 / Math.max(cam.lag, 0.01)
    const obj = cam.object
    if (obj) { obj.updateWorldMatrix(true, false); look.setFromMatrixPosition(obj.matrixWorld) }
    else look.copy(cam.target)
    if (obj && cam.mode !== "orbit") updateHeading(look, dt)
    const m = cam.mode

    if (m === "orbit") {
      if (obj) cam.target.copy(look)
      shown.yaw = damp(shown.yaw, cam.yaw, 12, dt)
      shown.pitch = damp(shown.pitch, cam.pitch, 12, dt)
      shown.distance = damp(shown.distance, cam.distance, 9, dt)
      shown.target.set(damp(shown.target.x, cam.target.x, 8, dt), damp(shown.target.y, cam.target.y, 8, dt), damp(shown.target.z, cam.target.z, 8, dt))
      const cp = Math.cos(shown.pitch)
      camera.position.set(
        shown.target.x + Math.sin(shown.yaw) * cp * shown.distance,
        shown.target.y + Math.sin(shown.pitch) * shown.distance,
        shown.target.z + Math.cos(shown.yaw) * cp * shown.distance,
      )
      camera.lookAt(shown.target)
    } else if (m === "follow") {
      want.set(look.x - heading.x * cam.distance, look.y + cam.height, look.z - heading.y * cam.distance)
      camera.position.set(damp(camera.position.x, want.x, k, dt), damp(camera.position.y, want.y, k, dt), damp(camera.position.z, want.z, k, dt))
      lookNow.set(damp(lookNow.x, look.x, k * 1.5, dt), damp(lookNow.y, look.y + 1, k * 1.5, dt), damp(lookNow.z, look.z, k * 1.5, dt))
      camera.lookAt(lookNow)
    } else if (m === "top") {
      want.set(look.x, cam.height, look.z + cam.height * 0.38)
      camera.position.set(damp(camera.position.x, want.x, k, dt), damp(camera.position.y, want.y, k, dt), damp(camera.position.z, want.z, k, dt))
      lookNow.set(camera.position.x, 0, camera.position.z - cam.height * 0.38)
      camera.lookAt(lookNow)
    } else if (m === "side") {
      want.set(look.x, look.y + cam.height, look.z + cam.distance)
      camera.position.set(damp(camera.position.x, want.x, k, dt), damp(camera.position.y, want.y, k, dt), damp(camera.position.z, want.z, k, dt))
      lookNow.set(camera.position.x, camera.position.y - cam.height * 0.4, look.z)
      camera.lookAt(lookNow)
    } else if (m === "first") {
      if (obj) camera.position.set(look.x, look.y + cam.height, look.z)
      else if (camera.position.y < 0.5) camera.position.set(0, cam.height, 6)
      camera.rotation.set(cam.pitch, cam.yaw, 0)
    }
  }

  return { cam, update, setMode: (m) => (FOV[m] ? defaults(m) : console.warn(`stage: unknown camera "${m}"`)), init: () => defaults(mode) }
}
