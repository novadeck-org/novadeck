import type { ChildProcess, SpawnOptions } from "node:child_process"

import type { Log } from "@novadeck/log"

import type { Hold } from "./keep-awake.js"

/** Electron's `powerSaveBlocker`, as much of it as a hold uses. */
export type Blocker = {
  start(type: "prevent-app-suspension"): number
  stop(id: number): void
}

/** Starts a program, as `child_process.spawn` does. */
export type Spawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess

// GNOME's own hold on suspend, which its power daemon honours where it ignores Electron's
// (`prevent-app-suspension` takes no hold on GNOME): only suspend, so the screen still blanks
// and locks. It lasts as long as the command it runs, `cat` on a pipe from the app, which ends
// once the app closes the pipe or dies: no hold outlives the app.
export const gnomeInhibit = [
  "--inhibit",
  "suspend",
  "--reason",
  "Agents are working",
  "--app-id",
  "dev.mzpk.novadeck",
  "cat",
] as const

/** Takes GNOME's hold, saying when it can't: no gnome-session-inhibit, or no GNOME session. */
const holdOnGnome = (spawn: Spawn, env: NodeJS.ProcessEnv, log: Log): (() => void) => {
  let released = false
  const child = spawn("gnome-session-inhibit", gnomeInhibit, {
    env,
    stdio: ["pipe", "ignore", "ignore"],
  })
  child.on("error", (error) =>
    log.info("awake.no-gnome", "GNOME's hold on suspend is not available here.", {
      data: { reason: error.message },
    }),
  )
  child.on("exit", (code, signal) => {
    if (!released)
      log.info("awake.gnome-ended", "GNOME's hold on suspend ended before it was released.", {
        data: { code, signal },
      })
  })
  // Writing to a pipe whose reader is gone must not throw in the main process.
  child.stdin?.on("error", () => {})
  return () => {
    released = true
    child.stdin?.end()
    child.kill()
  }
}

/**
 * The system's hold: Electron's `prevent-app-suspension` (a power assertion on macOS,
 * `SetThreadExecutionState` on Windows, a D-Bus inhibit some Linux desktops honour), and on
 * Linux GNOME's own as well, started in `env`, as the system's own programs expect.
 */
export const systemHold =
  ({
    platform,
    blocker,
    spawn,
    env,
    log,
  }: {
    readonly platform: NodeJS.Platform
    readonly blocker: Blocker
    readonly spawn: Spawn
    readonly env: NodeJS.ProcessEnv
    readonly log: Log
  }) =>
  (): Hold => {
    const id = blocker.start("prevent-app-suspension")
    const gnome = platform === "linux" ? holdOnGnome(spawn, env, log) : undefined
    log.info("awake.hold", "Keeping the computer awake while agents work.")
    return {
      release() {
        blocker.stop(id)
        gnome?.()
        log.info("awake.release", "The computer may sleep again.")
      },
    }
  }
