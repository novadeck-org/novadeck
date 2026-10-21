import { useShown } from "@novadeck/toolkit/shown"
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type PointerEvent,
} from "react"

// Whether what the pane shows is awake: the person is at it, or was a moment ago. Asleep,
// a pane may draw what costs to draw live as a still of itself, as a page shows a picture
// in its view's place; each pane's view decides what asleep means for it, and most draw
// the same either way. Outside a pane, as in an undocked window, it's always awake.
//
// It wakes as the pointer settles on it (moving, then staying a moment, not just passing
// over it on the way elsewhere), and at once on a press, a wheel, a key or focus inside
// it; `wake` wakes it too, as when an agent shows it again. Once the person has left it,
// pointer and focus, for a while, it sleeps; kept out of sight, at once.
export type Awake = {
  readonly awake: boolean
  /** Whether it ever sleeps: never outside a pane, so nothing there keeps a still ready. */
  readonly sleeps: boolean
  /** Wakes it for a while, as the person would; nothing while it's out of sight. */
  readonly wake: () => void
}

export const AwakeContext = createContext<Awake>({ awake: true, sleeps: false, wake: () => {} })

export const useAwake = (): Awake => useContext(AwakeContext)

/** How long the pointer stays on it, having moved there, before it wakes. */
export const settleMs = 400
/** How long it stays awake once the person has left it. */
export const graceMs = 20_000
/**
 * How long, once it shows, a pointer moving over it is taken for the view moving under
 * the pointer, as it slides in, not the person's.
 */
export const arrivingMs = 250

type Handlers = {
  readonly onPointerMove: (event: PointerEvent) => void
  readonly onPointerLeave: () => void
  readonly onPointerDown: () => void
  readonly onWheel: () => void
  readonly onKeyDown: () => void
  readonly onFocus: () => void
  readonly onBlur: (event: FocusEvent) => void
}

type Wakeful = {
  readonly awake: () => boolean
  readonly subscribe: (listener: () => void) => () => void
  readonly wake: () => void
  readonly show: (shown: boolean) => void
  readonly attach: (element: HTMLElement | null) => void
  readonly on: Handlers
  readonly stop: () => void
}

const createWakeful = (): Wakeful => {
  let awake = false
  let shown = true
  let shownAt = performance.now()
  let element: HTMLElement | null = null
  let settling: ReturnType<typeof setTimeout> | undefined
  let grace: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const set = (next: boolean): void => {
    if (next === awake) return
    awake = next
    for (const listener of listeners) listener()
  }
  const stop = (): void => {
    clearTimeout(settling)
    clearTimeout(grace)
    settling = undefined
  }
  // Still at it, pointer over it or focus in it: a while more, else asleep.
  const linger = (): void => {
    clearTimeout(grace)
    grace = setTimeout(() => {
      const at =
        element !== null &&
        (element.matches(":hover") || element.contains(element.ownerDocument.activeElement))
      if (at) linger()
      else set(false)
    }, graceMs)
  }
  // The person gone from it, pointer or focus: its while starts from now, not from when it
  // woke, which would let it sleep the moment they leave after staying long.
  const leave = (): void => {
    if (awake) linger()
  }
  const wake = (): void => {
    if (!shown) return
    set(true)
    linger()
  }
  return {
    awake: () => awake,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    wake,
    show: (next) => {
      if (next === shown) return
      shown = next
      if (shown) shownAt = performance.now()
      else {
        stop()
        set(false)
      }
    },
    attach: (next) => {
      element = next
    },
    on: {
      onPointerMove: (event) => {
        // A touch or pen has no hover: its press wakes it.
        if (event.pointerType !== "mouse" || settling !== undefined) return
        // The page moving under a still pointer, as it slides in, isn't the person's.
        if (event.movementX === 0 && event.movementY === 0) return
        if (performance.now() - shownAt < arrivingMs) return
        settling = setTimeout(() => {
          settling = undefined
          wake()
        }, settleMs)
      },
      onPointerLeave: () => {
        clearTimeout(settling)
        settling = undefined
        leave()
      },
      onPointerDown: wake,
      onWheel: wake,
      onKeyDown: wake,
      onFocus: wake,
      onBlur: (event) => {
        const to = event.relatedTarget
        if (!(to instanceof Node && element?.contains(to))) leave()
      },
    },
    stop,
  }
}

/**
 * The pane's awake state, for `AwakeContext`, from what the person does in the element
 * `ref` is given, which `on`'s handlers go on.
 */
export const useWakeful = (): {
  readonly awake: Awake
  readonly ref: (element: HTMLElement | null) => void
  readonly on: Handlers
} => {
  const shown = useShown()
  const [wakeful] = useState(createWakeful)
  const awake = useSyncExternalStore(wakeful.subscribe, wakeful.awake)
  // Before what it shows hears of it in their effects, so a view waking as it shows is.
  useLayoutEffect(() => wakeful.show(shown), [wakeful, shown])
  useEffect(() => wakeful.stop, [wakeful])
  const state = useMemo(() => ({ awake, sleeps: true, wake: wakeful.wake }), [awake, wakeful])
  return { awake: state, ref: wakeful.attach, on: wakeful.on }
}
