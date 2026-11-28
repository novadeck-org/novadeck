// input.js — keyboard, mouse, touch and gamepad as one set of actions.
//   const input = createInput(stage)
//   input.move            // { x, y }, length <= 1. x: right is +1. y: up/forward is -1 (screen
//                         // convention: W, up arrow, stick up and a touch-stick push up all give -1)
//   input.aim             // THREE.Vector3: the ground point under the pointer
//   input.held("fire"), input.pressed("jump") (true for one frame), input.on("fire", fn)
//   input.bind("build", ["KeyB"])
import * as THREE from "three"

const warn = (...a) => console.warn("[kit/input]", ...a)
const DEFAULTS = {
  fire: { keys: ["Space"], mouse: [0], pad: [0, 7] },
  alt: { keys: ["KeyE"], mouse: [2], pad: [6] },
  jump: { keys: ["Space"], pad: [0] },
  dash: { keys: ["ShiftLeft", "ShiftRight"], pad: [1, 5] },
  use: { keys: ["KeyE"], pad: [2] },
  pause: { keys: ["Escape"], pad: [9] },
}
const MOVE_KEYS = { KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] }
const SCROLL_KEYS = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])
const TOUCH_BUTTONS = { jump: "Jump", dash: "Dash", use: "Use", alt: "Alt" }

// "b" / "B" / "KeyB" / "Space" / "Mouse1" / "Pad3" -> one binding entry
function parseKey(k, into) {
  if (typeof k === "number") { into.pad.push(k); return }
  if (typeof k !== "string" || !k) return
  let m
  if ((m = /^mouse(\d)$/i.exec(k))) into.mouse.push(+m[1])
  else if ((m = /^pad(\d+)$/i.exec(k))) into.pad.push(+m[1])
  else if (k.length === 1 && /[a-z]/i.test(k)) into.keys.push("Key" + k.toUpperCase())
  else if (k.length === 1 && /\d/.test(k)) into.keys.push("Digit" + k)
  else if (k === " ") into.keys.push("Space")
  else if (/^shift$/i.test(k)) into.keys.push("ShiftLeft", "ShiftRight")
  else if (/^(ctrl|control)$/i.test(k)) into.keys.push("ControlLeft", "ControlRight")
  else if (/^(esc|escape)$/i.test(k)) into.keys.push("Escape")
  else into.keys.push(k)
}

const isTextField = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)

const CSS = `
.kit-touch{position:fixed;inset:0;z-index:15;pointer-events:none;touch-action:none;-webkit-user-select:none;user-select:none}
.kit-touch .base{position:absolute;width:130px;height:130px;margin:-65px 0 0 -65px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.04),rgba(255,255,255,.14));border:2px solid rgba(255,255,255,.3);backdrop-filter:blur(6px);transition:opacity .25s;opacity:.55}
.kit-touch .knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.75),rgba(255,255,255,.3));box-shadow:0 4px 14px rgba(0,0,0,.4);transition:transform .08s}
.kit-touch .base.on{opacity:1}
.kit-touch .btn{position:absolute;pointer-events:auto;touch-action:none;width:68px;height:68px;border-radius:50%;border:2px solid rgba(255,255,255,.4);background:rgba(255,255,255,.14);backdrop-filter:blur(6px);color:#fff;font:700 12px/68px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;text-align:center;opacity:.7}
.kit-touch .btn.on{background:rgba(255,255,255,.4);opacity:1}
`

