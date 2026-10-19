import type { DemoStates } from "./types"

export const sampleFolder = "~/projects/new-app"

// Asks for a folder with the browser's prompt. A failure can be armed for the next ask,
// which rejects as a picker that could not open does.
export const createDemoFolders = (
  ask: (message: string, initial: string) => string | null = (message, initial) =>
    window.prompt(message, initial),
): { readonly pickDirectory: DemoStates["pickDirectory"]; readonly failNext: () => void } => {
  let failing = false
  return {
    pickDirectory: async () => {
      if (failing) {
        failing = false
        throw new Error("The folder picker could not open")
      }
      return ask("Folder to open as a project", sampleFolder)?.trim() || null
    },
    failNext: () => {
      failing = true
    },
  }
}
