import { isShellProcess } from "./process"
import { sameTitleSource } from "./title-source"
import type {
  CompanionWindowMeta,
  TerminalMetadata,
  TerminalRoster,
  TerminalStatus,
  Tile,
} from "./types"

export const createRoster = (
  terminals: TerminalMetadata[],
  windows: readonly CompanionWindowMeta[] = [],
): TerminalRoster => ({ terminals, windows, order: [] })

export const hasTerminal = (roster: TerminalRoster, terminalId: string): boolean =>
  roster.terminals.some((terminal) => terminal.id === terminalId)

// A window undocked from a terminal's companion, rather than a terminal.
export const isWindow = (tile: Tile): tile is CompanionWindowMeta => tile.itemId !== undefined

export const hasWindow = (roster: TerminalRoster, windowId: string): boolean =>
  roster.windows.some((window) => window.id === windowId)

// Whether the session lays out a terminal or window by this id.
export const hasTile = (roster: TerminalRoster, id: string): boolean =>
  hasTerminal(roster, id) || hasWindow(roster, id)

// One answer per roster, so readers that compare by identity see a change only when the
// roster changed. A roster is never changed in place.
const remembered = <T>(derive: (roster: TerminalRoster) => T) => {
  const answers = new WeakMap<TerminalRoster, T>()
  return (roster: TerminalRoster): T => {
    const known = answers.get(roster)
    if (known !== undefined) return known
    const answer = derive(roster)
    answers.set(roster, answer)
    return answer
  }
}

// Every terminal and window, terminals first, as views lay them out.
export const tilesOf: (roster: TerminalRoster) => readonly Tile[] = remembered((roster) => [
  ...roster.terminals,
  ...roster.windows,
])

// Terminals and windows in sidebar order; those missing from the saved order follow,
// terminals in creation order, then windows.
export const orderedTiles: (roster: TerminalRoster) => readonly Tile[] = remembered((roster) => {
  const all = tilesOf(roster)
  const byId = new Map(all.map((tile) => [tile.id, tile]))
  const ordered = roster.order.flatMap((id) => {
    const tile = byId.get(id)
    return tile ? [tile] : []
  })
  const orderedIds = new Set(ordered.map((tile) => tile.id))
  return [...ordered, ...all.filter((tile) => !orderedIds.has(tile.id))]
})

// Terminals in sidebar order; terminals missing from the saved order follow in creation order.
export const orderedTerminals = (roster: TerminalRoster): TerminalMetadata[] => {
  const byId = new Map(roster.terminals.map((terminal) => [terminal.id, terminal]))
  const ordered = roster.order.flatMap((id) => {
    const terminal = byId.get(id)
    return terminal ? [terminal] : []
  })
  const orderedIds = new Set(ordered.map((terminal) => terminal.id))
  return [...ordered, ...roster.terminals.filter((terminal) => !orderedIds.has(terminal.id))]
}

export const addTerminal = (
  roster: TerminalRoster,
  terminal: TerminalMetadata,
): TerminalRoster => ({
  ...roster,
  terminals: [...roster.terminals, terminal],
})

type TerminalFacts = Pick<TerminalMetadata, "name" | "directory" | "handle" | "titleSource">

// What the backend says of a terminal now: its name or directory, its handle, and who
// its name is from.
export const updateTerminal = (
  roster: TerminalRoster,
  terminalId: string,
  change: Partial<TerminalFacts>,
): TerminalRoster => {
  const current = roster.terminals.find((terminal) => terminal.id === terminalId)
  if (!current) return roster
  const { name, directory, handle, titleSource } = change
  const facts: Partial<TerminalFacts> = {
    ...(name !== undefined && name !== current.name && { name }),
    ...(directory !== undefined && directory !== current.directory && { directory }),
    ...(handle !== undefined && handle !== current.handle && { handle }),
    ...(titleSource !== undefined &&
      !sameTitleSource(titleSource, current.titleSource) && { titleSource }),
  }
  if (!Object.keys(facts).length) return roster
  return {
    ...roster,
    terminals: roster.terminals.map((terminal) =>
      terminal === current ? { ...terminal, ...facts } : terminal,
    ),
  }
}

// The person names a terminal or window: the name is theirs.
export const renameTerminal = (
  roster: TerminalRoster,
  terminalId: string,
  name: string,
): TerminalRoster => {
  if (hasWindow(roster, terminalId))
    return {
      ...roster,
      windows: roster.windows.map((window) =>
        window.id === terminalId ? { ...window, name, titleSource: { kind: "person" } } : window,
      ),
    }
  return hasTerminal(roster, terminalId)
    ? {
        ...roster,
        terminals: roster.terminals.map((terminal) =>
          terminal.id === terminalId
            ? { ...terminal, name, titleSource: { kind: "person" } }
            : terminal,
        ),
      }
    : roster
}

