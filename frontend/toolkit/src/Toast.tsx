import {
  createToaster,
  Toast,
  Toaster,
  type CreateToasterReturn,
  type ToastOptions,
  type ToastStatusChangeDetails,
} from "@ark-ui/react/toast"
import { ChevronRight, X } from "lucide-react"
import { useEffect, useSyncExternalStore, type ReactNode } from "react"

import { createArrival, ignoresClick, moreOf } from "./toast-rules"

// A stack of toasts in the manner of Sonner, on Ark's Toast (Zag's toast machine): the newest
// in front, at rest the older ones peeking out behind it, spread into a list while the
// pointer is over them. The machine keeps the timers, their pause and each toast's life;
// the stack adds what Ark has not: a toast per key that a newer one replaces and brings to
// the front, a cap on what shows with the rest counted rather than queued (Ark's `max` holds
// extras back until room frees, and a toast that rings late is wrong), the countdown, and
// the two guards (a click as a toast lands, a pointer resting where it lands).

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
    // Holds every timer while the page is hidden, and lets them go once it is shown (unless
    // the pointer holds them).
    readonly hold: (held: boolean) => void
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
  // Whether the pointer (or focus) has paused the stack. Zag pauses and spreads on every
  // mouse event over it, one a browser sends for a pointer resting where a toast has
  // appeared included; they get through only after the pointer has really moved (see
  // `createArrival`). Spreading is asked for when the pause begins, for Zag asks for it only
  // as the pointer enters from rest, and the entering one may be the blocked.
  let engaged = false
  const gated: typeof store = {
    ...store,
    pause: (id) => {
      if (id !== undefined) return store.pause(id)
      if (!engaged) {
        if (!arrival.arrived()) return
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
  const current = new Map<string, string>()
  const listeners = new Set<() => void>()
  let snapshot: Snapshot<T> = { order, entries }
  const emit = (): void => {
    snapshot = { order, entries }
    listeners.forEach((listener) => listener())
  }
  const standing = (id: string): void => {
    order = order.filter((each) => each !== id)
    for (const [key, held] of current) if (held === id) current.delete(key)
  }
  const forget = (id: string): void => {
    standing(id)
    const next = new Map(entries)
    next.delete(id)
    entries = next
  }

  const toasts: Toasts<T> = {
    show: (key, data) => {
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
      // One that lands while the pointer holds the stack joins the pause.
      if (engaged) requestAnimationFrame(() => engaged && store.pause(id))
    },
    close: (key) => {
      const id = current.get(key)
      if (id !== undefined) store.dismiss(id)
    },
    clear: () => store.dismiss(),
    view: {
      toaster: gated,
      duration,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      snapshot: () => snapshot,
      arrival,
      hold: (held) => {
        if (held) store.pause()
        else if (!engaged) store.resume()
      },
    },
  }
  return toasts
}

const defaultMore = (count: number): string => `+${count} more`
const defaultFanned = (count: number): string => `${count} more`

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
  readonly onSelect: (data: T) => void
  readonly onMore: () => void
  readonly moreLabel?: (count: number) => string
  readonly fannedLabel?: (count: number) => string
}): React.JSX.Element => {
  const { toaster, subscribe, snapshot, arrival, duration, hold } = toasts.view
  const { order, entries } = useSyncExternalStore(subscribe, snapshot)
  const more = moreOf(order.length, shownToasts)
  useEffect(() => {
    const moved = (event: MouseEvent): void =>
      arrival.moved({ x: event.movementX, y: event.movementY })
    // Before Zag's own handlers, which are React's, at the root.
    document.addEventListener("mousemove", moved, { capture: true })
    // A hidden page holds the timers (Ark means to, but has no handler for it).
    const visibility = (): void => hold(document.hidden)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      document.removeEventListener("mousemove", moved, { capture: true })
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [arrival, hold])
  return (
    <Toaster
      toaster={toaster}
      label={label}
      aria-label={label}
      className="toasts"
      onFocusCapture={() => arrival.moved(true)}
    >
      {(toast: ToastOptions) => {
        const id = toast.id
        const entry = id === undefined ? undefined : entries.get(id)
        if (id === undefined || !entry) return null
        const rank = Math.max(0, order.indexOf(id))
        const select = (): void => {
          onSelect(entry.data)
          toasts.close(entry.key)
        }
        return (
          <Toast.Root
            className="toast floating"
            data-rank={rank}
            data-beyond={rank >= shownToasts ? "" : undefined}
            data-replaced={entry.replaced ? "" : undefined}
            style={{ "--toast-life": `${duration}ms`, "--toast-rank": rank } as React.CSSProperties}
            onClick={(event) => {
              // Its close button and pill act for themselves.
              if ((event.target as Element).closest("button")) return
              if (!ignoresClick(entry.landedAt, performance.now())) select()
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                select()
              }
            }}
          >
            {children(entry.data)}
            <Toast.CloseTrigger className="toast-close">
              <X size={13} strokeWidth={2} />
            </Toast.CloseTrigger>
            <span className="toast-countdown" aria-hidden="true" />
            {more > 0 && rank === 0 ? (
              <button
                type="button"
                className="toast-more"
                data-fan="rest"
                onClick={() => {
                  onMore()
                  toasts.clear()
                }}
              >
                {moreLabel(more)}
              </button>
            ) : null}
            {more > 0 && rank === shownToasts - 1 ? (
              <button
                type="button"
                className="toast-more"
                data-fan="fanned"
                onClick={() => {
                  onMore()
                  toasts.clear()
                }}
              >
                {fannedLabel(more)}
                <ChevronRight size={11} strokeWidth={2} />
              </button>
            ) : null}
          </Toast.Root>
        )
      }}
    </Toaster>
  )
}
