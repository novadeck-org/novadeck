import { commands } from "vitest/browser"

declare module "vitest/browser" {
  // Declaration merging extends Vitest's command registry.
  // eslint-disable-next-line typescript/consistent-type-definitions
  interface BrowserCommands {
    pinPointer: (
      action: "press" | "move" | "release",
      point?: { x: number; y: number },
    ) => Promise<void>
  }
}

// Native mouse events, split at the held pointer so a spec can inspect the handoff.
export const pinPointer = commands.pinPointer
