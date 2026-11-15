import { useShown } from "@novadeck/toolkit/shown"
import { useLayoutEffect, useRef, useSyncExternalStore } from "react"

// A chat out of sight (see toolkit's `Shown`: a terminal Focus keeps hidden, a Grid or Canvas
// tile off screen) draws nothing as its agent streams: what it reads from a store holds at what
// it last drew, and it stops listening, until it's back in sight, when it reads the store again,
// once, and draws what came meanwhile in that one render.

const noSubscribe = (): (() => void) => () => {}

/**
 * `useSyncExternalStore(subscribe, getSnapshot)` while what calls it is in sight; out of sight,
 * the snapshot it last drew, and no listening. A chat that mounts out of sight reads the store
 * once, as it mounts.
 */
export const useHeldSnapshot = <T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
): T => {
  const shown = useShown()
  const held = useRef<{ readonly value: T } | null>(null)
  const value = useSyncExternalStore(
    shown ? subscribe : noSubscribe,
    shown ? getSnapshot : () => (held.current === null ? getSnapshot() : held.current.value),
  )
  useLayoutEffect(() => {
    held.current = { value }
  })
  return value
}
