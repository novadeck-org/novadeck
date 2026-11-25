import type { Murmur } from "@novadeck/core/addons/murmur"
import type { Backend } from "@novadeck/core/port"
import { useSyncExternalStore } from "react"

// Murmur is Experimental: the app shows it (its offer, its Addons section, its footer chip) only
// while its switch is on, or where the backend has no switch, as a runner from before it.

type MurmurOf = Pick<Backend, "murmur" | "murmurSwitch">

const always = (): (() => void) => () => {}

const switchedOn = ({ murmurSwitch }: MurmurOf): boolean =>
  murmurSwitch?.enabled.getSnapshot() ?? true

// The backend's Murmur while the app shows it, now.
export const shownMurmur = (backend: MurmurOf): Murmur | undefined =>
  switchedOn(backend) ? backend.murmur : undefined

// The backend's Murmur while the app shows it, followed as its switch changes.
export const useShownMurmur = (backend: MurmurOf): Murmur | undefined => {
  const on = useSyncExternalStore(backend.murmurSwitch?.enabled.subscribe ?? always, () =>
    switchedOn(backend),
  )
  return on ? backend.murmur : undefined
}
