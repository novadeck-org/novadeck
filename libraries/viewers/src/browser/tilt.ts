// For fun: a phone tilts as the person drags across the stage around it, as if turned in
// the hand, and swings back flat when let go, so the page takes clicks where it shows. The
// tilt is set on the viewer as --browser-tilt-x, --browser-tilt-y and --browser-tilt-sheen,
// with data-tilting while it's dragged and data-settling while it swings back (see
// browser.css).

/**
 * How a phone tilts as the person drags across the stage around it, as if it had weight:
 * the drag sets where it's pushed toward, which gives way less the further it goes, never
 * past `tiltMaxDeg` each way; the phone follows on a heavy spring, and let go, swings back
 * flat on it. `tiltPerPx` is how far the first pixels of a drag push it.
 */
export const tiltPerPx = 0.1
export const tiltMaxDeg = 14

/** Where a drag of `by` pixels pushes a phone toward, in degrees: it stiffens as it goes. */
export const tiltToward = (by: number): number =>
  tiltMaxDeg * Math.tanh((by * tiltPerPx) / tiltMaxDeg)

// The spring a phone hangs on: heavy, so it's slow to start and to stop, and just short of
// critically damped, so it barely swings past flat. Within `restDeg` of where it's pushed,
// slower than `restSpeed` degrees a second, it rests there.
const spring = { mass: 2.2, stiffness: 70, damping: 21 }
const restDeg = 0.05
const restSpeed = 0.5
// One step of the spring from `at`, moving at `speed`, toward `to`, over `dt` seconds.
const stepOf = (
  at: number,
  speed: number,
  to: number,
  dt: number,
): { readonly at: number; readonly speed: number } => {
  const force = spring.stiffness * (to - at) - spring.damping * speed
  const next = speed + (force / spring.mass) * dt
  return { at: at + next * dt, speed: next }
}

/**
 * Tilts the phone in `root` as the person drags from a press `grabs` takes: one on the
 * stage around the phone, not on it. `stop` ends a swing under way.
 */
export const createTilt = (
  root: HTMLElement,
  grabs: (press: PointerEvent) => boolean,
): { readonly stop: () => void } => {
  // Where it's pushed toward, and where it is on its spring, each way.
  let pushed = { x: 0, y: 0 }
  let hold = { x: 0, y: 0, speedX: 0, speedY: 0 }
  let swinging: number | undefined
  let lastFrame = 0
  // The window it's drawn in, whose frames the swing goes by.
  const win = root.ownerDocument.defaultView
  const tilt = (x: number, y: number): void => {
    root.style.setProperty("--browser-tilt-x", `${Math.round(x * 100) / 100}`)
    root.style.setProperty("--browser-tilt-y", `${Math.round(y * 100) / 100}`)
    // How far it's turned, of the most it turns: what its glass catches of the light.
    const turned = Math.min(1, Math.hypot(x, y) / tiltMaxDeg)
    root.style.setProperty("--browser-tilt-sheen", `${Math.round(turned * 100) / 100}`)
  }
  const steady = (): boolean =>
    Math.abs(hold.x - pushed.x) < restDeg &&
    Math.abs(hold.y - pushed.y) < restDeg &&
    Math.abs(hold.speedX) < restSpeed &&
    Math.abs(hold.speedY) < restSpeed
  const swing = (now: number): void => {
    // A frame late, as after a while out of sight, steps as if it weren't, so it can't fly.
    const dt = Math.min(1 / 30, Math.max(0, (now - lastFrame) / 1000))
    lastFrame = now
    const x = stepOf(hold.x, hold.speedX, pushed.x, dt)
    const y = stepOf(hold.y, hold.speedY, pushed.y, dt)
    hold = { x: x.at, y: y.at, speedX: x.speed, speedY: y.speed }
    if (steady() && root.dataset.tilting === undefined) {
      hold = { x: pushed.x, y: pushed.y, speedX: 0, speedY: 0 }
      swinging = undefined
      tilt(hold.x, hold.y)
      delete root.dataset.settling
      return
    }
    tilt(hold.x, hold.y)
    swinging = win?.requestAnimationFrame(swing)
  }
  // Reduced motion, it goes where it's pushed at once, without the swing.
  const calm = (): boolean => win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  const push = (x: number, y: number): void => {
    pushed = { x, y }
    if (calm() || !win) {
      hold = { x, y, speedX: 0, speedY: 0 }
      tilt(x, y)
      if (root.dataset.tilting === undefined) delete root.dataset.settling
      return
    }
    if (swinging !== undefined) return
    lastFrame = win.performance.now()
    swinging = win.requestAnimationFrame(swing)
  }
  const turning = (event: PointerEvent): void => {
    if (event.target !== root || event.button !== 0 || !grabs(event)) return
    event.preventDefault()
    const { pointerId, clientX: fromX, clientY: fromY } = event
    try {
      root.setPointerCapture(pointerId)
    } catch {
      // A pointer the browser doesn't know, as one a test makes: it tilts all the same.
    }
    delete root.dataset.settling
    root.dataset.tilting = ""
    const turn = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return
      // Its release never came, as when another window took the pointer mid-drag: let go.
      if (move.buttons === 0) return letGo(move)
      push(tiltToward(fromY - move.clientY), tiltToward(move.clientX - fromX))
    }
    const letGo = (end: PointerEvent): void => {
      if (end.pointerId !== pointerId) return
      root.removeEventListener("pointermove", turn)
      root.removeEventListener("pointerup", letGo)
      root.removeEventListener("pointercancel", letGo)
      root.removeEventListener("lostpointercapture", letGo)
      delete root.dataset.tilting
      root.dataset.settling = ""
      push(0, 0)
    }
    root.addEventListener("pointermove", turn)
    root.addEventListener("pointerup", letGo)
    root.addEventListener("pointercancel", letGo)
    root.addEventListener("lostpointercapture", letGo)
  }
  root.addEventListener("pointerdown", turning)
  return {
    stop: () => {
      if (swinging !== undefined) win?.cancelAnimationFrame(swinging)
    },
  }
}