export function createInput(stage, options = {}) {
  const bindings = new Map(), listeners = new Map()
  for (const [name, b] of Object.entries(DEFAULTS)) bindings.set(name, { keys: [...b.keys], mouse: [...(b.mouse || [])], pad: [...(b.pad || [])] })

  const keysDown = new Set(), mouseDown = new Set(), virtual = new Set()
  let padDown = new Set(), padMove = { x: 0, y: 0 }
  let pendingPressed = new Set(), pressedNow = new Set()
  const prevHeld = new Map() // action -> held at the last check, for edge detection
  const move = { x: 0, y: 0 }
  const aim = new THREE.Vector3()
  const pointer = { x: 0, y: 0, seen: false }
  const touchMove = { x: 0, y: 0 }
  const cleanups = []
  const listen = (target, ev, fn, opt) => { target.addEventListener(ev, fn, opt); cleanups.push(() => target.removeEventListener(ev, fn, opt)) }

  const heldRaw = (name) => {
    const b = bindings.get(name)
    if (!b) return false
    return b.keys.some((k) => keysDown.has(k)) || b.mouse.some((m) => mouseDown.has(m)) || b.pad.some((p) => padDown.has(p)) || virtual.has(name)
  }
  // an action just went down: remember it for `pressed` and tell `on` listeners
  const fire = (name) => {
    pendingPressed.add(name)
    for (const fn of [...(listeners.get(name) || [])]) try { fn() } catch (e) { console.error(e) }
  }
  const sync = () => { // after any state change: find actions that just became held
    for (const name of bindings.keys()) {
      const h = heldRaw(name), was = prevHeld.get(name) || false
      prevHeld.set(name, h)
      if (h && !was) fire(name)
    }
  }

  function updateMove() {
    let x = 0, y = 0
    for (const [k, v] of Object.entries(MOVE_KEYS)) if (keysDown.has(k)) { x += v[0]; y += v[1] }
    x += padMove.x + touchMove.x; y += padMove.y + touchMove.y
    const len = Math.hypot(x, y)
    if (len > 1) { x /= len; y /= len }
    move.x = x; move.y = y
  }

  // ----- keyboard -----
  listen(window, "keydown", (e) => {
    if (isTextField(e.target)) return
    const bound = MOVE_KEYS[e.code] || [...bindings.values()].some((b) => b.keys.includes(e.code))
    if (bound && SCROLL_KEYS.has(e.code)) e.preventDefault()
    if (e.repeat) return
    keysDown.add(e.code); updateMove(); sync()
  })
  listen(window, "keyup", (e) => { keysDown.delete(e.code); updateMove(); sync() })
  listen(window, "blur", () => { keysDown.clear(); mouseDown.clear(); updateMove(); sync() })

  // ----- pointer -----
  const target = stage?.renderer?.domElement || document.getElementById("game") || window
  if (target !== window) { target.style.touchAction = "none"; listen(target, "contextmenu", (e) => e.preventDefault()) }
  const point = (e) => {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.seen = true
  }
  listen(window, "pointermove", point)
  listen(target, "pointerdown", (e) => {
    point(e)
    if (e.pointerType === "touch" && e.clientX < innerWidth * 0.45) return // that side drives the touch stick
    mouseDown.add(e.button); sync(); updateAim()
  })
  listen(window, "pointerup", (e) => { mouseDown.delete(e.button); sync() })
  listen(window, "pointercancel", (e) => { mouseDown.delete(e.button); sync() })

  function updateAim() {
    if (!pointer.seen || !stage?.screenToGround) return
    try {
      const p = stage.screenToGround(pointer.x, pointer.y)
      if (p && Number.isFinite(p.x)) aim.set(p.x, p.y ?? 0, p.z ?? 0)
    } catch (e) { /* the stage is not ready yet */ }
  }

  // ----- gamepad -----
  function pollPad() {
    const pads = navigator.getGamepads?.() || []
    const gp = [...pads].find((g) => g && g.connected)
    if (!gp) { if (padDown.size || padMove.x || padMove.y) { padDown = new Set(); padMove = { x: 0, y: 0 } } return }
    const down = new Set()
    gp.buttons.forEach((b, i) => { if (b.pressed || b.value > 0.5) down.add(i) })
    padDown = down
    let x = gp.axes[0] || 0, y = gp.axes[1] || 0
    const len = Math.hypot(x, y), dead = 0.18
    if (len < dead) { x = 0; y = 0 } else { const k = (Math.min(1, len) - dead) / (1 - dead) / len; x *= k; y *= k }
    if (down.has(14)) x -= 1; if (down.has(15)) x += 1; if (down.has(12)) y -= 1; if (down.has(13)) y += 1
    padMove = { x, y }
  }

  // ----- touch stick and buttons -----
  const touchy = options.touch ?? (typeof matchMedia === "function" && (matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints || 0) > 0))
  let touchRoot = null, stickBase = null, stickKnob = null
  const buttons = new Map()
  if (touchy) {
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st)
    touchRoot = document.createElement("div"); touchRoot.className = "kit-touch"
    stickBase = document.createElement("div"); stickBase.className = "base"
    stickKnob = document.createElement("div"); stickKnob.className = "knob"
    stickBase.append(stickKnob); touchRoot.append(stickBase); document.body.append(touchRoot)
    const home = () => { stickBase.style.left = "110px"; stickBase.style.top = innerHeight - 120 + "px"; stickBase.classList.remove("on"); stickKnob.style.transform = "" }
    let stickId = null, cx = 0, cy = 0
    home(); listen(window, "resize", () => { if (stickId == null) home() })
    const R = 55
    const drive = (e) => {
      const dx = e.clientX - cx, dy = e.clientY - cy, len = Math.hypot(dx, dy) || 1, k = Math.min(1, len / R)
      touchMove.x = (dx / len) * k; touchMove.y = (dy / len) * k
      stickKnob.style.transform = `translate(${touchMove.x * R}px,${touchMove.y * R}px)`; updateMove()
    }
    listen(target === window ? document : target, "pointerdown", (e) => {
      if (e.pointerType !== "touch" || stickId != null || e.clientX >= innerWidth * 0.45) return
      stickId = e.pointerId; cx = e.clientX; cy = e.clientY
      stickBase.style.left = cx + "px"; stickBase.style.top = cy + "px"; stickBase.classList.add("on"); drive(e)
    })
    listen(window, "pointermove", (e) => { if (e.pointerId === stickId) drive(e) })
    const release = (e) => { if (e.pointerId !== stickId) return; stickId = null; touchMove.x = touchMove.y = 0; home(); updateMove() }
    listen(window, "pointerup", release); listen(window, "pointercancel", release)
  }
  // a round touch button appears the first time the game asks about that action
  function touchButton(name) {
    if (!touchy || buttons.has(name) || !TOUCH_BUTTONS[name]) return
    const b = document.createElement("div"); b.className = "btn"; b.textContent = TOUCH_BUTTONS[name]
    const i = buttons.size
    b.style.right = 20 + (i % 2) * 80 + "px"; b.style.bottom = 28 + Math.floor(i / 2) * 80 + (i % 2 ? 0 : 56) + "px"
    b.addEventListener("pointerdown", (e) => { e.stopPropagation(); virtual.add(name); b.classList.add("on"); sync() })
    const up = () => { virtual.delete(name); b.classList.remove("on"); sync() }
    b.addEventListener("pointerup", up); b.addEventListener("pointercancel", up); b.addEventListener("pointerleave", up)
    touchRoot.append(b); buttons.set(name, b)
  }

  // ----- the frame: gamepad, aim, and the one-frame `pressed` window -----
  const frame = () => {
    pollPad(); updateMove(); sync(); updateAim()
    pressedNow = pendingPressed; pendingPressed = new Set()
  }
  let off = null, raf = 0
  if (typeof stage?.onFrame === "function") off = stage.onFrame(frame)
  else { const loop = () => { frame(); raf = requestAnimationFrame(loop) }; raf = requestAnimationFrame(loop) }

  const known = (name, who) => {
    if (bindings.has(name)) { touchButton(name); return true }
    warn(`${who}("${name}"): no such action (use ${[...bindings.keys()].join(", ")}, or bind one first).`)
    return false
  }
  const api = {
    move,
    aim,
    pointer,
    held: (name) => known(name, "held") && heldRaw(name),
    pressed: (name) => known(name, "pressed") && pressedNow.has(name),
    on(name, fn) {
      if (typeof fn !== "function" || !known(name, "on")) return () => {}
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name)?.delete(fn)
    },
    bind(name, keys = []) {
      if (typeof name !== "string" || !name) { warn("bind: give the action a name."); return api }
      const b = { keys: [], mouse: [], pad: [] }
      for (const k of Array.isArray(keys) ? keys : [keys]) parseKey(k, b)
      bindings.set(name, b); prevHeld.set(name, heldRaw(name))
      return api
    },
    dispose() { off?.(); cancelAnimationFrame(raf); cleanups.forEach((f) => f()); touchRoot?.remove() },
  }
  return api
}
