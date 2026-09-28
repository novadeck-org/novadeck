import { Terminal, type LucideIcon } from "lucide-react"
import type { ComponentType, ReactNode } from "react"

import type { TerminalMetadata } from "../../model/types"
import { ClaudeIcon } from "../../ui-toolkit/icons/ClaudeIcon"
import { CodexIcon } from "../../ui-toolkit/icons/CodexIcon"
import { ClaudeBody } from "./ClaudeBody"
import { CodexBody } from "./CodexBody"

// How the UI presents a program: its icon in the tab and window header, and a body
// around its terminal content inside the shared window. The window itself never
// changes, so a program starting or ending keeps the header, a rename in progress, and
// focus. Profiles are presentation only; per-program behaviour, such as resuming a
// restored program, goes beside `programName` in `model/`.
export type ProcessProfile = {
  readonly icon: LucideIcon
  readonly Body?: ComponentType<{ readonly children: ReactNode }>
}

const fallback: ProcessProfile = { icon: Terminal }

// Keyed by `programName`; programs not listed present as a plain terminal.
const profiles: ReadonlyMap<string, ProcessProfile> = new Map([
  ["claude", { icon: ClaudeIcon, Body: ClaudeBody }],
  ["codex", { icon: CodexIcon, Body: CodexBody }],
])

// The program a terminal presents as, which names its window: one with a profile, only
// while it holds the foreground. A shell, a fresh start, or an ending presents none.
export const presentedProgram = (terminal: TerminalMetadata): string | undefined =>
  terminal.state === "running" && profiles.has(terminal.process) ? terminal.process : undefined

export const terminalProfile = (terminal: TerminalMetadata): ProcessProfile =>
  profiles.get(presentedProgram(terminal) ?? "") ?? fallback
