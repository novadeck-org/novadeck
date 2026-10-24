import {
  createToaster,
  Toast,
  Toaster,
  type CreateToasterReturn,
  type ToastOptions,
  type ToastStatusChangeDetails,
} from "@ark-ui/react/toast"
import { ChevronRight, X } from "lucide-react"
import { useEffect, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react"

import { createArrival, ignoresClick, moreOf } from "./toast-rules"

// A stack of toasts in the manner of Sonner, on Ark's Toast (Zag's toast machine): the newest
// in front, at rest the older ones peeking out behind it, spread into a list while the
// pointer is over them. The machine keeps the timers, their pause and each toast's life;
// the stack adds what Ark has not: a toast per key that a newer one replaces and brings to
// the front, a cap on what shows with the rest counted rather than queued (Ark's `max` holds
// extras back until room frees; here they stand hidden, their timers running, and come into
// view as the front ones leave, so none rings late), the countdown, and the guards (a click
// as a toast lands or moves under the pointer, a pointer resting where a toast lands, focus
// kept where it was).

// How many toasts show; any more are counted in a pill.
export const shownToasts = 3

type Entry<T> = {
  readonly key: string
  readonly data: T
  // When it landed, for the click guard.
  readonly landedAt: number
  // Whether it took the place of its key's older toast, and so doesn't slide in.
  readonly replaced: boolean
}

type Snapshot<T> = {
  // The ids of the toasts standing, newest first.
  readonly order: readonly string[]
  // The toasts to draw, those leaving included.
  readonly entries: ReadonlyMap<string, Entry<T>>
  // Where a toast that is leaving stood, so it fades out as it was.
  readonly left: ReadonlyMap<string, number>
  // When each last took another place, which may put it under the pointer.
  readonly moved: ReadonlyMap<string, number>
}

export type Toasts<T> = {
  // Shows `data` as the toast of `key`, replacing its older one, in front.
  readonly show: (key: string, data: T) => void
  // Takes the toast of `key` away.
  readonly close: (key: string) => void
  // Takes every toast away.
  readonly clear: () => void
  // What `ToastRegion` draws from.
  readonly view: {
    readonly toaster: CreateToasterReturn
    readonly duration: number
    readonly subscribe: (listener: () => void) => () => void
    readonly snapshot: () => Snapshot<T>
    readonly arrival: ReturnType<typeof createArrival>
    // The element holding the stack, to ask whether the pointer or focus is on it.
    readonly region: { current: HTMLElement | null }
    readonly attach: (element: HTMLElement | null) => void
    // Whether the pointer is on the pill that counts the rest, which it may press where it
    // stands: that pill doesn't spread the stack as the pointer reaches it.
    readonly pill: { readonly enter: () => void; readonly leave: () => void }
    // Holds every timer while the page is hidden, and lets them go once it is shown (unless
    // the pointer holds them).
    readonly hold: (held: boolean) => void
    // Where focus was before it came into the stack, to give back.
    readonly focus: {
      // Focus came into / went out of the stack: it pauses and spreads it as the pointer does.
      readonly into: () => void
      readonly out: () => void
      readonly enter: (from: EventTarget | null) => void
      readonly leave: (to: EventTarget | null) => void
      readonly restore: () => void
      // Gives focus back if the toast that had it is gone.
      readonly recover: () => void
    }
  }
}

// Every toast leaves after `duration` ms, its timer paused while the pointer is over the
// stack or the page is hidden.
export const createToasts = <T,>({ duration = 8000 }: { duration?: number } = {}): Toasts<T> => {
  const store = createToaster({
    placement: "top-end",
    overlap: true,
    // Ark holds back what is past `max`; the stack shows what it can and counts the rest.
    max: Number.MAX_SAFE_INTEGER,
    gap: 8,
    removeDelay: 250,
    duration,
    // Alt+T is the terminal's (readline transposes words), and Ark's hotkey focuses the
    // stack; four modifiers are not typed by chance.
    hotkey: ["altKey", "ctrlKey", "metaKey", "shiftKey", "KeyT"],
    // Where it sits is the CSS's (--toast-top, --toast-right).
    offsets: {
      top: "var(--toast-top, 7px)",
      right: "var(--toast-right, 12px)",
      left: "0px",
      bottom: "0px",
    },
  })
  const arrival = createArrival()
  const region: { current: HTMLElement | null } = { current: null }
  let overPill = false
  // Whether the stack is really under the pointer or holds focus.
  const onStack = (): boolean => {
    try {
      return region.current?.matches(":hover, :focus-within") ?? false
    } catch {
      return false
    }
  }
  // Whether the pointer (or focus) has paused the stack. Zag pauses and spreads on every
  // mouse event over it, one a browser sends for a pointer resting where a toast has
  // appeared included; they get through only after the pointer has really moved (see
  // `createArrival`). Spreading is asked for when the pause begins, for Zag asks for it only
  // as the pointer enters from rest, and the entering one may be the blocked.
  let engaged = false
  const release = (): void => {
    if (!engaged) return
    engaged = false
    overPill = false
    arrival.reset()
    store.resume()
  }
  // The pause and the spread end once nothing holds the stack, neither the pointer nor focus.
  const settle = (): void => {
    if (!engaged || onStack()) return
    release()
    store.collapse()
  }
  const gated: typeof store = {
    ...store,
    pause: (id) => {
      if (id !== undefined) return store.pause(id)
      if (!engaged) {
        if (overPill || !arrival.arrived()) return
        engaged = true
        store.expand()
      }
      store.pause()
    },
    expand: () => {
      if (engaged) store.expand()
    },
    resume: (id) => {
      if (id !== undefined) return store.resume(id)
      engaged = false
      arrival.reset()
      store.resume()
    },
  }

  let serial = 0
  let order: readonly string[] = []
  let entries: ReadonlyMap<string, Entry<T>> = new Map()
  let left: ReadonlyMap<string, number> = new Map()
  const current = new Map<string, string>()
  const listeners = new Set<() => void>()
  let moved: ReadonlyMap<string, number> = new Map()
  let snapshot: Snapshot<T> = { order, entries, left, moved }
  const emit = (): void => {
    const places = new Map(moved)
    for (const [rank, id] of order.entries())
      if (snapshot.order.indexOf(id) !== rank) places.set(id, performance.now())
    moved = places
    snapshot = { order, entries, left, moved }
    // A toast closed or clicked away from under the pointer sends no leave, and the stack
    // that empties is no longer held.
    if (order.length === 0) release()
    // The pill that counts the rest is gone once there is nothing to count, and sends no
    // leave as it goes.
    if (order.length <= shownToasts) overPill = false
    listeners.forEach((listener) => listener())
  }
  const standing = (id: string): void => {
    const rank = order.indexOf(id)
    if (rank >= 0) left = new Map(left).set(id, rank)
    order = order.filter((each) => each !== id)
    for (const [key, standingId] of current) if (standingId === id) current.delete(key)
  }
  const forget = (id: string): void => {
    standing(id)
    const next = new Map(entries)
    next.delete(id)
    entries = next
    const gone = new Map(left)
    gone.delete(id)
    left = gone
    const placed = new Map(moved)
    placed.delete(id)
    moved = placed
  }

  // Focus, kept where it was: a toast is no place to leave it.
  let returnTo: HTMLElement | null = null
  let inside = false
  const focus: Toasts<T>["view"]["focus"] = {
    into: () => {
      if (engaged) return
      engaged = true
      store.expand()
      store.pause()
    },
    out: () => {
      // Once focus has settled: it may only have moved from one toast to its button.
      requestAnimationFrame(settle)
    },
    enter: (from) => {
      if (inside) return
      inside = true
      returnTo =
        from instanceof HTMLElement && !region.current?.contains(from) && from !== document.body
          ? from
          : null
    },
    leave: (to) => {
      if (!(to instanceof Element) || region.current?.contains(to)) return
      // Focus went somewhere on purpose: it is not ours to take back.
      inside = false
      returnTo = null
    },
    restore: () => {
      const active = document.activeElement
      const here = !active || active === document.body || region.current?.contains(active)
      inside = false
      if (here && returnTo?.isConnected) returnTo.focus({ preventScroll: true })
      returnTo = null
      settle()
    },
    recover: () => {
      if (inside && document.activeElement === document.body) focus.restore()
      // A toast removed with focus on it sends no blur.
      else settle()
    },
  }

  const toasts: Toasts<T> = {
    show: (key, data) => {
      // One that lands as the pointer is no longer on the stack doesn't join its pause.
      if (engaged && !onStack()) release()
      const previous = current.get(key)
      if (previous !== undefined) {
        // It leaves as the new one lands. (`remove` would skip Ark's cleanup of its height.)
        store.dismiss(previous)
        standing(previous)
      }
      const id = `${key}#${++serial}`
      arrival.reset()
      entries = new Map(entries).set(id, {
        key,
        data,
        landedAt: performance.now(),
        replaced: previous !== undefined,
      })
      order = [id, ...order]
      current.set(key, id)
      emit()
      store.create({
        id,
        onStatusChange: ({ status }: ToastStatusChangeDetails) => {
          if (status === "visible") return
          standing(id)
          if (status === "unmounted") forget(id)
          emit()
        },
      })
      // One that lands while the pointer holds the stack joins the spread list and the pause.
      if (engaged) {
        store.expand()
        requestAnimationFrame(() => engaged && store.pause(id))
      }
    },
    close: (key) => {
      const id = current.get(key)
      if (id !== undefined) store.dismiss(id)
    },
    clear: () => {
      overPill = false
      store.dismiss()
    },
    view: {
      toaster: gated,
      duration,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      snapshot: () => snapshot,
      arrival,
      region,
      attach: (element) => {
        region.current = element
      },
      pill: {
        enter: () => {
          overPill = true
        },
        leave: () => {
          overPill = false
        },
      },
      hold: (hold) => {
        if (hold) store.pause()
        else if (!engaged) store.resume()
      },
      focus,
    },
  }
  return toasts
}

// Tells whoever reads the event next that its focus came from, or went to, nothing.
const unrelated = (event: FocusEvent): void => {
  Object.defineProperty(event, "relatedTarget", { value: null })
}

const defaultMore = (count: number): string => `+${count} more`
const defaultFanned = (count: number): string => `${count} more`

type ItemProps<T> = {
  readonly entry: Entry<T>
  readonly rank: number
  // When it last took another place in the stack.
  readonly movedAt: number
  readonly more: number
  readonly toasts: Toasts<T>
  readonly children: (data: T) => ReactNode
  readonly onSelect: (data: T, via: { readonly keyboard: boolean }) => void
  readonly onMore: () => void
  readonly moreLabel: (count: number) => string
  readonly fannedLabel: (count: number) => string
}

// One toast: Ark's root with the caller's content, its close button, countdown and pills.
const ToastItem = <T,>({
  entry,
  rank,
  movedAt,
  more,
  toasts,
  children,
  onSelect,
  onMore,
  moreLabel,
  fannedLabel,
}: ItemProps<T>): React.JSX.Element => {
  const { duration, focus, pill, region } = toasts.view
  // A toast that goes with focus on it gives it back, once it is gone.
  useLayoutEffect(
    () => () => {
      if (region.current?.contains(document.activeElement)) queueMicrotask(focus.recover)
    },
    [focus, region],
  )
  // What `onSelect` takes the person to takes focus itself; the toast gives none back.
  const select = (keyboard: boolean): void => {
    onSelect(entry.data, { keyboard })
    toasts.close(entry.key)
  }
  const pressed = (): void => {
    onMore()
    toasts.clear()
  }
  return (
    <Toast.Root
      className="toast floating"
      role="group"
      aria-atomic="false"
      data-rank={rank}
      data-beyond={rank >= shownToasts ? "" : undefined}
      data-replaced={entry.replaced ? "" : undefined}
      style={{ "--toast-life": `${duration}ms`, "--toast-rank": rank } as React.CSSProperties}
      // A pointer press takes no focus from where the person is typing.
      onMouseDown={(event) => event.preventDefault()}
      onClickCapture={(event) => {
        const target = event.target as Element
        // One that is leaving, its ghost layer, or one a moment old at its place does nothing,
        // whatever it was aimed at.
        if (
          event.currentTarget.getAttribute("data-state") !== "open" ||
          target.closest("[data-ghost]") ||
          ignoresClick(Math.max(entry.landedAt, movedAt), performance.now())
        ) {
          event.stopPropagation()
          event.preventDefault()
        }
      }}
      onClick={(event) => {
        // Its close button and pills act for themselves.
        if ((event.target as Element).closest("button")) return
        select(event.detail === 0)
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") queueMicrotask(focus.restore)
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          select(true)
        }
      }}
    >
      {children(entry.data)}
      <Toast.CloseTrigger
        className="toast-close"
        onClick={(event) => {
          if (event.detail === 0) focus.restore()
        }}
      >
        <X size={13} strokeWidth={2} />
      </Toast.CloseTrigger>
      <span className="toast-countdown" aria-hidden="true" />
      {more > 0 && rank === 0 ? (
        <button
          type="button"
          className="toast-more"
          data-fan="rest"
          onPointerEnter={pill.enter}
          onPointerLeave={pill.leave}
          onClick={pressed}
        >
          {moreLabel(more)}
        </button>
      ) : null}
      {more > 0 && rank === shownToasts - 1 ? (
        <button type="button" className="toast-more" data-fan="fanned" onClick={pressed}>
          {fannedLabel(more)}
          <ChevronRight size={11} strokeWidth={2} />
        </button>
      ) : null}
    </Toast.Root>
  )
}

