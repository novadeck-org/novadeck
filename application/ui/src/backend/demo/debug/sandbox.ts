import type { SandboxState } from "#core/sandbox"

// The command the demo's unsandboxed notice offers, as the desktop host's might read.
export const sampleFix =
  "curl -fsSL https://github.com/novadeck-org/novadeck/releases/latest/download/install.sh | sh -s -- --sandbox"

// The browser's stand-in for the desktop host's account of its sandbox, asked once.
export const createDemoSandbox =
  (state: SandboxState): (() => Promise<SandboxState>) =>
  () =>
    Promise.resolve(state)
