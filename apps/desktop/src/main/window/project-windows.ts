// Project windows: each of the app's windows shows one project, and a project may show in
// several windows at once. This keeps which window shows what, which window the person used
// last, and the decisions that follow: opening a project in a window of its own, and handing
// a place in a project to the window that takes it. It knows no Electron: the window
// type is the caller's, and everything that touches a window goes through `ProjectWindowsOutput`.
import type { ProjectWindowsState, ProjectWindowTarget } from "@novadeck/protocol/bridge"

/** What the registry asks of the app's windows. */
export type ProjectWindowsOutput<Window> = {
  /** Opens a window on a project, which the new window shows from the start, under a new key. */
  readonly create: (projectId: string) => Window
  /** Brings a window to the front. */
  readonly forward: (window: Window) => void
  /** Tells a window's page what its siblings show, and whether it has the voice. */
  readonly tell: (window: Window, state: ProjectWindowsState) => void
  /** Tells a window's page to go to a place in a project. */
  readonly navigate: (window: Window, target: ProjectWindowTarget) => void
  /** The voice moved: `from` rang, raised notifications and counted, and `to` does now. */
  readonly voiceMoved?: (from: Window | undefined, to: Window | undefined) => void
}

/** The most windows the app opens at the person's asking. */
export const mostWindows = 16

export const createProjectWindows = <Window>(output: ProjectWindowsOutput<Window>) => {
  // In the order the windows opened; a window with no project yet maps to undefined.
  const shown = new Map<Window, string | undefined>()
  // The windows the person used, the last first. The first of them has the voice.
  let used: Window[] = []
  let voice: Window | undefined
  // The projects each window's page says it knows, which a window may be opened on.
  const known = new Map<Window, ReadonlySet<string>>()
  const isKnown = (projectId: string): boolean =>
    [...known.values()].some((ids) => ids.has(projectId))

  const stateOf = (window: Window): ProjectWindowsState => ({
    elsewhere: [
      ...new Set(
        [...shown].flatMap(([other, project]) =>
          other !== window && project !== undefined ? [project] : [],
        ),
      ),
    ],
    voice: window === voice,
  })
  const tellAll = (): void => {
    for (const window of shown.keys()) output.tell(window, stateOf(window))
  }
  // The voice is the window used last; with none used yet, the first that opened.
  const settleVoice = (): void => {
    const next = used[0] ?? shown.keys().next().value
    if (next === voice) return
    const from = voice
    voice = next
    output.voiceMoved?.(from, next)
  }
  const changed = (): void => {
    settleVoice()
    tellAll()
  }
  // The window that shows the project, the one used last if several do; not `except`.
  const windowOf = (projectId: string, except?: Window): Window | undefined => {
    const showing = [...shown].filter(
      ([window, project]) => project === projectId && window !== except,
    )
    return used.find((window) => showing.some(([each]) => each === window)) ?? showing[0]?.[0]
  }

  return {
    /** A new window, showing `projectId` if it opens on one. */
    add: (window: Window, projectId?: string): void => {
      shown.set(window, projectId)
      if (projectId !== undefined) known.set(window, new Set([projectId]))
      changed()
    },
    /** A window closed: what it showed is shown nowhere. */
    remove: (window: Window): void => {
      if (!shown.delete(window)) return
      known.delete(window)
      used = used.filter((each) => each !== window)
      changed()
    },
    /** The person used a window: it has the voice from now on. */
    used: (window: Window): void => {
      if (!shown.has(window)) return
      used = [window, ...used.filter((each) => each !== window)]
      changed()
    },
    /** A window's page says which project it shows now, or none. */
    show: (window: Window, projectId: string | undefined, projects?: readonly string[]): void => {
      if (!shown.has(window)) return
      if (projects) known.set(window, new Set(projects))
      if (shown.get(window) === projectId) return
      shown.set(window, projectId)
      changed()
    },
    /** Tells one window's page its state, as it asks when it starts listening. */
    tell: (window: Window): void => {
      if (shown.has(window)) output.tell(window, stateOf(window))
    },
    /**
     * Opens a project in a new window, even when this or another window shows it already. A
     * project no page knows, or one past `mostWindows` windows, opens nothing.
     */
    open: (_from: Window, projectId: string): void => {
      if (!isKnown(projectId) || shown.size >= mostWindows) return
      const created = output.create(projectId)
      // A second ask before the new page reports finds it.
      shown.set(created, projectId)
      changed()
    },
    /**
     * Sends a place in a project to a window: `from` when it shows the project, else the window
     * showing it that the person used last, else `from`, which switches. The window comes
     * forward, unless an agent asked (`quiet`), which never raises a window.
     */
    handOff: (from: Window, target: ProjectWindowTarget): void => {
      const window =
        shown.get(from) === target.projectId ? from : (windowOf(target.projectId, from) ?? from)
      if (target.quiet !== true) output.forward(window)
      output.navigate(window, target)
    },
    /** The windows, in the order they opened, with what each shows. */
    list: (): { readonly window: Window; readonly projectId: string | undefined }[] =>
      [...shown].map(([window, projectId]) => ({ window, projectId })),
    /** Whether the window has the voice. */
    hasVoice: (window: Window): boolean => window === voice,
    voice: (): Window | undefined => voice,
    size: (): number => shown.size,
  }
}

export type ProjectWindows<Window> = ReturnType<typeof createProjectWindows<Window>>
