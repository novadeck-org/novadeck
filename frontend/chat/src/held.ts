import { useShown } from "@novadeck/toolkit/shown"
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

// A chat out of sight (see toolkit's `Shown`: a terminal Focus keeps hidden, a Grid or Canvas
// tile off screen) draws nothing as its agent streams: what it reads from a store holds at what
// it last drew, and it stops listening, until it's back in sight, when it reads the store again,
// once, and draws what came meanwhile in that one render. It holds once out of sight
// `holdAfterMs`, past the while what the person just did there still reads the agent's box
// (`boxLagMs` for keys passed to a menu, the box handover's linger after), so that finishes as
// it would have; one that mounts out of sight holds at once.

/** How long a chat is out of sight before it holds. */
export const holdAfterMs = 2_000

// Whether the chat around holds: outside a chat, nothing does.
export const Holding = createContext(false)

/** Whether a chat in sight as toolkit's `Shown` tells holds now (see `holdAfterMs`). */
export const useHolds = (): boolean => {
  const shown = useShown()
  const [held, setHeld] = useState(() => !shown)
  useEffect(() => {
    if (shown) return
    const timer = setTimeout(() => setHeld(true), holdAfterMs)
    return () => {
      clearTimeout(timer)
      setHeld(false)
    }
  }, [shown])
  return !shown && held
}

const noSubscribe = (): (() => void) => () => {}

/**
 * `useSyncExternalStore(subscribe, getSnapshot)` while the chat around doesn't hold (see
 * `Holding`); while it holds, the snapshot it last drew, and no listening. A chat that mounts
 * holding reads the store once, as it mounts.
 */
export const useHeldSnapshot = <T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
): T => {
  const holds = useContext(Holding)
  const held = useRef<{ readonly value: T } | null>(null)
  const value = useSyncExternalStore(
    holds ? noSubscribe : subscribe,
    holds ? () => (held.current === null ? getSnapshot() : held.current.value) : getSnapshot,
  )
  useLayoutEffect(() => {
    held.current = { value }
  })
  return value
}
