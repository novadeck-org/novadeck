import type { IpcMainInvokeEvent } from "electron"

import { debugKillRunnerChannel } from "../bridge.js"

// The debug panel is always on in development. A packaged app turns it on only when
// launched with `--debug-panel` or with NOVADECK_DEBUG=1 in its environment. (Plain
// `--debug` is taken: Electron rejects it as Node's retired debugger flag.)
export const debugEnabled = ({
  argv,
  env,
  packaged,
}: {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly packaged: boolean
}): boolean => !packaged || argv.includes("--debug-panel") || env.NOVADECK_DEBUG === "1"

type DebugIpc = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): void
}

// Registers what the debug panel may ask of the main process, and nothing when the
// panel is off. `allowed` applies the same sender checks as the app's other requests.
export const registerDebugIpc = (
  ipc: DebugIpc,
  {
    enabled,
    allowed,
    killRunner,
  }: {
    readonly enabled: boolean
    readonly allowed: (event: IpcMainInvokeEvent) => boolean
    readonly killRunner: () => boolean
  },
): void => {
  if (!enabled) return
  ipc.handle(debugKillRunnerChannel, (event) => allowed(event) && killRunner())
}
