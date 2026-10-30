import type { SandboxState } from "@novadeck/core/desktop/sandbox"

// The command the demo's unsandboxed notice offers, as the desktop app's might read.
export const sampleFix =
  "curl -fsSL https://github.com/novadeck-org/novadeck/releases/latest/download/install.sh | sh -s -- --sandbox"

// The browser's stand-in for the desktop app's account of its sandbox, asked once.
export const createDemoSandbox =
  (state: SandboxState): (() => Promise<SandboxState>) =>
  () =>
    Promise.resolve(state)
