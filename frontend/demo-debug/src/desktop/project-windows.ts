import type {
  ProjectWindows,
  ProjectWindowsState,
  ProjectWindowTarget,
} from "@novadeck/core/desktop/project-windows"

// The page's stand-in for the desktop app's project windows, with the other windows pretended:
// it says which projects they show and whether this window has the voice, and takes what the
// page asks as the app would. Opening a project in a window of its own, or swapping with one,
// moves a pretend window; a hand-off goes to the pretend window, which this page can't see,
// so it is only noted. `send` is a pretend window sending this one somewhere.
export type DemoProjectWindows = {
  readonly windows: ProjectWindows
  // The projects the pretend windows show, by id, whichever the page shows now.
  readonly pretend: (projectIds: readonly string[]) => void
  // Whether this window has the voice, or another was used since.
  readonly setVoice: (voice: boolean) => void
  // A pretend window sends this one to a place in a project.
  readonly send: (target: ProjectWindowTarget) => void
  // The project this page says it shows.
  readonly shown: () => string | null
  // The places the page handed to a pretend window, in order.
  readonly handedOff: () => readonly ProjectWindowTarget[]
}

export const createDemoProjectWindows = ({
  extra,
}: {
  readonly extra: boolean
}): DemoProjectWindows => {
  let state: ProjectWindowsState = { elsewhere: [], voice: true }
  let shown: string | null = null
  const handed: ProjectWindowTarget[] = []
  const states = new Set<(state: ProjectWindowsState) => void>()
  const places = new Set<(target: ProjectWindowTarget) => void>()
  const set = (next: ProjectWindowsState): void => {
    state = next
    states.forEach((listener) => listener(next))
  }
  const windows: ProjectWindows = {
    onState: (listener) => {
      states.add(listener)
      listener(state)
      return () => void states.delete(listener)
    },
    show: (projectId) => {
      shown = projectId
    },
    use: () => {},
    open: (projectId) => {
      if (!state.elsewhere.includes(projectId))
        set({ ...state, elsewhere: [...state.elsewhere, projectId] })
    },
    swap: (projectId) => {
      // The page asks before it switches, so `shown` is still the project it leaves.
      if (!state.elsewhere.includes(projectId)) return
      const left = state.elsewhere.filter((id) => id !== projectId)
      set({ ...state, elsewhere: shown === null ? left : [...left, shown] })
    },
    handOff: (target) => {
      handed.push(target)
    },
    onNavigate: (listener) => {
      places.add(listener)
      return () => void places.delete(listener)
    },
    extra,
  }
  return {
    windows,
    pretend: (projectIds) => set({ ...state, elsewhere: [...projectIds] }),
    setVoice: (voice) => set({ ...state, voice }),
    send: (target) => places.forEach((listener) => listener(target)),
    shown: () => shown,
    handedOff: () => handed,
  }
}
