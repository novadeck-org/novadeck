import "./notices.css"
import { useSyncExternalStore } from "react"

import { createStore } from "../../../model/store"
import type { Notice } from "../../port"
import type { DemoStates } from "./types"

// How long a notification stays, unless clicked.
export const noticeMs = 6000

// The browser's stand-in for desktop notifications: `show` puts one on the page, a newer
// one for the same id taking the place of the older, and a click on one tells the
// listeners its id.
export const createDemoNotices = (): {
  readonly notices: DemoStates["notices"]
  readonly Notices: DemoStates["Notices"]
} => {
  const shown = createStore<readonly Notice[]>([])
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const listeners = new Set<(terminalId: string) => void>()
  const dismiss = (id: string): void => {
    clearTimeout(timers.get(id))
    timers.delete(id)
    shown.update((list) => list.filter((notice) => notice.id !== id))
  }
  const notices: DemoStates["notices"] = {
    show: (notice) => {
      clearTimeout(timers.get(notice.id))
      timers.set(
        notice.id,
        setTimeout(() => dismiss(notice.id), noticeMs),
      )
      shown.update((list) =>
        list.some((each) => each.id === notice.id)
          ? list.map((each) => (each.id === notice.id ? notice : each))
          : [...list, notice],
      )
    },
    onClick: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
  const Notices = (): React.JSX.Element => {
    const list = useSyncExternalStore(shown.subscribe, shown.getSnapshot)
    return (
      <section
        aria-label="Notifications"
        aria-live="polite"
        className="demo-notices pointer-events-none fixed top-16 right-4 z-60 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {list.map((notice) => (
          <button
            key={notice.id}
            type="button"
            className="demo-notice pointer-events-auto flex cursor-pointer flex-col gap-0.5 px-3 py-2 text-left"
            onClick={() => {
              dismiss(notice.id)
              listeners.forEach((listener) => listener(notice.id))
            }}
          >
            <span className="demo-notice-title truncate text-[12px] font-medium">
              {notice.title}
            </span>
            <span className="demo-notice-body line-clamp-2 text-[11px]">{notice.body}</span>
          </button>
        ))}
      </section>
    )
  }
  return { notices, Notices }
}
