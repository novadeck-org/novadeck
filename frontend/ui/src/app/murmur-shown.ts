import type { Murmur, MurmurState } from "@novadeck/core/addons/murmur"
import type { Backend } from "@novadeck/core/port"
import { useCallback, useSyncExternalStore } from "react"

// Murmur is Experimental. The app offers it (the one-time offer chip, an install from nothing)
// only while its switch is on, or where the backend has no switch, as a runner from before it.
// One already on this computer shows (its Addons section with its Uninstall, its footer item)
// with the switch off too, as it keeps working there: uninstalled then, it is gone until the
// switch is on.

type MurmurOf = Pick<Backend, "murmur" | "murmurSwitch">

const always = (): (() => void) => () => {}

const switchedOn = ({ murmurSwitch }: MurmurOf): boolean =>
  murmurSwitch?.enabled.getSnapshot() ?? true

// Whether Murmur has files on this computer: installed, or a model kept beside a verdict.
const onDisk = (state: MurmurState | undefined): boolean =>
  state !== undefined && (state.installed || state.kept)

const shown = (backend: MurmurOf): boolean =>
  switchedOn(backend) || onDisk(backend.murmur?.state.getSnapshot())

// The backend's Murmur while the app offers it, now.
export const offeredMurmur = (backend: MurmurOf): Murmur | undefined =>
  switchedOn(backend) ? backend.murmur : undefined

// The backend's Murmur while the app offers it, followed as its switch changes.
export const useOfferedMurmur = (backend: MurmurOf): Murmur | undefined => {
  const on = useSyncExternalStore(backend.murmurSwitch?.enabled.subscribe ?? always, () =>
    switchedOn(backend),
  )
  return on ? backend.murmur : undefined
}

// The backend's Murmur while the app shows it, now.
export const shownMurmur = (backend: MurmurOf): Murmur | undefined =>
  shown(backend) ? backend.murmur : undefined

// The backend's Murmur while the app shows it, followed as its switch and its files change.
export const useShownMurmur = (backend: MurmurOf): Murmur | undefined => {
  const { murmur, murmurSwitch } = backend
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      const offSwitch = (murmurSwitch?.enabled.subscribe ?? always)(listener)
      const offState = (murmur?.state.subscribe ?? always)(listener)
      return () => {
        offSwitch()
        offState()
      }
    },
    [murmur, murmurSwitch],
  )
  const on = useSyncExternalStore(subscribe, () => shown(backend))
  return on ? backend.murmur : undefined
}
