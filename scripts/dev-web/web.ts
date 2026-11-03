import { randomBytes } from "node:crypto"

export type DevCommand = {
  readonly name: string
  readonly command: string
  readonly env: Readonly<Record<string, string>>
}

// A fresh credential for one development run; the runner accepts 32–512 characters.
export const devToken = (): string => randomBytes(32).toString("hex")

// The runner and the UI dev server, sharing one token. Each gets only its own
// variables, so the runner's shells never see the token the UI connects with.
export const devWebCommands = (token: string, port = 8787): readonly DevCommand[] => [
  {
    name: "runner",
    command: "pnpm --filter @novadeck/runner dev",
    // HOST is pinned: some shells (tcsh) export the machine's name as HOST.
    env: { NOVADECK_TOKEN: token, PORT: String(port), HOST: "127.0.0.1" },
  },
  {
    name: "ui",
    // The web app's entry (apps/desktop/renderer/web), which reaches its runner over a WebSocket.
    command: "pnpm --filter @novadeck/desktop exec vite --host 127.0.0.1 --mode web",
    env: {
      VITE_NOVADECK_RUNNER_URL: `ws://127.0.0.1:${port}/api/rpc`,
      VITE_NOVADECK_RUNNER_TOKEN: token,
    },
  },
]
