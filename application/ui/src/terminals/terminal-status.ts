import type { TerminalMetadata } from "../model/types"

// The frame calls out an exited process or a failed start; other states show nothing.
export const terminalStatusLabel = (terminal: TerminalMetadata): string | null => {
  if (terminal.state === "exited")
    return terminal.exitCode === null ? "Exited" : `Exited · code ${terminal.exitCode}`
  if (terminal.state === "failed") return "Failed to start"
  return null
}
