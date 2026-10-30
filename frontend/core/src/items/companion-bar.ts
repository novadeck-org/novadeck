import type { ItemId } from "../items"

// A terminal's companion bar as the person arranged it: the order of what's on it, what
// they hid from it, and what its pane holds open. The pane stacks what's open as a desktop
// stacks windows: it shows the top one, and minimizing or closing that uncovers the one
// behind. The items themselves are the backend's; a bar keeps only their ids, and the
// terminal's messages, which never leave it.

export const messagesKey = "messages"

export type BarKey = ItemId | typeof messagesKey

export type Bar = {
  // What's on the bar, in the order it came or the person dragged it into.
  readonly order: readonly BarKey[]
  // Plans and the messages the person closed, which stay off the bar until they come
  // back: a plan rewritten, a message arriving.
  readonly hidden: readonly BarKey[]
  // What's open in the pane, the one it shows last: the rest wait behind it.
  readonly stack: readonly BarKey[]
  // Whether the pane is out. Hiding it keeps the stack, which comes back with it.
  readonly open: boolean
}

export const emptyBar: Bar = { order: [], hidden: [], stack: [], open: false }

// What the pane shows while it's out: the top of its stack.
export const topOf = (bar: Bar): BarKey | null => bar.stack.at(-1) ?? null

const without = (keys: readonly BarKey[], key: BarKey): readonly BarKey[] =>
  keys.includes(key) ? keys.filter((each) => each !== key) : keys

// Something came to the bar: it joins the end, unless it has a place there or the person
// hid it.
export const arrive = (bar: Bar, key: BarKey): Bar =>
  bar.order.includes(key) || bar.hidden.includes(key) ? bar : { ...bar, order: [...bar.order, key] }

// Something was moved here: last, as anything new is, and on the bar even if it was hidden.
export const arriveLast = (bar: Bar, key: BarKey): Bar =>
  bar.order.at(-1) === key && !bar.hidden.includes(key)
    ? bar
    : { ...bar, order: [...without(bar.order, key), key], hidden: without(bar.hidden, key) }

// It's no longer open in the pane: what was behind it shows, and the pane hides once
// nothing's left. Nothing opens on its own when it comes back.
const unshow = (bar: Bar, key: BarKey): Bar => {
  if (!bar.stack.includes(key)) return bar
  const stack = without(bar.stack, key)
  return { ...bar, stack, open: bar.open && stack.length > 0 }
}

// The person closed a plan or the messages from the bar: off it until they come back.
export const hide = (bar: Bar, key: BarKey): Bar =>
  bar.hidden.includes(key)
    ? unshow(bar, key)
    : unshow({ ...bar, order: without(bar.order, key), hidden: [...bar.hidden, key] }, key)

// What was hidden is back on the bar, last.
export const reopen = (bar: Bar, key: BarKey): Bar =>
  bar.hidden.includes(key)
    ? { ...bar, hidden: without(bar.hidden, key), order: [...without(bar.order, key), key] }
    : bar

// It left the bar: moved, undocked or gone.
export const leave = (bar: Bar, key: BarKey): Bar => {
  const order = without(bar.order, key)
  const hidden = without(bar.hidden, key)
  const left = order === bar.order && hidden === bar.hidden ? bar : { ...bar, order, hidden }
  return unshow(left, key)
}

// The pane comes out with it on top, from wherever it was in the stack.
export const raise = (bar: Bar, key: BarKey): Bar =>
  topOf(bar) === key && bar.open
    ? bar
    : { ...bar, stack: [...without(bar.stack, key), key], open: true }

// The person minimized it: back to the taskbar, uncovering what was behind it. One the
// stack doesn't hold, as what the pane falls back to showing, takes the pane with it.
export const minimize = (bar: Bar, key: BarKey): Bar =>
  bar.stack.includes(key) ? unshow(bar, key) : closePane(bar)

// The pane hides, keeping what's open in it for when it comes back.
export const closePane = (bar: Bar): Bar => (bar.open ? { ...bar, open: false } : bar)

// The bar's icons as `slots` group its keys, the one at `from` moved to `to`: its keys
// move along, a stack's together and in their own order. What isn't on the bar keeps its
// place.
export const moveSlot = (
  bar: Bar,
  slots: readonly (readonly BarKey[])[],
  from: number,
  to: number,
): Bar => {
  const moved = [...slots]
  const [slot] = moved.splice(from, 1)
  if (!slot || from === to) return bar
  moved.splice(to, 0, slot)
  const placed = moved.flat()
  const moving = new Set(placed)
  const all = [...bar.order, ...placed.filter((key) => !bar.order.includes(key))]
  let next = 0
  return { ...bar, order: all.map((key) => (moving.has(key) ? placed[next++]! : key)) }
}

// Only what `known` still knows: anything else leaves, and a pane left showing nothing
// closes, so it doesn't open on its own later.
export const settle = (bar: Bar, known: (key: BarKey) => boolean): Bar => {
  const order = bar.order.filter(known)
  const hidden = bar.hidden.filter(known)
  const stack = bar.stack.filter(known)
  const open = bar.open && stack.length > 0
  return order.length === bar.order.length &&
    hidden.length === bar.hidden.length &&
    stack.length === bar.stack.length &&
    open === bar.open
    ? bar
    : { order, hidden, stack, open }
}
