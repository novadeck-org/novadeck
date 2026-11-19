import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react"

// Where the chat keeps what the person opened and shut in it (see ./opened): a row that draws
// again finds it as they left it. The app gives one per terminal; without one, a row keeps its own,
// which goes with it.
export type OpenedMemory = {
  readonly subscribe: (listener: () => void) => () => void
  // What the person last did with `key`, undefined where they did nothing yet.
  readonly opened: (key: string) => boolean | undefined
  readonly setOpened: (key: string, open: boolean) => void
}

export const Opened = createContext<OpenedMemory | null>(null)

const noSubscribe = (): (() => void) => () => {}

// The memory with its keys kept apart for one session: a terminal's next agent starts closed.
export const sessionMemory = (memory: OpenedMemory, session: string | null): OpenedMemory => {
  const prefix = `${session ?? ""}:`
  return {
    subscribe: memory.subscribe,
    opened: (key) => memory.opened(prefix + key),
    setOpened: (key, open) => memory.setOpened(prefix + key, open),
  }
}

/**
 * Whether what `key` names is open, starting as `initial` until the person opens or shuts it, and
 * how they do. Kept in the chat's memory, where there is one, so it outlives the row.
 */
export const useOpen = (
  key: string,
  initial: boolean,
): readonly [boolean, (open: boolean | ((was: boolean) => boolean)) => void] =>
  useOpenIn(useContext(Opened), key, initial)

// `useOpen` with the memory given, as the chat that gives it to its rows uses it itself.
export const useOpenIn = (
  memory: OpenedMemory | null,
  key: string,
  initial: boolean,
): readonly [boolean, (open: boolean | ((was: boolean) => boolean)) => void] => {
  const [own, setOwn] = useState(initial)
  const read = (): boolean | undefined => memory?.opened(key)
  const kept = useSyncExternalStore(memory?.subscribe ?? noSubscribe, read, read)
  const open = kept ?? own
  const set = useCallback(
    (next: boolean | ((was: boolean) => boolean)): void => {
      const value = typeof next === "function" ? next(memory?.opened(key) ?? own) : next
      if (memory) memory.setOpened(key, value)
      else setOwn(value)
    },
    [memory, key, own],
  )
  return [open, set]
}