export const removeTerminal = (roster: TerminalRoster, terminalId: string): TerminalRoster =>
  hasTerminal(roster, terminalId)
    ? {
        ...roster,
        terminals: roster.terminals.filter((terminal) => terminal.id !== terminalId),
        order: roster.order.filter((id) => id !== terminalId),
      }
    : roster

export const addWindow = (roster: TerminalRoster, window: CompanionWindowMeta): TerminalRoster => ({
  ...roster,
  windows: [...roster.windows, window],
})

// What the backend says of a window now: its name, and whose it is.
export const updateWindow = (
  roster: TerminalRoster,
  window: CompanionWindowMeta,
): TerminalRoster => {
  const current = roster.windows.find((each) => each.id === window.id)
  if (
    !current ||
    (current.itemId === window.itemId &&
      current.name === window.name &&
      current.titleSource.kind === window.titleSource.kind)
  )
    return roster
  return { ...roster, windows: roster.windows.map((each) => (each === current ? window : each)) }
}

export const removeWindow = (roster: TerminalRoster, windowId: string): TerminalRoster =>
  hasWindow(roster, windowId)
    ? {
        ...roster,
        windows: roster.windows.filter((window) => window.id !== windowId),
        order: roster.order.filter((id) => id !== windowId),
      }
    : roster

// Keeps known ids once each, in the requested order.
export const reorderTerminals = (roster: TerminalRoster, requested: string[]): TerminalRoster => {
  const seen = new Set<string>()
  const order = requested.filter(
    (id) => hasTile(roster, id) && !seen.has(id) && (seen.add(id), true),
  )
  return order.length === roster.order.length &&
    order.every((id, index) => roster.order[index] === id)
    ? roster
    : { ...roster, order }
}

const sameStatus = (terminal: TerminalMetadata, status: TerminalStatus): boolean => {
  if (status.state === "exited")
    return (
      terminal.state === "exited" &&
      terminal.exitCode === status.exitCode &&
      terminal.signal === status.signal
    )
  if (status.state === "failed")
    return terminal.state === "failed" && terminal.message === status.message
  if (status.state === "running")
    return (
      terminal.state === "running" &&
      JSON.stringify(terminal.agent) === JSON.stringify(status.agent)
    )
  return terminal.state === status.state
}

// Only the fields a status defines, so nothing else the caller put on it is copied.
const statusFields = (status: TerminalStatus): TerminalStatus => {
  if (status.state === "exited")
    return { state: status.state, exitCode: status.exitCode, signal: status.signal }
  if (status.state === "failed") return { state: status.state, message: status.message }
  if (status.state === "running")
    return { state: status.state, ...(status.agent ? { agent: status.agent } : {}) }
  return { state: status.state }
}

// A restore exists only while the terminal has no live shell. A program that loses its
// shell while running, as when the runner is lost or the shell is killed, becomes it; a
// live shell, at its prompt or running a program, ends it. Other changes, as an ended
// shell starting afresh, keep it.
const restoredAfter = (terminal: TerminalMetadata, status: TerminalStatus): string | undefined => {
  if (status.state === "idle" || status.state === "running") return undefined
  const lost = status.state === "starting" || status.state === "exited" || status.state === "failed"
  if (lost && terminal.state === "running" && !isShellProcess(terminal.process))
    return terminal.process || undefined
  return terminal.restoredProcess
}

// Rebuilds the terminal from its identity so no exit code or message outlives its status.
const withStatus = (terminal: TerminalMetadata, status: TerminalStatus): TerminalMetadata => {
  const restoredProcess = restoredAfter(terminal, status)
  return {
    id: terminal.id,
    name: terminal.name,
    directory: terminal.directory,
    command: terminal.command,
    process: terminal.process,
    ...(restoredProcess ? { restoredProcess } : {}),
    ...statusFields(status),
  }
}

export const setTerminalStatus = (
  roster: TerminalRoster,
  terminalId: string,
  status: TerminalStatus,
): TerminalRoster => {
  const current = roster.terminals.find((terminal) => terminal.id === terminalId)
  if (!current || sameStatus(current, status)) return roster
  return {
    ...roster,
    terminals: roster.terminals.map((terminal) =>
      terminal === current ? withStatus(terminal, status) : terminal,
    ),
  }
}

// The program now in the foreground.
export const setTerminalProcess = (
  roster: TerminalRoster,
  terminalId: string,
  process: string,
): TerminalRoster => {
  const current = roster.terminals.find((terminal) => terminal.id === terminalId)
  if (!current || current.process === process) return roster
  return {
    ...roster,
    terminals: roster.terminals.map((terminal) =>
      terminal === current ? { ...terminal, process } : terminal,
    ),
  }
}
