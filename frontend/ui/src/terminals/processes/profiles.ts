import type { Item } from "@novadeck/core/items"
import type { TerminalMetadata } from "@novadeck/core/types"
import { agentIcon } from "@novadeck/items/agent-icon"
import { iconOf } from "@novadeck/items/registry"
import { CircleDashed, FileText, SquareTerminal, Terminal, type LucideIcon } from "lucide-react"

// How the UI presents a program: its icon in the tab and window header. The window itself
// never changes, so a program starting or ending keeps the header, a rename in progress, and
// focus. Profiles are presentation only; per-program behaviour, such as resuming a
// restored program, goes beside `programName` in `core/`.
type ProcessProfile = {
  readonly icon: LucideIcon
}

const fallback: ProcessProfile = { icon: Terminal }

// The agents' programs, which present as their mark (`agentIcon`); any other presents as a plain
// terminal.
// The program a terminal presents as, which names its window: one with a profile, while it
// holds the foreground, or, where no process runs, the agent that sleeps there or is being
// woken (its tab and window dim it). A shell, a fresh start, or an ending presents none.
export const presentedProgram = (terminal: TerminalMetadata): string | undefined => {
  const program =
    terminal.state === "running"
      ? terminal.process
      : terminal.state === "sleeping"
        ? terminal.agent
        : terminal.state === "starting"
          ? terminal.restoredProcess
          : undefined
  return program !== undefined && agentIcon(program) ? program : undefined
}

// A window undocked from a terminal's companion presents as what it shows: a plan, or an
// image, file or page, or the shells of its agent.
export const windowProfile = (
  item: Pick<Item, "kind" | "name" | "path"> | undefined,
): ProcessProfile => ({
  icon:
    !item || item.kind === "plan"
      ? FileText
      : item.kind === "shells"
        ? SquareTerminal
        : item.kind === "newer"
          ? CircleDashed
          : iconOf({ kind: item.kind, name: item.name, path: item.path }),
})

// The icon a program presents with, by its name: a plain terminal's for one without a
// profile. `nova`: it is Nova's, which has Novadeck's mark in place of Pi's.
export const programIcon = (program: string, nova?: boolean): LucideIcon =>
  agentIcon(program, nova) ?? fallback.icon

export const terminalProfile = (terminal: TerminalMetadata): ProcessProfile => ({
  icon: programIcon(presentedProgram(terminal) ?? "", terminal.nova),
})