// The stack's place and look are the toast recipe's (toast.css). `children` draws one
// toast's content; a click on a toast (after the guard) or Enter on it calls `onSelect` and
// takes it away; the pill that counts the rest calls `onMore`.
export const ToastRegion = <T,>({
  toasts,
  label,
  children,
  onSelect,
  onMore,
  moreLabel = defaultMore,
  fannedLabel = defaultFanned,
}: {
  readonly toasts: Toasts<T>
  // What a screen reader calls the region.
  readonly label: string
  readonly children: (data: T) => ReactNode
  // `via.keyboard` says it was chosen with a key.
  readonly onSelect: (data: T, via: { readonly keyboard: boolean }) => void
  readonly onMore: () => void
  readonly moreLabel?: (count: number) => string
  readonly fannedLabel?: (count: number) => string
}): React.JSX.Element => {
  const { toaster, subscribe, snapshot, arrival, hold, attach, focus } = toasts.view
  const { order, entries, left, moved } = useSyncExternalStore(subscribe, snapshot)
  const more = moreOf(order.length, shownToasts)
  useEffect(() => {
    const travel = (event: MouseEvent): void =>
      arrival.moved({ x: event.movementX, y: event.movementY })
    // Before Zag's own handlers, which are React's, at the root.
    document.addEventListener("mousemove", travel, { capture: true })
    // A hidden page holds the timers (Ark means to, but has no handler for it).
    const visibility = (): void => hold(document.hidden)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      document.removeEventListener("mousemove", travel, { capture: true })
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [arrival, hold])
  return (
    <div className="toast-layer" ref={(element) => attach(element)}>
      <Toaster
        toaster={toaster}
        label={label}
        aria-label={label}
        // Each toast is announced once as it arrives, not again as its text changes.
        aria-relevant="additions"
        className="toasts"
        // Focus is the stack's own to follow: Zag takes it back to where it came from when
        // it leaves, even for another field the person chose. Its handlers, which React builds
        // from the native event once these have run, are told nothing came from anywhere;
        // the page's own listeners still hear the event.
        onFocusCapture={(event) => {
          focus.enter(event.relatedTarget)
          focus.into()
          unrelated(event.nativeEvent)
        }}
        onBlurCapture={(event) => {
          focus.leave(event.relatedTarget)
          focus.out()
          unrelated(event.nativeEvent)
        }}
      >
        {(toast: ToastOptions) => {
          const id = toast.id
          const entry = id === undefined ? undefined : entries.get(id)
          if (id === undefined || !entry) return null
          const at = order.indexOf(id)
          return (
            <ToastItem
              entry={entry}
              rank={at >= 0 ? at : (left.get(id) ?? 0)}
              movedAt={moved.get(id) ?? entry.landedAt}
              more={more}
              toasts={toasts}
              onSelect={onSelect}
              onMore={onMore}
              moreLabel={moreLabel}
              fannedLabel={fannedLabel}
            >
              {children}
            </ToastItem>
          )
        }}
      </Toaster>
    </div>
  )
}
