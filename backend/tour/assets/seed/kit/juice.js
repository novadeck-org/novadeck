// Juice: what makes a hit feel like a hit.
// createJuice(stage) → { shake, hitstop, flash, slowmo, punch, tween, float, time }.
// Hitstop and slowmo scale stage.timeScale, so every stage.onFrame callback sees the slower dt.
// Shake moves the stage's camera through stage.cameraOffset / cameraRoll.
import * as THREE from "three"

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const bounceOut = (t) => (t < 1 / 2.75 ? 7.5625 * t * t : t < 2 / 2.75 ? 7.5625 * (t -= 1.5 / 2.75) * t + 0.75 : t < 2.5 / 2.75 ? 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375 : 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375)
export const eases = {
  linear: (t) => t,
  quadIn: (t) => t * t,
  quadOut: (t) => 1 - (1 - t) * (1 - t),
  quadInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  cubicOut: (t) => 1 - Math.pow(1 - t, 3),
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  backOut: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  elasticOut: (t) => (t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  bounceOut,
}
const css = (c) => { try { return "#" + new THREE.Color(c).getHexString() } catch { return "#ffffff" } }
const readPos = (v, out) => {
  if (v?.isObject3D) { v.updateWorldMatrix(true, false); return out.setFromMatrixPosition(v.matrixWorld) }
  return out.set(num(v?.x, 0), num(v?.y, 0), num(v?.z, 0))
}

export const createJuice = (stage) => {
  const st = stage && typeof stage === "object" ? stage : {}
  const juice = { time: 0 }
  let warnedEase = false

  // ---- clocks: real time for hitstop/slowmo/flash, game time (scaled) for tweens, punches, floats
  let hold = 0, slow = null, trauma = 0
  let realLast = performance.now()
  const tweens = [], punches = new Map(), floats = [], pool = []
  const flashes = []

  // ---- DOM layers
  const layer = document.createElement("div")
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:30;overflow:hidden"
  const flashEl = document.createElement("div")
  flashEl.style.cssText = "position:absolute;inset:0;opacity:0;will-change:opacity"
  layer.append(flashEl)
  const mount = () => (document.body || document.documentElement).append(layer)
  if (document.body) mount(); else addEventListener("DOMContentLoaded", mount)

  // ---- shake
  juice.shake = (amount = 0.5) => { trauma = Math.min(1, Math.max(trauma, clamp(num(amount, 0.5), 0, 1))) }
  const right = new THREE.Vector3(), up = new THREE.Vector3()
  const applyShake = (real) => {
    trauma = Math.max(0, trauma - real * 1.6)
    if (!st.cameraOffset) return
    const k = trauma * trauma, t = performance.now() / 1000
    if (st.camera) { st.camera.updateMatrixWorld(); right.setFromMatrixColumn(st.camera.matrixWorld, 0); up.setFromMatrixColumn(st.camera.matrixWorld, 1) }
    const nx = Math.sin(t * 53) + Math.sin(t * 91 + 1.3) * 0.6, ny = Math.sin(t * 61 + 2.1) + Math.sin(t * 83 + 0.4) * 0.6
    st.cameraOffset.set(0, 0, 0).addScaledVector(right, nx * k * 0.5).addScaledVector(up, ny * k * 0.5)
    if ("cameraRoll" in st) st.cameraRoll = (Math.sin(t * 47 + 0.7) + Math.sin(t * 71)) * 0.5 * k * 0.05
  }

  // ---- hitstop, slowmo
  juice.hitstop = (seconds = 0.08) => { hold = Math.max(hold, clamp(num(seconds, 0.08), 0, 1)) }
  juice.slowmo = (scale = 0.3, duration = 1.5) => { slow = { scale: clamp(num(scale, 0.3), 0.02, 1), left: Math.max(0, num(duration, 1.5)), total: Math.max(0.01, num(duration, 1.5)) } }

  // ---- flash
  juice.flash = (color = 0xffffff, duration = 0.3, strength = 0.6) => {
    flashEl.style.background = css(color)
    flashes.length = 0
    flashes.push({ left: Math.max(0.02, num(duration, 0.3)), total: Math.max(0.02, num(duration, 0.3)), peak: clamp(num(strength, 0.6), 0, 1) })
    try { st.post?.pulse?.(0.25) } catch {}
  }

  // ---- tween: numbers, and nested objects such as position/scale/color
  const collect = (target, props, out) => {
    for (const k of Object.keys(props || {})) {
      const to = props[k], from = target?.[k]
      if (typeof to === "number" && typeof from === "number") out.push({ o: target, k, a: from, b: to })
      else if (from?.isColor) { const c = new THREE.Color(to); out.push({ color: from, a: from.clone(), b: c }) }
      else if (to && typeof to === "object" && from && typeof from === "object") collect(from, to, out)
    }
    return out
  }
  juice.tween = (target, props, opts = {}) => {
    const o = opts && typeof opts === "object" ? opts : {}
    let ease = typeof o.ease === "function" ? o.ease : eases[o.ease ?? "quadOut"]
    if (!ease) { if (!warnedEase) { warnedEase = true; console.warn(`juice.tween: unknown ease "${o.ease}" (use ${Object.keys(eases).join(", ")}); using quadOut.`) } ease = eases.quadOut }
    let resolve
    const p = new Promise((r) => (resolve = r))
    let items = []
    try { items = collect(target, props, []) } catch {}
    const tw = { items, ease, t: -Math.max(0, num(o.delay, 0)), dur: Math.max(0.0001, num(o.duration, 0.4)), onUpdate: o.onUpdate, resolve, done: false }
    if (!items.length) { resolve(); tw.done = true } else tweens.push(tw)
    p.cancel = () => { tw.done = true; resolve() }
    return p
  }
  const stepTween = (tw, dt) => {
    tw.t += dt
    if (tw.t < 0) return
    const f = clamp(tw.t / tw.dur, 0, 1), e = tw.ease(f)
    for (const it of tw.items) {
      if (it.color) it.color.copy(it.a).lerp(it.b, e)
      else it.o[it.k] = it.a + (it.b - it.a) * e
    }
    try { tw.onUpdate?.(f) } catch {}
    if (f >= 1) { tw.done = true; tw.resolve() }
  }

  // ---- punch: a damped spring on the scale, squashing wider as it stretches taller
  juice.punch = (object, amount = 1.3, duration = 0.5) => {
    if (!object?.scale) return
    const prev = punches.get(object)
    punches.set(object, { base: prev ? prev.base : object.scale.clone(), amp: num(amount, 1.3) - 1, t: 0, dur: Math.max(0.1, num(duration, 0.5)) })
  }
  const stepPunch = (object, p, dt) => {
    p.t += dt
    const f = p.t / p.dur
    if (f >= 1) { object.scale.copy(p.base); punches.delete(object); return }
    const s = Math.exp(-6 * f * 1.6) * Math.cos(f * 22) * p.amp
    object.scale.set(p.base.x * (1 - s * 0.45), p.base.y * (1 + s), p.base.z * (1 - s * 0.45))
  }

  // ---- floating numbers (DOM, positioned with stage.worldToScreen)
  const v3 = new THREE.Vector3()
  juice.float = (text = "+1", position, opts = {}) => {
    const o = opts && typeof opts === "object" ? opts : {}
    const el = pool.pop() || document.createElement("div")
    el.textContent = String(text)
    const size = num(o.size, 30)
    el.style.cssText = `position:absolute;left:0;top:0;font:900 ${size}px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:${css(o.color ?? 0xffffff)};` +
      `text-shadow:0 2px 0 rgba(0,0,0,.55),0 0 14px ${css(o.color ?? 0xffffff)}88;white-space:nowrap;will-change:transform,opacity;letter-spacing:.02em`
    layer.append(el)
    const f = { el, pos: readPos(position, new THREE.Vector3()).clone(), t: 0, dur: Math.max(0.2, num(o.duration, 0.9)), rise: num(o.rise, 1.4), drift: (Math.random() - 0.5) * 30 }
    floats.push(f)
    while (floats.length > 48) { const old = floats.shift(); old.el.remove(); pool.push(old.el) }
  }
  const stepFloat = (f, dt) => {
    f.t += dt
    const k = f.t / f.dur
    if (k >= 1) { f.el.remove(); pool.push(f.el); return true }
    v3.copy(f.pos); v3.y += f.rise * (1 - Math.pow(1 - k, 2))
    let x = innerWidth / 2, y = innerHeight / 2, visible = true
    try { const s = st.worldToScreen?.(v3); if (s) { x = s.x; y = s.y; visible = s.visible !== false } } catch {}
    const pop = k < 0.15 ? eases.backOut(k / 0.15) : 1
    f.el.style.transform = `translate(${x + f.drift * k}px,${y}px) translate(-50%,-50%) scale(${(0.4 + 0.6 * pop) * (1 + 0.1 * k)})`
    f.el.style.opacity = visible ? String(k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4) : "0"
    return false
  }

  // ---- the tick: runs first each frame, so the time scale it sets reaches every later callback
  const tick = (dt) => {
    const now = performance.now(), real = Math.min((now - realLast) / 1000, 0.1)
    realLast = now
    let scale = 1
    if (slow) { slow.left -= real; const r = slow.left / slow.total; scale = slow.left <= 0 ? 1 : r < 0.25 ? slow.scale + (1 - slow.scale) * eases.quadOut(1 - r / 0.25) : slow.scale; if (slow.left <= 0) slow = null }
    if (hold > 0) { hold -= real; scale = 0 }
    st.timeScale = scale
    juice.time += dt
    for (let i = tweens.length - 1; i >= 0; i--) { stepTween(tweens[i], dt); if (tweens[i].done) tweens.splice(i, 1) }
    for (const [obj, p] of punches) stepPunch(obj, p, dt)
    for (let i = floats.length - 1; i >= 0; i--) if (stepFloat(floats[i], dt)) floats.splice(i, 1)
    applyShake(real)
    const fl = flashes[0]
    if (fl) { fl.left -= real; const k = Math.max(0, fl.left / fl.total); flashEl.style.opacity = String(fl.peak * k * k); if (fl.left <= 0) { flashes.length = 0; flashEl.style.opacity = "0" } }
  }
  if (typeof st.onFrame === "function") st.onFrame(tick)
  else {
    console.warn("createJuice: the stage has no onFrame; juice runs on its own clock.")
    let last = performance.now()
    const loop = (now) => { requestAnimationFrame(loop); tick(Math.min((now - last) / 1000, 0.05) * (st.timeScale ?? 1)); last = now }
    requestAnimationFrame(loop)
  }
  return juice
}
