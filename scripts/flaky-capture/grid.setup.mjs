import { afterEach, beforeEach } from "vitest"
import { commands } from "vitest/browser"

let index = 0
let events = []
let name = ""
let began = 0
let total = 0
let remove = () => {}
const state = (value) =>
  value && {
    from: value.from,
    undocks: value.undocks,
    over: value.over,
    onBar: value.onBar,
    place: value.place,
  }
const point = (event) => {
  const x = "clientX" in event ? event.clientX : undefined
  const y = "clientY" in event ? event.clientY : undefined
  return {
    native: event.type,
    pointer: event instanceof PointerEvent,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
    button: event.button,
    buttons: event.buttons,
    isTrusted: event.isTrusted,
    target:
      event.target instanceof Element
        ? {
            tag: event.target.tagName,
            class: event.target.getAttribute("class"),
            terminal: event.target.getAttribute("data-terminal"),
            slot: event.target.getAttribute("data-slot"),
          }
        : null,
    x,
    y,
    hits:
      typeof x === "number" && typeof y === "number"
        ? document.elementsFromPoint(x, y).map((el) => ({
            tag: el.tagName,
            class: el.getAttribute("class"),
            terminal: el.getAttribute("data-terminal"),
            slot: el.getAttribute("data-slot"),
          }))
        : [],
  }
}
beforeEach((context) => {
  index += 1
  const names = [context.task.name]
  for (let suite = context.task.suite; suite; suite = suite.suite) names.unshift(suite.name)
  name = names.join(" > ")
  began = performance.now()
  events = []
  total = 0
  let targetView
  const record = (type, value) => {
    total += 1
    events.push({ ms: Math.round(performance.now() - began), type, value })
    if (events.length > 200) events.shift()
  }
  const pointer = (event) => {
    if (event.type === "pointermove" && event instanceof PointerEvent && !event.buttons) return
    record(event.type, { ...point(event), view: targetView?.getBoundingClientRect().toJSON() })
  }
  const planned = (event) => {
    const { view, at, windows } = event.detail
    targetView = view
    const box = view.getBoundingClientRect()
    record("planned", {
      at,
      view: box.toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
      windows: windows.map((each) => each.toJSON()),
      ...point(new MouseEvent("planned", { clientX: box.left + at.x, clientY: box.top + at.y })),
    })
  }
  const dropped = (event) => {
    const { nativeEvent, before, after, ...detail } = event.detail
    record("app-drop", {
      ...detail,
      release: nativeEvent && point(nativeEvent),
      before: state(before),
      after: state(after),
    })
  }
  for (const type of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "gotpointercapture",
    "lostpointercapture",
  ])
    window.addEventListener(type, pointer, true)
  window.addEventListener("novadeck:test-bar-drop", dropped)
  window.addEventListener("novadeck:test-bar-drag-target", planned)
  remove = () => {
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
      "gotpointercapture",
      "lostpointercapture",
    ])
      window.removeEventListener(type, pointer, true)
    window.removeEventListener("novadeck:test-bar-drop", dropped)
    window.removeEventListener("novadeck:test-bar-drag-target", planned)
  }
})
afterEach(async () => {
  remove()
  await commands.gridCapture({ index, name, events, total, dropped: total - events.length })
})
