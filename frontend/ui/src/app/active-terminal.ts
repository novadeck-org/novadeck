import type { Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { pageDesktop, viewedTerminal, type DesktopSource } from "./inbox-landing"
import type { UiStore } from "./ui-store"

// Tells the backend, which runs the terminals' programs, which terminal the person is using:
// the one they look at (`viewedTerminal`), so the terminal shown in Focus view and the
// selected one in Grid and Canvas, while the window has their focus; none otherwise. Each
// change is told once; the backend gathers quick flips between terminals. Returns the stop,
// which tells none, so a window that closes leaves nothing raised.
export const watchActiveTerminal = (
  workspace: Pick<Store<Workspace>, "getSnapshot" | "subscribe">,
  ui: Pick<UiStore, "getSnapshot" | "subscribe">,
  report: ((terminalId: string | null) => void) | undefined,
  desktop: DesktopSource = pageDesktop,
): (() => void) => {
  if (!report) return () => {}
  let told: string | null | undefined
  const check = (): void => {
    const now = viewedTerminal(workspace.getSnapshot(), ui.getSnapshot(), desktop.is)?.id ?? null
    if (now === told) return
    told = now
    report(now)
  }
  check()
  const stops = [workspace.subscribe(check), ui.subscribe(check), desktop.subscribe(check)]
  return () => {
    for (const stop of stops) stop()
    if (told !== null) report(null)
  }
}
