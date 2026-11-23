import type { Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { pageDesktop, viewedTerminal, type DesktopSource } from "./inbox-landing"
import type { UiStore } from "./ui-store"

// Tells the backend, which runs the terminals' programs, which terminal the person is using:
// the one they look at (`viewedTerminal`), so the terminal shown in Focus view and the
// selected one in Grid and Canvas, while the window has their focus; none otherwise. Each
// change is told once; the backend gathers quick flips between terminals. The window's use is
// told again, at most once per `touchMs`, as it gains focus and on the person's input (keys,
// pointer): the runner counts it as the window the person used last, which routes what is
// about a project two windows show to the one in use. Returns the stop, which tells none, so a
// window that closes leaves nothing raised.

// The fewest milliseconds between two tellings of the same terminal in use.
export const touchMs = 1_000
export const watchActiveTerminal = (
  workspace: Pick<Store<Workspace>, "getSnapshot" | "subscribe">,
  ui: Pick<UiStore, "getSnapshot" | "subscribe">,
  report: ((terminalId: string | null, again?: boolean) => void) | undefined,
  desktop: DesktopSource = pageDesktop,
  input:
    | Pick<EventTarget, "addEventListener" | "removeEventListener">
    | undefined = globalThis.window,
  clock: () => number = Date.now,
): (() => void) => {
  if (!report) return () => {}
  let told: string | null | undefined
  let lastTold = Number.NEGATIVE_INFINITY
  const check = (): void => {
    const now = viewedTerminal(workspace.getSnapshot(), ui.getSnapshot(), desktop.is)?.id ?? null
    if (now === told) return
    told = now
    lastTold = clock()
    report(now)
  }
  check()
  // Use of the window with the terminal already told: it goes out again, but not often.
  const touch = (): void => {
    if (told === null || told === undefined) return
    const at = clock()
    if (at - lastTold < touchMs) return
    lastTold = at
    report(told, true)
  }
  const events = ["focus", "keydown", "pointerdown"] as const
  for (const event of events)
    input?.addEventListener(event, touch, { capture: true, passive: true })
  const stops = [workspace.subscribe(check), ui.subscribe(check), desktop.subscribe(check)]
  return () => {
    for (const stop of stops) stop()
    for (const event of events) input?.removeEventListener(event, touch, { capture: true })
    if (told !== null) report(null)
  }
}
